/* Redline bridge. The server injects this into every prototype page, which
   runs in a sandboxed iframe with an opaque origin. It reports screens and
   the current route, captures component picks in Comment mode, draws pins
   in a shadow root, and talks to the shell only through postMessage. */
(function () {
'use strict';
if (window.__redlineBridge) return;
window.__redlineBridge = true;

/* ---------- storage shims: an opaque origin makes real storage throw ---------- */

function memoryStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(String(k)) ? m.get(String(k)) : null),
    setItem: (k, v) => { m.set(String(k), String(v)); },
    removeItem: k => { m.delete(String(k)); },
    clear: () => m.clear(),
    key: i => { const k = Array.from(m.keys())[i]; return k === undefined ? null : k; },
    get length() { return m.size; },
  };
}
for (const name of ['localStorage', 'sessionStorage']) {
  let ok = false;
  try { window[name].getItem('__rl'); ok = true; } catch (e) {}
  if (!ok) {
    try { Object.defineProperty(window, name, {value: memoryStorage(), configurable: true}); } catch (e) {}
  }
}
try { void document.cookie; } catch (e) {
  const jar = {};
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => Object.keys(jar).map(k => k + '=' + jar[k]).join('; '),
      set: s => {
        const pair = String(s).split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      },
    });
  } catch (e2) {}
}

if (window.parent === window) return;  // opened in its own tab: shims only

/* ---------- messaging ---------- */

const send = (type, data) =>
  parent.postMessage(Object.assign({__redline: 1, type: type}, data || {}), '*');

let base = '';            // e.g. /p/ws/slug/, sent by the shell
let mode = 'interact';
let pins = [];            // [{id, n, status, anchor, el, clips, node}]
let showResolved = false;
let hold = null;          // {el, label, box}: kept highlighted while the popover is open
let ui = null;
let pickSeq = 0;
let lastState = '';
let lastDetached = '';
let down = null;          // pointer down in Comment mode: {x, y, target, alt, drag}

const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ---------- dom helpers ---------- */

function textOf(el) {
  let t = '';
  if (el.matches('input, textarea, select')) t = el.value || el.getAttribute('placeholder') || '';
  else t = el.innerText || el.textContent || '';
  t = t || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || '';
  return t.replace(/\s+/g, ' ').trim();
}

function similar(a, b) {
  a = (a || '').toLowerCase(); b = (b || '').toLowerCase();
  if (!a || !b) return !a && !b;
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a));
}

