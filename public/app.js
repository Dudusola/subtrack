import { nextRenewal, daysUntil, totals, money, upcoming, projection, addDays, validSubs, monthlyCost } from './core.js';

const $ = (id) => document.getElementById(id);
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { me: null, subs: [], scan: null, editing: null, pendingDelete: null };

// Auto-escaping template: interpolations are text unless they're another html`` result.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const show = (v) => (Array.isArray(v) ? v.map(show).join('') : v?.__html !== undefined ? v.__html : esc(v ?? ''));
const html = (strings, ...vals) => ({ __html: strings.reduce((out, s, i) => out + s + (i < vals.length ? show(vals[i]) : ''), '') });

async function api(method, path, data) {
  const res = await fetch(path, {
    method,
    headers: data === undefined ? {} : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error || 'Network problem. Try again.'), { status: res.status });
  return body;
}

const PER = { weekly: '/wk', monthly: '/mo', yearly: '/yr' };
const shortDate = (d) => new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const dayLabel = (d) => new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
const whenText = (days) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);

function toast(message, action) {
  const region = $('toast-region');
  region.replaceChildren();
  const el = document.createElement('div');
  el.className = 'toast';
  el.append(message);
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'btn btn-sm', type: 'button', textContent: action.label });
    b.onclick = () => { action.run(); el.remove(); };
    el.append(b);
  }
  region.append(el);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.remove(), action ? 6000 : 3500);
}

/* ── Rendering ──────────────────────────────────────────────── */

function primaryCurrency(subs) {
  const count = {};
  for (const s of subs) count[s.currency] = (count[s.currency] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
}

function heroView(subs, now) {
  const cur = primaryCurrency(subs);
  const t = totals(subs);
  const next = upcoming(subs, now, 400)[0];
  const others = Object.entries(t).filter(([c]) => c !== cur);
  const inCur = subs.filter((s) => s.currency === cur).length;
  const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).formatToParts(t[cur]);
  const symbol = parts.filter((p) => p.type === 'currency').map((p) => p.value).join('');
  const days = next && daysUntil(next.date, now);
  return html`
    <section class="hero" aria-labelledby="hero-title">
      <div class="figure" aria-hidden="true"><span class="cur">${symbol}</span><span id="hero-num" data-target="${t[cur]}">${money(t[cur], cur).replace(symbol, '').trim()}</span></div>
      <h1 id="hero-title"><span class="visually-hidden">${money(t[cur], cur)} </span>a month across ${inCur} ${inCur === 1 ? 'subscription' : 'subscriptions'}.</h1>
      ${next ? html`<p class="qualifier">Next up: <strong>${next.sub.name}</strong> charges <strong>${money(next.sub.price, next.sub.currency)}</strong> <span class="${days <= 3 ? 'soon' : ''}">${whenText(days)}</span>.</p>` : ''}
      <div class="hero-meta">
        <span><b class="tnum">${money(t[cur] * 12, cur)}</b> a year</span>
        ${others.map(([c, m]) => html`<span>plus <b class="tnum">${money(m, c)}</b> a month in ${c}</span>`)}
      </div>
      <div class="hero-actions">
        <button class="btn btn-outline" type="button" data-action="settings">Get reminders in your calendar</button>
      </div>
    </section>`;
}

// "Spotify" from a receipt matches "Spotify Premium" you already track.
function trackedMatch(name) {
  const n = name.toLowerCase();
  return state.subs.find((s) => { const t = s.name.toLowerCase(); return t.includes(n) || n.includes(t); });
}

