/* Redline Studio page kit, shared by the index, the plan page and the
   prototype page: theme, icons, dates and versions, the version menu, the
   command bar and the phone layout's pane tabs. Load it in <head> so the
   theme is set before the first paint. */
(function () {
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/* ---------- theme: a saved choice, else the system's ---------- */

let saved = null;
try { saved = localStorage.getItem('rl-theme'); } catch (e) {}
document.documentElement.dataset.theme = saved === 'light' || saved === 'dark' ? saved
  : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

// side panes: an explicit choice is remembered; otherwise the layout decides
for (const side of ['left', 'right']) {
  let v = null;
  try { v = localStorage.getItem('rl-' + side); } catch (e) {}
  if (v === 'open' || v === 'closed') document.documentElement.dataset[side] = v;
}

const themeHooks = [];
const theme = () => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

function paintTheme() {
  document.querySelectorAll('[data-theme-toggle]').forEach(b => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    b.innerHTML = '<svg class="i"><use href="#i-' + (next === 'light' ? 'sun' : 'moon') + '"/></svg>';
    b.title = 'Switch to the ' + next + ' theme';
    b.setAttribute('aria-label', b.title);
  });
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('rl-theme', t); } catch (e) {}
  paintTheme();
  themeHooks.forEach(f => f(t));
}
const toggleTheme = () => setTheme(theme() === 'dark' ? 'light' : 'dark');

/* ---------- icons ---------- */

const P = (id, body) => '<symbol id="' + id + '" viewBox="0 0 24 24">' + body + '</symbol>';
const SPRITE =
  '<symbol id="mark" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#22252e"/>'
  + '<rect x="13" y="17" width="25" height="5" rx="2.5" fill="#faf8f3"/><rect x="13" y="29.5" width="36" height="5" rx="2.5" fill="#faf8f3"/>'
  + '<rect x="13" y="42" width="21" height="5" rx="2.5" fill="#faf8f3" opacity=".55"/>'
  + '<path d="M10.5 38.6C21 36.2 37 37.4 51.5 35.3" fill="none" stroke="#ef4444" stroke-width="3.6" stroke-linecap="round"/>'
  + '<path d="M44 10.5h11.5a3.5 3.5 0 0 1 3.5 3.5v6.5a3.5 3.5 0 0 1-3.5 3.5H51l-4.2 3.6V24H44a3.5 3.5 0 0 1-3.5-3.5V14a3.5 3.5 0 0 1 3.5-3.5z" fill="#f59e0b"/></symbol>'
  + P('i-search', '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>')
  + P('i-phone', '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>')
  + P('i-tablet', '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M11 18.5h2"/>')
  + P('i-desktop', '<rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8.5 20.5h7M12 16.5v4"/>')
  + P('i-pointer', '<path d="M6 3.5l12.5 7.2-5.6 1.7-3.1 5.4z"/>')
  + P('i-down', '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>')
  + P('i-chev', '<path d="M7 10l5 5 5-5"/>')
  + P('i-file', '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>')
  + P('i-sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>')
  + P('i-moon', '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>')
  + P('i-comment', '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/>')
  + P('i-edit', '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>')
  + P('i-list', '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>')
  + P('i-doc', '<path d="M7 3h7l5 5v13H7z"/><path d="M10 13h6M10 17h6"/>')
  + P('i-status', '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>')
  + P('i-hash', '<path d="M5 9h14M4 15h14M10 3L8 21M16 3l-2 18"/>')
  + P('i-history', '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>')
  + P('i-reset', '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>')
  + P('i-send', '<path d="M4 12l16-8-6 16-2.5-6.5z"/>')
  + P('i-ext', '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>')
  + P('i-screen', '<rect x="4" y="3.5" width="16" height="17" rx="2.5"/><path d="M8 8h8M8 12h5"/>')
  + P('i-proto', '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/><path d="M9 7h6M9 10.5h4"/>')
  + P('i-plan', '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>')
  + P('i-side-l', '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9 4.5v15"/>')
  + P('i-side-r', '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M15 4.5v15"/>')
  + P('i-folder', '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>');

