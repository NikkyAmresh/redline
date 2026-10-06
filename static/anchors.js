/* Redline anchors for plan comments.

   The markdown stays untouched. While rendering, every block the parser
   produces (paragraph, heading, list item, table row, code block) is tagged
   in the page with the source lines it came from (data-src="41" or
   "12-15"). A comment then records where it was made, not just what text it
   quoted:

     anchor: { lines: "41", where: "Phase 2: real capacity › item 2",
               s: {src: "41", o: 0}, e: {src: "41", o: 52} }

   s and e are the start and end blocks plus character offsets inside their
   text, so repeated phrases, long selections and selections across bold,
   code and links all resolve to exactly one place. Older comments without
   an anchor still resolve by searching for their quote. */
(function () {
'use strict';

const QUOTE_MAX = 200;   // longer selections keep head … tail
const QUOTE_SIDE = 90;

/* ---------- rendering with a source map ---------- */

function lineIndex(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return offset => {  // 0-based line of a character offset
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
}

function setSrc(el, a, b) {
  if (el && el.nodeType === 1) el.dataset.src = a === b ? String(a) : a + '-' + b;
}

const trimmedLen = s => s.replace(/\s+$/, '').length;

/* Render markdown into docEl, tagging blocks with file line numbers.
   bodyLine is the file line where the body starts (after front matter). */
function render(docEl, markdown, bodyLine) {
  const lineOf = lineIndex(markdown);
  const fileLine = offset => bodyLine + lineOf(Math.max(0, offset));
  const locate = (raw, from) => {
    let at = markdown.indexOf(raw, from);
    if (at === -1) {  // nested content is de-indented by the parser
      const first = (raw.split('\n').find(l => l.trim()) || '').trim();
      at = first ? markdown.indexOf(first, from) : -1;
    }
    return at === -1 ? from : at;
  };
  const span = (raw, start) => [fileLine(start), fileLine(start + Math.max(1, trimmedLen(raw)) - 1)];

  function annotateList(tok, listEl, from) {
    if (!listEl) return from;
    const lis = Array.from(listEl.children).filter(c => c.tagName === 'LI');
    let cur = from;
    tok.items.forEach((item, i) => {
      const start = locate(item.raw, cur);
      const [a, b] = span(item.raw, start);
      setSrc(lis[i], a, b);
      cur = start + 1;
      const nestedToks = (item.tokens || []).filter(t => t.type === 'list');
      const nestedEls = lis[i] ? Array.from(lis[i].children).filter(c => /^(UL|OL)$/.test(c.tagName)) : [];
      let nc = start + 1;
      nestedToks.forEach((nt, j) => { nc = annotateList(nt, nestedEls[j], nc); });
      cur = Math.max(cur, nc);
    });
    return cur;
  }

  function annotateTable(tableEl, firstLine) {
    if (!tableEl) return;
    const head = tableEl.querySelector('thead tr');
    setSrc(head, firstLine, firstLine);
    Array.from(tableEl.querySelectorAll('tbody tr')).forEach((tr, i) =>
      setSrc(tr, firstLine + 2 + i, firstLine + 2 + i));
  }

  const tokens = marked.lexer(markdown);
  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const tok of tokens) {
    const start = locate(tok.raw, cursor);
    cursor = start + tok.raw.length;
    if (tok.type === 'space' || tok.type === 'def') continue;
    const one = [tok];
    one.links = tokens.links;
    const tpl = document.createElement('template');
    tpl.innerHTML = marked.parser(one);
    const els = Array.from(tpl.content.children);
    const [a, b] = span(tok.raw, start);
    els.forEach(el => setSrc(el, a, b));
    if (tok.type === 'list') annotateList(tok, els.find(e => /^(UL|OL)$/.test(e.tagName)), start);
    if (tok.type === 'table') annotateTable(els.find(e => e.tagName === 'TABLE'), a);
    frag.appendChild(tpl.content);
  }
  docEl.replaceChildren(frag);
}

/* ---------- where: a readable path to a block ---------- */

function headingTrail(docEl, el) {
  const slots = {};
  for (const h of docEl.querySelectorAll('h1, h2, h3, h4')) {
    // headings come in document order; stop at the first one after el
    if (h === el || !(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    const level = +h.tagName[1];
    slots[level] = h.textContent.trim();
    for (let l = level + 1; l <= 4; l++) delete slots[l];
  }
  const deep = [2, 3, 4].filter(l => slots[l]).map(l => slots[l]);
  return deep.length ? deep : (slots[1] ? [slots[1]] : []);
}

function blockLabel(docEl, el) {
  const tag = el.tagName;
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'LI') {
    const path = [];
    for (let li = el; li && li.tagName === 'LI'; li = li.parentElement && li.parentElement.closest('li')) {
      const sibs = Array.from(li.parentElement.children).filter(c => c.tagName === 'LI');
      path.unshift(sibs.indexOf(li) + 1);
    }
    return 'item ' + path.join('.');
  }
  if (tag === 'TR') {
    if (el.parentElement && el.parentElement.tagName === 'THEAD') return 'table header';
    return 'row ' + (Array.from(el.parentElement.children).indexOf(el) + 1);
  }
  if (tag === 'P') {
    // nth paragraph since the last heading
    let n = 0;
    for (let x = el; x; x = x.previousElementSibling) {
      if (/^H[1-6]$/.test(x.tagName)) break;
      if (x.tagName === 'P') n++;
    }
    return 'paragraph ' + Math.max(1, n);
  }
  if (tag === 'PRE' || el.classList.contains('mermaid-wrap')) return el.classList.contains('mermaid-wrap') ? 'diagram' : 'code block';
  if (tag === 'BLOCKQUOTE') return 'quote';
  if (tag === 'TABLE') return 'table';
  return tag.toLowerCase();
}

function where(docEl, el) {
  const label = blockLabel(docEl, el);
  const trail = /^H[1-6]$/.test(el.tagName) ? [el.textContent.trim()] : headingTrail(docEl, el);
  return trail.concat(label === 'heading' ? [] : [label]).join(' › ');
}

/* ---------- capture ---------- */

function blockOf(docEl, node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  const b = el && el.closest('[data-src]');
  return b && docEl.contains(b) ? b : null;
}

function offsetIn(block, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(block);
  try { r.setEnd(node, offset); } catch (e) { return 0; }
  return r.toString().length;
}

function shorten(text) {
  if (text.length <= QUOTE_MAX) return {quote: text};
  return {quote: text.slice(0, QUOTE_SIDE).trimEnd() + ' … ' + text.slice(-QUOTE_SIDE).trimStart(),
          quote_len: text.length};
}

const firstLine = src => +String(src).split('-')[0];
const lastLine = src => +String(src).split('-').pop();

/* Everything a comment needs from a DOM selection, or null when the
   selection is outside the rendered plan. */
function capture(docEl, range, selectedText) {
  const sb = blockOf(docEl, range.startContainer);
  const eb = blockOf(docEl, range.endContainer);
  if (!sb || !eb) return null;
  const so = offsetIn(sb, range.startContainer, range.startOffset);
  const eo = offsetIn(eb, range.endContainer, range.endOffset);
  const text = (selectedText || range.toString()).trim();
  const lines = firstLine(sb.dataset.src) === lastLine(eb.dataset.src)
    ? String(firstLine(sb.dataset.src))
    : firstLine(sb.dataset.src) + '-' + lastLine(eb.dataset.src);
  let w = where(docEl, sb);
  if (eb !== sb) w += ' … ' + blockLabel(docEl, eb);
  const before = sb.textContent.slice(Math.max(0, so - 40), so);
  const after = eb.textContent.slice(eo, eo + 40);
  return Object.assign(shorten(text), {
    full: text,  // for the edit box; not stored
    section: w,
    prefix: before,
    suffix: after,
    anchor: {lines, where: w, s: {src: sb.dataset.src, o: so}, e: {src: eb.dataset.src, o: eo}},
  });
}

/* ---------- resolving a stored comment to a Range ---------- */

function findBlock(docEl, src) {
  const all = Array.from(docEl.querySelectorAll('[data-src="' + CSS.escape(src) + '"]'));
  // innermost: a list with a single item shares its range with that item
  return all.find(el => !all.some(other => other !== el && el.contains(other))) || null;
}

function textNodes(root) {
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
  return out;
}

function pointAt(block, offset) {
  let left = offset;
  const nodes = textNodes(block);
  for (const n of nodes) {
    if (left <= n.data.length) return [n, left];
    left -= n.data.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? [last, last.data.length] : null;
}

const norm = s => s.replace(/\s+/g, ' ').trim();

function byAnchor(docEl, a) {
  if (!a || !a.s || !a.e) return null;
  const sb = findBlock(docEl, a.s.src), eb = findBlock(docEl, a.e.src);
  if (!sb || !eb) return null;
  const p1 = pointAt(sb, a.s.o), p2 = pointAt(eb, a.e.o);
  if (!p1 || !p2) return null;
  const r = document.createRange();
  try { r.setStart(p1[0], p1[1]); r.setEnd(p2[0], p2[1]); } catch (e) { return null; }
  return r.collapsed ? null : r;
}

/* Text search over the whole document, across element boundaries, with
   whitespace collapsed. Used for older comments and after the plan changed. */
function byQuote(docEl, item) {
  const q = item.quote || '';
  if (q.trim().length < 3) return null;
  const nodes = textNodes(docEl).filter(n => !n.parentElement.closest('.mermaid-wrap'));
  let flat = '';
  const map = [];  // flat index -> [node, offset]
  let lastSpace = true;
  for (const n of nodes) {
    for (let i = 0; i < n.data.length; i++) {
      const ch = /\s/.test(n.data[i]) ? ' ' : n.data[i];
      if (ch === ' ' && lastSpace) continue;
      flat += ch;
      map.push([n, i]);
      lastSpace = ch === ' ';
    }
  }
  const parts = q.split(' … ');
  const head = norm(parts[0]), tail = parts.length > 1 ? norm(parts[parts.length - 1]) : '';
  const hits = [];
  for (let i = flat.indexOf(head); i !== -1; i = flat.indexOf(head, i + 1)) hits.push(i);
  if (!hits.length) return null;
  // prefer the occurrence whose surroundings match what was stored
  const pre = norm(item.prefix || '').slice(-20);
  const pick = hits.find(i => pre && flat.slice(0, i).trimEnd().endsWith(pre)) ?? hits[0];
  let end = pick + head.length;
  if (tail) {
    const t = flat.indexOf(tail, end);
    if (t !== -1) end = t + tail.length;
  }
  const a = map[pick], b = map[end - 1];
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1] + 1);
  return r;
}

/* The range for a feedback item on the version on show. Anchors are exact
   on the version they were made on; after the plan changed, fall back to
   the quote. */
function resolve(docEl, item, version) {
  if (!item.quote && !item.anchor) return null;
  const sameVersion = item.at && String(item.at.version) === String(version);
  if (item.anchor && (sameVersion || !item.at)) {
    const r = byAnchor(docEl, item.anchor);
    if (r && (item.quote_len || norm(r.toString()).startsWith(norm(item.quote).slice(0, 20)))) return r;
  }
  return byQuote(docEl, item);
}

/* ---------- highlighting ---------- */

const supported = typeof Highlight === 'function' && typeof CSS !== 'undefined' && CSS.highlights;
const KINDS = ['open', 'answered', 'resolved'];
let ranges = new Map();

function clear(docEl) {
  if (supported) {
    KINDS.concat('flash').forEach(k => CSS.highlights.delete('rl-' + k));
  }
  docEl.querySelectorAll('mark.fb').forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  });
  ranges = new Map();
}