function reviewView(scan) {
  if (!scan) return '';
  const items = scan.found;
  return html`
    <section class="section" aria-labelledby="review-title">
      <div class="review">
        <div class="section-head">
          <h2 id="review-title">${items.length ? `Found ${items.length} in your inbox` : 'Nothing recurring found'}</h2>
          <p class="muted">Checked ${scan.scanned} billing emails from the last 13 months.</p>
        </div>
        ${items.length ? html`
          <form id="review-form">
            <ul class="review-list">
              ${items.map((f, i) => {
                const existing = trackedMatch(f.name);
                const changed = existing && existing.currency === f.currency && Math.abs(existing.price - f.price) >= 0.01;
                const ticked = changed || (!existing && f.confidence !== 'low');
                return html`<li><label>
                  <input type="checkbox" name="pick" value="${i}" ${{ __html: ticked ? 'checked' : '' }}>
                  <span class="name">${f.name}</span>
                  <span class="tnum">${money(f.price, f.currency)}${PER[f.cycle]}</span>
                  <span class="evidence">${changed
                    ? html`<span class="chip chip-change">Price changed</span> You track it at ${money(existing.price, existing.currency)}. Tick to update.`
                    : html`${f.receipts} ${f.receipts === 1 ? 'receipt' : 'receipts'}, last on ${shortDate(f.start)} · <span class="chip ${f.confidence === 'high' ? 'chip-high' : ''}">${f.confidence === 'high' ? 'Repeats on schedule' : f.confidence === 'medium' ? 'Says it renews' : 'Guess: check it'}</span>${existing ? ' · already tracked' : ''}`}</span>
                </label></li>`;
              })}
            </ul>
            <div class="review-actions">
              <button class="btn btn-accent" type="submit" id="review-submit">Track selected</button>
              <button class="btn btn-ghost" type="button" data-action="dismiss-scan">Dismiss</button>
            </div>
          </form>` : html`
          <p class="muted">Receipts from app stores and banks can hide the merchant name. Add those by hand.</p>
          <div class="review-actions"><button class="btn btn-ghost" type="button" data-action="dismiss-scan">Dismiss</button></div>`}
      </div>
    </section>`;
}

function nextMonthView(subs, now) {
  const items = upcoming(subs, now, 30);
  const x = (d) => `${1 + (Math.min(daysUntil(d, now), 30) / 30) * 98}%`;
  const ticks = ['Today', '+1 wk', '+2 wks', '+3 wks', '+30 days'];
  const groups = [['This week', 0, 7], ['Next week', 7, 14], ['Later this month', 14, 30]];
  return html`
    <section class="section" aria-labelledby="next-title">
      <div class="section-head">
        <h2 id="next-title">Next 30 days</h2>
        <p class="muted">${items.length} ${items.length === 1 ? 'charge' : 'charges'}</p>
      </div>
      <div aria-hidden="true">
        <svg class="ruler" width="100%" height="24">
          <line x1="0" x2="100%" y1="12" y2="12"/>
          ${[0, 25, 50, 75, 100].map((p) => html`<line class="tick" x1="${p}%" x2="${p}%" y1="8" y2="16"/>`)}
          ${items.map((u) => html`<circle class="${daysUntil(u.date, now) <= 3 ? 'soon' : ''}" cx="${x(u.date)}" cy="12" r="6"><title>${u.sub.name}</title></circle>`)}
        </svg>
        <div class="ruler-labels">${ticks.map((l, i) => html`<span class="${i % 2 ? 'mid' : ''}">${l}</span>`)}</div>
      </div>
      <div class="agenda">
        ${groups.map(([label, from, to]) => {
          const list = items.filter((u) => { const d = daysUntil(u.date, now); return d >= from && d < to; });
          return html`<div><h3>${label}</h3>${list.length ? html`<ul>${list.map((u) => html`
            <li class="${daysUntil(u.date, now) <= 3 ? 'soon' : ''}"><span class="when">${daysUntil(u.date, now) === 0 ? 'Today' : dayLabel(u.date)}</span><span class="what">${u.sub.name}</span><span class="tnum">${money(u.sub.price, u.sub.currency)}</span></li>`)}</ul>` : html`<p class="none">Nothing due.</p>`}</div>`;
        })}
      </div>
    </section>`;
}

