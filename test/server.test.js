import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { fakeTurso } from './fake-turso.js';

async function start(opts = {}) {
  const app = createApp({ googleClientId: 'id', googleClientSecret: 'secret', ...opts });
  await new Promise((r) => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  // A tiny cookie-jar client per "browser".
  const client = () => {
    let cookie = '';
    return async (method, path, data, headers = {}) => {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: { ...(data !== undefined && { 'content-type': 'application/json' }), cookie, ...headers },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
    };
  };
  return { app, base, client };
}

const sub = { name: 'Netflix', price: 15.49, currency: 'USD', cycle: 'monthly', start: '2026-01-15' };

test('accounts are isolated from each other', async (t) => {
  const { app, client } = await start();
  t.after(() => app.close());
  const ada = client(), bob = client();
  assert.equal((await ada('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' })).status, 201);
  assert.equal((await bob('POST', '/api/signup', { email: 'bob@example.com', password: 'battery staple' })).status, 201);
  const created = await ada('POST', '/api/subs', sub);
  assert.equal(created.status, 201);
  const id = created.json[0].id;
  assert.deepEqual((await bob('GET', '/api/subs')).json, []);
  assert.equal((await bob('PUT', `/api/subs/${id}`, { ...sub, price: 0 })).status, 404);
  await bob('DELETE', `/api/subs/${id}`, {});
  assert.equal((await ada('GET', '/api/subs')).json.length, 1);
});

test('sign in, wrong password, duplicate email, sign out', async (t) => {
  const { app, client } = await start();
  t.after(() => app.close());
  const c = client();
  await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  assert.equal((await c('POST', '/api/signup', { email: 'ADA@example.com', password: 'correct horse' })).status, 409);
  assert.equal((await c('POST', '/api/logout', {})).status, 204);
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'ada@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'ada@example.com', password: 'correct horse' })).status, 200);
  assert.equal((await c('GET', '/api/me')).json.email, 'ada@example.com');
});