function boot() {
  if (!document.getElementById('rl-sprite')) {
    const holder = document.createElement('div');
    holder.innerHTML = '<svg id="rl-sprite" width="0" height="0" style="position:absolute" aria-hidden="true">' + SPRITE + '</svg>';
    document.body.insertBefore(holder.firstChild, document.body.firstChild);
  }
  document.querySelectorAll('kbd.mod').forEach(k => { k.textContent = MAC ? '⌘' : 'Ctrl'; });
  paintTheme();
  paintPanes();
  const tabbar = document.getElementById('tabbar');
  if (tabbar) tabbar.addEventListener('click', e => { const b = e.target.closest('button'); if (b) showPane(b.dataset.pane, true); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
document.addEventListener('click', e => { if (e.target.closest('[data-theme-toggle]')) toggleTheme(); });

/* ---------- live indicator and phone panes ---------- */

function setLive(on) {
  const el = document.getElementById('live');
  if (!el) return;
  el.classList.toggle('on', on);
  document.getElementById('livetext').textContent = on ? 'Live' : 'Offline';
}

const isPhone = () => innerWidth <= 860;
function showPane(id, force) {
  if (!force && !isPhone()) return;
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('m-active', p.id === id));
  document.querySelectorAll('#tabbar button').forEach(b => b.setAttribute('aria-selected', b.dataset.pane === id));
  window.scrollTo(0, 0);
  window.dispatchEvent(new Event('resize'));
}

/* ---------- collapsible side panes ---------- */

const PANE_NAMES = {left: 'side panel', right: 'review panel'};
const paneHooks = [];
// open unless closed; the left pane starts closed on narrow screens
function paneOpen(side) {
  const v = document.documentElement.dataset[side];
  if (v) return v === 'open';
  return side === 'right' || innerWidth > 1180;
}
function paintPanes() {
  document.querySelectorAll('[data-pane-toggle]').forEach(b => {
    const side = b.dataset.paneToggle, open = paneOpen(side);
    b.setAttribute('aria-pressed', open);
    b.title = (open ? 'Hide' : 'Show') + ' the ' + PANE_NAMES[side] + ' (' + (side === 'left' ? '[' : ']') + ')';
    b.setAttribute('aria-label', b.title);
  });
}
function setPane(side, open) {
  document.documentElement.dataset[side] = open ? 'open' : 'closed';
  try { localStorage.setItem('rl-' + side, open ? 'open' : 'closed'); } catch (e) {}
  paintPanes();
  paneHooks.forEach(f => f(side, open));
  window.dispatchEvent(new Event('resize'));
}
const togglePane = side => setPane(side, !paneOpen(side));
// make sure a pane is visible, on the phone by switching tabs
function revealPane(side) {
  if (isPhone()) return;
  if (!paneOpen(side)) setPane(side, true);
}
document.addEventListener('click', e => { const b = e.target.closest('[data-pane-toggle]'); if (b) togglePane(b.dataset.paneToggle); });
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || isPhone()) return;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.key === '[' || e.key === ']') { e.preventDefault(); togglePane(e.key === '[' ? 'left' : 'right'); }
});
window.addEventListener('resize', () => paintPanes());

/* ---------- dates and versions ---------- */

function niceDate(d) {
  if (!d) return '';
  const [day, time] = d.split(' ');
  const iso = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  if (day === iso(new Date())) return 'today, ' + time;
  if (day === iso(new Date(Date.now() - 864e5))) return 'yesterday, ' + time;
  return new Date(day + 'T00:00').toLocaleDateString(undefined, {month: 'short', day: 'numeric'}) + ', ' + time;
}
const subjectTitle = c => { const m = c.subject.split(' - '); return m.length > 1 ? m.slice(1).join(' - ') : (c.version === '1' ? 'First version' : c.subject); };
const vLabel = c => c.version ? 'v' + c.version : c.short;
const stat = c => (c.adds ? '<span class="add">+' + c.adds + '</span> ' : '') + (c.dels ? '<span class="del">−' + c.dels + '</span>' : '');
// the newest commit is the live document when it carries the live version
const isLive = (c, i, live) => i === 0 && !!c.version && c.version === String(live || '');

/* hist: commits from /api/history, live: the live version, viewing: the sha
   shown read only, or null */
function versionList(hist, live, viewing) {
  if (!hist.length) return '<li class="pl-empty">No saved versions yet</li>';
  return hist.map((c, i) => {
    const lv = isLive(c, i, live), cur = viewing ? viewing === c.sha : lv;
    return '<li><button class="vrow' + (cur ? ' cur' : '') + '" data-sha="' + c.sha + '" data-live="' + lv + '">'
      + '<span class="vn">' + esc(vLabel(c)) + '</span><span class="vt">' + esc(subjectTitle(c)) + '</span>'
      + '<span class="vd">' + stat(c) + '</span>'
      + '<span class="vm">' + esc(niceDate(c.date)) + (lv ? '<span class="livetag">Live</span>' : '') + '</span></button></li>';
  }).join('');
}

function historyTimeline(hist, live, viewing, slug) {
  if (!hist.length) return '<div class="empty-state"><b>No saved versions yet</b>Every version Claude writes is committed and shows up here.</div>';
  return '<ol class="hist">' + hist.map((c, i) => {
    const lv = isLive(c, i, live), on = viewing === c.sha;
    return '<li class="hi' + (lv ? ' cur' : '') + (on ? ' viewing' : '') + '"><span class="node"></span>'
      + '<div class="ht"><span class="vn">' + esc(vLabel(c)) + '</span>' + (lv ? '<span class="livetag">Live</span>' : '')
      + '<time>' + esc(niceDate(c.date)) + '</time></div>'
      + '<div class="by">' + esc(subjectTitle(c)) + '</div><div class="hf">'
      + (lv ? '' : '<button class="btn-ghost" data-sha="' + c.sha + '" data-live="false">' + (on ? 'Viewing' : 'View') + '</button>')
      + '<a class="btn-ghost" href="/raw-at/' + c.sha + '/' + esc(slug) + '">Download</a>'
      + '<span class="stat">' + stat(c) + (c.adds || c.dels ? ' lines' : '') + '</span></div></li>';
  }).join('') + '</ol>';
}

