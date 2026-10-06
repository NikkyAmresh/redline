/* Redline kit: optional helpers for prototypes. A hash router over
   [data-rl-screen] sections, seeded dummy data, and toast, sheet and modal
   widgets, so a playable prototype stays small. Load it with
   <script src="/static/kit.js"></script>; everything lives on window.Kit.

   Routes look like #/product/3?state=empty: the first segment names the
   screen, the rest are params, the query switches states. */
(function () {
'use strict';
const Kit = {};
const renders = {};
const listeners = {};
let current = null;

/* ---------- router ---------- */

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qAt = raw.indexOf('?');
  const path = qAt >= 0 ? raw.slice(0, qAt) : raw;
  const query = new URLSearchParams(qAt >= 0 ? raw.slice(qAt + 1) : '');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return {name: parts[0] || '', params: parts.slice(1), query};
}

Kit.route = parseHash();
Kit.home = null;

/* Kit.screen('cart', (el, params, query) => { ... }) renders a screen each time it is shown. */
Kit.screen = (name, render) => { renders[name] = render; };
Kit.go = path => { location.hash = '#/' + String(path).replace(/^#?\/?/, ''); };
Kit.back = () => {
  if (history.length > 1) history.back();
  else Kit.go(Kit.home || '');
};
/* Kit.state() reads ?state=..., Kit.state('tab') reads ?tab=... */
Kit.state = key => Kit.route.query.get(key || 'state');
Kit.on = (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); };
const emit = (event, data) => (listeners[event] || []).forEach(fn => fn(data));

function show() {
  Kit.route = parseHash();
  const all = Array.from(document.querySelectorAll('[data-rl-screen]'));
  let name = Kit.route.name;
  if (!all.some(el => el.dataset.rlScreen === name))
    name = Kit.home || (all[0] && all[0].dataset.rlScreen) || '';
  for (const el of all) el.hidden = el.dataset.rlScreen !== name;
  const el = all.find(e => e.dataset.rlScreen === name);
  if (el && renders[name]) renders[name](el, Kit.route.params, Kit.route.query);
  if (current !== name) {
    if (el) el.scrollTop = 0;
    window.scrollTo(0, 0);
    current = name;
  }
  Kit.current = name;
  emit('route', {name, params: Kit.route.params, query: Kit.route.query});
}

/* Re-render the screen on show, for example after changing state. */
Kit.refresh = show;

Kit.start = opts => {
  Kit.home = (opts && opts.home) || Kit.home;
  window.addEventListener('hashchange', show);
  show();
};

// [data-go="cart"] navigates, [data-back] goes back, anywhere in the page
document.addEventListener('click', e => {
  const go = e.target.closest && e.target.closest('[data-go]');
  if (go) { e.preventDefault(); Kit.go(go.getAttribute('data-go')); return; }
  const back = e.target.closest && e.target.closest('[data-back]');
  if (back) { e.preventDefault(); Kit.back(); }
});

/* ---------- dummy data (seeded, so text stays stable across reloads) ---------- */

let seed = 20261006;
function rand() {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Isha', 'Arjun', 'Zara',
               'Leo', 'Maya', 'Noah', 'Ava', 'Omar', 'Sofia', 'Yuki', 'Lucas', 'Nina', 'Ravi'];
const LAST = ['Sharma', 'Iyer', 'Kapoor', 'Reddy', 'Nair', 'Mehta', 'Bose', 'Khan', 'Patel', 'Singh',
              'Garcia', 'Chen', 'Silva', 'Novak', 'Kim', 'Brown', 'Rossi', 'Haddad'];
const CITIES = ['Bengaluru', 'Mumbai', 'Pune', 'Delhi', 'Hyderabad', 'Chennai', 'Kolkata', 'Jaipur',
                'Lisbon', 'Berlin', 'Austin', 'Toronto', 'Singapore', 'Melbourne'];
const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ' +
  'ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ' +
  'aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum').split(' ');

const fake = {
  seed: n => { seed = n | 0; },
  random: rand,
  int: (a, b) => Math.floor(a + rand() * (b - a + 1)),
  float: (a, b, digits) => +(a + rand() * (b - a)).toFixed(digits == null ? 1 : digits),
  pick: arr => arr[Math.floor(rand() * arr.length)],
  bool: p => rand() < (p == null ? 0.5 : p),
  first: () => fake.pick(FIRST),
  last: () => fake.pick(LAST),
  name: () => fake.first() + ' ' + fake.last(),
  email: name => (name || fake.name()).toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
  phone: () => '+91 9' + fake.int(100000000, 999999999),
  city: () => fake.pick(CITIES),
  price: (min, max, step) => {
    step = step || 1;
    return Math.round(fake.int(min == null ? 99 : min, max == null ? 2999 : max) / step) * step;
  },
  date: daysBack => new Date(Date.now() - fake.int(0, (daysBack || 30) * 86400) * 1000),
  id: prefix => (prefix || '') + fake.int(10000, 99999),
  words: n => Array.from({length: n || 3}, () => fake.pick(WORDS)).join(' '),
  sentence: n => { const s = fake.words(n || 9); return s[0].toUpperCase() + s.slice(1) + '.'; },
  paragraph: n => Array.from({length: n || 3}, () => fake.sentence(fake.int(7, 14))).join(' '),
  list: (n, fn) => Array.from({length: n}, (_, i) => fn(i)),
  color: text => {
    let h = 0;
    for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return 'hsl(' + h + ' 55% 52%)';
  },
  /* An SVG avatar with initials; returns markup ready for innerHTML. */
  avatar: (name, size) => {
    size = size || 40;
    const initials = String(name || '?').split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 40 40" role="img" aria-label="' +
      esc(name) + '"><circle cx="20" cy="20" r="20" fill="' + fake.color(name) + '"/>' +
      '<text x="20" y="25.5" text-anchor="middle" font-family="-apple-system, Helvetica, Arial" ' +
      'font-size="15" font-weight="600" fill="#fff">' + esc(initials) + '</text></svg>';
  },
};
Kit.fake = fake;

/* ---------- formatting ---------- */

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
Kit.esc = esc;
Kit.money = (n, currency) => new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'en-IN', {
  style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0}).format(n);
