// Pure logic: dates are 'YYYY-MM-DD' strings handled in UTC so time zones never shift a day.

export const CYCLES = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m: m - 1, d };
};
const fmt = (date) => date.toISOString().slice(0, 10);

// nth renewal after the anchor date; monthly/yearly clamp to month end (Jan 31 -> Feb 28 -> Mar 31).
export function nthRenewal(start, cycle, n) {
  const { y, m, d } = parse(start);
  if (cycle === 'weekly') return fmt(new Date(Date.UTC(y, m, d + 7 * n)));
  const months = m + n * (cycle === 'yearly' ? 12 : 1);
  const lastDay = new Date(Date.UTC(y, months + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(y, months, Math.min(d, lastDay))));
}

// First renewal on or after `today`.
export function nextRenewal(start, cycle, today) {
  let n = 0;
  while (nthRenewal(start, cycle, n) < today) n++;
  return nthRenewal(start, cycle, n);
}

export const daysUntil = (date, today) =>
  Math.round((Date.parse(date) - Date.parse(today)) / 86400000);

export const monthlyCost = (sub) => sub.price * CYCLES[sub.cycle];

// Totals per currency; we never convert currencies, so mixed lists stay honest.
export function totals(subs) {
  const out = {};
  for (const s of subs) out[s.currency] = (out[s.currency] || 0) + monthlyCost(s);
  return out;
}

export function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');

// One recurring all-day event per subscription with an alarm `remindDays` before each renewal.
export function toICS(subs, remindDays = 3) {
  const freq = { weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' };
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, '');
  const events = subs.map((s) => {
    const day = s.start.replace(/-/g, '');
    // RFC 5545 skips months without that day (e.g. the 31st); BYMONTHDAY=-1 keeps month-end bills on track.
    const rule = s.cycle === 'monthly' && parse(s.start).d > 28 ? 'FREQ=MONTHLY;BYMONTHDAY=-1' : `FREQ=${freq[s.cycle]}`;
    return [
      'BEGIN:VEVENT',
      `UID:${s.id}@subtrack`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `RRULE:${rule}`,
      `SUMMARY:${esc(`${s.name} renews (${money(s.price, s.currency)})`)}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(`${s.name} renews in ${remindDays} days`)}`,
      `TRIGGER:-P${remindDays}D`,
      'END:VALARM',
      'END:VEVENT',
    ].join('\r\n');
  });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//subtrack//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

// Trust boundary: imported JSON is user-supplied, keep only well-formed entries.
export function validSubs(data) {
  if (!Array.isArray(data)) throw new Error('Expected a JSON array of subscriptions');
  return data.filter(
    (s) =>
      s && typeof s.name === 'string' && s.name.trim() &&
      Number.isFinite(s.price) && s.price >= 0 &&
      s.cycle in CYCLES &&
      /^\d{4}-\d{2}-\d{2}$/.test(s.start) &&
      /^[A-Z]{3}$/.test(s.currency)
  ).map((s) => ({ id: String(s.id || crypto.randomUUID()), name: s.name.trim(), price: s.price, currency: s.currency, cycle: s.cycle, start: s.start }));
}
