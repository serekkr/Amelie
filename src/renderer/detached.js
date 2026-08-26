// Detached note window: a standalone viewer/editor for a single note so it
// can be dragged onto another monitor. Renders the same markdown the main app
// preview shows, polls the file so external edits appear here too, and has an
// edit/view toggle in the header (edits write straight back to the note).

const params = new URLSearchParams(location.search);
const notePath = params.get('path') || '';
const noteName = params.get('name') || '';
const themeAttr = params.get('theme') || '';
let currentPath = notePath;   // wiki-link navigation can move this window to another note

// Match the main window's theme.
if (themeAttr) document.documentElement.setAttribute('data-theme', themeAttr);
// Match saved appearance (font sizes/family) — localStorage is shared per origin.
try {
  const ap = JSON.parse(localStorage.getItem('inkwell-appearance') || '{}');
  const root = document.documentElement.style;
  if (ap.editorFontSize) root.setProperty('--editor-font-size', ap.editorFontSize + 'px');
  if (ap.viewWidth) document.documentElement.setAttribute('data-view-width', ap.viewWidth);
} catch (_) {}

const nameEl = document.getElementById('det-name');
const previewContent = document.getElementById('preview-content');
nameEl.textContent = noteName || notePath.split('/').pop() || 'Nota';
document.title = nameEl.textContent + ' — Amelie';

// ── Load marked (same CDN/version as the main renderer) ───────────────────────
function loadMarked() {
  return new Promise((resolve) => {
    if (typeof marked !== 'undefined') return resolve();
    const s = document.createElement('script');
    s.src = 'marked.min.js';   // vendored locally (was cloudflare CDN)
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

function stripFrontmatter(text) {
  // Leading YAML frontmatter delimited by --- ... ---
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length) : text;
}

// ── Note tree (for [[wiki-link]] resolution) ──────────────────────────────────
let _allNotes = [];
function _flatten(nodes) {
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'folder') out.push(..._flatten(n.children));
    else out.push(n);
  }
  return out;
}
async function loadNoteIndex() {
  try { _allNotes = _flatten(await window.inkwell.listNotes()); } catch (_) { _allNotes = []; }
}
// Same forgiving matching as the main renderer's resolveNoteLink.
function resolveNote(rawTarget) {
  const target = (rawTarget || '').trim();
  if (!target) return null;
  const stripExt = (s) => s.replace(/\.(md|markdown|txt)$/i, '');
  const basename = (p) => stripExt((p || '').split('/').pop() || '');
  const normSpace = (s) => s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
  const normAlpha = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tLower = target.toLowerCase(), tSpace = normSpace(target), tAlpha = normAlpha(target);
  return _allNotes.find(n => (n.name || '').toLowerCase() === tLower)
    || _allNotes.find(n => basename(n.path).toLowerCase() === tLower)
    || _allNotes.find(n => normSpace(n.name || '') === tSpace || normSpace(basename(n.path)) === tSpace)
    || _allNotes.find(n => normAlpha(n.name || '') === tAlpha || normAlpha(basename(n.path)) === tAlpha)
    || null;
}

// Navigate this window to another note (wiki-link click or prev/next arrows).
// Works in BOTH modes: in edit mode the textarea is reloaded directly (the
// polling refresh() is paused there on purpose).
function loadNote(path, name) {
  currentPath = path;
  _lastRaw = null;
  nameEl.textContent = name || path.split('/').pop() || 'Nota';
  document.title = nameEl.textContent + ' — Amelie';
  if (_mode === 'edit') {
    window.inkwell.readNote(path).then(raw => {
      if (currentPath !== path) return;
      _lastRaw = raw || '';
      editorEl.value = _lastRaw;
      editorEl.setSelectionRange(0, 0);
      editorEl.scrollTop = 0;
    }).catch(() => {});
  } else {
    refresh();
  }
  updateNavButtons();
}

