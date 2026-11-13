import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, htmlToText } from '../mime.js';
import { buildMessage } from '../mailer.js';
import { parseAmount } from '../detect.js';

// Bytes as they arrive from IMAP (latin1 string), including a UTF-8 naira sign.
const latin1 = (s) => Buffer.from(s, 'utf8').toString('latin1');

test('multipart receipt: quoted-printable plain text wins over HTML', () => {
  const raw = latin1([
    'From: =?UTF-8?B?U3BvdGlmeQ==?= <no-reply@spotify.com>',
    'Subject: =?UTF-8?Q?Your_receipt_=E2=80=94_Premium?=',
    'Content-Type: multipart/alternative; boundary="xyz"',
    '',
    '--xyz',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Subtotal =E2=82=A61,200.00 Total charged =E2=82=A61,300.00 for your mon=',
    'thly plan',
    '--xyz',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<p>HTML copy</p>').toString('base64'),
    '--xyz--',
  ].join('\r\n'));
  const m = parseMessage(raw);
  assert.equal(m.from, 'Spotify <no-reply@spotify.com>');
  assert.equal(m.subject, 'Your receipt — Premium');
  assert.match(m.text, /monthly plan/);
  assert.deepEqual(parseAmount(m.text), { price: 1300, currency: 'NGN' }, 'labelled total beats the subtotal');
});

test('HTML-only base64 receipt becomes text', () => {
  const html = '<style>.x{}</style><table><tr><td>Amount paid</td><td>&#36;9.99</td></tr></table>';
  const raw = ['From: a@b.com', 'Subject: Receipt', 'Content-Type: text/html', 'Content-Transfer-Encoding: base64', '', Buffer.from(html).toString('base64')].join('\r\n');
  assert.equal(parseMessage(raw).text, 'Amount paid $9.99');
  assert.equal(htmlToText('a&nbsp;&amp;&#x20A6;b'), 'a &₦b');
});

test('outgoing mail encodes subject and body and can be parsed back', () => {
  const msg = buildMessage({ from: 'Subtrack <me@gmail.com>', to: 'you@example.com', subject: 'Netflix charges ₦4,400 soon', text: 'Hi\n.dot line', html: '<b>Hi</b>' });
  assert.match(msg, /Subject: =\?UTF-8\?B\?/);
  assert.equal(parseMessage(latin1(msg)).subject, 'Netflix charges ₦4,400 soon');
  assert.match(parseMessage(latin1(msg)).text, /\.dot line/);
});
