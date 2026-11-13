// Just enough MIME to turn a receipt email into searchable text. Strings here are raw bytes (latin1).
const utf8 = (bytes) => Buffer.from(bytes, 'latin1').toString('utf8');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', naira: '₦', euro: '€', pound: '£' };
export function htmlToText(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
      e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

// RFC 2047 encoded words, e.g. =?UTF-8?B?4oKmIHJlY2VpcHQ=?=
export function decodeWords(s) {
  // Whitespace is dropped only between two encoded words (RFC 2047 §6.2).
  return s.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=(?:\s+(?==\?))?/gi, (_, charset, enc, data) => {
    const bytes = enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64')
      : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return /utf-?8/i.test(charset) ? bytes.toString('utf8') : bytes.toString('latin1');
  });
}

function headers(block) {
  const out = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return out;
}

function decodeBody(body, encoding) {
  if (/base64/i.test(encoding)) return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8');
  if (/quoted-printable/i.test(encoding)) return utf8(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return utf8(body);
}

function partText(raw, depth) {
  const split = raw.search(/\r?\n\r?\n/);
  const h = headers(split < 0 ? raw : raw.slice(0, split));
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const type = h['content-type'] || 'text/plain';
  const boundary = /boundary="?([^";\s]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary && depth < 6) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    const texts = parts.map((p) => partText(p.replace(/^\r?\n/, ''), depth + 1));
    return texts.find((t, i) => t && /text\/plain/i.test(parts[i].slice(0, 300))) || texts.filter(Boolean).join(' ');
  }
  if (!/^text\//i.test(type)) return '';
  const text = decodeBody(body, h['content-transfer-encoding'] || '');
  return /html/i.test(type) ? htmlToText(text) : text.replace(/\s+/g, ' ').trim();
}

// Raw RFC 822 message (possibly cut short) -> { from, subject, text }.
export function parseMessage(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const h = headers(split < 0 ? raw : raw.slice(0, split));
  return { from: decodeWords(h.from || ''), subject: decodeWords(h.subject || ''), text: partText(raw, 0) };
}