function yearView(subs, now) {
  const currencies = Object.keys(totals(subs));
  const cur = currencies.includes(state.chartCurrency) ? state.chartCurrency : primaryCurrency(subs);
  const data = projection(subs, now, 12, cur);
  const max = Math.max(...data.map((d) => d.total), 1);
  const peak = data.reduce((a, b) => (b.total > a.total ? b : a));
  const sum = data.reduce((a, b) => a + b.total, 0);
  const W = 720, H = 200, top = 22, base = 170, gap = 10, bw = (W - gap * 11) / 12;
  const month = (m, style) => new Date(m + '-01T00:00').toLocaleDateString(undefined, { month: style });
  return html`
    <section class="section" aria-labelledby="year-title">
      <div class="section-head">
        <h2 id="year-title">The next 12 months</h2>
        ${currencies.length > 1 ? html`<label class="row"><span class="visually-hidden">Currency</span><select id="chart-currency" class="btn-sm">${currencies.map((c) => html`<option ${{ __html: c === cur ? 'selected' : '' }}>${c}</option>`)}</select></label>` : ''}
      </div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="year-desc">
        <desc id="year-desc">Projected spend per month in ${cur}. Highest is ${month(peak.month, 'long')} at ${money(peak.total, cur)}.</desc>
        ${data.map((d, i) => {
          const h = Math.max(2, ((base - top) * d.total) / max);
          const cls = i === 0 ? 'bar now' : d === peak && d.total > 0 ? 'bar peak' : 'bar';
          return html`
            <rect class="${cls}" x="${i * (bw + gap)}" y="${base - h}" width="${bw}" height="${h}" rx="3"><title>${month(d.month, 'long')}: ${money(d.total, cur)}</title></rect>
            ${d === peak && d.total > 0 ? html`<text class="val" x="${i * (bw + gap) + bw / 2}" y="${base - h - 7}" text-anchor="middle">${money(d.total, cur)}</text>` : ''}
            <text x="${i * (bw + gap) + bw / 2}" y="${base + 20}" text-anchor="middle">${month(d.month, 'short')}</text>`;
        })}
      </svg>
      <div class="chart-foot">
        <span><b class="tnum">${money(sum, cur)}</b> over the next 12 months</span>
        <span>Busiest: <b>${month(peak.month, 'long')}</b></span>
      </div>
    </section>`;
}

function listView(subs, now) {
  const rows = subs.map((s) => ({ ...s, next: nextRenewal(s.start, s.cycle, now) })).sort((a, b) => a.next.localeCompare(b.next));
  return html`
    <section class="section" aria-labelledby="all-title">
      <div class="section-head">
        <h2 id="all-title">All subscriptions</h2>
        <button class="btn btn-outline btn-sm" type="button" data-action="add">Add one</button>
      </div>
      <ul class="subs">
        <li class="head" aria-hidden="true"><span>Name</span><span>Billed</span><span class="num">Price</span><span class="num">Next charge</span><span></span></li>
        ${rows.map((r) => {
          const d = daysUntil(r.next, now);
          return html`<li data-id="${r.id}">
            <span class="name">${r.name}${r.trial && r.start >= now ? html`<span class="chip chip-soon">Trial</span>` : ''}${r.category ? html`<span class="cat">${r.category}</span>` : ''}</span>
            <span class="cycle muted">${r.cycle[0].toUpperCase() + r.cycle.slice(1)}${r.cycle !== 'monthly' ? html` <span class="fine">≈ ${money(monthlyCost(r), r.currency)}/mo</span>` : ''}</span>
            <span class="num price">${money(r.price, r.currency)}</span>
            <span class="next ${d <= 3 ? 'soon' : ''}">${d <= 1 ? whenText(d)[0].toUpperCase() + whenText(d).slice(1) : shortDate(r.next)}</span>
            <span class="edit"><button class="btn btn-ghost btn-sm" type="button" data-action="edit" aria-label="Edit ${r.name}">Edit</button></span>
          </li>`;
        })}
      </ul>
    </section>`;
}

function emptyView() {
  return html`
    <section class="empty" aria-labelledby="empty-title">
      <h1 id="empty-title">Nothing tracked yet.</h1>
      <p>Scan your inbox to find subscriptions from your receipts, or add the ones you know by hand.</p>
      <div class="hero-actions">
        <button class="btn btn-accent" type="button" data-action="scan">Scan your inbox</button>
        <button class="btn btn-outline" type="button" data-action="add">Add one by hand</button>
      </div>
    </section>`;
}