Kit.day = d => new Date(d).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
Kit.ago = d => {
  const s = Math.max(1, Math.round((Date.now() - new Date(d)) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
Kit.delay = ms => new Promise(r => setTimeout(r, ms == null ? 600 : ms));

/* ---------- widgets ---------- */

const CSS = `
[data-rl-screen][hidden] { display: none !important; }
.kit-toast { position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 16px); opacity: 0;
  background: var(--kit-ink, #1d2129); color: var(--kit-on-ink, #fff); padding: 11px 16px;
  border-radius: 12px; font: 500 14px/1.35 var(--kit-font, -apple-system, "Helvetica Neue", sans-serif);
  box-shadow: 0 10px 30px rgba(0,0,0,.22); transition: opacity .2s, transform .2s;
  z-index: 9000; max-width: calc(100% - 32px); pointer-events: none; }
.kit-toast.on { opacity: 1; transform: translate(-50%, 0); }
.kit-backdrop { position: fixed; inset: 0; background: rgba(15,17,22,.42); z-index: 8000;
  opacity: 0; transition: opacity .2s; }
.kit-backdrop.on { opacity: 1; }
.kit-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 8001;
  background: var(--kit-surface, #fff); color: var(--kit-text, #1d2129);
  border-radius: 20px 20px 0 0; padding: 10px 20px 24px; max-height: 86%; overflow: auto;
  transform: translateY(100%); transition: transform .25s cubic-bezier(.2,.8,.2,1);
  font: 15px/1.5 var(--kit-font, -apple-system, "Helvetica Neue", sans-serif); }
.kit-sheet.on { transform: none; }
.kit-sheet .kit-grip { width: 38px; height: 5px; border-radius: 3px; background: rgba(0,0,0,.18);
  margin: 0 auto 12px; }
.kit-modal { position: fixed; left: 50%; top: 50%; z-index: 8001; width: min(420px, calc(100% - 40px));
  background: var(--kit-surface, #fff); color: var(--kit-text, #1d2129); border-radius: 18px;
  padding: 22px; transform: translate(-50%, -46%); opacity: 0; transition: opacity .2s, transform .2s;
  font: 15px/1.5 var(--kit-font, -apple-system, "Helvetica Neue", sans-serif);
  box-shadow: 0 24px 60px rgba(0,0,0,.25); }
.kit-modal.on { opacity: 1; transform: translate(-50%, -50%); }
.kit-title { font-weight: 650; font-size: 18px; margin: 0 0 8px; }
.kit-actions { display: flex; gap: 10px; margin-top: 18px; }
.kit-actions button { flex: 1; border: 0; border-radius: 12px; padding: 12px 14px; cursor: pointer;
  font: 600 15px var(--kit-font, -apple-system, "Helvetica Neue", sans-serif);
  background: rgba(0,0,0,.06); color: inherit; }
.kit-actions button.primary { background: var(--kit-accent, #2563eb); color: #fff; }
.kit-skel { background: linear-gradient(90deg, rgba(0,0,0,.06), rgba(0,0,0,.12), rgba(0,0,0,.06));
  background-size: 200% 100%; animation: kit-shimmer 1.2s infinite linear; border-radius: 8px; }
@keyframes kit-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }`;

function injectCss() {
  if (document.getElementById('kit-css')) return;
  const s = document.createElement('style');
  s.id = 'kit-css';
  s.textContent = CSS;
  (document.head || document.documentElement).appendChild(s);
}
injectCss();

let toastEl = null, toastTimer = 0;
Kit.toast = msg => {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'kit-toast';
    toastEl.setAttribute('data-rl', 'kit.toast');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  requestAnimationFrame(() => toastEl.classList.add('on'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400);
};

let open = null;
function overlay(kind, opts) {
  Kit.close();
  const backdrop = document.createElement('div');
  backdrop.className = 'kit-backdrop';
  const panel = document.createElement('div');
  panel.className = 'kit-' + kind;
  panel.setAttribute('data-rl', opts.id || 'kit.' + kind);
  panel.setAttribute('role', 'dialog');
  let html = kind === 'sheet' ? '<div class="kit-grip"></div>' : '';
  if (opts.title) html += '<div class="kit-title">' + esc(opts.title) + '</div>';
  html += '<div class="kit-body"></div>';
  if (opts.actions && opts.actions.length) html += '<div class="kit-actions"></div>';
  panel.innerHTML = html;
  const body = panel.querySelector('.kit-body');
  if (opts.html instanceof Node) body.appendChild(opts.html);
  else body.innerHTML = opts.html || '';
  const bar = panel.querySelector('.kit-actions');
  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    if (a.id) b.setAttribute('data-rl', a.id);
    b.onclick = () => { const keep = a.onClick && a.onClick() === false; if (!keep) Kit.close(); };
    bar.appendChild(b);
  }
  backdrop.onclick = () => Kit.close();
  document.body.appendChild(backdrop);
  document.body.appendChild(panel);
  requestAnimationFrame(() => { backdrop.classList.add('on'); panel.classList.add('on'); });
  open = {backdrop, panel, onClose: opts.onClose};
  return panel;
}

/* Kit.sheet({title, html, actions: [{label, primary, id, onClick}], id}) -> panel element */
Kit.sheet = opts => overlay('sheet', opts || {});
Kit.modal = opts => overlay('modal', opts || {});
Kit.close = () => {
  if (!open) return;
  const o = open;
  open = null;
  o.backdrop.classList.remove('on');
  o.panel.classList.remove('on');
  setTimeout(() => { o.backdrop.remove(); o.panel.remove(); }, 260);
  if (o.onClose) o.onClose();
};

/* Kit.skeleton(3) -> markup for loading rows */
Kit.skeleton = (n, height) => Array.from({length: n || 3}, () =>
  '<div class="kit-skel" style="height:' + (height || 64) + 'px;margin:0 0 12px"></div>').join('');

window.Kit = Kit;
})();