function isShown(el) {
  if (!el || !el.isConnected || !el.getClientRects().length) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

const q = s => '"' + String(s).replace(/["\\]/g, '\\$&') + '"';

function cssPath(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
    const rl = cur.getAttribute('data-rl');
    if (rl && cur !== el) { parts.unshift('[data-rl=' + q(rl) + ']'); break; }
    const scr = cur.getAttribute('data-rl-screen');
    if (scr) { parts.unshift('[data-rl-screen=' + q(scr) + ']'); break; }
    let part = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

/* Copy edits make sense for a label, a button or a line of text, not for a
   card or a section that holds several blocks. */
const BLOCKISH = /^(block|flex|grid|table|list-item|flow-root)/;
function isCopy(el, text) {
  if (!text || text.length > 300 || el.matches('img, svg, canvas, video')) return false;
  if (el.matches('input, textarea, select')) return true;
  for (const c of el.querySelectorAll('*')) {
    if (c.closest('svg')) continue;
    if (BLOCKISH.test(getComputedStyle(c).display) && (c.innerText || '').trim()) return false;
  }
  return true;
}

function describe(el) {
  const rl = el.getAttribute('data-rl');
  if (rl) return rl;
  if (el.hasAttribute('data-rl-screen')) return 'screen "' + screenTitle(el) + '"';
  if (el === document.body) return 'page';
  const t = textOf(el);
  return el.tagName.toLowerCase() + (t ? ' "' + (t.length > 28 ? t.slice(0, 28) + '...' : t) + '"' : '');
}

/* ---------- screens and routes ---------- */

function screenEls() { return Array.from(document.querySelectorAll('[data-rl-screen]')); }
function screenId(el) { return el.getAttribute('data-rl-screen'); }
function screenTitle(el) { return el.getAttribute('data-rl-title') || screenId(el); }

function hashName() {
  const m = location.hash.match(/^#\/?([^?/]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function currentScreen() {
  const vis = screenEls().filter(isShown);
  if (!vis.length) return null;
  const h = hashName();
  return vis.find(el => screenId(el) === h) || vis[vis.length - 1];
}

function page() {
  let p = location.pathname;
  if (base && p.startsWith(base)) p = p.slice(base.length);
  return p === 'index.html' ? '' : p;
}

function route() { return page() + (location.hash || ''); }

function reportState() {
  const cur = currentScreen();
  const s = {
    screens: screenEls().map(el => ({id: screenId(el), title: screenTitle(el)})),
    screen: cur ? screenId(cur) : '',
    title: cur ? screenTitle(cur) : (document.title || ''),
    route: route(),
  };
  const key = JSON.stringify(s);
  if (key === lastState) return;
  lastState = key;
  send('state', s);
}

function goto(m) {
  const target = m.route != null ? m.route : (m.screen ? '#/' + m.screen : null);
  if (target != null) {
    const hashAt = target.indexOf('#');
    const pg = hashAt >= 0 ? target.slice(0, hashAt) : target;
    const hash = hashAt >= 0 ? target.slice(hashAt) : '';
    if (pg !== page() && base) {
      location.href = base + pg + hash;  // another page: the next bridge takes over
      return;
    }
    if (hash && hash !== location.hash) location.hash = hash;
  }
  if (m.focus) setTimeout(() => { scheduleUpdate(true); flash(m.focus, true); }, 160);
}

/* ---------- shadow ui ---------- */

const UI_CSS = `
:host { all: initial; }
.box { position: fixed; border: 2px solid #f59e0b; background: rgba(245,158,11,.10);
       border-radius: 4px; pointer-events: none; box-sizing: border-box; }
.box.hold { border-color: #b45309; background: rgba(180,83,9,.16); }
.lbl { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; background: #22252e;
       color: #fff; font: 11px/1.5 ui-monospace, Menlo, monospace; padding: 1px 7px;
       border-radius: 4px; white-space: nowrap; max-width: 300px; overflow: hidden;
       text-overflow: ellipsis; }
.box.below .lbl { bottom: auto; top: 100%; margin: 4px 0 0; }
.drag { position: fixed; border: 2px dashed #f59e0b; background: rgba(245,158,11,.08);
        border-radius: 4px; pointer-events: none; box-sizing: border-box; }
.pin { position: fixed; left: 0; top: 0; width: 0; height: 0; pointer-events: none; }
.dot { position: absolute; left: -12px; top: -12px; width: 24px; height: 24px; border-radius: 50%;
       display: grid; place-items: center; box-sizing: border-box;
       font: 600 11px/1 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #fff;
       background: #d97706; border: 2px solid #fff; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.region { position: absolute; inset: 0; border: 2px dashed #d97706; border-radius: 4px;
          background: rgba(217,119,6,.07); box-sizing: border-box; }
.pin.answered .dot { background: #dc2626; }
.pin.answered .region { border-color: #dc2626; background: rgba(220,38,38,.07); }
.pin.resolved .dot { background: #16a34a; }
.pin.resolved .region { border-color: #16a34a; background: rgba(22,163,74,.06); }
:host([data-mode="comment"]) .dot { pointer-events: auto; cursor: pointer; }
:host([data-mode="interact"]) .pin { opacity: .78; }
:host([data-mode="interact"]) .dot { transform: scale(.82); }
.pin.flash .dot { animation: pulse 1.3s ease-out; }
@keyframes pulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(217,119,6,.75); }
  35% { transform: scale(1.45); box-shadow: 0 0 0 12px rgba(217,119,6,0); }
  100% { transform: scale(1); }
}`;

function buildUi() {
  const host = document.createElement('redline-ui');
  host.setAttribute('data-mode', mode);
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({mode: 'open'});
  root.innerHTML = '<style>' + UI_CSS + '</style><div class="box" hidden><span class="lbl"></span></div>'
                 + '<div class="drag" hidden></div><div class="pins"></div>';
  document.documentElement.appendChild(host);
  const style = document.createElement('style');
  style.textContent = 'html.__rl-comment, html.__rl-comment * { cursor: crosshair !important; '
                    + 'user-select: none !important; -webkit-user-select: none !important; }';
  document.documentElement.appendChild(style);
  ui = {host, root, style, box: root.querySelector('.box'), lbl: root.querySelector('.lbl'),
        drag: root.querySelector('.drag'), pinsEl: root.querySelector('.pins')};
}

function ours(e) { return ui && e.composedPath && e.composedPath().includes(ui.host); }

function drawBox(el, label, held) {
  const r = el.getBoundingClientRect();
  const b = ui.box;
  b.hidden = false;
  b.style.left = r.left + 'px'; b.style.top = r.top + 'px';
  b.style.width = r.width + 'px'; b.style.height = r.height + 'px';
  b.classList.toggle('below', r.top < 26);
  b.classList.toggle('hold', !!held);
  ui.lbl.textContent = label;
}

function setMode(m) {
  mode = m === 'comment' ? 'comment' : 'interact';
  if (!ui) return;
  ui.host.setAttribute('data-mode', mode);
  document.documentElement.classList.toggle('__rl-comment', mode === 'comment');
  if (mode !== 'comment') { ui.box.hidden = true; ui.drag.hidden = true; down = null; }
  if (mode !== 'comment' && !hold) ui.box.hidden = true;
}

/* ---------- pins ---------- */

function resolve(a) {
  const scr = a.screen ? document.querySelector('[data-rl-screen=' + q(a.screen) + ']') : null;
  const scope = scr || document;
  if (a.component) {
    const sel = '[data-rl=' + q(a.component) + ']';
    let list = Array.from(scope.querySelectorAll(sel));
    if (!list.length) list = Array.from(document.querySelectorAll(sel));
    if (list.length) {
      // several cards can share one id. When the recorded path still points
      // at one of them with the same text, that is the card: this settles
      // identical cards, which text alone cannot tell apart.
      if (list.length > 1 && a.selector) {
        let at = null;
        try { at = document.querySelector(a.selector); } catch (e) {}
        if (at && list.includes(at) && (!a.text || similar(textOf(at), a.text))) return at;
      }
      // otherwise the text tells them apart
      return list.find(el => a.text && similar(textOf(el), a.text) && isShown(el))
          || list.find(el => a.text && similar(textOf(el), a.text))
          || list.find(isShown) || list[0];
    }
  }
  if (a.selector) {
    try {
      const el = document.querySelector(a.selector);
      if (el && (!a.text || similar(textOf(el), a.text))) return el;
    } catch (e) {}
  }
  if (a.tag && a.text) {
    for (const el of scope.querySelectorAll(a.tag))
      if (similar(textOf(el), a.text)) return el;
  }
  return null;
}

function clipsOf(el) {
  const out = [];
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) out.push(p);
  }
  return out;
}

function renderPins() {
  if (!ui) return;
  ui.pinsEl.textContent = '';
  for (const p of pins) {
    const n = document.createElement('div');
    n.className = 'pin ' + (p.status || '');
    if (p.anchor.box) n.appendChild(Object.assign(document.createElement('div'), {className: 'region'}));
    const dot = document.createElement('div');
    dot.className = 'dot';
    dot.textContent = p.n;
    dot.addEventListener('click', ev => { ev.stopPropagation(); send('pinclick', {id: p.id}); });
    n.appendChild(dot);
    p.node = n;
    ui.pinsEl.appendChild(n);
  }
  resolveAll();
}

function resolveAll() {
  const cur = currentScreen();
  const curId = cur ? screenId(cur) : '';
  const hasScreens = !!document.querySelector('[data-rl-screen]');
  const detached = [];
  for (const p of pins) {
    p.el = resolve(p.anchor);
    p.clips = p.el ? clipsOf(p.el) : [];
    // only judge pins whose screen is on show; frameworks may not render the others at all
    if (!p.el && (!hasScreens || !p.anchor.screen || p.anchor.screen === curId)) detached.push(p.id);
  }
  const key = detached.sort().join(',');
  if (key !== lastDetached) { lastDetached = key; send('detached', {ids: detached}); }
}

function pinPoint(p, r) {
  const a = p.anchor;
  if (a.box) {
    return {x: r.left + a.box[0] * r.width, y: r.top + a.box[1] * r.height,
            w: a.box[2] * r.width, h: a.box[3] * r.height};
  }
  const o = a.offset || [0.5, 0.5];
  return {x: r.left + o[0] * r.width, y: r.top + o[1] * r.height, w: 0, h: 0};
}

function visibleAt(p, x, y) {
  for (const c of p.clips) {
    const r = c.getBoundingClientRect();
    if (x < r.left - 2 || x > r.right + 2 || y < r.top - 2 || y > r.bottom + 2) return false;
  }
  return x > -14 && y > -14 && x < innerWidth + 14 && y < innerHeight + 14;
}

function layout() {
  if (ui) {
    if (!ui.host.isConnected) document.documentElement.appendChild(ui.host);
    for (const p of pins) {
      if (!p.node) continue;
      let show = !!p.el && (p.status !== 'resolved' || showResolved) && isShown(p.el);
      if (show) {
        const r = p.el.getBoundingClientRect();
        const pt = pinPoint(p, r);
        show = (r.width || r.height) && visibleAt(p, pt.x, pt.y);
        if (show) {
          p.node.style.transform = 'translate(' + pt.x + 'px,' + pt.y + 'px)';
          p.node.style.width = pt.w + 'px';
          p.node.style.height = pt.h + 'px';
        }
      }
      p.node.style.display = show ? '' : 'none';
    }
    if (hold && hold.el.isConnected) drawBox(hold.el, hold.label, true);
  }
  requestAnimationFrame(layout);
}

function flash(id, scroll) {
  const p = pins.find(x => x.id === id);
  if (!p || !p.el) return;
  if (scroll) p.el.scrollIntoView({block: 'center', behavior: 'smooth'});
  if (!p.node) return;
  p.node.classList.remove('flash');
  void p.node.offsetWidth;
  p.node.classList.add('flash');
  setTimeout(() => p.node && p.node.classList.remove('flash'), 1400);
}

/* ---------- picking in Comment mode ---------- */

function targetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el !== ui.host ? el : null;
}

function chooseEl(el, exact) {
  if (!el) return null;
  if (el === document.documentElement || el === document.body) return currentScreen() || document.body;
  return exact ? el : (el.closest('[data-rl]') || el);
}

function bgOf(el) {
  for (let p = el; p; p = p.parentElement) {
    const c = getComputedStyle(p).backgroundColor;
    if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
  }
  return '#ffffff';
}

let lib = null;
function loadLib() {
  if (!lib) lib = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/html-to-image.min.js';
    s.onload = () => (window.htmlToImage ? res(window.htmlToImage) : rej(new Error('no lib')));
    s.onerror = rej;
    (document.head || document.documentElement).appendChild(s);
  });
  return lib;
}

