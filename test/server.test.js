import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

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
