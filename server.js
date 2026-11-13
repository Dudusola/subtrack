#!/usr/bin/env node
import http from 'node:http';
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toICS, validSubs, upcoming, money, daysUntil } from './public/core.js';
import { detect } from './detect.js';
import { openDb } from './db.js';
import { smtp } from './mailer.js';
import { imapScan as realImapScan } from './imap.js';
import * as gmail from './gmail.js';

const scrypt = promisify(scryptCb);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_DAYS = 30;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const SCHEMA = [
  `create table if not exists users (id text primary key, email text unique not null collate nocase, pass text not null, cal_token text unique not null, created text not null default current_timestamp)`,
  `create table if not exists sessions (id text primary key, user_id text not null references users on delete cascade, expires integer not null)`,
  `create table if not exists subs (id text primary key, user_id text not null references users on delete cascade, name text not null, price real not null, currency text not null, cycle text not null, start text not null, category text not null default '', source text not null default 'manual')`,
  `create table if not exists scans (user_id text primary key references users on delete cascade, found text not null, created integer not null)`,
  `create table if not exists oauth_states (state text primary key, user_id text not null references users on delete cascade, expires integer not null)`,
  `create table if not exists resets (id text primary key, user_id text not null references users on delete cascade, expires integer not null)`,
  `create table if not exists reminders_sent (user_id text not null references users on delete cascade, sub_id text not null, date text not null, primary key (user_id, sub_id, date))`,
  `create index if not exists subs_user on subs (user_id)`,
];
// Columns added after the first release; "duplicate column" errors mean the database already has them.
const MIGRATIONS = [
  `alter table users add column remind_days integer not null default 3`,
  `alter table users add column email_reminders integer not null default 1`,
  `alter table subs add column trial integer not null default 0`,
];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({
  dbPath = ':memory:',
  tursoUrl,
  tursoToken,
  baseUrl = 'http://localhost:3000',
  googleClientId,
  googleClientSecret,
  gmailScan = gmail.scan,
  imapScan = realImapScan,
  sendMail = null,
  cronSecret,
  trustProxy = false,
} = {}) {
  const db = openDb({ path: dbPath, tursoUrl, tursoToken });
  const ready = (async () => {
    for (const sql of SCHEMA) await db.run(sql);
    for (const sql of MIGRATIONS) await db.run(sql).catch((e) => { if (!/duplicate column/i.test(e.message)) throw e; });
  })();
  const secure = baseUrl.startsWith('https:');
  const redirectUri = `${baseUrl}/api/gmail/callback`;
  const gmailReady = Boolean(googleClientId && googleClientSecret);
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const token = () => randomBytes(32).toString('base64url');
  const now = () => Date.now();
  const sameSecret = (a, b) => Boolean(a && b) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  async function hashPassword(password) {
    const salt = randomBytes(16);
    return `${salt.toString('hex')}:${(await scrypt(password, salt, 64)).toString('hex')}`;
  }
  async function checkPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    return timingSafeEqual(await scrypt(password, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
  }
  // Spent on unknown emails too, so response time doesn't reveal which emails have accounts.
  const DUMMY = hashPassword(randomUUID());

  // Behind a host's proxy every request comes from the proxy; the real client is the first X-Forwarded-For entry.
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

  // shortcut: in-memory, per process; move to the database if you run several instances.
  const attempts = new Map();
  function rateLimit(key, max = 10) {
    const t = now();
    const a = attempts.get(key);
    if (!a || a.reset < t) return void attempts.set(key, { n: 1, reset: t + 15 * 60_000 });
    if (++a.n > max) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }

  function cookie(res, value, maxAge) {
    res.setHeader('set-cookie', `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }
  async function startSession(res, userId) {
    const t = token();
    await db.run('insert into sessions values (?, ?, ?)', sha(t), userId, now() + SESSION_DAYS * 86400_000);
    cookie(res, t, SESSION_DAYS * 86400);
  }
  const sessionToken = (req) => /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  async function requireUser(req) {
    const t = sessionToken(req);
    const user = t && (await db.get('select users.* from sessions join users on users.id = sessions.user_id where sessions.id = ? and expires > ?', sha(t), now()));
    if (!user) throw new HttpError(401, 'Sign in first.');
    return user;
  }

  async function body(req) {
    // JSON-only bodies block cross-site form posts: a browser can't send this content type cross-origin without CORS.
    if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new HttpError(413, 'Request too large.');
    }
    try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }

  const subsOf = async (userId) =>
    (await db.all('select id, name, price, currency, cycle, start, category, source, trial from subs where user_id = ? order by name collate nocase', userId))
      .map((s) => ({ ...s, trial: Boolean(s.trial) }));
  const me = (user) => ({
    email: user.email,
    calendarUrl: `${baseUrl}/cal/${user.cal_token}.ics`,
    remindDays: user.remind_days,
    emailReminders: Boolean(user.email_reminders),
    gmail: gmailReady,
    mail: Boolean(sendMail),
  });
  const userById = (id) => db.get('select * from users where id = ?', id);
  function credentials(b) {
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    return { email, password: newPassword(password) };
  }
  function newPassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'Use a password of at least 8 characters.');
    return password;
  }
  const insertSubs = (userId, list, source) =>
    db.batch(list.map((s) => ['insert into subs (id, user_id, name, price, currency, cycle, start, category, source, trial) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), userId, s.name, s.price, s.currency, s.cycle, s.start, s.category, source, s.trial ? 1 : 0]));
  const saveScan = (userId, messages) =>
    db.run('insert or replace into scans values (?, ?, ?)', userId, JSON.stringify({ scanned: messages.length, found: detect(messages) }), now());

  function reminderEmail(user, items, today) {
    const line = ({ sub, date }) => {
      const when = daysUntil(date, today);
      const day = when === 0 ? 'today' : when === 1 ? 'tomorrow' : `in ${when} days (${date})`;
      return sub.trial && date === sub.start
        ? `${sub.name}: free trial ends ${day}, then ${money(sub.price, sub.currency)}. Cancel before then if you don't want it.`
        : `${sub.name}: ${money(sub.price, sub.currency)} ${day}`;
    };
    const [first] = items;
    const subject = items.length === 1
      ? (first.sub.trial && first.date === first.sub.start ? `Your ${first.sub.name} trial ends soon` : `${first.sub.name} charges ${money(first.sub.price, first.sub.currency)} soon`)
      : `${items.length} charges coming up`;
    const lines = items.map(line);
    const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return {
      to: user.email,
      subject,
      text: `${lines.join('\n')}\n\nSee everything: ${baseUrl}\nTurn these emails off in Settings.`,
      html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#2a2420;max-width:520px">
        <p style="font-size:18px;font-weight:600;margin:0 0 12px">${esc(subject)}</p>
        ${lines.map((l) => `<p style="margin:0 0 8px">${esc(l)}</p>`).join('')}
        <p style="margin:20px 0 0"><a href="${baseUrl}" style="color:#b4432b">Open Subtrack</a></p>
        <p style="margin:16px 0 0;font-size:12px;color:#8a817a">You get these because email reminders are on. Turn them off in Settings.</p></div>`,
    };
  }

  async function runReminders() {
    const today = new Date().toISOString().slice(0, 10);
    const users = sendMail ? await db.all('select id, email, remind_days from users where email_reminders = 1') : [];
    let emails = 0;
    // shortcut: one user at a time; fine for hundreds of users, batch it beyond that.
    for (const user of users) {
      const sent = new Set((await db.all('select sub_id, date from reminders_sent where user_id = ?', user.id)).map((r) => `${r.sub_id}|${r.date}`));
      const fresh = upcoming(await subsOf(user.id), today, user.remind_days + 1).filter((u) => !sent.has(`${u.sub.id}|${u.date}`));
      if (!fresh.length) continue;
      try {
        await sendMail(reminderEmail(user, fresh, today));
        emails++;
        await db.batch(fresh.map((u) => ['insert or ignore into reminders_sent values (?, ?, ?)', user.id, u.sub.id, u.date]));
      } catch (e) {
        console.error(`reminder to user ${user.id} failed:`, e.message);
      }
    }
    // Housekeeping rides along with the daily run.
    await db.batch([
      ['delete from sessions where expires < ?', now()],
      ['delete from oauth_states where expires < ?', now()],
      ['delete from resets where expires < ?', now()],
      ['delete from reminders_sent where date < ?', new Date(now() - 60 * 86400_000).toISOString().slice(0, 10)],
    ]);
    return { users: users.length, emails };
  }

  const routes = {
    'GET /api/health': () => [200, { ok: true }],
    'POST /api/signup': async (req, res) => {
      rateLimit(`auth:${clientIp(req)}`);
      const { email, password } = credentials(await body(req));
      if (await db.get('select 1 from users where email = ?', email)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
      const id = randomUUID();
      await db.run('insert into users (id, email, pass, cal_token) values (?, ?, ?, ?)', id, email, await hashPassword(password), token());
      await startSession(res, id);
      return [201, me(await userById(id))];
    },
    'POST /api/login': async (req, res) => {
      rateLimit(`auth:${clientIp(req)}`);
      const { email, password } = await body(req);
      const user = await db.get('select * from users where email = ?', String(email || '').trim());
      const ok = await checkPassword(String(password || ''), user?.pass || (await DUMMY));
      if (!user || !ok) throw new HttpError(401, 'That email and password don’t match.');
      await startSession(res, user.id);
      return [200, me(user)];
    },
    'POST /api/logout': async (req, res) => {
      await body(req);
      const t = sessionToken(req);
      if (t) await db.run('delete from sessions where id = ?', sha(t));
      cookie(res, '', 0);
      return [204];
    },
    'POST /api/reset/request': async (req) => {
      rateLimit(`reset:${clientIp(req)}`, 5);
      if (!sendMail) throw new HttpError(501, 'Password reset needs email, which isn’t set up on this server.');
      const email = String((await body(req)).email || '').trim();
      const user = email && (await db.get('select * from users where email = ?', email));
      if (user) {
        const t = token();
        await db.run('insert into resets values (?, ?, ?)', sha(t), user.id, now() + 60 * 60_000);
        sendMail({
          to: user.email,
          subject: 'Reset your Subtrack password',
          text: `Someone asked to reset the password for this account. If that was you, open this link within an hour:\n\n${baseUrl}/?reset=${t}\n\nIf it wasn't, ignore this email. Your password stays the same.`,
          html: `<div style="font:15px/1.5 system-ui,sans-serif;color:#2a2420;max-width:520px"><p>Someone asked to reset the password for this account. If that was you, open this link within an hour:</p><p><a href="${baseUrl}/?reset=${t}" style="color:#b4432b">Choose a new password</a></p><p style="font-size:13px;color:#8a817a">If it wasn't you, ignore this email. Your password stays the same.</p></div>`,
        }).catch((e) => console.error('reset email failed:', e.message));
      }
      // Same answer either way, so this can't be used to find out who has an account.
      return [202, { ok: true }];
    },
    'POST /api/reset': async (req, res) => {
      rateLimit(`reset:${clientIp(req)}`, 5);
      const b = await body(req);
      const password = newPassword(b.password);
      const row = await db.get('select user_id from resets where id = ? and expires > ?', sha(String(b.token || '')), now());
      if (!row) throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
      await db.batch([
        ['update users set pass = ? where id = ?', await hashPassword(password), row.user_id],
        ['delete from resets where user_id = ?', row.user_id],
        ['delete from sessions where user_id = ?', row.user_id],
      ]);
      await startSession(res, row.user_id);
      return [200, me(await userById(row.user_id))];
    },
    'GET /api/me': async (req) => [200, me(await requireUser(req))],
    'PATCH /api/me': async (req) => {
      const user = await requireUser(req);
      const b = await body(req);
      const days = b.remindDays === undefined ? user.remind_days : Number(b.remindDays);
      if (![1, 3, 7].includes(days)) throw new HttpError(400, 'Reminders can be 1, 3 or 7 days before.');
      const on = b.emailReminders === undefined ? user.email_reminders : b.emailReminders ? 1 : 0;
      await db.run('update users set remind_days = ?, email_reminders = ? where id = ?', days, on, user.id);
      return [200, me(await userById(user.id))];
    },
    'DELETE /api/me': async (req, res) => {
      const user = await requireUser(req);
      if (!(await checkPassword(String((await body(req)).password || ''), user.pass))) throw new HttpError(403, 'Wrong password.');
      await db.run('delete from users where id = ?', user.id);
      cookie(res, '', 0);
      return [204];
    },
    'POST /api/me/calendar': async (req) => {
      const user = await requireUser(req);
      await body(req);
      await db.run('update users set cal_token = ? where id = ?', token(), user.id);
      return [200, me(await userById(user.id))];
    },
    'GET /api/subs': async (req) => [200, await subsOf((await requireUser(req)).id)],
    'POST /api/subs': async (req) => {
      const user = await requireUser(req);
      const b = await body(req);
      const list = validSubs(Array.isArray(b) ? b : [b]);
      if (!list.length) throw new HttpError(400, 'Check the subscription details.');
      if ((await subsOf(user.id)).length + list.length > 500) throw new HttpError(400, 'That’s more than 500 subscriptions.');
      await insertSubs(user.id, list, Array.isArray(b) ? 'import' : 'manual');
      return [201, await subsOf(user.id)];
    },
    'PUT /api/subs/:id': async (req, res, id) => {
      const user = await requireUser(req);
      const [s] = validSubs([await body(req)]);
      if (!s) throw new HttpError(400, 'Check the subscription details.');
      const r = await db.run('update subs set name = ?, price = ?, currency = ?, cycle = ?, start = ?, category = ?, trial = ? where id = ? and user_id = ?', s.name, s.price, s.currency, s.cycle, s.start, s.category, s.trial ? 1 : 0, id, user.id);
      if (!r.changes) throw new HttpError(404, 'Not found.');
      return [200, await subsOf(user.id)];
    },
    'DELETE /api/subs/:id': async (req, res, id) => {
      const user = await requireUser(req);
      await body(req);
      await db.run('delete from subs where id = ? and user_id = ?', id, user.id);
      return [200, await subsOf(user.id)];
    },
    'GET /api/gmail/start': async (req, res) => {
      const user = await requireUser(req);
      if (!gmailReady) throw new HttpError(501, 'Gmail sign-in isn’t configured on this server.');
      const state = token();
      await db.run('insert into oauth_states values (?, ?, ?)', state, user.id, now() + 10 * 60_000);
      res.writeHead(302, { location: gmail.authUrl({ clientId: googleClientId, redirectUri, state }) }).end();
    },
    'GET /api/gmail/callback': async (req, res, _, url) => {
      const user = await requireUser(req);
      const state = url.searchParams.get('state') || '';
      const row = await db.get('delete from oauth_states where state = ? and user_id = ? and expires > ? returning 1 as ok', state, user.id, now());
      let outcome = 'done';
      if (!row || !url.searchParams.get('code')) outcome = url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed';
      else {
        try {
          await saveScan(user.id, await gmailScan({ code: url.searchParams.get('code'), clientId: googleClientId, clientSecret: googleClientSecret, redirectUri }));
        } catch (e) {
          console.error('gmail scan failed:', e.message);
          outcome = 'failed';
        }
      }
      res.writeHead(302, { location: `/?scan=${outcome}` }).end();
    },
    'POST /api/scan/imap': async (req) => {
      const user = await requireUser(req);
      rateLimit(`imap:${user.id}`, 5);
      const b = await body(req);
      const email = String(b.email || '').trim();
      const password = String(b.password || '').replace(/\s+/g, ''); // app passwords are shown with spaces
      if (!email.includes('@') || !password) throw new HttpError(400, 'Enter your email address and app password.');
      try {
        await saveScan(user.id, await imapScan({ email, password }));
      } catch (e) {
        if (e.userFacing) throw new HttpError(400, e.message);
        console.error('imap scan failed:', e.message);
        throw new HttpError(502, 'Couldn’t read your mailbox. Check that IMAP is turned on for your email account, then try again.');
      }
      const row = await db.get('select found from scans where user_id = ?', user.id);
      return [200, JSON.parse(row.found)];
    },
    'GET /api/scan': async (req) => {
      const row = await db.get('select found, created from scans where user_id = ?', (await requireUser(req)).id);
      return [200, row ? { ...JSON.parse(row.found), created: row.created } : null];
    },
    'DELETE /api/scan': async (req) => {
      const user = await requireUser(req);
      await body(req);
      await db.run('delete from scans where user_id = ?', user.id);
      return [204];
    },
    'POST /api/cron/reminders': async (req) => {
      if (!sameSecret(req.headers.authorization, `Bearer ${cronSecret}`) || !cronSecret) throw new HttpError(401, 'Not allowed.');
      await body(req);
      return [200, await runReminders()];
    },
  };

  async function serveStatic(req, res, url) {
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found.');
    let data;
    try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  }

  async function calendar(req, res, url) {
    const t = /^\/cal\/([\w-]+)\.ics$/.exec(url.pathname)?.[1];
    const user = t && (await db.get('select id from users where cal_token = ?', t));
    if (!user) throw new HttpError(404, 'Not found.');
    const remind = Math.min(30, Math.max(0, Number(url.searchParams.get('remind')) || 3));
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' }).end(toICS(await subsOf(user.id), remind));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-security-policy', CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    const url = new URL(req.url, baseUrl);
    try {
      await ready;
      if (url.pathname.startsWith('/cal/')) return await calendar(req, res, url);
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url);
      if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== new URL(baseUrl).origin) throw new HttpError(403, 'Cross-origin request refused.');
      const [, base, id] = /^(\/api\/subs)\/([\w-]+)$/.exec(url.pathname) || [];
      const handler = routes[`${req.method} ${base ? `${base}/:id` : url.pathname}`];
      if (!handler) throw new HttpError(404, 'Not found.');
      const out = await handler(req, res, id, url);
      if (!out || res.headersSent) return;
      const [status, data] = out;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(data === undefined ? undefined : JSON.stringify(data));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      const status = e.status || 500;
      if (res.headersSent) return res.end();
      if (url.pathname.startsWith('/api/') || status !== 404) res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.status ? e.message : 'Something went wrong on our side.' }));
      else res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  server.on('close', () => db.close());
  server.runReminders = runReminders;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const port = Number(env.PORT) || 3000;
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
  const app = createApp({
    dbPath: env.DATABASE_PATH || 'subtrack.db',
    tursoUrl: env.TURSO_DATABASE_URL,
    tursoToken: env.TURSO_AUTH_TOKEN,
    baseUrl,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    sendMail:
      env.SMTP_HOST === 'console' ? async (m) => console.log(`\n--- email to ${m.to}: ${m.subject}\n${m.text}\n---`) // local development
      : env.SMTP_HOST ? smtp({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.MAIL_FROM })
      : null,
    cronSecret: env.CRON_SECRET,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  });
  app.listen(port, () => console.log(`Subtrack running on ${baseUrl}`));
}