/* Screenshot of what was commented on: the element, or for an area pin
   just the dragged box (plus a little margin) cut out of its container. */
async function capture(el, pid, box) {
  let data = null;
  try {
    const h2i = await loadLib();
    const r = el.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1, 1400 / Math.max(1, r.width, r.height));
    // computed styles get inlined into the clone; without this, scroll
    // containers render classic scrollbars in the picture
    const noBars = document.createElement('style');
    noBars.textContent = '* { scrollbar-width: none !important; }';
    document.documentElement.appendChild(noBars);
    let canvas;
    try {
      canvas = await h2i.toCanvas(el, {
        pixelRatio: ratio, skipFonts: true, cacheBust: false, imagePlaceholder: TRANSPARENT,
        backgroundColor: bgOf(el), filter: n => n !== ui.host && n !== noBars,
      });
    } finally { noBars.remove(); }
    if (box) {
      const W = canvas.width, H = canvas.height, pad = 16 * ratio;
      const x = Math.max(0, box[0] * W - pad), y = Math.max(0, box[1] * H - pad);
      const w = Math.min(W - x, box[2] * W + pad * 2), h = Math.min(H - y, box[3] * H + pad * 2);
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w));
      out.height = Math.max(1, Math.round(h));
      out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
      data = out.toDataURL('image/png');
    } else {
      data = canvas.toDataURL('image/png');
    }
  } catch (e) { data = null; }
  send('shot', {pid: pid, data: data});
}

