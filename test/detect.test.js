import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, parseAmount, merchant } from '../detect.js';

test('parses amounts in symbol, prefix-code and suffix-code forms', () => {
  assert.deepEqual(parseAmount('You paid $15.49 today'), { price: 15.49, currency: 'USD' });
  assert.deepEqual(parseAmount('Total ₦4,400.00'), { price: 4400, currency: 'NGN' });
  assert.deepEqual(parseAmount('Amount: EUR 9.99'), { price: 9.99, currency: 'EUR' });
  assert.deepEqual(parseAmount('charged 120.00 GBP'), { price: 120, currency: 'GBP' });
  assert.equal(parseAmount('Your plan is active'), null);
});

test('merchant groups subdomains and cleans display names', () => {
  assert.deepEqual(merchant('"Spotify Receipts" <no-reply@billing.spotify.com>'), { key: 'spotify.com', name: 'Spotify' });
  assert.deepEqual(merchant('payments@paystack.com.ng'), { key: 'paystack.com.ng', name: 'Paystack' });
});

const mail = (from, subject, date, snippet = '') => ({ from, subject, date, snippet });

test('detects monthly and yearly subscriptions from receipt history', () => {
  const found = detect([
    mail('Netflix <info@account.netflix.com>', 'Your Netflix receipt', '2026-08-03', 'Payment of $15.49 received'),
    mail('Netflix <info@account.netflix.com>', 'Your Netflix receipt', '2026-09-03', 'Payment of $15.49 received'),
    mail('Netflix <info@account.netflix.com>', 'Payment received', '2026-09-04', 'We charged $15.49'),
    mail('Netflix <info@account.netflix.com>', 'Your Netflix receipt', '2026-10-03', 'Payment of $17.99 received'),
    mail('Namecheap <billing@namecheap.com>', 'Invoice for domain renewal', '2025-12-01', 'Total 12.98 USD, renews annually'),
    mail('Shop <orders@shop.com>', 'Your order has shipped', '2026-10-01', 'Order total $40.00'),
    mail('News <hello@news.com>', 'Weekly newsletter', '2026-10-02', 'Subscription tips $5'),
  ]);
  assert.equal(found.length, 2);
  const [netflix, domain] = found;
  assert.equal(netflix.name, 'Netflix');
  assert.equal(netflix.cycle, 'monthly');
  assert.equal(netflix.price, 17.99, 'latest price wins after a price rise');
  assert.equal(netflix.start, '2026-10-03');
  assert.equal(netflix.receipts, 3, 'duplicate mail for one charge counts once');
  assert.equal(netflix.confidence, 'high');
  assert.equal(domain.cycle, 'yearly');
  assert.equal(domain.confidence, 'medium');
});

test('a single receipt without recurring language is not a subscription', () => {
  assert.deepEqual(detect([mail('Uber <uber@uber.com>', 'Your trip receipt', '2026-10-01', 'Total $12.00')]), []);
});