// ── Prev/next note arrows (same order as the sidebar tree) ────────────────────
function _navNotes() {
  return _allNotes.filter(n => n.path && /\.(md|markdown|txt)$/i.test(n.path));
}
function updateNavButtons() {
  const prev = document.getElementById('det-prev');
  const next = document.getElementById('det-next');
  if (!prev || !next) return;
  const list = _navNotes();
  const idx = list.findIndex(n => n.path === currentPath);
  prev.disabled = (idx <= 0);
  next.disabled = (idx === -1 || idx >= list.length - 1);
}
async function navNote(dir) {
  // Refresh the index first: notes may have been created/renamed meanwhile.
  await loadNoteIndex();
  const list = _navNotes();
  const idx = list.findIndex(n => n.path === currentPath);
  const target = list[idx + dir];
  if (target) loadNote(target.path, target.name);
  else updateNavButtons();
}
document.getElementById('det-prev')?.addEventListener('click', () => navNote(-1));
document.getElementById('det-next')?.addEventListener('click', () => navNote(1));

// Apply `fn` only to the parts of the note that are NOT code: outside fenced
// blocks and outside inline `code` spans. Kept in step with _rewriteOutsideCode
// in app.js — this window loads its own scripts and shares nothing with it.
function _rewriteOutsideCode(body, fn) {
  const lines = body.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```+|~~~+)/.exec(lines[i]);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      continue;
    }
    if (m) { fence = m[1]; continue; }
    lines[i] = lines[i].split(/(`+[^`]*`+)/).map((part, k) => (k % 2 ? part : fn(part))).join('');
  }
  return lines.join('\n');
}

