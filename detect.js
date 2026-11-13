// Turns receipt-like emails into subscription candidates.
// Input: [{ from, subject, date: 'YYYY-MM-DD', snippet }]. Pure, so it is tested without Gmail.
import { daysUntil } from './public/core.js';

const RECEIPT = /\b(receipt|invoice|subscription|renew(al|s|ed)?|payment|charged|billed|billing|membership|your plan|trial)\b/i;
const NOISE = /\b(shipped|delivered|delivery|refund(ed)?|password|verify|verification|sign[- ]?in|security alert|webinar|newsletter|% off|sale ends|order #?\d+ (has )?shipped)\b/i;
const RECURRING = /\b(subscription|renew(al|s|ed)?|membership|plan|monthly|annual|yearly|per month|per year|auto-?pay)\b/i;
const CODES = 'USD|EUR|GBP|NGN|INR|CAD|AUD|JPY|ZAR|KES|GHS|BRL|MXN';
const SYMBOLS = { $: 'USD', US$: 'USD', CA$: 'CAD', A$: 'AUD', '€': 'EUR', '£': 'GBP', '₦': 'NGN', '₹': 'INR', '¥': 'JPY' };
const NUM = '(\\d{1,3}(?:,\\d{3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const AMOUNT = new RegExp(`(US\\$|CA\\$|A\\$|[$€£₦₹¥])\\s?${NUM}|\\b(${CODES})\\s?${NUM}|${NUM}\\s?(${CODES})\\b`);

export function parseAmount(text) {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const [currency, num] = m[1] ? [SYMBOLS[m[1]], m[2]] : m[3] ? [m[3], m[4]] : [m[6], m[5]];
  const price = Number(num.replace(/,/g, ''));
  return price > 0 ? { price, currency } : null;
}

// Groups mail by the sender's registrable domain, so billing.x.com and x.com are one merchant.
export function merchant(from) {
  const email = (/<([^>]+)>/.exec(from)?.[1] || from).trim().toLowerCase();
  const labels = email.split('@')[1]?.split('.') || [];
  const take = labels.length > 2 && labels.at(-2).length <= 3 && labels.at(-1).length === 2 ? 3 : 2; // co.uk, com.ng
  const key = labels.slice(-take).join('.');
  const display = (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] || '')
    .replace(/\b(receipts?|billing|payments?|team|support|no-?reply|notifications?|accounts?|invoices?)\b/gi, '')
    .replace(/\s+(via|from)\s+.*$/i, '')
    .replace(/[\s,|·-]+$/, '')
    .trim();
  const fallback = labels.at(-take) || key;
  return { key, name: display || fallback.charAt(0).toUpperCase() + fallback.slice(1) };
}

function cycleFromGaps(dates) {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => daysUntil(d, dates[i])).sort((a, b) => a - b);
  const g = gaps[Math.floor(gaps.length / 2)];
  if (g >= 5 && g <= 10) return 'weekly';
  if (g >= 25 && g <= 35) return 'monthly';
  if (g >= 330 && g <= 400) return 'yearly';
  return null;
}

function cycleFromText(text) {
  if (/\b(annual(ly)?|yearly|per year|\/\s?yr|\/\s?year|12 months)\b/i.test(text)) return 'yearly';
  if (/\b(weekly|per week|\/\s?wk)\b/i.test(text)) return 'weekly';
  if (/\b(monthly|per month|\/\s?mo(nth)?)\b/i.test(text)) return 'monthly';
  return null;
}

export function detect(messages) {
  const groups = new Map();
  for (const msg of messages) {
    const text = `${msg.subject} ${msg.snippet}`;
    if (!RECEIPT.test(text) || NOISE.test(text)) continue;
    const { key, name } = merchant(msg.from);
    if (!key) continue;
    const g = groups.get(key) || { key, name, charges: [], text: '' };
    const amount = parseAmount(text);
    if (amount) g.charges.push({ ...amount, date: msg.date, subject: msg.subject });
    g.text += ' ' + text;
    groups.set(key, g);
  }

  const found = [];
  for (const g of groups.values()) {
    if (!g.charges.length) continue;
    g.charges.sort((a, b) => a.date.localeCompare(b.date));
    // Receipt + "payment received" for one charge arrive days apart; count each billing once.
    const dates = g.charges.map((c) => c.date).filter((d, i, all) => i === 0 || daysUntil(d, all[i - 1]) > 3);
    const last = g.charges.at(-1);
    let cycle = cycleFromGaps(dates);
    let confidence = 'high';
    if (!cycle) {
      cycle = cycleFromText(g.text);
      confidence = 'medium';
    }
    if (!cycle && RECURRING.test(g.text)) {
      cycle = 'monthly';
      confidence = 'low';
    }
    if (!cycle) continue;
    found.push({
      key: g.key,
      name: g.name,
      price: last.price,
      currency: last.currency,
      cycle,
      start: last.date,
      category: '',
      confidence,
      receipts: dates.length,
      lastSubject: last.subject.slice(0, 120),
    });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return found.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.receipts - a.receipts);
}
