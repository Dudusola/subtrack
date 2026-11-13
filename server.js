#!/usr/bin/env node
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toICS, validSubs } from './public/core.js';
import { detect } from './detect.js';
import * as gmail from './gmail.js';

const scrypt = promisify(scryptCb);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const SESSION_DAYS = 30;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dbPath = ':memory:', baseUrl = 'http://localhost:3000', googleClientId, googleClientSecret, gmailScan = gmail.scan } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    pragma journal_mode = wal;
    pragma foreign_keys = on;
    create table if not exists users (id text primary key, email text unique not null collate nocase, pass text not null, cal_token text unique not null, created text not null default current_timestamp);
    create table if not exists sessions (id text primary key, user_id text not null references users on delete cascade, expires integer not null);
    create table if not exists subs (id text primary key, user_id text not null references users on delete cascade, name text not null, price real not null, currency text not null, cycle text not null, start text not null, category text not null default '', source text not null default 'manual');
    create table if not exists scans (user_id text primary key references users on delete cascade, found text not null, created integer not null);
    create table if not exists oauth_states (state text primary key, user_id text not null references users on delete cascade, expires integer not null);
    create index if not exists subs_user on subs (user_id);
  `);
  const q = (sql) => db.prepare(sql);
  const secure = baseUrl.startsWith('https:');
  const redirectUri = `${baseUrl}/api/gmail/callback`;
  const gmailReady = Boolean(googleClientId && googleClientSecret);
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const token = () => randomBytes(32).toString('base64url');

  async function hashPassword(password) {
    const salt = randomBytes(16);
    return `${salt.toString('hex')}:${(await scrypt(password, salt, 64)).toString('hex')}`;
  }
  async function checkPassword(password, stored) {
    const [salt, hash] = stored.split(':');
    const got = await scrypt(password, Buffer.from(salt, 'hex'), 64);
    return timingSafeEqual(got, Buffer.from(hash, 'hex'));
  }
  // Spent on unknown emails too, so response time doesn't reveal which emails have accounts.
  const DUMMY = hashPassword(randomUUID());

  // shortcut: in-memory, per process; move to the database if you run several instances.
  const attempts = new Map();
  function rateLimit(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (!a || a.reset < now) return attempts.set(key, { n: 1, reset: now + 15 * 60_000 });
    if (++a.n > 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }

  function cookie(res, value, maxAge) {
    res.setHeader('set-cookie', `sid=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }
  function startSession(res, userId) {
    const t = token();
    q('insert into sessions values (?, ?, ?)').run(sha(t), userId, Date.now() + SESSION_DAYS * 86400_000);
    cookie(res, t, SESSION_DAYS * 86400);
  }
  function currentUser(req) {
    const t = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
    if (!t) return null;
    return q('select users.* from sessions join users on users.id = sessions.user_id where sessions.id = ? and expires > ?').get(sha(t), Date.now()) || null;
  }
  function requireUser(req) {
    const user = currentUser(req);
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

  const subsOf = (userId) => q('select id, name, price, currency, cycle, start, category, source from subs where user_id = ? order by name collate nocase').all(userId);
  const me = (user) => ({
    email: user.email,
    calendarUrl: `${baseUrl}/cal/${user.cal_token}.ics`,
    gmail: gmailReady,
  });
  function credentials(b) {
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Use a password of at least 8 characters.');
    return { email, password };
  }
  function insertSubs(userId, list, source) {
    const ins = q('insert into subs (id, user_id, name, price, currency, cycle, start, category, source) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('begin');
    try {
      for (const s of list) ins.run(randomUUID(), userId, s.name, s.price, s.currency, s.cycle, s.start, s.category, source);
      db.exec('commit');
    } catch (e) { db.exec('rollback'); throw e; }
  }

  const routes = {
    'POST /api/signup': async (req, res) => {
      rateLimit(`auth:${req.socket.remoteAddress}`);
      const { email, password } = credentials(await body(req));
      if (q('select 1 from users where email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
      const id = randomUUID();
      q('insert into users (id, email, pass, cal_token) values (?, ?, ?, ?)').run(id, email, await hashPassword(password), token());
      startSession(res, id);
      return [201, me(q('select * from users where id = ?').get(id))];
    },
    'POST /api/login': async (req, res) => {
      rateLimit(`auth:${req.socket.remoteAddress}`);
      const { email, password } = await body(req);
      const user = q('select * from users where email = ?').get(String(email || '').trim());
      const ok = await checkPassword(String(password || ''), user?.pass || await DUMMY);
      if (!user || !ok) throw new HttpError(401, 'That email and password don’t match.');
      startSession(res, user.id);
      return [200, me(user)];
    },
    'POST /api/logout': async (req, res) => {
      await body(req);
      const t = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
      if (t) q('delete from sessions where id = ?').run(sha(t));
      cookie(res, '', 0);
      return [204];
    },
    'GET /api/me': (req) => [200, me(requireUser(req))],
    'DELETE /api/me': async (req, res) => {
      const user = requireUser(req);
      if (!(await checkPassword(String((await body(req)).password || ''), user.pass))) throw new HttpError(403, 'Wrong password.');
      q('delete from users where id = ?').run(user.id);
      cookie(res, '', 0);
      return [204];
    },
    'POST /api/me/calendar': async (req) => {
      const user = requireUser(req);
      await body(req);
      q('update users set cal_token = ? where id = ?').run(token(), user.id);
      return [200, me(q('select * from users where id = ?').get(user.id))];
    },
    'GET /api/subs': (req) => [200, subsOf(requireUser(req).id)],
    'POST /api/subs': async (req) => {
      const user = requireUser(req);
      const b = await body(req);
      const list = validSubs(Array.isArray(b) ? b : [b]);
      if (!list.length) throw new HttpError(400, 'Check the subscription details.');
      if (subsOf(user.id).length + list.length > 500) throw new HttpError(400, 'That’s more than 500 subscriptions.');
      insertSubs(user.id, list, Array.isArray(b) ? 'import' : 'manual');
      return [201, subsOf(user.id)];
    },
    'PUT /api/subs/:id': async (req, res, id) => {
      const user = requireUser(req);
      const [s] = validSubs([await body(req)]);
      if (!s) throw new HttpError(400, 'Check the subscription details.');
      const r = q('update subs set name = ?, price = ?, currency = ?, cycle = ?, start = ?, category = ? where id = ? and user_id = ?').run(s.name, s.price, s.currency, s.cycle, s.start, s.category, id, user.id);
      if (!r.changes) throw new HttpError(404, 'Not found.');
      return [200, subsOf(user.id)];
    },
    'DELETE /api/subs/:id': async (req, res, id) => {
      const user = requireUser(req);
      await body(req);
      q('delete from subs where id = ? and user_id = ?').run(id, user.id);
      return [200, subsOf(user.id)];
    },
    'GET /api/gmail/start': (req, res) => {
      const user = requireUser(req);
      if (!gmailReady) throw new HttpError(501, 'Gmail scanning isn’t configured on this server.');
      const state = token();
      q('delete from oauth_states where expires < ?').run(Date.now());
      q('insert into oauth_states values (?, ?, ?)').run(state, user.id, Date.now() + 10 * 60_000);
      res.writeHead(302, { location: gmail.authUrl({ clientId: googleClientId, redirectUri, state }) }).end();
    },
    'GET /api/gmail/callback': async (req, res, _, url) => {
      const user = requireUser(req);
      const state = url.searchParams.get('state') || '';
      const row = q('delete from oauth_states where state = ? and user_id = ? and expires > ? returning 1').get(state, user.id, Date.now());
      let outcome = 'done';
      if (!row || !url.searchParams.get('code')) outcome = url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed';
      else {
        try {
          const messages = await gmailScan({ code: url.searchParams.get('code'), clientId: googleClientId, clientSecret: googleClientSecret, redirectUri });
          q('insert or replace into scans values (?, ?, ?)').run(user.id, JSON.stringify({ scanned: messages.length, found: detect(messages) }), Date.now());
        } catch (e) {
          console.error('gmail scan failed:', e.message);
          outcome = 'failed';
        }
      }
      res.writeHead(302, { location: `/?scan=${outcome}` }).end();
    },
    'GET /api/scan': (req) => {
      const row = q('select found, created from scans where user_id = ?').get(requireUser(req).id);
      return [200, row ? { ...JSON.parse(row.found), created: row.created } : null];
    },
    'DELETE /api/scan': async (req) => {
      const user = requireUser(req);
      await body(req);
      q('delete from scans where user_id = ?').run(user.id);
      return [204];
    },
  };

  async function serveStatic(req, res, url) {
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found.');
    let data;
    try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  }

  function calendar(req, res, url) {
    const t = /^\/cal\/([\w-]+)\.ics$/.exec(url.pathname)?.[1];
    const user = t && q('select id from users where cal_token = ?').get(t);
    if (!user) throw new HttpError(404, 'Not found.');
    const remind = Math.min(30, Math.max(0, Number(url.searchParams.get('remind')) || 3));
    res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' }).end(toICS(subsOf(user.id), remind));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-security-policy', CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    const url = new URL(req.url, baseUrl);
    try {
      if (url.pathname.startsWith('/cal/')) return calendar(req, res, url);
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
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({
    dbPath: process.env.DATABASE_PATH || 'subtrack.db',
    baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  });
  app.listen(port, () => console.log(`Subtrack running on ${process.env.BASE_URL || `http://localhost:${port}`}`));
}