function pick(el, point, box, area) {
  const r = el.getBoundingClientRect();
  const scr = el.closest('[data-rl-screen]') || currentScreen();
  const text = textOf(el).slice(0, 300);
  const anchor = {
    screen: scr ? screenId(scr) : '',
    title: scr ? screenTitle(scr) : (document.title || ''),
    route: route(),
    component: el.getAttribute('data-rl') || '',
    selector: cssPath(el),
    tag: el.tagName.toLowerCase(),
    text: text.slice(0, 160),
    offset: box ? [box[0], box[1]]
                : [(point.x - r.left) / Math.max(1, r.width), (point.y - r.top) / Math.max(1, r.height)],
    viewport: {w: innerWidth, h: innerHeight},
  };
  if (box) anchor.box = box;
  const label = box ? 'area in ' + describe(el) : describe(el);
  hold = {el: el, label: label};
  ui.box.hidden = true;
  const pid = ++pickSeq;
  const near = area || (point
    ? {left: point.x - 10, right: point.x + 10, top: point.y - 10, bottom: point.y + 10}
    : {left: r.left, right: r.right, top: r.top, bottom: r.bottom});
  send('pick', {pid: pid, anchor: anchor, label: label, text: box ? '' : text, rect: near,
                editable: !box && isCopy(el, text)});
  capture(el, pid, box);
}