function render(raw) {
  if (typeof marked === 'undefined') { previewContent.textContent = raw; return; }
  marked.setOptions({ breaks: true, gfm: true });
  const body = stripFrontmatter(raw);
  // OUTSIDE code only — the same reason as the main window (see
  // _rewriteOutsideCode in app.js): bash's `[[ … ]]` looks exactly like a wiki
  // link, and rewriting it inside a fence printed an <a> tag, &quot; and all,
  // into the middle of a shell script.
  const processed = _rewriteOutsideCode(body, seg => seg
    // [[note links]] → clickable span (navigates inside this window)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
      `<span class="note-link" data-note="${target.trim().replace(/"/g, '&quot;')}">${(alias || target).trim()}</span>`)
    .replace(/(!)\[([^\]]*)\]\(([^)]+)\)\{width=(\d+)\}/g,
      (_, bang, alt, url, w) => `<img src="${url}" alt="${alt}" width="${w}" style="width:${w}px;height:auto">`)
    .replace(/==([^=\n]+?)==/g, '<mark class="md-highlight">$1</mark>'));
  // Sanitize before inserting: no script/handler in a note can run (anti-XSS).
  const _rawHtml = marked.parse(processed).replace(/(src=")attachments\//g, '$1inkwell://attachments/');
  previewContent.innerHTML = (typeof DOMPurify !== 'undefined')
    ? DOMPurify.sanitize(_rawHtml, {
        ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|inkwell|blob|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
        FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
      })
    : '';
  if (typeof hljs !== 'undefined') {
    previewContent.querySelectorAll('pre code').forEach(el => {
      if ([...el.classList].some(c => c.startsWith('language-'))) hljs.highlightElement(el);
    });
  }
  // [[wiki-link]] → open the target note in THIS window.
  previewContent.querySelectorAll('.note-link').forEach(span => {
    const node = resolveNote(span.dataset.note || span.textContent || '');
    if (node) {
      span.style.cssText = 'color:#5b8def;border-bottom:1px dashed rgba(91,141,239,0.55);cursor:pointer';
      span.addEventListener('click', () => loadNote(node.path, node.name));
    }
  });
  // External links (http, https, www, mailto) → default browser, never
  // navigate this window away from the note.
  previewContent.querySelectorAll('a').forEach(a => {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    const isWeb = /^https?:\/\//i.test(href) || /^www\./i.test(href) || /^mailto:/i.test(href);
    a.addEventListener('click', e => {
      e.preventDefault();
      if (isWeb) window.inkwell.openExternal(href).catch(() => {});
    });
  });
  // AUDIO and VIDEO attachment links → inline players (same as the main
  // preview; no resize handle here, the {width=N} is honored read-only).
  previewContent.querySelectorAll('a[href^="inkwell://attachments/"], a[href^="attachments/"]').forEach(a => {
    const href = a.getAttribute('href') || '';
    let clean = href;
    try { clean = decodeURIComponent(href); } catch (_) {}
    const isAudio = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|wma|mka|weba)$/i.test(clean);
    const isVideo = /\.(mp4|webm|mkv|mov|m4v|avi|wmv|mpg|mpeg|flv)$/i.test(clean);
    if (!isAudio && !isVideo) return;
    // Optional {width=N} after the link (written by the main editor's handle).
    let width = 0;
    const sib = a.nextSibling;
    if (sib && sib.nodeType === Node.TEXT_NODE) {
      const m = sib.nodeValue.match(/^\{width=(\d+)\}/);
      if (m) { width = parseInt(m[1], 10); sib.nodeValue = sib.nodeValue.slice(m[0].length); }
    }
    const wrap = document.createElement('div');
    wrap.className = 'media-embed';
    const label = document.createElement('div');
    label.className = 'media-label';
    label.textContent = (isAudio ? '🎵 ' : '🎬 ') + clean.split('/').pop();
    const el = document.createElement(isAudio ? 'audio' : 'video');
    el.controls = true;
    el.preload = 'metadata';
    const relMedia = clean.startsWith('inkwell://attachments/') ? clean.slice('inkwell://attachments/'.length) : clean.replace(/^attachments\//, '');
    // Chromium's own file loader when it can read the file, the media server only for
    // an attachment that is encrypted at rest (see _mediaPlaybackUrl in app.js — this
    // window loads its own scripts and shares nothing with it).
    (async () => {
      let u = null;
      try { u = await window.inkwell.attachmentLocalUrl(relMedia); } catch (_) {}
      if (!u) { try { const b = await window.inkwell.mediaBaseUrl(); if (b) u = b + encodeURIComponent(relMedia); } catch (_) {} }
      el.src = u || href;
    })();
    if (isVideo && width) el.style.width = width + 'px';
    el.addEventListener('error', () => {
      // One silent retry first — transient load errors self-heal.
      if (!el.dataset.retried) {
        el.dataset.retried = '1';
        setTimeout(() => { try { el.load(); } catch (_) {} }, 500);
        return;
      }
      const fb = document.createElement('div');
      fb.className = 'media-fallback';
      const msg = document.createElement('span');
      msg.textContent = '⚠️ Formato non riproducibile nell\'app [err ' + (el.error?.code ?? '?') + ']';
      const btn = document.createElement('button');
      btn.textContent = 'Apri col player di sistema';
      btn.addEventListener('click', () => window.inkwell.openAttachmentFile?.(relMedia).catch(() => {}));
      fb.append(msg, btn);
      el.replaceWith(fb);
    });
    wrap.append(label, el);
    a.replaceWith(wrap);
  });
  // Re-apply an open search: this render just replaced the marked content.
  try {
    if (_sBar && _sBar.style.display === 'flex' && _sInput.value) _applySearch();
  } catch (_) {}
}

// ── "Vai a" hint near the pointer when hovering a link (like the main view) ───
const _linkHint = document.createElement('div');
_linkHint.id = 'link-hover-hint';
_linkHint.style.cssText = 'position:fixed;left:0;top:0;display:none;z-index:3300;max-width:60vw;padding:5px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;box-shadow:0 4px 14px rgba(0,0,0,.4);font-family:var(--ui-font);font-size:12px;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none';
document.body.appendChild(_linkHint);
const _hintTargetOf = (el) => {
  if (!el) return '';
  if (el.classList.contains('note-link')) return el.dataset.note || el.textContent || '';
  const href = (el.getAttribute('href') || '').trim();
  // Internal attachment URLs read ugly — show the clean vault-relative path.
  let h = href;
  try { h = decodeURIComponent(h); } catch (_) {}
  if (h.startsWith('inkwell://attachments/')) return 'attachments/' + h.slice('inkwell://attachments/'.length);
  if (h.startsWith('attachments/')) return h;
  return href;
};
const _placeHint = (e) => {
  const PAD = 8, OX = 14, OY = 20;
  const r = _linkHint.getBoundingClientRect();
  let x = e.clientX + OX, y = e.clientY + OY;
  if (x + r.width + PAD > window.innerWidth)  x = e.clientX - r.width - OX;
  if (y + r.height + PAD > window.innerHeight) y = e.clientY - r.height - 10;
  _linkHint.style.left = Math.max(PAD, x) + 'px';
  _linkHint.style.top  = Math.max(PAD, y) + 'px';
};
previewContent.addEventListener('mouseover', e => {
  const el = e.target.closest && e.target.closest('a, .note-link');
  if (!el || !previewContent.contains(el)) return;
  const dest = _hintTargetOf(el);
  if (!dest) { _linkHint.style.display = 'none'; return; }
  _linkHint.textContent = 'Vai a → ' + dest;
  _linkHint.style.display = 'block';
  _placeHint(e);
});
previewContent.addEventListener('mousemove', e => {
  if (_linkHint.style.display === 'none') return;
  const el = e.target.closest && e.target.closest('a, .note-link');
  if (el && previewContent.contains(el)) _placeHint(e);
  else _linkHint.style.display = 'none';
});
previewContent.addEventListener('mouseout', e => {
  const el = e.target.closest && e.target.closest('a, .note-link');
  if (!el) return;
  const to = e.relatedTarget;
  if (to && el.contains(to)) return;
  _linkHint.style.display = 'none';
});

let _lastRaw = null;
async function refresh() {
  if (!currentPath) return;
  // Never clobber the textarea while the user is editing here.
  if (_mode === 'edit') return;
  try {
    const raw = await window.inkwell.readNote(currentPath);
    if (raw == null) return;
    if (raw !== _lastRaw) { _lastRaw = raw; render(raw); }
  } catch (_) { /* file may be mid-write; retry next tick */ }
}

// ── Edit/view toggle ──────────────────────────────────────────────────────────
const _EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
const _VIEW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
let _mode = 'view';
let _saveTimer = null;
const modeBtn = document.getElementById('det-mode');
const editorEl = document.getElementById('det-editor');
const previewPane = document.getElementById('preview-pane');

function updateModeBtn() {
  if (!modeBtn) return;
  const goingToEdit = (_mode === 'view');
  modeBtn.innerHTML = goingToEdit ? _EDIT_ICON : _VIEW_ICON;
  modeBtn.title = goingToEdit ? 'Modifica' : 'Anteprima';
}

function setMode(mode) {
  _mode = (mode === 'edit') ? 'edit' : 'view';
  const toolbar = document.getElementById('det-toolbar');
  if (_mode === 'edit') {
    editorEl.value = _lastRaw != null ? _lastRaw : '';
    previewPane.style.display = 'none';
    editorEl.style.display = 'block';
    if (toolbar) toolbar.style.display = 'flex';
    editorEl.focus();
  } else {
    // Render what's in the textarea (freshest content, saved or pending).
    _lastRaw = editorEl.value;
    render(_lastRaw);
    editorEl.style.display = 'none';
    if (toolbar) toolbar.style.display = 'none';
    previewPane.style.display = 'block';
  }
  updateModeBtn();
  // An open search must survive the mode switch (different match mechanics).
  try {
    if (_sBar && _sBar.style.display === 'flex' && _sInput.value) _applySearch();
  } catch (_) {}
}

// ── Formatting toolbar (edit mode) ────────────────────────────────────────────
// Same behaviour as the main editor's toolbar, self-contained on #det-editor.
// execCommand keeps native undo working and fires a real 'input' (→ autosave).
function _dInsert(text, s, e) {
  editorEl.focus();
  editorEl.setSelectionRange(s, e);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (_) {}
  if (!ok) { editorEl.setRangeText(text, s, e, 'end'); editorEl.dispatchEvent(new Event('input')); }
}
function _dWrap(prefix, suffix, placeholder) {
  const s = editorEl.selectionStart, e = editorEl.selectionEnd;
  const sel = editorEl.value.slice(s, e) || placeholder;
  _dInsert(prefix + sel + suffix, s, e);
  if (!editorEl.value.slice(s, e)) {
    const caret = s + prefix.length + sel.length;
    editorEl.setSelectionRange(caret, caret);
  }
}
function _dLineStart() {
  const s = editorEl.selectionStart;
  return editorEl.value.lastIndexOf('\n', s - 1) + 1;
}
function _dCmd(cmd) {
  const v = editorEl.value;
  const s = editorEl.selectionStart, e = editorEl.selectionEnd;
  switch (cmd) {
    case 'heading': {
      // Cycle # → ## → ### → none on the current line.
      const ls = _dLineStart();
      const m = v.slice(ls).match(/^(#{1,6})\s/);
      const lvl = m ? m[1].length : 0;
      const next = lvl >= 3 ? '' : '#'.repeat(lvl + 1) + ' ';
      _dInsert(next, ls, ls + (m ? m[0].length : 0));
      break;
    }
    case 'bullet': {
      const ls = _dLineStart();
      if (/^- /.test(v.slice(ls))) _dInsert('', ls, ls + 2);
      else _dInsert('- ', ls, ls);
      break;
    }
    case 'checklist': {
      const ls = _dLineStart();
      if (/^- \[[ x]\] /i.test(v.slice(ls))) _dInsert('', ls, ls + 6);
      else _dInsert('- [ ] ', ls, ls);
      break;
    }
    case 'bold':   _dWrap('**', '**', 'bold text'); break;
    case 'italic': _dWrap('*', '*', 'italic text'); break;
    case 'code': {
      const sel = v.slice(s, e);
      if (sel && !sel.includes('\n')) { _dInsert('`' + sel + '`', s, e); break; }
      _dInsert('```\n' + sel + '\n```', s, e);
      const caret = s + 4 + sel.length;
      editorEl.setSelectionRange(caret, caret);
      break;
    }
    case 'table':
      _dInsert('\n| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n|  |  |  |\n', s, e);
      break;
    case 'link': _dWrap('[[', ']]', ''); break;
  }
}
document.querySelectorAll('#det-toolbar button').forEach(btn => {
  // Keep the editor focused (and the selection intact) through the click.
  btn.addEventListener('mousedown', ev => ev.preventDefault());
  btn.addEventListener('click', () => _dCmd(btn.dataset.dcmd));
});

if (modeBtn) {
  modeBtn.addEventListener('click', () => setMode(_mode === 'view' ? 'edit' : 'view'));
  updateModeBtn();
}

// Edits write back to the note (debounced). Capture path AND value at
// schedule time so a late timer can never cross-write after navigation.
if (editorEl) {
  editorEl.addEventListener('input', () => {
    clearTimeout(_saveTimer);
    const p = currentPath;
    const v = editorEl.value;
    _saveTimer = setTimeout(() => {
      window.inkwell.writeNote(p, v).then(() => { if (currentPath === p) _lastRaw = v; }).catch(() => {});
    }, 450);
  });
}

// ── In-note search (Ctrl+F) ───────────────────────────────────────────────────
// View mode: highlights matches in the rendered preview (<mark>) and scrolls
// between them. Edit mode: selects occurrences in the textarea and jumps.
const _sBar = document.getElementById('det-search');
const _sInput = document.getElementById('det-search-input');
const _sCount = document.getElementById('det-search-count');
let _sMarks = [];       // view mode: <mark> elements
let _sHits = [];        // edit mode: [start, end] pairs
let _sIdx = -1;

function _clearMarks() {
  document.querySelectorAll('mark.det-find').forEach(m => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  _sMarks = []; _sHits = []; _sIdx = -1;
  if (_sCount) _sCount.textContent = '';
}

function _applySearch() {
  _clearMarks();
  const q = (_sInput.value || '').trim().toLowerCase();
  if (!q) return;
  if (_mode === 'view') {
    // Wrap every match inside the preview's text nodes.
    const walker = document.createTreeWalker(previewContent, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n; while ((n = walker.nextNode())) nodes.push(n);
    for (const node of nodes) {
      let text = node.nodeValue, idx = text.toLowerCase().indexOf(q), cur = node;
      while (idx !== -1) {
        const matchNode = cur.splitText(idx);
        const rest = matchNode.splitText(q.length);
        const mark = document.createElement('mark');
        mark.className = 'det-find';
        matchNode.parentNode.replaceChild(mark, matchNode);
        mark.appendChild(matchNode);
        _sMarks.push(mark);
        cur = rest; text = cur.nodeValue; idx = text.toLowerCase().indexOf(q);
      }
    }
    if (_sMarks.length) _gotoMatch(0);
    else _sCount.textContent = '0';
  } else {
    const v = editorEl.value.toLowerCase();
    let i = v.indexOf(q);
    while (i !== -1) { _sHits.push([i, i + q.length]); i = v.indexOf(q, i + q.length); }
    if (_sHits.length) _gotoMatch(0);
    else _sCount.textContent = '0';
  }
}

function _gotoMatch(i) {
  const total = (_mode === 'view') ? _sMarks.length : _sHits.length;
  if (!total) return;
  _sIdx = ((i % total) + total) % total;
  if (_mode === 'view') {
    _sMarks.forEach(m => m.classList.remove('current'));
    const m = _sMarks[_sIdx];
    m.classList.add('current');
    m.scrollIntoView({ block: 'center' });
  } else {
    const [s, e] = _sHits[_sIdx];
    editorEl.focus();
    editorEl.setSelectionRange(s, e);
    // Scroll the match roughly to the middle (textarea has no scrollIntoView).
    const cs = getComputedStyle(editorEl);
    const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 15) * 1.7;
    const line = editorEl.value.slice(0, s).split('\n').length - 1;
    editorEl.scrollTop = Math.max(0, line * lh - editorEl.clientHeight / 2);
  }
  _sCount.textContent = `${_sIdx + 1}/${total}`;
}

function openSearch() {
  _sBar.style.display = 'flex';
  _sInput.focus();
  _sInput.select();
  if (_sInput.value) _applySearch();
}
function closeSearch() {
  _sBar.style.display = 'none';
  _clearMarks();
}

document.getElementById('det-search-btn')?.addEventListener('click', () =>
  _sBar.style.display === 'flex' ? closeSearch() : openSearch());
document.getElementById('det-search-close')?.addEventListener('click', closeSearch);
document.getElementById('det-search-prev')?.addEventListener('click', () => _gotoMatch(_sIdx - 1));
document.getElementById('det-search-next')?.addEventListener('click', () => _gotoMatch(_sIdx + 1));
_sInput?.addEventListener('input', _applySearch);
_sInput?.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); _gotoMatch(e.shiftKey ? _sIdx - 1 : _sIdx + 1); }
  if (e.key === 'Escape') closeSearch();
});
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  else if (e.key === 'Escape' && _sBar.style.display === 'flex') closeSearch();
});

(async () => {
  await loadMarked();
  await loadNoteIndex();   // for [[wiki-link]] resolution and prev/next arrows
  updateNavButtons();
  await refresh();
  // Poll so edits made in the main window show up here too.
  setInterval(refresh, 1500);
})();
