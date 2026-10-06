/* Redline review rail, shared by the plan viewer and the prototype shell:
   drafts, Send to Claude, threads and replies, screenshot attachments and
   the comment popover. Pages own what is being reviewed; the rail owns the
   feedback. */
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

function thumbRow(urls) {
  return '<div class="thumbs">' + urls.map(u =>
    '<span class="tw"><img src="' + esc(u) + '"></span>').join('') + '</div>';
}

const RAIL_HTML =
  '<h2>Review</h2><div id="hint"></div><div class="rail-actions"></div>' +
  '<label class="switch" title="Claude hands this batch to a background agent and keeps its own task going, instead of fixing everything in the main context">' +
  '<input type="checkbox" id="bgmode"><span class="track"></span>Run independently (background agent)</label>' +
  '<button class="primary" id="submit" disabled>Send to Claude</button><div id="items"></div>';

const POPOVER_HTML =
  '<div class="quote" id="p-quote"></div><div class="where" id="p-where"></div>' +
  '<div class="kinds" id="p-kinds"></div>' +
  '<div id="p-editwrap" hidden><label>Proposed replacement</label>' +
  '<textarea id="p-replace" class="mono"></textarea></div>' +
  '<label id="p-notelabel">Comment</label>' +
  '<textarea id="p-note" placeholder="What should change, or what do you want to know?"></textarea>' +
  '<div class="thumbs" id="p-imgs"></div>' +
  '<div class="imghint">Paste or drop screenshots to attach</div>' +
  '<div class="row"><button class="ghost" id="p-cancel">Cancel</button>' +
  '<button class="primary" id="p-save">Save draft</button></div>';

/* opts: slug, rail (element), hint (html), actions [{label, title, onClick}],
   decorate(item) -> {num, chip, where}, onCardClick(item), refresh() */