function kindOf(item) {
  return item.status === 'resolved' ? 'resolved' : item.status === 'answered' ? 'answered' : 'open';
}

/* Fallback for browsers without the Custom Highlight API: wrap each text
   node piece of the range in a mark. */
function wrap(range, item) {
  const pieces = [];
  for (const n of textNodes(range.commonAncestorContainer.nodeType === 1
                            ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode)) {
    if (!range.intersectsNode(n)) continue;
    const s = n === range.startContainer ? range.startOffset : 0;
    const e = n === range.endContainer ? range.endOffset : n.data.length;
    if (e > s) pieces.push([n, s, e]);
  }
  for (const [n, s, e] of pieces.reverse()) {
    const mid = n.splitText(s);
    mid.splitText(e - s);
    const m = document.createElement('mark');
    m.className = 'fb' + (item.status === 'resolved' ? ' resolved' : item.status === 'answered' ? ' answered' : '');
    m.dataset.id = item.id;
    mid.parentNode.insertBefore(m, mid);
    m.appendChild(mid);
  }
}

function paint(docEl, items, version) {
  clear(docEl);
  const groups = {open: [], answered: [], resolved: []};
  const found = [];
  for (const item of items) {
    const r = resolve(docEl, item, version);
    if (!r) continue;
    ranges.set(item.id, r);
    groups[kindOf(item)].push(r);
    found.push([item, r]);
  }
  if (supported) {
    KINDS.forEach(k => { if (groups[k].length) CSS.highlights.set('rl-' + k, new Highlight(...groups[k])); });
  } else {
    found.forEach(([item, r]) => { try { wrap(r, item); } catch (e) {} });
  }
}

function reveal(docEl, id) {
  const r = ranges.get(id);
  if (!r) return false;
  const box = r.getBoundingClientRect();
  window.scrollTo({top: scrollY + box.top - innerHeight / 3, behavior: 'smooth'});
  if (supported) {
    const h = new Highlight(r);
    h.priority = 1;
    CSS.highlights.set('rl-flash', h);
    setTimeout(() => CSS.highlights.delete('rl-flash'), 1300);
  } else {
    docEl.querySelectorAll('mark.fb[data-id="' + CSS.escape(id) + '"]').forEach(m => {
      m.classList.add('flash');
      setTimeout(() => m.classList.remove('flash'), 1300);
    });
  }
  return true;
}

window.RedlineAnchors = {render, capture, resolve, paint, clear, reveal, where};
})();
