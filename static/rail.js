/* Redline review panel, shared by the plan page and the prototype page:
   comment cards (drafts, waiting, needs your reply, resolved), threads and
   replies, screenshot attachments, the comment form, and the footer with
   Run independently and Send to Claude. Pages own what is being reviewed;
   the panel owns the feedback. */
(function () {
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function api(path, body) {
  const opts = body ? {method:'POST', headers:{'Content-Type':'application/json'},
                       body:JSON.stringify(body)} : {};
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

function imageFiles(dt) {
  const out = [];
  for (const it of (dt && dt.items) || [])
    if (it.kind === 'file' && it.type.startsWith('image/')) out.push(it.getAsFile());
  return out;
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? '<kbd class="g">⌘</kbd>' : '<kbd>Ctrl</kbd>';
const ENTER = '<kbd class="g">↵</kbd>';
const I = {
  x: '<svg class="i s14" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  check: '<svg class="i s14" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  note: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};

function thumbRow(urls) {
  return '<div class="thumbs">' + urls.map(u =>
    '<span class="tw"><img src="' + esc(u) + '" alt="Attached screenshot"></span>').join('') + '</div>';
}

const POPOVER_HTML =
  '<div class="quote" id="p-quote"></div><div class="where" id="p-where"></div>' +
  '<div class="kinds" id="p-kinds"></div>' +
  '<div id="p-editwrap" hidden><label for="p-replace">Proposed replacement</label>' +
  '<textarea id="p-replace" class="mono"></textarea></div>' +
  '<label id="p-notelabel" for="p-note">Comment</label>' +
  '<textarea id="p-note" placeholder="What should change, or what do you want to know?"></textarea>' +
  '<div class="thumbs" id="p-imgs"></div>' +
  '<div class="imghint">Paste or drop screenshots to attach</div>' +
  '<div class="row"><span class="hintk">' + MOD + ENTER + ' to save</span>' +
  '<button class="btn-ghost" id="p-cancel">Cancel</button>' +
  '<button class="btn-sm solo" id="p-save">Save draft</button></div>';

/* opts:
     slug
     list      element for the comment cards
     footer    element for Run independently, note actions and Send
     hint      html shown when there is no feedback yet
     actions   [{label, title, key, onClick}] note buttons in the footer
     decorate  (item) -> {num, chip, where} extra card details
     onCardClick(item, cardEl), onRender(items), refresh() */
function mount(opts) {
  const slug = opts.slug;
  const list = opts.list;
  const footer = opts.footer;

  footer.innerHTML =
    '<div class="agent-row" role="switch" tabindex="0" aria-checked="false" id="bgmode" ' +
    'title="Claude hands this batch to a background agent and keeps its own task going">' +
    '<span class="switch" aria-hidden="true"></span>Run independently<span class="sub">background agent</span></div>' +
    ((opts.actions || []).length > 1 ? '<div class="note-row"></div>' : '') +
    '<div class="frow"><button class="send" id="submit" disabled><span class="lbl">Send to Claude</span>' +
    '<span class="kbds">' + MOD + ENTER + '</span></button></div>';
  const frow = footer.querySelector('.frow');
  const noteRow = footer.querySelector('.note-row');
  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.className = 'note-btn';
    b.innerHTML = I.note + '<span>' + esc(a.label) + '</span>' + (a.key ? '<kbd>' + esc(a.key) + '</kbd>' : '');
    if (a.title) b.title = a.title;
    b.onclick = a.onClick;
    if (noteRow) noteRow.appendChild(b); else frow.insertBefore(b, frow.firstChild);
  }
  const submitBtn = footer.querySelector('#submit');
  const bgmode = footer.querySelector('#bgmode');

  const popover = document.createElement('div');
  popover.id = 'popover';
  popover.hidden = true;
  popover.setAttribute('role', 'dialog');
  popover.innerHTML = POPOVER_HTML;
  document.body.appendChild(popover);
  const $ = id => popover.querySelector('#' + id);

  // images: [{url, auto}]; pending: promises of uploads still in flight
  const st = { fb:{items:[]}, fbRaw:'', form:null, images:[], pending:[], replyImgs:{} };
  const refresh = () => opts.refresh && opts.refresh();

  /* ---------- the comment list ---------- */

  function setFeedback(fb) {
    const raw = JSON.stringify(fb);
    if (raw === st.fbRaw) return false;
    st.fb = fb; st.fbRaw = raw;
    render();
    return true;
  }

  function counts() {
    const c = {draft:0, submitted:0, answered:0, resolved:0};
    for (const i of st.fb.items) c[i.status] = (c[i.status] || 0) + 1;
    c.total = st.fb.items.length;
    return c;
  }

  function render() {
    const groups = {draft:[], submitted:[], answered:[], resolved:[]};
    for (const i of st.fb.items) (groups[i.status] || groups.draft).push(i);
    let html = '';
    const section = (label, arr, note) => {
      if (!arr.length) return;
      html += '<div class="grp"><span>' + label + '</span><span class="n">' + arr.length + '</span>'
            + (note ? '<span class="note">' + note + '</span>' : '') + '</div><div class="cards">';
      for (const i of arr) html += itemCard(i);
      html += '</div>';
    };
    section('Needs your reply', groups.answered);
    section('Drafts', groups.draft, 'Not sent yet');
    section('Waiting for Claude', groups.submitted);
    section('Resolved', groups.resolved.slice().reverse());
    list.innerHTML = html || '<div class="ihint">' + (opts.hint || '') + '</div>';
    const n = groups.draft.length;
    submitBtn.disabled = !n;
    submitBtn.querySelector('.lbl').textContent = n ? 'Send ' + n + ' to Claude' : 'Send to Claude';
    if (opts.onRender) opts.onRender(st.fb.items);
  }

  function typeLabel(i) {
    if (i.kind === 'screen') return 'Screen note';
    if (!i.quote && !i.anchor) return 'General note';
    return i.type === 'edit' ? 'Suggested edit' : 'Comment';
  }

  function itemCard(i) {
    const d = (opts.decorate && opts.decorate(i)) || {};
    const s = i.status;
    const cls = s === 'answered' ? 'st-reply' : s === 'resolved' ? 'st-resolved' : s === 'submitted' ? 'st-waiting' : 'st-draft';
    const kind = typeLabel(i);
    const head = s === 'answered' ? 'Claude asked you' : s === 'submitted' ? 'Waiting for Claude'
               : s === 'resolved' ? 'Resolved' : kind;
    let h = '<article class="card ' + cls + '" data-id="' + esc(i.id) + '" tabindex="0"><div class="ch">';
    h += d.num ? '<span class="num">' + d.num + '</span>' : '<span class="dot"></span>';
    h += '<span class="ty">' + head + (head !== kind ? ' <span class="k">· ' + kind.toLowerCase() + '</span>' : '') + '</span>';
    if (d.chip) h += d.chip;
    if (s === 'draft')
      h += '<span class="acts"><button title="Remove draft" aria-label="Remove draft" data-rm="' + esc(i.id) + '">' + I.x + '</button></span>';
    h += '</div>';
    // where it is: the plan anchor, or what the page tells us
    const a = i.anchor || {};
    let loc = '';
    if (a.lines) loc = esc(a.where || i.section || '') + ' · <span class="ln">line ' + esc(a.lines) + '</span>';
    else if (d.where) loc = (i.section ? esc(i.section) + ' · ' : '') + '<span class="ln">' + esc(d.where) + '</span>';
    else if (i.section) loc = esc(i.section);
    if (loc) h += '<div class="loc">' + loc + '</div>';
    if (i.type === 'edit' && i.suggested_text) {
      h += '<div class="diff"><div class="m"><span class="sg">-</span><span>' + esc(i.quote) + '</span></div>'
         + '<div class="p"><span class="sg">+</span><span>' + esc(i.suggested_text) + '</span></div></div>';
      if (i.comment && s !== 'answered') h += '<div class="why"><span>Why: </span>' + esc(i.comment) + '</div>';
    } else if (i.quote) {
      h += '<div class="q">' + esc(i.quote) + '</div>';
    }
    if (i.images && s !== 'resolved') h += thumbRow(i.images);
    if (s === 'resolved') {
      if (i.resolution) h += '<div class="resn">' + I.check + '<span>' + esc(i.resolution) + '</span></div>';
    } else {
      const thread = (i.reply ? [{who:'claude', text:i.reply}] : []).concat(i.thread || []);
      if (thread.length) {
        const msgs = (i.comment && i.type !== 'edit' && !(thread[0].who === 'user' && thread[0].text === i.comment))
          ? [{who:'user', text:i.comment}].concat(thread) : thread;
        h += '<div class="thread">' + msgs.map(m =>
          '<div class="msg"><span class="av ' + (m.who === 'user' ? 'av-you">Y' : 'av-claude">C') + '</span><div>'
          + '<div class="who"><b>' + (m.who === 'user' ? 'You' : 'Claude') + '</b></div><p>' + esc(m.text) + '</p>'
          + (m.images ? thumbRow(m.images) : '') + '</div></div>').join('') + '</div>';
      } else if (i.comment && i.type !== 'edit') {
        h += '<div class="body">' + esc(i.comment) + '</div>';
      }
    }
    if (s === 'answered')
      h += '<div class="reply"><textarea placeholder="Reply to Claude, paste screenshots too" data-reply="' + esc(i.id) + '"></textarea>'
         + '<div class="thumbs" data-thumbs="' + esc(i.id) + '">'
         + (st.replyImgs[i.id] || []).map(u => '<span class="tw"><img src="' + esc(u) + '"></span>').join('') + '</div>'
         + '<div class="rf"><span>Sends to Claude now</span><span class="sp"></span>'
         + '<button class="btn-sm" data-send="' + esc(i.id) + '">Reply <span class="kbds">' + MOD + ENTER + '</span></button></div></div>';
    return h + '</article>';
  }

  function focusCard(id) {
    const card = list.querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    if (!card) return;
    card.scrollIntoView({block:'nearest', behavior:'smooth'});
    card.classList.add('focus');
    setTimeout(() => card.classList.remove('focus'), 1400);
  }

  /* ---------- image attachments ---------- */

  function uploadDataUrl(dataUrl) {
    return api('/api/upload/' + slug, {data: dataUrl}).then(j => j.url);
  }

  function uploadImage(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => uploadDataUrl(r.result).then(res, rej);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  function renderFormImgs() {
    $('p-imgs').innerHTML = st.images.map((im, i) =>
      '<span class="tw"><img src="' + esc(im.url) + '"' + (im.auto ? ' title="Captured automatically"' : '')
      + '><button class="tx" data-imgrm="' + i + '" aria-label="Remove">&times;</button></span>').join('')
      + st.pending.map(() => '<span class="tw loading">capturing</span>').join('');
    if (st.form) place(st.form.sel.rect, st.form.sel.place);  // it grew; stay on screen
  }

  $('p-imgs').onclick = e => {
    const b = e.target.closest('[data-imgrm]');
    if (b) { st.images.splice(+b.dataset.imgrm, 1); renderFormImgs(); }
  };

  /* Attach the result of an upload promise (resolving to an /uploads url) to
     the open form. auto marks a screenshot the page captured by itself, which
     does not count as content when validating the draft. */
  function attachImage(promise, auto) {
    const form = st.form;
    if (!form) return;
    const p = Promise.resolve(promise).then(url => {
      if (st.form === form && url) st.images.push({url, auto: !!auto});
    }, () => { if (!auto) toast('Upload failed'); });
    st.pending.push(p);
    renderFormImgs();
    p.finally(() => {
      st.pending = st.pending.filter(x => x !== p);
      if (st.form === form) renderFormImgs();
    });
  }

  function stageReplyImages(id, files) {
    files.forEach(f => uploadImage(f).then(u => {
      (st.replyImgs[id] = st.replyImgs[id] || []).push(u);
      const el = list.querySelector('[data-thumbs="' + CSS.escape(id) + '"]');
      if (el) el.innerHTML = st.replyImgs[id].map(x =>
        '<span class="tw"><img src="' + esc(x) + '"></span>').join('');
    }, () => toast('Upload failed')));
  }

  document.addEventListener('paste', e => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    if (st.form) { e.preventDefault(); files.forEach(f => attachImage(uploadImage(f))); return; }
    const ta = document.activeElement;
    if (ta && ta.matches && ta.matches('textarea[data-reply]')) {
      e.preventDefault();
      stageReplyImages(ta.dataset.reply, files);
    }
  });

  popover.addEventListener('dragover', e => { if (st.form) e.preventDefault(); });
  popover.addEventListener('drop', e => {
    if (!st.form) return;
    e.preventDefault();
    imageFiles(e.dataTransfer).forEach(f => attachImage(uploadImage(f)));
  });
  list.addEventListener('dragover', e => { if (e.target.closest('.reply')) e.preventDefault(); });
  list.addEventListener('drop', e => {
    const box = e.target.closest('.reply');
    if (!box) return;
    e.preventDefault();
    stageReplyImages(box.querySelector('textarea[data-reply]').dataset.reply, imageFiles(e.dataTransfer));
  });

  /* ---------- the comment form ---------- */

  function setType(type) {
    const f = st.form;
    f.type = type;
    $('p-editwrap').hidden = type !== 'edit';
    $('p-notelabel').textContent = type === 'edit' ? 'Why (optional)' : 'Comment';
    if (type === 'edit' && !$('p-replace').value) $('p-replace').value = f.sel.editText || '';
    $('p-kinds').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.kind === type));
  }

  function place(rect, mode) {
    const w = popover.offsetWidth, h = popover.offsetHeight;
    const minX = scrollX + 8, maxX = scrollX + innerWidth - w - 12;
    let left, top;
    if (!rect) {
      left = Math.max(minX, (innerWidth - w) / 2 + scrollX);
      top = scrollY + Math.max(80, innerHeight * .18);
    } else if (mode === 'side') {
      left = rect.right + 14;
      top = rect.top;
      if (left > maxX) left = rect.left - w - 14;
      if (left < minX) { left = Math.max(minX, Math.min(rect.left, maxX)); top = rect.bottom + 10; }
    } else {
      left = Math.max(minX, Math.min(rect.left, maxX));
      top = rect.bottom + 10;
      if (top + h > scrollY + innerHeight - 12) top = Math.max(scrollY + 8, rect.top - h - 10);
    }
    top = Math.max(scrollY + 8, Math.min(top, scrollY + innerHeight - h - 12));
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  /* sel: {label, where, editText, allowEdit, editLabel, rect (page coords), place
     ('below' or 'side'), extra (fields merged into the saved item), onClose} */
  function openForm(type, sel) {
    st.form = {type, sel};
    st.images = []; st.pending = [];
    renderFormImgs();
    $('p-quote').textContent = sel.label || '';
    $('p-where').textContent = sel.where || '';
    $('p-kinds').innerHTML = sel.allowEdit
      ? '<span class="seg"><button data-kind="comment">Comment</button><button data-kind="edit">' + esc(sel.editLabel || 'Suggest copy') + '</button></span>' : '';
    $('p-replace').value = type === 'edit' ? (sel.editText || '') : '';
    $('p-note').value = '';
    setType(type);
    popover.hidden = false;
    place(sel.rect, sel.place);
    (type === 'edit' ? $('p-replace') : $('p-note')).focus();
  }

  $('p-kinds').onclick = e => {
    const b = e.target.closest('[data-kind]');
    if (!b || !st.form) return;
    setType(b.dataset.kind);
    (b.dataset.kind === 'edit' ? $('p-replace') : $('p-note')).focus();
  };

  function closeForm() {
    const f = st.form;
    st.form = null;
    popover.hidden = true;
    if (f && f.sel.onClose) f.sel.onClose();
  }

  $('p-cancel').onclick = closeForm;
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st.form) { closeForm(); e.stopImmediatePropagation(); }
  });
  popover.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); $('p-save').click(); }
  });

  $('p-save').onclick = async () => {
    const f = st.form;
    if (!f) return;
    const note = $('p-note').value.trim();
    const replace = $('p-replace').value;
    const own = st.images.some(im => !im.auto) || st.pending.length;
    if (f.type === 'comment' && !note && !own) { toast('Write a comment or attach a screenshot first'); return; }
    if (f.type === 'edit' && replace === (f.sel.editText || '') && !note && !own) { toast('Change the text or add a note'); return; }
    if (st.pending.length) {  // let an in-flight capture land, but never hang on it
      $('p-save').disabled = true;
      await Promise.race([Promise.all(st.pending), new Promise(r => setTimeout(r, 4000))]);
      $('p-save').disabled = false;
      if (st.form !== f) return;
    }
    const body = Object.assign({}, f.sel.extra || {}, {type: f.type, comment: note});
    if (f.type === 'edit') body.suggested_text = replace;
    if (st.images.length) body.images = st.images.map(im => im.url);
    try {
      await api('/api/feedback/' + slug, body);
      closeForm();
      toast('Draft saved');
      refresh();
    } catch (e) { toast('Could not save: ' + e.message); }
  };

  /* ---------- send, replies, card clicks ---------- */

  const setBg = on => bgmode.setAttribute('aria-checked', on ? 'true' : 'false');
  setBg(localStorage.getItem('plan-bgmode') === '1');
  bgmode.querySelector('.switch').setAttribute('aria-checked', bgmode.getAttribute('aria-checked'));
  const toggleBg = () => {
    const on = bgmode.getAttribute('aria-checked') !== 'true';
    setBg(on);
    bgmode.querySelector('.switch').setAttribute('aria-checked', on);
    localStorage.setItem('plan-bgmode', on ? '1' : '0');
  };
  bgmode.onclick = toggleBg;
  bgmode.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleBg(); } };
  const independent = () => bgmode.getAttribute('aria-checked') === 'true';

  async function send() {
    if (submitBtn.disabled) { toast('No drafts to send'); return; }
    try {
      const r = await api('/api/submit/' + slug, {independent: independent()});
      toast('Sent ' + r.submitted + ' item' + (r.submitted === 1 ? '' : 's') + ' to Claude. It is watching the inbox.');
      refresh();
    } catch (e) { toast('Submit failed: ' + e.message); }
  }
  submitBtn.onclick = send;

  async function sendReply(id) {
    const ta = list.querySelector('textarea[data-reply="' + CSS.escape(id) + '"]');
    const text = ta ? ta.value.trim() : '';
    if (!text && !(st.replyImgs[id] || []).length) { toast('Write a reply or attach a screenshot first'); return; }
    try {
      if (ta) ta.blur();
      await api('/api/reply/' + slug, {id, text, images: st.replyImgs[id] || [], independent: independent()});
      delete st.replyImgs[id];
      toast('Reply sent to Claude');
      refresh();
    } catch (err) { toast('Could not send: ' + err.message); }
  }

  list.addEventListener('keydown', e => {
    const ta = e.target.closest && e.target.closest('textarea[data-reply]');
    if (ta && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); sendReply(ta.dataset.reply); }
    else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('card')) e.target.click();
  });

  list.addEventListener('click', async e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      await api('/api/feedback/' + slug + '/delete', {id: rm.dataset.rm});
      refresh();
      return;
    }
    const sendBtn = e.target.closest('[data-send]');
    if (sendBtn) { sendReply(sendBtn.dataset.send); return; }
    const img = e.target.closest('.thumbs img');
    if (img) { window.open(img.src); return; }
    if (e.target.closest('.reply')) return;
    const card = e.target.closest('.card');
    if (!card || !opts.onCardClick) return;
    const item = st.fb.items.find(i => i.id === card.dataset.id);
    if (item) opts.onCardClick(item, card);
  });

  return {
    setFeedback, render, focusCard, openForm, closeForm, attachImage, uploadDataUrl, send, counts,
    items: () => st.fb.items,
    isFormOpen: () => !!st.form,
    // a re-render would wipe a reply being typed; a focused button is fine
    busy: () => !!st.form || !!(document.activeElement && list.contains(document.activeElement)
                                && document.activeElement.matches('textarea')),
    setDisabled: on => { footer.hidden = on; list.classList.toggle('disabled', on); },
  };
}

window.Redline = { api, toast, esc, mount };
})();