function versionMenuItems(hist, live, viewing) {
  return hist.map((c, i) => {
    const lv = isLive(c, i, live), cur = viewing ? viewing === c.sha : lv;
    return '<button class="pop-i' + (cur ? ' cur' : '') + '" data-sha="' + c.sha + '" data-live="' + lv + '">'
      + '<span class="vn">' + esc(vLabel(c)) + '</span><span class="vt">' + esc(subjectTitle(c)) + '</span>'
      + '<span class="vm">' + esc(niceDate(c.date)) + (lv ? ', live' : '') + '</span></button>';
  }).join('') || '<div class="pl-empty" style="padding:8px">No saved versions yet</div>';
}

/* A menu anchored under a button. build() returns its html; onPick(button)
   runs for a click on any button inside it. */
function menu(btn, pop, build, onPick) {
  const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    pop.innerHTML = build();
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8, innerWidth - 312)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });
  pop.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { close(); onPick(b); } });
  document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) close(); });
  return {close};
}

/* ---------- command bar ---------- */

/* commands() returns [{group, title, run, key?, icon?, dot?}] each time the
   bar opens or the query changes. */
function palette(commands) {
  const wrap = document.createElement('div');
  wrap.className = 'pal-wrap';
  wrap.hidden = true;
  wrap.innerHTML = '<div class="pal" role="dialog" aria-label="Command bar">'
    + '<div class="pal-in"><svg class="i"><use href="#i-search"/></svg><input placeholder="Search or run a command" autocomplete="off" aria-label="Command"></div>'
    + '<div class="pal-list" role="listbox"></div>'
    + '<div class="pal-foot"><span><kbd class="g">↑</kbd><kbd class="g">↓</kbd> move</span><span><kbd class="g">↵</kbd> run</span><span><kbd>Esc</kbd> close</span></div></div>';
  document.body.appendChild(wrap);
  const input = wrap.querySelector('input'), list = wrap.querySelector('.pal-list');
  const st = {items: [], act: 0};

  const fuzzy = (q, t) => {
    q = q.toLowerCase(); t = t.toLowerCase();
    if (!q || t.includes(q)) return true;
    let i = 0;
    for (const ch of t) if (ch === q[i]) i++;
    return i === q.length;
  };

  function render() {
    const q = input.value.trim();
    st.items = commands().filter(c => fuzzy(q, c.title + ' ' + c.group));
    st.act = Math.min(st.act, Math.max(0, st.items.length - 1));
    let html = '', group = '';
    st.items.forEach((c, i) => {
      if (c.group !== group) { group = c.group; html += '<div class="pal-g">' + esc(group) + '</div>'; }
      html += '<button class="pal-i' + (i === st.act ? ' act' : '') + '" data-i="' + i + '" role="option">'
        + (c.dot ? '<span class="dotx" style="background:' + c.dot + '"></span>' : '<svg class="i s14"><use href="#i-' + (c.icon || 'send') + '"/></svg>')
        + '<span class="t">' + esc(c.title) + '</span>' + (c.key ? '<kbd>' + esc(c.key) + '</kbd>' : '') + '</button>';
    });
    list.innerHTML = html || '<div class="pal-empty">Nothing matches</div>';
    const act = list.querySelector('.pal-i.act');
    if (act) act.scrollIntoView({block: 'nearest'});
  }

  const open = () => { wrap.hidden = false; input.value = ''; st.act = 0; render(); input.focus(); };
  const close = () => { wrap.hidden = true; };
  const run = i => { const c = st.items[i]; close(); if (c) c.run(); };

  input.addEventListener('input', () => { st.act = 0; render(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); st.act = Math.min(st.act + 1, st.items.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); st.act = Math.max(st.act - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(st.act); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  list.addEventListener('click', e => { const b = e.target.closest('.pal-i'); if (b) run(+b.dataset.i); });
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); wrap.hidden ? open() : close(); }
  });
  return {open, close, isOpen: () => !wrap.hidden};
}

window.Studio = {
  esc, MAC, theme, setTheme, toggleTheme, onTheme: f => themeHooks.push(f),
  setLive, showPane, isPhone, paneOpen, setPane, togglePane, revealPane, onPane: f => paneHooks.push(f),
  niceDate, subjectTitle, vLabel, stat, isLive, versionList, historyTimeline, versionMenuItems,
  menu, palette,
};
})();
