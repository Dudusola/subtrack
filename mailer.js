// Sends mail over SMTP with implicit TLS (port 465). Works with a free Gmail app password, Brevo, Zoho, etc.
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMessage({ from, to, subject, text, html }) {
  const boundary = `b-${randomUUID()}`;
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${from.split('@')[1]?.replace(/>.*/, '') || 'subtrack'}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export function smtp({ host, port = 465, user, pass, from, connect = () => tls.connect({ host, port, servername: host }) }) {
  return async function sendMail(mail) {
    const socket = connect();
    socket.setEncoding('utf8');
    socket.setTimeout(30_000, () => socket.destroy(new Error('SMTP timed out')));
    let buf = '';
    const waiters = [];
    socket.on('data', (d) => { buf += d; waiters.shift()?.(); });
    socket.on('error', (e) => { while (waiters.length) waiters.shift()(e); });

    // Reads one full reply (multi-line replies use "250-" until the final "250 ").
    async function reply(expect) {
      for (;;) {
        const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buf);
        if (m) {
          const text = buf.slice(0, m.index + m[0].length);
          buf = buf.slice(m.index + m[0].length);
          if (!String(m[1]).startsWith(expect)) throw new Error(`SMTP: ${text.trim().slice(0, 200)}`);
          return text;
        }
        const err = await new Promise((r) => waiters.push(r));
        if (err) throw err;
      }
    }
    const send = (line, expect) => { socket.write(`${line}\r\n`); return reply(expect); };

    try {
      await reply('2');
      await send('EHLO subtrack', '2');
      await send('AUTH LOGIN', '3');
      await send(b64(user), '3');
      await send(b64(pass), '2');
      await send(`MAIL FROM:<${user}>`, '2');
      await send(`RCPT TO:<${mail.to}>`, '2');
      await send('DATA', '3');
      // Dot-stuffing: a line starting with "." must be doubled so it isn't read as the end.
      await send(`${buildMessage({ from: from || user, ...mail }).replace(/^\./gm, '..')}\r\n.`, '2');
      socket.write('QUIT\r\n');
    } finally {
      socket.end();
    }
  };
}
