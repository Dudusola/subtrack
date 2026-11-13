// One async interface over a local SQLite file (node:sqlite) or a free Turso database (HTTP).
import { DatabaseSync } from 'node:sqlite';

export function openDb({ path = ':memory:', tursoUrl, tursoToken } = {}) {
  return tursoUrl ? turso(tursoUrl, tursoToken) : local(path);
}

function local(path) {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
  const run = (sql, args) => db.prepare(sql).run(...args);
  return {
    all: async (sql, ...args) => db.prepare(sql).all(...args),
    get: async (sql, ...args) => db.prepare(sql).get(...args),
    run: async (sql, ...args) => ({ changes: Number(run(sql, args).changes) }),
    // Statements run in one transaction: all or nothing.
    batch: async (stmts) => {
      db.exec('begin');
      try {
        for (const [sql, ...args] of stmts) run(sql, args);
        db.exec('commit');
      } catch (e) {
        db.exec('rollback');
        throw e;
      }
    },
    close: async () => db.close(),
  };
}

// Turso speaks the Hrana-over-HTTP pipeline protocol: POST a list of statements, get rows back.
function turso(url, token) {
  const endpoint = `${url.replace(/^libsql:\/\//, 'https://')}/v2/pipeline`;
  const arg = (v) =>
    v === null || v === undefined ? { type: 'null' }
    : typeof v === 'number' ? (Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v })
    : { type: 'text', value: String(v) };
  const value = (c) => (c.type === 'null' ? null : c.type === 'integer' ? Number(c.value) : c.value);

  async function pipeline(stmts) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: [
          ...stmts.map(([sql, ...args]) => ({ type: 'execute', stmt: { sql, args: args.map(arg) } })),
          { type: 'close' },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Turso ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { results } = await res.json();
    const failed = results.find((r) => r.type === 'error');
    if (failed) throw new Error(`Turso: ${failed.error.message}`);
    return results.slice(0, stmts.length).map((r) => {
      const { cols, rows, affected_row_count } = r.response.result;
      return { rows: rows.map((row) => Object.fromEntries(row.map((c, i) => [cols[i].name, value(c)]))), changes: affected_row_count };
    });
  }

  return {
    all: async (sql, ...args) => (await pipeline([[sql, ...args]]))[0].rows,
    get: async (sql, ...args) => (await pipeline([[sql, ...args]]))[0].rows[0],
    run: async (sql, ...args) => ({ changes: (await pipeline([[sql, ...args]]))[0].changes }),
    // Each step runs only if the previous one succeeded; any failure rolls the whole batch back.
    batch: async (stmts) => {
      const all = [['begin'], ...stmts, ['commit']];
      const steps = all.map(([sql, ...args], i) => ({ stmt: { sql, args: args.map(arg) }, ...(i && { condition: { type: 'ok', step: i - 1 } }) }));
      steps.push({ stmt: { sql: 'rollback' }, condition: { type: 'not', cond: { type: 'ok', step: all.length - 1 } } });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ type: 'batch', batch: { steps } }, { type: 'close' }] }),
      });
      if (!res.ok) throw new Error(`Turso ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const [r] = (await res.json()).results;
      const err = r.type === 'error' ? r.error : r.response.result.step_errors.slice(0, -1).find(Boolean);
      if (err) throw new Error(`Turso: ${err.message}`);
    },
    close: async () => {},
  };
}