function render() {
  if (!state.me) {
    $('dash-view').hidden = true;
    $('auth-view').hidden = false;
    return;
  }
  $('auth-view').hidden = true;
  $('dash-view').hidden = false;
  $('foot-email').textContent = state.me.email;
  const now = today();
  const subs = state.subs.filter((s) => s.id !== state.pendingDelete);
  const view = subs.length
    ? html`${heroView(subs, now)}${reviewView(state.scan)}${nextMonthView(subs, now)}${yearView(subs, now)}${listView(subs, now)}`
    : html`${reviewView(state.scan)}${emptyView()}`;
  $('dash').innerHTML = view.__html;
  $('categories').innerHTML = html`${[...new Set(state.subs.map((s) => s.category).filter(Boolean))].map((c) => html`<option value="${c}">`)}`.__html;
  countUp();
}

function countUp() {
  const el = $('hero-num');
  if (!el || reduceMotion || countUp.done) return;
  countUp.done = true; // once per page load; re-renders after edits shouldn't replay it
  const target = Number(el.dataset.target);
  const fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const final = el.textContent;
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / 500);
    el.textContent = p < 1 ? fmt.format(target * (1 - (1 - p) ** 3)) : final;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ── Actions ────────────────────────────────────────────────── */

function busy(button, on) {
  button.disabled = on;
  button.setAttribute('aria-busy', String(on));
}

function openEditor(sub) {
  const f = $('edit-form');
  state.editing = sub?.id || null;
  f.reset();
  $('edit-error').textContent = '';
  $('edit-title').textContent = sub ? `Edit ${sub.name}` : 'Add subscription';
  $('edit-delete').hidden = !sub;
  const fallback = { currency: primaryCurrency(state.subs) || 'USD', cycle: 'monthly', start: today() };
  for (const k of ['name', 'price', 'currency', 'cycle', 'start', 'category']) f[k].value = (sub || fallback)[k] ?? '';
  f.trial.checked = Boolean(sub?.trial);
  $('edit-dialog').showModal();
  f.name.focus();
}

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const data = { name: f.name.value, price: Number(f.price.value), currency: f.currency.value.trim().toUpperCase(), cycle: f.cycle.value, start: f.start.value, category: f.category.value, trial: f.trial.checked };
  for (const k of ['name', 'price', 'currency', 'start']) f[k].removeAttribute('aria-invalid');
  if (!f.price.value) f.price.setAttribute('aria-invalid', 'true');
  if (!validSubs([data]).length) {
    for (const k of ['name', 'currency', 'start']) if (!f[k].checkValidity() || !f[k].value.trim()) f[k].setAttribute('aria-invalid', 'true');
    $('edit-error').textContent = 'Fill in a name, a price, a three-letter currency like USD, and a date.';
    return;
  }
  busy($('edit-submit'), true);
  try {
    state.subs = await api(state.editing ? 'PUT' : 'POST', state.editing ? `/api/subs/${state.editing}` : '/api/subs', data);
    $('edit-dialog').close();
    render();
  } catch (err) {
    $('edit-error').textContent = err.message;
  } finally {
    busy($('edit-submit'), false);
  }
});

// Optimistic delete with Undo: the row disappears now, the request waits out the undo window.
$('edit-delete').addEventListener('click', () => {
  const id = state.editing;
  const sub = state.subs.find((s) => s.id === id);
  $('edit-dialog').close();
  commitPendingDelete();
  state.pendingDelete = id;
  render();
  const timer = setTimeout(commitPendingDelete, 6000);
  toast(`Deleted ${sub.name}.`, { label: 'Undo', run: () => { clearTimeout(timer); state.pendingDelete = null; render(); } });
});

async function commitPendingDelete() {
  const id = state.pendingDelete;
  if (!id) return;
  state.pendingDelete = null;
  try { state.subs = await api('DELETE', `/api/subs/${id}`, {}); } catch (err) { toast(`Couldn’t delete: ${err.message}`); }
  render();
}
addEventListener('pagehide', commitPendingDelete);

