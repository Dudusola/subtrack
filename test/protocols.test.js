// Talks to fake IMAP and SMTP servers over plain local sockets to check the protocol handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { imapScan } from '../imap.js';
import { smtp } from '../mailer.js';
import { parseMessage } from '../mime.js';

function fakeServer(onLine, greeting) {
  const server = net.createServer((sock) => {
    sock.setEncoding('latin1');
    sock.write(greeting);
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line, (s) => sock.write(s, 'latin1'), sock);
      }
    });
  });
  return new Promise((r) => server.listen(0, () => r(server)));
}

const receipt = Buffer.from([
  'From: "Netflix" <info@account.netflix.com>',
  'Subject: Your receipt',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Total charged ₦4,400.00 for your monthly plan',
].join('\r\n'), 'utf8').toString('latin1');

test('IMAP: logs in, finds the All Mail folder, searches with Gmail syntax and parses literals', async (t) => {
  const seen = [];
  const server = await fakeServer((line, send) => {
    const [tag, ...rest] = line.split(' ');
    const cmd = rest.join(' ');
    seen.push(cmd.split(' ')[0] + (cmd.startsWith('UID') ? ` ${rest[1]}` : ''));
    if (cmd === 'CAPABILITY') send('* CAPABILITY IMAP4rev1 X-GM-EXT-1\r\n');
    if (cmd.startsWith('LOGIN')) {
      if (!cmd.includes('"app-pass"')) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    }
    if (cmd.startsWith('LIST')) send('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n');
    if (cmd.startsWith('EXAMINE')) assert.equal(cmd, 'EXAMINE "[Gmail]/All Mail"');
    if (cmd.startsWith('UID SEARCH')) { assert.match(cmd, /X-GM-RAW "newer_than:13m/); send('* SEARCH 7 9\r\n'); }
    if (cmd.startsWith('UID FETCH')) {
      for (const [seq, uid] of [[1, 7], [2, 9]]) {
        send(`* ${seq} FETCH (UID ${uid} INTERNALDATE "0${seq}-Oct-2026 10:00:00 +0000" BODY[]<0> {${receipt.length}}\r\n${receipt})\r\n`);
      }
    }
    send(`${tag} OK done\r\n`);
  }, '* OK fake imap ready\r\n');
  t.after(() => server.close());
  const connect = () => net.connect(server.address().port, '127.0.0.1');

  const messages = await imapScan({ email: 'ada@gmail.com', password: 'app-pass', connect });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { from: '"Netflix" <info@account.netflix.com>', subject: 'Your receipt', date: '2026-10-01', snippet: 'Total charged ₦4,400.00 for your monthly plan' });
  assert.deepEqual(seen.slice(0, 5), ['CAPABILITY', 'LOGIN', 'LIST', 'EXAMINE', 'UID SEARCH']);

  await assert.rejects(imapScan({ email: 'ada@gmail.com', password: 'wrong', connect }), (e) => e.userFacing && /rejected/.test(e.message));
  await assert.rejects(imapScan({ email: 'ada@outlook.com', password: 'x', connect }), (e) => e.userFacing);
});

test('SMTP: authenticates, sends and dot-stuffs the message', async (t) => {
  let data = null, inData = false, lines = [];
  const auth = [];
  const server = await fakeServer((line, send) => {
    if (inData) {
      if (line === '.') { inData = false; data = lines.join('\r\n'); return send('250 queued\r\n'); }
      return lines.push(line);
    }
    if (line.startsWith('EHLO')) return send('250-fake\r\n250 AUTH LOGIN\r\n');
    if (line === 'AUTH LOGIN') return send('334 VXNlcm5hbWU6\r\n');
    if (auth.length < 2 && /^[A-Za-z0-9+/=]+$/.test(line)) { auth.push(Buffer.from(line, 'base64').toString()); return send(auth.length === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); }
    if (line === 'DATA') { inData = true; return send('354 go\r\n'); }
    if (line === 'QUIT') return send('221 bye\r\n');
    send('250 ok\r\n');
  }, '220 fake smtp\r\n');
  t.after(() => server.close());

  const send = smtp({ user: 'me@gmail.com', pass: 'app pass', from: 'Subtrack <me@gmail.com>', connect: () => net.connect(server.address().port, '127.0.0.1') });
  await send({ to: 'ada@example.com', subject: 'Hello ₦', text: 'line one\n.starts with a dot', html: '<p>hi</p>' });
  assert.deepEqual(auth, ['me@gmail.com', 'app pass']);
  const unstuffed = data.replace(/^\.\./gm, '.');
  const msg = parseMessage(Buffer.from(unstuffed, 'utf8').toString('latin1'));
  assert.equal(msg.subject, 'Hello ₦');
  assert.match(msg.text, /\.starts with a dot/);
});
