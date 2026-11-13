// A stand-in for Turso's HTTP pipeline API, backed by node:sqlite, so db.js's remote path is tested offline.
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

export async function fakeTurso() {
  const db = new DatabaseSync(':memory:');
  db.exec('pragma foreign_keys = on');
  const toArg = (a) => (a.type === 'null' ? null : a.type === 'integer' ? BigInt(a.value) : a.value);
  const toCell = (v) =>
    v === null ? { type: 'null' } : typeof v === 'bigint' || Number.isInteger(v) ? { type: 'integer', value: String(v) } : typeof v === 'number' ? { type: 'float', value: v } : { type: 'text', value: v };
  function execute({ sql, args = [] }) {
    const stmt = db.prepare(sql);
    stmt.setReadBigInts(true);
    if (stmt.columns().length) {
      const rows = stmt.all(...args.map(toArg));
      const cols = stmt.columns().map((c) => ({ name: c.name }));
      return { cols, rows: rows.map((r) => cols.map((c) => toCell(r[c.name]))), affected_row_count: 0 };
    }
    return { cols: [], rows: [], affected_row_count: Number(stmt.run(...args.map(toArg)).changes) };
  }
  const holds = (cond, ok) => (cond.type === 'ok' ? ok[cond.step] === true : !holds(cond.cond, ok));

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-token') return res.writeHead(401).end('unauthorized');
    let raw = '';
    for await (const c of req) raw += c;
    const results = JSON.parse(raw).requests.map((r) => {
      if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
      if (r.type === 'execute') {
        try { return { type: 'ok', response: { type: 'execute', result: execute(r.stmt) } }; } catch (e) { return { type: 'error', error: { message: e.message } }; }
      }
      const ok = [], step_results = [], step_errors = [];
      for (const step of r.batch.steps) {
        if (step.condition && !holds(step.condition, ok)) { ok.push(null); step_results.push(null); step_errors.push(null); continue; }
        try { step_results.push(execute(step.stmt)); step_errors.push(null); ok.push(true); } catch (e) { step_results.push(null); step_errors.push({ message: e.message }); ok.push(false); }
      }
      return { type: 'ok', response: { type: 'batch', result: { step_results, step_errors } } };
    });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ baton: null, results }));
  });
  await new Promise((r) => server.listen(0, r));
  return { url: `libsql://localhost:${server.address().port}`.replace('libsql://', 'http://'), server, db };
}