const BLOCKED = ['click', 'dblclick', 'auxclick', 'contextmenu', 'mousedown', 'mouseup',
                 'touchstart', 'touchend', 'submit', 'dragstart'];

function block(e) {
  if (mode !== 'comment' || ours(e)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onPointerDown(e) {
  if (mode !== 'comment' || ours(e)) return;
  block(e);
  if (hold) return;  // the popover is open; Cancel or Esc first
  down = {x: e.clientX, y: e.clientY, alt: e.altKey, drag: false};
  try { document.documentElement.setPointerCapture(e.pointerId); } catch (err) {}
  // a drag can end outside the iframe; the shell then forwards the pointer
  send('dragging', {on: true});
}

const clampX = x => Math.max(0, Math.min(innerWidth, x));
const clampY = y => Math.max(0, Math.min(innerHeight, y));

function dragTo(x, y) {
  if (!down.drag && Math.hypot(x - down.x, y - down.y) > 8) down.drag = true;
  if (!down.drag) return false;
  x = clampX(x); y = clampY(y);
  const d = ui.drag;
  d.hidden = false;
  d.style.left = Math.min(down.x, x) + 'px';
  d.style.top = Math.min(down.y, y) + 'px';
  d.style.width = Math.abs(x - down.x) + 'px';
  d.style.height = Math.abs(y - down.y) + 'px';
  ui.box.hidden = true;
  return true;
}

function onPointerMove(e) {
  if (mode !== 'comment' || hold) return;
  if (down) {
    block(e);
    if (dragTo(e.clientX, e.clientY)) return;
  }
  if (ours(e)) { ui.box.hidden = true; return; }
  const el = chooseEl(targetAt(e.clientX, e.clientY), e.altKey);
  if (el) drawBox(el, describe(el) + (e.altKey ? '  (exact)' : ''), false);
}

function onPointerUp(e) {
  if (mode !== 'comment' || !down) { if (mode === 'comment' && !ours(e)) block(e); return; }
  block(e);
  release(e.clientX, e.clientY, e.altKey);
}

function release(x, y, alt) {
  const d = down;
  if (!d) return;
  down = null;
  ui.drag.hidden = true;
  send('dragging', {on: false});
  if (d.drag || Math.hypot(x - d.x, y - d.y) > 8) {
    x = clampX(x); y = clampY(y);
    const L = Math.min(d.x, x), T = Math.min(d.y, y);
    const W = Math.abs(x - d.x), H = Math.abs(y - d.y);
    if (W < 4 || H < 4) return;
    let el = targetAt(L + W / 2, T + H / 2);
    const contains = (n) => {
      const r = n.getBoundingClientRect();
      return r.left <= L + 1 && r.top <= T + 1 && r.right >= L + W - 1 && r.bottom >= T + H - 1;
    };
    while (el && el !== document.body && !contains(el)) el = el.parentElement;
    const tagged = el && el.closest('[data-rl]');
    if (tagged && contains(tagged)) el = tagged;
    if (!el || el === document.documentElement) el = document.body;
    const r = el.getBoundingClientRect();
    const box = [(L - r.left) / r.width, (T - r.top) / r.height, W / r.width, H / r.height];
    pick(el, null, box, {left: L, top: T, right: L + W, bottom: T + H});
    return;
  }
  const el = chooseEl(targetAt(d.x, d.y), d.alt || alt);
  if (el) pick(el, {x: d.x, y: d.y}, null);
}

function onKey(e) {
  const t = e.target;
  const typing = t && (t.isContentEditable || (t.matches && t.matches('input, textarea, select')));
  const mod = e.metaKey || e.ctrlKey;
  // the shell's command bar opens from inside the prototype too
  if (mod && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); send('key', {key: 'palette'}); return; }
  if (typing || mod || e.altKey) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === 'c' || k === 'n' || k === 'Escape') send('key', {key: k});
}