test('mutations refuse form posts and other origins', async (t) => {
  const { app, client } = await start();
  t.after(() => app.close());
  const c = client();
  await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  assert.equal((await c('POST', '/api/subs', undefined, { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await c('POST', '/api/subs', sub, { origin: 'https://evil.example' })).status, 403);
});

test('gmail callback stores detected subscriptions for review', async (t) => {
  const { app, client } = await start({
    gmailScan: async ({ code }) => {
      assert.equal(code, 'abc');
      return [
        { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Spotify receipt', date: '2026-09-10', snippet: 'Premium ₦1,300.00' },
        { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Spotify receipt', date: '2026-10-10', snippet: 'Premium ₦1,300.00' },
      ];
    },
  });
  t.after(() => app.close());
  const c = client();
  await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  const startRes = await c('GET', '/api/gmail/start');
  assert.equal(startRes.status, 302);
  const state = new URL(startRes.headers.get('location')).searchParams.get('state');
  assert.equal((await c('GET', `/api/gmail/callback?code=abc&state=wrong`)).headers.get('location'), '/?scan=failed');
  assert.equal((await c('GET', `/api/gmail/callback?code=abc&state=${state}`)).headers.get('location'), '/?scan=done');
  const scan = (await c('GET', '/api/scan')).json;
  assert.equal(scan.scanned, 2);
  assert.equal(scan.found[0].name, 'Spotify');
  assert.equal(scan.found[0].currency, 'NGN');
  // State is single-use.
  assert.equal((await c('GET', `/api/gmail/callback?code=abc&state=${state}`)).headers.get('location'), '/?scan=failed');
});

test('calendar feed is private per token and rotates', async (t) => {
  const { app, client } = await start();
  t.after(() => app.close());
  const c = client();
  const me = (await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' })).json;
  await c('POST', '/api/subs', sub);
  const path = new URL(me.calendarUrl).pathname;
  const feed = await c('GET', path, undefined, { cookie: '' });
  assert.match(feed.json, /SUMMARY:Netflix renews/);
  await c('POST', '/api/me/calendar', {});
  assert.equal((await c('GET', path)).status, 404);
});

test('static files cannot escape the public folder', async (t) => {
  const { app, client } = await start();
  t.after(() => app.close());
  const c = client();
  assert.equal((await c('GET', '/')).status, 200);
  assert.equal((await c('GET', '/..%2fserver.js')).status, 404);
  assert.equal((await c('GET', '/%2e%2e/package.json')).status, 404);
});

test('password reset by email signs you in and kills old sessions', async (t) => {
  const outbox = [];
  const { app, client } = await start({ sendMail: async (m) => { outbox.push(m); } });
  t.after(() => app.close());
  const old = client(), anon = client();
  await old('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  assert.equal((await anon('POST', '/api/reset/request', { email: 'nobody@example.com' })).status, 202, 'same answer for unknown emails');
  assert.equal(outbox.length, 0);
  await anon('POST', '/api/reset/request', { email: 'ada@example.com' });
  const link = /https?:\/\/\S+\?reset=([\w-]+)/.exec(outbox[0].text);
  assert.ok(link, 'email contains a reset link');
  assert.equal((await anon('POST', '/api/reset', { token: 'bogus', password: 'new password 1' })).status, 400);
  assert.equal((await anon('POST', '/api/reset', { token: link[1], password: 'new password 1' })).status, 200);
  assert.equal((await anon('GET', '/api/me')).json.email, 'ada@example.com');
  assert.equal((await old('GET', '/api/me')).status, 401, 'old session revoked');
  assert.equal((await anon('POST', '/api/reset', { token: link[1], password: 'another one 1' })).status, 400, 'link is single-use');
  assert.equal((await client()('POST', '/api/login', { email: 'ada@example.com', password: 'new password 1' })).status, 200);
});

test('daily reminders: secret required, one email per charge, trials worded', async (t) => {
  const outbox = [];
  const { app, client } = await start({ sendMail: async (m) => { outbox.push(m); }, cronSecret: 's3cret' });
  t.after(() => app.close());
  const c = client();
  await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  const today = new Date().toISOString().slice(0, 10);
  const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  await c('POST', '/api/subs', [
    { ...sub, name: 'Soon', start: inDays(2) },
    { ...sub, name: 'Trialy', trial: true, start: today },
    { ...sub, name: 'Later', start: inDays(20) },
  ]);
  const cron = client();
  assert.equal((await cron('POST', '/api/cron/reminders', {}, { authorization: 'Bearer wrong' })).status, 401);
  const run = await cron('POST', '/api/cron/reminders', {}, { authorization: 'Bearer s3cret' });
  assert.deepEqual(run.json, { users: 1, emails: 1 });
  assert.equal(outbox[0].to, 'ada@example.com');
  assert.match(outbox[0].text, /Soon: US\$15\.49 in 2 days/);
  assert.match(outbox[0].text, /Trialy: free trial ends today/);
  assert.doesNotMatch(outbox[0].text, /Later/);
  await cron('POST', '/api/cron/reminders', {}, { authorization: 'Bearer s3cret' });
  assert.equal(outbox.length, 1, 'no repeat for the same charge');
  await c('PATCH', '/api/me', { emailReminders: false, remindDays: 7 });
  assert.deepEqual((await cron('POST', '/api/cron/reminders', {}, { authorization: 'Bearer s3cret' })).json, { users: 0, emails: 0 });
  assert.equal((await c('PATCH', '/api/me', { remindDays: 5 })).status, 400);
});

test('app-password scan stores results; provider rejection is shown to the user', async (t) => {
  const { app, client } = await start({
    imapScan: async ({ email, password }) => {
      if (password !== 'abcdabcdabcdabcd') throw Object.assign(new Error('Your email provider rejected that email and app password.'), { userFacing: true });
      return [
        { from: 'Canva <no-reply@canva.com>', subject: 'Your Canva Pro receipt', date: '2026-09-08', snippet: 'Total paid $14.99' },
        { from: 'Canva <no-reply@canva.com>', subject: 'Your Canva Pro receipt', date: '2026-10-08', snippet: 'Total paid $14.99' },
      ];
    },
  });
  t.after(() => app.close());
  const c = client();
  await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' });
  const bad = await c('POST', '/api/scan/imap', { email: 'ada@gmail.com', password: 'wrong' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /rejected/);
  const ok = await c('POST', '/api/scan/imap', { email: 'ada@gmail.com', password: 'abcd abcd abcd abcd' });
  assert.equal(ok.json.found[0].name, 'Canva');
  assert.equal((await c('GET', '/api/scan')).json.found.length, 1);
});

test('behind a proxy, rate limits apply per real client', async (t) => {
  const { app, client } = await start({ trustProxy: true });
  t.after(() => app.close());
  const c = client();
  for (let i = 0; i < 10; i++) await c('POST', '/api/login', { email: 'x@example.com', password: 'nope nope' }, { 'x-forwarded-for': '1.1.1.1' });
  assert.equal((await c('POST', '/api/login', { email: 'x@example.com', password: 'nope nope' }, { 'x-forwarded-for': '1.1.1.1' })).status, 429);
  assert.equal((await c('POST', '/api/login', { email: 'x@example.com', password: 'nope nope' }, { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' })).status, 401, 'another user is not locked out');
});

test('the whole API works on Turso too', async (t) => {
  const turso = await fakeTurso();
  const { app, client } = await start({ tursoUrl: turso.url, tursoToken: 'test-token' });
  t.after(() => { app.close(); turso.server.close(); });
  const c = client();
  assert.equal((await c('POST', '/api/signup', { email: 'ada@example.com', password: 'correct horse' })).status, 201);
  const list = (await c('POST', '/api/subs', [sub, { ...sub, name: 'Trial', trial: true }])).json;
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.name === 'Trial').trial, true);
  assert.equal((await c('PUT', `/api/subs/${list[0].id}`, { ...sub, price: 20 })).json.find((s) => s.id === list[0].id).price, 20);
  assert.equal((await c('POST', '/api/login', { email: 'ada@example.com', password: 'correct horse' })).status, 200);
});