$('dash').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'add') openEditor();
  if (action === 'scan') openScan();
  if (action === 'settings') openSettings();
  if (action === 'edit') openEditor(state.subs.find((s) => s.id === e.target.closest('li').dataset.id));
  if (action === 'dismiss-scan') {
    state.scan = null;
    render();
    await api('DELETE', '/api/scan', {}).catch(() => {});
  }
});

$('dash').addEventListener('change', (e) => {
  if (e.target.id === 'chart-currency') { state.chartCurrency = e.target.value; render(); }
});

$('dash').addEventListener('submit', async (e) => {
  if (e.target.id !== 'review-form') return;
  e.preventDefault();
  const picks = [...new FormData(e.target).getAll('pick')].map((i) => state.scan.found[i]);
  if (!picks.length) return toast('Tick at least one to track.');
  // A ticked price change updates the tracked one; everything else is added.
  const updates = picks.map((f) => [f, trackedMatch(f.name)]).filter(([f, s]) => s && s.currency === f.currency && Math.abs(s.price - f.price) >= 0.01);
  const adds = picks.filter((f) => !updates.some(([u]) => u === f));
  busy($('review-submit'), true);
  try {
    for (const [f, s] of updates) state.subs = await api('PUT', `/api/subs/${s.id}`, { ...s, price: f.price });
    if (adds.length) state.subs = await api('POST', '/api/subs', adds);
    await api('DELETE', '/api/scan', {});
    state.scan = null;
    render();
    toast([adds.length && `Tracking ${adds.length} new`, updates.length && `updated ${updates.length} ${updates.length === 1 ? 'price' : 'prices'}`].filter(Boolean).join(', ').replace(/^./, (c) => c.toUpperCase()) + '.');
  } catch (err) {
    toast(err.message);
    busy($('review-submit'), false);
  }
});

$('nav-add').addEventListener('click', () => openEditor());
$('nav-scan').addEventListener('click', () => openScan());

/* ── Scan ───────────────────────────────────────────────────── */

function openScan() {
  $('scan-google').hidden = !state.me.gmail;
  $('imap-title').textContent = state.me.gmail ? 'Or use an app password' : 'Use an app password';
  $('imap-error').textContent = '';
  const f = $('imap-form');
  f.reset();
  f.email.value = state.me.email;
  $('scan-dialog').showModal();
}

$('imap-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('imap-error').textContent = '';
  if (!f.email.value.includes('@') || !f.password.value.trim()) return void ($('imap-error').textContent = 'Enter your email address and the app password.');
  busy($('imap-submit'), true);
  $('imap-wait').hidden = false;
  try {
    state.scan = await api('POST', '/api/scan/imap', { email: f.email.value, password: f.password.value });
    f.reset();
    $('scan-dialog').close();
    render();
    document.getElementById('review-title')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  } catch (err) {
    $('imap-error').textContent = err.message;
  } finally {
    busy($('imap-submit'), false);
    $('imap-wait').hidden = true;
  }
});
$('nav-settings').addEventListener('click', () => openSettings());
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

/* ── Settings ───────────────────────────────────────────────── */