function mount(opts) {
  const slug = opts.slug;
  const rail = opts.rail;
  rail.innerHTML = RAIL_HTML;
  const hint = rail.querySelector('#hint');
  hint.innerHTML = opts.hint || '';
  const actions = rail.querySelector('.rail-actions');
  for (const a of opts.actions || []) {
    const b = document.createElement('button');
    b.className = 'ghost';
    b.textContent = a.label;
    if (a.title) b.title = a.title;
    b.onclick = a.onClick;
    actions.appendChild(b);
  }
  const itemsEl = rail.querySelector('#items');
  const submitBtn = rail.querySelector('#submit');
  const bgmode = rail.querySelector('#bgmode');

  const popover = document.createElement('div');
  popover.id = 'popover';
  popover.hidden = true;
  popover.innerHTML = POPOVER_HTML;
  document.body.appendChild(popover);
  const $ = id => popover.querySelector('#' + id);

  // images: [{url, auto}]; pending: promises of uploads still in flight
  const st = { fb:{items:[]}, fbRaw:'', form:null, images:[], pending:[], replyImgs:{} };
  const refresh = () => opts.refresh && opts.refresh();

  /* ---------- feedback list ---------- */

  function setFeedback(fb) {
    const raw = JSON.stringify(fb);
    if (raw === st.fbRaw) return false;
    st.fb = fb; st.fbRaw = raw;
    render();
    return true;
  }

  function render() {
    const groups = {draft:[], submitted:[], answered:[], resolved:[]};
    for (const i of st.fb.items) (groups[i.status] || groups.draft).push(i);
    let html = '';
    const section = (label, arr, cls) => {
      if (!arr.length) return;
      html += '<h2 class="' + (cls || '') + '">' + label + '</h2>';
      for (const i of arr) html += itemCard(i);
    };
    section('Needs your reply', groups.answered, 'attn');
    section('Drafts', groups.draft);
    section('Waiting for Claude', groups.submitted);
    section('Resolved', groups.resolved.slice().reverse());
    itemsEl.innerHTML = html;
    hint.style.display = st.fb.items.length ? 'none' : '';
    const n = groups.draft.length;
    submitBtn.disabled = !n;
    submitBtn.textContent = n ? 'Send ' + n + ' to Claude' : 'Send to Claude';
  }

  function itemCard(i) {
    const d = (opts.decorate && opts.decorate(i)) || {};
    const answered = i.status === 'answered';
    let h = '<div class="item' + (answered ? ' answered' : '') + '" data-id="' + esc(i.id) + '"><div class="head">';
    if (d.num) h += '<span class="num ' + (i.status === 'resolved' ? 'resolved' : answered ? 'answered' : '')
                  + '">' + d.num + '</span>';
    const chip = i.status === 'resolved' ? ['resolved', 'resolved']
               : answered ? ['answered', 'needs reply']
               : [esc(i.type), i.type === 'edit' ? 'edit' : 'comment'];
    h += '<span class="chip ' + chip[0] + '">' + chip[1] + '</span>';
    if (d.chip) h += d.chip;
    if (i.section) h += '<span class="sec">' + esc(i.section) + '</span>';
    if (i.status === 'draft')
      h += '<button class="rm" title="Remove draft" data-rm="' + esc(i.id) + '">&times;</button>';
    h += '</div>';
    if (d.where) h += '<div class="where">' + esc(d.where) + '</div>';
    if (i.quote) h += '<div class="quote">&ldquo;' + esc(i.quote) + '&rdquo;</div>';
    if (i.comment) h += '<div class="body">' + esc(i.comment) + '</div>';
    if (i.type === 'edit' && i.suggested_text)
      h += '<div class="prop">' + esc(i.suggested_text) + '</div>';
    if (i.images) h += thumbRow(i.images);
    if (i.status === 'resolved' && i.resolution) {
      h += '<div class="res"><span class="who">Resolved</span>' + esc(i.resolution) + '</div>';
    } else {
      const thread = (i.reply ? [{who:'claude', text:i.reply}] : []).concat(i.thread || []);
      for (const m of thread) {
        h += '<div class="msg"><span class="who' + (m.who === 'user' ? ' user' : '') + '">'
           + (m.who === 'user' ? 'You' : 'Claude') + '</span>' + esc(m.text);
        if (m.images) h += thumbRow(m.images);
        h += '</div>';
      }
    }
    if (answered)
      h += '<div class="replybox"><textarea placeholder="Answer Claude&hellip; (paste screenshots too)" data-reply="'
         + esc(i.id) + '"></textarea><div class="thumbs" data-thumbs="' + esc(i.id) + '">'
         + (st.replyImgs[i.id] || []).map(u => '<span class="tw"><img src="' + esc(u) + '"></span>').join('')
         + '</div><button class="primary" data-send="' + esc(i.id) + '">Reply</button></div>';
    return h + '</div>';
  }

  function focusCard(id) {
    const card = itemsEl.querySelector('.item[data-id="' + CSS.escape(id) + '"]');
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
      + '><button class="tx" data-imgrm="' + i + '">&times;</button></span>').join('')
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
      const el = itemsEl.querySelector('[data-thumbs="' + CSS.escape(id) + '"]');
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
  itemsEl.addEventListener('dragover', e => {
    if (e.target.closest('.replybox')) e.preventDefault();
  });
  itemsEl.addEventListener('drop', e => {
    const box = e.target.closest('.replybox');
    if (!box) return;
    e.preventDefault();
    stageReplyImages(box.querySelector('textarea[data-reply]').dataset.reply,
                     imageFiles(e.dataTransfer));
  });

  /* ---------- comment popover ---------- */

  function setType(type) {
    const f = st.form;
    f.type = type;
    $('p-editwrap').hidden = type !== 'edit';
    $('p-notelabel').textContent = type === 'edit' ? 'Why (optional)' : 'Comment';
    if (type === 'edit' && !$('p-replace').value) $('p-replace').value = f.sel.editText || '';
    $('p-kinds').querySelectorAll('button').forEach(b =>
      b.classList.toggle('on', b.dataset.kind === type));
  }

  function place(rect, mode) {
    const w = popover.offsetWidth, h = popover.offsetHeight;
    const minX = scrollX + 8, maxX = scrollX + innerWidth - w - 16;
    let left, top;
    if (!rect) {
      left = Math.max(minX, (innerWidth - w) / 2 + scrollX);
      top = scrollY + 140;
    } else if (mode === 'side') {
      left = rect.right + 14;
      top = rect.top;
      if (left > maxX) left = rect.left - w - 14;
      if (left < minX) { left = Math.max(minX, Math.min(rect.left, maxX)); top = rect.bottom + 10; }
      top = Math.max(scrollY + 8, Math.min(top, scrollY + innerHeight - h - 12));
    } else {
      left = Math.max(minX, Math.min(rect.left, maxX));
      top = rect.bottom + 10;
    }
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  /* sel: {label, where, editText, allowEdit, rect (page coords), place
     ('below' or 'side'), extra (fields merged into the saved item), onClose} */
  function openForm(type, sel) {
    st.form = {type, sel};
    st.images = []; st.pending = [];
    renderFormImgs();
    $('p-quote').textContent = sel.label || '';
    $('p-where').textContent = sel.where || '';
    $('p-kinds').innerHTML = sel.allowEdit
      ? '<button data-kind="comment">Comment</button><button data-kind="edit">Suggest copy</button>' : '';
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

  $('p-save').onclick = async () => {
    const f = st.form;
    if (!f) return;
    const note = $('p-note').value.trim();
    const replace = $('p-replace').value;
    const own = st.images.some(im => !im.auto) || st.pending.length;
    if (f.type === 'comment' && !note && !own) {
      toast('Write a comment or attach a screenshot first'); return;
    }
    if (f.type === 'edit' && replace === (f.sel.editText || '') && !note && !own) {
      toast('Change the text or add a note'); return;
    }
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

  /* ---------- submit, replies, card clicks ---------- */

  bgmode.checked = localStorage.getItem('plan-bgmode') === '1';
  bgmode.onchange = () => localStorage.setItem('plan-bgmode', bgmode.checked ? '1' : '0');

  submitBtn.onclick = async () => {
    try {
      const r = await api('/api/submit/' + slug, {independent: bgmode.checked});
      toast('Sent ' + r.submitted + ' item' + (r.submitted === 1 ? '' : 's')
            + ' to Claude. It is watching the inbox.');
      refresh();
    } catch (e) { toast('Submit failed: ' + e.message); }
  };

  itemsEl.addEventListener('click', async e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      await api('/api/feedback/' + slug + '/delete', {id: rm.dataset.rm});
      refresh();
      return;
    }
    const send = e.target.closest('[data-send]');
    if (send) {
      const id = send.dataset.send;
      const ta = itemsEl.querySelector('textarea[data-reply="' + CSS.escape(id) + '"]');
      const text = ta ? ta.value.trim() : '';
      if (!text && !(st.replyImgs[id] || []).length) {
        toast('Write a reply or attach a screenshot first'); return;
      }
      try {
        if (ta) ta.blur();
        await api('/api/reply/' + slug, {id, text, images: st.replyImgs[id] || [],
                                         independent: bgmode.checked});
        delete st.replyImgs[id];
        toast('Reply sent to Claude');
        refresh();
      } catch (err) { toast('Could not send: ' + err.message); }
      return;
    }
    const img = e.target.closest('.thumbs img');
    if (img) { window.open(img.src); return; }
    if (e.target.closest('.replybox')) return;
    const card = e.target.closest('.item');
    if (!card || !opts.onCardClick) return;
    const item = st.fb.items.find(i => i.id === card.dataset.id);
    if (item) opts.onCardClick(item, card);
  });

  return {
    setFeedback, render, focusCard, openForm, closeForm, attachImage, uploadDataUrl,
    items: () => st.fb.items,
    isFormOpen: () => !!st.form,
    // a re-render would wipe a reply being typed; a focused button is fine
    busy: () => !!st.form || !!(document.activeElement && itemsEl.contains(document.activeElement)
                                && document.activeElement.matches('textarea')),
    setDisabled: on => rail.classList.toggle('disabled', on),
  };
}

window.Redline = { api, toast, esc, mount };
})();
