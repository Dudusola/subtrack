// Reads receipt emails over IMAP with an app password: free, and needs no approval from Google.
// The password is used for this one connection and never stored.
import tls from 'node:tls';
import { parseMessage } from './mime.js';

export const PROVIDERS = {
  'gmail.com': 'imap.gmail.com',
  'googlemail.com': 'imap.gmail.com',
  'yahoo.com': 'imap.mail.yahoo.com',
  'ymail.com': 'imap.mail.yahoo.com',
  'icloud.com': 'imap.mail.me.com',
  'me.com': 'imap.mail.me.com',
  'zoho.com': 'imap.zoho.com',
  'aol.com': 'imap.aol.com',
};
const KEYWORDS = ['receipt', 'invoice', 'subscription', 'renewal', 'payment', 'membership', 'billed'];
const GMAIL_QUERY = 'newer_than:13m -category:promotions -category:social {receipt invoice subscription renewal renews payment membership billed charged}';
const MAX_MESSAGES = 300;
const BYTES_PER_MESSAGE = 24_000;

const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

export async function imapScan({ email, password, host = PROVIDERS[email.split('@')[1]?.toLowerCase()], port = 993, connect = () => tls.connect({ host, port, servername: host }) }) {
  if (!host) throw Object.assign(new Error('That email provider isn’t supported for app-password scans yet. Gmail, Yahoo, iCloud, Zoho and AOL work.'), { userFacing: true });
  const socket = connect();
  socket.setEncoding('latin1'); // keep raw bytes; MIME decoding turns them into text later
  socket.setTimeout(90_000, () => socket.destroy(new Error('IMAP timed out')));
  let buf = '';
  let wake = null;
  let failure = null;
  socket.on('data', (d) => { buf += d; wake?.(); });
  socket.on('error', (e) => { failure = e; wake?.(); });
  socket.on('close', () => { failure ??= new Error('IMAP connection closed'); wake?.(); });
  const more = () => new Promise((r) => { if (failure) throw failure; wake = r; }).then(() => { wake = null; if (failure) throw failure; });

  // One response "line", with any {n} literals pulled out in order.
  async function readLine() {
    let text = '';
    const literals = [];
    for (;;) {
      let end;
      while ((end = buf.indexOf('\r\n')) < 0) await more();
      const line = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const lit = /\{(\d+)\}$/.exec(line);
      if (!lit) return { text: text + line, literals };
      const n = Number(lit[1]);
      while (buf.length < n) await more();
      literals.push(buf.slice(0, n));
      buf = buf.slice(n);
      text += line.slice(0, lit.index) + '\0';
    }
  }

  let seq = 0;
  async function command(cmd) {
    const tag = `a${++seq}`;
    socket.write(`${tag} ${cmd}\r\n`);
    const untagged = [];
    for (;;) {
      const r = await readLine();
      if (r.text.startsWith(`${tag} `)) {
        if (!/^\S+ OK/i.test(r.text)) {
          if (cmd.startsWith('LOGIN')) throw Object.assign(new Error('Your email provider rejected that email and app password.'), { userFacing: true });
          throw new Error(`IMAP ${cmd.split(' ')[0]}: ${r.text.slice(tag.length + 1, 200)}`);
        }
        return untagged;
      }
      untagged.push(r);
    }
  }

  try {
    await readLine(); // greeting
    const caps = (await command('CAPABILITY')).map((r) => r.text).join(' ');
    await command(`LOGIN ${quote(email)} ${quote(password)}`);
    // Gmail keeps archived mail outside INBOX; its "\All" folder sees everything.
    const all = (await command('LIST "" "*"')).map((r) => r.text).find((t) => /\\All\b/.test(t));
    const mailbox = all ? /"([^"]+)"\s*$|(\S+)\s*$/.exec(all).slice(1).find(Boolean) : 'INBOX';
    await command(`EXAMINE ${quote(mailbox)}`);

    let search;
    if (/X-GM-EXT-1/.test(caps)) search = `UID SEARCH X-GM-RAW ${quote(GMAIL_QUERY)}`;
    else {
      const since = new Date(Date.now() - 395 * 86400_000).toUTCString().split(' ').slice(1, 4).join('-'); // 13-Oct-2025
      search = `UID SEARCH SINCE ${since} ${KEYWORDS.slice(0, -1).map((k) => `OR SUBJECT ${k} `).join('')}SUBJECT ${KEYWORDS.at(-1)}`;
    }
    const uids = (await command(search)).flatMap((r) => (/^\* SEARCH\b(.*)/.exec(r.text)?.[1] || '').trim().split(/\s+/).filter(Boolean)).slice(-MAX_MESSAGES);

    const messages = [];
    for (let i = 0; i < uids.length; i += 50) {
      const rows = await command(`UID FETCH ${uids.slice(i, i + 50).join(',')} (INTERNALDATE BODY.PEEK[]<0.${BYTES_PER_MESSAGE}>)`);
      for (const r of rows) {
        const date = /INTERNALDATE "([^"]+)"/.exec(r.text)?.[1];
        if (!date || !r.literals.length) continue;
        const { from, subject, text } = parseMessage(r.literals.at(-1));
        messages.push({ from, subject, date: new Date(date.replace(/-/g, ' ')).toISOString().slice(0, 10), snippet: text.slice(0, 3000) });
      }
    }
    await command('LOGOUT').catch(() => {});
    return messages;
  } finally {
    socket.destroy();
  }
}
