import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { fakeTurso } from './fake-turso.js';

async function backends(t) {
  const turso = await fakeTurso();
  t.after(() => turso.server.close());
  return { local: openDb(), turso: openDb({ tursoUrl: turso.url, tursoToken: 'test-token' }) };
}

test('local and Turso backends behave the same', async (t) => {
  for (const [name, db] of Object.entries(await backends(t))) {
    await db.run('create table t (id text primary key, n integer, price real, note text)');
    await db.run('insert into t values (?, ?, ?, ?)', 'a', 3, 9.99, null);
    assert.deepEqual({ ...(await db.get('select * from t where id = ?', 'a')) }, { id: 'a', n: 3, price: 9.99, note: null }, name);
    assert.equal((await db.run('update t set n = n + 1')).changes, 1, name);
    assert.equal((await db.all('select * from t')).length, 1, name);
    assert.equal(await db.get('select * from t where id = ?', 'missing'), undefined, name);
  }
});

test('a failing statement rolls back the whole batch', async (t) => {
  for (const [name, db] of Object.entries(await backends(t))) {
    await db.run('create table t (id text primary key)');
    await assert.rejects(db.batch([['insert into t values (?)', 'x'], ['insert into t values (?)', 'x']]), undefined, name);
    assert.equal((await db.all('select * from t')).length, 0, `${name}: nothing kept`);
    await db.batch([['insert into t values (?)', 'y'], ['insert into t values (?)', 'z']]);
    assert.equal((await db.all('select * from t')).length, 2, name);
  }
});

test('a wrong Turso token is an error, not an empty result', async (t) => {
  const turso = await fakeTurso();
  t.after(() => turso.server.close());
  await assert.rejects(openDb({ tursoUrl: turso.url, tursoToken: 'nope' }).all('select 1'), /401/);
});
