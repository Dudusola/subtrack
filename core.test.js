import test from 'node:test';
import assert from 'node:assert/strict';
import { nthRenewal, nextRenewal, daysUntil, totals, toICS, validSubs } from './core.js';

test('monthly renewals clamp to month end without drifting', () => {
  assert.equal(nthRenewal('2026-01-31', 'monthly', 1), '2026-02-28');
  assert.equal(nthRenewal('2026-01-31', 'monthly', 2), '2026-03-31');
  assert.equal(nthRenewal('2024-02-29', 'yearly', 1), '2025-02-28');
});

test('next renewal is on or after today', () => {
  assert.equal(nextRenewal('2026-01-15', 'monthly', '2026-11-13'), '2026-11-15');
  assert.equal(nextRenewal('2026-11-13', 'monthly', '2026-11-13'), '2026-11-13');
  assert.equal(nextRenewal('2026-11-01', 'weekly', '2026-11-13'), '2026-11-15');
  assert.equal(nextRenewal('2027-03-01', 'yearly', '2026-11-13'), '2027-03-01');
  assert.equal(daysUntil('2026-11-15', '2026-11-13'), 2);
});

test('totals are per currency and normalised to a month', () => {
  const t = totals([
    { price: 120, currency: 'USD', cycle: 'yearly' },
    { price: 10, currency: 'USD', cycle: 'monthly' },
    { price: 3, currency: 'EUR', cycle: 'weekly' },
  ]);
  assert.equal(t.USD, 20);
  assert.equal(t.EUR, 13);
});

test('ics export escapes text and uses month-end rule', () => {
  const ics = toICS([{ id: 'a', name: 'Gym; Pro', price: 5, currency: 'USD', cycle: 'monthly', start: '2026-01-31' }]);
  assert.match(ics, /RRULE:FREQ=MONTHLY;BYMONTHDAY=-1/);
  assert.match(ics, /SUMMARY:Gym\\; Pro renews/);
  assert.match(ics, /TRIGGER:-P3D/);
});

test('import drops malformed entries', () => {
  const out = validSubs([
    { name: 'ok', price: 1, currency: 'USD', cycle: 'monthly', start: '2026-01-01' },
    { name: 'bad', price: -1, currency: 'USD', cycle: 'monthly', start: '2026-01-01' },
    { name: '<x>', price: 1, currency: 'usd', cycle: 'daily', start: 'soon' },
  ]);
  assert.equal(out.length, 1);
  assert.throws(() => validSubs({}));
});