function calUrl() {
  return `${state.me.calendarUrl}?remind=${$('cal-remind').value}`;
}
function openSettings() {
  $('mail-settings').hidden = !state.me.mail;
  $('mail-on').checked = state.me.emailReminders;
  $('mail-days').value = String(state.me.remindDays);
  $('cal-url').value = calUrl();
  $('settings-email').textContent = `Signed in as ${state.me.email}`;
  $('delete-error').textContent = '';
  $('delete-form').reset();
  $('settings-dialog').showModal();
}
$('cal-remind').addEventListener('change', () => { $('cal-url').value = calUrl(); });
async function saveMailSettings() {
  try {
    state.me = await api('PATCH', '/api/me', { emailReminders: $('mail-on').checked, remindDays: Number($('mail-days').value) });
  } catch (err) {
    toast(`Couldn’t save: ${err.message}`);
    $('mail-on').checked = state.me.emailReminders;
    $('mail-days').value = String(state.me.remindDays);
  }
}
$('mail-on').addEventListener('change', saveMailSettings);
$('mail-days').addEventListener('change', saveMailSettings);
$('cal-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('cal-url').value); $('cal-copy').textContent = 'Copied'; } catch { $('cal-url').select(); }
  setTimeout(() => { $('cal-copy').textContent = 'Copy'; }, 1500);
});
$('cal-reset').addEventListener('click', async () => {
  state.me = await api('POST', '/api/me/calendar', {});
  $('cal-url').value = calUrl();
  toast('New calendar link made. Re-subscribe with it.');
});
$('export').addEventListener('click', () => {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(state.subs.map(({ id, source, ...s }) => s), null, 2)], { type: 'application/json' })),
    download: `subtrack-${today()}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  try {
    const list = validSubs(JSON.parse(await e.target.files[0].text()));
    if (!list.length) throw new Error('No valid subscriptions in that file.');
    state.subs = await api('POST', '/api/subs', list);
    render();
    toast(`Imported ${list.length}.`);
  } catch (err) {
    toast(`Couldn’t import: ${err.message}`);
  }
  e.target.value = '';
});
$('signout').addEventListener('click', async () => {
  await commitPendingDelete();
  await api('POST', '/api/logout', {}).catch(() => {});
  location.replace('/');
});
$('delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('DELETE', '/api/me', { password: e.target.password.value });
    location.replace('/');
  } catch (err) {
    $('delete-error').textContent = err.message;
  }
});

/* ── Auth ───────────────────────────────────────────────────── */

const mode = () => document.querySelector('input[name="mode"]:checked').value;
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => {
    $('auth-submit').textContent = mode() === 'signup' ? 'Create account' : 'Sign in';
    $('auth-form').password.autocomplete = mode() === 'signup' ? 'new-password' : 'current-password';
    $('auth-error').textContent = '';
  });
}
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  busy($('auth-submit'), true);
  $('auth-error').textContent = '';
  try {
    state.me = await api('POST', mode() === 'signup' ? '/api/signup' : '/api/login', { email: f.email.value, password: f.password.value });
    await load();
  } catch (err) {
    $('auth-error').textContent = err.message;
  } finally {
    busy($('auth-submit'), false);
  }
});

function showPanel(id) {
  for (const p of ['panel-auth', 'forgot-form', 'reset-form']) $(p).hidden = p !== id;
  $(id).querySelector('input')?.focus();
}
$('forgot').addEventListener('click', () => {
  $('forgot-form').email.value = $('auth-form').email.value;
  $('forgot-error').textContent = '';
  showPanel('forgot-form');
});
for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', () => showPanel('panel-auth'));

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = e.target.email.value.trim();
  if (!email.includes('@')) return void ($('forgot-error').textContent = 'Enter the email you signed up with.');
  busy($('forgot-submit'), true);
  try {
    await api('POST', '/api/reset/request', { email });
    $('forgot-error').textContent = '';
    showPanel('panel-auth');
    toast('If that email has an account, a reset link is on its way.');
  } catch (err) {
    $('forgot-error').textContent = err.message;
  } finally {
    busy($('forgot-submit'), false);
  }
});

const resetToken = new URLSearchParams(location.search).get('reset');
$('reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('reset-submit'), true);
  try {
    state.me = await api('POST', '/api/reset', { token: resetToken, password: e.target.password.value });
    history.replaceState(null, '', '/');
    await load();
    toast('Password changed. You’re signed in.');
  } catch (err) {
    $('reset-error').textContent = err.message;
  } finally {
    busy($('reset-submit'), false);
  }
});

/* ── Boot ───────────────────────────────────────────────────── */

async function load() {
  [state.subs, state.scan] = await Promise.all([api('GET', '/api/subs'), api('GET', '/api/scan')]);
  render();
}

const scanResult = new URLSearchParams(location.search).get('scan');
if (scanResult) history.replaceState(null, '', '/');
try {
  state.me = await api('GET', '/api/me');
  await load();
  if (scanResult === 'failed') toast('The Gmail scan didn’t finish. Try again.');
  if (scanResult === 'cancelled') toast('Gmail access was cancelled. Nothing was read.');
} catch {
  render();
  if (resetToken) showPanel('reset-form');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
