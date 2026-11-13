import { nextRenewal, daysUntil, monthlyCost, totals, money, toICS, validSubs } from './core.js';

const KEY = 'subtrack.v1';
const $ = (id) => document.getElementById(id);
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

let subs = load();
let editing = null;

function load() {
  try { return validSubs(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(subs)); } catch { alert('Could not save: browser storage is unavailable.'); }
}

function download(name, text, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function stat(value, label) {
  const div = document.createElement('div');
  div.className = 'stat';
  div.append(Object.assign(document.createElement('b'), { textContent: value }), Object.assign(document.createElement('span'), { textContent: label }));
  return div;
}

function render() {
  const now = today();
  const rows = subs.map((s) => ({ ...s, next: nextRenewal(s.start, s.cycle, now) })).sort((a, b) => a.next.localeCompare(b.next));

  const t = Object.entries(totals(subs));
  const week = rows.filter((r) => daysUntil(r.next, now) <= 7);
  $('totals').replaceChildren(
    ...(t.length ? t : [['USD', 0]]).flatMap(([cur, m]) => [stat(money(m, cur), `per month (${cur})`), stat(money(m * 12, cur), `per year (${cur})`)]),
    stat(String(week.length), 'renewing in the next 7 days'),
  );

  $('list').replaceChildren(...(rows.length ? rows.map((r) => {
    const days = daysUntil(r.next, now);
    const li = document.createElement('li');
    if (days <= 3) li.className = 'soon';
    const per = { weekly: '/wk', monthly: '/mo', yearly: '/yr' }[r.cycle];
    const extra = r.cycle === 'monthly' ? '' : ` · ≈ ${money(monthlyCost(r), r.currency)}/mo`;
    li.innerHTML = '<span class="name"></span><span class="due"></span><span class="meta"></span><span class="ops"><button data-op="edit">Edit</button><button data-op="del">Delete</button></span>';
    li.querySelector('.name').textContent = r.name;
    li.querySelector('.due').textContent = days === 0 ? 'Renews today' : days === 1 ? 'Tomorrow' : `In ${days} days`;
    li.querySelector('.meta').textContent = `${money(r.price, r.currency)}${per}${extra} · next ${new Date(r.next + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    li.dataset.id = r.id;
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No subscriptions yet. Add the first one above.' })]));
}

function resetForm() {
  editing = null;
  $('form').reset();
  $('form').start.value = today();
  $('submit').textContent = 'Add';
  $('cancel').hidden = true;
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const [sub] = validSubs([{ id: editing || crypto.randomUUID(), name: f.name.value, price: Number(f.price.value), currency: f.currency.value.toUpperCase(), cycle: f.cycle.value, start: f.start.value }]);
  if (!sub) return alert('Please check the fields.');
  subs = editing ? subs.map((s) => (s.id === editing ? sub : s)) : [...subs, sub];
  save(); resetForm(); render();
});

$('cancel').addEventListener('click', resetForm);

$('list').addEventListener('click', (e) => {
  const op = e.target.dataset.op;
  const id = e.target.closest('li')?.dataset.id;
  if (!op || !id) return;
  const sub = subs.find((s) => s.id === id);
  if (op === 'del' && confirm(`Delete ${sub.name}?`)) { subs = subs.filter((s) => s.id !== id); save(); render(); }
  if (op === 'edit') {
    editing = id;
    const f = $('form');
    for (const k of ['name', 'price', 'currency', 'cycle', 'start']) f[k].value = sub[k];
    $('submit').textContent = 'Save';
    $('cancel').hidden = false;
    f.name.focus();
  }
});

$('ics').addEventListener('click', () => subs.length ? download('subtrack-reminders.ics', toICS(subs, Number($('remind').value)), 'text/calendar') : alert('Add a subscription first.'));
$('export').addEventListener('click', () => download('subtrack-backup.json', JSON.stringify(subs, null, 2), 'application/json'));
$('import').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async (e) => {
  try {
    const incoming = validSubs(JSON.parse(await e.target.files[0].text()));
    if (confirm(`Replace your ${subs.length} subscriptions with ${incoming.length} from the backup?`)) { subs = incoming; save(); render(); }
  } catch (err) { alert(`Could not restore: ${err.message}`); }
  e.target.value = '';
});

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
resetForm();
render();