/* ---------- wiring ---------- */

let pending = 0;
function scheduleUpdate(now) {
  if (now) { reportState(); resolveAll(); return; }
  if (pending) return;
  pending = setTimeout(() => { pending = 0; reportState(); resolveAll(); }, 150);
}

window.addEventListener('message', e => {
  if (e.source !== parent || !e.data || !e.data.__redline) return;
  const m = e.data;
  if (m.type === 'init') {
    base = m.base || '';
    showResolved = !!m.showResolved;
    setMode(m.mode);
    pins = (m.pins || []).map(p => Object.assign({}, p));
    lastState = '';
    renderPins();
    reportState();
  } else if (m.type === 'mode') {
    setMode(m.mode);
  } else if (m.type === 'pins') {
    showResolved = !!m.showResolved;
    pins = (m.pins || []).map(p => Object.assign({}, p));
    renderPins();
  } else if (m.type === 'hold') {
    if (!m.on) { hold = null; if (ui) ui.box.hidden = true; }
  } else if (m.type === 'goto') {
    goto(m);
  } else if (m.type === 'flash') {
    flash(m.id, true);
  } else if (m.type === 'dragmove') {
    if (down && mode === 'comment') dragTo(m.x, m.y);
  } else if (m.type === 'dragend') {
    if (down && mode === 'comment') release(m.x, m.y, false);
  }
});

function boot() {
  buildUi();
  setMode(mode);
  for (const t of BLOCKED) window.addEventListener(t, block, true);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('mouseleave', () => { if (ui && !hold) ui.box.hidden = true; });
  window.addEventListener('hashchange', () => scheduleUpdate(true));
  window.addEventListener('popstate', () => scheduleUpdate(true));
  new MutationObserver(() => scheduleUpdate(false)).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['hidden', 'class', 'style', 'open', 'data-rl-screen'],
  });
  requestAnimationFrame(layout);
  send('hello', {});
  reportState();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
})();
