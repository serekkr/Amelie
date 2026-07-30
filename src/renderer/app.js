/* ═══════════════════════════════════════════════════════════════
   K7TZ NOTES — Renderer process
═══════════════════════════════════════════════════════════════ */

// Global safety net: surface (instead of silently swallowing) an escaped error
// or rejected promise — e.g. a failed autosave that would otherwise vanish. Log
// everything; show the user a toast at most once every 5s so a real problem is
// visible without spamming on noisy third-party rejections.
let _lastErrToastAt = 0;
function _reportGlobalError(label, detail) {
  console.error(label, detail);
  const now = (window.performance ? performance.now() : 0);
  if (now - _lastErrToastAt < 5000) return;
  _lastErrToastAt = now;
  try { if (typeof showToast === 'function') showToast(window.i18n.t('toast.unexpected_error')); } catch (_) {}
}
window.addEventListener('unhandledrejection', (e) => _reportGlobalError('[renderer] Unhandled rejection:', e.reason));
window.addEventListener('error', (e) => _reportGlobalError('[renderer] Uncaught error:', e.error || e.message));

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  notes: [],
  currentPath: null,   // active tab path
  viewMode: 'edit',
  saveTimer: null,
  config: {},
  contextTarget: null,
  searchQuery: '',
  theme: 'navy',
  // Persisted across sessions so folders stay expanded after reopening the app.
  openFolders: new Set((() => { try { return JSON.parse(localStorage.getItem('amelie.openFolders') || '[]'); } catch (_) { return []; } })()),
  selectedFolder: null,
  draggingNote: false,
  draggingFolder: false,
  draggingAttach: false,   // dragging a pdf/image node (reorder-only, never moves on disk)
};

// Persist which folders are expanded, so the sidebar reopens in the same state.
function persistOpenFolders() {
  try { localStorage.setItem('amelie.openFolders', JSON.stringify([...state.openFolders])); } catch (_) {}
}

// Sticky view mode: once the user flips the Edit/View toggle, that choice is
// remembered and applied to EVERY note they open next — and across restarts —
// so switching to preview stays in preview as you click through notes. Set only
// by the explicit user toggle (toggleViewMode); programmatic setViewMode calls
// don't change it. Special tabs (pdf/mindmap/canvas) return early and ignore it.
let _stickyViewMode = (() => { try { return localStorage.getItem('amelie.viewMode') === 'view' ? 'view' : 'edit'; } catch (_) { return 'edit'; } })();
function setStickyViewMode(m) {
  _stickyViewMode = (m === 'view') ? 'view' : 'edit';
  try { localStorage.setItem('amelie.viewMode', _stickyViewMode); } catch (_) {}
}
// The single user-facing Edit⇄View flip: remember the new mode globally, then apply.
function toggleViewMode() {
  const next = state.viewMode === 'edit' ? 'view' : 'edit';
  setStickyViewMode(next);
  setViewMode(next, { preserveScroll: true });
}

// ─── Tab system ───────────────────────────────────────────────────────────────
// Each tab: { path, name, content, isDirty, viewMode, scrollPos, cursorPos }
const tabs = [];
let activeTabIdx = -1;
let _tabDragFrom = -1;   // index of the tab being dragged (reorder), -1 if none

function getTab(path) { return tabs.find(t => t.path === path); }
function getActiveTab() { return tabs[activeTabIdx] ?? null; }

// Reorder: move the tab at `from` so it lands at index `to` (insertion point
// in the ORIGINAL array). Keeps the same tab active after the move.
function moveTab(from, to) {
  if (from < 0 || from >= tabs.length) return;
  if (to < 0) to = 0;
  if (to > tabs.length) to = tabs.length;
  const activePath = getActiveTab()?.path ?? null;
  const [moved] = tabs.splice(from, 1);
  // Removing the item shifts everything after it left by one.
  if (to > from) to -= 1;
  tabs.splice(to, 0, moved);
  // Restore the active index by path (it may have shifted).
  if (activePath != null) {
    const idx = tabs.findIndex(t => t.path === activePath);
    if (idx !== -1) activeTabIdx = idx;
  }
  renderTabBar();
}

// A hidden <audio>/<video> keeps playing, so leaving the player must stop it —
// otherwise sound comes out of a note you are quietly typing in. Skipped when the
// tab being switched TO is the very file already loaded: switchTab also fires on
// spurious re-opens (a sync refresh), which must not pause what you are listening to.
function pauseMediaViewUnlessActive() {
  const t = typeof tabs !== 'undefined' ? tabs[activeTabIdx] : null;
  for (const id of ['audio-view-content', 'video-view-content']) {
    const el = $(id);
    if (!el || !el.src || el.paused) continue;
    const stillOn = t && (t.type === 'audio' || t.type === 'video')
      && el.dataset.loaded === t.attachmentName;
    if (!stillOn) { try { el.pause(); } catch (_) {} }
  }
}

// Hide ALL special full-screen views (mindmap / canvas / pdf / todo) and clear
// their toolbar-active state. Central helper so every view-switch is consistent:
// whichever view you open next first calls this, guaranteeing the others are
// dismissed. Does NOT touch the editor/empty-state — the caller decides those.
function hideAllSpecialViews() {
  const mm = $('mindmap-overlay'); if (mm) mm.style.display = 'none';
  const cv = $('canvas-overlay');  if (cv) cv.style.display = 'none';
  const pdf = $('pdf-overlay');    if (pdf) pdf.style.display = 'none';
  const iv = $('img-view-overlay'); if (iv) iv.style.display = 'none';
  const mv = $('media-view-overlay'); if (mv) mv.style.display = 'none';
  pauseMediaViewUnlessActive();
  const tv = $('todo-view');       if (tv) tv.style.display = 'none';
  const mmTip = $('mindmap-tooltip'); if (mmTip) mmTip.style.display = 'none';
  const bm = $('btn-mindmap'); if (bm) bm.classList.remove('active');
  const bc = $('btn-canvas');  if (bc) bc.classList.remove('active');
  _kanbanOpen = false;
  // Restore the Files icon: leaving the ToDo board (for mindmap/draw/pdf/note)
  // must drop the "kanban-active" hint so the tab shows the folder icon again,
  // not the ToDo check.
  const vf = $('view-files'); if (vf) vf.classList.remove('kanban-active');
  document.querySelectorAll('.todo-tree-entry.active').forEach(e => e.classList.remove('active'));
}

// `activate` defaults true (normal open = jump to the tab). Session restore passes
// false so tabs are created in the bar WITHOUT loading each note's content/render;
// only the active tab is switched to at the end. Inactive tabs load lazily on click
// (the `!tab.content` guard in switchTab). This keeps startup O(1) render, not O(N).
function openTab(node, activate = true) {
  if (activate) _returnToFilesView();   // a real open (not lazy session-restore) → back to the tree
  // An attachment (PDF, photo, audio, video) needs its own viewer: the tab pushed
  // below is a NOTE tab, and reading a PDF or an MP3 as note text gives a broken
  // tab. Callers that don't know the kind — a click in Bookmarks/Recent, which come
  // in by path — land here, so the routing belongs here rather than in each caller.
  if (isAttachNode(node)) {
    if (node.type === 'pdf') { openPdfFile(node, activate); return; }
    openAttachmentNode(node, activate);
    return;
  }
  // Focus-based routing: with the split pane open and last focused, a click on
  // a note (sidebar tree, recent/bookmarks/tags lists, links) loads it into
  // the SPLIT pane instead of the main tabs. Only regular .md notes — special
  // views (canvas/pdf/mindmap) always go through the normal tab flow.
  if (_splitPath && _focusedPane === 'split' && node && node.path
      && (!node.type || node.type === 'note') && /\.md$/i.test(node.path)) {
    try { pushRecent(node); } catch(_) {}
    openSplitView(node.path, node.name, _splitOrient);
    return;
  }
  if (node && node.path) try { pushRecent(node); } catch(_) {}
  const existing = tabs.findIndex(t => t.path === node.path);
  if (existing !== -1) { if (activate) switchTab(existing); return; }
  tabs.push({
    path: node.path,
    name: node.name,
    content: '',
    isDirty: false,
    viewMode: 'edit',
    scrollPos: 0,
    cursorPos: 0,
    created: node.created,
    modified: node.modified,
  });
  if (activate) switchTab(tabs.length - 1);
}

async function closeTab(idx, e) {
  if (e) e.stopPropagation();
  const tab = tabs[idx];
  if (tab?.isDirty) {
    if (!await showConfirmModal(`"${tab.name}" ha modifiche non salvate. Chiudere comunque?`)) return;
  }
  const wasActive = (idx === activeTabIdx);
  tabs.splice(idx, 1);
  if (tab?.type === 'pdf') _destroyPdfDoc();   // free pdf.js worker memory (reloaded if a PDF tab is reopened)
  // Closing the player's tab stops it and lets the file go: without clearing `src`
  // the stream stays open and reopening the same file would resume mid-way.
  if (tab?.type === 'audio' || tab?.type === 'video') {
    const el = $(tab.type === 'audio' ? 'audio-view-content' : 'video-view-content');
    if (el) { try { el.pause(); } catch (_) {} el.removeAttribute('src'); el.dataset.loaded = ''; try { el.load(); } catch (_) {} }
  }
  if (tabs.length === 0) {
    activeTabIdx = -1;
    state.currentPath = null;
    editorContainer.style.display = 'none';
    emptyState.style.display = 'flex';
  } else if (wasActive) {
    // Closed the ACTIVE tab → move to whichever note slid into its slot and load it.
    const newIdx = Math.min(idx, tabs.length - 1);
    switchTab(newIdx);
  } else {
    // Closed a BACKGROUND tab → the active note MUST stay active; only its array
    // index shifted. DATA-LOSS FIX: the old code reselected by slot index
    // (switchTab(min(idx,…))), which — when the closed tab sat BEFORE the active
    // one — swapped in a neighbouring note under the active tab; the 2s autosave
    // then wrote the editor buffer to the wrong/empty path and wiped the note the
    // user was on (observed by deleting a PDF while editing another note). Just
    // adjust the index; never reload the editor here.
    if (activeTabIdx > idx) activeTabIdx--;
  }
  renderTabBar();
}

async function switchTab(idx) {
  // Any popup tied to the previous note (e.g. wiki-link autocomplete) must
  // not survive across notes.
  try { hideLinkPopup(); } catch(_) {}
  // DATA-LOSS GUARD: flush the LIVE CM content into the current tab BEFORE any reload
  // path can fire. Otherwise a re-open of the already-open note (a spurious refresh,
  // or a return where `_cmSameNote` ends up false) hits line "editor.value =
  // tab.content" with a STALE tab.content and wipes unsaved edits — observed as a big
  // fresh paste collapsing back to the note's previous tiny content. The regular
  // save-prev below only runs when switching to a DIFFERENT tab, so it misses the
  // same-tab reopen; this covers both. Safe: writing the current content back to the
  // current tab is a no-op when nothing changed.
  // Save into the tab CM ACTUALLY has loaded (matched by _cmLoadedPath) — NOT
  // getActiveTab(). openNote repoints the active tab IN-PLACE (same index) BEFORE
  // calling switchTab, so getActiveTab() may already point at the NEW note; writing the
  // old live content into it would clobber the new tab's empty content, and line 288
  // would then skip the disk read → the new note shows the PREVIOUS note's text. When
  // _cmLoadedPath doesn't match any tab (e.g. right after the repoint, or a fresh
  // session-restore with no path yet) there's nothing safe to flush into, so skip.
  if (_cmActive && _cmHandle && _cmLoadedPath) { try { const live = editor.value; if (live && live.length) { const cmTab = tabs.find(t => t && !t.type && t.path === _cmLoadedPath); if (cmTab) cmTab.content = live; } } catch (_) {} }
  // Save current tab state only when switching away to a different tab
  if (idx !== activeTabIdx) {
    const prev = getActiveTab();
    if (prev) {
      prev.content = editor.value;
      prev.scrollPos = editor.scrollTop;
      prev.cursorPos = editor.selectionStart;
      prev.viewMode = state.viewMode;
      // Keep duplicate tabs of the SAME note in sync: "open in new tab" lets
      // the user keep one tab in edit and another in view — when switching
      // away, the freshest content follows into every twin tab (each keeps
      // its own viewMode/scroll/cursor).
      if (prev.path) {
        for (const t of tabs) {
          if (t !== prev && t.path === prev.path && !t.type) {
            t.content = prev.content;
            t.isDirty = prev.isDirty;
          }
        }
      }
    }
  }

  activeTabIdx = idx;
  const tab = tabs[idx];
  if (!tab) return;

  // Close the TOC/index when this navigation leaves the note it was built for —
  // a different note, or any special view (mindmap/draw/pdf). A same-note
  // refresh (sync, spurious re-open) keeps it: tab.path still matches _tocPath.
  if (tocVisible && (tab.type || tab.path !== _tocPath)) closeTOC();

  // CM engine: is this a reload of the note CM ALREADY has loaded (same path)?
  // Then it's a spurious re-open (sync/refresh) — we must NOT reset value/cursor/
  // scroll, which would yank the caret and (with stale content) wipe edits. CM
  // keeps its state; we only refresh the peripheral UI below.
  const _cmSameNote = _cmActive && tab.path && tab.path === _cmLoadedPath && !tab.type;
  if (_cmActive && tab.path && !tab.type) _cmLoadedPath = tab.path;

  // Clickable path breadcrumb under the title (hidden for special tabs).
  try { renderBreadcrumb(tab); } catch (_) {}

  // Always reset every special view (mindmap / canvas / pdf / todo) so the new
  // tab starts from a clean slate, no matter which view we were in before.
  hideAllSpecialViews();

  // Special tab: mindmap
  if (tab.type === 'mindmap') {
    emptyState.style.display = 'none';
    editorContainer.style.display = 'none';
    $('mindmap-overlay').style.display = 'flex';
    $('btn-mindmap').classList.add('active');
    renderTabBar();
    // Resize the canvas FIRST so layoutMindmap reads the correct dimensions.
    resizeMindmapCanvas();
    buildMindmapData().then(() => {
      // Re-resize + re-layout: at the time the mindmap-overlay was made
      // visible the browser hadn't finished its layout pass yet, so the
      // canvas may have been 0px during the first sizing. Doing it again
      // here (after the data is ready and the overlay is visible) ensures
      // the notes are spread across the full viewport, not crammed in a
      // tiny circle from a stale canvas size.
      resizeMindmapCanvas();
      layoutMindmap();    // seed + headless pre-warm, so the entry framing is right
      fitMindmapView();   // fit the WHOLE graph in view on entry (nothing cut off at the edges)
      // Then let the live simulation take over warm: the graph visibly breathes
      // into its final shape, the way Obsidian's does when you open it.
      kickMindmap(0.45);
    });
    return;
  }
  // Special tab: canvas (draw file)
  if (tab.type === 'canvas') {
    emptyState.style.display = 'none';
    editorContainer.style.display = 'none';
    // Lazy-load Excalidraw: the canvas iframe (canvas.html + excalidraw-bundle.js)
    // is NOT loaded at startup — only the first time a drawing is opened. Saves
    // that RAM/parse for users who never draw. CANVAS_READY then auto-sends the draw.
    { const _f = $('canvas-iframe'); if (_f && !_f.getAttribute('src')) _f.setAttribute('src', 'canvas.html'); }
    $('canvas-overlay').style.display = 'flex';
    $('btn-canvas').classList.add('active');
    $('canvas-title').textContent = tab.name || 'Draw';
    activeCanvasPath = tab.path;
    _liveCanvasJson = null;   // new drawing on screen → drop the previous live snapshot
    state.currentPath = tab.path;
    if (canvasIframeReady && tab.path) _sendDrawToIframe(tab.path);
    renderTabBar();
    renderTree();
    return;
  }
  // Special tab: the ToDo board
  if (tab.type === 'todo') {
    state.currentPath = null;
    showTodoView();
    renderTabBar();
    renderTree();
    return;
  }
  // Special tab: PDF viewer
  if (tab.type === 'pdf') {
    emptyState.style.display = 'none';
    editorContainer.style.display = 'none';
    $('pdf-overlay').style.display = 'flex';
    $('pdf-title').textContent = tab.name || 'PDF';
    state.currentPath = tab.path || null;
    const embed = $('pdf-embed');
    // Returning to a PDF that still holds UNSAVED edits must NOT show them — you
    // never saved them. Two cases, so it's instant instead of a slow full reload:
    //   • pen/text/image edits are OVERLAYS on top of the page images → just wipe
    //     the overlays + reset the annot state. No page re-render at all (this is
    //     why the edits used to linger ~2s: renderPdfPages kept the old pages up
    //     while it slowly re-rendered). Instant, no flash.
    //   • form-field / page-op edits change the document itself → a clean reload
    //     from disk is required; wipe overlays first so nothing stale flashes.
    const _samePdf = _pdfAttName === tab.attachmentName;
    const _annotOnlyDirty = _samePdf && _pdfDirty && !_pdfFormDirty && !_pdfPagesDirty;
    const _deepDirty      = _samePdf && (_pdfFormDirty || _pdfPagesDirty);
    if (tab.attachmentName && embed.dataset.loaded !== tab.attachmentName) {
      embed.dataset.loaded = tab.attachmentName;
      renderPdfPages(tab.attachmentName, embed);          // different PDF → full render
    } else if (_deepDirty) {
      try { _clearPdfOverlays(); } catch (_) {}           // no stale flash while it reloads
      renderPdfPages(tab.attachmentName, embed);          // form/page edits → clean reload
    } else if (_annotOnlyDirty) {
      try { _clearPdfOverlays(); } catch (_) {}           // instantly drop the drawn edits
      _pdfAnnots = []; _pdfDirty = false; setPdfTool(null);
      try { _updatePdfDirty(); } catch (_) {}
    }
    renderTabBar();
    renderTree();
    return;
  }
  // Special tab: image viewer (photos dropped on the sidebar)
  if (tab.type === 'image') {
    emptyState.style.display = 'none';
    editorContainer.style.display = 'none';
    $('img-view-overlay').style.display = 'flex';
    $('img-view-title').textContent = tab.name || 'Image';
    state.currentPath = tab.path || null;
    const img = $('img-view-content');
    if (img && tab.attachmentName && img.dataset.loaded !== tab.attachmentName) {
      img.dataset.loaded = tab.attachmentName;
      img.removeAttribute('style');
      _imgZoom = 1.0; _updateImgZoomLabel();
      img.src = 'inkwell://attachments/' + tab.attachmentName.split('/').map(encodeURIComponent).join('/');
    }
    renderTabBar();
    renderTree();
    return;
  }
  // Special tab: audio / video player (files in the vault, not note embeds)
  if (tab.type === 'audio' || tab.type === 'video') {
    emptyState.style.display = 'none';
    editorContainer.style.display = 'none';
    $('media-view-overlay').style.display = 'flex';
    $('media-view-title').textContent = tab.name || 'Media';
    state.currentPath = tab.path || null;
    const el    = $(tab.type === 'audio' ? 'audio-view-content' : 'video-view-content');
    const other = $(tab.type === 'audio' ? 'video-view-content' : 'audio-view-content');
    if (other) { other.style.display = 'none'; }
    if (el) {
      el.style.display = '';
      // Only (re)load on a DIFFERENT file: coming back to the tab must keep the
      // position you were at, not restart from zero.
      if (tab.attachmentName && el.dataset.loaded !== tab.attachmentName) {
        el.dataset.loaded = tab.attachmentName;
        el.src = 'inkwell://attachments/' + tab.attachmentName.split('/').map(encodeURIComponent).join('/');
      }
    }
    renderTabBar();
    renderTree();
    return;
  }

  // Show editor immediately — before async IPC — so it's never stuck hidden
  state.currentPath = tab.path;
  state.viewMode = _stickyViewMode;   // sticky: every note follows the last Edit/View choice
  noteTitle.value = tab.name;
  if (!_cmSameNote) editor.value = tab.content || '';
  try { closeKanban(); } catch(_) {}
  document.querySelectorAll('.todo-tree-entry.active').forEach(e => e.classList.remove('active'));
  emptyState.style.display = 'none';
  editorContainer.style.display = 'flex';

  // Load content if not yet cached
  if (!tab.content && tab.path) {
    tab.content = await window.inkwell.readNote(tab.path).catch(() => '');
    editor.value = tab.content;
    applyEditorHighlight();
  }

  applyEditorHighlight();
  if (!_cmSameNote) editor.scrollTop = tab.scrollPos || 0;

  updateNoteMeta(tab);
  try { updatePreview(); } catch(_) {}
  updateWordCount();
  statusPath.textContent = tab.path;
  setSavedState(!tab.isDirty);
  try { setViewMode(state.viewMode); } catch(_) {}
  loadFrontmatterPanel(tab);
  updateMetaRows(state.viewMode === 'edit');
  if (tocVisible) try { renderTOC(); } catch(_) {}

  // Restore cursor after render. Do NOT steal keyboard focus (and with it the
  // header title, via the focusin tracker) when the user is working in the
  // split pane and this switchTab came from a programmatic refresh.
  requestAnimationFrame(() => {
    if (state.viewMode === 'edit' && !(_splitPath && _focusedPane === 'split') && !_cmSameNote) {
      editor.focus();
      try { editor.setSelectionRange(tab.cursorPos || 0, tab.cursorPos || 0); } catch(_) {}
    }
    try { refreshAttachmentChips(); } catch(_) {}
    // Recompute the code-block backgrounds/copy buttons NOW that layout is ready:
    // on the first render the line height could still be wrong, leaving the code
    // box misaligned (higher than the text).
    decorateEditorCodeBlocks();
  });

  applyEditorHighlight();
  // Each tab shows its OWN split (or none): a tab that never split comes up whole, and the
  // one that did gets its pane back. Done after the content is in the editor, so the pane
  // seeds from the right note.
  try { _applyTabSplit(tab); } catch (_) {}
  renderTabBar();
  renderTree();
  // switchTab can fire programmatically (sync refresh, session restore…)
  // while the SPLIT pane owns the header title: re-assert the focused pane's
  // title so the bare `noteTitle.value = tab.name` above can't clobber it.
  try { updateTitleForFocus(); } catch (_) {}
}

// Bring the split pane in line with the tab being shown.
// Each tab carries its own split (or none). Called from switchTab, and from the paths that
// change which note the tab shows — the pane is pinned to the TAB, so it stays put while the
// main half moves from note to note.
function _applyTabSplit(tab) {
  const want = tab && tab.split && tab.split.path ? tab.split : null;
  const paneB = $('editor-pane-b');
  const paneOpen = !!paneB && paneB.style.display !== 'none';
  // Store the size the open pane is at, so a tab you come back to reopens with the divider
  // where you left it instead of back at the middle.
  if (paneOpen && paneB) {
    const live = paneB.style.flexBasis || (paneB.style.flex || '').split(' ').pop();
    if (live && live !== '0%' && live !== 'auto') _splitBasis = live;
    const host = tabs.find(t => t && t.split && t.split.path === _splitPath);
    if (host && host.split) host.split.basis = _splitBasis;
  }
  if (want) {
    _splitBasis = want.basis || _splitBasis;
    if (_splitPath !== want.path || !paneOpen) openSplitView(want.path, want.name, want.orient);
    return;
  }
  // This tab has no split. Close the pane WITHOUT forgetting anything: closeSplitView()
  // clears the ACTIVE tab's record, which is right when the user closes it themselves.
  if (_splitPath || paneOpen) {
    const keep = tab && tab.split;
    closeSplitView();
    if (keep && tab) tab.split = keep;
  }
}

function renderTabBar() {
  saveSession();
  const list = $('tab-list');
  list.innerHTML = '';
  tabs.forEach((tab, i) => {
    const el = document.createElement('div');
    el.className = 'note-tab' + (i === activeTabIdx ? ' active' : '') + (tab.isDirty ? ' unsaved' : '');
    // Pathless special tabs (e.g. the graph) must not tooltip "null".
    el.title = tab.path || tab.name
      || (tab.type === 'mindmap' ? window.i18n.t('tab.graph') : '');

    const name = document.createElement('span');
    name.className = 'tab-name';
    if (tab.type === 'mindmap') {
      // Inline SVG hexagon (not the ⬡ glyph: it renders via a taller fallback
      // font, inflating the line box — the label visibly jumped vs other tabs).
      name.innerHTML = `<svg style="width:12px;height:12px;vertical-align:middle;margin-right:4px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 2.5l8 4.6v9.8l-8 4.6-8-4.6V7.1z"/></svg>${escHtml(window.i18n.t('tab.graph'))}`;
    } else if (tab.type === 'canvas') {
      name.innerHTML = `<svg style="width:12px;height:12px;vertical-align:middle;margin-right:4px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3.5a2.121 2.121 0 0 1 3 3L7 18l-4 1 1-4L15.5 3.5z"/><path d="M13 6l3 3"/></svg>${escHtml(tab.name || 'Draw')}.draw`;
    } else {
      name.textContent = tab.name;
    }
    el.appendChild(name);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.innerHTML = '✕';
    close.title = window.i18n.t('toolbar.close_tab');
    close.addEventListener('click', e => closeTab(i, e));
    el.appendChild(close);

    el.addEventListener('click', () => switchTab(i));
    // Middle click to close
    el.addEventListener('mousedown', e => { if (e.button === 1) { e.preventDefault(); closeTab(i); } });
    // Right click → tab context menu (split view / close)
    el.addEventListener('contextmenu', e => showTabContextMenu(e, i));

    // ── Drag to reorder tabs ──────────────────────────────────────────────────
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', e => {
      _tabDragFrom = i;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(i)); } catch(_) {}
      el.classList.add('tab-dragging');
    });
    el.addEventListener('dragend', () => {
      _tabDragFrom = -1;
      el.classList.remove('tab-dragging');
      list.querySelectorAll('.note-tab').forEach(t => t.classList.remove('tab-drop-before', 'tab-drop-after'));
    });
    el.addEventListener('dragover', e => {
      if (_tabDragFrom < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      el.classList.toggle('tab-drop-before', before);
      el.classList.toggle('tab-drop-after', !before);
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('tab-drop-before', 'tab-drop-after');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('tab-drop-before', 'tab-drop-after');
      if (_tabDragFrom < 0 || _tabDragFrom === i) return;
      const rect = el.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      let target = before ? i : i + 1;
      moveTab(_tabDragFrom, target);
    });

    list.appendChild(el);
  });
  // Scroll active tab into view
  const activeEl = list.children[activeTabIdx];
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // Split-focused label survives tab-bar re-renders.
  try { _mirrorActiveTabLabel(); } catch (_) {}
}

// Active in-note search highlight (rendered into #editor-highlight overlay)
let _searchHL = { query: '', currentPos: -1 };

function _escHL(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function _highlightSearchInLine(line, q, basePos, currentPos) {
  if (!q) return _escHL(line);
  const ql = q.toLowerCase();
  const ll = line.toLowerCase();
  let out = '';
  let i = 0;
  while (i < line.length) {
    const idx = ll.indexOf(ql, i);
    if (idx === -1) { out += _escHL(line.substring(i)); break; }
    if (idx > i) out += _escHL(line.substring(i, idx));
    const matchText = line.substring(idx, idx + q.length);
    const isCur = (basePos + idx) === currentPos;
    out += `<span class="search-match${isCur ? ' current' : ''}">${_escHL(matchText)}</span>`;
    i = idx + q.length;
  }
  return out;
}

// Wrap ==text== spans (markdown highlight) in <span class="md-hl"> so the
// editor overlay paints them with a yellow background just like the preview.
function _applyMdHighlight(html) {
  // Inline color span: <span style="color:HEX">text</span> — render the whole
  // matched block (tags + content) in the requested colour so the editor
  // visually reflects the chosen colour while writing.
  let out = html.replace(
    /&lt;span style="color:([^"]+)"&gt;[\s\S]*?&lt;\/span&gt;/g,
    (match, color) => `<span style="color:${color}">${match}</span>`
  );
  // ==highlight==
  out = out.replace(/==([^=\n]+?)==/g, '<span class="md-hl">==$1==</span>');
  // Wiki-links [[note]] (with optional |alias)
  out = out.replace(/\[\[([^\]|\n]+(?:\|[^\]\n]+)?)\]\]/g,
    '<span class="hl-link">[[$1]]</span>');
  // Markdown link [text](url)
  out = out.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g,
    '<span class="hl-link">[$1]($2)</span>');
  // Attachment link [📎 name](inkwell://…): refine the generic link span just
  // produced — the ugly internal URL fades to near-invisible, only the label
  // stays readable. Operating on the EXACT output shape of the rule above
  // avoids any regex cross-matching (color-only spans, wrapping untouched).
  out = out.replace(/<span class="hl-link">\[([^\]\n]+)\]\(inkwell:\/\/([^)\n]+)\)<\/span>/g,
    '<span class="hl-dim">[</span><span class="hl-link">$1</span><span class="hl-dim">](</span><span class="hl-hide">inkwell://</span><span class="hl-link">$2</span><span class="hl-dim">)</span>');
  // Clean relative attachment links: same treatment, nothing to hide.
  out = out.replace(/<span class="hl-link">\[([^\]\n]+)\]\((attachments\/[^)\n]+)\)<\/span>/g,
    '<span class="hl-dim">[</span><span class="hl-link">$1</span><span class="hl-dim">](</span><span class="hl-link">$2</span><span class="hl-dim">)</span>');
  // {width=N} written by the image/video resize handle: it only ever follows a
  // `](url)` link, and every link rule above ends its output with `)</span>` —
  // anchor on that shape so the attribute is painted blue like the link itself.
  out = out.replace(/(\)<\/span>)\{width=(\d+)\}/g,
    '$1<span class="hl-link">{width=$2}</span>');
  // Bare URL (http://, https://, www.)
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi,
    '$1<span class="hl-link">$2</span>');
  return out;
}

// The CodeMirror engine owns rendering entirely, so the legacy textarea-overlay
// pipeline (highlight/masks/gutter/reindent/sync) is skipped — CM does it
// virtualized. CM is now the ONLY editor (always on); the legacy pipeline functions
// remain but are dormant (each early-returns while `_cmActive`).
let _cmActive = false;
// Set while we push content into CM ourselves (graph link edits). CM dispatches
// its update listener synchronously from setValue, and _onCmChange would then
// mark the WRONG tab dirty — getActiveTab() is the graph, not the note.
let _cmSuppressChange = false;
let _cmHandle = null;
let _cmLoadedPath = null;   // note path currently loaded in CM (to detect spurious reloads)
// The editor's file paste/drop handlers (image + attachment import). Assigned in
// setupEditor() on the legacy textarea; _initCmEditor() re-attaches them to CM's
// content DOM (the hidden textarea never receives paste/drop when CM is active).
let _editorPasteHandler = null;
let _editorDropHandler = null;
let _editorDragoverHandler = null;
// Middle-click (X11/Wayland primary-selection) paste blocker — shared so it can be
// re-attached to CM's content DOM too (the hidden textarea never sees the click).
let _middleDownAt = -1e9;
let _editorMiddleDownHandler = null;
let _editorAuxClickHandler = null;
// True when the editing surface has keyboard focus — the legacy textarea OR the CM
// content (whose focused element is a div, not `editor`). Toolbar shortcuts use it.
function editorHasFocus() {
  if (editor === document.activeElement) return true;
  if (_cmActive && _cmHandle) { try { return !!_cmHandle.view.hasFocus; } catch (_) {} }
  return false;
}
function applyEditorHighlight() {
  if (_cmActive) return;
  const overlay = document.getElementById('editor-highlight');
  if (!overlay || !editor) return;
  // Match the overlay's box to the textarea's actual TEXT width. editor.clientWidth
  // excludes the scrollbar, so with the same padding the overlay wraps at the exact
  // same column as the textarea — otherwise typed words appear to jump lines.
  if (editor.clientWidth) overlay.style.width = editor.clientWidth + 'px';
  const lines = editor.value.split('\n');
  const q = _searchHL.query;
  const curPos = _searchHL.currentPos;
  let html = '';
  let charPos = 0;
  let inFence = false; // inside a ``` / ~~~ fenced code block
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFenceMarker = /^\s*(```|~~~)/.test(line);
    // Inside a code block (and on the fence lines themselves) keep the text
    // plain — same look as general text, no link/highlight/heading styling.
    if (inFence || isFenceMarker) {
      const inner = _highlightSearchInLine(line, q, charPos, curPos);
      // Fence lines: the backtick glyphs sit high in their line box; with the
      // editor's airy line-height the empty space below them reads as an extra
      // blank row inside the block. .hl-fence shifts the ink down to the
      // vertical center of the line (--fence-shift, set in decorate) — pure
      // visual offset (position:relative), wrapping/layout untouched.
      html += isFenceMarker ? '<span class="hl-fence">' + inner + '</span>' : inner;
      if (isFenceMarker) inFence = !inFence;
      if (i < lines.length - 1) html += '\n';
      charPos += line.length + 1;
      continue;
    }
    let inner = _highlightSearchInLine(line, q, charPos, curPos);
    inner = _applyMdHighlight(inner);
    if      (/^# /.test(line))    html += '<span class="hl-h1">' + inner + '</span>';
    else if (/^## /.test(line))   html += '<span class="hl-h2">' + inner + '</span>';
    else if (/^### /.test(line))  html += '<span class="hl-h3">' + inner + '</span>';
    else if (/^#### /.test(line)) html += '<span class="hl-h4">' + inner + '</span>';
    else                           html += inner;
    if (i < lines.length - 1) html += '\n';
    charPos += line.length + 1; // +1 for '\n'
  }
  // Trailing buffer: a <textarea> reserves a bit more scroll height at the
  // bottom than this plain div does. Without a buffer the overlay's scroll gets
  // clamped shorter than the textarea's, so at the end of the file the visible
  // text sits below the caret ("cursor above text"). A couple of invisible
  // blank lines make the overlay at least as tall as the textarea; they stay
  // below the fold (overlay is overflow:hidden, scroll driven by the textarea).
  html += '\n\u200b\n\u200b';
  overlay.innerHTML = html;
  overlay.scrollTop = editor.scrollTop;
  decorateEditorCodeBlocks();
  renderEditorGutter();
}

// Hidden twin of the editor textarea. We mirror its content + styles into a
// div and read marker offsets to get the REAL pixel position of each line —
// including soft-wrapped long lines, which `lineIndex × lineHeight` gets wrong.
let _editorMirror = null;
let _editorTopsCacheKey = '';
let _editorTopsCache = null;
function _measureEditorLineTops(text, lineSet, cs) {
  // Font state in the key: wraps measured with the fallback differ from
  // those of the real font (see _fenceInkMetrics).
  const fontsReady = !document.fonts || document.fonts.status === 'loaded';
  // The font size (and line height) MUST be in the key: zoom changes them
  // without changing clientWidth or text, and a stale cache would leave the
  // code boxes sized for the previous zoom (too short when zooming in).
  const key = (fontsReady ? 'R|' : 'P|') + editor.clientWidth + '|' + cs.fontSize + '|' + cs.lineHeight + '|' + text;
  if (_editorTopsCacheKey === key && _editorTopsCache) return _editorTopsCache;

  let m = _editorMirror;
  if (!m) {
    m = document.createElement('div');
    m.setAttribute('aria-hidden', 'true');
    m.style.cssText = 'position:absolute;top:-99999px;left:0;visibility:hidden;pointer-events:none;overflow:hidden;';
    document.body.appendChild(m);
    _editorMirror = m;
  }
  // Replicate every property that influences text wrapping/metrics.
  m.style.boxSizing = 'border-box';
  m.style.width = editor.clientWidth + 'px';
  m.style.fontFamily = cs.fontFamily;
  m.style.fontSize = cs.fontSize;
  m.style.fontWeight = cs.fontWeight;
  m.style.fontStyle = cs.fontStyle;
  m.style.lineHeight = cs.lineHeight;
  m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  m.style.paddingTop = cs.paddingTop;
  m.style.paddingRight = cs.paddingRight;
  m.style.paddingBottom = cs.paddingBottom;
  m.style.paddingLeft = cs.paddingLeft;
  m.style.whiteSpace = 'pre-wrap';
  m.style.overflowWrap = 'break-word';
  m.style.wordBreak = cs.wordBreak;

  const lines = text.split('\n');
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    if (lineSet.has(i)) html += `<span class="_lnm" data-ln="${i}"></span>`;
    html += escHtml(lines[i]);
    if (i < lines.length - 1) html += '\n';
  }
  // A boundary may point just past the last line (block ends at EOF).
  if (lineSet.has(lines.length)) html += `<span class="_lnm" data-ln="${lines.length}"></span>`;
  m.innerHTML = html;

  const tops = {};
  m.querySelectorAll('span[data-ln]').forEach(s => { tops[+s.dataset.ln] = s.offsetTop; });
  _editorTopsCacheKey = key;
  _editorTopsCache = tops;
  return tops;
}

// ── Line-number gutter ───────────────────────────────────────────────────────
// Measures the pixel top of EVERY logical line (soft-wrap aware) with a private
// mirror + cache, so it never collides with _measureEditorLineTops' shared cache
// (whose key ignores the line-set — a mixed all-lines/some-lines call would
// otherwise return the wrong cached object).
let _gutterMirror = null, _gutterTopsKey = '', _gutterTops = null;
function _measureGutterLineTops(text, cs) {
  const fontsReady = !document.fonts || document.fonts.status === 'loaded';
  const key = (fontsReady ? 'R|' : 'P|') + editor.clientWidth + '|' + cs.fontSize + '|' + cs.lineHeight + '|' + text;
  if (_gutterTopsKey === key && _gutterTops) return _gutterTops;
  let m = _gutterMirror;
  if (!m) {
    m = document.createElement('div');
    m.setAttribute('aria-hidden', 'true');
    m.style.cssText = 'position:absolute;top:-99999px;left:0;visibility:hidden;pointer-events:none;overflow:hidden;';
    document.body.appendChild(m);
    _gutterMirror = m;
  }
  m.style.boxSizing = 'border-box';
  m.style.width = editor.clientWidth + 'px';
  m.style.fontFamily = cs.fontFamily; m.style.fontSize = cs.fontSize;
  m.style.fontWeight = cs.fontWeight; m.style.fontStyle = cs.fontStyle;
  m.style.lineHeight = cs.lineHeight; m.style.letterSpacing = cs.letterSpacing;
  m.style.tabSize = cs.tabSize;
  m.style.paddingTop = cs.paddingTop; m.style.paddingRight = cs.paddingRight;
  m.style.paddingBottom = cs.paddingBottom; m.style.paddingLeft = cs.paddingLeft;
  m.style.whiteSpace = 'pre-wrap'; m.style.overflowWrap = 'break-word'; m.style.wordBreak = cs.wordBreak;
  const lines = text.split('\n');
  let html = '';
  for (let i = 0; i < lines.length; i++) {
    html += `<span class="_glnm" data-ln="${i}"></span>` + escHtml(lines[i]);
    if (i < lines.length - 1) html += '\n';
  }
  m.innerHTML = html;
  const tops = {};
  m.querySelectorAll('span[data-ln]').forEach(s => { tops[+s.dataset.ln] = s.offsetTop; });
  _gutterTopsKey = key; _gutterTops = tops;
  return tops;
}

// Render the line numbers into #editor-gutter, aligned to each logical line's
// top and scrolled in lock-step with the textarea. No-op unless the option is
// on (the .line-numbers class) and the editor is laid out (edit view).
function renderEditorGutter() {
  if (_cmActive) return;
  const pane   = document.getElementById('editor-pane');
  const gutter = document.getElementById('editor-gutter');
  if (!pane || !gutter || !editor) return;
  if (!pane.classList.contains('line-numbers') || !editor.clientWidth) { gutter.textContent = ''; return; }
  const cs = getComputedStyle(editor);
  const tops = _measureGutterLineTops(editor.value, cs);   // pixel top of each logical line (wrap-aware)
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.85);
  const lines = editor.value.split('\n');
  const n = lines.length;
  // Mirror the overlay's fence-line vertical shift so a ``` line's number tracks
  // it (the whole ``` line is shifted by --fence-shift in #editor-highlight).
  const overlay = document.getElementById('editor-highlight');
  if (overlay) {
    const fs = getComputedStyle(overlay).getPropertyValue('--fence-shift');
    if (fs && fs.trim()) gutter.style.setProperty('--fence-shift', fs.trim());
  }
  // Build flowing text: the number for each logical line, then a blank row for
  // every EXTRA visual row that line occupies (soft-wrap), so the next number
  // lands on the next logical line's first row — same flow as the text overlay.
  // Fence-marker lines get their number wrapped in .hl-fence (same shift).
  const parts = [];
  for (let i = 0; i < n; i++) {
    const isFence = /^\s*(```|~~~)/.test(lines[i]);
    parts.push(isFence ? `<span class="hl-fence">${i + 1}</span>` : String(i + 1));
    const rows = (i < n - 1 && tops[i + 1] != null && tops[i] != null)
      ? Math.max(1, Math.round((tops[i + 1] - tops[i]) / lh))
      : 1;
    for (let k = 1; k < rows; k++) parts.push('');
  }
  gutter.innerHTML = parts.join('\n');
  gutter.scrollTop = editor.scrollTop;
}


function loadLineNumbers() {
  try { return localStorage.getItem('inkwell-line-numbers') === '1'; } catch (_) { return false; }
}
function applyLineNumbers(on) {
  const pane = document.getElementById('editor-pane');
  if (pane) pane.classList.toggle('line-numbers', !!on);
  try { localStorage.setItem('inkwell-line-numbers', on ? '1' : '0'); } catch (_) {}
  const tgl = document.getElementById('cfg-line-numbers');
  if (tgl) tgl.checked = !!on;
  // CM engine: use its native gutter instead of the legacy overlay gutter.
  if (_cmActive && _cmHandle) { try { _cmHandle.setLineNumbers(!!on); } catch (_) {} return; }
  try { renderEditorGutter(); } catch (_) {}
}
function setupLineNumbers() {
  applyLineNumbers(loadLineNumbers());
  document.getElementById('cfg-line-numbers')?.addEventListener('change', e => applyLineNumbers(e.target.checked));
}

// ── Wiki-link `[[` suggestions toggle ────────────────────────────────────────
// ── Editor toolbar visibility toggle (General settings) ──────────────────────
// The formatting toolbar row (H/bold/italic/…/search/undo). Default ON (shown).
function editorToolbarOn() {
  try { return localStorage.getItem('inkwell-editor-toolbar') !== '0'; } catch (_) { return true; }
}
function applyEditorToolbar(on) {
  try { localStorage.setItem('inkwell-editor-toolbar', on ? '1' : '0'); } catch (_) {}
  const bar = document.getElementById('editor-toolbar');
  if (bar) bar.style.display = on ? '' : 'none';
  const tgl = document.getElementById('cfg-editor-toolbar');
  if (tgl) tgl.checked = !!on;
}
function setupEditorToolbarToggle() {
  applyEditorToolbar(editorToolbarOn());
  document.getElementById('cfg-editor-toolbar')?.addEventListener('change', e => applyEditorToolbar(e.target.checked));
}

// Make the preview checkboxes clickable and kept in sync with the markdown
// (Obsidian style). marked generates them \`disabled\`: here we re-enable them, and on
// each click we toggle \`- [ ]\` ↔ \`- [x]\` in the source note.
function enhanceCheckboxes() {
  const boxes = previewContent.querySelectorAll('input[type="checkbox"]');
  boxes.forEach((box, idx) => {
    box.disabled = false;
    box.style.cursor = 'pointer';
    const li = box.closest('li');
    if (li) { li.classList.add('task-list-item'); li.classList.toggle('done', box.checked); }
    box.addEventListener('change', () => {
      if (li) li.classList.toggle('done', box.checked);
      toggleCheckboxInSource(idx, box.checked);
    });
  });
}

// Toggle the Nth checkbox (\`- [ ]\` / \`- [x]\`) in the note source,
// save, and keep the preview/anchor consistent.
function toggleCheckboxInSource(index, checked) {
  const tab = getActiveTab(); if (!tab) return;
  const lines = editor.value.split('\n');
  let n = -1;
  const re = /^(\s*[-*+]\s+)\[([ xX])\](\s.*)?$/;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      n++;
      if (n === index) {
        lines[i] = lines[i].replace(re, (m, pre, _mark, rest) => pre + '[' + (checked ? 'x' : ' ') + ']' + (rest || ''));
        break;
      }
    }
  }
  const newVal = lines.join('\n');
  if (newVal === editor.value) return;
  editor.value = newVal;
  tab.content = newVal; tab.isDirty = true;
  try { applyEditorHighlight(); } catch (_) {}
  try { scheduleAutosave(); } catch (_) {}
}

// Vertical position of the backtick "```" ink for the current font
// (cached). Used to give the box a small SYMMETRIC breathing space around the
// fence glyphs while staying inside their lines.
// IMPORTANT: the baseline is NOT computed from canvas metrics (Chrome centers
// the line with different metrics → ~5px error, the border clipped the glyphs):
// it is measured in the DOM with an empty inline-block, which by definition aligns
// to the text baseline. Only the ink extent above/below the
// baseline comes from the canvas (that one is reliable, it's the same rasterizer).
let _fenceMetricsKey = '';
let _fenceMetrics = null;
function _fenceInkMetrics(cs, lh) {
  // The editor font loads asynchronously: measuring BEFORE the load would give
  // the fallback metrics. The load state is part of the cache key,
  // so at "fonts.ready" (which re-runs decorate) it is measured again.
  const fontsReady = !document.fonts || document.fonts.status === 'loaded';
  const key = (fontsReady ? 'R|' : 'P|') + cs.fontWeight + '|' + cs.fontSize + '|' + cs.fontFamily + '|' + lh;
  if (_fenceMetricsKey === key && _fenceMetrics) return _fenceMetrics;
  let res;
  try {
    // Line baseline: half-leading + font ascent (as Chrome does for
    // the line box). The canvas actualBoundingBox* metrics match the
    // DOM rendering (verified at the pixel level: real ink 3.75–6.2px from
    // the line top vs 3.875–6.875 computed). The historical bug was ONLY the cache
    // filled before the font loaded (see key 'R|/P|').
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontStyle && cs.fontStyle !== 'normal' ? cs.fontStyle + ' ' : ''}${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText('```');
    const baseline = (lh - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
    res = {
      inkTop: baseline - m.actualBoundingBoxAscent,
      inkBottom: baseline + m.actualBoundingBoxDescent,
      // Line bottom with descender letters (g, j, p, q, y): needed when the
      // fence line has text beyond the backticks.
      fullDescent: baseline + m.fontBoundingBoxDescent,
      // The mirror's empty <span> markers do NOT report the line top but
      // the top of their font-box (= baseline - fontAscent, lower down).
      // This offset brings the measured tops back to the REAL line top.
      strutOff: baseline - m.fontBoundingBoxAscent,
    };
  } catch (_) {
    res = { inkTop: lh * 0.28, inkBottom: lh * 0.40, fullDescent: lh * 0.85, strutOff: 0 };
  }
  _fenceMetricsKey = key;
  _fenceMetrics = res;
  return res;
}

// Copy button on every code block ALSO in editing view (like in preview).
// The editor is a textarea: we position an absolute button over each fence
// block by measuring the real positions (with wrapping), and reposition it
// allo scroll/input.
function decorateEditorCodeBlocks() {
  if (_cmActive) return;
  const layer = document.getElementById('editor-code-actions');
  const bgLayer = document.getElementById('editor-code-bg');
  const overlay = document.getElementById('editor-highlight');
  if (!overlay || !editor) return;
  if (layer) layer.innerHTML = '';
  if (bgLayer) bgLayer.innerHTML = '';
  // Remove the old rectangles from the text overlay (but NOT the text).
  overlay.querySelectorAll('.editor-code-rect').forEach(r => r.remove());
  // Editor hidden (e.g. we're in preview): clientWidth = 0, any measurement
  // would be garbage (boxes 40px wide and thousands tall). No boxes: they'll be
  // recreated by setViewMode when switching back to edit.
  if (!editor.clientWidth) return;
  const cs = getComputedStyle(editor);
  let lh = parseFloat(cs.lineHeight);
  if (!lh || isNaN(lh)) lh = (parseFloat(cs.fontSize) || 15) * 1.6;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const lines = editor.value.split('\n');

  // Vertically center the ``` ink within their line (see .hl-fence
  // in applyEditorHighlight): shift from the natural line top to the center.
  // Must be set even without complete blocks (a lone opening ```).
  const ink = _fenceInkMetrics(cs, lh);
  // No visual ink shift on ``` lines: it moved the OVERLAY text down while the
  // textarea's caret stayed at the uniform row position, so on a ``` line with
  // trailing text the caret floated ABOVE the text. Keeping it 0 makes overlay
  // text, caret, line numbers and the file all line up (normal markdown). The
  // grey code box still wraps the block (geometry below uses fenceShift=0).
  const fenceShift = 0;
  overlay.style.setProperty('--fence-shift', '0px');

  // find the fenced blocks (opening line → closing line)
  const blocks = [];
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      if (start === -1) start = i;
      else { blocks.push({ start, end: i }); start = -1; }
    }
  }
  if (!blocks.length) return;

  // Real pixel tops of every block boundary (start line and the line right after
  // the block), so soft-wrapped lines are accounted for and the grey box always
  // contains the full code — no text spilling past the bottom border.
  const needed = new Set();
  for (const b of blocks) { needed.add(b.start); needed.add(b.end); }
  const tops = _measureEditorLineTops(editor.value, needed, cs);

  const padL = parseFloat(cs.paddingLeft) || 48;
  const padR = parseFloat(cs.paddingRight) || 48;
  // The code block is indented 2 spaces in the file (indentFenceContent), so the
  // grey box HUGS that indent: its left edge sits `innerPad` px before the code's
  // actual leading indent, and its right edge is flush with the wrap column. This
  // makes the box narrower than the paragraph column on the left (the code is
  // shifted right) and tight on the right. Computed PER-BLOCK from the block's
  // real indent so it always tracks the code — even a freshly-typed block at
  // col 0 (before save normalizes it to 2) gets a box that hugs it, no mismatch.
  const innerPad = 8;
  // Width of one space in the editor font, to convert the code's leading-space
  // count into pixels (proportional fonts → measure, don't assume).
  const _cwCtx = (decorateEditorCodeBlocks._cw ||
    (decorateEditorCodeBlocks._cw = document.createElement('canvas').getContext('2d')));
  _cwCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const spaceW = _cwCtx.measureText(' ').width || (parseFloat(cs.fontSize) || 15) * 0.5;
  const boxRight = editor.clientWidth - padR;   // flush at the wrap column (tightest safe)
  const _blockIndentPx = (b) => {
    let min = Infinity;
    for (let k = b.start; k <= b.end && k < lines.length; k++) {
      if (lines[k].trim() === '') continue;
      const sp = lines[k].match(/^ */)[0].length;
      if (sp < min) min = sp;
    }
    return (min === Infinity ? 0 : min) * spaceW;
  };
  // Breathing space above and below the backtick INK. Scales with the line
  // height so it stays proportional when the note is zoomed (a fixed 6px looked
  // cramped — the ``` nearly touched the box edge — at large font sizes).
  const inkGap = Math.max(6, Math.round(lh * 0.30));

  // The boxes live in an inner wrapper as tall as ALL the content and the layer
  // scrolls with scrollTop = editor.scrollTop (identical to the #editor-highlight overlay).
  // Using the exact same mechanism as the text, background and text stay locked
  // together and cannot diverge during scrolling (no more "table that
  // moves up/down"). The boxes are positioned in CONTENT coordinates.
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const lineTop = (tops[b.start] != null) ? tops[b.start] - ink.strutOff : (padTop + b.start * lh);
    const closeTop = (tops[b.end] != null) ? tops[b.end] - ink.strutOff : (padTop + b.end * lh);
    // FIXED measurement (doesn't depend on what's written, no box that "breathes"
    // while typing): inkGap above/below the CENTERED ``` ink (the
    // fenceShift follows the .hl-fence shift), never leaving the
    // fence lines.
    const boxTopAbs = lineTop + ink.inkTop + fenceShift - inkGap;
    // Cover the FULL closing-fence line (down to ~its line bottom) so the caret
    // sitting on that line is inside the box. When another code block sits
    // directly on the next line (stacked, no blank line between), extend this box
    // down to exactly meet the next box's top so they TOUCH (no gap) and a thin
    // 1px dark border-bottom (.cb-stacked) reads as a single separating line.
    const nextAdjacent = blocks[idx + 1] && blocks[idx + 1].start === b.end + 1;
    const prevAdjacent = blocks[idx - 1] && blocks[idx - 1].end === b.start - 1;
    const boxBottomAbs = nextAdjacent
      ? closeTop + lh + ink.inkTop + fenceShift - inkGap   // = the next box's top
      : closeTop + lh - 1;
    // Horizontal: the box starts EXACTLY at the paragraph text column (padL) —
    // i.e. where the caret on a code-fence line sits at column 0. Not inset to the
    // code's 2-space indent (that left the caret outside the box on the left), and
    // not the extra innerPad to the left of the column (that made the box look too
    // wide). Flush with the text column = caret at col 0 sits on the box edge.
    // The code text inside stays indented (indentFenceContent).
    const bLeft = Math.max(0, padL);
    const bWidth = Math.max(40, boxRight - bLeft);
    // The rectangle lives INSIDE #editor-highlight, the same container as the
    // editor text: so it scrolls exactly together with the text and can
    // never get out of sync (no separate layer that clamps/drifts). z-index:-1
    // keeps it behind the letters.
    const rect = document.createElement('div');
    rect.className = 'editor-code-rect' + (nextAdjacent ? ' cb-stacked' : '') + (prevAdjacent ? ' cb-stacked-top' : '');
    rect.style.top = boxTopAbs + 'px';
    rect.style.left = bLeft + 'px';
    rect.style.width = bWidth + 'px';
    rect.style.height = (boxBottomAbs - boxTopAbs) + 'px';
    overlay.appendChild(rect);
  }
}

// ─── Live code-fence indentation ─────────────────────────────────────────────
// Keep code blocks indented to 2 spaces WHILE typing (same rule as main's
// indentFenceContent), so a freshly-typed block looks like an existing one
// instead of staying flush at column 0 until save/reopen. Only COMPLETE (closed)
// blocks are touched — an unclosed ``` (still being typed) is left alone so we
// never indent the rest of the note.
function _indentFences2(text) {
  const lines = text.split('\n');
  const out = lines.slice();
  let i = 0;
  while (i < lines.length) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*(```|~~~)/.test(lines[j])) j++;
      if (j >= lines.length) {
        // Unclosed block (still being typed): indent ONLY the opening fence line
        // to 2 so the block starts indented right away (Enter-auto-indent keeps
        // the lines you type next aligned) — no jump when you later close it.
        // The lines AFTER it are left untouched (could be unrelated text below a
        // stray fence; the real content typed next is indented as you go).
        if (lines[i].trim() !== '') out[i] = '  ' + lines[i].replace(/^ */, '');
        break;
      }
      // DRIFT-PROOF: shift the block by a delta derived from the OPENING fence's
      // own indent (which is stable — always the block's base), NOT the min over
      // all lines. With the min, a single freshly-added column-0 line would drag
      // the min to 0 and shift the whole block +2 every pass (4,6,8…). Anchoring
      // to the opening fence makes it idempotent: already-at-2 → delta 0 → no-op.
      // Relative indentation is preserved (every non-blank line shifts equally).
      const base = lines[i].match(/^ */)[0].length;
      const delta = 2 - base;
      for (let k = i; k <= j; k++) {
        if (lines[k].trim() === '') continue;
        const cur = lines[k].match(/^ */)[0].length;
        // Shift by the fence delta (keeps relative indent, drift-proof) AND keep
        // every code line at least at the fence's 2-space level so a line typed
        // flush at column 0 doesn't stick out left of the rest of the block.
        let ni = Math.max(0, cur + delta);
        if (ni < 2) ni = 2;
        if (ni !== cur) out[k] = ' '.repeat(ni) + lines[k].slice(cur);
      }
      i = j + 1;
    } else i++;
  }
  return out.join('\n');
}

// Map a caret offset from the old text to the normalized text by (line, column):
// the caret's line only changed by its leading-indent delta.
function _remapCaretAfterIndent(oldText, newText, pos) {
  const before = oldText.slice(0, pos);
  const line = before.split('\n').length - 1;
  const col = pos - (before.lastIndexOf('\n') + 1);
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (line >= newLines.length) return newText.length;
  const oldInd = (oldLines[line].match(/^ */) || [''])[0].length;
  const newInd = (newLines[line].match(/^ */) || [''])[0].length;
  let newCol = col + (newInd - oldInd);
  if (newCol < newInd) newCol = newInd;     // don't land inside the new indent
  if (newCol < 0) newCol = 0;
  if (newCol > newLines[line].length) newCol = newLines[line].length;
  let abs = 0;
  for (let k = 0; k < line; k++) abs += newLines[k].length + 1;
  return abs + newCol;
}

// INSTANT (synchronous, no debounce) so a finished block snaps to 2 spaces the
// moment it's closed — the user explicitly didn't want a delayed "shift after a
// pause". A re-entry guard stops the execCommand-fired input from recursing.
let _reindenting = false;
function scheduleFenceReindent() {
  if (_cmActive) return;   // CM handles code blocks natively; no textarea reindent
  if (_reindenting) return;
  if (!editor || state.viewMode !== 'edit') return;
  const cur = editor.value;
  const norm = _indentFences2(cur);
  if (norm === cur) return;   // idempotent → no-op
  // SURGICAL: rewrite ONLY the minimal changed span, not the whole textarea. A
  // full rewrite (select-all + insert the entire 38 KB note) froze the app on a
  // big paste. Since reindent only tweaks leading spaces of the changed block,
  // the diff is tiny — replace just cur[p..sc) with norm[p..sn).
  let p = 0;
  const maxP = Math.min(cur.length, norm.length);
  while (p < maxP && cur[p] === norm[p]) p++;
  let sc = cur.length, sn = norm.length;
  while (sc > p && sn > p && cur[sc - 1] === norm[sn - 1]) { sc--; sn--; }
  const replacement = norm.slice(p, sn);
  const pos = editor.selectionStart;
  const newPos = _remapCaretAfterIndent(cur, norm, pos);
  _reindenting = true;
  try {
    editor.focus();
    editor.setSelectionRange(p, sc);
    // execCommand keeps it as ONE undo step (integrated with native undo).
    const ok = document.execCommand('insertText', false, replacement);
    if (!ok) { editor.value = norm; editor.dispatchEvent(new Event('input', { bubbles: true })); }
    editor.setSelectionRange(newPos, newPos);
  } finally { _reindenting = false; }
}

// Enter inside a code fence keeps the new line at the block's indent (so blocks
// never collect a column-0 line that the min-based normalize would then shift
// the WHOLE block by — that was the drift / misaligned-fence look).
function _isInsideFence(val, caretPos) {
  // Count fences UP TO AND INCLUDING the caret's current line. Including the
  // current line is what makes pressing Enter ON the opening ``` enter the block
  // (the opener counts → odd → inside), so the first code line auto-indents.
  const upto = val.slice(0, caretPos).split('\n');
  let fences = 0;
  for (const ln of upto) if (/^\s*(```|~~~)/.test(ln)) fences++;
  return fences % 2 === 1;
}
function handleFenceEnterIndent(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  if (!editor || state.viewMode !== 'edit') return;
  const val = editor.value, pos = editor.selectionStart;
  if (pos !== editor.selectionEnd) return;        // a selection is being replaced
  if (!_isInsideFence(val, pos)) return;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const nlIdx = val.indexOf('\n', pos);
  const lineEnd = nlIdx === -1 ? val.length : nlIdx;
  const fullLine = val.slice(lineStart, lineEnd);
  const indent = (fullLine.match(/^ */) || ['  '])[0] || '  ';

  // Manual ``` → same as the toolbar Code button: pressing Enter at the END of an
  // OPENING fence that has no closer yet auto-adds the closing ``` below and drops
  // the caret on the empty middle line. (Inside-a-fence guard above means this is
  // always an OPENING fence — a closing one makes the count even → not "inside".)
  const onFenceLine = /^\s*(```|~~~)/.test(fullLine);
  if (onFenceLine && pos === lineEnd) {
    const hasCloserBelow = /\n[ \t]*(```|~~~)/.test(val.slice(lineEnd));
    if (!hasCloserBelow) {
      e.preventDefault();
      const openLineIdx = val.slice(0, pos).split('\n').length - 1;   // stays stable across reindent
      document.execCommand('insertText', false, '\n' + indent + '\n' + indent + '```');
      // Caret on the FINAL text (fence-reindent may have shifted indents): end of
      // the line right after the opening fence = the empty middle line.
      const vlines = editor.value.split('\n');
      let off = 0;
      for (let k = 0; k <= openLineIdx; k++) off += vlines[k].length + 1;
      const caret = off + ((vlines[openLineIdx + 1] || '').length);
      editor.setSelectionRange(caret, caret);
      return;
    }
  }

  e.preventDefault();
  document.execCommand('insertText', false, '\n' + indent);
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fileTree = $('file-tree');
const editor = $('markdown-editor');
const previewContent = $('preview-content');
const noteTitle = $('note-title');
const editorContainer = $('editor-container');
const emptyState = $('empty-state');
const searchInput = $('search-input');
const statusPath = $('status-path');
const statusWords = $('status-words');
const statusSaved = $('status-saved');
const syncStatusDot = $('sync-status');

// ─── CodeMirror engine (the ONLY editor — legacy textarea editor retired) ────────
// Swaps the textarea + custom overlays for a virtualized CodeMirror editor so big
// notes paste/scroll instantly. Proxies the textarea's value/selection/scroll API
// onto CM so all existing load/save/feature code keeps working unchanged. Flag
// OFF → nothing runs, the legacy editor is untouched.
// Lightweight change handler for the CM engine: only the cheap essentials run
// per keystroke (dirty + autosave); the O(document) work (word count, preview,
// split mirror, tab cache) is debounced so typing stays instant on big notes.
let _cmLightTimer = null;
function _onCmChange() {
  if (_cmSuppressChange) return;      // programmatic sync, not a user edit
  const tab = getActiveTab();
  if (tab) tab.isDirty = true;
  setSavedState(false);
  scheduleAutosave();
  // Wiki-link `[[` autocomplete: the legacy editor triggers this from its textarea
  // 'input' event, which never fires under CM — drive it from the CM change instead.
  // Only while CM has focus, so a programmatic reload/setValue can't pop the list.
  try { if (_cmHandle && _cmHandle.hasFocus()) checkNoteLinkTrigger(); } catch (_) {}
  if (typeof _cmLog === 'function' && _cmHandle) _cmLog('typed caret=' + _cmHandle.getSelection().from + ' scroll=' + Math.round(_cmHandle.getScrollTop()));
  // Debounced, LIGHT only: word count. (Preview/split re-render and tab.content
  // materialization were O(document) and caused multi-second stalls on big pastes;
  // they aren't needed while editing in CM — autosave reads editor.value directly.)
  clearTimeout(_cmLightTimer);
  _cmLightTimer = setTimeout(() => {
    // Keep the in-memory tab content current so a programmatic reload can't revert
    // to a stale version (removing this in v907 caused pastes to vanish on reload).
    try { if (tab) tab.content = editor.value; } catch (_) {}
    try { updateWordCount(); } catch (_) {}
  }, 300);
}
// File-only debug log for the CM engine (DevTools isn't available in the packaged
// app). OFF by default now that CM is the shipping editor — writing to
// /tmp/amelie-cm-debug.log via IPC on every keystroke is pure overhead. Re-enable
// for a session with localStorage['amelie-cm-debug']='1' to trace caret/focus.
let _cmDebug = false;
try { _cmDebug = localStorage.getItem('amelie-cm-debug') === '1'; } catch (_) {}
function _cmLog(msg) {
  if (!_cmDebug) return;
  try {
    const d = new Date();
    const ts = ('' + d.getMinutes()).padStart(2, '0') + ':' + ('' + d.getSeconds()).padStart(2, '0') + '.' + ('' + d.getMilliseconds()).padStart(3, '0');
    try { window.inkwell.debugLog(ts + ' ' + msg); } catch (_) {}
  } catch (_) {}
}
function _cmStack() {
  if (!_cmDebug) return '';
  try {
    return (new Error().stack || '').split('\n').slice(2, 9)
      .map(s => s.trim().replace(/^at\s+/, '').replace(/\s*\(.*app\.js/, ' @app.js').replace(/:\d+\)?$/, '')).join(' <- ');
  } catch (_) { return '?'; }
}

// CM is the ONLY editor now — the legacy textarea editor was retired. There is no
// toggle and no fallback: this just wipes any stale opt-out keys left over from the
// old flag/escape-hatch era so they can never resurrect the old editor.
function _setupCmToggle() {
  try { localStorage.removeItem('amelie-legacy'); localStorage.removeItem('amelie-cm'); } catch (_) {}
}
function _initCmEditor() {
  if (_cmActive) return;
  try {
    // CM is the ONLY editor — always activate it. The single exception is a broken
    // build where the CM bundle didn't load: without AmelieCM we can't create the
    // editor, so we bail (the raw textarea stays visible only to avoid a dead app).
    if (!window.AmelieCM) { console.error('[amelie-cm] bundle missing — cannot start editor'); return; }
    const mount = document.getElementById('cm-mount');
    if (!mount || !editor) return;
    // Show the mount + hide the legacy layers FIRST, so CM is created in a VISIBLE,
    // measurable container. (Creating it while #cm-mount was display:none made CM
    // measure 0 height and stay non-interactive — you couldn't type.)
    for (const id of ['editor-highlight', 'editor-code-bg', 'editor-code-actions', 'editor-gutter']) {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    }
    editor.style.display = 'none';
    mount.style.display = 'block';
    _cmHandle = window.AmelieCM.create(mount, editor.value || '', () => _onCmChange());
    try { _cmHandle.view.requestMeasure(); } catch (_) {}
    // Proxy textarea API → CM (so existing code that reads/writes editor.value,
    // selection, scroll keeps working). INSTRUMENTED: every write logs its caller.
    Object.defineProperty(editor, 'value', { configurable: true,
      get() { return _cmHandle.getValue(); },
      set(v) { const s = v == null ? '' : String(v); if (_cmHandle.getValue() !== s) { _cmLog('SET value len=' + s.length + ' <- ' + _cmStack()); _cmHandle.setValue(s); } } });
    // Setters clamp so a two-step "selectionStart = selectionEnd = X" collapses to a
    // caret instead of leaving a giant selection (setting end < the stale start, or
    // start > the stale end, would otherwise select everything between).
    Object.defineProperty(editor, 'selectionStart', { configurable: true,
      get() { return _cmHandle.getSelection().from; },
      set(v) { try { let t = _cmHandle.getSelection().to; if (t < v) t = v; _cmHandle.setSelection(v, t); } catch (_) {} } });
    Object.defineProperty(editor, 'selectionEnd', { configurable: true,
      get() { return _cmHandle.getSelection().to; },
      set(v) { try { let f = _cmHandle.getSelection().from; if (f > v) f = v; _cmHandle.setSelection(f, v); } catch (_) {} } });
    Object.defineProperty(editor, 'scrollTop', { configurable: true,
      get() { return _cmHandle.getScrollTop(); }, set(v) { _cmLog('SET scrollTop=' + v + ' <- ' + _cmStack()); _cmHandle.setScrollTop(v); } });
    editor.setSelectionRange = (a, b) => { _cmLog('setSelectionRange(' + a + ',' + b + ') <- ' + _cmStack()); _cmHandle.setSelection(a, b); };
    editor.focus = () => { _cmLog('focus() <- ' + _cmStack()); _cmHandle.focus(); };
    _cmActive = true;
    // File paste + drag&drop (images, PDFs, attachments): the legacy handlers are
    // bound to the now-hidden textarea, which never sees these events under CM.
    // Re-attach them to CM's content DOM. Capture phase + stopImmediatePropagation
    // (inside the handlers) so we win over CM's built-in paste, which would
    // otherwise insert a file:// path as literal text.
    try {
      const cd = _cmHandle.view.contentDOM;
      if (_editorPasteHandler) cd.addEventListener('paste', _editorPasteHandler, true);
      if (_editorDragoverHandler) cd.addEventListener('dragover', _editorDragoverHandler);
      if (_editorDropHandler) cd.addEventListener('drop', _editorDropHandler, true);
      // Block the middle-click primary-selection paste under CM too.
      if (_editorMiddleDownHandler) cd.addEventListener('mousedown', _editorMiddleDownHandler, true);
      if (_editorAuxClickHandler) cd.addEventListener('auxclick', _editorAuxClickHandler, true);
    } catch (_) {}
    // Sync the line-number gutter to the saved setting (CM's native gutter).
    try { _cmHandle.setLineNumbers(loadLineNumbers()); } catch (_) {}
    // Force CM to re-measure line metrics after the custom editor font
    // ('AmelieWideTick') finishes loading. Without this CM measures line HEIGHT
    // with the fallback font at create time and never updates — on a big note the
    // wrong per-line height makes the virtualized viewport miscalculate (symptom:
    // the editor collapses to a few visible rows after a large paste). The legacy
    // editor did the same via document.fonts.ready.
    try { document.fonts && document.fonts.ready.then(() => { try { _cmHandle.view.requestMeasure(); } catch (_) {} }); } catch (_) {}
    // Re-measure whenever the mount is resized (pane resize, split toggle, sidebar
    // collapse, DevTools). A stale measurement here is the other way CM can end up
    // rendering only a sliver of lines; requestMeasure recovers it.
    try {
      const ro = new ResizeObserver(() => { try { _cmHandle.view.requestMeasure(); } catch (_) {} });
      ro.observe(mount);
    } catch (_) {}
  } catch (e) { console.error('[amelie-cm] init failed:', e); }
}

// ─── Theme ────────────────────────────────────────────────────────────────────
const THEMES = {
  'github-dark': { label: 'Green Dark',     attr: ''          },
  navy:          { label: 'Navy',          attr: 'navy'      },
  amber:         { label: 'Amber Dark',    attr: 'amber'     },
  solarized:     { label: 'Solarized',     attr: 'solarized' },
  light:         { label: 'Light Paper',   attr: 'light'     },
  rose:          { label: 'Rosé Pine',     attr: 'rose'      },
  gruvbox:       { label: 'Gruvbox',       attr: 'gruvbox'   },
  nord:          { label: 'Nord',          attr: 'nord'      },
  onedark:       { label: 'One Dark',      attr: 'onedark'   },
  dracula:       { label: 'Dracula',       attr: 'dracula'   },
};

const FONTS = {
  // ── Monospace (bundled offline, see fonts.css) ──
  jetbrains:    "'JetBrains Mono', monospace",
  roboto:       "'Roboto Mono', monospace",
  fira:         "'Fira Code', monospace",
  sourcecodepro:"'Source Code Pro', monospace",
  ibmplex:      "'IBM Plex Mono', monospace",
  spacemono:    "'Space Mono', monospace",
  couriernew:   "'Courier New', 'Liberation Mono', Courier, monospace",
  // ── Sans-serif (bundled offline) ──
  inter:        "'Inter', sans-serif",
  robotosans:   "'Roboto', sans-serif",
  sourcesans:   "'Source Sans 3', sans-serif",
  lato:         "'Lato', sans-serif",
  nunito:       "'Nunito', sans-serif",
  atkinson:     "'Atkinson Hyperlegible', sans-serif",
  // ── Serif (bundled offline) ──
  lora:         "'Lora', serif",
  merriweather: "'Merriweather', serif",
  ebgaramond:   "'EB Garamond', serif",
  fraunces:     "'Fraunces', serif",
  // ── Common system fonts (proportional) — no download required. ──
  helvetica:    "'Helvetica Neue', Helvetica, Arial, sans-serif",
  arial:        "Arial, 'Helvetica Neue', Helvetica, sans-serif",
  system:       "system-ui, -apple-system, 'Segoe UI', sans-serif",
  noto:         "'Noto Sans', 'Open Sans', sans-serif",
  cantarell:    "Cantarell, 'Noto Sans', sans-serif",
  dejavu:       "'DejaVu Sans', Verdana, sans-serif",
  georgia:      "Georgia, 'Times New Roman', serif",
  times:        "'Times New Roman', 'Liberation Serif', Times, serif",
  verdana:      "Verdana, Geneva, Tahoma, sans-serif",
};

// The family currently chosen for the editor, for the places that need it as a string
// (canvas contexts, which cannot inherit CSS).
function _editorFontFamily() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--editor-font-family').trim();
  return v || FONTS.roboto;
}

// Labels + order for the font dropdown.
const FONT_LABELS = {
  jetbrains: 'JetBrains Mono', roboto: 'Roboto Mono', fira: 'Fira Code',
  sourcecodepro: 'Source Code Pro', ibmplex: 'IBM Plex Mono', spacemono: 'Space Mono',
  couriernew: 'Courier New',
  inter: 'Inter', robotosans: 'Roboto', sourcesans: 'Source Sans', lato: 'Lato',
  nunito: 'Nunito', atkinson: 'Atkinson Hyperlegible',
  lora: 'Lora', merriweather: 'Merriweather', ebgaramond: 'EB Garamond', fraunces: 'Fraunces',
  helvetica: 'Helvetica', arial: 'Arial', system: 'System',
  noto: 'Noto Sans', cantarell: 'Cantarell', dejavu: 'DejaVu Sans',
  georgia: 'Georgia', times: 'Times New Roman', verdana: 'Verdana',
};
const FONT_ORDER = [
  'jetbrains','roboto','fira','sourcecodepro','ibmplex','spacemono','couriernew',
  'inter','robotosans','sourcesans','lato','nunito','atkinson',
  'lora','merriweather','ebgaramond','fraunces',
  'helvetica','arial','system','noto','cantarell','dejavu','georgia','times','verdana',
];

// Apply appearance vars to :root
function applyAppearance(prefs = {}) {
  const root = document.documentElement;
  const edSize    = prefs.editorFontSize  ?? 14;
  const treePy    = prefs.treeSpacing     ?? 3;
  const treeSize  = prefs.treeFontSize    ?? 13;
  // An unknown key (a font that has since been removed — Mr Robot was one) falls back to
  // the default instead of leaving the editor on a family that no longer exists and the
  // dropdown showing a blank label.
  const fontKey   = FONTS[prefs.editorFont] ? prefs.editorFont : 'roboto';
  // Where a new drawing / note is created: 'root' (vault root) or 'current' (selected folder).
  const drawLoc   = prefs.drawLocation    ?? 'root';
  const noteLoc   = prefs.noteLocation    ?? 'current';
  // Global size of the top toolbar icons, as a percentage (100 = default).
  const tbZoom    = prefs.toolbarZoom     ?? 100;
  root.style.setProperty('--editor-font-size',   edSize   + 'px');
  root.style.setProperty('--tree-item-py',        treePy   + 'px');
  root.style.setProperty('--tree-font-size',      treeSize + 'px');
  root.style.setProperty('--editor-font-family',  FONTS[fontKey] ?? FONTS.jetbrains);
  root.style.setProperty('--toolbar-zoom',        (tbZoom / 100).toFixed(3));
  // persist
  try { localStorage.setItem('inkwell-appearance', JSON.stringify({ editorFontSize: edSize, treeSpacing: treePy, treeFontSize: treeSize, editorFont: fontKey, drawLocation: drawLoc, noteLocation: noteLoc, toolbarZoom: tbZoom })); } catch(_) {}
  updateFontDropdownCurrent(fontKey);
  updateNumberDdCurrent('edsize-dd', edSize,   'px');
  updateNumberDdCurrent('treesp-dd', treePy,   'px');
  updateNumberDdCurrent('treesz-dd', treeSize, 'px');
  updateNumberDdCurrent('tbsize-dd', tbZoom,   '%');
  updateDrawLocationPills(drawLoc);
  updateNoteLocationPills(noteLoc);
}

// New notes / new drawings location is a toggle: ON = current folder, OFF = vault root.
function updateDrawLocationPills(loc) {
  const t = document.getElementById('cfg-draw-loc');
  if (t) t.checked = (loc === 'current');
}
function updateNoteLocationPills(loc) {
  const t = document.getElementById('cfg-note-loc');
  if (t) t.checked = (loc === 'current');
}

// Folder a new note should be created in, per the noteLocation preference.
function newNoteFolder() {
  return (loadAppearance().noteLocation === 'root') ? '' : currentFolderPath();
}

// Wire the location toggles (draws + notes): flipping saves the preference.
function setupDrawLocation() {
  const dt = document.getElementById('cfg-draw-loc');
  if (dt && !dt.dataset.wired) {
    dt.dataset.wired = '1';
    dt.addEventListener('change', () => {
      const prefs = loadAppearance();
      prefs.drawLocation = dt.checked ? 'current' : 'root';
      applyAppearance(prefs);
    });
  }
  const nt = document.getElementById('cfg-note-loc');
  if (nt && !nt.dataset.wired) {
    nt.dataset.wired = '1';
    nt.addEventListener('change', () => {
      const prefs = loadAppearance();
      prefs.noteLocation = nt.checked ? 'current' : 'root';
      applyAppearance(prefs);
    });
  }
}

// Update the dropdown button's label + font.
function updateFontDropdownCurrent(fontKey) {
  const cur = document.getElementById('font-dd-current');
  if (!cur) return;
  cur.textContent = FONT_LABELS[fontKey] || fontKey;
  cur.style.fontFamily = FONTS[fontKey] || '';
}

// Close every other custom dropdown menu when one opens — otherwise clicking
// another dropdown's button (which stops propagation) left the first one open.
function closeOtherDropdowns(exceptMenu) {
  ['font-dd-menu', 'lang-dd-menu', 'langsetup-dd-menu',
   'edsize-dd-menu', 'treesp-dd-menu', 'treesz-dd-menu', 'tbsize-dd-menu',
   'text-color-popup', 'table-popup', 'heading-popup'].forEach(id => {
    const m = document.getElementById(id);
    if (m && m !== exceptMenu) m.style.display = 'none';
  });
}

// Font picker dropdown: the button opens a menu with every font shown
// in its own typeface; clicking one applies it immediately.
function setupFontDropdown() {
  const btn = document.getElementById('font-dd-btn');
  const menu = document.getElementById('font-dd-menu');
  if (!btn || !menu) return;
  menu.innerHTML = '';
  FONT_ORDER.forEach(key => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'font-dd-item';
    item.dataset.font = key;
    item.textContent = FONT_LABELS[key] || key;
    item.style.fontFamily = FONTS[key] || '';
    item.addEventListener('click', () => {
      const prefs = loadAppearance();
      prefs.editorFont = key;
      applyAppearance(prefs);            // apply + persist + update label
      menu.querySelectorAll('.font-dd-item').forEach(i => i.classList.toggle('active', i === item));
      menu.style.display = 'none';
    });
    menu.appendChild(item);
  });
  const close = () => { menu.style.display = 'none'; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const open = menu.style.display !== 'none';
    if (open) { close(); return; }
    closeOtherDropdowns(menu);   // close lang/other dropdowns first
    // Highlight the active font on open.
    const cur = (loadAppearance().editorFont) || 'jetbrains';
    menu.querySelectorAll('.font-dd-item').forEach(i => i.classList.toggle('active', i.dataset.font === cur));
    menu.style.display = 'block';
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#font-dd')) close();
  });
}

// Numeric appearance settings shown as dropdowns (like Language/Font) instead of
// sliders. Each lists discrete values over its old slider range; picking one applies
// + persists via applyAppearance (which also refreshes the button label).
const NUMBER_DROPDOWNS = [
  { ddId: 'edsize-dd', key: 'editorFontSize', min: 9,  max: 22,  step: 1, unit: 'px', def: 14  },
  { ddId: 'treesp-dd', key: 'treeSpacing',    min: 1,  max: 10,  step: 1, unit: 'px', def: 3   },
  { ddId: 'treesz-dd', key: 'treeFontSize',   min: 11, max: 18,  step: 1, unit: 'px', def: 13  },
  { ddId: 'tbsize-dd', key: 'toolbarZoom',    min: 70, max: 160, step: 5, unit: '%',  def: 100 },
];

// Refresh a numeric dropdown's button label (e.g. "14px").
function updateNumberDdCurrent(ddId, value, unit) {
  const cur = document.getElementById(ddId + '-current');
  if (cur) cur.textContent = value + unit;
}

function setupNumberDropdowns() {
  NUMBER_DROPDOWNS.forEach(cfg => {
    const btn  = document.getElementById(cfg.ddId + '-btn');
    const menu = document.getElementById(cfg.ddId + '-menu');
    if (!btn || !menu) return;
    menu.innerHTML = '';
    for (let v = cfg.min; v <= cfg.max; v += cfg.step) {
      const val = v;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'font-dd-item';
      item.dataset.val = String(val);
      item.textContent = val + cfg.unit;
      item.addEventListener('click', () => {
        const prefs = loadAppearance();
        prefs[cfg.key] = val;
        applyAppearance(prefs);   // apply + persist + refresh every dd label
        menu.querySelectorAll('.font-dd-item').forEach(i => i.classList.toggle('active', i === item));
        menu.style.display = 'none';
      });
      menu.appendChild(item);
    }
    const close = () => { menu.style.display = 'none'; };
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (menu.style.display !== 'none') { close(); return; }
      closeOtherDropdowns(menu);
      const cur = loadAppearance()[cfg.key] ?? cfg.def;
      menu.querySelectorAll('.font-dd-item').forEach(i => i.classList.toggle('active', parseInt(i.dataset.val, 10) === cur));
      menu.style.display = 'block';
      const act = menu.querySelector('.font-dd-item.active');
      if (act) act.scrollIntoView({ block: 'nearest' });
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('#' + cfg.ddId)) close();
    });
  });
}

// Language dropdown: same behavior as the font dropdown. Clicks on the
// items (.lang-pill) are already handled by i18n.js; here just open/close.
function setupLangDropdown() {
  const btn = document.getElementById('lang-dd-btn');
  const menu = document.getElementById('lang-dd-menu');
  if (!btn || !menu) return;
  const close = () => { menu.style.display = 'none'; };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = menu.style.display === 'none';
    if (willOpen) closeOtherDropdowns(menu);   // close font/other dropdowns first
    menu.style.display = willOpen ? 'block' : 'none';
  });
  menu.querySelectorAll('.lang-pill').forEach(item => item.addEventListener('click', close));
  document.addEventListener('click', e => {
    if (!e.target.closest('#lang-dd')) close();
  });
}

// First-run language picker: a full-screen overlay shown ONLY when no language
// has ever been chosen (localStorage 'amelie-lang' empty). A collapsed "Choose
// your language" dropdown expands to the available languages; picking one applies
// it (i18n.applyLanguage saves it) and dismisses the overlay for good.
function maybeShowLangSetup() {
  let saved = null;
  try { saved = localStorage.getItem('amelie-lang'); } catch (_) {}
  if (saved) return;   // already chosen → never show again
  const ov = document.getElementById('langsetup-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  const btn = document.getElementById('langsetup-dd-btn');
  const menu = document.getElementById('langsetup-dd-menu');
  if (btn && menu) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      menu.style.display = (menu.style.display !== 'none') ? 'none' : 'block';
    });
    document.addEventListener('click', e => { if (!e.target.closest('#langsetup-dd')) menu.style.display = 'none'; });
  }
  // Picking a language: i18n's global .lang-pill handler applies+saves it; here
  // we just close the overlay so the app proceeds.
  ov.querySelectorAll('.lang-pill').forEach(p => p.addEventListener('click', () => { ov.style.display = 'none'; }));
}

// ─── View width (wide ↔ readable line length, Obsidian-style) ────────────────
// 'wide'     → editor & preview use the full pane width (almost to the window edge)
// 'readable' → content centered with a max line length, easier to read
function applyViewWidth(mode) {
  const m = (mode === 'readable') ? 'readable' : 'wide';
  document.documentElement.setAttribute('data-view-width', m);
  try { localStorage.setItem('inkwell-view-width', m); } catch(_) {}
  // Reflect the state on the toggle in settings (On = readable).
  const tgl = document.getElementById('cfg-readable-width');
  if (tgl) tgl.checked = (m === 'readable');
}

function loadViewWidth() {
  try { return localStorage.getItem('inkwell-view-width') || 'wide'; } catch(_) { return 'wide'; }
}

function setupViewWidth() {
  applyViewWidth(loadViewWidth());
  document.getElementById('cfg-readable-width')?.addEventListener('change', e => {
    applyViewWidth(e.target.checked ? 'readable' : 'wide');
  });
}

// ─── Folder guide lines (sidebar indent guides on/off) ───────────────────────
// 'on'  → vertical guide lines next to nested folders (default)
// 'off' → uniform/flat look without the long indent lines
function applyFolderGuides(mode) {
  const m = (mode === 'off') ? 'off' : 'on';
  document.documentElement.setAttribute('data-folder-guides', m);
  try { localStorage.setItem('inkwell-folder-guides', m); } catch(_) {}
  // Reflect the state on the toggle in settings (On = lines visible).
  const tgl = document.getElementById('cfg-folder-guides');
  if (tgl) tgl.checked = (m === 'on');
}

function loadFolderGuides() {
  // Default to the clean, line-free look (Obsidian/Notion-like).
  try { return localStorage.getItem('inkwell-folder-guides') || 'off'; } catch(_) { return 'off'; }
}

function setupFolderGuides() {
  applyFolderGuides(loadFolderGuides());
  document.getElementById('cfg-folder-guides')?.addEventListener('change', e => {
    applyFolderGuides(e.target.checked ? 'on' : 'off');
  });
}

// ─── Voice recording (mic button next to Export, toggle in Settings) ──────────
// Records from the microphone into webm/opus (natively playable by the in-app
// audio player), saves into attachments/audio/ and inserts a 🎵 link at the
// caret. The button shows the elapsed time and pulses red while recording.
let _recStream = null, _recRecorder = null, _recChunks = [], _recTimer = null, _recStart = 0;

function applyAudioRecEnabled(on) {
  const en = on === true || on === 'on';
  const btn = $('btn-audio-rec');
  if (btn) btn.style.display = en ? '' : 'none';
  try { localStorage.setItem('amelie-audio-rec', en ? 'on' : 'off'); } catch (_) {}
  const tgl = $('cfg-audio-rec');
  if (tgl) tgl.checked = en;
  if (!en && _recRecorder) _stopRecording();   // turning it off mid-take stops & saves
}

function setupAudioRecording() {
  let saved = 'off';
  try { saved = localStorage.getItem('amelie-audio-rec') || 'off'; } catch (_) {}
  applyAudioRecEnabled(saved);
  $('cfg-audio-rec')?.addEventListener('change', e => applyAudioRecEnabled(e.target.checked));
  $('btn-audio-rec')?.addEventListener('click', () => _recRecorder ? _stopRecording() : _startRecording());
}

// "Disattiva GPU rendering" toggle. Persisted in settings.json (NOT localStorage)
// because the main process reads it at startup — before app 'ready' — to call
// app.disableHardwareAcceleration(). Takes effect only after a restart.
function setupGpuToggle() {
  const tgl = document.getElementById('cfg-disable-gpu');
  if (!tgl) return;
  // Toggle is now POSITIVE: checked = GPU enabled (default), unchecked = software
  // rendering. The stored config stays `disableGpu` (inverse of the checkbox).
  window.inkwell.readConfig().then(c => { tgl.checked = !(c && c.disableGpu); }).catch(() => { tgl.checked = true; });
  tgl.addEventListener('change', async () => {
    try {
      const c = (await window.inkwell.readConfig()) || {};
      c.disableGpu = !tgl.checked;
      await window.inkwell.writeConfig(c);
      showToast(window.i18n.t('settings.gpu_restart'));
    } catch (e) { console.error('GPU toggle save failed:', e); }
  });
}

// "Low-power mode": the toggle was REMOVED from the UI (v1.0.643); the mode
// is now always on, forced in main.js. No renderer-side setup.

async function _startRecording() {
  // Immediate feedback: opening the mic device can take a couple of seconds
  // (PipeWire init) — show "…" so the click clearly registered.
  const lbl0 = $('audio-rec-label');
  if (lbl0) lbl0.textContent = '…';
  try {
    _recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    if (lbl0) lbl0.textContent = window.i18n.t('toolbar.record');
    showToast(window.i18n.t('rec.mic_denied'));
    return;
  }
  // Warm-up: the mic's power-on transient (AGC settling, PipeWire stream
  // attach) lands as a high-pitched blip in the very first instant — let the
  // device settle for half a second BEFORE recording starts, so the take
  // begins clean. The "…" label covers this wait.
  await new Promise(r => setTimeout(r, 500));
  if (!_recStream) return;   // turned off during the warm-up
  _recChunks = [];
  try {
    _recRecorder = new MediaRecorder(_recStream, { mimeType: 'audio/webm;codecs=opus' });
  } catch (_) {
    _recRecorder = new MediaRecorder(_recStream);
  }
  _recRecorder.addEventListener('dataavailable', ev => { if (ev.data && ev.data.size) _recChunks.push(ev.data); });
  _recRecorder.addEventListener('stop', _onRecStopped);
  _recRecorder.start();
  _recStart = Date.now();
  const btn = $('btn-audio-rec');
  btn?.classList.add('recording');
  const lbl = $('audio-rec-label');
  if (lbl) lbl.textContent = '0:00';
  _recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - _recStart) / 1000);
    if (lbl) lbl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}

function _stopRecording() {
  try { _recRecorder?.stop(); } catch (_) {}
}

async function _onRecStopped() {
  clearInterval(_recTimer); _recTimer = null;
  $('btn-audio-rec')?.classList.remove('recording');
  const lbl = $('audio-rec-label');
  if (lbl) lbl.textContent = window.i18n.t('toolbar.record');
  try { _recStream?.getTracks().forEach(t => t.stop()); } catch (_) {}
  _recStream = null;
  const blob = new Blob(_recChunks, { type: 'audio/webm' });
  _recRecorder = null; _recChunks = [];
  if (!blob.size) return;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // .weba = audio-webm: stored flat in attachments/ and rendered as a player.
  const fname = `rec-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.weba`;
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const name = await window.inkwell.saveAttachment(fname, buf);
    insertAttachmentRef(name);
  } catch (_) {
    showToast(window.i18n.t('toast.files_import_failed'));
  }
}

// Folder icon style: folder | chevron | graphene | book. Swaps which glyph the
// folder rows show (all glyphs are rendered; CSS shows one per data-folder-icon).
function applyFolderIconStyle(style) {
  const s = ['folder', 'chevron', 'graphene', 'dot', 'star'].includes(style) ? style : 'folder';
  document.documentElement.setAttribute('data-folder-icon', s);
  try { localStorage.setItem('amelie-folder-icon', s); } catch (_) {}
  document.querySelectorAll('.folder-icon-pills .fip').forEach(p =>
    p.classList.toggle('active', p.dataset.folderIcon === s));
}

function loadFolderIconStyle() {
  try { return localStorage.getItem('amelie-folder-icon') || 'folder'; } catch (_) { return 'folder'; }
}

// Wire the folder-icon pills (builtin glyphs only). A saved 'custom' value
// from the removed import-your-own-icon feature falls back to 'folder' via
// the allow-list in applyFolderIconStyle.
function setupFolderIconStyle() {
  // One-shot cleanup of the removed feature's cached data.
  try {
    localStorage.removeItem('amelie-folder-custom-icon');
    localStorage.removeItem('amelie-folder-custom-subpath');
  } catch (_) {}
  applyFolderIconStyle(loadFolderIconStyle());
  document.querySelectorAll('.folder-icon-pills .fip').forEach(pill => {
    pill.addEventListener('click', () => applyFolderIconStyle(pill.dataset.folderIcon));
  });
}

function loadAppearance() {
  try {
    const saved = localStorage.getItem('inkwell-appearance');
    const prefs = saved ? JSON.parse(saved) : {};
    if (saved) {
      // One-time bumps for EXISTING users (migrations of old profiles). A FRESH
      // install skips these (see the else branch) so it starts at the clean
      // defaults — Roboto Mono, editor 13 — instead of an oversized 15/16px.
      // One-time bump (v1.0.152): old builds defaulted to editor 14 / tree 13.
      if (!localStorage.getItem('inkwell-fontsize-bump-v1')) {
        if ((prefs.editorFontSize ?? 0) < 16) prefs.editorFontSize = 16;
        if ((prefs.treeFontSize   ?? 0) < 15) prefs.treeFontSize   = 15;
        localStorage.setItem('inkwell-fontsize-bump-v1', '1');
      }
      // v1.0.155: editor 16 felt too big — realign existing users to 15 once.
      if (!localStorage.getItem('inkwell-editorsize-15-v1')) {
        if ((prefs.editorFontSize ?? 0) >= 16) prefs.editorFontSize = 15;
        localStorage.setItem('inkwell-editorsize-15-v1', '1');
      }
      // v1.0.156: tree 15 still felt too big — realign existing users to 13 once.
      if (!localStorage.getItem('inkwell-treesize-13-v1')) {
        if ((prefs.treeFontSize ?? 0) > 13) prefs.treeFontSize = 13;
        localStorage.setItem('inkwell-treesize-13-v1', '1');
      }
    } else {
      // Fresh install: mark all migrations done so they never bump this profile;
      // the empty prefs then fall back to the defaults (Roboto Mono, editor 13).
      localStorage.setItem('inkwell-fontsize-bump-v1', '1');
      localStorage.setItem('inkwell-editorsize-15-v1', '1');
      localStorage.setItem('inkwell-treesize-13-v1', '1');
    }
    return prefs;
  } catch(_) { return {}; }
}

// Load the custom themes (~/.amelie/themes/*.css): inject the <style>, register
// the theme in THEMES and create the card in the grid (generic preview with the
// colors read from the CSS variables, if found).
const _customThemeIds = new Set();   // ids loaded from the themes folder

// Full re-scan from disk: drop every previously injected custom style, card
// and registration, then load fresh. Called when the Theme tab opens, so new
// files/blocks (and color edits) show up WITHOUT restarting the app.
async function reloadCustomThemes() {
  document.querySelectorAll('style[data-custom-theme]').forEach(s => s.remove());
  document.querySelectorAll('.theme-card[data-custom="1"]').forEach(c => c.remove());
  _customThemeIds.forEach(id => { delete THEMES[id]; });
  _customThemeIds.clear();
  await loadCustomThemes();
  paintAllThemePreviews();
  // The active theme may be a custom one that was just re-injected (or edited):
  // re-apply so the new values take effect immediately.
  if (state.theme && _customThemeIds.has(state.theme)) applyTheme(state.theme);
  // Keep the card highlight in sync.
  document.querySelectorAll('.theme-card').forEach(c =>
    c.classList.toggle('active', c.dataset.theme === state.theme));
}

async function loadCustomThemes() {
  let list = [];
  try { list = await window.inkwell.themes?.list?.() || []; } catch (_) { return; }
  if (!list.length) return;
  const grid = document.querySelector('.theme-grid');
  // `inject` (the whole file's CSS) comes only on the first entry of each
  // file; we inject it at the first id NOT conflicting with builtin themes, so a
  // file that only redefines builtin themes doesn't override them.
  let pendingInject = null;
  for (const t of list) {
    if (t.inject) pendingInject = t.inject;
    if (THEMES[t.id]) continue;            // don't override builtin themes
    if (pendingInject) {
      const style = document.createElement('style');
      style.dataset.customTheme = t.id;
      style.textContent = pendingInject;
      document.head.appendChild(style);
      pendingInject = null;
    }
    THEMES[t.id] = { label: t.id, attr: t.id };
    _customThemeIds.add(t.id);
    if (!grid) continue;
    // Colors for the card preview (best effort from the theme's CSS)
    const pick = (v, fb) => (t.css.match(new RegExp('--' + v + '\\s*:\\s*([^;]+);')) || [])[1]?.trim() || fb;
    const bg0 = pick('bg-0', '#0d1117'), bg1 = pick('bg-1', '#161b22');
    const acc = pick('accent', '#3fb950'), tx = pick('text-1', '#8b949e');
    // Heading colors so the card preview reflects the h1/h2/h3 the user set.
    const h1 = pick('h1', acc), h2 = pick('h2', h1), h3 = pick('h3', h2);
    const lnk = pick('link', acc);
    const card = document.createElement('div');
    card.className = 'theme-card';
    card.dataset.theme = t.id;
    card.dataset.custom = '1';
    card.title = t.id + ' (custom)';
    card.innerHTML =
      `<div class="theme-preview">
         <div class="tp-sidebar" style="background:${bg1}"></div>
         <div class="tp-editor" style="background:${bg0}">
           <div class="tp-line accent" style="background:${h1}"></div>
           <div class="tp-line dim" style="background:${tx}"></div>
           <div class="tp-line short" style="background:${h2}"></div>
           <div class="tp-line dim" style="background:${tx}"></div>
           <div class="tp-line short" style="background:${lnk}"></div>
         </div>
       </div>
       <div class="theme-name">${t.id}</div>`;
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      applyTheme(t.id, { resetCustomColors: true });
    });
    // ✎ edit — opens the theme's css file in the system editor.
    const edit = document.createElement('button');
    edit.className = 'theme-edit-btn';
    edit.textContent = '✎';
    edit.title = window.i18n.t('theme.edit_theme');
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      window.inkwell.themes?.edit?.(t.id);
    });
    card.appendChild(edit);
    // ✕ delete — custom themes only (builtin cards never get one).
    const del = document.createElement('button');
    del.className = 'theme-delete-btn';
    del.textContent = '✕';
    del.title = window.i18n.t('theme.delete_theme');
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!(await showConfirmModal(window.i18n.t('theme.delete_confirm').replace('%s', t.id)))) return;
      const res = await window.inkwell.themes?.delete?.(t.id);
      if (!res?.ok) return;
      document.querySelector(`style[data-custom-theme="${t.id}"]`)?.remove();
      delete THEMES[t.id];
      _customThemeIds.delete(t.id);
      card.remove();
      // Deleting the active theme falls back to the default one.
      if (state.theme === t.id) {
        applyTheme('github-dark');
        document.querySelectorAll('.theme-card').forEach(c =>
          c.classList.toggle('active', c.dataset.theme === 'github-dark'));
      }
    });
    card.appendChild(del);
    grid.appendChild(card);
  }
}

// Read a theme's declared palette straight from the CSS rules (not computed, so
// user color-overrides on :root don't leak in). Built-ins live in style.css as
// [data-theme="x"] (or :root for the default); custom ones in their injected
// <style>. Used to paint every card preview accurately.
function _themeVarsFromCss(themeId) {
  const attr = (THEMES[themeId] && THEMES[themeId].attr) || '';
  const sel = attr ? '[data-theme="' + attr + '"]' : ':root';
  const props = ['--bg-0', '--bg-1', '--accent', '--text-1', '--h1', '--h2', '--h3', '--link'];
  const out = {};
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch (_) { continue; }
    for (const rule of rules) {
      if (!rule.selectorText) continue;
      if (!rule.selectorText.split(',').map(s => s.trim()).includes(sel)) continue;
      for (const p of props) { const v = rule.style.getPropertyValue(p); if (v) out[p] = v.trim(); }
    }
  }
  return out;
}

// Repaint EVERY theme-card preview (built-in + custom) from the real palette, so
// each card matches its theme (the old static swatches had drifted, e.g. navy).
function paintAllThemePreviews() {
  document.querySelectorAll('.theme-card').forEach(card => {
    const pv = card.querySelector('.theme-preview'); if (!pv) return;
    const v = _themeVarsFromCss(card.dataset.theme);
    const acc = v['--accent'], tx = v['--text-1'];
    const set = (selc, col) => { const el = pv.querySelector(selc); if (el && col) el.style.background = col; };
    set('.tp-sidebar', v['--bg-1']);
    set('.tp-editor', v['--bg-0']);
    const cols = [v['--h1'] || acc, tx, v['--h2'] || v['--h1'] || acc, tx, v['--link'] || acc];
    pv.querySelectorAll('.tp-line').forEach((ln, i) => { if (cols[i]) ln.style.background = cols[i]; });
  });
}

function applyTheme(key, opts = {}) {
  state.theme = key;
  const attr = THEMES[key]?.attr ?? '';
  if (attr) document.documentElement.setAttribute('data-theme', attr);
  else document.documentElement.removeAttribute('data-theme');
  // A user-initiated switch drops the custom color overrides: they're inline
  // :root vars, which would win over the palette of EVERY theme. At startup
  // (no opt) the saved overrides are kept — they're deliberate tweaks on top
  // of the saved theme.
  if (opts.resetCustomColors) clearCustomColorOverrides();
  // persist
  try { localStorage.setItem('inkwell-theme', key); } catch(_) {}
}

function setupTheme() {
  // Custom themes from ~/.amelie/themes: inject the CSS, register in THEMES and
  // adds a card for each one. Then restore the saved theme (which can
  // be custom, so the custom ones are loaded FIRST).
  loadCustomThemes().finally(() => {
    const savedTheme = (() => { try { return localStorage.getItem('inkwell-theme'); } catch(_) { return null; } })();
    applyTheme(savedTheme && THEMES[savedTheme] ? savedTheme : 'github-dark');
    paintAllThemePreviews();
  });

  // Restore saved appearance
  applyAppearance(loadAppearance());

  // Wire theme cards
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.theme-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      applyTheme(card.dataset.theme, { resetCustomColors: true });
    });
  });

  // "Add theme" → main creates a ready-to-edit my-theme-N.css and opens it in
  // the system editor; the new card shows up immediately (loadCustomThemes is
  // re-runnable: already-known ids are skipped).
  document.getElementById('btn-add-theme')?.addEventListener('click', async () => {
    const res = await window.inkwell.themes?.create?.();
    if (res?.ok) await loadCustomThemes();
    else if (res?.error === 'limit') showToast(window.i18n.t('theme.limit_reached'));
  });

  // Coming back from an external editor (you saved the theme's .css)? If the Theme
  // tab is open, re-scan the themes from disk so edits/new themes show up
  // immediately, without switching tabs or restarting Amelie.
  window.addEventListener('focus', () => {
    const modal = document.getElementById('settings-modal');
    const panel = document.getElementById('tab-theme');
    if (modal && modal.style.display !== 'none' && panel && panel.classList.contains('active')) {
      reloadCustomThemes();
    }
  });

  // Wire font dropdown
  setupFontDropdown();
  setupDrawLocation();
  setupLangDropdown();

  // Wire the numeric appearance dropdowns (font size, spacing, icon size, …)
  setupNumberDropdowns();
}

// (Sync interval is now per-section: backup frequency in the Local section and
//  the two-way sync frequency in its own section — see openSettings/saveSettings.)

// ─── Init ─────────────────────────────────────────────────────────────────────
let _sessionReady = false;
function saveSession() {
  if (!_sessionReady) return;
  try {
    // `paths` drops pathless tabs (mindmap / unsaved new note), so `activeIdx`
    // (an index into the FULL tabs array) can point PAST the restored set and
    // land you on the wrong tab. Also record the active tab by PATH and TYPE so
    // restore can find it unambiguously (and re-open the mindmap if it was active).
    const active = tabs[activeTabIdx];
    localStorage.setItem('amelie-session', JSON.stringify({
      paths: tabs.map(t => t.path).filter(Boolean),
      activeIdx: activeTabIdx,
      activePath: active && active.path ? active.path : null,
      activeType: active && active.type ? active.type : null,
    }));
  } catch(_) {}
}

async function restoreSession() {
  try {
    const raw = localStorage.getItem('amelie-session');
    if (!raw) {
      // No previous session (first run): open the most recent note so the user
      // lands on content — the "Welcome" note on a fresh vault — not a blank app.
      const notes = flattenTree(state.notes).filter(n => !n.type || n.type === 'note');
      if (notes.length) {
        notes.sort((a, b) => (b.modified || 0) - (a.modified || 0));
        openTab(notes[0], false);
        renderTabBar();
        await switchTab(tabs.length - 1);
      }
      return;
    }
    const { paths = [], activePath, activeType } = JSON.parse(raw);
    const flat = flattenTree(state.notes);
    // Restore ONLY plain notes, and LAZILY (activate=false): create the tab in the
    // bar but don't read/render its file. Drawings, PDFs, images, audio/video and the
    // mindmap are intentionally NOT reopened at startup (user preference: notes only) —
    // this also avoids building the mindmap during init, which could error.
    for (const path of paths) {
      const node = flat.find(n => n.path === path);
      if (node && (!node.type || node.type === 'note')) openTab(node, false);
    }
    if (tabs.length === 0) { renderTabBar(); return; }
    // Land on the note that was active (matched by path). If the active tab was a
    // drawing / PDF / image / player / mindmap (not restored), fall back to the LAST note.
    let idx = (activePath && (!activeType || activeType === 'note'))
      ? tabs.findIndex(t => t.path === activePath) : -1;
    if (idx < 0) idx = tabs.length - 1;
    await switchTab(idx);
  } catch(_) {}
}

// Gentle 254-char cap on EVERY user input (note/folder names, passwords, search,
// settings fields, table cells, inline renames…). 254 < the filesystem's 255-byte
// limit, so names never error. The note BODY editor (a <textarea>) is exempt —
// only single-line <input>s and contenteditable fields are capped.
const INPUT_MAX = 254;
function enforceInputLimits() {
  const NOCAP = new Set(['checkbox', 'radio', 'color', 'range', 'file', 'hidden', 'submit', 'button', 'image']);
  const cap = (el) => { if (el.tagName === 'INPUT' && !NOCAP.has(el.type) && el.maxLength < 0) el.maxLength = INPUT_MAX; };
  document.querySelectorAll('input').forEach(cap);
  // Catch inputs created later (rename prompts, dynamic forms).
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      cap(n);
      if (n.querySelectorAll) n.querySelectorAll('input').forEach(cap);
    }
  }).observe(document.body, { childList: true, subtree: true });
  // contenteditable fields (inline renames, table cells): gently truncate at the cap.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el && el.isContentEditable && el.textContent.length > INPUT_MAX) {
      el.textContent = el.textContent.slice(0, INPUT_MAX);
      try { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (_) {}
    }
  }, true);
}

async function init() {
  // i18n must be first — applies saved language before any UI renders
  window.i18n.initI18n();
  maybeShowLangSetup();   // first run only: ask the user to pick a language
  applyCustomColors(); // restore any saved color overrides
  applyFolderIconStyle(loadFolderIconStyle()); // restore folder icon style early
  enforceInputLimits();   // gentle 254-char cap on all user inputs
  attachNameGuard(noteTitle);   // block forbidden filename chars in the note title
  // Samba fields: share name = strict name allowlist; remote folder = same but
  // keeps "/" (it's a path). Username/password are credentials — left untouched.
  attachNameGuard($('cfg-smb-share'));
  attachNameGuard($('tw-smb-share'));
  attachNameGuard($('cfg-smb-path'), { test: FORBIDDEN_PATH_RE, strip: FORBIDDEN_PATH_RE_G });
  attachNameGuard($('tw-smb-path'),  { test: FORBIDDEN_PATH_RE, strip: FORBIDDEN_PATH_RE_G });
  // Username fields (Samba + OpenVPN): block special chars too, per request.
  attachNameGuard($('cfg-smb-user'));
  attachNameGuard($('tw-smb-user'));
  attachNameGuard($('cfg-ovpn-user'));
  attachNameGuard($('tw-ovpn-user'));
  // WebDAV (backup + sync): username strict; remote folder = path set (keeps "/");
  // server URL = URL set (keeps :/?#@…, blocks spaces/quotes/backtick). Passwords free.
  attachNameGuard($('cfg-webdav-user'));
  attachNameGuard($('tw-webdav-user'));
  attachNameGuard($('cfg-webdav-path'), { test: FORBIDDEN_PATH_RE, strip: FORBIDDEN_PATH_RE_G });
  attachNameGuard($('tw-webdav-path'),  { test: FORBIDDEN_PATH_RE, strip: FORBIDDEN_PATH_RE_G });
  attachNameGuard($('cfg-webdav-url'), { test: FORBIDDEN_URL_RE, strip: FORBIDDEN_URL_RE_G });
  attachNameGuard($('tw-webdav-url'),  { test: FORBIDDEN_URL_RE, strip: FORBIDDEN_URL_RE_G });
  // Local backup folder = filesystem path (keeps "/").
  attachNameGuard($('cfg-local-path'), { test: FORBIDDEN_PATH_RE, strip: FORBIDDEN_PATH_RE_G });

  // Block dragging TEXT (or images) OUT of the app. Only the app's OWN element
  // drags are allowed to start — tabs, tree rows, attachments, todo cards etc.
  // all set draggable="true"; a text-selection drag has no such ancestor, so we
  // cancel it. Selection + Ctrl+C still work; only the drag gesture is stopped.
  document.addEventListener('dragstart', (e) => {
    const t = e.target;
    if (!(t && t.closest && t.closest('[draggable="true"]'))) e.preventDefault();
  }, true);

  // Global safety net: the app shell (<html>/<body>) must NEVER scroll — at
  // fractional device-pixel-ratios (hi-DPI monitors) sub-pixel overflow can make
  // it 1–2px scrollable, and any scrollIntoView() can then drag the titlebar
  // (tabs/settings) and status bar out of view. Snap it back whenever it moves.
  const _pinShell = () => {
    if (document.documentElement.scrollTop || document.documentElement.scrollLeft) {
      document.documentElement.scrollTop = 0; document.documentElement.scrollLeft = 0;
    }
    if (document.body.scrollTop || document.body.scrollLeft) {
      document.body.scrollTop = 0; document.body.scrollLeft = 0;
    }
  };
  window.addEventListener('scroll', _pinShell, true);

  setupFileDrop();
  setupTheme();
  setupViewWidth();
  setupLineNumbers();
  setupEditorToolbarToggle();
  setupFolderGuides();
  setupAudioRecording();
  setupGpuToggle();

  // Load the event-notification log BEFORE the unlock gate: a wrong-password
  // notification fired during unlock must merge into the saved history, not
  // overwrite it (setupSidebarViews loads it again later — harmless reload).
  _loadEventNotifs();

  // Check if vault is encrypted and needs unlock
  await checkVaultLock();

  state.config = await window.inkwell.readConfig();
  updateSyncButtonVisibility();   // show Backup (and Sync only if two-way) as soon as config is known
  await loadTree();
  await restoreSession();
  _sessionReady = true;
  window.addEventListener('beforeunload', saveSession);
  setupFrontmatter();
  setupEditor();
  _setupCmToggle();  // wipes stale opt-out keys (no toggle anymore — CM is the only editor)
  _initCmEditor();   // CM engine — the ONLY editor; always on (bails only if the bundle is missing)
  setupTOC();
  setupExportPdf();
  setupMindmap();
  setupCanvas();
  setupNoteSearch();
  setupTableContextMenu();
  setupImageContextMenu();
  setupSettings();
  setupSync();
  setupSearch();
  setupContextMenu();
  setupViewColorBubble();
  setupLinkHoverHint();
  setupColorPalette();
  setupTooltips();
  setupTabContextMenu();
  setupBookmarkContextMenu();
  setupCrumbContextMenu();
  setupSplitView();
  setupResize();
  setupWindowDrag();
  loadShortcuts();
  updateToolbarShortcutTips();   // seed Bold/Italic tooltips from saved shortcuts
  document.addEventListener('amelie:lang-changed', updateToolbarShortcutTips);
  // Re-seed after the first paint too: at init i18n may not have applied yet, so
  // the tooltips would otherwise stay empty until a language switch.
  requestAnimationFrame(() => { try { updateToolbarShortcutTips(); } catch (_) {} });
  setupKeyboard();
  setupTodo();
  setupSidebarViews();
  // One-shot check for the optional system tools the network features need.
  setTimeout(() => { checkDepsOnStartup().catch(() => {}); }, 2500);
}

// Detect the missing optional system tool (the OpenVPN NM plugin — Samba sync
// uses the bundled amelie-smb helper, no system smbclient needed) and offer to
// install it via the package manager (pkexec password prompt — no terminal).
// Asks at most once per distinct missing-set (tracked in localStorage).
async function checkDepsOnStartup() {
  let d;
  try { d = await window.inkwell.deps.check(); } catch (_) { return; }
  if (!d || !Array.isArray(d.missing) || !d.missing.length) return;
  const labels = d.missing.map(m => m.label).join(', ');
  const sig = d.missing.map(m => m.key).sort().join(',');
  const ASKED = 'amelie-deps-asked';
  // Surface as a transient toast (NOT the bell — the notifications bell is
  // reserved for backup/sync failures and to-do deadlines).
  showToast('✗ ' + window.i18n.t('deps.missing_notif') + ': ' + labels);
  if (localStorage.getItem(ASKED) === sig) return;   // already asked for this set
  localStorage.setItem(ASKED, sig);
  if (!d.installCmd) return;   // unknown distro → notification only
  const msg = window.i18n.t('deps.prompt')
    .replace('{list}', d.missing.map(m => '• ' + m.label).join('\n'))
    .replace('{cmd}', d.installCmd);
  if (!confirm(msg)) return;
  const r = await window.inkwell.deps.install({ installCmd: d.installCmd });
  if (r && r.ok) {
    showToast('✓ ' + window.i18n.t('deps.installed'));
    localStorage.removeItem(ASKED);
  } else {
    showToast('✗ ' + window.i18n.t('deps.install_failed') + (r && r.error ? ': ' + r.error : ''));
  }
}

// ─── File Tree ────────────────────────────────────────────────────────────────
async function loadTree() {
  await loadTreeOrderFromVault();
  state.notes = applyManualOrder(await window.inkwell.listNotes(), '');
  pruneSidebarOrphans();
  requestAnimationFrame(() => renderTree());
}

// Remove Recent/Bookmark entries whose note no longer exists in the tree
// (deleted / renamed / moved). Keyed by path, so a stale path lingers forever
// otherwise. Runs on every loadTree (unlock + refresh). GUARD: skip if the tree
// is empty — a transient listNotes() failure must NOT wipe every saved entry.
function pruneSidebarOrphans() {
  try {
    if (!state.notes || !state.notes.length) return;
    for (const key of [RECENT_KEY, BOOKMARKS_KEY]) {
      const list = _lsGet(key);
      if (!list.length) continue;
      const kept = list.filter(it => it && it.path && _findNode(it.path));
      if (kept.length !== list.length) _lsSet(key, kept);
    }
  } catch (_) {}
}

// Scroll a tree node (by its data-path) into view and briefly flash it. Waits
// two frames because loadTree() renders the tree on the next animation frame.
function _revealTreeNode(treePath) {
  if (!treePath || !fileTree) return;
  const sel = (window.CSS && CSS.escape) ? CSS.escape(treePath) : treePath;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = fileTree.querySelector(`[data-path="${sel}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('tree-flash');
    setTimeout(() => el.classList.remove('tree-flash'), 1600);
  }));
}

function makeTodoTreeEntry() {
  const row = document.createElement('div');
  row.className = 'tree-folder todo-tree-entry' + (_kanbanOpen ? ' active' : '');
  // Folder-with-checklist icon: a folder shape with a small check, so the ToDo
  // entry reads clearly as "the todo folder" and looks consistent with the
  // other folders in the tree.
  row.innerHTML = '<span class="tree-folder-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M9 13l2 2 4-4"/></svg></span><span class="tree-name">ToDo</span>';
  row.addEventListener('click', () => { openKanban(); document.querySelectorAll('.todo-tree-entry').forEach(e => e.classList.add('active')); });
  return row;
}

function renderTree() {
  // Live-refresh the graph if it's on screen and the tree structure changed
  // (move/rename/add/delete, incl. external vault edits — loadTree ends here,
  // and drag-moves call renderTree directly). No-op otherwise.
  try { refreshMindmapIfActive(); } catch (_) {}
  const query = state.searchQuery.toLowerCase();
  fileTree.innerHTML = '';
  // The "ToDo" entry is no longer shown in the tree: the ToDo board is
  // reachable from the icon in the sections bar at the top.
  const filtered = query ? filterTree(state.notes, query) : state.notes;
  if (filtered.length === 0) {
    fileTree.innerHTML = '<div style="padding:14px;color:var(--text-3);font-size:12px;font-style:italic">' + escHtml(window.i18n.t('canvas.empty')) + '</div>';
    return;
  }
  renderNodes(filtered, fileTree);
  persistOpenFolders();
}

// A vault file that lives in attachments/ — PDF, photo, audio, video — as opposed to a
// note or drawing on disk. They are renamed and deleted through the attachment API,
// only ever REORDER in the tree (never move into a folder), and have none of the
// note-only extras (duplicate, colour, emoji). One predicate instead of a chain of
// `type === 'pdf' || type === 'image'` comparisons, so a new kind can't be forgotten
// at one of the dozen places that ask this question.
const ATTACH_NODE_TYPES = new Set(['pdf', 'image', 'audio', 'video']);
const isAttachNode = (n) => !!n && ATTACH_NODE_TYPES.has(n.type);

// A term the user means as an extension: `.draw`, `.pdf`, `.PNG`. Matched against the
// REAL file name, because the tree's `name` has the extension stripped for notes and
// drawings (main.js builds it that way) while PDFs and images keep theirs — so before
// this `.pdf`/`.png` filtered by accident and `.draw`/`.md` could not work at all.
// Only a leading dot triggers it: a bare `md` or `png` keeps matching names only,
// which is what stops every note in the vault from answering a 2-letter word.
const isExtTerm = (t) => /^\.[a-z0-9]+$/i.test(t);
function filterTree(nodes, q) {
  // Multi-word: all terms must appear somewhere in the name
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const n of nodes) {
    if (n.type === 'folder') {
      const children = filterTree(n.children, q);
      if (children.length) results.push({ ...n, children });
    } else {
      const nameLower = n.name.toLowerCase();
      // `path` carries the on-disk name with its extension (`notes/sketch.draw`).
      const fileLower = String(n.path || '').toLowerCase().split('/').pop();
      const dot = fileLower.lastIndexOf('.');
      const extLower = dot >= 0 ? fileLower.slice(dot) : '';
      // A dotted term matches the extension by PREFIX, so the list narrows as you type:
      // `.d` already shows the drawings, `.p` the PDFs and photos, `.dr` just the
      // drawings. Matching the whole extension meant `.d`, `.dr` and `.dra` all answered
      // nothing and you had to type `.draw` in full before seeing anything.
      if (terms.every(t => nameLower.includes(t) || (isExtTerm(t) && extLower.startsWith(t)))) results.push(n);
    }
  }
  return results;
}

function renderNodes(nodes, container, folderPath = '') {
  for (const node of nodes) {
    if (node.type === 'folder') {
      container.appendChild(makeFolderEl(node, nodes, folderPath));
    } else {
      container.appendChild(makeNoteEl(node, nodes, folderPath));
    }
  }
}

function findAndRemoveFromTree(srcPath, nodes) {
  const idx = nodes.findIndex(n => n.path === srcPath);
  if (idx !== -1) return { node: nodes.splice(idx, 1)[0], parentArr: nodes };
  for (const n of nodes) {
    if (n.type === 'folder' && n.children) {
      const found = findAndRemoveFromTree(srcPath, n.children);
      if (found) return found;
    }
  }
  return null;
}

function updateNodePaths(node, oldPath, newPath) {
  if (node.path === oldPath) node.path = newPath;
  else if (node.path?.startsWith(oldPath + '/')) node.path = newPath + '/' + node.path.slice(oldPath.length + 1);
  if (node.children) node.children.forEach(c => updateNodePaths(c, oldPath, newPath));
}

async function moveFolderOnDisk(oldPath, newPath) {
  if (oldPath === newPath) return;
  await _flushBeforePathChange(oldPath);   // flush + disarm autosave so no ghost file mid-move
  await window.inkwell.renameNote(oldPath, newPath);
  renameInTreeOrder(oldPath, newPath);   // remap the moved folder's children order
  if (_cmLoadedPath === oldPath) _cmLoadedPath = newPath;
  else if (_cmLoadedPath && _cmLoadedPath.startsWith(oldPath + '/')) _cmLoadedPath = newPath + '/' + _cmLoadedPath.slice(oldPath.length + 1);
  tabs.forEach(t => {
    if (!t.path) return;
    if (t.path === oldPath) t.path = newPath;
    else if (t.path.startsWith(oldPath + '/')) t.path = newPath + '/' + t.path.slice(oldPath.length + 1);
  });
  if (state.currentPath === oldPath) state.currentPath = newPath;
  else if (state.currentPath?.startsWith(oldPath + '/')) state.currentPath = newPath + '/' + state.currentPath.slice(oldPath.length + 1);
  const newOpenFolders = new Set();
  state.openFolders.forEach(p => {
    if (p === oldPath) newOpenFolders.add(newPath);
    else if (p.startsWith(oldPath + '/')) newOpenFolders.add(newPath + '/' + p.slice(oldPath.length + 1));
    else newOpenFolders.add(p);
  });
  state.openFolders = newOpenFolders;
  renderTabBar();
}

function makeFolderEl(node, parentArray, folderPath = '') {
  const folderKey = node.path || node.name;
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'tree-folder';
  row.dataset.folder = folderKey;
  const folderColorKey = noteColors[node.path];
  if (folderColorKey) row.dataset.color = folderColorKey;
  row.innerHTML = `<span class="tree-folder-icon">
    <svg class="folder-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>
    <svg class="folder-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16"><path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"/></svg>
    <svg class="fi-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M9 6l6 6-6 6"/></svg>
    <svg class="fi-graphene" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" width="16" height="16"><path d="M12 2.5l8 4.6v9.8l-8 4.6-8-4.6V7.1z"/></svg>
    <svg class="fi-dot" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="4.5"/></svg>
    <svg class="fi-star" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" width="16" height="16"><polygon points="12 2.5 14.85 8.3 21.2 9.25 16.6 13.75 17.7 20.1 12 17.1 6.3 20.1 7.4 13.75 2.8 9.25 9.15 8.3"/></svg>
  </span><span class="tree-name">${escHtml(node.name)}</span>`;

  const children = document.createElement('div');
  children.className = 'tree-folder-children';

  // Restore open state
  const isOpen = state.openFolders.has(folderKey);
  if (isOpen) { row.classList.add('open'); children.style.display = 'block'; }
  else { children.style.display = 'none'; }

  // Lazy children: a folder's contents are put in the DOM only when it's OPEN.
  // A collapsed folder keeps ZERO child DOM — on big vaults this collapses the
  // node count/RAM (previously children were rendered even when collapsed, just
  // hidden with display:none). Rendered once on first open, then kept.
  let _childrenRendered = false;
  const ensureChildren = () => {
    if (!_childrenRendered && node.children?.length) {
      renderNodes(node.children, children, node.path);
      _childrenRendered = true;
    }
  };
  // Restore selected state (the folder a new note will be created into).
  if (state.selectedFolder === node.path) row.classList.add('selected');

  let folderClickAllowed = true;
  row.addEventListener('click', () => {
    if (!folderClickAllowed) return;
    const open = row.classList.toggle('open');
    if (open) ensureChildren();   // lazy: build child DOM only on first expand
    children.style.display = open ? 'block' : 'none';
    if (open) state.openFolders.add(folderKey);
    else state.openFolders.delete(folderKey);
    persistOpenFolders();
    // Mark this folder as the active one: a new note (＋ / Ctrl+N) lands here.
    state.selectedFolder = node.path;
    document.querySelectorAll('.tree-folder.selected').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
  });
  row.addEventListener('contextmenu', e => showContextMenu(e, node));

  // Folder drag (reorder)
  row.setAttribute('draggable', 'true');
  row.style.pointerEvents = 'auto';
  row.addEventListener('dragstart', e => {
    folderClickAllowed = false;
    state.draggingFolder = true;
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
    row.style.opacity = '0.5';
    e.stopPropagation();
  });
  row.addEventListener('dragend', () => {
    state.draggingFolder = false;
    row.style.opacity = '';
    setTimeout(() => { folderClickAllowed = true; }, 0);
  });

  // Accept note drops (move into folder) or folder drops (inside / reorder)
  row.addEventListener('dragover', e => {
    if (!state.draggingNote && !state.draggingFolder) return;
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('drag-over-folder', 'drag-over-top', 'drag-over-bottom');
    // Both notes AND folders can now land above / inside / below a folder: the
    // top and bottom thirds reorder at the folder's level (so a note can sit
    // ABOVE the folder), the middle third drops INTO it.
    const rect = row.getBoundingClientRect();
    const relY = (e.clientY - rect.top) / rect.height;
    if (relY < 0.3) row.classList.add('drag-over-top');
    else if (relY > 0.7) row.classList.add('drag-over-bottom');
    else row.classList.add('drag-over-folder');
  });
  row.addEventListener('dragleave', e => {
    e.stopPropagation();
    row.classList.remove('drag-over-folder', 'drag-over-top', 'drag-over-bottom');
  });
  row.addEventListener('drop', async e => {
    if (!state.draggingNote && !state.draggingFolder) return;
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('drag-over-folder', 'drag-over-top', 'drag-over-bottom');
    const srcPath = e.dataTransfer.getData('text/plain');

    if (state.draggingNote) {
      state.draggingNote = false;
      if (srcPath === node.path) return;
      const rect = row.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;
      const dropInside = relY >= 0.3 && relY <= 0.7;
      const found = findAndRemoveFromTree(srcPath, state.notes);
      if (!found) return;
      const moved = found.node;
      const fileName = moved.path.split('/').pop();
      const srcParent = srcPath.split('/').slice(0, -1).join('/');
      // Helper: move the note on disk to `destParent` (rename), keeping tab + colour in sync.
      const relocate = async destParent => {
        const newPath = destParent ? `${destParent}/${fileName}` : fileName;
        if (newPath === moved.path) return;
        await _flushBeforePathChange(moved.path);   // no ghost file / lost edits mid-move
        await window.inkwell.renameNote(moved.path, newPath);
        migrateNoteColorPath(moved.path, newPath);   // keep the label colour across the move
        if (_cmLoadedPath === moved.path) _cmLoadedPath = newPath;
        const tab = tabs.find(t => t.path === moved.path);
        if (tab) { tab.path = newPath; if (state.currentPath === moved.path) state.currentPath = newPath; renderTabBar(); }
        moved.path = newPath;
      };
      if (dropInside) {
        // Middle third → move INTO this folder (appended at the end).
        await relocate(node.path);
        node.children = node.children || [];
        node.children.push(moved);
        state.openFolders.add(node.path || node.name);
        saveManualOrder(node.path, node.children);
      } else {
        // Top / bottom third → place the note ABOVE / BELOW the folder at the
        // folder's OWN level (this is what lets a note sit above the folders).
        await relocate(folderPath);
        const arr = parentArray || state.notes;
        const dstIdx = arr.findIndex(n => n.path === node.path);
        if (dstIdx === -1) arr.push(moved); else arr.splice(relY > 0.7 ? dstIdx + 1 : dstIdx, 0, moved);
        saveManualOrder(folderPath, arr);
      }
      if (found.parentArr && found.parentArr !== node.children && found.parentArr !== (parentArray || state.notes)) {
        saveManualOrder(srcParent, found.parentArr);
      }
      renderTree();
    } else if (state.draggingFolder) {
      state.draggingFolder = false;
      if (srcPath === node.path || node.path.startsWith(srcPath + '/')) return; // prevent drop into self/descendant
      const found = findAndRemoveFromTree(srcPath, state.notes);
      if (!found) return;
      const moved = found.node;
      const rect = row.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / rect.height;

      const srcParent = srcPath.split('/').slice(0, -1).join('/');
      let destLevel, destArr;
      if (relY >= 0.3 && relY <= 0.7) {
        // Drop INSIDE: move folder into this folder
        const folderName = moved.path.split('/').pop();
        const newPath = `${node.path}/${folderName}`;
        updateNodePaths(moved, moved.path, newPath);
        await moveFolderOnDisk(srcPath, newPath);
        node.children = node.children || [];
        node.children.push(moved);
        state.openFolders.add(node.path || node.name);
        destLevel = node.path; destArr = node.children;
      } else {
        // Reorder at same level — also move on disk if parent changes
        const arr = parentArray || state.notes;
        const insertAfter = relY > 0.7;
        const dstIdx = arr.findIndex(n => n.path === node.path);
        if (dstIdx === -1) arr.push(moved); else arr.splice(insertAfter ? dstIdx + 1 : dstIdx, 0, moved);
        const folderName = moved.path.split('/').pop();
        const targetParent = node.path.split('/').slice(0, -1).join('/');
        const newPath = targetParent ? `${targetParent}/${folderName}` : folderName;
        if (newPath !== srcPath) {
          updateNodePaths(moved, srcPath, newPath);
          await moveFolderOnDisk(srcPath, newPath);
        }
        destLevel = targetParent; destArr = arr;
      }
      // Persist the interleaved order at the destination (and source) level so the
      // folder's new position — including a folder placed below a note — sticks.
      saveManualOrder(destLevel, destArr);
      if (found.parentArr && found.parentArr !== destArr) saveManualOrder(srcParent, found.parentArr);
      renderTree();
    }
  });

  wrap.appendChild(row);

  if (isOpen) ensureChildren();   // lazy: only an already-open folder renders its children now
  wrap.appendChild(children);
  return wrap;
}

function makeNoteEl(node, parentArray, folderPath = '') {
  const el = document.createElement('div');
  const isActive = node.path === state.currentPath;
  el.className = 'tree-note' + (isActive ? ' active' : '');
  const colorKey = noteColors[node.path];
  if (colorKey) el.dataset.color = colorKey;
  // Show the file extension explicitly for PDFs (since the icon has been
  // removed) so the user can still tell them apart from regular notes.
  const displayName = node.type === 'draw'
    ? node.name + '.draw'
    : node.type === 'pdf'
      ? (/\.pdf$/i.test(node.name) ? node.name : node.name + '.pdf')
      : node.name;
  el.innerHTML = `<span class="tree-name">${escHtml(displayName)}</span>`;
  el.dataset.path = node.path;

  el.addEventListener('click', () => openNote(node));
  el.addEventListener('contextmenu', e => showContextMenu(e, node));

  // Files (notes, draws, pdfs, images) are all freely re-orderable via drag.
  // PDFs/images live in attachments/ on disk, so they only ever REORDER — they
  // are never renamed/moved into a folder (unlike notes/draws).
  const isAttach = isAttachNode(node);

  el.setAttribute('draggable', 'true');
  // Drag & drop reorder
  el.addEventListener('dragstart', e => {
    if (isAttach) state.draggingAttach = true; else state.draggingNote = true;
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
    el.style.opacity = '0.5';
    e.stopPropagation();
  });
  el.addEventListener('dragend', e => {
    state.draggingNote = false;
    state.draggingAttach = false;
    el.style.opacity = '';
    e.stopPropagation();
  });
  el.addEventListener('dragover', e => {
    if (!state.draggingNote && !state.draggingAttach && !state.draggingFolder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = el.getBoundingClientRect();
    const isTop = e.clientY < rect.top + rect.height / 2;
    el.classList.toggle('drag-over-top', isTop);
    el.classList.toggle('drag-over-bottom', !isTop);
  });
  el.addEventListener('dragleave', e => {
    e.stopPropagation();
    el.classList.remove('drag-over-top', 'drag-over-bottom');
  });
  el.addEventListener('drop', async e => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over-top', 'drag-over-bottom');
    const srcPath = e.dataTransfer.getData('text/plain');
    const wasNote = state.draggingNote, wasAttach = state.draggingAttach, wasFolder = state.draggingFolder;
    state.draggingNote = state.draggingAttach = state.draggingFolder = false;
    if (srcPath === node.path) { renderTree(); return; }
    const found = findAndRemoveFromTree(srcPath, state.notes);
    if (!found) return;
    const moved = found.node;
    const srcFolder = srcPath.split('/').slice(0, -1).join('/');
    const arr = parentArray || state.notes;
    const rect = el.getBoundingClientRect();
    const insertAfter = e.clientY >= rect.top + rect.height / 2;
    const dstIdx = arr.findIndex(n => n.path === node.path);
    if (dstIdx === -1) { arr.push(moved); } else {
      arr.splice(insertAfter ? dstIdx + 1 : dstIdx, 0, moved);
    }
    if (wasNote) {
      // A note/draw may have changed folder: move it on disk to THIS level.
      const fileName = moved.path.split('/').pop();
      const newPath = folderPath ? `${folderPath}/${fileName}` : fileName;
      if (newPath !== moved.path) {
        await _flushBeforePathChange(moved.path);   // no ghost file / lost edits mid-move
        await window.inkwell.renameNote(moved.path, newPath);
        migrateNoteColorPath(moved.path, newPath);   // keep the label colour across the move
        if (_cmLoadedPath === moved.path) _cmLoadedPath = newPath;
        const tab = tabs.find(t => t.path === moved.path);
        if (tab) { tab.path = newPath; if (state.currentPath === moved.path) state.currentPath = newPath; renderTabBar(); }
        moved.path = newPath;
      }
    } else if (wasFolder) {
      const folderName = moved.path.split('/').pop();
      const newPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      if (newPath !== moved.path) {
        updateNodePaths(moved, moved.path, newPath);
        await moveFolderOnDisk(moved.path, newPath);
      }
    }
    // Persist the new manual order for the affected level(s). Now saved for
    // FOLDER drops too (a folder dropped on a note reorders to this level) so the
    // interleaved folder/note order sticks. (Attach drags also reach here.)
    saveManualOrder(folderPath, arr);
    if (found.parentArr && found.parentArr !== arr) saveManualOrder(srcFolder, found.parentArr);
    renderTree();
  });
  return el;
}

// ─── Note open/save ───────────────────────────────────────────────────────────
async function openNote(node) {
  _returnToFilesView();   // leaving Recent/Bookmarks/Tags/Notifications → back to the tree
  // Opening a note clears any folder selection: from now on a new note follows
  // the open note's folder again (until the user clicks another folder).
  state.selectedFolder = null;
  document.querySelectorAll('.tree-folder.selected').forEach(r => r.classList.remove('selected'));
  if (node.type === 'draw' || node.path?.endsWith('.draw')) {
    openDrawFile(node);
    return;
  }
  if (node.type === 'pdf' || node.path?.toLowerCase().endsWith('.pdf')) {
    openPdfFile(node);
    return;
  }
  if (node.type === 'image' || node.type === 'audio' || node.type === 'video') {
    openAttachmentNode(node);      // the note that links it, or the file on its own
    return;
  }
  // Focus-based routing: with the split pane open and last focused, the
  // clicked note loads into the SPLIT pane; main tab and its note stay put.
  if (_splitPath && _focusedPane === 'split' && node.path && /\.md$/i.test(node.path)) {
    try { pushRecent(node); } catch(_) {}
    openSplitView(node.path, node.name, _splitOrient);
    return;
  }
  const prev = getActiveTab();
  if (prev?.isDirty) await saveCurrentNote();

  // Already open in a tab → reset cursor/scroll to top, then switch to it.
  // (User asked: opening a note via tree click or prev/next arrows always
  // lands the caret at the very beginning of the note.)
  const existing = tabs.findIndex(t => t.path === node.path);
  if (existing !== -1) {
    // If it's ALREADY the active tab, re-opening it would needlessly reset the
    // caret/scroll to the top (and with the CM engine that yanks the view up
    // mid-typing when something re-triggers openNote). Leave it as-is.
    if (existing === activeTabIdx) { if (typeof _cmLog === 'function') _cmLog('openNote: already active — skip reset <- ' + _cmStack()); return; }
    tabs[existing].cursorPos = 0;
    tabs[existing].scrollPos = 0;
    switchTab(existing);
    return;
  }

  // Replace the active tab in-place (single-tab navigation), but only if it's a note tab
  if (activeTabIdx !== -1 && !tabs[activeTabIdx]?.type) {
    const tab = tabs[activeTabIdx];
    tab.path     = node.path;
    tab.name     = node.name;
    tab.content  = '';
    tab.isDirty  = false;
    tab.viewMode = 'edit';
    tab.scrollPos = 0;
    tab.cursorPos = 0;
    tab.created  = node.created;
    tab.modified = node.modified;
    await switchTab(activeTabIdx);
    return;
  }

  // No tab open yet → create the first one
  openTab(node);
}

function updateNoteMeta(node) {
  if (!node) return;
  const fmt = dt => {
    if (!dt) return '—';
    const d = new Date(dt); const p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear()
      + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  const creEl = $('meta-created-line');
  const modEl = $('meta-edited-line');
  if (creEl) creEl.textContent = fmt(node.created || node.modified);
  if (modEl) modEl.textContent = fmt(node.modified);
  updateNoteNavButtons();
  // In split mode each pane carries its own dates chip — keep the main pane's
  // chip in step when the active tab changes.
  try { updatePaneMetaChips(); } catch (_) {}
}

// Notes that can be paged through with the prev/next arrows.
function _navigableNotes() {
  return flattenTree(state.notes).filter(n =>
    n.type !== 'folder' && n.path &&
    /\.(md|markdown|txt)$/i.test(n.path)
  );
}

function updateNoteNavButtons() {
  const prev = $('btn-prev-note');
  const next = $('btn-next-note');
  if (!prev || !next) return;
  const tab = getActiveTab();
  const list = _navigableNotes();
  const idx = tab?.path ? list.findIndex(n => n.path === tab.path) : -1;
  prev.disabled = (idx <= 0);
  next.disabled = (idx === -1 || idx >= list.length - 1);
}

async function navigateNote(direction) {
  const tab = getActiveTab();
  if (!tab) return;
  const list = _navigableNotes();
  const idx = list.findIndex(n => n.path === tab.path);
  if (idx === -1) return;
  const nextIdx = direction === 'next' ? idx + 1 : idx - 1;
  if (nextIdx < 0 || nextIdx >= list.length) return;
  await openNote(list[nextIdx]);
}

// ─── Frontmatter (YAML) ───────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const fm = { title: '', tags: '', source: '' };
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm, body: content };
  const yaml = match[1]; const body = match[2];
  for (const line of yaml.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    // First occurrence wins: a duplicate key (e.g. two `source:` lines) keeps the
    // FIRST value, not the last. serializeFrontmatter then writes a single line,
    // so a re-save collapses the duplicates.
    if (['title','tags','source'].includes(key) && !fm[key]) fm[key] = val.trim();
  }
  return { fm, body };
}

// An Obsidian-style date block (`---` / `created:` / `updated:` / `---`) that is
// NOT the file's real top frontmatter — e.g. one left a blank line down by an
// import, so it never gets stripped — otherwise renders horribly: the opening
// `---` becomes a horizontal rule and the `key: value` lines, "underlined" by
// the closing `---`, become a big SETEXT heading. The user just wants those
// dates shown as ordinary text. This strips the `---` fences (and any leading
// blank lines) but KEEPS the key:value lines, so they render as a normal
// paragraph instead of an <hr> + oversized heading. Only fires when every inner
// line is blank or a `key:` line, so a genuine `---` rule in prose is untouched.
function unwrapStrayFrontmatter(md) {
  return md.replace(/^\s*?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/, (m, inner) => {
    const meaningful = inner.split(/\r?\n/).filter(l => l.trim() !== '');
    if (!meaningful.length) return m;
    if (!meaningful.every(l => /^[ \t]*[\w][\w .-]*:(\s|$)/.test(l))) return m;
    return meaningful.join('\n') + '\n\n';
  });
}

// The user wants `---` to ALWAYS be a divider, never a heading. In Markdown a
// `---` line placed directly under a text line is a SETEXT heading — the text
// above becomes a big <h2> (e.g. `test` between two `---` rendered huge). We
// rewrite any such divider-under-text into `***`: an identical-width thematic
// break that is NEVER a heading, so the text above stays a normal paragraph and
// the `---` shows as the horizontal rule the user expects. Replacing each `-`
// with a `*` keeps the exact character count, so every downstream offset (TOC,
// jump-to-heading) stays valid. A `---` already acting as a rule (blank line or
// start above it) is left untouched; `===` H1 underlines are rare here and left
// as-is. marked v11's tokenizer-override can't disable lheading (a falsy return
// just falls through to the default), so this source rewrite is the reliable way.
function dividerizeSetextRules(md) {
  return md.replace(/([^\n])\n(-{3,})([ \t]*)(?=\n|$)/g,
    (_, prev, dashes, trail) => prev + '\n' + '*'.repeat(dashes.length) + trail);
}

// The body every preview/TOC path should render: real top frontmatter removed
// (parseFrontmatter), any stray Obsidian date block shown as plain text
// (unwrapStrayFrontmatter), and setext `---` headings turned into plain rules
// (dividerizeSetextRules). Kept in one place so the render, the TOC heading
// walk, and jump-to-heading all agree on line/char offsets — every transform
// preserves or trims only leading content, keeping `editor.value.length -
// body.length` an exact offset into editor.value for anything below.
function _previewBody(src) {
  return dividerizeSetextRules(unwrapStrayFrontmatter(parseFrontmatter(src).body));
}

function serializeFrontmatter(fm, body) {
  const lines = [];
  if (fm.title)  lines.push('title: ' + fm.title);
  if (fm.tags)   lines.push('tags: ' + fm.tags);
  if (fm.source) lines.push('source: ' + fm.source);
  if (lines.length === 0) return body;
  return '---\n' + lines.join('\n') + '\n---\n' + body;
}

// `source` holds URLs far longer than the field, so hovering it shows the whole
// value. BOTH attributes are written: the tooltip layer moves `title` → `data-tip`
// on first hover and drops the title, so refreshing only `title` would leave a
// stale bubble on an element already hovered (same reason as the mode-toggle
// button). An empty value clears both, or switching to a note without a source
// would keep showing the previous note's URL.
function setSourceTip(value) {
  const el = $('fm-source');
  if (!el) return;
  if (value) { el.title = value; el.setAttribute('data-tip', value); }
  else       { el.removeAttribute('title'); el.removeAttribute('data-tip'); }
}

function loadFrontmatterPanel(tab) {
  const { fm } = parseFrontmatter(tab.content || '');
  const titleEl = $('fm-title'); if (titleEl) titleEl.value = fm.title || '';
  const tagsEl  = $('fm-tags');  if (tagsEl)  tagsEl.value  = fm.tags  || '';
  const srcEl   = $('fm-source');if (srcEl) { srcEl.value = fm.source || ''; setSourceTip(fm.source || ''); }
  updateNoteMeta(tab);
  // Show rows only if in edit mode AND field has content (or is focused)
  updateMetaRows(state.viewMode === 'edit');
}

function updateMetaRows(editMode) {
  const tagsRow   = $('meta-row-tags');
  const srcRow    = $('meta-row-source');
  const tagsVal   = ($('fm-tags')   || {}).value || '';
  const srcVal    = ($('fm-source') || {}).value || '';
  if (tagsRow)  tagsRow.style.display   = (editMode && tagsVal)   ? 'flex' : 'none';
  if (srcRow)   srcRow.style.display    = (editMode && srcVal)    ? 'flex' : 'none';
}

function setupFrontmatter() {
  // Show row on focus even if field empty, hide on blur if still empty
  ['fm-tags','fm-source'].forEach(id => {
    const rowId = id === 'fm-tags' ? 'meta-row-tags' : 'meta-row-source';
    const el = $(id); if (!el) return;
    el.addEventListener('focus', () => {
      const row = $(rowId); if (row) row.style.display = 'flex';
    });
    el.addEventListener('blur', () => {
      if (!el.value.trim()) { const row = $(rowId); if (row) row.style.display = 'none'; }
    });
  });

  ['fm-title','fm-tags','fm-source'].forEach(id => {
    $(id).addEventListener('input', () => {
      updateMetaRows(true);
      const tab = getActiveTab();
      if (!tab) return;
      const { body } = parseFrontmatter(tab.content || '');
      const fm = {
        title:  $('fm-title').value.trim(),
        tags:   $('fm-tags').value.trim(),
        source: $('fm-source').value.trim(),
      };
      setSourceTip(fm.source);   // keep the hover text in step as you type
      const newContent = serializeFrontmatter(fm, body);
      editor.value = newContent;
      tab.content = newContent;
      tab.isDirty = true;
      setSavedState(false);
      renderTabBar();
      scheduleAutosave();
    });
  });
}

async function saveCurrentNote() {
  const tab = getActiveTab();
  if (!tab) return;

  // New blank tab — use the typed title or prompt for one
  if (!tab.path) {
    const content = editor.value;
    let safeName = (tab.name && tab.name !== 'Nuova nota')
      ? tab.name.replace(FORBIDDEN_NAME_RE_G, '-').replace(/\.md$/, '')
      : null;
    if (!safeName) {
      if (!content.trim()) return;
      const prompted = await showInputModal('Nome nota:', 'untitled');
      if (!prompted) return;
      safeName = prompted.replace(FORBIDDEN_NAME_RE_G, '-').replace(/\.md$/, '');
    }
    const filePath = `${safeName}.md`;
    await window.inkwell.writeNote(filePath, content);
    tab.path = filePath;
    tab.name = safeName;
    tab.content = content;
    tab.isDirty = false;
    tab.isNew = false;
    state.currentPath = filePath;
    noteTitle.value = safeName;
    if (statusPath) statusPath.textContent = filePath;
    setSavedState(true);
    renderTabBar();
    await loadTree();
    return;
  }

  if (!tab.isDirty) return;
  const _saveT0 = (typeof performance !== 'undefined') ? performance.now() : 0;
  const _saveVal = editor.value;
  await window.inkwell.writeNote(tab.path, _saveVal);
  try { if (_cmActive && window.inkwell.debugLog) window.inkwell.debugLog('SAVE writeNote ' + Math.round(performance.now() - _saveT0) + 'ms len=' + _saveVal.length); } catch (_) {}
  tab.content = editor.value;
  tab.isDirty = false;
  tab.modified = Date.now();
  updateNoteMeta(tab);
  setSavedState(true);
  renderTabBar();
}

function setSavedState(saved) {
  statusSaved.textContent = saved ? window.i18n.t('status.saved') : window.i18n.t('status.unsaved');
  statusSaved.className = saved ? '' : 'unsaved';
}

function showInputModal(label, defaultValue = '', opts = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('input-modal');
    const field = document.getElementById('input-modal-field');
    const labelEl = document.getElementById('input-modal-label');
    const okBtn = document.getElementById('input-modal-ok');
    const cancelBtn = document.getElementById('input-modal-cancel');
    const eye = document.getElementById('input-modal-eye');
    const errEl = document.getElementById('input-modal-err');
    labelEl.textContent = label;
    field.value = defaultValue;
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    // Password mode: mask the field and show the show/hide eye toggle.
    const isPass = !!opts.password;
    field.type = isPass ? 'password' : 'text';
    field.style.paddingRight = isPass ? '38px' : '';
    if (eye) {
      eye.style.display = isPass ? 'flex' : 'none';
      eye.onclick = isPass ? () => { field.type = field.type === 'password' ? 'text' : 'password'; field.focus(); } : null;
    }
    modal.style.display = 'flex';
    setTimeout(() => { field.select(); field.focus(); }, 60);
    const cleanup = (val) => {
      modal.style.display = 'none';
      field.type = 'text'; field.style.paddingRight = '';
      if (eye) { eye.style.display = 'none'; eye.onclick = null; }
      if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
      okBtn.disabled = false;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      field.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const showErr = (msg, color) => { if (errEl) { errEl.textContent = msg || ''; errEl.style.color = color || 'var(--red)'; errEl.style.display = msg ? 'block' : 'none'; } field.select(); field.focus(); };
    const onOk = async () => {
      const value = (isPass ? field.value : field.value.trim()) || null;
      // With a validator, DON'T close on a bad value: show the error inline and
      // keep the modal open (no disappear/reappear).
      if (opts.validate) {
        okBtn.disabled = true;
        let vr;
        try { vr = await opts.validate(value); } catch (e) { vr = { ok: false, error: String(e && e.message || e) }; }
        okBtn.disabled = false;
        if (vr && vr.ok === false) { showErr(vr.error, vr.color); return; }
        cleanup(vr && ('value' in vr) ? vr.value : value);
        return;
      }
      cleanup(value);
    };
    const onCancel = () => cleanup(null);
    const onKey = (e) => { if (e.key === 'Enter') onOk(); if (e.key === 'Escape') onCancel(); };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    field.addEventListener('keydown', onKey);
  });
}

// In-theme confirmation dialog — replaces window.confirm() (which on Linux
// shows an ugly native box with the old app icon). Returns a Promise<boolean>.
function showConfirmModal(message) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-modal-msg');
    const okBtn = document.getElementById('confirm-modal-ok');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    if (!modal || !msgEl || !okBtn || !cancelBtn) { resolve(window.confirm(message)); return; }
    msgEl.textContent = message;
    modal.style.display = 'flex';
    setTimeout(() => okBtn.focus(), 60);
    const cleanup = (val) => {
      modal.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

function openNewTab() {
  tabs.push({
    path: null, name: 'Nuova nota', content: '',
    isDirty: false, isNew: true,
    viewMode: 'edit', scrollPos: 0, cursorPos: 0,
  });
  switchTab(tabs.length - 1);
}

// Expand a folder path and all its ancestors in the sidebar, so a freshly
// created note/folder is visible nested inside its parent instead of being
// hidden behind a collapsed folder (which looks like it landed at root).
function openFolderAncestors(folderPath) {
  if (!folderPath) return;
  const parts = folderPath.split('/');
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    state.openFolders.add(acc);
  }
}

// ─── Editor breadcrumb (clickable note path under the title) ───────────────────
// Shows where the current note lives in the vault. Root notes show just their
// name; nested notes show "folder1/folder2/note" with every segment clickable —
// folder segments expand+reveal that folder in the left tree, the note segment
// reveals (selects + scrolls to) the note itself.
function renderBreadcrumb(tab) {
  const bc = $('note-breadcrumb');
  if (!bc) return;
  // Hide for special tabs (mindmap/canvas/pdf) and when there's no path.
  if (!tab || !tab.path || tab.type) {
    bc.style.display = 'none';
    bc.innerHTML = '';
    return;
  }

  const parts = tab.path.split('/');
  const fileName = parts.pop();
  const noteName = fileName.replace(/\.(md|draw|pdf)$/i, '');

  bc.innerHTML = '';
  bc.style.display = 'flex';

  // Folder segments (everything before the file name), each with its cumulative
  // path so a click can target exactly that folder.
  let acc = '';
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const folderPath = acc;
    const seg = document.createElement('span');
    seg.className = 'crumb crumb-folder';
    seg.textContent = part;
    seg.title = folderPath;
    seg.addEventListener('click', () => revealFolderInTree(folderPath));
    bc.appendChild(seg);

    const sep = document.createElement('span');
    sep.className = 'crumb-sep';
    sep.textContent = '/';
    bc.appendChild(sep);
  }

  // Note segment — single click selects/reveals in the tree; double click or
  // right-click → rename the note inline in the breadcrumb itself.
  const noteSeg = document.createElement('span');
  noteSeg.className = 'crumb crumb-note';
  noteSeg.textContent = noteName;
  noteSeg.title = tab.path;
  noteSeg.addEventListener('click', () => revealNoteInTree(tab.path));
  // Double click → rename inline directly.
  noteSeg.addEventListener('dblclick', (e) => {
    e.preventDefault(); e.stopPropagation();
    renameNoteInBreadcrumb(noteSeg, tab.path);
  });
  // Right click → small menu (Rename / Copy / Paste).
  noteSeg.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    showCrumbContextMenu(e, noteSeg, tab.path);
  });
  bc.appendChild(noteSeg);
}

// Context menu for the note name in the breadcrumb.
let _crumbCtx = { seg: null, path: null };
function showCrumbContextMenu(e, seg, path) {
  _crumbCtx = { seg, path };
  const menu = $('crumb-context-menu');
  if (!menu) return;
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
}

function setupCrumbContextMenu() {
  const menu = $('crumb-context-menu');
  if (!menu) return;
  document.addEventListener('click', e => {
    if (!e.target.closest('#crumb-context-menu')) menu.style.display = 'none';
  });
  $('crumbctx-rename')?.addEventListener('click', () => {
    menu.style.display = 'none';
    if (_crumbCtx.seg && _crumbCtx.path) renameNoteInBreadcrumb(_crumbCtx.seg, _crumbCtx.path);
  });
  $('crumbctx-duplicate')?.addEventListener('click', () => {
    menu.style.display = 'none';
    if (!_crumbCtx.path) return;
    const node = findNote(state.notes, _crumbCtx.path)
      || { type: 'note', name: (_crumbCtx.seg && _crumbCtx.seg.textContent) || '', path: _crumbCtx.path };
    duplicateNode(node);
  });
  $('crumbctx-copy')?.addEventListener('click', async () => {
    menu.style.display = 'none';
    const name = (_crumbCtx.seg && _crumbCtx.seg.textContent) || '';
    try { await navigator.clipboard.writeText(name); } catch(_) {}
  });
  $('crumbctx-paste')?.addEventListener('click', async () => {
    menu.style.display = 'none';
    if (!_crumbCtx.seg || !_crumbCtx.path) return;
    let txt = '';
    try { txt = await navigator.clipboard.readText(); } catch(_) {}
    txt = (txt || '').split('\n')[0].trim();
    if (txt) {
      const node = findNote(state.notes, _crumbCtx.path)
        || { type: 'note', name: _crumbCtx.seg.textContent, path: _crumbCtx.path };
      await commitRename(node, txt);
    }
  });
}

// Inline-rename the active note straight from the breadcrumb: the note name
// segment becomes an editable field. Enter / blur confirms, Esc cancels.
function renameNoteInBreadcrumb(noteSeg, path) {
  if (!noteSeg || !path) return;
  const node = findNote(state.notes, path)
    || { type: 'note', name: noteSeg.textContent, path };
  const curName = node.name || noteSeg.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'crumb-rename-input';
  input.value = curName;
  input.spellcheck = false;
  noteSeg.style.display = 'none';
  noteSeg.after(input);
  attachNameGuard(input);   // block forbidden chars as you type (no revert)

  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const val = input.value.trim();
    input.remove();
    noteSeg.style.display = '';
    if (commit && val && val !== curName) await commitRename(node, val);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
  input.focus();
  // Select base name (without extension) for quick overwrite.
  const dot = curName.lastIndexOf('.');
  if (dot > 0) input.setSelectionRange(0, dot); else input.select();
}

// Briefly highlight a tree element after scrolling it into view.
function flashTreeEl(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  el.classList.remove('tree-flash');
  // Force reflow so re-adding the class restarts the animation.
  void el.offsetWidth;
  el.classList.add('tree-flash');
  setTimeout(() => el.classList.remove('tree-flash'), 1000);
}

// Expand + scroll to a folder in the left sidebar tree.
function revealFolderInTree(folderPath) {
  if (!folderPath) return;
  openFolderAncestors(folderPath);   // opens the folder itself and all ancestors
  renderTree();
  const rows = document.querySelectorAll('.tree-folder');
  for (const r of rows) {
    if (r.dataset.folder === folderPath) { flashTreeEl(r); break; }
  }
}

// Select + scroll to a note in the left sidebar tree.
function revealNoteInTree(notePath) {
  if (!notePath) return;
  const folder = notePath.includes('/') ? notePath.split('/').slice(0, -1).join('/') : '';
  if (folder) openFolderAncestors(folder);
  state.currentPath = notePath;       // mark it active so it renders highlighted
  renderTree();
  const notes = document.querySelectorAll('.tree-note');
  for (const el of notes) {
    if (el.dataset.path === notePath) { flashTreeEl(el); break; }
  }
}

// Target folder for a new note. Priority:
//  1) a folder explicitly selected in the tree (clicked), else
//  2) the folder of the currently open note, else
//  3) '' (vault root).
function currentFolderPath() {
  const isAtt = (f) => f === 'attachments' || f.startsWith('attachments/');
  // A selected tree folder wins — but never an attachments/* path (not a note folder).
  if (state.selectedFolder && !isAtt(state.selectedFolder)) return state.selectedFolder;
  const p = state.currentPath;
  if (!p || !p.includes('/')) return '';
  const folder = p.split('/').slice(0, -1).join('/');
  // The active tab can be an attachment (image/pdf/media live under attachments/);
  // those are NOT note-tree folders, so never create notes/draws inside them.
  if (isAtt(folder)) return '';
  return folder;
}

async function createNewNote(folder = '') {
  if (typeof folder !== 'string') folder = '';
  // Default name: today's date day-month-year (direct creation, no prompt).
  // "-" not "/" — the slash is a path separator and is blocked in file names.
  const d = new Date();
  const safeName = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  const flat = flattenTree(state.notes);
  let finalName = safeName;
  let counter = 1;
  while (flat.some(n => n.path === (folder ? `${folder}/${finalName}.md` : `${finalName}.md`))) {
    finalName = `${safeName} (${counter++})`;
  }
  const filePath = folder ? `${folder}/${finalName}.md` : `${finalName}.md`;
  // Start empty (no "# title" heading): the note title is already shown above,
  // so the editor opens blank with the cursor ready to type.
  const defaultContent = '';
  await window.inkwell.writeNote(filePath, defaultContent);
  openFolderAncestors(folder);
  await loadTree();
  openTab({ path: filePath, name: finalName, content: defaultContent });
}

async function createNewFolder(parent = '') {
  if (typeof parent !== 'string') parent = '';
  // No name prompt: create the folder right away named with today's date
  // day-month-year (with suffix (1), (2)… if it already exists). Stays renamable.
  // "-" not "/" — the slash is a path separator and is blocked in folder names.
  const d = new Date();
  const base = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  let finalName = base;
  let counter = 1;
  while (anyFolderAtPath(state.notes, parent ? `${parent}/${finalName}` : finalName)) {
    finalName = `${base} (${counter++})`;
  }
  const folderPath = parent ? `${parent}/${finalName}` : finalName;
  await window.inkwell.createFolder(folderPath);
  // Keep the parent (and the new folder itself) expanded so it appears nested.
  openFolderAncestors(folderPath);
  await loadTree();
}

// True if a folder node with exactly this path exists anywhere in the tree.
function anyFolderAtPath(nodes, targetPath) {
  for (const n of nodes) {
    if (n.type === 'folder') {
      if (n.path === targetPath) return true;
      if (anyFolderAtPath(n.children, targetPath)) return true;
    }
  }
  return false;
}

async function deleteNote(node) {
  // No confirmation dialog — delete immediately (notes, folders, draws, PDF, images).
  // (User preference: delete goes through without asking.)
  removeFromTreeOrder(node.path);   // forget the deleted item's manual order
  if (node.type === 'folder') {
    await window.inkwell.deleteFolder(node.path);
    // Close any open tabs that live inside the deleted folder
    const prefix = node.path + '/';
    for (let i = tabs.length - 1; i >= 0; i--) {
      if (tabs[i].path === node.path || (tabs[i].path && tabs[i].path.startsWith(prefix))) {
        tabs.splice(i, 1);
        if (activeTabIdx >= i) activeTabIdx--;
      }
    }
    if (tabs.length === 0) {
      activeTabIdx = -1;
      state.currentPath = null;
      editorContainer.style.display = 'none';
      emptyState.style.display = 'flex';
    } else {
      await switchTab(Math.min(Math.max(activeTabIdx, 0), tabs.length - 1));
    }
    renderTabBar();
    // Drop the folder (and descendants) from the persisted open-state set
    state.openFolders.forEach(p => {
      if (p === node.path || p.startsWith(prefix)) state.openFolders.delete(p);
    });
    await loadTree();
    return;
  }
  if (isAttachNode(node)) {
    await window.inkwell.deleteAttachment(node.attachmentName || node.name);
    const tabIdx = tabs.findIndex(t => t.type === node.type && t.attachmentName === (node.attachmentName || node.name));
    if (tabIdx !== -1) closeTab(tabIdx);
    await loadTree();
    return;
  }
  await window.inkwell.deleteNote(node.path);
  // Close the tab if this note is open
  const tabIdx = tabs.findIndex(t => t.path === node.path);
  if (tabIdx !== -1) {
    const wasActive = (tabIdx === activeTabIdx);
    tabs.splice(tabIdx, 1);
    if (tabs.length === 0) {
      activeTabIdx = -1;
      state.currentPath = null;
      editorContainer.style.display = 'none';
      emptyState.style.display = 'flex';
    } else if (wasActive) {
      // Deleted the note the user was on → switch to its neighbour and load it.
      await switchTab(Math.min(tabIdx, tabs.length - 1));
    } else if (activeTabIdx > tabIdx) {
      // Deleted a BACKGROUND note → keep the SAME note active; only its index
      // shifted. Same data-loss fix as closeTab: never reselect by slot index.
      activeTabIdx--;
    }
    renderTabBar();
  }
  await loadTree();
}

// Apply a rename once a new name is known (shared by inline editor + any caller).
async function commitRename(node, newName) {
  if (!newName || newName === node.name) return;
  if (isAttachNode(node)) {
    const oldAttachment = node.attachmentName || node.name;
    const finalName = await window.inkwell.renameAttachment(oldAttachment, newName);
    renameInTreeOrder(node.path, `attachments/${finalName}`);   // preserve manual order
    const tab = tabs.find(t => t.type === node.type && t.attachmentName === oldAttachment);
    if (tab) {
      tab.attachmentName = finalName;
      tab.name = node.type === 'pdf' ? finalName : finalName.split('/').pop();
      tab.path = `attachments/${finalName}`;
      const embed = node.type === 'pdf'   ? $('pdf-embed')
                  : node.type === 'image' ? $('img-view-content')
                  : node.type === 'audio' ? $('audio-view-content')
                  :                         $('video-view-content');
      if (embed) embed.dataset.loaded = '';
      renderTabBar();
      if (tabs[activeTabIdx] === tab) await switchTab(activeTabIdx);
    }
    await loadTree();
    return;
  }
  await _applyRename(node, newName);
}

// Inline rename — no popup. Reveals the node in the tree, turns its label into
// an editable input (Obsidian/VS Code style). Enter or blur confirms, Esc cancels.
async function renameNote(node) {
  if (!node) return;
  const isFolder = node.type === 'folder';

  // Make sure the row is visible in the tree before editing it.
  const parent = node.path && node.path.includes('/')
    ? node.path.split('/').slice(0, -1).join('/') : '';
  if (parent) { openFolderAncestors(parent); }
  renderTree();

  const sel = isFolder
    ? `.tree-folder[data-folder="${(node.path || node.name).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    : `.tree-note[data-path="${(node.path || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  const row = document.querySelector(sel);
  const nameEl = row ? row.querySelector('.tree-name') : null;
  if (!row || !nameEl) {
    // Fallback (e.g. row not in DOM): minimal prompt instead of the old modal.
    const np = await showInputModal('Rinomina:', node.name);
    if (np) await commitRename(node, np);
    return;
  }

  // Build the inline input in place of the label.
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-rename-input';
  input.value = node.name;
  input.spellcheck = false;
  nameEl.style.display = 'none';
  nameEl.after(input);
  attachNameGuard(input);   // block forbidden chars as you type (no revert)
  // Don't let a click in the input trigger the row's open/select handler.
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());

  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const val = input.value.trim();
    input.remove();
    nameEl.style.display = '';
    if (commit && val && val !== node.name) {
      await commitRename(node, val);
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));

  input.focus();
  // Select the base name (without extension) for quick overwrite.
  const dot = node.name.lastIndexOf('.');
  if (!isFolder && dot > 0) input.setSelectionRange(0, dot);
  else input.select();
}

// Allowlist for names: ONLY letters (any language), digits, space, and - _ . ( )
// — plus emoji (so the emoji-picker prefix survives). Everything else (' ` & # $
// % * : | " < > / \ ? …) is a "special char" and is BLOCKED as the user types
// (strip just that char, keep the rest + the caret, show a throttled error) — we
// never revert or replace the whole value. The strip on commit is a net.
// Emoji kept: pictographs + ZWJ + variation-selector + skin tones + flags + keycap.
const _NAME_ALLOW = '\\p{L}\\p{N} \\-_.()\\p{Extended_Pictographic}\\u200d\\ufe0f\\u20e3\\u{1f3fb}-\\u{1f3ff}\\u{1f1e6}-\\u{1f1ff}';
const FORBIDDEN_NAME_RE   = new RegExp(`[^${_NAME_ALLOW}]`, 'u');
const FORBIDDEN_NAME_RE_G = new RegExp(`[^${_NAME_ALLOW}]`, 'gu');
// Same, but also allows "/" — for path-like fields (e.g. the Samba/WebDAV remote
// folder, the local backup folder).
const _PATH_ALLOW = _NAME_ALLOW + '/';
const FORBIDDEN_PATH_RE   = new RegExp(`[^${_PATH_ALLOW}]`, 'u');
const FORBIDDEN_PATH_RE_G = new RegExp(`[^${_PATH_ALLOW}]`, 'gu');
// URL fields (e.g. the WebDAV server URL): letters/digits + the structural URL
// chars (scheme/host/port/path/query). Still blocks spaces, quotes, backtick,
// < > | \ ^ { } etc. NB: no emoji here.
const _URL_ALLOW = '\\p{L}\\p{N}:/?#@%~._+=&()\\-';
const FORBIDDEN_URL_RE   = new RegExp(`[^${_URL_ALLOW}]`, 'u');
const FORBIDDEN_URL_RE_G = new RegExp(`[^${_URL_ALLOW}]`, 'gu');
let _nameErrAt = 0;
function showNameError() {
  const now = Date.now();
  if (now - _nameErrAt > 1200) { showToast(window.i18n.t('toast.invalid_name_chars'), 5000); _nameErrAt = now; }
}
// opts.test / opts.strip override the default name allowlist (e.g. the path set).
function attachNameGuard(el, opts) {
  if (!el || el._nameGuard) return; el._nameGuard = true;
  const testRe  = (opts && opts.test)  || FORBIDDEN_NAME_RE;
  const stripRe = (opts && opts.strip) || FORBIDDEN_NAME_RE_G;
  el.addEventListener('input', () => {
    if (!testRe.test(el.value)) return;
    const pos = el.selectionStart ?? el.value.length;
    const removedBefore = el.value.slice(0, pos).length - el.value.slice(0, pos).replace(stripRe, '').length;
    el.value = el.value.replace(stripRe, '');
    const np = Math.max(0, pos - removedBefore);
    try { el.setSelectionRange(np, np); } catch (_) {}
    showNameError();
  });
}

// Before a rename/move changes a note's on-disk path: flush any pending unsaved
// edits of the AFFECTED active note to its CURRENT path and cancel the armed
// autosave, so the 2s timer can't fire mid-rename and recreate a ghost file at
// the old path (nor lose the edits). Safe no-op when nothing dirty/affected.
async function _flushBeforePathChange(oldPath) {
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  const t = getActiveTab();
  if (t && t.isDirty && t.path && (t.path === oldPath || t.path.startsWith(oldPath + '/'))) {
    try { await saveCurrentNote(); } catch (_) {}
  }
}

async function _applyRename(node, newName) {
  const isFolder = node.type === 'folder';
  const safeName = newName.replace(FORBIDDEN_NAME_RE_G, '').replace(/\.md$/, '').trim();
  const parts = node.path.split('/');
  parts[parts.length - 1] = isFolder ? safeName : safeName + '.md';
  const newPath = parts.join('/');
  if (newPath === node.path) return;
  await _flushBeforePathChange(node.path);   // no ghost file / no lost edits mid-rename
  await window.inkwell.renameNote(node.path, newPath);
  renameInTreeOrder(node.path, newPath);   // keep manual order across the rename
  // Keep the CM "loaded path" in step so switchTab's data-loss guard still
  // matches the right tab after the rename.
  if (_cmLoadedPath === node.path) _cmLoadedPath = newPath;
  else if (_cmLoadedPath && _cmLoadedPath.startsWith(node.path + '/')) _cmLoadedPath = newPath + '/' + _cmLoadedPath.slice(node.path.length + 1);
  if (isFolder) {
    const prefix = node.path + '/';
    tabs.forEach(t => {
      if (t.path.startsWith(prefix)) {
        t.path = newPath + '/' + t.path.slice(prefix.length);
        if (state.currentPath === t.path) state.currentPath = t.path;
      }
    });
    // Keep the folder (and any expanded sub-folders) open under the new path —
    // otherwise it collapses after the rename and the notes inside "vanish".
    const remappedOpen = new Set();
    state.openFolders.forEach(pth => {
      if (pth === node.path) remappedOpen.add(newPath);
      else if (pth.startsWith(prefix)) remappedOpen.add(newPath + '/' + pth.slice(prefix.length));
      else remappedOpen.add(pth);
    });
    state.openFolders = remappedOpen;
    if (state.selectedFolder === node.path) state.selectedFolder = newPath;
    persistOpenFolders();
    renderTabBar();
  } else {
    const tab = getTab(node.path);
    if (tab) {
      tab.path = newPath;
      tab.name = safeName;
      if (state.currentPath === node.path) {
        state.currentPath = newPath;
        noteTitle.value = safeName;
      }
      renderTabBar();
      // Refresh the breadcrumb so the renamed note shows immediately.
      try { renderBreadcrumb(getActiveTab()); } catch(_) {}
    }
  }
  await loadTree();
}

// Prepend an emoji to the note/folder name (replacing any existing emoji).
async function addEmojiToNode(node, emoji) {
  if (!node || isAttachNode(node)) return;
  const base = node.name.replace(/^[\p{Extended_Pictographic}️‍]+\s*/u, '').trim();
  await _applyRename(node, emoji + ' ' + base);
}

// ─── Editor ───────────────────────────────────────────────────────────────────
function setupEditor() {
  // Tab bar new button — opens blank tab; file is created on first save
  $('tab-new-btn').addEventListener('click', () => openNewTab());

  // Focus / reading mode: hide the left column to maximise reading width.
  const FOCUS_KEY = 'amelie-focus-mode';
  const applyFocusMode = on => document.getElementById('app').classList.toggle('focus-mode', !!on);
  try { applyFocusMode(localStorage.getItem(FOCUS_KEY) === '1'); } catch (_) {}
  $('btn-focus-mode')?.addEventListener('click', () => {
    const on = !document.getElementById('app').classList.contains('focus-mode');
    applyFocusMode(on);
    try { localStorage.setItem(FOCUS_KEY, on ? '1' : '0'); } catch (_) {}
  });

  // Right-click menu in the editor → "Highlight" sends an IPC command
  // from main back here, which wraps the current selection in ==…==.
  window.inkwell.onEditorCmd?.(cmd => {
    if (document.activeElement !== editor) return;
    if (cmd === 'highlight') {
      handleToolbarCmd('highlight');
    } else if (typeof cmd === 'string' && cmd.startsWith('color:')) {
      applyTextColor(cmd.slice('color:'.length));
    } else if (cmd === 'color-remove') {
      removeTextColor();
    } else if (cmd === 'bold' || cmd === 'italic') {
      handleToolbarCmd(cmd);
    }
  });

  // Debounce timers for expensive operations
  let _previewTimer = null;
  let _tocTimer     = null;
  let _chipsTimer   = null;

  // Keep the colored overlay aligned with the textarea in BOTH axes:
  //  - width: when a vertical scrollbar appears/disappears the textarea's text
  //    width changes by ~12px; the overlay must match or text shifts right.
  //  - scrollTop: typing/inserting can auto-scroll the textarea to keep the
  //    caret visible, and that can land AFTER our handlers, leaving the overlay
  //    a line behind (text appears above/below the caret).
  const syncOverlay = () => {
    if (_cmActive) return;
    const overlay = document.getElementById('editor-highlight');
    if (!overlay) return;
    if (editor.clientWidth && parseFloat(overlay.style.width) !== editor.clientWidth) {
      overlay.style.width = editor.clientWidth + 'px';
    }
    if (overlay.scrollTop !== editor.scrollTop) overlay.scrollTop = editor.scrollTop;
    const g = document.getElementById('editor-gutter');
    if (g && g.scrollTop !== editor.scrollTop) g.scrollTop = editor.scrollTop;
  };
  editor.addEventListener('scroll', syncOverlay);
  // After the browser settles layout (incl. caret-visibility auto-scroll and a
  // newly-appeared scrollbar), re-sync both width and scroll.
  editor.addEventListener('keyup', () => requestAnimationFrame(syncOverlay));

  // Re-sync the overlay width whenever the editor's size changes — window
  // resize, sidebar resize/collapse, focus mode, etc. (none of which fire
  // 'input'). A ResizeObserver catches them all. Just updating the overlay
  // width is cheap; reposition the code-block backgrounds too.
  try {
    const _ro = new ResizeObserver(() => {
      syncOverlay();
      try { decorateEditorCodeBlocks(); } catch (_) {}
    });
    _ro.observe(editor);
  } catch (_) {}

  // The fonts (JetBrains Mono) load asynchronously: when they're ready
  // the real line height can change → recompute the code-block backgrounds
  // to avoid misalignment on first startup.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { try { decorateEditorCodeBlocks(); } catch(_) {} });
  }

  // Enter inside a code fence keeps the new line at the block's indent (runs
  // before the browser inserts a plain newline).
  editor.addEventListener('keydown', handleFenceEnterIndent);

  // Selected-character count in the status bar (left side, edit mode only).
  document.addEventListener('selectionchange', () => { if (document.activeElement === editor) updateSelectionCount(); });
  editor.addEventListener('blur', updateSelectionCount);

  editor.addEventListener('input', (e) => {
    const tab = getActiveTab();
    if (tab) { tab.isDirty = true; tab.content = editor.value; }

    // Full highlight incl. code-block boxes + gutter, synchronously, so the masks
    // always track the text exactly (correct size/spacing, no blink).
    applyEditorHighlight();
    setSavedState(false);
    updateWordCount();
    updateSelectionCount();
    scheduleAutosave();
    // Re-indent code fences to 2 spaces (incl. on paste, so pasted code blocks
    // get normalized like the rest and their masks line up). Skip only undo/redo:
    // re-normalizing the just-reverted text would make Ctrl+Z look like a no-op.
    if (e.inputType !== 'historyUndo' && e.inputType !== 'historyRedo') {
      scheduleFenceReindent();
    }
    checkNoteLinkTrigger();
    try { syncSplitFromMain(); } catch(_) {}
    // The caret-visibility auto-scroll (and any scrollbar appearance) happens
    // after this handler; re-align the overlay AND re-measure the code-block masks
    // once layout has settled — a fresh line can shift clientWidth (scrollbar) so
    // the synchronous measure above lands the mask one row off ("mask va sotto").
    requestAnimationFrame(() => { syncOverlay(); try { decorateEditorCodeBlocks(); } catch (_) {} });

    // Debounced — expensive, no need to run on every keystroke
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(() => requestAnimationFrame(() => updatePreview()), 120);

    if (tocVisible) {
      clearTimeout(_tocTimer);
      _tocTimer = setTimeout(() => renderTOC(), 200);
    }

    if (state.viewMode === 'edit') {
      clearTimeout(_chipsTimer);
      _chipsTimer = setTimeout(() => refreshAttachmentChips(), 400);
    }
  });

  let _titleTimer = null;
  noteTitle.addEventListener('input', () => {
    clearTimeout(_titleTimer);
    _titleTimer = setTimeout(async () => {
      const tab = getActiveTab();
      if (!tab) return;
      const newName = noteTitle.value.replace(FORBIDDEN_NAME_RE_G, '').replace(/\.md$/, '');
      if (!tab.path) {
        // New unsaved tab — create the file on first title entry
        if (!newName) return;
        tab.name = newName;
        renderTabBar();
        const filePath = `${newName}.md`;
        const content = editor.value || '';
        await window.inkwell.writeNote(filePath, content);
        tab.path = filePath;
        tab.isNew = false;
        state.currentPath = filePath;
        if (statusPath) statusPath.textContent = filePath;
        await loadTree();
        return;
      }
      const parts = tab.path.split('/');
      parts[parts.length - 1] = newName + '.md';
      const newPath = parts.join('/');
      await window.inkwell.renameNote(tab.path, newPath);
      renameInTreeOrder(tab.path, newPath);   // keep manual order across title rename
      tab.path = newPath;
      tab.name = newName;
      state.currentPath = newPath;
      renderTabBar();
      await loadTree();
    }, 600);
  });

  // Paste a file (image OR any other attachment, e.g. a PDF copied from a file
  // manager). Images embed inline; PDFs/other files become a 📎 link. Either way
  // the bytes are saved into the vault's attachments/ folder — organized by
  // type: scripts (.py/.sh/.ps1/…) under attachments/scripts/, PDFs under
  // attachments/pdf/, everything else at the root.
  // Notes/drawings are NOT attachments — never let them pollute attachments/.
  // (Video is welcome again: the old "can't play" was the protocol's broken
  // Range support, fixed in v210 — codecs were there all along.)
  // Not attachable: notes/drawings (they're vault content, not attachments) and
  // SCRIPTS (.sh/.py/.ps1/… — deliberately NOT importable, to keep the vault clean).
  // Scripts are NOT importable (kept in sync with main.js's SCRIPT list, incl.
  // .js/.ts/.lua which used to slip through and land in the vault).
  const _SCRIPT_RE = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|rb|pl|js|mjs|cjs|ts|lua)$/i;
  const _isScript = (name) => _SCRIPT_RE.test(name || '');
  const _isNoteLike = (name) => /\.(md|markdown|txt|draw|tldr|excalidraw)$/i.test(name || '');
  // A path is attachable ONLY if it's a supported media/PDF type. Everything else
  // — notes/drawings (vault content, imported elsewhere) and scripts/archives/docs
  // (refused) — is filtered out of the attachment paths.
  const _notAttachable = (name) => !isSupportedAttachmentName(name);
  // Toast "unsupported format" when a drop/paste carried a file we can't attach.
  // Note-like files are excluded — the window-level handler imports them as notes,
  // not attachments, so they shouldn't trigger a "format not supported" warning.
  const _warnUnsupported = (names) => {
    if (names.some(n => n && !isSupportedAttachmentName(n) && !_isNoteLike(n)))
      showToast(window.i18n.t('attach.unsupported_format'), 4000);
  };
  const _warnIfScript = _warnUnsupported;   // back-compat alias for existing call sites
  const _videoNotice = () => {};   // kept for call-site compatibility
  // Per-file import cap (mirrors MAX_ATTACHMENT_BYTES in main). Import reads the
  // whole file into memory, so a huge file risks OOM — refuse it with a clear
  // message. Playback is streamed, so this only limits IMPORT, not viewing.
  const MAX_ATTACH_BYTES = 512 * 1024 * 1024;   // 512 MB
  const _tooBigToImport = (size) => {
    if (size != null && size > MAX_ATTACH_BYTES) { showToast(window.i18n.t('attach.too_large')); return true; }
    return false;
  };
  const _isTooLargeErr = (err) => /ATTACHMENT_TOO_LARGE/.test(err?.message || String(err || ''));
  // Main has the final say on the format (its allowlist is the one that cannot be
  // bypassed), so its refusal has to reach the user: a paste whose type looked fine
  // here but whose extension main rejects would otherwise fail in silence.
  const _isUnsupportedErr = (err) => /Unsupported attachment type/.test(err?.message || String(err || ''));
  // Refused because the bytes are not what the extension says (main reads the head).
  const _isMismatchErr = (err) => /ATTACHMENT_CONTENT_MISMATCH/.test(err?.message || String(err || ''));
  // Block the middle-mouse-button "primary selection" paste (X11/Linux/Wayland):
  // a middle click in the editor would otherwise paste whatever text is selected
  // elsewhere. The user only wants explicit Ctrl+V pastes. preventDefault on the
  // mousedown isn't always enough (esp. on Wayland), so we ALSO remember the
  // middle-click time and drop any paste that fires right after it (below).
  _editorMiddleDownHandler = e => { if (e.button === 1) { _middleDownAt = performance.now(); e.preventDefault(); } };
  _editorAuxClickHandler = e => { if (e.button === 1) { e.preventDefault(); } };
  editor.addEventListener('mousedown', _editorMiddleDownHandler, true);
  editor.addEventListener('auxclick',  _editorAuxClickHandler, true);
  _editorPasteHandler = async e => {
    // Drop the primary-selection paste triggered by a middle click (not a Ctrl+V).
    if (performance.now() - _middleDownAt < 700) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // FAST PATH — ordinary TEXT paste: there ARE text bytes, NO file items, and the
    // text isn't a list of file paths. Let the editor (CM or textarea) handle it
    // natively and DON'T touch the system clipboard. The readClipboardFilePaths()
    // call below is a *synchronous* IPC that can shell out to `wl-paste` (up to a
    // 2s timeout) on Wayland — running it on every keystroke-paste made pasting
    // text feel broken/laggy. This branch skips all of that for the common case.
    {
      const cd = e.clipboardData;
      const hasFileItem = [...(cd?.items || [])].some(i => i.kind === 'file');
      const plain = cd?.getData('text/plain') || '';
      const uriList = cd?.getData('text/uri-list') || '';
      const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
      const textIsPaths = lines.length > 0 && lines.every(l => /^(file:\/\/|\/)/.test(l));
      if (!hasFileItem && !uriList && plain && !textIsPaths) return;   // → native paste
    }
    // FIRST: ask the MAIN process what the OS clipboard really holds — a
    // synchronous read of the raw desktop formats (KDE/GNOME/uri-list/plain).
    // Chromium's DataTransfer often mangles file copies, this never does.
    let sysPaths = [];
    try {
      const raw = window.inkwell.readClipboardFilePaths?.() || [];
      _videoNotice(raw);
      _warnIfScript(raw);
      sysPaths = raw.filter(p => !_notAttachable(p));
    } catch (_) {}
    if (sysPaths.length) {
      e.preventDefault(); e.stopImmediatePropagation();
      let imported = 0;
      const importedNames = [];
      for (const p of sysPaths) {
        const base = p.split('/').pop();
        try {
          const name = await window.inkwell.importAttachmentPath(p, _attachmentTarget(base));
          insertAttachmentRef(name);
          importedNames.push(name.split('/').pop());
          imported++;
        } catch (err) { console.error('Paste import failed:', p, err); }
      }
      // Only warn on failure — no toast on a successful import.
      if (!imported) showToast(window.i18n.t('toast.files_import_failed', { n: 0 }));
      return;
    }
    const items = [...(e.clipboardData?.items || [])];
    // Keep only supported media/PDF. Use the FILE predicate (extension OR MIME) so a
    // pasted screenshot — which often has no filename, only an image/* MIME — survives.
    const files = items.filter(i => i.kind === 'file')
      .map(i => i.getAsFile())
      .filter(f => f && isSupportedAttachmentFile(f));
    // Audio/video/scripts copied in the file manager may arrive as file://
    // URIs only — and sometimes as EMPTY File stubs (0 bytes) with the real
    // path in text/uri-list. Prefer real bytes, fall back to paths.
    const uriList = e.clipboardData?.getData('text/uri-list') || '';
    // Warn once if the clipboard carried an unsupported file (script/archive/doc…).
    _warnUnsupported([
      ...items.filter(i => i.kind === 'file').map(i => { const f = i.getAsFile(); return f && f.name; }),
      ...uriList.split('\n').map(l => l.trim()).filter(l => l.startsWith('file://'))
        .map(l => { try { return decodeURIComponent(l.replace(/^file:\/\//, '')); } catch (_) { return ''; } })
    ]);
    const paths = uriList.split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('file://'))
      .map(l => { try { return decodeURIComponent(l.replace(/^file:\/\//, '')); } catch (_) { return null; } })
      .filter(p => p && !_notAttachable(p));
    // THIRD channel: some file managers/desktops put the copied file's path
    // only in text/plain (file:///… or /abs/path). Hijack the paste ONLY when
    // every non-empty line looks like a local path with an attachable
    // extension — never ordinary text.
    const plain = e.clipboardData?.getData('text/plain') || '';
    let plainPaths = [];
    if (!files.length && !paths.length && plain.trim()) {
      const lines = plain.split('\n').map(l => l.trim()).filter(Boolean);
      // Wider than what Amelie ACCEPTS on purpose (scripts, and ogg/oga which are no
      // longer supported): recognising the paste as a file paste is what lets the
      // "unsupported format" toast explain the refusal, instead of dumping a raw path
      // into the note.
      const ATTACHABLE_RE = /\.(png|jpe?g|gif|webp|svg|pdf|sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|rb|pl|mp3|wav|ogg|oga|flac|m4a|aac|opus|mp4|webm|mkv|mov|m4v)$/i;
      if (lines.length && lines.every(l => /^(file:\/\/|\/)/.test(l) && ATTACHABLE_RE.test(l))) {
        plainPaths = lines
          .map(l => { try { return decodeURIComponent(l.replace(/^file:\/\//, '')); } catch (_) { return null; } })
          .filter(p => p && !_notAttachable(p));
      }
    }
    // PATHS FIRST: when the clipboard carries file paths (file copied in a
    // file manager) import from disk — file items for media are often hollow
    // stubs whose bytes can't be read, and huge videos shouldn't be piped
    // through the clipboard anyway. Bytes are used only when there's no path
    // (e.g. a screenshot or an image copied from a browser).
    const allPaths = paths.length ? paths : plainPaths;
    if (allPaths.length) {
      e.preventDefault(); e.stopImmediatePropagation();
      let imported = 0;
      for (const p of allPaths) {
        const base = p.split('/').pop();
        try {
          const name = await window.inkwell.importAttachmentPath(p, _attachmentTarget(base));
          insertAttachmentRef(name);
          imported++;
        } catch (err) { console.error('Paste import failed:', p, err); }
      }
      if (!imported) showToast(window.i18n.t('toast.files_import_failed'));
      return;
    }
    const usableFiles = files.filter(f => f.size > 0);
    if (!usableFiles.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    let saved = 0;
    for (const file of usableFiles) {
      if (_tooBigToImport(file.size)) continue;
      try {
        const buf = await file.arrayBuffer();
        let target;
        if (file.type.startsWith('image/')) {
          // Pasted photo → name it with today's date, GG-MM-AAAA (dedup adds -1/-2).
          const d = new Date(), p2 = n => String(n).padStart(2, '0');
          const ext = (file.type.split('/')[1] || 'png').toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg').replace(/[^a-z0-9]/g, '');
          target = _attachmentTarget(`${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()}.${ext || 'png'}`);
        } else {
          target = _attachmentTarget(file.name || 'pasted-file');
        }
        const name = await window.inkwell.saveAttachment(target, new Uint8Array(buf));
        insertAttachmentRef(name);
        saved++;
      } catch (err) {
        console.error('Paste save failed:', file.name, err);
        if (_isTooLargeErr(err)) showToast(window.i18n.t('attach.too_large'));
        else if (_isUnsupportedErr(err)) showToast(window.i18n.t('attach.unsupported_format'));
        else if (_isMismatchErr(err)) showToast(window.i18n.t('attach.content_mismatch'));
      }
    }
  };
  editor.addEventListener('paste', _editorPasteHandler);

  // Drag & drop is restricted to MEDIA only: images (png/jpg/jpeg), PDF and
  // video (mp4/webm/mkv), ≤512 MB.
  // Everything else (audio, documents, archives, scripts, …) is refused with a
  // toast — the user only wants photos/PDFs/videos to land in the vault this way.
  // (Paste keeps the wider set; this cap is drag-specific by request.)
  // On Linux the drag payload sometimes carries NO File objects, only a
  // text/uri-list (file:// URIs) — import those by path via the main process.
  const _dragAllowed = (name) => isSupportedAttachmentName(name);   // images / audio / video / PDF
  const _uriListPaths = (dt) => {
    const parsed = (dt?.getData('text/uri-list') || '').split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('file://'))
      .map(l => { try { return decodeURIComponent(l.replace(/^file:\/\//, '')); } catch (_) { return null; } })
      .filter(Boolean);
    _videoNotice(parsed);
    return parsed.filter(p => !_notAttachable(p));
  };
  _editorDragoverHandler = e => e.preventDefault();
  editor.addEventListener('dragover', _editorDragoverHandler);
  _editorDropHandler = async e => {
    const rawFiles = [...(e.dataTransfer?.files || [])];
    _videoNotice(rawFiles.map(f => f && f.name));
    const rawUris = (e.dataTransfer?.getData('text/uri-list') || '').split('\n').map(l => l.trim());
    // NOTE-LIKE files dropped INTO the editor (.md/.markdown/.txt) → import as NOTES
    // into the vault ROOT. We must handle them HERE (this handler runs in CM's capture
    // phase precisely to beat CM's built-in drop, which would insert the file path as
    // literal text). Only when the drop is notes-ONLY; if media is also present the
    // media path below runs instead.
    const noteFiles = rawFiles.filter(f => f && /\.(md|markdown|txt)$/i.test(f.name));
    const anyMedia = rawFiles.some(f => f && _dragAllowed(f.name)) || rawUris.some(l => _dragAllowed(l));
    if (noteFiles.length && !anyMedia) {
      e.preventDefault(); e.stopImmediatePropagation();
      // Collect existing note paths so an import NEVER overwrites a note with the same
      // name — collisions get a "-1"/"-2" suffix instead (no silent data loss).
      const existing = new Set();
      try {
        const flatten = (nodes) => { for (const n of nodes || []) { if (n.type === 'folder') flatten(n.children); else if (n.path) existing.add(n.path.toLowerCase()); } };
        flatten(await window.inkwell.listNotes());
      } catch (_) {}
      const _freeName = (rel) => {
        if (!existing.has(rel.toLowerCase())) { existing.add(rel.toLowerCase()); return rel; }
        const dot = rel.lastIndexOf('.'), stem = dot >= 0 ? rel.slice(0, dot) : rel, ext = dot >= 0 ? rel.slice(dot) : '';
        let i = 1, cand; do { cand = `${stem}-${i}${ext}`; i++; } while (existing.has(cand.toLowerCase()));
        existing.add(cand.toLowerCase()); return cand;
      };
      let importedN = 0;
      for (const f of noteFiles) {
        try {
          let rel = (f.name || 'nota').replace(/\.(markdown|txt)$/i, '.md');
          if (!/\.md$/i.test(rel)) rel += '.md';
          rel = rel.split('/').map(s => s.replace(/[\\?%*:|"<>]/g, '-')).filter(Boolean).join('/');
          rel = _freeName(rel);
          await window.inkwell.writeNote(rel, await f.text());   // no folder prefix → notes/ root
          importedN++;
        } catch (err) { console.error('Note import (editor drop) failed:', f.name, err); }
      }
      if (importedN) { try { await loadTree(); } catch (_) {} showToast(window.i18n.t(importedN === 1 ? 'toast.note_imported' : 'toast.notes_imported', { n: importedN })); }
      return;
    }
    // MEDIA-ONLY: keep just images/audio/video/PDF; drop the rest (the mediaRejected
    // toast below reports anything refused).
    const files = rawFiles.filter(f => f && _dragAllowed(f.name));
    const rawUriPaths = _uriListPaths(e.dataTransfer);
    const uriPaths = rawUriPaths.filter(_dragAllowed);
    const droppedAny = rawFiles.length > 0 || rawUris.some(l => l.startsWith('file://'));
    // Something non-media was in the drop (a File or an attachable path our media
    // filter rejected) → tell the user why it didn't attach.
    const mediaRejected = (rawFiles.length - files.length) > 0 || (rawUriPaths.length - uriPaths.length) > 0;
    if (!uriPaths.length && !files.length) {
      // Note-like files (.md/.markdown/.txt/.draw) aren't attachments — let the drop
      // BUBBLE to the window-level handler, which imports them as NOTES into the vault
      // (root, or the folder dropped onto). Only warn for genuinely unsupported files
      // (scripts, archives, docs…). Use the RAW uri list so the Linux uri-only path
      // (no File objects) still recognises a dropped note.
      const noteLike = [...rawFiles.map(f => f && f.name), ...rawUris].some(n => _isNoteLike(n));
      if (droppedAny && !noteLike) { e.preventDefault(); e.stopImmediatePropagation(); showToast(window.i18n.t('attach.unsupported_format'), 4000); }
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (mediaRejected) showToast(window.i18n.t('attach.unsupported_format'), 4000);
    // PATHS FIRST (see the paste handler): media file items are often hollow
    // stubs — when the drag carries file:// URIs, import from disk.
    if (uriPaths.length) {
      for (const p of uriPaths) {
        const base = p.split('/').pop();
        try {
          const name = await window.inkwell.importAttachmentPath(p, _attachmentTarget(base));
          insertAttachmentRef(name);
        } catch (err) { console.error('Drop import failed:', p, err); if (_isTooLargeErr(err)) showToast(window.i18n.t('attach.too_large')); }
      }
      return;
    }
    for (const file of files.filter(f => f.size > 0)) {
      if (_tooBigToImport(file.size)) continue;
      try {
        const buf = await file.arrayBuffer();
        const name = await window.inkwell.saveAttachment(_attachmentTarget(file.name || 'file'), new Uint8Array(buf));
        insertAttachmentRef(name);
      } catch (err) {
        console.error('Drop save failed:', file.name, err);
        if (_isTooLargeErr(err)) showToast(window.i18n.t('attach.too_large'));
        else if (_isUnsupportedErr(err)) showToast(window.i18n.t('attach.unsupported_format'));
        else if (_isMismatchErr(err)) showToast(window.i18n.t('attach.content_mismatch'));
      }
    }
  };
  editor.addEventListener('drop', _editorDropHandler);

  // Toolbar buttons
  document.querySelectorAll('.tool-btn[data-cmd]').forEach(btn => {
    // Keep the editor focused (and its caret/selection intact) when clicking a
    // toolbar button. Without this, mousedown moves focus to the button, the
    // text is inserted but the editor is left UNFOCUSED — so the next keystroke
    // (incl. Backspace) does nothing, which looks like "can't delete text".
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => handleToolbarCmd(btn.dataset.cmd));
  });

  // Table button
  setupTableBuilder();

  // Heading picker
  setupHeadingPicker();

  // Single Edit/View toggle: flip to the other mode on click (and make it sticky).
  $('btn-mode-toggle')?.addEventListener('click', () => { toggleViewMode(); });

  // Undo / Redo header buttons — focus the editor first so the native history
  // applies to the note text.
  $('btn-undo')?.addEventListener('mousedown', e => e.preventDefault());
  $('btn-undo')?.addEventListener('click', () => { if (_editingBlocked()) return; editor.focus(); document.execCommand('undo'); });
  $('btn-redo')?.addEventListener('mousedown', e => e.preventDefault());
  $('btn-redo')?.addEventListener('click', () => { if (_editingBlocked()) return; editor.focus(); document.execCommand('redo'); });

  $('btn-prev-note')?.addEventListener('click', () => navigateNote('prev'));
  $('btn-next-note')?.addEventListener('click', () => navigateNote('next'));

  // Hide the wiki-link autocomplete popup when focus leaves the editor — but
  // give popup mousedown handlers time to run first (they preventDefault, so
  // the editor wouldn't truly lose focus on a popup click).
  editor.addEventListener('blur', () => {
    setTimeout(() => {
      const popup = $('link-popup');
      if (!popup || popup.style.display === 'none') return;
      if (!popup.contains(document.activeElement)) hideLinkPopup();
    }, 120);
  });
  // Clicking back into the note (without picking a link) cancels the popup and
  // strips the empty `[[]]` the link button inserted — no stray brackets left.
  editor.addEventListener('mousedown', () => { if (linkPopupActive) hideLinkPopup(); });
  // CM engine: the textarea blur/mousedown above never fire when CodeMirror owns
  // focus, so the popup stayed open when clicking away (e.g. onto the notes list).
  // A global mousedown outside the popup dismisses it.
  document.addEventListener('mousedown', (e) => {
    if (!linkPopupActive) return;
    const popup = $('link-popup');
    if (popup && popup.contains(e.target)) return;
    hideLinkPopup();
  }, true);

  setupNoteZoom();
}

// ─── Note content zoom (Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+wheel) ─────────────

const NOTE_ZOOM_KEY = 'amelie.noteZoom';
const NOTE_ZOOM_BASE = 14; // px — must match --editor-font-size default
let _noteZoom = parseInt(localStorage.getItem(NOTE_ZOOM_KEY), 10) || 100;
// One-time readability bump for EXISTING users only: raise a small note zoom once.
// A FRESH install stays at 100% so the editor matches the chosen font size (13px)
// and isn't oversized on first run. Fully adjustable with Ctrl+scroll / Ctrl± / Ctrl+0.
try {
  if (!localStorage.getItem('amelie.noteZoom.bump-v2')) {
    const existing = localStorage.getItem(NOTE_ZOOM_KEY) !== null;
    if (existing && _noteZoom < 120) { _noteZoom = 120; localStorage.setItem(NOTE_ZOOM_KEY, String(_noteZoom)); }
    localStorage.setItem('amelie.noteZoom.bump-v2', '1');
  }
} catch (_) {}

function applyNoteZoom() {
  // Base font = the "Dimensione font editor" appearance pref (the settings dropdown),
  // so that control is authoritative; Ctrl+wheel / Ctrl± zoom multiplies it. Falls
  // back to NOTE_ZOOM_BASE when the pref is missing.
  const base = (loadAppearance().editorFontSize) || NOTE_ZOOM_BASE;
  const px = Math.round(base * _noteZoom / 100);
  document.documentElement.style.setProperty('--editor-font-size', px + 'px');
  // Zoom changes the font size → the line height, the ``` ink metrics and every
  // line's pixel position all change, so the code-block boxes must be remeasured
  // AFTER the new font size has been laid out. A single rAF can fire before the
  // textarea has reflowed at the new size (leaving boxes sized for the old
  // font), so we redecorate across two frames and once more on a short timeout.
  const redo = () => { try { decorateEditorCodeBlocks(); } catch (_) {} };
  try {
    requestAnimationFrame(() => { redo(); requestAnimationFrame(redo); });
    setTimeout(redo, 60);
  } catch (_) { redo(); }
}

function changeNoteZoom(delta) {
  _noteZoom = Math.max(60, Math.min(220, _noteZoom + delta));
  localStorage.setItem(NOTE_ZOOM_KEY, String(_noteZoom));
  applyNoteZoom();
}

function setupNoteZoom() {
  // v979: the editor font size is now driven by the 'editorFontSize' appearance pref
  // (the settings dropdown), used as applyNoteZoom's base. Seed it once to
  // NOTE_ZOOM_BASE so the dropdown is authoritative and matches the intended default.
  // Bump the key (v2, v980: default 14→13; v3, v1.0.18: 13→14) to carry a new base to
  // profiles that already exist — a saved size otherwise keeps the old value and the
  // change reaches nobody who has used Amelie before. Unlike v2, which overwrote the
  // size whatever it was, this only moves a profile still sitting on the PREVIOUS
  // default: a size someone picked on purpose (11, 18…) is theirs, not ours to raise.
  const ED_SIZE_PREV_DEFAULT = 13;
  try {
    if (!localStorage.getItem('amelie.edFontSize.unify-v3')) {
      const ap = loadAppearance();
      if ((ap.editorFontSize ?? ED_SIZE_PREV_DEFAULT) === ED_SIZE_PREV_DEFAULT) {
        ap.editorFontSize = NOTE_ZOOM_BASE;
        applyAppearance(ap);   // persists + refreshes the dropdown label
      }
      localStorage.setItem('amelie.edFontSize.unify-v3', '1');
    }
  } catch (_) {}
  applyNoteZoom();
  // Bind to #editor-pane (not just the hidden legacy textarea) so zoom works with
  // the CodeMirror editor: CM's focus/scroll live in #cm-mount, which is a child of
  // #editor-pane — the old `editor` textarea never receives those events under CM.
  const targets = [$('editor-pane'), $('preview-pane')].filter(Boolean);

  // Ctrl/Cmd + = / + / - / 0
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const active = document.activeElement;
    // Only act when the focus is inside the note area
    const inNote = targets.some(t => t === active || (t && t.contains && t.contains(active)));
    if (!inNote) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); changeNoteZoom(10); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); changeNoteZoom(-10); }
    else if (e.key === '0') { e.preventDefault(); _noteZoom = 100; localStorage.setItem(NOTE_ZOOM_KEY, '100'); applyNoteZoom(); }
  });

  // Ctrl/Cmd + wheel — non-passive so we can preventDefault
  targets.forEach(t => {
    t.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      changeNoteZoom(e.deltaY < 0 ? 6 : -6);
    }, { passive: false });
  });
}

// Autosave: write to disk a couple of seconds after the last keystroke (debounced).
// Not instant on purpose — a short delay means a transient bad state (e.g. a reload
// glitch) is less likely to get persisted before you notice, and leaves room for undo.
const AUTOSAVE_DELAY_MS = 2000;
function scheduleAutosave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  const tab = getActiveTab(); if (!tab || !tab.isDirty || !tab.path) return;
  state.saveTimer = setTimeout(saveCurrentNote, AUTOSAVE_DELAY_MS);
}

// In the reading view the note is not editable, so nothing on the toolbar may write to
// it: the buttons used to act on the hidden editor, inserting text into a note you were
// only reading and bumping its "last edited" through the autosave that followed. Guarded
// at the command dispatcher (toolbar clicks AND the Ctrl+B/I/… shortcuts route through
// it) and again at insertAtCursor, which every insert — heading, table, colour, emoji —
// goes through, so a new button cannot reintroduce this.
const _editingBlocked = () => state.viewMode !== 'edit';
function handleToolbarCmd(cmd) {
  if (_editingBlocked()) return;
  const sel = { s: editor.selectionStart, e: editor.selectionEnd };
  const text = editor.value.substring(sel.s, sel.e);
  let insert = '';
  switch (cmd) {
    case 'emoji': {
      const btn = document.querySelector('.tool-btn[data-cmd="emoji"]');
      const r = btn ? btn.getBoundingClientRect() : { left: 200, bottom: 120 };
      openEmojiPicker(r.left, r.bottom + 4, emo => { editor.focus(); insertAtCursor(emo, sel.s, sel.e); });
      return;
    }
    case 'bold':    if (!text) return; insert = `**${text}**`; break;
    case 'italic':  if (!text) return; insert = `*${text}*`; break;
    case 'code': {
      // If the caret is already inside a fenced code block, ``` is just literal
      // text: insert the bare three backticks (like typing them) instead of
      // scaffolding a nested block, which would mangle the surrounding fences.
      const _isFence = l => /^\s*(```|~~~)/.test(l);
      const cLineStart = editor.value.lastIndexOf('\n', sel.s - 1) + 1;
      const fencesBefore = editor.value.slice(0, cLineStart).split('\n').filter(_isFence).length;
      if (fencesBefore % 2 === 1) { insert = '```'; break; }
      // Inline for a single selected word; otherwise a fenced block with an
      // empty line in the middle and the cursor placed there, ready to type.
      if (text && !text.includes('\n')) { insert = `\`${text}\``; break; }
      // Empty block → the middle line carries the block's 2-space indent so the
      // caret lands at the CODE column (aligned under the fences), exactly like
      // the manual "``` + Enter" path — no 2-space jump on the first keystroke.
      const body = text ? text : '  ';
      // Line index of the opening fence BEFORE the insert (stays stable across the
      // fence-reindent that runs synchronously inside insertAtCursor).
      const openLineIdx = editor.value.slice(0, sel.s).split('\n').length - 1;
      const bodyLineCount = body.split('\n').length;
      // Insert the fences ALREADY at the 2-space indent so the live reindent is a
      // no-op (norm === cur). That avoids a nested execCommand inside insertAtCursor's
      // input event, which used to corrupt the undo stack (Ctrl+Z did nothing).
      insertAtCursor('  ```\n' + body + '\n  ```', sel.s, sel.e);
      // Caret on the FINAL text (reindent may have shifted indents): end of the
      // last content line = the empty middle line for an empty block. Same robust
      // method as the manual "``` + Enter" path.
      const vlines = editor.value.split('\n');
      const lastIdx = openLineIdx + bodyLineCount;
      let off = 0;
      for (let k = 0; k < lastIdx; k++) off += (vlines[k] || '').length + 1;
      const caret = off + ((vlines[lastIdx] || '').length);
      editor.selectionStart = editor.selectionEnd = caret;
      editor.focus();
      return;
    }
    case 'link': {
      // Insert a wiki-link `[[…]]` with the caret in the middle so the user
      // can type the note name and the autocomplete popup kicks in.
      if (text) {
        insert = `[[${text}]]`;
        insertAtCursor(insert, sel.s, sel.e);
      } else {
        insert = '[[]]';
        insertAtCursor(insert, sel.s, sel.e);
        const caret = sel.s + 2; // between the two `[[`
        editor.selectionStart = editor.selectionEnd = caret;
        // Remember where we put the empty `[[]]` so we can strip it later
        // if the user dismisses the popup without picking a note.
        _toolbarEmptyLinkPos = sel.s;
        editor.focus();
        // Explicit user action → open the list even if the typing-suggestions
        // setting is off.
        _wikilinkForce = true;
        try { checkNoteLinkTrigger(); } catch(_) {}
        _wikilinkForce = false;
      }
      return;
    }
    case 'highlight': insert = `==${text || 'testo evidenziato'}==`; break;
    case 'bullet': {
      if (text) {
        insert = text.split('\n').map(l => l.trim() ? `- ${l}` : l).join('\n');
      } else {
        const atLineStart = sel.s === 0 || editor.value.charAt(sel.s - 1) === '\n';
        insert = (atLineStart ? '' : '\n') + '- ';
      }
      break;
    }
    case 'checklist': {
      if (text) {
        insert = text.split('\n').map(l => l.trim() ? `- [ ] ${l}` : l).join('\n');
      } else {
        const atLineStart = sel.s === 0 || editor.value.charAt(sel.s - 1) === '\n';
        insert = (atLineStart ? '' : '\n') + '- [ ] ';
      }
      break;
    }
    case 'image': (async () => {
        const name = await window.inkwell.openAttachmentDialog();
        if (name) insertAttachmentRef(name);
      })(); return;
  }
  insertAtCursor(insert, sel.s, sel.e);
}

function insertAtCursor(text, start, end) {
  if (_editingBlocked()) return;
  start = start ?? editor.selectionStart;
  end = end ?? editor.selectionEnd;
  // CM engine: replace the range via a proper CM transaction (execCommand targets
  // the hidden textarea, not CM). insertAtCursor puts the caret after the text.
  if (_cmActive && _cmHandle) {
    try { _cmHandle.setSelection(start, end); _cmHandle.insertAtCursor(text); _cmHandle.focus(); } catch (_) {}
    return;
  }
  // Insert like real typing: execCommand('insertText') moves the caret to the
  // end of the inserted text AND scrolls it into view natively, then fires a
  // real 'input' event. A bare setRangeText does NOT scroll the caret into
  // view, so after e.g. the checklist button the caret landed off-screen and
  // the visible text/caret looked misplaced.
  editor.focus();
  editor.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (_) {}
  if (!ok) {
    // Fallback for environments without execCommand support.
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  if (document.activeElement !== editor) {
    try { editor.focus(); } catch (_) {}
  }
}

// Attachments foldering: PDFs → attachments/pdf/, VIDEOS → attachments/videos/,
// everything else (images, audio, scripts, …) stays flat at the attachments root.
// Old files in scripts/ media/ audio/ video/ keep working (links carry the path;
// playback is extension-based, not folder-based — so a video in videos/ plays the
// same way).
const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|aac|opus|wma|weba)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|m4v|avi|wmv|mpeg)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
// The ONLY attachment types Amelie accepts, anywhere (drag, paste, sidebar):
// images, audio, video, PDF. Everything else (scripts, archives, docs, …) is
// refused with an "unsupported format" toast — never saved, never linked.
// Deliberately NOT accepted, though they are images/audio/video: ico, avif, ogg,
// oga, mka, mpg, flv. `weba` stays — it is what Amelie's own voice recorder writes
// (`rec-….weba`), so dropping it would orphan every recording made in the app.
const SUPPORTED_ATTACH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|mp3|wav|flac|m4a|aac|opus|wma|weba|mp4|webm|mkv|mov|m4v|avi|wmv|mpeg|pdf)$/i;
function isSupportedAttachmentName(name) { return SUPPORTED_ATTACH_RE.test(name || ''); }
// The types a clipboard/drop item may be accepted BY, when its name carries no usable
// extension — a pasted screenshot often arrives as a nameless `image/png` blob. Only
// the formats above are listed: the previous check asked `/^(image|audio|video)\//`,
// which let every removed format straight back in (an `audio/ogg`, an `image/avif` or
// an `image/tiff` was "an audio/an image", so it passed). Absent on purpose:
// audio/ogg, image/avif, image/x-icon, image/tiff, video/x-flv.
const SUPPORTED_ATTACH_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp',
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac',
  'audio/mp4', 'audio/aac', 'audio/webm', 'audio/x-ms-wma',
  'video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/x-msvideo',
  'video/x-ms-wmv', 'video/mpeg', 'application/pdf',
]);
// File form: accept by extension, or (for name-less pastes like screenshots) by MIME.
function isSupportedAttachmentFile(file) {
  if (!file) return false;
  if (isSupportedAttachmentName(file.name)) return true;
  return SUPPORTED_ATTACH_MIME.has((file.type || '').toLowerCase());
}
function _attachmentTarget(name) {
  if (/\.pdf$/i.test(name)) return 'pdf/' + name;
  if (VIDEO_EXT_RE.test(name)) return 'videos/' + name;
  if (AUDIO_EXT_RE.test(name)) return 'audio/' + name;
  return name;
}

// In the rendered preview, links to AUDIO and VIDEO attachments become inline
// players, Obsidian-style (the markdown source keeps a plain link — portable
// and diff-friendly). A `{width=N}` right after the link sizes the video and
// the drag handle persists it back into the markdown. The historical "video
// can't play" turned out to be the old protocol's broken Range support (fixed
// in v210) — Electron DOES ship the H.264/AAC codecs. A failing player gets
// one silent retry, then a card that opens the system player.
// Vault-relative path of an attachment href, or null. Accepts BOTH formats:
// legacy `inkwell://attachments/…` and clean `attachments/…`.
function _attRel(href) {
  let h = href || '';
  try { h = decodeURIComponent(h); } catch (_) {}
  if (h.startsWith('inkwell://attachments/')) return h.slice('inkwell://attachments/'.length);
  if (h.startsWith('attachments/')) return h.slice('attachments/'.length);
  return null;
}
const ATT_LINK_SELECTOR = 'a[href^="inkwell://attachments/"], a[href^="attachments/"]';

function embedMediaPlayers(root, opts = {}) {
  // Two source shapes become inline players:
  //   (a) plain attachment LINKS to a/v:  [🎵](attachments/song.mp3)  → <a>
  //   (b) the uniform IMAGE form:         ![🎵](attachments/song.mp3) → <img> (broken as
  //       an image, since it's really audio/video) — we swap it for a player too.
  // Collect first (mutating the DOM mid-query would skip nodes).
  const targets = [];
  root.querySelectorAll(ATT_LINK_SELECTOR).forEach(a => {
    const href = a.getAttribute('href') || '';
    let clean = href; try { clean = decodeURIComponent(href); } catch (_) {}
    const isAudio = AUDIO_EXT_RE.test(clean), isVideo = VIDEO_EXT_RE.test(clean);
    if (!isAudio && !isVideo) return;
    // Optional {width=N} written by the resize handle (as a following text node).
    let width = 0;
    const sib = a.nextSibling;
    if (sib && sib.nodeType === Node.TEXT_NODE) {
      const m = sib.nodeValue.match(/^\{width=(\d+)\}/);
      if (m) { width = parseInt(m[1], 10); sib.nodeValue = sib.nodeValue.slice(m[0].length); }
    }
    targets.push({ src: a, href, clean, isAudio, isVideo, width });
  });
  root.querySelectorAll('img').forEach(img => {
    const s = img.getAttribute('src') || '';
    let clean = s; try { clean = decodeURIComponent(s); } catch (_) {}
    const isAudio = AUDIO_EXT_RE.test(clean), isVideo = VIDEO_EXT_RE.test(clean);
    if (!isAudio && !isVideo) return;
    // {width=N} was folded into a width attr by the preview pre-processor.
    const width = parseInt(img.getAttribute('width') || '0', 10) || 0;
    targets.push({ src: img, href: s, clean, isAudio, isVideo, width });
  });

  targets.forEach(({ src, href, clean, isAudio, isVideo, width }) => {
    const wrap = document.createElement('div');
    wrap.className = 'media-embed';
    const label = document.createElement('div');
    label.className = 'media-label';
    label.textContent = (isAudio ? '🎵 ' : '🎬 ') + clean.split('/').pop();
    const el = document.createElement(isAudio ? 'audio' : 'video');
    el.controls = true;
    el.preload = 'metadata';
    // Playback goes through the localhost media server (real HTTP ranges);
    // the markdown keeps a portable attachments/… (or legacy inkwell://) link.
    const rel = _attRel(href) || clean;
    const base = (window.inkwell.mediaBaseUrl && window.inkwell.mediaBaseUrl()) || '';
    el.src = base ? base + encodeURIComponent(rel) : href;
    // One silent retry on error (load hiccups self-heal), then the card.
    el.addEventListener('error', () => {
      if (!el.dataset.retried) {
        el.dataset.retried = '1';
        setTimeout(() => { try { el.load(); } catch (_) {} }, 500);
        return;
      }
      const fb = document.createElement('div');
      fb.className = 'media-fallback';
      const msg = document.createElement('span');
      msg.textContent = '⚠️ ' + window.i18n.t('media.cant_play') + ' [err ' + (el.error?.code ?? '?') + ']';
      const btn = document.createElement('button');
      btn.textContent = window.i18n.t('media.open_system');
      btn.addEventListener('click', () => window.inkwell.openAttachmentFile?.(rel).catch(() => {}));
      fb.append(msg, btn);
      const box = el.closest('.video-box');
      (box || el).replaceWith(fb);
    });
    wrap.append(label);
    // File deleted from attachments → show "Missing" instead of a dead player.
    try {
      window.inkwell.attachmentExists?.(rel).then(ok => {
        if (ok === false) {
          const miss = document.createElement('div');
          miss.className = 'media-label';
          miss.style.color = 'var(--warn, #d29922)';
          miss.textContent = '⚠ ' + window.i18n.t('media.missing') + ' — ' + clean.split('/').pop();
          wrap.replaceWith(miss);
        }
      }).catch(() => {});
    } catch (_) {}
    if (isVideo) {
      const box = document.createElement('div');
      box.className = 'video-box';
      if (width) el.style.width = width + 'px';
      box.appendChild(el);
      if (opts.resizable) {
        const handle = document.createElement('div');
        handle.className = 'img-resize-handle';
        handle.title = window.i18n.t('toolbar.resize_image');
        box.appendChild(handle);
        _setupVideoResize(el, handle, href);
      }
      wrap.appendChild(box);
    } else {
      wrap.appendChild(el);
    }
    src.replaceWith(wrap);
  });
}

// Persist an editor.value change WITHOUT re-rendering the preview. Used by the
// media resize handles on release: the dragged element already shows its final
// size, and dispatching a full 'input' would rebuild the preview — destroying
// and recreating the <video>/<img> (visible flash/reload right after the drag).
function _persistEditorNoRender() {
  const tab = getActiveTab();
  if (tab) { tab.isDirty = true; tab.content = editor.value; }
  applyEditorHighlight();
  setSavedState(false);
  updateWordCount();
  scheduleAutosave();
  try { syncSplitFromMain(); } catch (_) {}
}

// Resizing a photo or a video rewrites `{width=N}` in the markdown — a change that has to
// be stored, but not one the user made to the note's text, so it must not move "last
// edited". Saved right here with keepModified instead of going through the autosave, which
// always stamps the current time. If the note ALREADY had unsaved edits, those are a real
// edit: the timestamp moves, and this just rides along with them.
async function _persistMediaSize() {
  const tab = getActiveTab();
  if (!tab || !tab.path) { _persistEditorNoRender(); return; }
  const hadEdits = !!tab.isDirty;
  tab.content = editor.value;
  applyEditorHighlight();
  updateWordCount();
  try { syncSplitFromMain(); } catch (_) {}
  if (hadEdits) { _persistEditorNoRender(); return; }
  try {
    await window.inkwell.writeNote(tab.path, editor.value, { keepModified: true });
    tab.isDirty = false;
    setSavedState(true);
    updateNoteMeta(tab);
  } catch (_) { _persistEditorNoRender(); }   // couldn't save quietly → the normal route
}

// Drag the handle → live width change; on release the width is persisted into
// the markdown as `[🎬 …](url){width=N}` (mirrors syncImageSizeToMarkdown).
// Pointer capture: pointerup is guaranteed to reach the handle even if the
// initial release happens over the video's native controls or off-window —
// without it the drag could "stick" and follow the mouse until a second click.
function _setupVideoResize(video, handle, href) {
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = video.offsetWidth;
    const onMove = ev => {
      const w = Math.max(160, startW + (ev.clientX - startX));
      video.style.width = w + 'px';
      video.style.maxHeight = 'none';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      const w = Math.round(video.offsetWidth);
      // Match the CLEAN editor form: <img> sources were rewritten to inkwell://…,
      // but the markdown keeps attachments/… — strip the scheme before matching.
      const cleanHref = href.replace(/^inkwell:\/\//, '');
      const esc = cleanHref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(\\[[^\\]]*\\]\\(' + esc + '\\))(?:\\{width=\\d+\\})?');
      const updated = editor.value.replace(re, `$1{width=${w}}`);
      if (updated !== editor.value) {
        editor.value = updated;
        _persistMediaSize();   // stored, but it does not count as editing the note
      }
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

// Inserts a markdown reference for the attachment.
// Media Amelie renders inline (image/audio/video) → embed form ![icon](url).
// Everything else (pdf, zip, …) → plain link [📎](url) — an ![](non-image) would
// render as a broken <img>, and the preview only turns a/v into players.
function insertAttachmentRef(name) {
  const imageExts = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg']);
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  const isImg = imageExts.has(ext);
  const isAudio = AUDIO_EXT_RE.test(name);
  const isVideo = VIDEO_EXT_RE.test(name);
  // CLEAN relative URL — no scheme: the note shows `(attachments/media/x.mp3)`.
  // Renderers resolve it (players via the media server, images via inkwell://);
  // legacy inkwell:// links keep working everywhere.
  const url = `attachments/${name.split('/').map(encodeURIComponent).join('/')}`;
  // SHORT link: the file name is already in the URL, so we don't repeat it in the
  // label (would show twice in edit mode) — just a type icon: 📷 / 🎵 / 🎬 / 📎.
  // The preview builds the player/label from the URL, and rename works off the URL.
  const icon = isImg ? '📷' : isAudio ? '🎵' : isVideo ? '🎬' : '📎';
  const bang = (isImg || isAudio || isVideo) ? '!' : '';   // ! → inline embed for media
  const ref = `\n${bang}[${icon}](${url})\n`;
  insertAtCursor(ref);
  // For media embeds: put the caret at the END of the link (after the ")"), not
  // on the empty line below it. insertAtCursor leaves the caret past the trailing
  // "\n" — step it back one char so it sits right after the link.
  if (bang) {
    const c = editor.selectionStart - 1;
    if (c >= 0) editor.setSelectionRange(c, c);
  }
}

// Pencil (edit) and eye (view) icons for the single mode-toggle button.
const _EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>';
const _VIEW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

// The single toggle shows the mode you'll switch TO: in edit → eye/"View",
// in view → pencil/"Edit".
function updateModeToggle(mode) {
  const btn = $('btn-mode-toggle');
  if (!btn) return;
  const iconEl = btn.querySelector('.mode-toggle-icon');
  const labelEl = btn.querySelector('.mode-toggle-label');
  const goingToView = (mode === 'edit');
  if (iconEl) iconEl.innerHTML = goingToView ? _VIEW_ICON : _EDIT_ICON;
  const label = window.i18n.t(goingToView ? 'toolbar.view' : 'toolbar.edit');
  if (labelEl) labelEl.textContent = label;
  // Tooltip is the longer "Click to …" phrase; the visible pill keeps the short label.
  btn.title = window.i18n.t(goingToView ? 'toolbar.view_tip' : 'toolbar.edit_tip');
  // The custom-tooltip layer caches title→data-tip on first hover, so refresh it
  // here too in case it was already converted for a previous mode.
  btn.setAttribute('data-tip', btn.title);
}

// The CodeMirror scroll element (its scrollTop/scrollHeight/clientHeight), used to
// read/apply a proportional scroll position when toggling edit⇄view.
function _cmScrollEl() { try { return _cmHandle && _cmHandle.view && _cmHandle.view.scrollDOM; } catch (_) { return null; } }
function _scrollFrac(el) { if (!el) return 0; const max = el.scrollHeight - el.clientHeight; return max > 8 ? el.scrollTop / max : 0; }
function _applyScrollFrac(el, frac) { if (!el || frac == null) return; const max = el.scrollHeight - el.clientHeight; el.scrollTop = max > 0 ? Math.max(0, Math.round(frac * max)) : 0; }

// A control that cannot do anything must not look as if it could: in the reading view the
// writing buttons (bold, italic, lists, code, link, emoji, image, heading, colour, table,
// undo/redo) are dimmed and stop taking clicks. The toolbar lives in the note header, not
// in the editor pane, so it stays on screen while reading — which is how a click on one of
// them used to reach the note at all. Reading-mode controls (search, index, export, the
// mode toggle) are untouched.
const WRITING_CONTROL_SEL = '.tool-btn[data-cmd], #btn-heading, #btn-color, #btn-table, #btn-undo, #btn-redo, #btn-audio-rec';
function _updateWritingControls(mode) {
  document.querySelectorAll(WRITING_CONTROL_SEL).forEach(b => b.classList.toggle('reading-off', mode !== 'edit'));
}
function setViewMode(mode, opts) {
  const editorPane = $('editor-pane');
  const previewPane = $('preview-pane');
  const fmPanel = $('frontmatter-panel');
  // Keep the reading position across an edit⇄view toggle: capture how far (as a
  // fraction 0..1) the pane we're LEAVING is scrolled, and re-apply it to the pane we
  // ENTER once it has laid out — so clicking the view/edit icon no longer jumps to the
  // top. Only on a real toggle (opts.preserveScroll); tab restore keeps its saved pos.
  let _frac = null;
  if (opts && opts.preserveScroll && state.viewMode !== mode) {
    _frac = _scrollFrac(state.viewMode === 'edit' ? _cmScrollEl() : previewPane);
  }
  state.viewMode = mode;
  updateModeToggle(mode);
  _updateWritingControls(mode);
  // One toggle for the whole note: the split half had its own edit/view button, which meant
  // two controls doing the same thing and two halves that could disagree. It follows this one.
  if (_splitPath) { try { setSplitMode(mode); } catch (_) {} }
  try { if (typeof _vcHideBubble === 'function') _vcHideBubble(); } catch (_) {}
  if (mode === 'edit') {
    editorPane.style.display = 'flex';
    previewPane.style.display = 'none';
    if (fmPanel) fmPanel.classList.remove('hidden');
    updateMetaRows(true);
    refreshAttachmentChips();
    // Don't steal keyboard focus (and the header title, via the focusin
    // tracker) from the split pane on programmatic mode switches.
    if (!(_splitPath && _focusedPane === 'split')) editor.focus();
    // The editor was display:none (clientWidth 0): the code-block boxes don't
    // exist / would be wrong. Rebuild them at the first usable layout.
    requestAnimationFrame(() => {
      try { decorateEditorCodeBlocks(); } catch (_) {}
      try { renderEditorGutter(); } catch (_) {}
      // Same reason as the two calls above, for CodeMirror's OWN document view: it
      // cannot render or measure while the pane is display:none, which is how the DOM
      // ends up holding only part of the note. A stale DOM here is not cosmetic — CM
      // re-reads it on every keystroke, thinks the note shrank, and tries to delete the
      // rest; the content-loss firewall then blocks key after key and the editor looks
      // frozen. Verify and rebuild BEFORE the user can type. Cheap: one length compare,
      // and it skips out immediately on a virtualized (big) note.
      try { if (_cmActive && _cmHandle && _cmHandle.checkSync) _cmHandle.checkSync('view->edit'); } catch (_) {}
      _applyScrollFrac(_cmScrollEl(), _frac);
    });
  } else {
    updatePreview();
    editorPane.style.display = 'none';
    previewPane.style.display = 'flex';
    if (fmPanel) fmPanel.classList.add('hidden');
    updateMetaRows(false);
    const _chips = $('attachment-chips'); if (_chips) _chips.style.display = 'none';
    // Restore the reading position once the preview has FULLY laid out. A big
    // note renders incrementally (blocks stream in over many frames), so a fixed
    // rAF would fire mid-stream while scrollHeight is still growing and land far
    // too high. Hand the fraction to the render pipeline instead: updatePreview
    // (called just above) reset _pendingPreviewScrollFrac to null, and
    // enhancePreviewContent applies it against the complete document height.
    if (_frac != null) _pendingPreviewScrollFrac = _frac;
  }
}

// Add a language label (top-left) and a copy button (top-right) to every
// fenced code block in the preview. Idempotent: skips blocks already done.
const _COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const _CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function decorateCodeBlocks(root = previewContent) {
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.code-copy-btn')) return;
    const code = pre.querySelector('code');

    // Copy button (top-right corner)
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.title = window.i18n.t('toolbar.copy_code');
    btn.innerHTML = _COPY_SVG;
    btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const text = (code || pre).textContent;
      // Instant visual feedback — don't wait for the async clipboard promise
      btn.classList.add('copied');
      btn.innerHTML = _CHECK_SVG;
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = _COPY_SVG; }, 1000);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
        } catch(_) {}
      }
    });
    pre.appendChild(btn);
  });
}

// Emoji shortcode → character. Curated set of the most common ones (GitHub style).
// :name: in the note is rendered as an emoji in the preview.
const EMOJI_MAP = {
  // A few smileys + hacking/security emoji
  sunglasses:'😎', nerd_face:'🤓', thinking:'🤔',
  skull_crossbones:'☠️', ninja:'🥷', detective:'🕵️', mask_theatre:'🎭', incognito:'🥸',
  beetle:'🪲', microbe:'🦠', worm:'🪱', syringe:'💉', spider:'🕷️', spider_web:'🕸️',
  old_key:'🗝️', chains:'⛓️', firecracker:'🧨', dagger:'🗡️', crossed_swords:'⚔️', locked_key:'🔐',
  fishing:'🎣', hook:'🪝', eye:'👁️', flashlight:'🔦', pager:'📟', radioactive:'☢️', biohazard:'☣️',
  no_entry:'⛔', prohibited:'🚫', warning2:'⚠️', fire_hack:'🔥', boom_hack:'💥', zap_hack:'⚡',
  heart:'❤️', orange_heart:'🧡', yellow_heart:'💛', green_heart:'💚', blue_heart:'💙',
  purple_heart:'💜', black_heart:'🖤', white_heart:'🤍', broken_heart:'💔', two_hearts:'💕',
  sparkling_heart:'💖', heartpulse:'💗', cupid:'💘', fire:'🔥', sparkles:'✨', star:'⭐', star2:'🌟',
  zap:'⚡', boom:'💥', collision:'💥', dizzy:'💫', thumbsup:'👍', '+1':'👍', thumbsdown:'👎', '-1':'👎',
  ok_hand:'👌', punch:'👊', fist:'✊', wave:'👋', raised_hand:'✋', clap:'👏', pray:'🙏',
  muscle:'💪', point_up:'☝️', point_down:'👇', point_left:'👈', point_right:'👉', v:'✌️',
  crossed_fingers:'🤞', handshake:'🤝', writing_hand:'✍️', eyes:'👀', brain:'🧠',
  rocket:'🚀', tada:'🎉', confetti_ball:'🎊', balloon:'🎈', gift:'🎁', trophy:'🏆', medal:'🏅',
  '100':'💯', warning:'⚠️', no_entry:'⛔', x:'❌', heavy_check_mark:'✔️', white_check_mark:'✅',
  ballot_box_with_check:'☑️', question:'❓', exclamation:'❗', bangbang:'‼️', bulb:'💡',
  bell:'🔔', lock:'🔒', unlock:'🔓', key:'🔑', mag:'🔍', link:'🔗', paperclip:'📎', pushpin:'📌',
  pencil:'📝', memo:'📝', book:'📖', books:'📚', bookmark:'🔖', clipboard:'📋', calendar:'📅',
  date:'📆', email:'📧', envelope:'✉️', inbox_tray:'📥', outbox_tray:'📤', package:'📦',
  computer:'💻', desktop:'🖥️', keyboard:'⌨️', iphone:'📱', battery:'🔋', floppy_disk:'💾',
  space_invader:'👾', penguin:'🐧', crab:'🦀', satellite:'🛰️', antenna:'📡', mouse_pc:'🖱️',
  joystick:'🕹️', printer:'🖨️', cd:'💿', dvd:'📀', minidisc:'💽', test_tube:'🧪', dna:'🧬',
  microscope:'🔬', telescope:'🔭', magnet:'🧲', electric_plug:'🔌', abacus:'🧮', technologist:'👨‍💻',
  toolbox:'🧰', globe:'🌐', signal:'📶', chart_up:'📈', chart_bar:'📊',
  camera:'📷', video_camera:'📹', tv:'📺', telephone:'☎️', hourglass:'⌛', watch:'⌚',
  alarm_clock:'⏰', stopwatch:'⏱️', moneybag:'💰', dollar:'💵', credit_card:'💳', gem:'💎',
  wrench:'🔧', hammer:'🔨', gear:'⚙️', nut_and_bolt:'🔩', shield:'🛡️', bomb:'💣',
  coffee:'☕', tea:'🍵', beer:'🍺', wine_glass:'🍷', pizza:'🍕', hamburger:'🍔', cake:'🍰',
  birthday:'🎂', apple:'🍎', sun:'☀️', sunny:'☀️', cloud:'☁️', umbrella:'☔', snowflake:'❄️',
  snowman:'⛄', rainbow:'🌈', ocean:'🌊', earth_africa:'🌍', moon:'🌙', dog:'🐶', cat:'🐱',
  rabbit:'🐰', bear:'🐻', panda_face:'🐼', tiger:'🐯', unicorn:'🦄', bug:'🐛', bee:'🐝',
  snail:'🐌', whale:'🐳', dolphin:'🐬', fish:'🐟', turtle:'🐢', snake:'🐍', dragon:'🐉',
  seedling:'🌱', herb:'🌿', four_leaf_clover:'🍀', maple_leaf:'🍁', cherry_blossom:'🌸',
  rose:'🌹', sunflower:'🌻', tulip:'🌷', christmas_tree:'🎄', flag_it:'🇮🇹', flag_gb:'🇬🇧',
  flag_us:'🇺🇸', check:'✅', cross:'❌', arrow_right:'➡️', arrow_left:'⬅️', arrow_up:'⬆️',
  arrow_down:'⬇️', recycle:'♻️', infinity:'♾️', hash:'#️⃣', tm:'™️', copyright:'©️', registered:'®️',
  hourglass_flowing_sand:'⏳', construction:'🚧', no_entry_sign:'🚫', skull:'💀', ghost:'👻',
  alien:'👽', robot:'🤖', poop:'💩', clown_face:'🤡', wave_hand:'👋', raised_hands:'🙌',
  ok:'🆗', new:'🆕', top:'🔝', cool:'🆒', free:'🆓', up:'🆙', sos:'🆘',
};

// ── Emoji picker (reused: editor toolbar + note/folder context menu) ──
// Curated set for LABELING notes/folders: folders, documents, tech, security,
// categories, objects — no chat smileys/hearts.
const PICKER_EMOJIS = [
  ['📁','folder'],['📂','folder open'],['🗂️','folders dividers'],['🗃️','box file'],['🗄️','cabinet'],
  ['📄','document file'],['📃','page'],['📝','note memo'],['📋','clipboard'],['📑','tabs'],['🗒️','notepad'],['🧾','receipt'],
  ['📚','books'],['📖','book'],['📕','book red'],['📗','book green'],['📘','book blue'],['📙','book orange'],['📔','notebook'],['📓','notebook'],
  ['🔖','bookmark'],['🏷️','label tag'],['📌','pin'],['📍','location'],['📎','paperclip'],['✂️','scissors'],
  ['✏️','pencil'],['🖊️','pen'],['🖌️','brush'],['🖍️','crayon'],['📐','ruler'],['📏','ruler'],
  ['💡','idea light'],['🧠','brain'],['🎯','target goal'],['⭐','star'],['🌟','star glow'],['🔥','fire'],['⚡','zap energy'],['✨','sparkles'],['🚀','rocket'],['🏆','trophy'],['🎓','study graduation'],
  ['💻','laptop pc'],['🖥️','desktop'],['⌨️','keyboard'],['🖱️','mouse'],['💾','disk save'],['💿','cd disc'],['📀','dvd'],['⚙️','gear settings'],['🔧','wrench'],['🔨','hammer'],['🛠️','tools'],['🧰','toolbox'],['🔩','bolt'],['🧲','magnet'],['🔋','battery'],['🔌','plug'],
  ['🌐','globe web www'],['🛰️','satellite'],['📡','antenna signal'],['📶','signal'],['🐧','linux penguin tux'],['🪟','windows window os'],['🍏','apple mac macos'],['ℹ️','info information'],['🤖','robot bot'],['👾','invader monster'],['🐛','bug'],['🦀','crab rust'],['🐍','snake python'],['🐳','docker whale'],
  ['🔐','lock key secure'],['🔒','lock'],['🔓','unlock'],['🔑','key'],['🗝️','old key'],['🛡️','shield security'],['👁️','eye'],['🕵️','detective spy'],['🥷','ninja hacker'],['💀','skull'],['☠️','skull danger'],['🧨','firecracker exploit'],['💣','bomb'],['🔦','flashlight'],['⛓️','chains'],['🎣','phishing fishing'],
  ['💰','money bag'],['💳','card'],['💎','gem'],['🪙','coin'],['📈','chart up stats'],['📊','chart bar'],['🛒','cart shop'],
  ['🏠','home house'],['🏢','office building'],['🏦','bank'],['🏭','factory'],['🏥','hospital'],['🏫','school'],
  ['✈️','plane travel'],['🚗','car'],['🗺️','map'],['🌍','earth world'],['🧭','compass'],
  ['📅','calendar date'],['📆','calendar'],['⏰','alarm clock'],['⏳','hourglass'],['🕒','clock time'],
  ['🎵','music note'],['🎨','art design'],['📷','camera photo'],['🎬','movie film video'],['🎮','game gaming'],['🎧','headphones audio'],
  ['🍕','food pizza'],['☕','coffee'],['🍔','burger'],['🥗','salad'],
  ['🌱','seedling'],['🌿','herb plant'],['🌳','tree'],['🌸','flower'],
  ['🐶','dog'],['🐱','cat'],['🦊','fox'],['🐼','panda'],
  ['🩺','health medical'],['💊','pill med'],['🧪','test tube lab'],['🔬','microscope'],['🧬','dna'],['🔭','telescope'],
  ['📦','package box'],['🎁','gift'],['🔔','bell notify'],['📣','megaphone'],
  ['✅','check done ok'],['❌','cross no'],['⚠️','warning'],['❓','question'],['❗','exclaim'],['➕','plus add'],['🔗','link'],['🔍','search find'],['🚩','flag'],
  ['🔴','red dot'],['🟢','green dot'],['🟡','yellow dot'],['🔵','blue dot'],['🟣','purple dot'],['⚫','black dot'],['⚪','white dot'],
  // ── Computing & hardware ──
  ['🖲️','trackball'],['🕹️','joystick arcade'],['🖨️','printer'],['📟','pager'],['📠','fax'],['☎️','telephone'],['📞','phone receiver'],['📱','smartphone'],['📲','phone arrow'],['⌚','smartwatch wearable'],['🪫','low battery'],['💽','minidisc'],['📼','tape vhs'],['🧮','abacus'],['🛜','wireless wifi router access point lan'],['📺','monitor screen'],['📻','radio'],['🎙️','studio mic'],['🗜️','clamp compress zip archive'],['🪙','token chip'],
  // ── Hacking & security ──
  ['🕸️','web net spiderweb'],['🪲','beetle debug'],['🐞','ladybug bug'],['🦠','virus malware microbe'],['🔏','lock pen sign'],['🪪','id badge credentials'],['📛','name badge'],['🔰','beginner noob'],['🚨','alarm siren alert'],['📵','no phones'],['🔞','restricted nsfw'],['🚷','no pedestrian'],['⛔','no entry'],['🚫','forbidden block deny'],['☢️','radioactive nuclear'],['☣️','biohazard'],['⚠️','warning hazard'],['🚧','construction wip'],['🔋','battery charge'],
  // ── Weapons & tools ──
  ['🔪','knife blade'],['🗡️','dagger'],['⚔️','crossed swords'],['🪓','axe'],['🔫','gun pistol'],['🪛','screwdriver'],['⛏️','pick mining'],['⚒️','hammer pick'],['🪤','trap honeypot'],['🧯','fire extinguisher'],['🪝','hook'],
  // ── Cyberpunk & sci-fi ──
  ['🤖','robot android ai'],['👾','invader alien game'],['👽','alien'],['🛸','ufo flying saucer'],['🚀','rocket'],['🦾','cybernetic arm bionic'],['🦿','cybernetic leg bionic'],['🕶️','dark sunglasses shades'],['🥽','goggles vr'],['🧿','nazar amulet'],['🔮','crystal ball'],['💊','pill matrix'],['🪩','disco mirror ball neon'],['🛰️','satellite'],['🪐','planet saturn'],['🌌','galaxy cyberspace'],['☄️','comet'],['🌠','shooting star'],['⚗️','alembic chemistry'],['🧫','petri dish'],['🩻','xray scan'],['🧠','brain neural'],
  // ── Neon city & night ──
  ['🌃','night city'],['🌆','city dusk'],['🌇','sunset skyline'],['🌉','bridge night'],['🏙️','cityscape skyline'],['🌫️','fog mist'],['🌧️','rain'],['⛈️','storm thunder'],['🌩️','lightning bolt'],['🎆','fireworks'],['🎇','sparkler neon'],['🕯️','candle'],['🔦','flashlight torch'],
  // ── Money & crypto ──
  ['💸','money flying'],['💵','cash dollar'],['💴','yen'],['💶','euro'],['💷','pound'],['🏧','atm'],['💱','currency exchange'],['💹','chart up money'],['📉','trend down'],['🧾','receipt invoice'],['⚖️','balance scale'],
  // ── Vehicles ──
  ['🏍️','motorcycle bike'],['🚓','police car'],['🚁','helicopter'],['🚙','suv'],['🛹','skateboard'],['🛵','moped scooter'],['🚦','traffic light'],['🚥','signal lights'],['🛢️','oil drum barrel'],
  // ── IT mascots ──
  ['🐙','octopus git github'],['🦫','beaver go golang'],['🐡','blowfish puffer'],['🦅','eagle'],
  // ── DevOps, infra & networking (mapped glyphs + searchable keywords;
  //    most of these have no real Unicode emoji, so search by name) ──
  ['🛢️','database db sql redis cache postgres mysql mongo data store oil drum'],
  ['☸️','kubernetes k8s helm orchestration cluster container'],
  ['🐳','docker container image compose'],
  ['🧱','firewall wall waf iptables bricks'],
  ['📜','script shell bash scroll sh ps1'],
  ['🌐','network networking dns internet lan web globe'],
  ['📡','router modem dns gateway antenna'],
  ['🔀','load balancer switch routing proxy nat'],
  ['🔌','api port socket ethernet endpoint plug'],
  ['🗄️','server rack datacenter storage nas'],
  ['🖥️','server host node machine vm'],
  ['☁️','cloud aws azure gcp hosting serverless'],
  ['🔑','ssh key auth token secret credentials'],
  ['🛡️','firewall security defense vpn waf'],
  ['📦','container package deploy artifact image npm registry'],
  ['🪵','log logs logging journal syslog'],
  ['📈','metrics monitoring observability grafana prometheus'],
  ['🔔','alert notification oncall pager incident'],
  ['⚙️','service daemon config systemd cron'],
  ['🔗','api endpoint webhook url link rest'],
  ['🐍','python script py'],['💎','ruby gem'],['☕','java jvm coffee'],['🐘','php elephant'],['🦀','rust cargo crab'],
  // ── Symbols & status ──
  ['☑️','checkbox checked'],['✔️','check mark'],['❎','cross button'],['⭕','circle no'],['‼️','double exclaim'],['⁉️','interrobang'],['💯','hundred perfect'],['🔣','symbols'],['🔢','numbers'],['🔠','letters caps'],['🔡','letters lower'],['#️⃣','hash pound'],['*️⃣','asterisk star'],['♾️','infinity'],['➖','minus'],['✖️','multiply'],['➗','divide'],['🟰','equals'],['💲','dollar sign'],['©️','copyright'],['®️','registered'],['™️','trademark'],['📛','badge'],['🔱','trident'],
  ['➡️','arrow right'],['⬅️','arrow left'],['⬆️','arrow up'],['⬇️','arrow down'],['↗️','arrow up right'],['↘️','arrow down right'],['↙️','arrow down left'],['↖️','arrow up left'],['↔️','arrow horizontal'],['↕️','arrow vertical'],['🔄','sync refresh'],['🔁','loop repeat'],['🔀','shuffle'],['▶️','play run'],['⏸️','pause'],['⏹️','stop'],['⏭️','next'],['⏮️','prev'],['🔝','top'],['🔙','back'],['🔜','soon'],
  ['🟠','orange dot'],['🟤','brown dot'],['🟥','red square'],['🟧','orange square'],['🟨','yellow square'],['🟩','green square'],['🟦','blue square'],['🟪','purple square'],['⬛','black square'],['⬜','white square'],['🔲','button black'],['🔳','button white'],['🔘','radio button'],['🔺','triangle up'],['🔻','triangle down'],['💠','diamond'],['🔆','brightness'],['🔅','dim'],['🔇','mute'],['🔊','volume loud'],
  // ── Flags ──
  ['🏁','checkered finish'],['🚩','flag marker'],['🏴','black flag'],['🏴‍☠️','pirate flag jolly roger'],['🇮🇹','italy'],['🇬🇧','uk britain'],['🇺🇸','usa america'],['🇪🇺','eu europe'],['🇩🇪','germany'],['🇫🇷','france'],['🇪🇸','spain'],['🇯🇵','japan'],
];

let _emojiPickerEl = null;
function closeEmojiPicker() { if (_emojiPickerEl) { _emojiPickerEl.remove(); _emojiPickerEl = null; document.removeEventListener('mousedown', _emojiOutside, true); } }
function _emojiOutside(e) { if (_emojiPickerEl && !_emojiPickerEl.contains(e.target)) closeEmojiPicker(); }
function openEmojiPicker(x, y, onPick) {
  closeEmojiPicker();
  const list = PICKER_EMOJIS.map(([emo, name]) => ({ emo, name }));
  const pop = document.createElement('div'); pop.id = 'emoji-picker';
  const search = document.createElement('input'); search.className = 'emoji-search'; search.placeholder = window.i18n.t('emoji.search');
  const grid = document.createElement('div'); grid.className = 'emoji-grid';
  const render = (filter) => {
    grid.innerHTML = ''; const f = (filter || '').toLowerCase();
    list.filter(it => !f || it.name.includes(f)).forEach(it => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'emoji-cell'; b.textContent = it.emo; b.title = ':' + it.name + ':';
      b.addEventListener('mousedown', e => e.preventDefault());
      b.addEventListener('click', () => { onPick(it.emo); closeEmojiPicker(); });
      grid.appendChild(b);
    });
  };
  render('');
  search.addEventListener('input', () => render(search.value));
  search.addEventListener('keydown', e => { if (e.key === 'Escape') closeEmojiPicker(); });
  pop.append(search, grid);
  document.body.appendChild(pop);
  const pw = 372, ph = 340;
  pop.style.left = Math.max(8, Math.min(x, window.innerWidth - pw - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(y, window.innerHeight - ph - 8)) + 'px';
  _emojiPickerEl = pop;
  setTimeout(() => search.focus(), 30);
  setTimeout(() => document.addEventListener('mousedown', _emojiOutside, true), 0);
}

// Sanitize the HTML produced from a note's markdown BEFORE it touches the DOM.
// DOMPurify strips <script>, inline event handlers (onerror/onclick…), javascript:
// URLs etc., so no code embedded in a note (raw HTML or otherwise) can ever run.
// We allow the app's own `inkwell:` attachment scheme (+ blob:/data: media, like
// the CSP) and forbid embedding tags. Code FENCES are already text-escaped by
// marked; this closes the raw-HTML hole too.
const _NOTE_SANITIZE = {
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|inkwell|blob|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
  ADD_ATTR: ['target'],
};
function sanitizeNoteHtml(html) {
  return (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(html, _NOTE_SANITIZE) : '';
}

// Bumped on every preview render (main + split); the deferred enhancement pass
// and the chunked highlighter check them so they never decorate content the user
// has already navigated away from.
let _previewRenderToken = 0;
let _splitRenderToken = 0;

// A scroll fraction (0..1) that setViewMode wants restored to the main preview
// AFTER this render finishes laying out — not after a fixed rAF. On a big note
// the incremental render streams blocks in over many frames, so scrollHeight is
// still growing when an early rAF fires; applying the fraction then lands far
// too high. enhancePreviewContent (which runs once the WHOLE DOM is in place)
// consumes this, so the fraction maps onto the complete document height.
let _pendingPreviewScrollFrac = null;

// Rendered-HTML length (chars) above which the main preview switches from a
// single blocking innerHTML to incremental, idle-batched DOM insertion — see
// renderPreviewIncremental. Below it the one-shot path is already fast.
const PREVIEW_INCREMENTAL_MIN = 300 * 1024;

// Syntax highlighting ALWAYS runs (colours kept), but AFTER the text is painted
// and in small idle-time batches — so even a code-heavy multi-MB note colours in
// progressively without ever blocking the UI. `stillValid()` returns false once a
// newer render supersedes this one, cutting the remaining work short.
function highlightCodeChunked(stillValid, els, i) {
  if (typeof hljs === 'undefined' || !stillValid()) return;
  const BATCH = 12;
  const end = Math.min(i + BATCH, els.length);
  for (; i < end; i++) {
    const el = els[i];
    // Highlight ONLY blocks with an explicit language (```bash, ```yaml…).
    // Without a language no auto-detect → plain text, no colour.
    if ([...el.classList].some(c => c.startsWith('language-'))) hljs.highlightElement(el);
  }
  if (i < els.length) {
    (window.requestIdleCallback || requestAnimationFrame)(() => highlightCodeChunked(stillValid, els, i));
  }
}

function updatePreview() {
  if (typeof marked === 'undefined') return;
  // Default: no scroll to restore. setViewMode sets _pendingPreviewScrollFrac
  // AFTER calling updatePreview when it wants the reading position preserved;
  // clearing it here keeps a stale fraction from a previous render (e.g. one
  // abandoned by a note switch) from being applied to this one.
  _pendingPreviewScrollFrac = null;
  marked.setOptions({ breaks: true, gfm: true });
  const body = _previewBody(editor.value);

  // Strip column-width markers (`<!-- amelie:colw=N,N,N -->`) so they don't
  // render; remember widths positionally to re-apply to each table.
  const { cleanedBody, widthsByTable } = extractTableWidthMarkers(body);

  // Pre-process: [[note links]] → clickable spans
  // Pre-process: ![alt](url){width=N} → <img width="N">
  const processedBody = cleanedBody
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      const t = target.trim();
      const display = (alias || target).trim();
      return `<a class="note-link" data-note="${t.replace(/"/g, '&quot;')}" href="#">${display}</a>`;
    })
    .replace(/(!)\[([^\]]*)\]\(([^)]+)\)\{width=(\d+)\}/g,
      (_, bang, alt, url, w) => `<img src="${url}" alt="${alt}" width="${w}" style="width:${w}px;height:auto">`)
    // ==text== → highlighted span (gentle yellow). Skips code spans/blocks.
    .replace(/==([^=\n]+?)==/g, '<mark class="md-highlight">$1</mark>')
    // :shortcode: → emoji (only the known ones; unknown ones stay unchanged).
    .replace(/:([a-z0-9_+-]+):/g, (m, name) => EMOJI_MAP[name] || m);

  let html = marked.parse(processedBody);
  // Clean relative image refs resolve through the inkwell protocol.
  html = html.replace(/(src=")attachments\//g, '$1inkwell://attachments/');

  // Paint-first, plus incremental insertion for large notes. Small notes take
  // the simple path: one innerHTML, then the enhancement passes (syntax
  // highlight, media players, image-resize wrapping, link/table wiring) deferred
  // to the next frame. A big note would block for seconds on that single
  // innerHTML alone (building 100k+ DOM nodes WITH layout), so it instead goes
  // through renderPreviewIncremental, which streams the blocks in over idle time.
  // The render token guards both paths so stale work is dropped once the user
  // switches notes or types again.
  const _token = ++_previewRenderToken;
  if (html.length > PREVIEW_INCREMENTAL_MIN && typeof DOMPurify !== 'undefined') {
    renderPreviewIncremental(_token, html, widthsByTable);
  } else {
    previewContent.innerHTML = sanitizeNoteHtml(html);
    requestAnimationFrame(() => {
      if (_token !== _previewRenderToken) return; // superseded — skip stale work
      enhancePreviewContent(_token, widthsByTable);
    });
  }
}

// Large-note render (see PREVIEW_INCREMENTAL_MIN). DOMPurify sanitizes the HTML
// once directly into an INERT DocumentFragment — no layout, no image loading yet
// — then we move its top-level blocks into #preview-content in idle-time batches.
// The note paints almost immediately and the rest streams in without a
// multi-second freeze. Rendering fidelity is identical to the one-shot path
// (same sanitized nodes, same order); only the timing of insertion changes.
// Enhancement runs once the whole document is in place (table indices / TOC need
// the complete DOM). `token` supersedes a stale insert (note switch / keystroke).
function renderPreviewIncremental(token, html, widthsByTable) {
  const frag = DOMPurify.sanitize(html, Object.assign({ RETURN_DOM_FRAGMENT: true }, _NOTE_SANITIZE));
  previewContent.innerHTML = '';
  const BATCH = 150; // element blocks inserted per frame
  const step = () => {
    if (token !== _previewRenderToken) return; // superseded — abandon stale insert
    let n = 0;
    // Move whole blocks over; only ELEMENT nodes count toward the batch so the
    // insignificant newline text nodes marked leaves between blocks don't halve
    // throughput. requestAnimationFrame gives steady per-frame progress (unlike
    // requestIdleCallback, which can be starved and stall a big render).
    while (frag.firstChild && n < BATCH) {
      const node = frag.firstChild;
      previewContent.appendChild(node);
      if (node.nodeType === 1) n++;
    }
    if (frag.firstChild) {
      requestAnimationFrame(step);
    } else {
      enhancePreviewContent(token, widthsByTable);
    }
  };
  step(); // first batch runs synchronously → immediate paint
}

// Deferred second half of updatePreview (see the paint-first note above). Runs
// all the DOM-decoration passes over #preview-content. Syntax highlighting is
// kept (colours!) but dispatched to highlightCodeChunked so it batches over idle
// time instead of blocking on a code-heavy note. `token` guards against staleness.
// Colour inline #tags blue in the rendered preview so they read as tags. Walks
// TEXT nodes only (never touches links, code, or existing markup) and skips code
// spans/blocks. Same match rule as the editor + the sidebar Tags parser.
function highlightInlineTags(root) {
  if (!root) return;
  const re = /(^|\s)(#[A-Za-z][\w-]*)/g;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || node.nodeValue.indexOf('#') === -1) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p || p.closest('code, pre, a, .md-tag')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length;       // start of '#'
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const span = document.createElement('span');
      span.className = 'md-tag';
      span.textContent = m[2];                    // #tag
      frag.appendChild(span);
      last = start + m[2].length;
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function enhancePreviewContent(token, widthsByTable) {
  if (typeof hljs !== 'undefined') {
    highlightCodeChunked(() => token === _previewRenderToken,
      [...previewContent.querySelectorAll('pre code')], 0);
  }
  // Code blocks: language label (top-left) + copy button (top-right corner)
  decorateCodeBlocks();

  // Colour #tags blue (after code decoration so code spans are already skipped).
  try { highlightInlineTags(previewContent); } catch (_) {}

  // Task-list checkboxes: make them clickable (Obsidian style)
  enhanceCheckboxes();

  // Audio/video attachment links → inline players (resizable video here:
  // the handle writes {width=N} back into the main editor's markdown)
  embedMediaPlayers(previewContent, { resizable: true });

  // Wrap images for resizing
  previewContent.querySelectorAll('img').forEach(img => {
    if (img.closest('.img-resize-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'img-resize-wrap';
    img.parentNode.insertBefore(wrap, img);
    wrap.appendChild(img);
    const handle = document.createElement('div');
    handle.className = 'img-resize-handle';
    handle.title = window.i18n.t('toolbar.resize_image');
    wrap.appendChild(handle);
    setupImageResize(img, handle);

    // Right-click → image context menu
    img.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      showImageContextMenu(e, img);
    });
  });

  // Note links → open note on click
  previewContent.querySelectorAll('.note-link').forEach(a => {
    const name = a.dataset.note || '';
    const node = resolveNoteLink(name);
    if (node) {
      // Same navy as regular markdown links for visual consistency.
      a.style.cssText = 'color:var(--link);text-decoration:none;border-bottom:1px dashed color-mix(in srgb, var(--link) 55%, transparent);cursor:pointer';
    } else {
      // Unresolved link — render like normal text (no red error). On hover show
      // its original wikilink form, e.g. [[name test]]. Marked so the "Go to"
      // hover hint skips it (there is nowhere to go).
      a.style.cssText = 'color:inherit;text-decoration:none;border-bottom:1px dotted rgba(140,140,150,0.45);cursor:default';
      a.title = '[[' + name + ']]';
      a.dataset.unresolved = '1';
    }
    a.addEventListener('click', e => {
      e.preventDefault();
      const target = resolveNoteLink(a.dataset.note || '');
      if (target) {
        // Remember where we came from: "Torna alla nota precedente" in the
        // right-click menu walks this stack back.
        if (state.currentPath && state.currentPath !== target.path) {
          _noteBackStack.push(state.currentPath);
          if (_noteBackStack.length > 50) _noteBackStack.shift();
        }
        openNote(target);
      }
    });
  });

  // External links (http, https, www, mailto) → open in default browser.
  // Skip note-links (already handled above) and attachment links.
  previewContent.querySelectorAll('a:not(.note-link)').forEach(a => {
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;
    // Attachment links (📎) are wired separately below — leave them alone.
    if (a.matches(ATT_LINK_SELECTOR)) return;
    const isWeb = /^https?:\/\//i.test(href) ||
                  /^www\./i.test(href) ||
                  /^mailto:/i.test(href);
    a.addEventListener('click', e => {
      // Never let a note-embedded anchor navigate this window. Only http(s)/
      // mailto/www open in the system browser; anything else (data:, blob:,
      // unknown schemes) is neutralized — clicking it does nothing. This closes
      // a navigation-XSS where a `data:text/html` link would load into this
      // webContents and reach window.inkwell. (main.js will-navigate is the
      // hard backstop; this stops it at the source.)
      e.preventDefault();
      if (isWeb) window.inkwell.openExternal(href).catch(() => {});
    });
  });

  // Attachment links still rendered as anchors (📎 scripts/files — media were
  // replaced by players above): a click REVEALS the file in the file manager.
  // Never open/execute the file itself — scripts especially must not run.
  previewContent.querySelectorAll(ATT_LINK_SELECTOR).forEach(a => {
    a.dataset.attachmentWired = '1';
    a.style.cursor = 'pointer';
    // Deleted attachment → "⚠ Missing —" in front of the link, muted style.
    try {
      const relX = _attRel(a.getAttribute('href'));
      if (relX) window.inkwell.attachmentExists?.(relX).then(ok => {
        if (ok === false && !a.dataset.missingMarked) {
          a.dataset.missingMarked = '1';
          const pre = document.createElement('span');
          pre.style.cssText = 'color:var(--warn, #d29922);font-size:12px;margin-right:4px';
          pre.textContent = '⚠ ' + window.i18n.t('media.missing') + ' —';
          a.parentNode?.insertBefore(pre, a);
          a.style.opacity = '.55';
          a.style.textDecoration = 'line-through';
        }
      }).catch(() => {});
    } catch (_) {}
    a.addEventListener('click', e => {
      e.preventDefault();
      const rel = _attRel(a.getAttribute('href'));
      if (rel) window.inkwell.showAttachmentInFolder?.(rel).catch(() => {});
    });
  });

  // Tables — add context menu on right-click
  previewContent.querySelectorAll('td, th').forEach(cell => {
    cell.addEventListener('contextmenu', e => {
      e.preventDefault(); e.stopPropagation();
      showTableContextMenu(e, cell);
    });
  });

  // Tables — inject colgroup, apply persisted column widths, add resize handles
  previewContent.querySelectorAll('table').forEach((table, idx) => {
    setupTableColumnResize(table, idx, widthsByTable[idx]);
  });

  // Keep TOC perfectly in sync with the rendered preview: rebuild it right
  // after the DOM has been replaced, using the freshly created heading nodes.
  if (tocVisible) {
    try { renderTOC(); } catch (_) {}
  }

  // Restore the reading position now that the WHOLE document is in the DOM and
  // all synchronous decorations (media players, image wraps, tables) that affect
  // height have run — so the fraction maps onto the final scrollHeight instead of
  // a partial one. Guarded by the render token so a superseded render never
  // scrolls, and consumed once so only the render it was set for uses it.
  if (_pendingPreviewScrollFrac != null && token === _previewRenderToken) {
    const _f = _pendingPreviewScrollFrac;
    _pendingPreviewScrollFrac = null;
    const _pv = $('preview-pane');
    // One more frame so the browser has reflowed after the last DOM mutations.
    requestAnimationFrame(() => { if (token === _previewRenderToken) _applyScrollFrac(_pv, _f); });
  }
}

// ─── Table column resize (persisted via HTML comment markers) ────────────────

function isMdTableSeparatorRow(line) {
  const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
  return cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
}

function extractTableWidthMarkers(body) {
  const lines = body.split('\n');
  const cleanedLines = [];
  const widthsByTable = [];
  let pending = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*<!--\s*amelie:colw=([\d,]+)\s*-->\s*$/);
    if (m) {
      pending = m[1].split(',').map(s => parseInt(s, 10)).filter(n => n > 0);
      continue; // strip from rendered body
    }
    const isHeader = line.includes('|')
      && i + 1 < lines.length
      && isMdTableSeparatorRow(lines[i + 1]);
    if (isHeader) {
      widthsByTable.push(pending || null);
      pending = null;
    }
    cleanedLines.push(line);
  }
  return { cleanedBody: cleanedLines.join('\n'), widthsByTable };
}

function setupTableColumnResize(table, tableIdx, widths) {
  const firstRow = table.querySelector('tr');
  if (!firstRow) return;
  const headerCells = [...firstRow.querySelectorAll('th, td')];
  const colCount = headerCells.length;
  if (colCount < 1) return;

  let colgroup = table.querySelector('colgroup');
  if (!colgroup) {
    colgroup = document.createElement('colgroup');
    for (let i = 0; i < colCount; i++) colgroup.appendChild(document.createElement('col'));
    table.insertBefore(colgroup, table.firstChild);
  }
  const cols = [...colgroup.querySelectorAll('col')];

  if (widths && widths.length) {
    // Clamp to a sane minimum so a tiny/legacy saved width can't collapse a
    // column to ~1 char (text then stacks one letter per line).
    const MIN_COL = 48;
    let clamped = cols.map((_, i) => widths[i] ? Math.max(MIN_COL, widths[i]) : 0);
    // v1.0.984: pin the table to the saved total. WITHOUT this the table stayed at
    // its default shrink-to-fit under table-layout:auto and the browser
    // REDISTRIBUTED the <col> preferences to fill the pane — so ~120ms after a drag
    // (the debounced re-render that persist triggers) the columns jumped to a
    // "strange" layout that did NOT match what the user had just dragged. Fixing the
    // table width makes auto reproduce the per-column widths verbatim. We only pin
    // when EVERY column has a saved width (a partial/legacy marker would mis-size).
    const allSet = clamped.length === cols.length && clamped.every(w => w > 0);
    if (allSet) {
      let total = clamped.reduce((s, w) => s + w, 0);
      // If the saved widths sum wider than the CURRENT pane (e.g. the note was saved
      // in a wider window, or the window was since narrowed), scale them down
      // proportionally so the table fits — this is deterministic and matches the
      // fixed-layout drag, instead of letting max-width:100% squeeze unpredictably.
      // Guard clientWidth>0: in edit mode the preview pane is display:none → 0.
      const avail = (table.parentElement ? table.parentElement.clientWidth : 0) - 2;
      if (avail > 0 && total > avail) {
        const k = avail / total;
        clamped = clamped.map(w => Math.max(MIN_COL, Math.round(w * k)));
        total = clamped.reduce((s, w) => s + w, 0);
      }
      table.style.width = total + 'px';
    }
    cols.forEach((col, i) => { if (clamped[i]) col.style.width = clamped[i] + 'px'; });
    // AUTO (not fixed) layout: a <col> width is then a *minimum/preferred*, so the
    // user's widths are honoured BUT a column always grows to fit its content —
    // a long word can never be clipped, stacked one-letter-per-line, nor overflow
    // the cell. (Fixed layout would cap the column at the width and force the word
    // to break/overflow.) The user chose "column grows to fit the word". Pinning
    // table width above does NOT defeat this: under auto, a column's min-content
    // still overrides its preferred width, so a long word grows the column (and the
    // table, capped by max-width:100%) rather than clipping.
    table.style.tableLayout = 'auto';
  }
  table.dataset.tableIdx = String(tableIdx);

  // Add a resize handle on the right edge of every cell in every row.
  // Handles in the same column trigger the same resize → user can grab the
  // column edge from any row, not only the header.
  // Also make each cell contenteditable so the user can type content directly
  // in view mode (sync on blur).
  const allRows = [...table.querySelectorAll('tr')];
  allRows.forEach(row => {
    const cells = [...row.querySelectorAll('th, td')];
    cells.forEach((cell, colIdx) => {
      if (colIdx >= colCount) return;
      cell.style.position = 'relative';
      makeCellEditable(table, cell);
      // Anchor the caret at the LEFT of an empty cell with a zero-width space.
      // Without a leading text node the absolutely-positioned resize handle
      // pulls the caret to the cell's right edge until the user starts typing.
      // The ZWSP has no width/height and is stripped from the saved markdown.
      if (!cell.textContent.replace(/\u200b/g, '').trim()) {
        cell.insertBefore(document.createTextNode('\u200b'), cell.firstChild);
      }
      if (cell.querySelector('.col-resize-handle')) return;
      const handle = document.createElement('div');
      handle.className = 'col-resize-handle';
      // NOT editable: the cell is contentEditable, so without this the handle
      // (an absolutely-positioned child at the cell's right edge) would attract
      // the caret — clicking an empty cell put the cursor at the right and typed
      // text landed in the handle / next column.
      handle.contentEditable = 'false';
      const isLast = (colIdx === colCount - 1);
      if (isLast) handle.classList.add('col-resize-handle-last');
      handle.title = window.i18n.t('toolbar.resize_col');
      cell.appendChild(handle);
      handle.addEventListener('mousedown', e =>
        startColumnResize(e, table, cols, headerCells, colIdx, isLast));
    });
  });
}

function makeCellEditable(table, cell) {
  if (cell.dataset.editable === '1') return;
  cell.dataset.editable = '1';
  cell.contentEditable = 'true';
  cell.spellcheck = false;
  cell.addEventListener('focus', () => {
    cell.dataset.origText = cell.textContent;
  });
  // Put the caret where the user clicked. In an empty cell the only child is the
  // (non-editable) resize handle pinned to the right, which can leave the caret
  // mis-placed or unset — force it to the clicked point, else the cell start.
  cell.addEventListener('mousedown', e => {
    if (e.target.classList && e.target.classList.contains('col-resize-handle')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      let bad = !sel.rangeCount;
      if (sel.rangeCount) {
        const a = sel.anchorNode;
        const el = a.nodeType === 1 ? a : a.parentElement;
        if (!cell.contains(a) || (el && el.closest('.col-resize-handle'))) bad = true;
      }
      if (bad) {
        let r = document.caretRangeFromPoint && document.caretRangeFromPoint(e.clientX, e.clientY);
        if (!r || !cell.contains(r.startContainer)) {
          r = document.createRange();
          r.selectNodeContents(cell);
          r.collapse(true);
        }
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }, 0);
  });
  cell.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cell.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cell.textContent = cell.dataset.origText || '';
      cell.blur();
    }
  });
  cell.addEventListener('blur', () => syncCellToMarkdown(table, cell));
}

function syncCellToMarkdown(table, cell) {
  const sanitize = (s) => s.replace(/\u200b/g, '').replace(/\r?\n+/g, ' ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
  const newText = sanitize(cell.textContent).trim();
  const oldText = sanitize(cell.dataset.origText || '').trim();
  if (newText === oldText) return;

  const row = cell.closest('tr');
  if (!row) return;
  const tableIdx = parseInt(table.dataset.tableIdx, 10);
  if (!Number.isFinite(tableIdx)) return;

  const allRows = [...table.querySelectorAll('tr')];
  const rowIdx = allRows.indexOf(row);
  const cellsInRow = [...row.querySelectorAll('th,td')];
  const colIdx = cellsInRow.indexOf(cell);
  if (rowIdx < 0 || colIdx < 0) return;

  const lines = editor.value.split('\n');
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const isHeader = lines[i].includes('|')
      && i + 1 < lines.length
      && isMdTableSeparatorRow(lines[i + 1]);
    if (!isHeader) continue;
    if (found === tableIdx) {
      const mdRowIdx = rowIdx === 0 ? i : i + rowIdx + 1;
      if (mdRowIdx >= lines.length) return;
      const tokens = lines[mdRowIdx].split('|');
      // tokens[0] and tokens[length-1] are the empty bits around the outer pipes.
      const target = colIdx + 1;
      if (target < 1 || target >= tokens.length - 1) return;
      tokens[target] = ' ' + newText + ' ';
      lines[mdRowIdx] = tokens.join('|');
      // Mutate editor.value WITHOUT dispatching 'input' so the preview is not
      // re-rendered (would destroy the user's caret in the next cell).
      editor.value = lines.join('\n');
      const tab = getActiveTab();
      if (tab) { tab.isDirty = true; tab.content = editor.value; }
      setSavedState(false);
      scheduleAutosave();
      cell.dataset.origText = cell.textContent;
      return;
    }
    found++;
  }
}

// Smallest width a column may shrink to without CLIPPING its text. Cells use
// word-break:normal / overflow-wrap:normal (so a word is never split — see the
// per-char-stacking fix), which means a long single word can't wrap and would be
// cut off when the column gets narrower than it. The floor is the widest word in
// the column plus the cell's horizontal padding + borders. (v1.0.615)
let _colMeasureCtx = null;
function _columnContentMin(table, cols, colIndex) {
  // Smallest the column can get without CLIPPING text: the widest unbreakable word
  // (cells use word-break/overflow-wrap:normal → a word never splits) plus the
  // cell's padding + borders. PERF (v1.0.983): measured with a canvas 2D context,
  // NOT a per-word in-cell <span> + offsetWidth. The old span approach appended to /
  // read from a live cell for EVERY word in EVERY row of EVERY column at drag engage,
  // forcing a synchronous layout each time (~cols×rows×words reflows) → a big hitch
  // the moment you started to widen a table. Canvas measureText touches no layout.
  let min = 40;
  const ctx = _colMeasureCtx || (_colMeasureCtx = document.createElement('canvas').getContext('2d'));
  for (const row of table.rows) {
    const cell = row.cells[colIndex];
    if (!cell) continue;
    const words = (cell.textContent || '').replace(/\u200b/g, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const cs = getComputedStyle(cell);
    // Canvas font shorthand: style weight size family — the cell's exact font (header
    // th and body td differ in size/weight, so read it per cell).
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let widest = 0;
    for (const word of words) {
      const wdt = ctx.measureText(word).width;
      if (wdt > widest) widest = wdt;
    }
    const extra = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
    // +3px slack: canvas can under-measure the rendered box by ~1-2px (sub-pixel /
    // letter-spacing) — keep the old "text is never clipped" guarantee.
    const need = Math.ceil(widest + extra) + 3;
    if (need > min) min = need;
  }
  return min;
}

function startColumnResize(e, table, cols, cells, colIdx, isLast) {
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;

  // A bare CLICK on the column border must do NOTHING. Only once the pointer
  // actually moves past a threshold do we "engage" the resize — lock the current
  // widths, switch to fixed layout and pin the table. Engaging on a mere click
  // (auto → fixed + pin) made the whole table visibly jump/widen even when the
  // user only wanted to click, not drag (v1.0.612). The threshold is generous
  // (8px) because a real mouse/trackpad click jitters a few px; below it the
  // border is completely inert. When it DOES engage, movement is tracked from the
  // engage point (engageX), not from mousedown, so the column never jumps by the
  // accumulated slack — it follows the pointer 1:1 from where the drag began (v1.0.613).
  const DRAG_THRESHOLD = 8;
  let engaged = false;
  let engageX = startX;
  let leftStart = 0, rightStart = 0, containerW = 0;
  let colMin = [];   // per-column min width (text must never be clipped) — filled at engage

  const engage = (ev) => {
    engaged = true;
    engageX = ev.clientX;
    // Lock the CURRENTLY RENDERED widths into <col> and switch to fixed layout.
    // Must use the live getBoundingClientRect widths (NOT any pre-existing
    // col.style.width): a saved `colw` whose columns sum WIDER than the pane is
    // squeezed back to fit by `max-width:100%` under table-layout:auto, but once we
    // flip to fixed those literal oversized widths are honoured verbatim and the
    // table shoots off-screen mid-drag (then snaps back on release). Snapshotting the
    // rendered (already-clamped) widths keeps the table exactly where it looks (v1.0.614).
    const natural = cells.map(c => c.getBoundingClientRect().width);
    cols.forEach((col, i) => {
      col.style.width = Math.round(natural[i]) + 'px';
    });
    table.style.tableLayout = 'fixed';
    // Pin table to current total so dragging the last column actually moves
    // the right edge rather than letting the parent's width:100% override.
    if (!table.style.width || table.style.width === '100%') {
      const total = cols.reduce((s, c) => s + (parseFloat(c.style.width) || 0), 0);
      table.style.width = total + 'px';
    }
    leftStart  = parseFloat(cols[colIdx].style.width);
    rightStart = isLast ? 0 : parseFloat(cols[colIdx + 1].style.width);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Upper bound for the table when dragging the last column: never let it grow
    // past the visible area of the preview, otherwise the widened row scrolls out
    // of view mid-drag and only snaps back on release. Captured once at engage.
    containerW = (table.parentElement
      ? table.parentElement.clientWidth
      : table.clientWidth) - 2;
    colMin = cols.map((_, i) => _columnContentMin(table, cols, i));
  };

  const onMove = (ev) => {
    if (!engaged) {
      if (Math.abs(ev.clientX - startX) <= DRAG_THRESHOLD) return;
      engage(ev);
    }
    const dx = ev.clientX - engageX;
    if (isLast) {
      // Drag last column's right edge → only that column changes; table grows/shrinks.
      // Cap so the table total stays within the container width (no horizontal overflow).
      const others = cols.reduce(
        (s, c, i) => i === colIdx ? s : s + (parseFloat(c.style.width) || 0), 0);
      const maxW = Math.max(40, containerW - others);
      // Floor at the column's content width so its text is never clipped.
      const newW = Math.max(colMin[colIdx], Math.min(maxW, leftStart + dx));
      cols[colIdx].style.width = newW + 'px';
      const total = others + newW;
      table.style.width = total + 'px';
    } else {
      // Drag an INTERNAL border → redistribute width between the two adjacent
      // columns ONLY, keeping their combined width constant so the table never
      // grows past the visible area. (Without tying the pair sum, once the right
      // neighbour bottoms out at 40px the dragged column kept growing unbounded
      // and the table scrolled out of view — v1.0.611.)
      // Each of the two columns is floored at its own content width so neither
      // one's text gets clipped while the other grows (v1.0.615).
      const pairSum = leftStart + rightStart;
      const minLeft = colMin[colIdx], minRight = colMin[colIdx + 1];
      const newLeft = Math.max(minLeft, Math.min(leftStart + dx, pairSum - minRight));
      const newRight = pairSum - newLeft;
      cols[colIdx].style.width     = newLeft  + 'px';
      cols[colIdx + 1].style.width = newRight + 'px';
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    // Pure click (never engaged): leave the table completely untouched.
    if (!engaged) return;
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    const finalWidths = cols.map(c => Math.round(parseFloat(c.style.width) || 0));
    const tableIdx = parseInt(table.dataset.tableIdx, 10);
    persistTableColumnWidths(tableIdx, finalWidths);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function persistTableColumnWidths(tableIdx, widths) {
  if (!Number.isFinite(tableIdx) || tableIdx < 0) return;
  const marker = `<!-- amelie:colw=${widths.join(',')} -->`;
  const lines = editor.value.split('\n');
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const isHeader = lines[i].includes('|')
      && i + 1 < lines.length
      && isMdTableSeparatorRow(lines[i + 1]);
    if (!isHeader) continue;
    if (found === tableIdx) {
      const prev = i > 0 ? lines[i - 1] : '';
      if (/^\s*<!--\s*amelie:colw=/.test(prev)) {
        lines[i - 1] = marker;
      } else {
        lines.splice(i, 0, marker);
      }
      editor.value = lines.join('\n');
      // v1.0.984: do NOT dispatch 'input' — that schedules a full preview rebuild,
      // and the freshly re-rendered table (table-layout:auto) lands a sub-pixel off
      // from where the drag left it, so the table appeared to "shift a little" right
      // after release. The on-screen table is already correct (fixed layout, exact px
      // from the drag); we only need to persist the marker + mark the note dirty. Run
      // just the bookkeeping the 'input' handler does that matters for a comment-only
      // edit — skip the highlight/preview/overlay work that caused the shift.
      const tab = getActiveTab();
      if (tab) { tab.isDirty = true; tab.content = editor.value; }
      setSavedState(false);
      updateWordCount();
      scheduleAutosave();
      return;
    }
    found++;
  }
}

function updateWordCount() {
  const words = editor.value.trim().split(/\s+/).filter(Boolean).length;
  const wLabel = words === 1 ? window.i18n.t('status.word') : window.i18n.t('status.words');
  statusWords.textContent = `${words} ${wLabel}`;
}

// Selected-character count, shown on the LEFT of the status bar ONLY while text is
// selected in the editor (edit mode). Clears on collapse/blur.
function updateSelectionCount() {
  const el = document.getElementById('status-selection');
  if (!el) return;
  const n = Math.abs(editor.selectionEnd - editor.selectionStart);
  if (n > 0 && document.activeElement === editor) {
    const key = n === 1 ? 'status.char_selected' : 'status.chars_selected';
    el.textContent = window.i18n.t(key, { n });
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

// ─── TOC (Table of Contents) ──────────────────────────────────────────────────

let tocVisible = false;
let _tocPath = null;   // the note path the open TOC was built for (to close it on navigation)

function setupTOC() {
  $('btn-toc').addEventListener('click', toggleTOC);
  setupTocResizer();
}

function _restoreTocWidth() {
  try { const w = parseInt(localStorage.getItem('amelie-toc-width')); if (w >= 140 && w <= 600) $('toc-panel').style.width = w + 'px'; } catch (_) {}
}

// Drag the divider on the Index panel's left edge to resize it (persisted).
function setupTocResizer() {
  const rz = $('toc-resizer'), panel = $('toc-panel');
  if (!rz || !panel) return;
  let dragging = false, startX = 0, startW = 0;
  rz.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = panel.getBoundingClientRect().width;
    rz.classList.add('dragging');
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(140, Math.min(600, startW + (startX - e.clientX)));   // drag left → wider
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; rz.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    try { localStorage.setItem('amelie-toc-width', String(parseInt(panel.style.width) || 260)); } catch (_) {}
  });
}

// tags/source are always shown inline in edit mode — no toggle needed
function toggleTagsBar() {} // kept for compatibility

function toggleTOC() {
  tocVisible = !tocVisible;
  $('toc-panel').style.display = tocVisible ? 'flex' : 'none';
  const rz = $('toc-resizer'); if (rz) rz.style.display = tocVisible ? 'block' : 'none';
  $('btn-toc').classList.toggle('active', tocVisible);
  if (tocVisible) { _restoreTocWidth(); renderTOC(); }
}

// Close the TOC/index panel. Called when navigating to a DIFFERENT note or to a
// special view (mindmap / draw / pdf / todo): the index belongs to the note it
// was opened on, so it must not linger — stale — over the next thing you open.
function closeTOC() {
  if (!tocVisible) return;
  tocVisible = false;
  _tocPath = null;
  const p = $('toc-panel'); if (p) p.style.display = 'none';
  const rz = $('toc-resizer'); if (rz) rz.style.display = 'none';
  const b = $('btn-toc'); if (b) b.classList.remove('active');
}

// ─── Export note → PDF ────────────────────────────────────────────────────────
function setupExportPdf() {
  const btn = $('btn-export-pdf');
  if (btn) btn.addEventListener('click', exportNoteToPdf);
}

// Clean, print-friendly stylesheet (light paper, regardless of the app theme).
const PDF_PRINT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  body {
    color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11px; line-height: 1.55;
    padding: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; font-weight: 600; }
  /* No empty gap above the first block — the title sits right at the top. */
  .amelie-pdf > :first-child { margin-top: 0; }
  h1 { font-size: 1.7em; border-bottom: 1px solid #e2e2e2; padding-bottom: .2em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #ececec; padding-bottom: .2em; }
  h3 { font-size: 1.25em; } h4 { font-size: 1.1em; }
  p, ul, ol, blockquote, table, pre { margin: 0.6em 0; }
  a { color: #2563eb; text-decoration: none; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  img { max-width: 100%; height: auto; }
  blockquote {
    margin-left: 0; padding: 0.2em 1em; color: #555;
    border-left: 4px solid #d0d0d0; background: #f7f7f7;
  }
  code {
    font-family: "JetBrains Mono", "Fira Code", "Roboto Mono", monospace;
    font-size: 0.88em; background: #f0f0f3; padding: 0.12em 0.35em; border-radius: 4px;
    word-break: break-word; overflow-wrap: anywhere;
  }
  /* Code blocks WRAP onto the next line instead of scrolling/clipping, so long
     commands are never cut off in the PDF. */
  pre {
    background: #f6f8fa; border: 1px solid #e2e2e2; border-radius: 6px;
    padding: 0.8em 1em; overflow: visible;
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  }
  pre code {
    background: none; padding: 0; font-size: 0.85em;
    white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
  }
  table { border-collapse: collapse; width: 100%; font-size: 0.95em; table-layout: auto; }
  th, td { border: 1px solid #dcdcdc; padding: 0.45em 0.7em; text-align: left; word-break: break-word; }
  th { background: #f2f2f4; font-weight: 600; }
  mark.md-highlight { background: #fff3a3; padding: 0 .15em; }
  hr { border: none; border-top: 1px solid #e2e2e2; margin: 1.4em 0; }
  .note-link { color: #2563eb; }
  /* Hide any interactive controls that slipped through into the print. */
  .code-copy-btn, .img-resize-handle, .col-resize-handle { display: none !important; }
  /* keep headings with the content that follows */
  h1, h2, h3, h4 { page-break-after: avoid; }
  img, blockquote, table { page-break-inside: avoid; }
`;

// Dark-theme override appended after PDF_PRINT_CSS when the user picks "Scuro".
// Only re-colours surfaces/text so the layout above stays identical.
const PDF_PRINT_CSS_DARK = `
  html, body { background: #1a1b1e; }
  body { color: #e3e3e6; }
  h1 { border-bottom-color: #3a3a40; }
  h2 { border-bottom-color: #2f2f34; }
  a, .note-link { color: #6aa6ff; }
  blockquote { color: #b8b8bd; border-left-color: #44454b; background: #232428; }
  code { background: #2a2b30; color: #e8e8ec; }
  pre { background: #232428; border-color: #34353b; }
  pre code { background: none; }
  th, td { border-color: #3a3a40; }
  th { background: #26272c; }
  mark.md-highlight { background: #6b5d00; color: #fff; }
  hr { border-top-color: #34353b; }
`;

// Margin presets → inches (consumed by printToPDF in the main process).
const PDF_MARGIN_PRESETS = { normal: 0.6, narrow: 0.3, wide: 1.0, none: 0 };
const PDF_BASE_FONT_PX = 11;

// In landscape the page gets much wider, so the same px font fills a smaller
// fraction of the sheet and reads as "tiny". Boost the font by the page's
// long/short side ratio so the text keeps the same perceived size as portrait.
const PDF_PAGE_RATIO = { A4: 1.414, A3: 1.414, A5: 1.419, Letter: 1.294, Legal: 1.647, Tabloid: 1.545, Wide: 1.778 };

// Show the export options dialog. Resolves to an options object, or null if the
// user cancels. Remembers the last choices for the next export.
let _exportOpts = { fontPct: 100, orientation: 'portrait', pageSize: 'A4', margins: 'normal', theme: 'light' };
function showExportModal() {
  return new Promise(resolve => {
    const modal = $('export-modal');
    if (!modal) { resolve(_exportOpts); return; }
    const fontRange = $('export-font');
    const fontVal   = $('export-font-val');
    const orientBox = $('export-orient');
    const themeBox  = $('export-theme');
    const pageSel   = $('export-pagesize');
    const marginSel = $('export-margins');
    const okBtn     = $('export-modal-ok');
    const cancelBtn = $('export-modal-cancel');

    // Segmented-control helper: highlight the button matching `val`.
    const setSeg = (box, val) => box.querySelectorAll('.export-seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.val === val));

    // Restore last-used values.
    fontRange.value = _exportOpts.fontPct;
    fontVal.textContent = _exportOpts.fontPct + '%';
    pageSel.value = _exportOpts.pageSize;
    marginSel.value = _exportOpts.margins;
    setSeg(orientBox, _exportOpts.orientation);
    setSeg(themeBox, _exportOpts.theme);

    modal.style.display = 'flex';
    setTimeout(() => okBtn.focus(), 60);

    const onFont = () => { fontVal.textContent = fontRange.value + '%'; };
    const onSeg = (box) => (e) => {
      const b = e.target.closest('.export-seg-btn'); if (!b) return;
      box.querySelectorAll('.export-seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
    };
    const onOrient = onSeg(orientBox);
    const onTheme  = onSeg(themeBox);
    const cleanup = (val) => {
      modal.style.display = 'none';
      fontRange.removeEventListener('input', onFont);
      orientBox.removeEventListener('click', onOrient);
      themeBox.removeEventListener('click', onTheme);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onOk = () => {
      _exportOpts = {
        fontPct: parseInt(fontRange.value, 10) || 100,
        orientation: orientBox.querySelector('.export-seg-btn.active')?.dataset.val || 'portrait',
        theme: themeBox.querySelector('.export-seg-btn.active')?.dataset.val || 'light',
        pageSize: pageSel.value,
        margins: marginSel.value,
      };
      cleanup(_exportOpts);
    };
    const onCancel = () => cleanup(null);
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    fontRange.addEventListener('input', onFont);
    orientBox.addEventListener('click', onOrient);
    themeBox.addEventListener('click', onTheme);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

async function exportNoteToPdf() {
  const tab = getActiveTab();
  if (!tab || tab.type) { showToast(window.i18n.t('pdf.no_note')); return; }

  const opts = await showExportModal();
  if (!opts) return; // cancelled

  // Make sure the rendered HTML reflects the current editor content.
  try { updatePreview(); } catch (_) {}
  // Clone the rendered preview and strip the interactive controls that the
  // editor injects (copy-code button, image/column resize handles) — they're
  // useless in a PDF and render as stray grey boxes.
  const clone = previewContent.cloneNode(true);
  clone.querySelectorAll('.code-copy-btn, .img-resize-handle, .col-resize-handle')
    .forEach(el => el.remove());
  const bodyHtml = clone.innerHTML || '';
  const rawName = (tab.name || 'note').replace(/\.md$/i, '');

  // Match the on-screen VIEW mode: export with the same font size and the same
  // text-column width the user sees in the preview, so line wrapping in the PDF
  // is identical to view mode (no sentence that wrapped onto two lines suddenly
  // collapsing onto one because the page is wider). The chosen page size/
  // orientation just adds paper around that fixed column.
  const pcs = getComputedStyle(previewContent);
  const viewFontPx = parseFloat(pcs.fontSize) || 15;
  const viewFontFamily = pcs.fontFamily || 'sans-serif';
  const viewLineHeight = (pcs.lineHeight && pcs.lineHeight !== 'normal') ? pcs.lineHeight : '1.6';
  let viewColW = Math.round((previewContent.clientWidth || 0)
    - parseFloat(pcs.paddingLeft || '0') - parseFloat(pcs.paddingRight || '0'));
  if (!viewColW || viewColW < 80) {
    // Preview hidden (we were in edit mode) → fall back to the editor's width.
    const ecs = getComputedStyle(editor);
    viewColW = Math.round((editor.clientWidth || 700)
      - parseFloat(ecs.paddingLeft || '0') - parseFloat(ecs.paddingRight || '0')) || 700;
  }
  // Slider scales the view font; 100% = exactly what you see on screen.
  const fontPx = (viewFontPx * (opts.fontPct / 100)).toFixed(2);
  const marginIn = PDF_MARGIN_PRESETS[opts.margins] ?? 0.6;
  const isDark = opts.theme === 'dark';
  // Margins are a Chromium dilemma: real per-page margins give every page proper
  // top/bottom spacing, but the margin strip is ALWAYS white and can't be
  // coloured — so a dark export would get ugly white borders. We therefore split
  // by theme:
  //   • Light → real per-page page margins (white strips are invisible on white).
  //   • Dark  → full-bleed page (margin 0) + the chosen margin applied as body
  //     padding, so the dark background reaches every edge with no white border.
  const pagePadPx = isDark ? Math.round(marginIn * 96) : 0; // 1in = 96px
  const effPageMargin = isDark ? 0 : marginIn;
  // Match the view's font family / line-height too so wrapping is faithful.
  const layoutOverride = `body{font-size:${fontPx}px;font-family:${viewFontFamily};line-height:${viewLineHeight};padding:${pagePadPx}px;}`
    + `.amelie-pdf{max-width:${viewColW}px;margin:0 auto;}`;
  const themeCss = isDark ? PDF_PRINT_CSS_DARK : '';

  // The 16:9 "Wide" format isn't one of Chromium's named page sizes, and custom
  // {width,height} pageSize objects fail to print in this Electron build. So we
  // drive it through a CSS @page rule + preferCSSPageSize on the main side — the
  // @page margin gives it the same per-page spacing as the other formats.
  const isWideFmt = opts.pageSize === 'Wide';
  const pageCss = isWideFmt ? `@page{size:13.333in 7.5in;margin:${effPageMargin}in}` : '';

  const doc =
`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${escHtml(rawName)}</title>
<!-- No external font CDN: PDF export must work offline. Uses the chosen
     font-family with a system fallback (the temp export HTML can't reach the
     in-asar fonts). -->
<style>${PDF_PRINT_CSS}${pageCss}${themeCss}${layoutOverride}</style>
</head>
<body><article class="amelie-pdf">${bodyHtml}</article></body></html>`;

  const printOpts = isWideFmt
    ? { wide: true }
    : { landscape: opts.orientation === 'landscape', pageSize: opts.pageSize, margin: effPageMargin };

  const btn = $('btn-export-pdf');
  if (btn) btn.classList.add('active');
  try {
    const res = await window.inkwell.exportPdf(rawName, doc, printOpts);
    if (res && res.ok) {
      showToast('✓ ' + window.i18n.t('pdf.exported'));
    } else if (res && res.canceled) {
      /* user dismissed the save dialog — no message */
    } else {
      showToast('✗ ' + window.i18n.t('pdf.export_failed') + (res && res.error ? ': ' + res.error : ''));
    }
  } catch (err) {
    showToast('✗ ' + window.i18n.t('pdf.export_failed') + ': ' + (err && err.message || err));
  } finally {
    if (btn) btn.classList.remove('active');
  }
}

// Strip markdown inline formatting (bold/italic/code/links/etc.) by letting
// marked render the inline fragment, then reading its plain textContent.
// Needed so a heading like `## **Foo**` matches `<h2>Foo</h2>` in preview.
function mdInlineToText(md) {
  // Mirror updatePreview's preprocessing for Amelie-specific syntaxes
  let s = md
    .replace(/==([^=\n]+?)==/g, '$1')     // ==highlight==
    .replace(/\[\[([^\]]+)\]\]/g, '$1');  // [[wiki-links]]
  if (typeof marked === 'undefined' || typeof marked.parseInline !== 'function') {
    return s.replace(/[*_`~]/g, '').trim();
  }
  try {
    const html = marked.parseInline(s);
    const tmp = document.createElement('div');
    tmp.innerHTML = sanitizeNoteHtml(html);
    return tmp.textContent.trim();
  } catch (_) {
    return s.replace(/[*_`~]/g, '').trim();
  }
}

function renderTOC() {
  const list = $('toc-list');
  if (!list) return;
  _tocPath = state.currentPath;   // remember which note this index belongs to

  // Use marked.lexer to walk source tokens — this is the ONLY way to reliably
  // distinguish ATX (`# foo`) headings from setext-style ones (`foo\n===`)
  // since they both produce identical `<h?>` elements in the rendered DOM.
  // For each heading token we track its position in the FLAT heading-token
  // sequence; that index is exactly the index into previewHeadings (which
  // also enumerates ALL <h?> elements in source order).
  const body = _previewBody(editor.value);
  const bodyOffset = editor.value.length - body.length;
  const previewHeadings = [...$('preview-content').querySelectorAll('h1,h2,h3,h4,h5,h6')];

  const matched = [];
  let flatHeadingIdx = 0;
  let sourceCharOffset = 0; // running char position in body (for sourceLineInBody)

  if (typeof marked !== 'undefined' && typeof marked.lexer === 'function') {
    try {
      const tokens = marked.lexer(body);
      for (const t of tokens) {
        const rawLen = (t.raw || '').length;
        if (t.type === 'heading') {
          const rawTrimmed = (t.raw || '').trim();
          const isAtx = /^#{1,6}\s/.test(rawTrimmed);
          const cleanText = mdInlineToText(t.text || '').trim();
          // Skip empty-text ATX (`## ` with no title yet) — keeps the TOC clean
          // while the user is still typing a heading.
          // Build from the SOURCE tokens (not the preview DOM): with the CM engine
          // the preview isn't rendered in edit mode, so previewHeadings is empty —
          // the TOC would be blank. hEl is only needed for the view-mode jump.
          if (isAtx && cleanText) {
            const sourceLineInBody = body.substring(0, sourceCharOffset).split('\n').length - 1;
            matched.push({
              level: t.depth,
              text: cleanText,
              hEl: previewHeadings[flatHeadingIdx] || null,
              sourceLineInBody,
              bodyOffset,
            });
          }
          flatHeadingIdx++;
        }
        sourceCharOffset += rawLen;
      }
    } catch (_) { /* fall through to empty matched → "Nessun titolo" message */ }
  }

  list.innerHTML = '';
  if (matched.length === 0) {
    list.innerHTML = '<div style="padding:12px 14px;font-size:11px;color:var(--text-3);font-family:var(--editor-font);font-style:italic">' + escHtml(window.i18n.t('toc.empty')) + '</div>';
    return;
  }

  matched.forEach((h, idx) => {
    const el = document.createElement('div');
    el.className = `toc-item h${h.level}`;
    el.dataset.idx = String(idx);
    el.textContent = h.text;
    // No title: the text is already visible in the entry (long lines
    // wrap), the tooltip repeating it on hover is just noise.
    el.addEventListener('click', () => jumpToHeadingEl(h.hEl, h.text, idx, h.sourceLineInBody, h.bodyOffset));
    list.appendChild(el);
  });
}

// Measure the visual Y-coordinate of the caret at `pos` inside a textarea.
// Uses a hidden absolutely-positioned mirror <div> that copies the textarea's
// width and text-rendering styles, then reads the offsetTop of a marker span.
// This correctly accounts for soft-wrapped lines (white-space: pre-wrap),
// which a naïve `lineIdx * lineHeight` calculation gets wrong by a lot.
function measureTextareaCaretY(textarea, pos) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const PROPS = [
    'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'lineHeight', 'letterSpacing', 'textTransform', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'whiteSpace', 'wordWrap', 'wordBreak', 'overflowWrap',
  ];
  PROPS.forEach(p => { mirror.style[p] = style[p]; });
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.width = textarea.clientWidth + 'px';
  mirror.style.height = 'auto';
  mirror.style.overflow = 'hidden';
  mirror.textContent = textarea.value.substring(0, pos);
  const marker = document.createElement('span');
  marker.textContent = '\u200b'; // zero-width space — has line-height
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const y = marker.offsetTop;
  document.body.removeChild(mirror);
  return y;
}

function jumpToHeadingEl(hEl, text, tocIdx, sourceLineInBody, bodyOffset) {
  if (state.viewMode === 'edit') {
    if (typeof sourceLineInBody === 'number' && typeof bodyOffset === 'number') {
      const lines = _previewBody(editor.value).split('\n');
      if (sourceLineInBody < lines.length) {
        const charIdxInBody = lines.slice(0, sourceLineInBody)
          .reduce((s, l) => s + l.length + 1, 0);
        const charIdx = bodyOffset + charIdxInBody;
        editor.focus();
        editor.setSelectionRange(charIdx, charIdx + lines[sourceLineInBody].length);
        if (_cmActive && _cmHandle) {
          // CM scrolls the position near the top natively (the textarea mirror
          // measurement below is meaningless when the textarea is hidden).
          _cmHandle.scrollToPos(charIdx, 'start');
        } else {
          // Use a mirror div to measure the EXACT visual Y of the selection start,
          // accounting for line wrapping (the textarea has white-space: pre-wrap).
          const y = measureTextareaCaretY(editor, charIdx);
          editor.scrollTop = Math.max(0, y - 60);
        }
      }
    }
  } else if (hEl && hEl.isConnected) {
    // Scroll ONLY the preview pane to the heading — do NOT use
    // hEl.scrollIntoView(). scrollIntoView walks the whole ancestor chain and
    // scrolls every scrollable ancestor; at fractional device-pixel-ratios
    // (hi-DPI monitors) the outer flex containers and <body> end up 1–2px
    // "scrollable" even with overflow:hidden (programmatic scroll still works),
    // so it would drag the titlebar (tabs/settings row) off the top and the
    // status bar off the bottom — the editor looked "full-screen". Positioning
    // the pane directly via scrollTop never touches the outer layout.
    const pane = $('preview-pane');
    if (pane) {
      const paneRect = pane.getBoundingClientRect();
      const targetRect = hEl.getBoundingClientRect();
      pane.scrollTop += targetRect.top - paneRect.top - 12;
    }
    // Undo any stray outer scroll (hi-DPI sub-pixel overflow from any source)
    // so the titlebar and status bar can never be pushed out of view.
    document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
    ['layout','editor-area','editor-container','editor-toc-row','editor-column']
      .forEach(id => { const el = $(id); if (el) { el.scrollTop = 0; el.scrollLeft = 0; } });
    // Brief green flash to confirm the target — no purple/outline.
    hEl.style.transition = 'background .2s';
    hEl.style.background = 'var(--accent-glow)';
    setTimeout(() => { hEl.style.background = ''; }, 600);
  }

  document.querySelectorAll('.toc-item').forEach(el => {
    el.classList.toggle('active', parseInt(el.dataset.idx, 10) === tocIdx);
  });
}

// ─── Attachment chips (edit mode) ─────────────────────────────────────────────

const IMAGE_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg']);

function getAttachmentIcon(name) {
  const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return null;  // will use thumbnail
  if (ext === '.pdf') return '📄';
  if (['.mp4','.mkv','.mov','.avi','.webm'].includes(ext)) return '🎬';
  if (['.mp3','.wav','.ogg','.flac','.aac'].includes(ext)) return '🎵';
  return '📎';
}

// Parse all inkwell://attachments/ refs from current editor content
function getAttachmentsInNote() {
  const content = editor.value;
  const found = new Map(); // name → first occurrence index
  const re = /inkwell:\/\/attachments\/([^)\s"']+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = decodeURIComponent(m[1]);
    if (!found.has(name)) found.set(name, m.index);
  }
  return [...found.keys()];
}

async function refreshAttachmentChips() {
  const chipsBar = $('attachment-chips');
  if (!chipsBar) return;
  const chipsList = $('chips-list');
  const names = getAttachmentsInNote();
  if (names.length === 0) { chipsBar.style.display = 'none'; return; }

  chipsBar.style.display = 'flex';
  chipsList.innerHTML = '';

  for (const name of names) {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    chip.dataset.name = name;

    const icon = getAttachmentIcon(name);
    const ext = name.substring(name.lastIndexOf('.')).toLowerCase();

    if (!icon && IMAGE_EXTS.has(ext)) {
      // Tiny thumbnail
      const img = document.createElement('img');
      img.className = 'att-chip-img';
      img.src = `inkwell://attachments/${encodeURIComponent(name)}`;
      img.onerror = () => { img.style.display = 'none'; };
      chip.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'att-chip-icon';
      ic.textContent = icon;
      chip.appendChild(ic);
    }

    // Editable filename span
    const nameSpan = document.createElement('span');
    nameSpan.className = 'att-chip-name';
    nameSpan.textContent = name;
    nameSpan.contentEditable = 'true';
    nameSpan.spellcheck = false;
    nameSpan.title = window.i18n.t('ctx.rename');

    nameSpan.addEventListener('keydown', async e => {
      if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); }
      if (e.key === 'Escape') { nameSpan.textContent = name; nameSpan.blur(); }
    });
    nameSpan.addEventListener('blur', async () => {
      const newName = nameSpan.textContent.trim();
      if (!newName || newName === name) { nameSpan.textContent = name; return; }
      await renameAttachmentInNote(name, newName, chip);
    });

    chip.appendChild(nameSpan);

    // Copy reference button (images only — copies markdown syntax to clipboard)
    if (IMAGE_EXTS.has(ext)) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'att-chip-copy';
      copyBtn.title = window.i18n.t('toolbar.copy_ref');
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:11px;height:11px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
      copyBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const url  = `inkwell://attachments/${encodeURIComponent(name)}`;
        const ref  = `![${name}](${url})`;
        // Show only the filename in clipboard — full ref is pasted but display is clean
        await navigator.clipboard.writeText(ref);
        // Show just the filename in the toast
        copyBtn.style.color = 'var(--green)';
        copyBtn.title = '✓ ' + window.i18n.t('toolbar.copied');
        setTimeout(() => {
          copyBtn.style.color = '';
          copyBtn.title = window.i18n.t('toolbar.copy_ref');
        }, 1400);
        showToast(window.i18n.t('toast.ref_copied', { name }));
      });
      chip.appendChild(copyBtn);
    }

    // Delete button
    const del = document.createElement('button');
    del.className = 'att-chip-del';
    del.textContent = '✕';
    del.title = window.i18n.t('toolbar.remove_ref');
    del.addEventListener('click', () => removeAttachmentRef(name));
    chip.appendChild(del);

    chipsList.appendChild(chip);
  }
}

async function renameAttachmentInNote(oldName, newName, chipEl) {
  // Ask main to rename file on disk and patch all notes
  const finalName = await window.inkwell.renameAttachment(oldName, newName);
  // Patch current editor content too (main already patched the saved file)
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  editor.value = editor.value.replace(new RegExp(escaped, 'g'), finalName);
  editor.dispatchEvent(new Event('input'));
  // Update chip UI
  chipEl.dataset.name = finalName;
  chipEl.querySelector('.att-chip-name').textContent = finalName;
  if (chipEl.querySelector('.att-chip-img')) {
    chipEl.querySelector('.att-chip-img').src = `inkwell://attachments/${encodeURIComponent(finalName)}`;
  }
}

function removeAttachmentRef(name) {
  // Remove the markdown reference from editor (not the file itself)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Remove ![]() or []() lines containing this attachment
  editor.value = editor.value
    .replace(new RegExp(`\\n?!?\\[[^\\]]*\\]\\(inkwell://attachments/${escaped}\\)\\n?`, 'g'), '\n')
    .trim() + '\n';
  editor.dispatchEvent(new Event('input'));
  refreshAttachmentChips();
}

// ─── Search ───────────────────────────────────────────────────────────────────
let searchDebounce = null;

function setupSearch() {
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    state.searchQuery = q;
    clearTimeout(searchDebounce);

    if (!q.trim()) {
      hideSearchResults();
      renderTree();
      return;
    }

    // Instant filename filter in sidebar
    renderTree();

    // Debounced full-text search after 250ms
    searchDebounce = setTimeout(() => runFullTextSearch(q), 250);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      state.searchQuery = '';
      hideSearchResults();
      renderTree();
    }
    if (e.key === 'Enter') {
      // Open first result
      const first = $('search-results').querySelector('.sr-item');
      if (first) first.click();
    }
    // Arrow keys to navigate results
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...$('search-results').querySelectorAll('.sr-item')];
      if (!items.length) return;
      const focused = $('search-results').querySelector('.sr-item.focused');
      let idx = items.indexOf(focused);
      if (focused) focused.classList.remove('focused');
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      if (idx === -1) idx = 0;
      items[idx].classList.add('focused');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
  });

  // Close results when clicking outside
  document.addEventListener('click', e => {
    if (!e.target.closest('#search-wrap')) hideSearchResults();
  });
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) runFullTextSearch(searchInput.value);
  });
}

function hideSearchResults() {
  const r = $('search-results');
  r.innerHTML = '';
  r.classList.add('empty');
}

async function runFullTextSearch(query) {
  if (!query.trim()) return;
  // A search made only of extensions (`.pdf`, `.draw .md`) belongs to the tree filter:
  // this index holds notes only, and their names are stored without `.md`, so it would
  // always answer "no results for .pdf" in a panel covering the very files the tree
  // has just listed. Guarded here, so the focus handler behaves the same.
  if (query.trim().split(/\s+/).every(isExtTerm)) { hideSearchResults(); return; }
  const results = await window.inkwell.searchNotes(query);
  renderSearchResults(results, query);
}

function renderSearchResults(results, query) {
  const container = $('search-results');
  container.innerHTML = '';
  container.classList.remove('empty');

  if (results.length === 0) {
    container.innerHTML = '<div class="sr-empty">' + escHtml(window.i18n.t('search.no_results_for', { query })) + '</div>';
    return;
  }

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'sr-item';

    // Highlight terms in snippet
    let snippet = escHtml(r.snippet || '');
    terms.forEach(t => {
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
      snippet = snippet.replace(re, '<mark>$1</mark>');
    });

    // Highlight terms in name
    let nameHtml = escHtml(r.name);
    terms.forEach(t => {
      const re = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + ')', 'gi');
      nameHtml = nameHtml.replace(re, '<mark>$1</mark>');
    });

    item.innerHTML = `
      <div class="sr-name">${nameHtml} <span class="sr-path">${escHtml(r.path)}</span></div>
      ${snippet ? `<div class="sr-snippet">${snippet}</div>` : ''}
    `;

    item.addEventListener('click', async () => {
      // Open or switch to this note
      const node = findNote(state.notes, r.path) || { path: r.path, name: r.name, modified: r.modified };
      await openNote(node);
      hideSearchResults();
      searchInput.value = '';
      state.searchQuery = '';
      renderTree();
    });

    container.appendChild(item);
  });
}

// ─── Context menu ─────────────────────────────────────────────────────────────
// ─── Note colors ─────────────────────────────────────────────────────────────

const NOTE_COLORS = [
  { key: 'rose',   hex: '#e0758a', label: 'Rosa' },
  { key: 'amber',  hex: '#c9a96e', label: 'Ambra' },
  { key: 'sky',    hex: '#6ab0d4', label: 'Cielo' },
  { key: 'violet', hex: '#a78bda', label: 'Viola' },
  { key: 'lime',   hex: '#7ec97a', label: 'Verde' },
  { key: 'peach',  hex: '#d4916a', label: 'Pesca' },
];

// ─── Manual tree order ────────────────────────────────────────────────────────
// The user can drag FILES (notes, draws, pdfs, images) into any order they like;
// folders are NOT reorderable — they stay alphabetical at the top of each level.
// Stored per containing-folder path as { [folderPath]: [filePath, …] } where the
// root level uses the '' key. Items missing from the list keep their backend
// order (creation time) and fall to the bottom — so new files still land last.
// The order lives in the vault (notes/.amelie-order.json) so it syncs across PCs;
// localStorage is just a fast local cache / offline fallback.
let treeOrder = (() => {
  try { return JSON.parse(localStorage.getItem('amelie-tree-order') || '{}'); } catch(_) { return {}; }
})();
const isFileNode = n => n && n.type !== 'folder';
let _orderWriteInFlight = 0;
function saveTreeOrder() {
  try { localStorage.setItem('amelie-tree-order', JSON.stringify(treeOrder)); } catch(_) {}
  try {                                                          // persist in the vault → syncs to other PCs
    _orderWriteInFlight++;
    Promise.resolve(window.inkwell.writeTreeOrder(treeOrder)).catch(() => {}).finally(() => { _orderWriteInFlight--; });
  } catch(_) { _orderWriteInFlight--; }
}
// Pull the order from the vault before rendering (it's the source of truth across
// PCs). First run after upgrading from the localStorage-only version: seed the
// vault from whatever local order already exists.
async function loadTreeOrderFromVault() {
  if (_orderWriteInFlight > 0) return;   // our own just-saved order is still being written — don't clobber it
  let remote = null;
  try { remote = await window.inkwell.readTreeOrder(); } catch(_) {}
  if (remote && typeof remote === 'object' && Object.keys(remote).length) {
    treeOrder = remote;
    try { localStorage.setItem('amelie-tree-order', JSON.stringify(treeOrder)); } catch(_) {}
  } else if (Object.keys(treeOrder).length) {
    try { window.inkwell.writeTreeOrder(treeOrder); } catch(_) {}   // seed the vault from the local order
  }
}
// Persist the file order of one tree level (the array of sibling nodes).
function saveManualOrder(folderPath, arr) {
  // Save the FULL sibling order (folders AND files interleaved) so a note can sit
  // above/between folders — not just files-after-folders. A level with no saved
  // order still defaults to folders-first (see applyManualOrder).
  const paths = arr.map(n => n.path).filter(Boolean);
  if (paths.length) treeOrder[folderPath] = paths; else delete treeOrder[folderPath];
  saveTreeOrder();
}
// Keep the saved order in sync when a path changes (rename / folder move).
// Remaps both stored file paths (values) AND folder-keys, including descendants.
function renameInTreeOrder(oldPath, newPath) {
  if (!oldPath || oldPath === newPath) return;
  const remap = p =>
    p === oldPath ? newPath
    : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length)
    : p;
  for (const k of Object.keys(treeOrder)) {
    const list = treeOrder[k].map(remap);
    const nk = remap(k);
    if (nk !== k) { delete treeOrder[k]; treeOrder[nk] = list; }
    else treeOrder[k] = list;
  }
  saveTreeOrder();
  migrateNoteColorPath(oldPath, newPath);   // labels follow the rename/move too
}
// Drop a path (and any descendants/keys) from the saved order on delete.
function removeFromTreeOrder(path) {
  if (!path) return;
  for (const k of Object.keys(treeOrder)) {
    if (k === path || k.startsWith(path + '/')) { delete treeOrder[k]; continue; }
    treeOrder[k] = treeOrder[k].filter(p => p !== path && !p.startsWith(path + '/'));
  }
  saveTreeOrder();
}
// Order each level by the saved manual order (folders AND files interleaved, so a
// note can sit above/between folders). A level with NO saved order keeps the
// classic folders-first default. Items not in the saved order fall to the end,
// folders-first among themselves (freshly created notes/folders).
function applyManualOrder(nodes, folderPath = '') {
  const order = treeOrder[folderPath];
  let out;
  if (order && order.length) {
    const pos = new Map(order.map((p, i) => [p, i]));
    out = [...nodes].sort((a, b) => {
      const ia = pos.has(a.path) ? pos.get(a.path) : Infinity;
      const ib = pos.has(b.path) ? pos.get(b.path) : Infinity;
      if (ia !== ib) return ia - ib;                                  // both saved (or one saved) → by index
      if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1; // unsaved: folders first
      return 0;                                                       // stable: keep backend order otherwise
    });
  } else {
    out = [...nodes.filter(n => n.type === 'folder'), ...nodes.filter(isFileNode)];  // default: folders first
  }
  out.forEach(n => { if (n.type === 'folder' && n.children) n.children = applyManualOrder(n.children, n.path); });
  return out;
}

// Stored as { [path]: colorKey }
const noteColors = (() => {
  try { return JSON.parse(localStorage.getItem('amelie-note-colors') || '{}'); } catch(_) { return {}; }
})();


function saveNoteColors() {
  try { localStorage.setItem('amelie-note-colors', JSON.stringify(noteColors)); } catch(_) {}
}

// A note/folder/attachment changed path (rename OR move): carry its label colour
// — and, for a folder, every descendant's colour (both keyed by path) — over to
// the new path so the colour is never dropped. Prefix remap mirrors
// renameInTreeOrder. [[amelie-visual-mindmap-prefs]]
function migrateNoteColorPath(oldPath, newPath) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const remap = p =>
    p === oldPath ? newPath
    : p.startsWith(oldPath + '/') ? newPath + p.slice(oldPath.length)
    : p;
  let changed = false;
  for (const k of Object.keys(noteColors)) {
    const nk = remap(k);
    if (nk !== k) { noteColors[nk] = noteColors[k]; delete noteColors[k]; changed = true; }
  }
  if (changed) saveNoteColors();
}

function setNoteColor(path, colorKey) {
  if (colorKey) noteColors[path] = colorKey;
  else delete noteColors[path];
  saveNoteColors();
  renderTree();
}

// Open the color-palette popup at (x, y) to set the label color of `node`.
let _colorTargetPath = null;
// x = preferred left (right side of the menu item); leftEdge = the item's left,
// used to flip the palette to the LEFT of the menu when it would overflow.
function openColorPalette(node, x, y, leftEdge) {
  if (!node || !node.path) return;
  _colorTargetPath = node.path;
  const menu = $('color-palette-menu');
  if (!menu) return;
  menu.style.display = 'block';
  const w = menu.offsetWidth || 200, h = menu.offsetHeight || 40;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x;
  // If it would run off the right edge, place it to the left of the menu item
  // instead of overlapping it.
  if (left + w + 4 > vw && leftEdge != null) left = leftEdge - w - 8;
  left = Math.max(4, Math.min(left, vw - w - 4));
  menu.style.left = left + 'px';
  menu.style.top  = Math.max(4, Math.min(y, vh - h - 4)) + 'px';
}

function setupColorPalette() {
  const menu = $('color-palette-menu');
  if (!menu) return;
  document.addEventListener('click', e => {
    if (!e.target.closest('#color-palette-menu') && !e.target.closest('#ctx-color')) {
      menu.style.display = 'none';
    }
  });
  menu.querySelectorAll('.cp-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      if (_colorTargetPath != null) setNoteColor(_colorTargetPath, sw.dataset.color || '');
      menu.style.display = 'none';
      // Also close the main context menu once a color is chosen.
      const cm = $('context-menu'); if (cm) cm.style.display = 'none';
    });
  });
}

// ─── Custom tooltips ──────────────────────────────────────────────────────────
// Replace the native grey title="" bubbles with an in-theme tooltip (app
// colors, white text). Works app-wide via event delegation: any element with a
// `title` attribute is handled. The native title is moved to `data-tip` so the
// OS bubble never shows.
function setupTooltips() {
  const tip = $('app-tooltip');
  if (!tip) return;
  let curEl = null, showTimer = null;

  const hide = () => {
    clearTimeout(showTimer);
    tip.classList.remove('show');
    curEl = null;
  };

  const place = (el) => {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text;
    // Wrap mode BEFORE measuring — the size below depends on it.
    tip.classList.toggle('wide', text.length > 60);
    tip.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    // Prefer below the element, centered; flip above if no room.
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.bottom + 6;
    if (top + th + 4 > vh) top = r.top - th - 6;
    left = Math.max(4, Math.min(left, vw - tw - 4));
    top = Math.max(4, top);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  };

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[title], [data-tip]');
    if (!el) return;
    // Move native title → data-tip so the OS tooltip never appears.
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      if (t) el.setAttribute('data-tip', t);
      el.removeAttribute('title');
    }
    if (!el.getAttribute('data-tip')) return;
    if (curEl === el) return;
    curEl = el;
    clearTimeout(showTimer);
    showTimer = setTimeout(() => { if (curEl === el) place(el); }, 350);
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el === curEl) hide();
  });
  // Any click / scroll dismisses immediately. Also listen on pointerdown:
  // handlers that preventDefault() it (e.g. the media resize handles) suppress
  // the compatibility mousedown, which would leave the tooltip up during drags.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
}

// ─── Text colors ─────────────────────────────────────────────────────────────

const TEXT_COLORS = [
  '#e0758a','#c9a96e','#6ab0d4','#a78bda','#7ec97a','#d4916a',
  '#e05c6a','#3d9970','#9aacbe','#dde6f0','#e0a84a','#c4a7e7',
];

let currentTextColor = null;

function setupTextColor() {
  const btn = $('btn-text-color');
  const popup = $('text-color-popup');
  const swatches = $('tc-swatches');

  // Build swatches
  TEXT_COLORS.forEach(hex => {
    const s = document.createElement('div');
    s.className = 'tc-swatch';
    s.style.background = hex;
    s.title = hex;
    s.addEventListener('click', () => {
      currentTextColor = hex;
      btn.style.setProperty('--text-color-current', hex);
      applyTextColor(hex);
      popup.style.display = 'none';
    });
    swatches.appendChild(s);
  });

  $('tc-reset').addEventListener('click', () => {
    removeTextColor();
    currentTextColor = null;
    btn.style.removeProperty('--text-color-current');
    popup.style.display = 'none';
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = popup.style.display === 'none';
    if (willOpen) closeOtherDropdowns(popup);
    const r = btn.getBoundingClientRect();
    popup.style.left = r.left + 'px';
    popup.style.top  = (r.bottom + 4) + 'px';
    popup.style.display = willOpen ? 'block' : 'none';
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-text-color') && !e.target.closest('#text-color-popup')) {
      popup.style.display = 'none';
    }
  });
}

function applyTextColor(hex) {
  if (!currentTextColor && !hex) return;
  const color = hex || currentTextColor;
  const sel = { s: editor.selectionStart, e: editor.selectionEnd };
  const text = editor.value.substring(sel.s, sel.e);
  if (!text) return;
  // If the selection is already wrapped in a color span, replace just the
  // colour (don't nest spans). Otherwise wrap.
  const COLOR_RE = /^<span style="color:[^"]+">([\s\S]*)<\/span>$/;
  const m = text.match(COLOR_RE);
  // Also strip any inner color spans to avoid stacking after multiple changes
  const inner = (m ? m[1] : text).replace(
    /<span style="color:[^"]+">([\s\S]*?)<\/span>/g, '$1'
  );
  const colored = `<span style="color:${color}">${inner}</span>`;
  insertAtCursor(colored, sel.s, sel.e);
  // Reset selection to the inserted span so further changes work on it
  const newEnd = sel.s + colored.length;
  editor.selectionStart = sel.s;
  editor.selectionEnd = newEnd;
}

function removeTextColor() {
  const sel = { s: editor.selectionStart, e: editor.selectionEnd };
  if (sel.s === sel.e) return;
  const text = editor.value.substring(sel.s, sel.e);
  let stripped = text;
  const whole = text.match(/^<span style="color:[^"]+">([\s\S]*)<\/span>$/);
  if (whole) stripped = whole[1];
  stripped = stripped.replace(
    /<span style="color:[^"]+">([\s\S]*?)<\/span>/g, '$1'
  );
  if (stripped === text) return;
  insertAtCursor(stripped, sel.s, sel.e);
  editor.selectionStart = sel.s;
  editor.selectionEnd = sel.s + stripped.length;
}

// ─── Color removal in VIEW mode (floating bubble on the selection) ────────────
// In view mode the toolbar is hidden. When the user selects text that is
// COLORED, we show a small "remove color" bubble; clicking it removes the color
// span from the SOURCE MARKDOWN and the preview updates.
// (Applying color is only done in edit mode.)
let _vcBubble = null;     // the bubble button
let _vcSel = null;        // captured selection { text, occ }

// If the selection is inside a colored span, return the ENTIRE text of the
// span and its occurrence (0-based) in the preview — used to locate the
// same span in the source. Returns null if it's not colored text.
function _vcCaptureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!previewContent.contains(range.commonAncestorContainer)) return null;
  // Walk up to the span with an inline color that contains the selection.
  let node = range.commonAncestorContainer;
  if (node.nodeType === 3) node = node.parentElement;
  let spanEl = null;
  while (node && node !== previewContent) {
    if (node.tagName === 'SPAN' && node.style && node.style.color) { spanEl = node; break; }
    node = node.parentElement;
  }
  if (!spanEl) return null;
  const text = spanEl.textContent;
  if (!text) return null;
  // Occurrence of the same text before this span in the preview.
  let occ = 0;
  try {
    const pre = document.createRange();
    pre.selectNodeContents(previewContent);
    pre.setEndBefore(spanEl);
    const before = pre.toString();
    let from = 0, idx;
    while ((idx = before.indexOf(text, from)) !== -1) { occ++; from = idx + text.length; }
  } catch (_) { occ = 0; }
  return { text, occ };
}

// Locate the right occurrence in the source and apply/remove the color.
function _vcApplyToSource(captured, color) {
  if (!captured) return false;
  const selText = captured.text;
  const src = editor.value;
  // If the text is unique in the source we use it directly (max reliability).
  let pos = -1;
  const first = src.indexOf(selText);
  if (first === -1) return false;
  const second = src.indexOf(selText, first + selText.length);
  if (second === -1) {
    pos = first;
  } else {
    // Multiple occurrences: pick the Nth one as in the preview.
    let from = 0, count = 0, p;
    while ((p = src.indexOf(selText, from)) !== -1) {
      if (count === captured.occ) { pos = p; break; }
      from = p + selText.length; count++;
    }
    if (pos === -1) pos = first;
  }
  const len = selText.length;
  const before = src.slice(0, pos);
  const after = src.slice(pos + len);
  // Is the text already wrapped in an adjacent color span? Replace the whole span.
  const openM = before.match(/<span style="color:[^"]+">$/);
  let repStart = pos, repEnd = pos + len, newText;
  if (openM && after.startsWith('</span>')) {
    repStart = pos - openM[0].length;
    repEnd = pos + len + '</span>'.length;
    newText = color ? `<span style="color:${color}">${selText}</span>` : selText;
  } else {
    if (!color) return false; // nothing to remove
    newText = `<span style="color:${color}">${selText}</span>`;
  }
  editor.value = src.slice(0, repStart) + newText + src.slice(repEnd);
  editor.dispatchEvent(new Event('input'));
  try { updatePreview(); } catch (_) {}
  return true;
}

function _vcHideBubble() { if (_vcBubble) _vcBubble.style.display = 'none'; }

function setupViewColorBubble() {
  _vcBubble = document.createElement('button');
  _vcBubble.type = 'button';
  _vcBubble.id = 'view-color-bubble';
  _vcBubble.title = window.i18n ? window.i18n.t('toolbar.text_color_remove') : 'Rimuovi colore';
  _vcBubble.style.cssText = 'position:fixed;display:none;z-index:3100;gap:5px;height:28px;padding:0 10px;align-items:center;justify-content:center;background:var(--bg-2);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;color:var(--text-1);font-family:var(--ui-font);font-size:12px;white-space:nowrap';
  // Crossed-out drop icon + "Remove color" text.
  _vcBubble.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><path d="M5 16L10 5l5 11M7 12h6"/><line x1="4" y1="20" x2="20" y2="4"/></svg><span></span>';
  _vcBubble.querySelector('span').textContent = window.i18n ? window.i18n.t('toolbar.text_color_remove') : 'Rimuovi colore';
  document.body.appendChild(_vcBubble);
  // Don't steal the selection when clicking the bubble.
  _vcBubble.addEventListener('mousedown', e => e.preventDefault());
  _vcBubble.addEventListener('click', e => {
    e.stopPropagation();
    _vcApplyToSource(_vcSel, null);   // null = remove the color
    _vcHideBubble();
  });
  _vcBubble.addEventListener('mouseenter', () => { _vcBubble.style.borderColor = 'var(--accent)'; _vcBubble.style.color = 'var(--text-0)'; });
  _vcBubble.addEventListener('mouseleave', () => { _vcBubble.style.borderColor = 'var(--border)'; _vcBubble.style.color = 'var(--text-1)'; });

  // Show the bubble only when the selection is inside COLORED text (view mode).
  const maybeShow = () => {
    if (state.viewMode !== 'view') { _vcHideBubble(); return; }
    const cap = _vcCaptureSelection();
    if (!cap) { _vcHideBubble(); _vcSel = null; return; }
    _vcSel = cap;
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    _vcBubble.style.display = 'flex';
    const bw = _vcBubble.offsetWidth || 120;
    let left = Math.round(rect.left + rect.width / 2 - bw / 2);
    left = Math.max(8, Math.min(window.innerWidth - bw - 8, left));
    let top = Math.round(rect.top - 36);
    if (top < 8) top = Math.round(rect.bottom + 8);
    _vcBubble.style.left = left + 'px';
    _vcBubble.style.top = top + 'px';
  };
  previewContent.addEventListener('mouseup', () => setTimeout(maybeShow, 0));
  document.addEventListener('selectionchange', () => {
    if (state.viewMode !== 'view') return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) _vcHideBubble();
  });
  // Click outside the bubble → close.
  document.addEventListener('mousedown', e => {
    if (_vcBubble && _vcBubble.contains(e.target)) return;
    if (!previewContent.contains(e.target)) _vcHideBubble();
  }, true);
}

// ─── Hint "Vai a <path>" on link hover (view mode) ────────────────────────────
// Show a tooltip near the pointer with the destination of the link under the
// mouse; it follows the cursor and stays inside the window borders.
let _linkHint = null;
function setupLinkHoverHint() {
  _linkHint = document.createElement('div');
  _linkHint.id = 'link-hover-hint';
  _linkHint.style.cssText = 'position:fixed;left:0;top:0;display:none;z-index:3300;max-width:60vw;padding:5px 10px;background:var(--bg-2);border:1px solid var(--border);border-radius:7px;box-shadow:0 4px 14px rgba(0,0,0,.4);font-family:var(--ui-font);font-size:12px;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none';
  document.body.appendChild(_linkHint);

  const targetOf = (a) => {
    if (!a) return '';
    if (a.classList.contains('note-link')) {
      // Show the FULL location (folder/subfolders + name), so if the note lives
      // in a folder the tooltip reads e.g. "serbia/2026-06-14", not just the name.
      const node = resolveNoteLink(a.dataset.note || a.textContent || '');
      if (node && node.path) return node.path.replace(/\.(md|markdown|txt|draw)$/i, '');
      return a.dataset.note || a.textContent || '';
    }
    const href = (a.getAttribute('href') || '').trim();
    // Internal attachment URLs read ugly — show the clean vault-relative path.
    const rel = _attRel(href);
    if (rel != null) return 'attachments/' + rel;
    return href;
  };
  // Position the tooltip next to the pointer, without leaving the window
  const place = (e) => {
    const PAD = 8, OX = 14, OY = 20;
    const r = _linkHint.getBoundingClientRect();
    let x = e.clientX + OX;
    let y = e.clientY + OY;
    if (x + r.width + PAD > window.innerWidth)  x = e.clientX - r.width - OX;
    if (y + r.height + PAD > window.innerHeight) y = e.clientY - r.height - 10;
    _linkHint.style.left = Math.max(PAD, x) + 'px';
    _linkHint.style.top  = Math.max(PAD, y) + 'px';
  };
  const show = (a, e) => {
    // Unresolved [[wikilink]] → no "Go to" hint: it leads nowhere.
    if (a.dataset.unresolved) { _linkHint.style.display = 'none'; return; }
    const dest = targetOf(a);
    if (!dest) { _linkHint.style.display = 'none'; return; }
    const label = (window.i18n ? window.i18n.t('view.link_goto') : 'Vai a');
    _linkHint.textContent = label + ' → ' + dest;
    _linkHint.style.display = 'block';
    place(e);
  };
  previewContent.addEventListener('mouseover', e => {
    const a = e.target.closest && e.target.closest('a');
    if (a && previewContent.contains(a)) show(a, e);
  });
  previewContent.addEventListener('mousemove', e => {
    if (_linkHint.style.display === 'none') return;
    const a = e.target.closest && e.target.closest('a');
    if (a && previewContent.contains(a)) place(e);
    else _linkHint.style.display = 'none';
  });
  previewContent.addEventListener('mouseout', e => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const to = e.relatedTarget;
    if (to && a.contains(to)) return; // still inside the same link
    _linkHint.style.display = 'none';
  });
  // Clicking a link navigates to the destination while the pointer stays put:
  // no mousemove/mouseout fires, so the stale "Vai a" hint would keep floating
  // over the note we just landed on. Hide it on any click in the preview.
  previewContent.addEventListener('click', () => { _linkHint.style.display = 'none'; }, true);
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  const menu = $('context-menu');

  document.addEventListener('click', e => {
    if (!e.target.closest('#context-menu')) {
      menu.style.display = 'none';
    }
  });

  // Right-click on empty area of file tree → create note/folder at root
  $('file-tree').addEventListener('contextmenu', e => {
    if (!e.target.closest('.tree-note') && !e.target.closest('.tree-folder')) {
      showContextMenu(e, null);
    }
  });

  $('ctx-new-note').addEventListener('click', async () => {
    const target = state.contextTarget;
    let folder = '';
    if (target) {
      folder = target.type === 'folder' ? target.path : (target.path.includes('/') ? target.path.split('/').slice(0, -1).join('/') : '');
    }
    menu.style.display = 'none';
    await createNewNote(folder);
  });

  $('ctx-new-folder-here').addEventListener('click', async () => {
    const target = state.contextTarget;
    let parent = '';
    if (target) {
      parent = target.type === 'folder' ? target.path : (target.path.includes('/') ? target.path.split('/').slice(0, -1).join('/') : '');
    }
    menu.style.display = 'none';
    await createNewFolder(parent);
  });

  $('ctx-open-new-tab').addEventListener('click', () => {
    if (state.contextTarget) {
      // If the note is already open in another tab, start from ITS content
      // (it may hold unsaved edits) — duplicate tabs stay in sync on switch.
      const twin = tabs.find(t => t.path === state.contextTarget.path && !t.type);
      tabs.push({
        path: state.contextTarget.path,
        name: state.contextTarget.name,
        content: twin ? twin.content : '',
        isDirty: twin ? twin.isDirty : false,
        viewMode: 'edit',
        scrollPos: 0,
        cursorPos: 0,
        created: state.contextTarget.created,
        modified: state.contextTarget.modified,
      });
      switchTab(tabs.length - 1);
    }
    menu.style.display = 'none';
  });
  $('ctx-rename').addEventListener('click', async () => {
    if (state.contextTarget) await renameNote(state.contextTarget);
    menu.style.display = 'none';
  });

  $('ctx-duplicate')?.addEventListener('click', async () => {
    const target = state.contextTarget;
    menu.style.display = 'none';
    if (target) await duplicateNode(target);
  });

  $('ctx-color')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const node = state.contextTarget; if (!node) return;
    // Anchor the palette to the menu item; keep the main menu open behind it.
    const r = $('ctx-color').getBoundingClientRect();
    openColorPalette(node, r.right + 8, r.top, r.left);
  });

  $('ctx-emoji')?.addEventListener('click', () => {
    const node = state.contextTarget; if (!node) return;
    const r = menu.getBoundingClientRect();
    menu.style.display = 'none';
    openEmojiPicker(r.left, r.top, emo => addEmojiToNode(node, emo));
  });
  $('ctx-delete').addEventListener('click', async () => {
    const target = state.contextTarget;
    menu.style.display = 'none';
    if (target) await deleteNote(target);
  });
  $('ctx-open-location').addEventListener('click', () => {
    if (state.contextTarget?.path) {
      window.inkwell.showItemInFolder(state.contextTarget.path);
    }
    menu.style.display = 'none';
  });

  $('ctx-open-external').addEventListener('click', () => {
    const n = state.contextTarget;
    // Decrypt to a temp file in main and open it with the OS default app — the
    // vault copy stays encrypted, so opening the raw file directly never works.
    if (n?.attachmentName) window.inkwell.openAttachmentFile(n.attachmentName).catch(() => {});
    menu.style.display = 'none';
  });

  $('ctx-sort-name').addEventListener('click', () => {
    sortFolderChildren(state.contextTarget, 'name-asc');
    menu.style.display = 'none';
  });
  $('ctx-sort-date').addEventListener('click', () => {
    sortFolderChildren(state.contextTarget, 'date-desc');
    menu.style.display = 'none';
  });
}

function showContextMenu(e, node) {
  e.preventDefault();
  state.contextTarget = node;
  const menu = $('context-menu');
  const isFolder = node ? node.type === 'folder' : false;
  const hasTarget = !!node;
  $('ctx-sep-create').style.display   = hasTarget ? '' : 'none';
  $('ctx-open-new-tab').style.display = (!hasTarget || isFolder) ? 'none' : '';
  $('ctx-rename').style.display       = hasTarget ? '' : 'none';
  // Duplicate: available for notes and folders (not for PDFs / attachments).
  const ctxDup = $('ctx-duplicate');
  if (ctxDup) ctxDup.style.display = (hasTarget && !isAttachNode(node)) ? '' : 'none';
  // Set color — notes and folders (not PDFs). Always reads "Set color ›"
  // regardless of whether a color is already assigned.
  const ctxColor = $('ctx-color');
  if (ctxColor) {
    const showColor = hasTarget && !isAttachNode(node);
    ctxColor.style.display = showColor ? '' : 'none';
    if (showColor) ctxColor.textContent = window.i18n.t('ctx.color_set');
  }
  const ctxEmoji = $('ctx-emoji'); if (ctxEmoji) ctxEmoji.style.display = (hasTarget && !isAttachNode(node)) ? '' : 'none';
  $('ctx-open-location').style.display= hasTarget ? '' : 'none';
  // PDFs/images are encrypted at rest — they can't be opened straight from the
  // vault folder. This decrypts to a temp file and opens it in the default app.
  const ctxExt = $('ctx-open-external');
  if (ctxExt) ctxExt.style.display =
    (hasTarget && isAttachNode(node) && node.attachmentName) ? '' : 'none';
  const ctxBm = $('ctx-bookmark');
  if (ctxBm) {
    ctxBm.style.display = (hasTarget && !isFolder) ? '' : 'none';
    if (hasTarget && !isFolder) {
      ctxBm.textContent = isBookmarked(node.path)
        ? window.i18n.t('ctx.unbookmark') : window.i18n.t('ctx.bookmark');
    }
  }
  $('ctx-sep-sort').style.display     = isFolder ? '' : 'none';
  $('ctx-sort-name').style.display    = isFolder ? '' : 'none';
  $('ctx-sort-date').style.display    = isFolder ? '' : 'none';
  $('ctx-delete').style.display       = hasTarget ? '' : 'none';
  // Show, then clamp inside the window so the menu (e.g. on a file near the
  // bottom) is never cut off — flip up / shift left when it would overflow.
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.max(4, Math.min(e.clientX, vw - mw - 4)) + 'px';
  menu.style.top  = Math.max(4, Math.min(e.clientY, vh - mh - 4)) + 'px';
}

// ─── Duplicate a note or folder ───────────────────────────────────────────────
// Creates a real copy on disk with a unique "name (1)" name next to the original.
// Notes: copies content. Folders: recursively copies every note inside.
// Does NOT open the duplicate — it just appears in the tree.
async function duplicateNode(node) {
  if (!node || isAttachNode(node)) return;
  const flat = flattenTree(state.notes);

  // Pick a unique sibling name based on `base`, testing `exists(candidatePath)`.
  // Uses the conventional " (1)", " (2)"… suffix.
  function uniqueName(base, parent, isFolder, exists) {
    const join = (name) => parent ? `${parent}/${name}` : name;
    const suffix = isFolder ? '' : '.md';
    let n = 1;
    let name = `${base} (${n})`;
    let candidate = join(name) + suffix;
    while (exists(candidate)) {
      n++;
      name = `${base} (${n})`;
      candidate = join(name) + suffix;
    }
    return { name, path: candidate };
  }

  const parent = node.path.includes('/') ? node.path.split('/').slice(0, -1).join('/') : '';

  if (node.type === 'folder') {
    const folderExists = (p) => flat.some(x => x.type === 'folder' && x.path === p)
      || anyFolderAtPath(state.notes, p);
    const { path: newFolderPath } = uniqueName(node.name, parent, true, folderExists);
    await window.inkwell.createFolder(newFolderPath);
    // Recursively copy all notes contained in the source folder.
    const prefix = node.path + '/';
    for (const n of flat) {
      if (n.type === 'note' && n.path.startsWith(prefix)) {
        const rel = n.path.slice(prefix.length);
        const destPath = `${newFolderPath}/${rel}`;
        const content = await window.inkwell.readNote(n.path).catch(() => '');
        await window.inkwell.writeNote(destPath, content);
      }
    }
    openFolderAncestors(newFolderPath);
    await loadTree();
    return;
  }

  // Note — create the copy on disk but do NOT open it.
  const noteExists = (p) => flat.some(x => x.path === p);
  const { path: newPath } = uniqueName(node.name, parent, false, noteExists);
  const content = await window.inkwell.readNote(node.path).catch(() => '');
  await window.inkwell.writeNote(newPath, content);
  if (parent) openFolderAncestors(parent);
  await loadTree();
}

// Duplicate a .draw file → "name (1).draw", preserving the .draw extension.
// Does NOT open the copy; it just appears in the tree.
async function duplicateDraw(path) {
  if (!path) return;
  const flat = flattenTree(state.notes);
  const exists = (p) => flat.some(x => x.path === p);
  const parent = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
  const base = path.split('/').pop().replace(/\.draw$/i, '');
  let n = 1;
  let candidate = (parent ? `${parent}/${base} (${n})` : `${base} (${n})`) + '.draw';
  while (exists(candidate)) {
    n++;
    candidate = (parent ? `${parent}/${base} (${n})` : `${base} (${n})`) + '.draw';
  }
  const content = await window.inkwell.readNote(path).catch(() => '');
  await window.inkwell.writeNote(candidate, content);
  if (parent) openFolderAncestors(parent);
  await loadTree();
}

// ─── Tab context menu (right-click on an open note tab) ───────────────────────
let _tabCtxIdx = -1;
function showTabContextMenu(e, idx) {
  e.preventDefault();
  e.stopPropagation();
  const tab = tabs[idx];
  if (!tab) return;
  _tabCtxIdx = idx;
  const menu = $('tab-context-menu');
  if (!menu) return;
  // Split view only makes sense for a real, file-backed note (not mindmap/
  // canvas/pdf special tabs, and not an unsaved blank tab).
  const canSplit = !tab.type && !!tab.path;
  $('tctx-split-right').style.display = canSplit ? '' : 'none';
  $('tctx-split-down').style.display  = canSplit ? '' : 'none';
  // Detach — open a real, file-backed markdown note in its own window.
  const det = $('tctx-detach');
  if (det) det.style.display = (!tab.type && !!tab.path) ? '' : 'none';
  // Rename — for any file-backed tab (notes, draw, pdf), not the graph.
  const rn = $('tctx-rename');
  if (rn) rn.style.display = (tab.type !== 'mindmap' && !!tab.path) ? '' : 'none';
  // Duplicate — for markdown notes and draw files (not pdf/graph).
  const dup = $('tctx-duplicate');
  if (dup) dup.style.display = ((!tab.type || tab.type === 'canvas') && !!tab.path) ? '' : 'none';
  // Bookmark toggle — only for real notes; label reflects current state.
  const bm = $('tctx-bookmark');
  if (bm) {
    const canBookmark = !tab.type && !!tab.path;
    bm.style.display = canBookmark ? '' : 'none';
    if (canBookmark) {
      bm.textContent = isBookmarked(tab.path)
        ? window.i18n.t('ctx.unbookmark') : window.i18n.t('ctx.bookmark');
    }
  }
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
}

function setupTabContextMenu() {
  const menu = $('tab-context-menu');
  if (!menu) return;
  document.addEventListener('click', e => {
    if (!e.target.closest('#tab-context-menu')) menu.style.display = 'none';
  });
  $('tctx-rename')?.addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (!tab || !tab.path) return;
    if (tab.type === 'canvas') {
      // .draw: switch to it and rename from its title field.
      if (activeTabIdx !== _tabCtxIdx) switchTab(_tabCtxIdx);
      setTimeout(() => renameDrawTitle(), 60);
      return;
    }
    const node = findNote(state.notes, tab.path)
      || { type: ATTACH_NODE_TYPES.has(tab.type) ? tab.type : 'note', name: tab.name, path: tab.path,
           attachmentName: tab.attachmentName };
    renameNote(node);
  });
  $('tctx-duplicate')?.addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (!tab || !tab.path) return;
    if (tab.type === 'canvas') { duplicateDraw(tab.path); return; }
    const node = findNote(state.notes, tab.path) || { type: 'note', name: tab.name, path: tab.path };
    duplicateNode(node);
  });
  $('tctx-split-right').addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (tab && tab.path) openSplitView(tab.path, tab.name, 'right');
  });
  $('tctx-split-down').addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (tab && tab.path) openSplitView(tab.path, tab.name, 'down');
  });
  $('tctx-detach')?.addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (!tab || !tab.path) return;
    const themeAttr = document.documentElement.getAttribute('data-theme') || '';
    window.inkwell.openDetached?.(tab.path, tab.name, themeAttr);
  });
  $('tctx-bookmark')?.addEventListener('click', () => {
    menu.style.display = 'none';
    const tab = tabs[_tabCtxIdx];
    if (tab && tab.path) toggleBookmark({ path: tab.path, name: tab.name });
  });
  $('tctx-close').addEventListener('click', () => {
    menu.style.display = 'none';
    if (_tabCtxIdx >= 0) closeTab(_tabCtxIdx);
  });
}

// ─── Note-link back history ───────────────────────────────────────────────────
// Paths visited BEFORE following a [[note-link]] in the preview. The native
// right-click menu offers "Torna alla nota precedente" while non-empty.
const _noteBackStack = [];
function goBackNote() {
  while (_noteBackStack.length) {
    const path = _noteBackStack.pop();
    const node = _findNode(path);
    if (node) { openNote(node); return; }
    // Note deleted/renamed meanwhile: skip and keep walking back.
  }
}

// ─── Split view: secondary pane with its own note and view mode ───────────────
// The secondary pane (#editor-pane-b) hosts a note: by default the same one as
// the main editor (parallel view), but with the pane focused, clicking another
// note in the sidebar loads it HERE instead of opening a tab. The pane has its
// own edit/view toggle. When both panes show the same path they stay in sync.
let _splitPath = null;
let _splitSyncing = false;
let _splitBasis = null;       // the pane's size (e.g. '35%' or '407px'), so reopening keeps it
let _splitOrient = 'right';   // 'right' = side-by-side, 'down' = stacked
let _splitMode = 'edit';      // edit | view — follows the note's own toggle, for both halves
let _focusedPane = 'main';    // main | split — last pane the user interacted with

// orient: 'right' (side-by-side) or 'down' (stacked vertically).
function openSplitView(path, name, orient = 'right') {
  _splitPath = path;
  _splitOrient = (orient === 'down') ? 'down' : 'right';
  // The split belongs to the tab that opened it. It used to be app-wide state, so every
  // other tab you clicked came up split as well, showing a pane of a note it had nothing
  // to do with. Recorded on the ACTIVE tab — the one hosting the split; the paths that
  // load another note INTO the pane keep the same active tab, so the owner doesn't move.
  // `owner` is the note the split was opened FROM: clicking a note in the tree reuses the
  // same tab rather than opening a new one, so keying on the tab object alone let the pane
  // follow you onto every note you opened next.
  // The pane is PINNED to the tab, not to a note: it keeps showing its own note while you
  // open other notes in the main half, and closes only when you close it. Recorded on the
  // tab so the other tabs stay whole and this one gets its pane back.
  const _host = getActiveTab();
  if (_host) _host.split = { path, name: name || null, orient: _splitOrient, basis: _splitBasis };
  const paneB = $('editor-pane-b');
  const edB = $('markdown-editor-b');
  const resizer = $('split-resizer');
  const split = $('content-split');
  if (!paneB || !edB) return;
  const wasOpen = paneB.style.display !== 'none';
  // Seed the secondary pane with the current content. If this is the active
  // tab, use the live editor value; otherwise read from the cached tab/disk.
  const active = getActiveTab();
  if (active && active.path === path) {
    edB.value = editor.value;
    _splitLoading = null;
  } else {
    const t = getTab(path);
    if (t && t.content) {
      edB.value = t.content;
      _splitLoading = null;
    } else {
      // Content not cached → read from disk ASYNC. DATA-LOSS GUARD: mark the pane
      // as LOADING so its input handler won't persist a truncated buffer (typing
      // before the read lands used to autosave just the typed chars over the whole
      // note). Editing is ignored until the real content arrives.
      edB.value = '';
      _splitLoading = path;
      window.inkwell.readNote(path).then(c => {
        if (_splitPath === path && _splitLoading === path) {
          edB.value = c || '';
          _splitLoading = null;
          const tt = getTab(path); if (tt && !tt.content) tt.content = c || '';
          if (_splitMode === 'view') renderSplitPreview();
        }
      }).catch(() => { if (_splitLoading === path) _splitLoading = null; });
    }
  }
  // Toggle layout direction; reset to a 50% split only on first open (loading
  // another note into an already-open pane keeps the user's size).
  if (split) split.classList.toggle('split-down', _splitOrient === 'down');
  // Reopening keeps the size it had: `basis` comes from the tab's remembered split, so
  // walking away and coming back does not snap the divider back to the middle. 50% only
  // for a split that has no size yet.
  if (!wasOpen) paneB.style.flex = `0 0 ${_splitBasis || '50%'}`;
  paneB.style.display = 'flex';
  if (resizer) resizer.style.display = 'block';
  document.body.classList.add('split-open');
  // A freshly opened half starts in the note's current mode, so the two never disagree.
  try { setSplitMode(state.viewMode === 'view' ? 'view' : 'edit'); } catch (_) {}
  updatePaneMetaChips();
  setFocusedPane(_focusedPane);   // refresh title + focus ring
}

// In split mode each pane carries its own "created · last edited" chip
// (bottom-right corner), so the dates are never ambiguous; the header dates
// row is hidden meanwhile (CSS body.split-open). One chip per pane element —
// the main note's chip goes on both #editor-pane and #preview-pane (only the
// visible one shows).
function _fmtNoteDate(dt) {
  if (!dt) return '—';
  const d = new Date(dt); const p = n => String(n).padStart(2, '0');
  return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear()
    + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
// The floating "created · last edited" chip each pane carried in split mode is gone — it
// sat on top of the text in the corner. The header's dates row is no longer hidden while
// splitting, so the information is still there. Kept as a no-op that also SWEEPS any chip
// left in the DOM, so nothing lingers for someone updating mid-session.
function updatePaneMetaChips() {
  document.querySelectorAll('.pane-meta-chip').forEach(el => el.remove());
}

// Central focus switch: remembers the pane, updates the header title and the
// visual focus ring. The ring lives ONLY on the split pane (when it owns the
// title). BOTH halves can carry it now: the selected one gets a thin light outline, so it is
// always clear which half a keystroke or a tree click will land in. Only while split — a
// single pane needs no outline (the CSS is scoped to body.split-open).
function setFocusedPane(which, opts) {
  const prev = _focusedPane;
  _focusedPane = (which === 'split') ? 'split' : 'main';
  try { updateTitleForFocus(); } catch (_) {}
  const split = !!_splitPath;
  const b = $('editor-pane-b');
  if (b) b.classList.toggle('pane-focused', split && _focusedPane === 'split');
  // The main half is one of two elements depending on the mode (editor or preview); mark
  // both, only the visible one shows.
  ['editor-pane', 'preview-pane'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('pane-focused', split && _focusedPane === 'main');
  });
  // Show the frame only for a moment. setFocusedPane also runs on plain refreshes (a tab
  // switch, a title re-assert), and flashing on those would blink for no reason — so only
  // on a real change of half, or when a click asks for it explicitly.
  if (split && (prev !== _focusedPane || (opts && opts.flash))) _flashFocusedPane();
}

// A 1-second frame around the selected half, then gone. The class is removed afterwards so
// selecting again re-triggers the animation from the start.
let _paneFlashTimer = null;
function _flashFocusedPane() {
  document.querySelectorAll('.pane-flash').forEach(el => el.classList.remove('pane-flash'));
  clearTimeout(_paneFlashTimer);
  if (!_splitPath) return;
  const ids = _focusedPane === 'split' ? ['editor-pane-b'] : ['editor-pane', 'preview-pane'];
  const els = ids.map(id => $(id)).filter(Boolean);
  els.forEach(el => { void el.offsetWidth; el.classList.add('pane-flash'); });   // reflow → restart
  _paneFlashTimer = setTimeout(() => els.forEach(el => el.classList.remove('pane-flash')), 1100);
}

// The big header title follows the FOCUSED pane in split mode: click the left
// pane → main note's title, click the right pane → split note's title. While
// the split pane owns the title the input is read-only (the title field
// renames the note, and it must never rename the wrong one).
function updateTitleForFocus() {
  let focusName = null;
  if (_splitPath && _focusedPane === 'split') {
    const node = _findNode(_splitPath);
    focusName = (node && node.name) || _baseName(_splitPath);
    noteTitle.value = focusName;
    noteTitle.readOnly = true;
    // The VISIBLE title under the tab bar is the breadcrumb (#note-title is
    // display:none — the breadcrumb took its place): render the split note's
    // path there too, or the user sees no change at all.
    try { renderBreadcrumb({ path: _splitPath, name: focusName }); } catch (_) {}
  } else {
    const t = getActiveTab();
    if (t) {
      noteTitle.value = t.name;
      focusName = t.name;
      try { renderBreadcrumb(t); } catch (_) {}
    }
    noteTitle.readOnly = false;
  }
  // The ACTIVE tab's visible label in the tab bar mirrors the focused pane's
  // note too (display only — tab.name stays bound to the real file). ONLY for
  // plain note tabs: special tabs (mindmap/canvas/pdf/image) carry decorated
  // labels (icon + suffix) that a bare textContent write would wipe — the
  // label visibly flip-flopped between "⬡ Graph" and "Graph" on every focus
  // change.
  const at = tabs[activeTabIdx];
  if (at && at.type) return;
  const tabEl = document.querySelectorAll('.note-tab')[activeTabIdx];
  const nameEl = tabEl ? tabEl.querySelector('.tab-name') : null;
  if (nameEl && focusName != null) nameEl.textContent = focusName;
}

// Re-apply the split-note label after a tab-bar re-render (which resets the
// labels to the tabs' own names). No-op unless the split pane owns the title.
function _mirrorActiveTabLabel() {
  if (!(_splitPath && _focusedPane === 'split')) return;
  if (tabs[activeTabIdx]?.type) return;   // never wipe a decorated special-tab label
  const node = _findNode(_splitPath);
  const focusName = (node && node.name) || _baseName(_splitPath);
  const tabEl = document.querySelectorAll('.note-tab')[activeTabIdx];
  const nameEl = tabEl ? tabEl.querySelector('.tab-name') : null;
  if (nameEl) nameEl.textContent = focusName;
}

function closeSplitView() {
  // Closing is deliberate: forget it for this tab too, or coming back would reopen it.
  const _host = getActiveTab();
  if (_host) delete _host.split;
  _splitPath = null;
  _focusedPane = 'main';
  const paneB = $('editor-pane-b');
  const resizer = $('split-resizer');
  const split = $('content-split');
  if (paneB) paneB.style.display = 'none';
  if (resizer) resizer.style.display = 'none';
  if (split) split.classList.remove('split-down');
  document.body.classList.remove('split-open');
  updatePaneMetaChips();
  setFocusedPane('main');   // restore title + clear focus rings
}

// Render the split pane's markdown into #preview-content-b. Lightweight twin
// of updatePreview: same pre-processing, highlight and code-block chrome; no
// image-resize/checkbox write-back (those are wired to the main editor).
function renderSplitPreview() {
  const pvB = $('preview-content-b');
  const edB = $('markdown-editor-b');
  if (!pvB || !edB || typeof marked === 'undefined') return;
  marked.setOptions({ breaks: true, gfm: true });
  const body = _previewBody(edB.value);
  const { cleanedBody } = extractTableWidthMarkers(body);
  const processedBody = cleanedBody
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
      const t = target.trim();
      const display = (alias || target).trim();
      return `<a class="note-link" data-note="${t.replace(/"/g, '&quot;')}" href="#">${display}</a>`;
    })
    .replace(/(!)\[([^\]]*)\]\(([^)]+)\)\{width=(\d+)\}/g,
      (_, bang, alt, url, w) => `<img src="${url}" alt="${alt}" width="${w}" style="width:${w}px;height:auto">`)
    .replace(/==([^=\n]+?)==/g, '<mark class="md-highlight">$1</mark>')
    .replace(/:([a-z0-9_+-]+):/g, (m, name) => EMOJI_MAP[name] || m);
  pvB.innerHTML = sanitizeNoteHtml(marked.parse(processedBody).replace(/(src=")attachments\//g, '$1inkwell://attachments/'));
  // Colours kept, but chunked over idle time (see highlightCodeChunked) so live
  // split view stays responsive while typing on a big document. Each render bumps
  // _splitRenderToken, cancelling the previous run's remaining batches.
  if (typeof hljs !== 'undefined') {
    const _st = ++_splitRenderToken;
    highlightCodeChunked(() => _st === _splitRenderToken,
      [...pvB.querySelectorAll('pre code')], 0);
  }
  decorateCodeBlocks(pvB);
  embedMediaPlayers(pvB);
  // Wiki-links clicked in the split preview load into the split pane itself.
  pvB.querySelectorAll('.note-link').forEach(a => {
    const node = resolveNoteLink(a.dataset.note || '');
    if (node) {
      a.style.cssText = 'color:var(--link);text-decoration:none;border-bottom:1px dashed color-mix(in srgb, var(--link) 55%, transparent);cursor:pointer';
      a.addEventListener('click', e => {
        e.preventDefault();
        openSplitView(node.path, node.name, _splitOrient);
      });
    }
  });
}

function setSplitMode(mode) {
  _splitMode = (mode === 'view') ? 'view' : 'edit';
  const edB = $('markdown-editor-b');
  const pvB = $('preview-pane-b');
  if (!edB || !pvB) return;
  if (_splitMode === 'view') {
    renderSplitPreview();
    edB.style.display = 'none';
    pvB.style.display = 'block';
  } else {
    pvB.style.display = 'none';
    edB.style.display = 'block';
    edB.focus();
  }
}

// Clone every CSS rule that targets #preview-content onto #preview-content-b
// so the split preview's typography always matches the main one (single
// source of truth: style.css only styles #preview-content).
function _cloneSplitPreviewStyles() {
  const out = [];
  const visit = (rules) => {
    for (const r of rules) {
      if (r.selectorText && r.selectorText.includes('#preview-content')) {
        out.push(r.cssText.split('#preview-content').join('#preview-content-b'));
      } else if (r.cssRules) {
        visit(r.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { visit(sheet.cssRules); } catch (_) { /* cross-origin sheet */ }
  }
  if (out.length) {
    const st = document.createElement('style');
    st.id = 'split-preview-styles';
    st.textContent = out.join('\n');
    document.head.appendChild(st);
  }
}

// ✕ on the MAIN pane (split mode only): "close this half" — the split note is
// promoted into the main tab and the split closes. Mirrors pane B's ✕.
async function closeMainPaneInSplit() {
  if (!_splitPath) return;
  const path = _splitPath;
  const edB = $('markdown-editor-b');
  // Flush any pending split autosave so the promoted note is fresh on disk.
  clearTimeout(_splitSaveTimer);
  if (edB) { try { await window.inkwell.writeNote(path, edB.value); } catch (_) {} }
  const node = _findNode(path) || { type: 'note', path, name: _baseName(path) };
  closeSplitView();
  await openNote(node);
}

function setupSplitView() {
  const edB = $('markdown-editor-b');
  const closeBtn = $('split-b-close');
  if (closeBtn) closeBtn.addEventListener('click', closeSplitView);
  _cloneSplitPreviewStyles();

  // Right-click anywhere: tell main (synchronously, before its native menu
  // pops) which note sits under the cursor — left pane → main note, split
  // pane → split note — so the menu can offer "Apri in nuova finestra" and
  // "Torna alla nota precedente" (back stack of followed note-links).
  // Skipped over images/tables (they have their own DOM context menus).
  document.addEventListener('contextmenu', (e) => {
    let info = null;
    const tgt = e.target;
    const overOwnMenu = tgt.closest && tgt.closest('img, td, th, .img-resize-wrap');
    if (!overOwnMenu && tgt.closest) {
      // isEditor = right-click inside a note editor/preview pane → the native
      // menu may show text formatting. Other editable fields get only Copy/Paste.
      if (tgt.closest('#editor-pane-b')) {
        const node = _splitPath ? _findNode(_splitPath) : null;
        info = _splitPath
          ? { path: _splitPath, name: (node && node.name) || _baseName(_splitPath), isEditor: true }
          : { isEditor: true };
      } else if (tgt.closest('#editor-pane, #preview-pane')) {
        const t = getActiveTab();
        info = (t && t.path && !t.type) ? { path: t.path, name: t.name, isEditor: true } : { isEditor: true };
      }
    }
    if (info) {
      info.theme = document.documentElement.getAttribute('data-theme') || '';
      info.canGoBack = _noteBackStack.length > 0;
      // Media (player or attachment link) under the cursor → the menu offers
      // "Apri file / Apri percorso / Elimina".
      const mediaEl = tgt.closest && tgt.closest('.media-embed, a[href^="inkwell://attachments/"], a[href^="attachments/"]');
      if (mediaEl) {
        const href = mediaEl.matches && mediaEl.matches('a')
          ? mediaEl.getAttribute('href')
          : mediaEl.querySelector('audio, video')?.getAttribute('src');
        if (href) {
          const rel = _attRel(href);
          if (rel) info.media = { rel, href };
        }
      }
      // EDIT mode: right-click on an attachment link inside the CodeMirror editor.
      // Map the click COORDINATES to a document position (a right-click doesn't move the
      // caret, and the CM target isn't the legacy `editor` textarea), then, if that
      // position sits inside an attachments/ link, offer the file actions for it.
      if (!info.media && tgt.closest && tgt.closest('#cm-mount')) {
        let pos = null;
        try { if (_cmHandle && _cmHandle.view && _cmHandle.view.posAtCoords) pos = _cmHandle.view.posAtCoords({ x: e.clientX, y: e.clientY }); } catch (_) {}
        if (pos == null) pos = editor.selectionStart;
        const val = editor.value;
        const re = /!?\[[^\]]*\]\(((?:inkwell:\/\/)?attachments\/[^)]+)\)/g;
        let m;
        while ((m = re.exec(val))) {
          if (pos >= m.index && pos <= m.index + m[0].length) {
            const rel = _attRel(m[1]);
            if (rel) info.media = { rel, href: m[1] };
            break;
          }
        }
      }
    }
    try { window.inkwell.setCtxNoteTarget?.(info); } catch (_) {}
  }, true);

  // Media actions from the native menu (delete confirms, then removes both
  // the file on disk and every markdown reference in the current note).
  window.inkwell.onEditorCmd?.(async cmd => {
    if (typeof cmd !== 'string' || !cmd.startsWith('media:')) return;
    let payload;
    try { payload = JSON.parse(cmd.slice('media:'.length)); } catch (_) { return; }
    if (payload.action === 'delete' && payload.rel) {
      const leaf = payload.rel.split('/').pop();
      const ok = await showConfirmModal(`Eliminare "${leaf}"? Il file verrà cancellato dal vault e il link rimosso dalla nota.`);
      if (!ok) return;
      try { await window.inkwell.deleteAttachment(payload.rel); } catch (_) {}
      // Remove every reference (encoded or plain href) + optional {width=N}.
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const encSeg = payload.rel.split('/').map(encodeURIComponent).join('/');
      const hrefs = [payload.href,
        'inkwell://attachments/' + encodeURIComponent(payload.rel),
        'inkwell://attachments/' + encSeg,
        'attachments/' + encSeg];
      let updated = editor.value;
      for (const h of new Set(hrefs.filter(Boolean))) {
        const re = new RegExp('!?\\[[^\\]]*\\]\\(' + esc(h) + '\\)(\\{width=\\d+\\})?', 'g');
        updated = updated.replace(re, '');
      }
      if (updated !== editor.value) {
        editor.value = updated.replace(/\n{3,}/g, '\n\n');
        editor.dispatchEvent(new Event('input'));
      }
      try { updatePreview(); } catch (_) {}
      try { refreshAttachmentChips(); } catch (_) {}
    }
    if (payload.action === 'rename' && payload.rel) {
      const oldRel = payload.rel, oldLeaf = oldRel.split('/').pop();
      const typed = await showInputModal('Rinomina allegato:', oldLeaf);
      if (!typed || !typed.trim() || typed.trim() === oldLeaf) return;
      let finalName;
      try { finalName = await window.inkwell.renameAttachment(oldRel, typed.trim()); } catch (_) { return; }
      if (!finalName || finalName === oldRel) { try { refreshAttachmentChips(); } catch (_) {} return; }
      // Patch the OPEN note's in-memory content (main already patched the saved notes).
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const encOld = oldRel.split('/').map(encodeURIComponent).join('/');
      const encNew = finalName.split('/').map(encodeURIComponent).join('/');
      const newLeaf = finalName.split('/').pop();
      let updated = editor.value;
      // 1) URL forms (anchored on "attachments/" so a short name can't over-match).
      for (const pre of ['attachments/', 'inkwell://attachments/']) {
        updated = updated.replace(new RegExp(esc(pre + encOld), 'g'), pre + encNew);
      }
      // 2) Clean the visible label so the name isn't shown twice:
      //    - MEDIA embeds (![…] — image/audio/video) → reset the icon to the type marker
      //      (📷/🎵/🎬) for the RENAMED file; the filename is already in the URL.
      //    - other links ([📎 …]) → swap the old leaf for the new one.
      const encNewEsc = esc(encNew);
      const mediaIcon = AUDIO_EXT_RE.test(finalName) ? '🎵'
                      : VIDEO_EXT_RE.test(finalName) ? '🎬'
                      : /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(finalName) ? '📷'
                      : '';
      if (mediaIcon) {
        updated = updated.replace(
          new RegExp('!\\[[^\\]]*\\]\\(((?:inkwell://)?attachments/' + encNewEsc + '(?:\\{[^}]*\\})?)\\)', 'g'),
          '![' + mediaIcon + ']($1)'
        );
      }
      if (oldLeaf !== newLeaf) {
        updated = updated.replace(
          new RegExp('(^|[^!])\\[([^\\]]*' + esc(oldLeaf) + '[^\\]]*)\\](\\((?:inkwell://)?attachments/' + encNewEsc + ')', 'g'),
          (mm, pre, label, tail) => pre + '[' + label.split(oldLeaf).join(newLeaf) + ']' + tail
        );
      }
      if (updated !== editor.value) { editor.value = updated; editor.dispatchEvent(new Event('input')); }
      try { updatePreview(); } catch (_) {}
      try { refreshAttachmentChips(); } catch (_) {}
    }
  });

  // "Torna alla nota precedente" clicked in the native menu → walk back.
  window.inkwell.onEditorCmd?.(cmd => { if (cmd === 'nav-back') goBackNote(); });

  // ✕ also on the main pane while split (one per pane element — editor and
  // preview — only the visible one shows; CSS gates them on body.split-open).
  ['editor-pane', 'preview-pane'].forEach(id => {
    const pane = $(id);
    if (!pane) return;
    const btn = document.createElement('button');
    btn.className = 'split-a-close';
    btn.title = 'Chiudi questa finestra';
    btn.textContent = '✕';
    btn.addEventListener('click', closeMainPaneInSplit);
    pane.appendChild(btn);
  });

  // No edit/view button in the split half any more — the note's own toggle drives both.

  // Focus tracking: the last pane the user CLICKED receives the notes clicked
  // in the sidebar (see openTab), the header title and the focus ring.
  // Pointerdown ONLY, capture phase: programmatic focus() calls (sync refresh,
  // mode switches, toolbar actions…) must never flip the pane — only a real
  // user click does. Tab-bar clicks imply the main pane.
  const paneBFocus = $('editor-pane-b');
  if (paneBFocus) paneBFocus.addEventListener('pointerdown', () => setFocusedPane('split', { flash: true }), true);
  ['editor-pane', 'preview-pane', 'tab-list'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('pointerdown', () => setFocusedPane('main', { flash: true }), true);
  });

  // Drag the resizer to change the split panes' relative size. Works for both
  // orientations: horizontal drag when split-right, vertical when split-down.
  const resizer = $('split-resizer');
  const paneB = $('editor-pane-b');
  const split = $('content-split');
  if (resizer && paneB && split) {
    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = (_splitOrient === 'down') ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const rect = split.getBoundingClientRect();
      if (_splitOrient === 'down') {
        // Height of pane B = distance from the cursor to the bottom edge.
        let bSize = rect.bottom - e.clientY;
        const min = 100, max = rect.height - 150;
        bSize = Math.max(min, Math.min(max, bSize));
        paneB.style.flex = `0 0 ${bSize}px`;
        _splitBasis = `${bSize}px`;   // remembered, so reopening this split keeps the size
      } else {
        // Width of pane B = distance from the cursor to the right edge.
        let bSize = rect.right - e.clientX;
        const min = 120, max = rect.width - 200;
        bSize = Math.max(min, Math.min(max, bSize));
        paneB.style.flex = `0 0 ${bSize}px`;
        _splitBasis = `${bSize}px`;   // remembered, so reopening this split keeps the size
      }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  if (!edB) return;
  // Edits in pane B → write through to its note + mirror into the main editor
  // if that note is the active tab (same-path parallel view).
  edB.addEventListener('input', () => {
    if (_splitSyncing || !_splitPath) return;
    // The pane's note hasn't finished loading from disk — ignore edits so we
    // never persist a truncated buffer over the real note (the load will fill
    // edB.value in a moment). DATA-LOSS GUARD.
    if (_splitLoading === _splitPath) return;
    const t = getTab(_splitPath);
    if (t) { t.content = edB.value; t.isDirty = true; }
    const active = getActiveTab();
    if (active && active.path === _splitPath) {
      _splitSyncing = true;
      // Assigning .value resets the textarea's caret AND scroll to the top —
      // the user would see the main pane "jump up" and later typing land in
      // the wrong place. Preserve both across the mirror.
      const selS = editor.selectionStart, selE = editor.selectionEnd, st = editor.scrollTop;
      editor.value = edB.value;
      try { editor.setSelectionRange(Math.min(selS, editor.value.length), Math.min(selE, editor.value.length)); } catch (_) {}
      editor.scrollTop = st;
      _splitSyncing = false;
      applyEditorHighlight();
      setSavedState(false);
      updateWordCount();
    }
    // Persist to disk (debounced). Capture path AND value now: by the time the
    // timer fires the pane may host a different note — never cross-write.
    clearTimeout(_splitSaveTimer);
    const savePath = _splitPath;
    const saveValue = edB.value;
    _splitSaveTimer = setTimeout(() => {
      window.inkwell.writeNote(savePath, saveValue).then(() => {
        const tt = getTab(savePath);
        if (tt && tt.content === saveValue) tt.isDirty = false;
      }).catch(() => {});
    }, AUTOSAVE_DELAY_MS);
  });
}
let _splitSaveTimer = null;
let _splitRenderTimer = null;
let _splitLoading = null;   // path whose content is still being read into pane B (edits/saves blocked until it lands)

// Keep pane B in sync when the main editor changes the SAME note.
function syncSplitFromMain() {
  if (_splitSyncing || !_splitPath) return;
  const active = getActiveTab();
  if (!active || active.path !== _splitPath) return;
  const edB = $('markdown-editor-b');
  if (!edB) return;
  _splitSyncing = true;
  // Same caret/scroll preservation as the B→main mirror: a bare .value
  // assignment would scroll pane B back to the top on every keystroke.
  const selS = edB.selectionStart, selE = edB.selectionEnd, st = edB.scrollTop;
  edB.value = editor.value;
  try { edB.setSelectionRange(Math.min(selS, edB.value.length), Math.min(selE, edB.value.length)); } catch (_) {}
  edB.scrollTop = st;
  _splitSyncing = false;
  // If the pane is in view mode, refresh its render (debounced per keystroke).
  if (_splitMode === 'view') {
    clearTimeout(_splitRenderTimer);
    _splitRenderTimer = setTimeout(() => renderSplitPreview(), 150);
  }
}

// ─── Window drag (Wayland) ────────────────────────────────────────────────────
function setupWindowDrag() {
  const titlebar = document.getElementById('titlebar');
  if (!titlebar) return;

  // Empty titlebar area (not buttons/tabs) → start move immediately
  titlebar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('#titlebar-controls, #titlebar-actions, .note-tab, #tab-new-btn, .sst')) return;
    try { window.inkwell.startMove?.(); } catch(_) {}
  });

  // .sst buttons: preventDefault releases pointer capture on Wayland so startMoving works.
  // If mouse barely moved → it was a click → trigger it manually.
  document.querySelectorAll('.sst').forEach(btn => {
    let downPos = null;
    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      downPos = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      try { window.inkwell.startMove?.(); } catch(_) {}
    });
    btn.addEventListener('pointerup', e => {
      if (!downPos) return;
      const wasDrag = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 5;
      downPos = null;
      if (!wasDrag) btn.click();
    });
  });
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────
function applySort(nodes, mode) {
  const sorted = [...nodes];
  if (mode === 'name-asc')  sorted.sort((a, b) => a.name.localeCompare(b.name));
  if (mode === 'name-desc') sorted.sort((a, b) => b.name.localeCompare(a.name));
  if (mode === 'date-desc') sorted.sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0));
  if (mode === 'date-asc')  sorted.sort((a, b) => new Date(a.modified || 0) - new Date(b.modified || 0));
  return sorted;
}

function sortFolderChildren(folderNode, mode) {
  if (!folderNode?.children) return;
  folderNode.children = applySort(folderNode.children, mode);
  renderTree();
}

// ─── Mindmap ──────────────────────────────────────────────────────────────────

// The graph is modelled on Obsidian's: only FILES are nodes and only `[[wiki
// links]]` / embeds are edges by default. Folder nodes and shared-tag edges —
// Amelie extras — are opt-in filters, exactly like Obsidian's Tags/Attachments
// toggles. Layout is a LIVE d3-force-style simulation (link + charge + centre +
// collide) that cools down on its own and reheats on any interaction, instead of
// the old bake-once layout plus a scripted sine "wobble".
let mmDragging = false, mmDragStart = {x:0,y:0}, mmOffset = {x:0,y:0};
let mmScale = 1;
let mmNodes = [], mmEdges = [], mmWikiLinks = [], mmAttachLinks = [];
let mmRaw = null;                 // un-filtered model; the filters derive mmNodes/mmEdges from it
let mmHover = null;
let mmDraggingNode = null;
let mmConnectFrom = null;
let mmMouseWorld = {x:0, y:0};
let mmPhysicsRAF = null;
let mmPhysicsRunning = false;
let mmAlpha = 0;                  // simulation temperature (d3 semantics: 1 = hot, <0.001 = stopped)
let mmAlphaTarget = 0;            // >0 while dragging, so the graph keeps reacting
// Retired: connections live in the notes' markdown, nowhere else. Drop the old
// shadow list so leftovers can't keep drawing edges no note actually has.
try { localStorage.removeItem('amelie-mm-edges'); } catch (_) {}

// ── Graph settings (the Obsidian-like panel) ────────────────────────────────
// Filters decide WHAT is in the graph, Display how it's drawn, Forces how the
// simulation behaves. Persisted so the graph reopens exactly as you left it.
const MM_DEFAULTS = {
  // Filters
  fSearch: '', fTags: false, fFolders: false, fAttach: true, fOrphans: true,
  // Display
  // textFade 0.35 = labels start fading out below ~35% zoom. Kept low on purpose:
  // a big vault is fitted well under 100% on entry, and a threshold near 1 would
  // open the graph with every label already invisible.
  textFade: 0.35, nodeSize: 1, linkWidth: 1, arrows: false,
  // Forces
  fCenter: 0.35, fRepel: 10, fLink: 1, fDist: 90,
};
let mmSet = (() => {
  try { return Object.assign({}, MM_DEFAULTS, JSON.parse(localStorage.getItem('amelie-mm-settings') || '{}')); }
  catch (_) { return Object.assign({}, MM_DEFAULTS); }
})();
function saveMmSettings() {
  try { localStorage.setItem('amelie-mm-settings', JSON.stringify(mmSet)); } catch (_) {}
}

// Node radius grows with the number of links (Obsidian scales by degree too).
// sqrt so a 40-link hub doesn't dwarf everything else.
function mmNodeRadius(n) {
  const deg = n._conns || 0;
  const base = n.type === 'folder' ? 4.5 : 3.4;
  return mmSet.nodeSize * Math.min(base + 2.1 * Math.sqrt(deg), 15);
}

function getNodeAtEvent(e) {
  const canvas = $('mindmap-canvas');
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left - mmOffset.x) / mmScale;
  const my = (e.clientY - rect.top  - mmOffset.y) / mmScale;
  const slack = 6 / mmScale;                 // constant grab margin on screen
  let best = null, bestD = Infinity;
  for (const n of mmNodes) {
    const r = mmNodeRadius(n) + slack;
    const dx = n.x - mx, dy = n.y - my;
    const d = Math.sqrt(dx*dx + dy*dy);
    if (d < r && d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function setupMindmap() {
  $('btn-mindmap').addEventListener('click', () => {
    // Toggle: clicking the icon while the graph is already on screen closes it
    // and returns to the notes (same as the ✕ button / keyboard shortcut).
    const ov = $('mindmap-overlay');
    if (ov.style.display && ov.style.display !== 'none') { closeMindmap(); return; }
    openMindmap();
  });
  $('btn-mindmap-close').addEventListener('click', closeMindmap);

  const canvas = $('mindmap-canvas');

  // Right-click on a wiki/custom edge → "Remove link" menu.
  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - mmOffset.x) / mmScale;
    const my = (e.clientY - rect.top  - mmOffset.y) / mmScale;
    const hit = findMindmapEdgeAt(mx, my, 8 / mmScale);
    if (hit) showMindmapEdgeContextMenu(e.clientX, e.clientY, hit.edge);
  });

  let mmDownPos = { x: 0, y: 0 };
  let mmDownHit = null;
  let mmDragStarted = false;

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    mmDownPos = { x: e.clientX, y: e.clientY };
    mmDragStarted = false;
    const hit = getNodeAtEvent(e);
    mmDownHit = hit;

    if (hit && e.shiftKey) {
      mmConnectFrom = hit;
      mmDownHit = null;
    } else if (!hit) {
      // Pan
      mmDragging = true;
      mmDragStart = { x: e.clientX - mmOffset.x, y: e.clientY - mmOffset.y };
      canvas.style.cursor = 'grabbing';
    }
    // hit without shift: wait to see if it's a click or drag
  });

  document.addEventListener('mouseup', e => {
    if (mmConnectFrom) {
      const hit = getNodeAtEvent(e);
      if (hit && hit !== mmConnectFrom) {
        // The MARKDOWN is the only source of truth for a connection. (There used
        // to be a parallel `amelie-mm-edges` list in localStorage; when a note
        // write failed or was reverted the two drifted apart and the graph drew
        // an edge no note actually had — and a second shift+drag then just
        // deleted that phantom instead of writing the link. Gone.)
        toggleMindmapLink(mmConnectFrom, hit);
      } else {
        drawMindmap();
      }
      mmConnectFrom = null;
    }
    if (mmDraggingNode) {
      mmDraggingNode = null;
      // physics keeps running to settle connected nodes
    } else if (mmDownHit && !mmDragStarted) {
      // Click without drag → open note
      if (mmDownHit.type !== 'folder') {
        // Pass type + attachmentName through so PDFs/images open via their real
        // loader (a bare {path,name} would drop the 'pdf/…' attachmentName).
        openNote({ path: mmDownHit.path, name: mmDownHit.label, modified: mmDownHit.modified,
          type: mmDownHit.type, attachmentName: mmDownHit.attachmentName });
        // You have left the graph: close its tab instead of leaving it in the bar behind the
        // note you just opened (every node clicked used to add a tab and keep 'Graph' around,
        // so it still looked like you were in the graph).
        try {
          const gi = tabs.findIndex(t => t.type === 'mindmap');
          if (gi !== -1) closeTab(gi);
        } catch (_) {}
      }
    }
    mmDownHit = null;
    mmDragging = false;
    canvas.style.cursor = 'grab';
  });

  document.addEventListener('mousemove', e => {
    const canvas = $('mindmap-canvas');
    const rect = canvas.getBoundingClientRect();
    mmMouseWorld.x = (e.clientX - rect.left  - mmOffset.x) / mmScale;
    mmMouseWorld.y = (e.clientY - rect.top   - mmOffset.y) / mmScale;

    // Promote mousedown hit to a real drag after 5px movement
    if (mmDownHit && !mmDragStarted && Math.hypot(e.clientX - mmDownPos.x, e.clientY - mmDownPos.y) > 5) {
      mmDragStarted = true;
      mmDraggingNode = mmDownHit;
      canvas.style.cursor = 'grabbing';
      kickMindmap(0.3);        // reheat so the neighbours follow the dragged node
    }

    if (mmDraggingNode) {
      mmDraggingNode.x = mmMouseWorld.x;
      mmDraggingNode.y = mmMouseWorld.y;
      drawMindmap();
    } else if (mmDragging) {
      mmOffset.x = e.clientX - mmDragStart.x;
      mmOffset.y = e.clientY - mmDragStart.y;
      drawMindmap();
    } else if (mmConnectFrom) {
      canvas.style.cursor = 'crosshair';
      drawMindmap();
    } else {
      updateMindmapHover(e);
    }
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    // Zoom toward the CURSOR (keep the point under the pointer fixed) instead of the
    // world origin — otherwise zooming drifted the graph off toward a corner.
    const rect = canvas.getBoundingClientRect();
    zoomMindmapAround(factor, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // Zoom controls (+ / · / −) in the bottom-right of the mindmap.
  const zoomBy = (factor) => {
    // Buttons zoom toward the VIEWPORT CENTRE so the notes stay centred.
    const rect = canvas.getBoundingClientRect();
    zoomMindmapAround(factor, rect.width / 2, rect.height / 2);
  };
  // Gentler steps (was 1.25 = 25% per click — too aggressive, a couple of zoom-outs
  // and the labels were unreadable). 1.15 = 15% per click.
  $('btn-mm-zoom-in')?.addEventListener('click',  () => zoomBy(1.15));
  $('btn-mm-zoom-out')?.addEventListener('click', () => zoomBy(1 / 1.15));
  // Reset: re-seed the layout (so nodes you dragged around go back), then frame at
  // EXACTLY 100% + centred — the user's kept preference, deliberately not fit-to-view —
  // and reheat so it settles in front of you.
  $('btn-mm-zoom-reset')?.addEventListener('click', () => { layoutMindmap(); resetMindmapView(); kickMindmap(0.45); });

  setupMindmapPanel();
}

// ── Settings panel (Filters / Display / Forces), Obsidian-style ─────────────
// Every control writes straight into `mmSet`, persists, and reheats the
// simulation so you SEE the change immediately. Filter changes rebuild the
// graph (keeping the positions of nodes that survive, so it never reshuffles).
function setupMindmapPanel() {
  const panel = $('mm-settings-panel');
  if (!panel) return;

  $('btn-mm-settings')?.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    $('btn-mm-settings').classList.toggle('active', open);
  });

  // key → [element id, kind]. 'filter' controls change the graph's contents,
  // 'display' only how it's painted, 'force' the simulation.
  const CONTROLS = [
    ['fSearch',  'mm-f-search',    'filter', 'text'],
    ['fTags',    'mm-f-tags',      'filter', 'bool'],
    ['fFolders', 'mm-f-folders',   'filter', 'bool'],
    ['fAttach',  'mm-f-attach',    'filter', 'bool'],
    ['fOrphans', 'mm-f-orphans',   'filter', 'bool'],
    ['textFade', 'mm-d-textfade',  'display','num'],
    ['nodeSize', 'mm-d-nodesize',  'display','num'],
    ['linkWidth','mm-d-linkw',     'display','num'],
    ['arrows',   'mm-d-arrows',    'display','bool'],
    ['fCenter',  'mm-fo-center',   'force',  'num'],
    ['fRepel',   'mm-fo-repel',    'force',  'num'],
    ['fLink',    'mm-fo-link',     'force',  'num'],
    ['fDist',    'mm-fo-dist',     'force',  'num'],
  ];

  const syncUI = () => {
    for (const [key, id, , kind] of CONTROLS) {
      const el = $(id); if (!el) continue;
      if (kind === 'bool') el.checked = !!mmSet[key];
      else el.value = mmSet[key];
    }
  };
  syncUI();

  let _filterT = null;
  for (const [key, id, kind, type] of CONTROLS) {
    const el = $(id); if (!el) continue;
    const apply = () => {
      mmSet[key] = type === 'bool' ? el.checked : type === 'num' ? parseFloat(el.value) : el.value;
      saveMmSettings();
      if (kind === 'filter') {
        // Debounced: typing in the search box shouldn't rebuild per keystroke.
        if (_filterT) clearTimeout(_filterT);
        _filterT = setTimeout(() => { rebuildMindmapGraph(); kickMindmap(0.5); }, type === 'text' ? 180 : 0);
      } else if (kind === 'force') {
        kickMindmap(0.4);
      } else {
        drawMindmap();
      }
    };
    el.addEventListener('input', apply);
    el.addEventListener('change', apply);
  }

  $('btn-mm-restore')?.addEventListener('click', () => {
    mmSet = Object.assign({}, MM_DEFAULTS);
    saveMmSettings();
    syncUI();
    rebuildMindmapGraph();
    layoutMindmap();
    fitMindmapView();
    kickMindmap(0.45);
  });
}

// Zoom the mindmap by `factor`, keeping the world point currently under screen
// pixel (sx, sy) fixed — so the graph zooms toward that point instead of sliding
// toward the world origin. Screen = mmOffset + world*mmScale, so to hold the point:
//   newOffset = s − (s − offset) * (newScale / oldScale)
function zoomMindmapAround(factor, sx, sy) {
  const newScale = Math.max(0.3, Math.min(3, mmScale * factor));
  const k = newScale / mmScale;
  if (k === 1) return;
  mmOffset.x = sx - (sx - mmOffset.x) * k;
  mmOffset.y = sy - (sy - mmOffset.y) * k;
  mmScale = newScale;
  drawMindmap();
}

// ── Live force simulation (the Obsidian graph feel) ─────────────────────────
// d3-force semantics: `alpha` is the temperature. Every tick applies link,
// charge (repulsion), centring and collision forces scaled by alpha, then alpha
// decays exponentially until the graph freezes. Any interaction "reheats" it, so
// the graph is organically alive instead of playing a canned wobble animation.
const MM_ALPHA_MIN   = 0.0015;
const MM_ALPHA_DECAY = 0.0228;   // ≈ settles in 300 ticks, same as d3's default
const MM_VEL_DECAY   = 0.6;      // velocity kept per tick (d3 velocityDecay 0.4)

// Reheat the simulation. `a` = starting temperature (1 = full re-layout energy).
function kickMindmap(a = 1) {
  if (!mmNodes || !mmNodes.length) return;
  mmAlpha = Math.max(mmAlpha, a);
  startMindmapPhysics();
}

function startMindmapPhysics() {
  if (mmPhysicsRunning) return;
  mmPhysicsRunning = true;
  mmPhysicsRAF = requestAnimationFrame(tickMindmapPhysics);
}

function stopMindmapPhysics() {
  if (mmPhysicsRAF) cancelAnimationFrame(mmPhysicsRAF);
  mmPhysicsRAF = null;
  mmPhysicsRunning = false;
}

// Uniform grid over the nodes so charge repulsion is O(n·k) instead of O(n²).
// Cell size = the repulsion cut-off, so each node only tests the 9 cells around
// it. Far-apart pairs contribute almost nothing at 1/d² anyway, and the centre
// force is what keeps detached components from drifting away.
function mmBuildGrid(cell) {
  const grid = new Map();
  for (let i = 0; i < mmNodes.length; i++) {
    const n = mmNodes[i];
    const key = ((n.x / cell) | 0) + ':' + ((n.y / cell) | 0);
    let bucket = grid.get(key);
    if (!bucket) { bucket = []; grid.set(key, bucket); }
    bucket.push(i);
  }
  return grid;
}

function tickMindmapPhysics() {
  mmPhysicsRAF = null;
  if (!mmNodes.length) { mmPhysicsRunning = false; return; }

  mmAlphaTarget = mmDraggingNode ? 0.3 : 0;
  mmAlpha += (mmAlphaTarget - mmAlpha) * MM_ALPHA_DECAY;

  mmSimStep(mmAlpha);
  drawMindmap();

  if (mmAlpha < MM_ALPHA_MIN && !mmDraggingNode) {
    for (const nd of mmNodes) { nd.vx = 0; nd.vy = 0; }
    mmAlpha = 0;
    mmPhysicsRunning = false;
    drawMindmap();
    return;
  }
  mmPhysicsRAF = requestAnimationFrame(tickMindmapPhysics);
}

// One simulation step at temperature `alpha`. Pure physics, no drawing — the
// entry pre-warm (layoutMindmap) runs it in a tight headless loop, the rAF loop
// runs it once per frame.
function mmSimStep(alpha) {
  const n = mmNodes.length;
  if (!n) return;

  const canvas = $('mindmap-canvas');
  const dpr = canvas._dpr || 1;
  const cx = (canvas.width / dpr) / 2, cy = (canvas.height / dpr) / 2;
  // The centre force pulls toward the middle of the GRAPH's own coordinate
  // space, i.e. wherever the viewport is looking — otherwise panning would drag
  // the whole graph along with it.
  const wcx = (cx - mmOffset.x) / mmScale, wcy = (cy - mmOffset.y) / mmScale;

  const L = mmSet.fDist;
  // Charge scaled with the link distance so the equilibrium spacing tracks the
  // "link distance" slider instead of collapsing when you widen it.
  const REP  = mmSet.fRepel * 3 * (L * L) / 900;
  const CUT  = Math.max(160, L * 5);

  for (let i = 0; i < n; i++) {
    const nd = mmNodes[i];
    if (nd.vx === undefined) { nd.vx = 0; nd.vy = 0; }
  }

  // 1) Link force — a spring toward `fDist`, weakened for busy endpoints (d3
  //    uses 1/min(degree) so a hub isn't torn apart by its own children).
  for (const e of mmEdges) {
    const a = mmNodes[e.from], b = mmNodes[e.to];
    if (!a || !b) continue;
    let dx = (b.x + b.vx) - (a.x + a.vx);
    let dy = (b.y + b.vy) - (a.y + a.vy);
    const d = Math.sqrt(dx*dx + dy*dy) || 1e-6;
    const strength = mmSet.fLink / Math.max(1, Math.min(a._conns || 1, b._conns || 1));
    // Shared-tag links are deliberately loose: two notes that merely share a tag
    // shouldn't be yanked as tight as an explicit [[link]].
    const w = e.edgeType === 'tag' ? 0.3 : e.edgeType === 'folder' ? 0.7 : 1;
    const l = ((d - L) / d) * alpha * strength * w;
    const bias = (a._conns || 1) / ((a._conns || 1) + (b._conns || 1));
    if (b !== mmDraggingNode) { b.vx -= dx * l * bias; b.vy -= dy * l * bias; }
    if (a !== mmDraggingNode) { a.vx += dx * l * (1 - bias); a.vy += dy * l * (1 - bias); }
  }

  // 2) Charge — every node repels its neighbourhood at 1/d².
  const grid = mmBuildGrid(CUT);
  const CUT2 = CUT * CUT;
  for (let i = 0; i < n; i++) {
    const a = mmNodes[i];
    const gx = (a.x / CUT) | 0, gy = (a.y / CUT) | 0;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid.get((gx + ox) + ':' + (gy + oy));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const b = mmNodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx*dx + dy*dy;
        if (d2 > CUT2) continue;
        if (d2 < 1e-4) { dx = (i - j) * 0.01 + 0.01; dy = 0.01; d2 = dx*dx + dy*dy; }
        const f = (REP * alpha) / d2;
        if (a !== mmDraggingNode) { a.vx -= dx * f; a.vy -= dy * f; }
        if (b !== mmDraggingNode) { b.vx += dx * f; b.vy += dy * f; }
      }
    }
  }

  // 3) Centre gravity — holds the cloud together and brings orphans home.
  const g = mmSet.fCenter * alpha * 0.09;
  if (g > 0) {
    for (let i = 0; i < n; i++) {
      const nd = mmNodes[i];
      if (nd === mmDraggingNode) continue;
      nd.vx += (wcx - nd.x) * g;
      nd.vy += (wcy - nd.y) * g;
    }
  }

  // 4) Integrate.
  for (let i = 0; i < n; i++) {
    const nd = mmNodes[i];
    if (nd === mmDraggingNode) { nd.vx = 0; nd.vy = 0; continue; }
    nd.vx *= MM_VEL_DECAY;
    nd.vy *= MM_VEL_DECAY;
    nd.x += nd.vx;
    nd.y += nd.vy;
  }

  // 5) Collision — resolve dot overlaps positionally so nodes never stack.
  const grid2 = mmBuildGrid(CUT);
  for (let i = 0; i < n; i++) {
    const a = mmNodes[i];
    const ra = mmNodeRadius(a) + 2;
    const gx = (a.x / CUT) | 0, gy = (a.y / CUT) | 0;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const bucket = grid2.get((gx + ox) + ':' + (gy + oy));
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const b = mmNodes[j];
        const min = ra + mmNodeRadius(b) + 2;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy;
        if (d2 >= min * min || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const push = ((min - d) / d) * 0.5;
        const px = dx * push, py = dy * push;
        if (b !== mmDraggingNode) { b.x += px; b.y += py; }
        if (a !== mmDraggingNode) { a.x -= px; a.y -= py; }
      }
    }
  }
}


// The note to come back to when the graph closes. Its tab is appended at the END, so closing
// it used to land on whatever tab sat last in the bar — not on the note you opened it from.
let _mmReturnPath = null;

async function openMindmap() {
  mmOffset = { x: 0, y: 0 };
  mmScale = 1;
  const cur = getActiveTab();
  if (cur && cur.path && !cur.type) _mmReturnPath = cur.path;
  const existing = tabs.findIndex(t => t.type === 'mindmap');
  if (existing !== -1) { await switchTab(existing); return; }
  tabs.push({ type: 'mindmap', name: 'Graph', path: null, isDirty: false });
  await switchTab(tabs.length - 1);
}

async function closeMindmap() {
  stopMindmapPhysics();          // never keep a rAF loop alive behind a hidden overlay
  const idx = tabs.findIndex(t => t.type === 'mindmap');
  if (idx !== -1) {
    const back = _mmReturnPath;
    await closeTab(idx);
    // Back to the note the graph was opened from, if it is still open.
    if (back) {
      const i = tabs.findIndex(t => t.path === back && !t.type);
      if (i !== -1 && i !== activeTabIdx) await switchTab(i);
    }
    return;
  }
  $('mindmap-overlay').style.display = 'none';
  $('btn-mindmap').classList.remove('active');
  $('mindmap-tooltip').style.display = 'none';
}

function resizeMindmapCanvas() {
  const canvas = $('mindmap-canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = canvas.offsetWidth  * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  canvas._dpr = dpr;
}

// A cheap signature of the tree STRUCTURE (every folder/note/attachment path).
// Changes on move / rename / add / delete — but NOT on a pure reorder or a
// sidebar folder expand (same path set) — so the live refresh below only rebuilds
// the graph when something that actually affects it changed.
let _mmSig = '';
let _mmRefreshTimer = null;
function _mmSignature() {
  const paths = [];
  const walk = (nodes) => { if (!nodes) return; for (const n of nodes) { paths.push(n.path); if (n.children) walk(n.children); } };
  try { walk(state.notes); } catch (_) {}
  return paths.sort().join('|');
}
// Live-refresh the mindmap when it's ON SCREEN and the tree structure changed
// (a note/PDF moved, renamed, added or removed — including external vault edits).
// Keeps the current zoom/pan so the view doesn't jump. Debounced.
function refreshMindmapIfActive() {
  const ov = document.getElementById('mindmap-overlay');
  if (!ov || ov.style.display === 'none') return;      // graph not visible → nothing to do
  const sig = _mmSignature();
  if (sig === _mmSig) return;                          // structure unchanged
  _mmSig = sig;
  if (_mmRefreshTimer) clearTimeout(_mmRefreshTimer);
  _mmRefreshTimer = setTimeout(() => {
    // Nodes that survive keep their coordinates, so the graph absorbs the change
    // with a short settling animation instead of jumping to a new arrangement.
    buildMindmapData().then(() => { try { kickMindmap(0.4); drawMindmap(); } catch (_) {} }).catch(() => {});
  }, 250);
}

// Read the vault ONCE into an un-filtered model. The Filters panel then derives
// the actual graph from it (rebuildMindmapGraph), so ticking a checkbox never
// re-reads a file — it just re-projects what we already parsed.
async function buildMindmapData() {
  const folders = [], files = [], wikiLinks = [], attachLinks = [];

  // Every folder (nested included) is available as a node; whether it ends up in
  // the graph is up to the "Folders as nodes" filter.
  const walkFolders = (nodes, parentPath) => {
    for (const n of nodes) {
      if (n.type !== 'folder') continue;
      const colorKey = noteColors[n.path];
      const color = colorKey ? NOTE_COLORS.find(c => c.key === colorKey)?.hex : null;
      folders.push({ path: n.path, label: n.name, type: 'folder', color: color || null,
        tags: [], modified: null, _folder: parentPath });
      if (n.children) walkFolders(n.children, n.path);
    }
  };
  walkFolders(state.notes, null);

  const allNotes = flattenTree(state.notes);
  const wikiRe  = /\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g;
  const attMdRe = /!?\[[^\]\n]*\]\((attachments\/[^)\s]+)\)/g;   // ![](attachments/…) / [x](attachments/…)
  for (const n of allNotes) {
    const isAttach = isAttachNode(n);
    const colorKey = noteColors[n.path];
    const color = colorKey ? NOTE_COLORS.find(c => c.key === colorKey)?.hex : null;
    const _folder = n.path.includes('/') ? n.path.split('/').slice(0, -1).join('/') : null;

    if (isAttach) {
      // Binary — never read as text. Keeps its real type + attachmentName so a
      // click opens it through the right loader (a PDF under attachments/pdf/
      // needs the 'pdf/…' attachmentName, not just the basename).
      files.push({ path: n.path, label: n.name, type: n.type, attachmentName: n.attachmentName,
        isAttach: true, tags: [], color, modified: n.modified, _folder });
      continue;
    }

    let tags = [];
    const tab = getTab(n.path);
    // Lazy tab restore: an OPEN tab may not have loaded its content yet (empty
    // sentinel) — read the file so the graph isn't missing its links/tags.
    const content = (tab && tab.content) ? tab.content : (await window.inkwell.readNote(n.path).catch(() => ''));
    const { fm } = parseFrontmatter(content);
    if (fm.tags) tags = fm.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    files.push({ path: n.path, label: n.name, type: 'note', tags, color, modified: n.modified, _folder });

    // `[[target]]`: a note→note link, or — when it doesn't resolve to a note —
    // possibly an attachment embed like `![[file.pdf]]`, resolved later.
    wikiRe.lastIndex = 0;
    let m;
    while ((m = wikiRe.exec(content)) !== null) {
      const target = m[1].trim();
      const resolved = resolveNoteLink(target);
      if (resolved && resolved.path !== n.path) wikiLinks.push({ from: n.path, to: resolved.path });
      else attachLinks.push({ from: n.path, target });
    }
    // Markdown embeds/links into attachments/ (the Amelie/Obsidian-import form).
    attMdRe.lastIndex = 0;
    let am;
    while ((am = attMdRe.exec(content)) !== null) {
      let ap = am[1].trim(); try { ap = decodeURIComponent(ap); } catch (_) {}
      attachLinks.push({ from: n.path, target: ap });
    }
  }

  mmRaw = { folders, files, wikiLinks, attachLinks };
  mmWikiLinks = wikiLinks;      // kept for the edge-removal helpers
  mmAttachLinks = attachLinks;

  rebuildMindmapGraph();
  _mmSig = _mmSignature();      // baseline for the live-refresh diff
}

// Project `mmRaw` through the Filters into the drawable graph (mmNodes/mmEdges).
// Nodes that were already on screen KEEP their coordinates, so flipping a filter
// morphs the graph instead of reshuffling it.
function rebuildMindmapGraph() {
  if (!mmRaw) { mmNodes = []; mmEdges = []; return; }
  const prev = new Map();
  for (const n of mmNodes) prev.set(n.path, n);

  const q = (mmSet.fSearch || '').trim().toLowerCase();
  const matches = (src) => !q
    || (src.label || '').toLowerCase().includes(q)
    || (src.path  || '').toLowerCase().includes(q)
    || (src.tags || []).some(t => t.includes(q));

  // ── Nodes ────────────────────────────────────────────────────────────────
  let nodes = [];
  const add = (src) => {
    const old = prev.get(src.path);
    const n = Object.assign({}, src, { _conns: 0, vx: 0, vy: 0 });
    if (old) { n.x = old.x; n.y = old.y; }
    nodes.push(n);
  };
  if (mmSet.fFolders) for (const f of mmRaw.folders) { if (matches(f)) add(f); }
  for (const f of mmRaw.files) {
    if (f.isAttach && !mmSet.fAttach) continue;
    if (!matches(f)) continue;
    add(f);
  }

  const byPath = new Map();
  nodes.forEach((n, i) => byPath.set(n.path, i));

  // ── Edges ────────────────────────────────────────────────────────────────
  let edges = [];
  const seen = new Set();
  const addEdge = (a, b, edgeType, extra) => {
    if (a == null || b == null || a === b) return;
    const key = Math.min(a, b) + '-' + Math.max(a, b);
    if (seen.has(key)) return;                 // one line per pair, whatever its kind
    seen.add(key);
    edges.push(Object.assign({ from: a, to: b, edgeType }, extra || {}));
  };

  // Wiki links — the Obsidian graph's only native edge type, and the only thing
  // shift+drag creates (it writes `[[…]]` into the note).
  for (const wl of mmRaw.wikiLinks) addEdge(byPath.get(wl.from), byPath.get(wl.to), 'wiki');

  // Embedded/linked attachments sit next to the note that references them.
  if (mmSet.fAttach && mmRaw.attachLinks.length) {
    const attachByPath = {}, attachByName = {};
    nodes.forEach((nd, i) => {
      if (!nd.isAttach) return;
      attachByPath[nd.path.toLowerCase()] = i;
      const base = nd.path.split('/').pop().toLowerCase();
      attachByName[base] = i;
      const lbl = (nd.label || '').toLowerCase();
      if (lbl && lbl !== base) attachByName[lbl] = i;
    });
    for (const al of mmRaw.attachLinks) {
      const fi = byPath.get(al.from);
      if (fi == null) continue;
      const t = String(al.target || '').toLowerCase();
      let ai = attachByPath[t];
      if (ai == null) {
        const base = t.split('/').pop();
        ai = attachByName[base];
        if (ai == null && !/\.[a-z0-9]+$/.test(base)) ai = attachByName[base + '.pdf'];   // wiki ref without extension
      }
      addEdge(fi, ai, 'attach');
    }
  }

  // Amelie extra: folder → child (note and sub-folder) containment edges.
  if (mmSet.fFolders) {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n._folder == null || n.isAttach) continue;
      addEdge(byPath.get(n._folder), i, 'folder');
    }
  }

  // Amelie extra: notes that share a frontmatter tag.
  if (mmSet.fTags) {
    const byTag = new Map();
    nodes.forEach((n, i) => {
      if (n.type !== 'note') return;
      for (const t of (n.tags || [])) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(i);
      }
    });
    for (const [tag, idxs] of byTag) {
      if (idxs.length < 2 || idxs.length > 60) continue;   // a tag on 60+ notes is noise, not structure
      for (let a = 0; a < idxs.length; a++)
        for (let b = a + 1; b < idxs.length; b++)
          addEdge(idxs[a], idxs[b], 'tag', { tags: [tag] });
    }
  }

  // ── Degrees, then the orphan filter ──────────────────────────────────────
  for (const e of edges) { nodes[e.from]._conns++; nodes[e.to]._conns++; }

  if (!mmSet.fOrphans) {
    const keep = nodes.map(n => n._conns > 0);
    const remap = new Array(nodes.length).fill(-1);
    const kept = [];
    nodes.forEach((n, i) => { if (keep[i]) { remap[i] = kept.length; kept.push(n); } });
    // Every edge touches two non-orphans by construction, so none is lost here.
    edges = edges.filter(e => remap[e.from] >= 0 && remap[e.to] >= 0)
                 .map(e => Object.assign({}, e, { from: remap[e.from], to: remap[e.to] }));
    nodes = kept;
  }

  // Same-named notes (a vault full of `README.md` is the usual case) are
  // indistinguishable as bare dots — you can't tell which one you just linked.
  // Suffix the parent folder on the DISPLAY label only; `label` stays the real
  // note name, because that's what gets written inside `[[…]]`.
  const nameCount = new Map();
  for (const n of nodes) nameCount.set(n.label, (nameCount.get(n.label) || 0) + 1);
  for (const n of nodes) {
    const parent = n._folder ? n._folder.split('/').pop() : null;
    n.displayLabel = (nameCount.get(n.label) > 1 && parent) ? `${n.label} — ${parent}` : n.label;
  }

  mmNodes = nodes;
  mmEdges = edges;
  mmSeedMissingPositions();
  if (mmHover && !mmNodes.includes(mmHover)) mmHover = null;
  if (mmDraggingNode && !mmNodes.includes(mmDraggingNode)) mmDraggingNode = null;
}

// Nodes that just entered the graph have no coordinates yet — drop them on a
// small ring around the viewport centre and let the simulation place them.
function mmSeedMissingPositions() {
  const canvas = $('mindmap-canvas');
  if (!canvas) return;
  const dpr = canvas._dpr || 1;
  const cx = ((canvas.width  / dpr) / 2 - mmOffset.x) / mmScale;
  const cy = ((canvas.height / dpr) / 2 - mmOffset.y) / mmScale;
  let k = 0;
  for (const n of mmNodes) {
    if (typeof n.x === 'number' && typeof n.y === 'number' && isFinite(n.x) && isFinite(n.y)) continue;
    const a = (k * 2.399963) ;                       // golden angle → no clumping
    const r = mmSet.fDist * (0.6 + 0.35 * Math.sqrt(k));
    n.x = cx + r * Math.cos(a);
    n.y = cy + r * Math.sin(a);
    k++;
  }
}

// Older call sites (shift+drag connect, edge removal) still say "edges".
function rebuildMindmapEdges() { rebuildMindmapGraph(); }

// Are these two notes linked, in either direction?
function mmLinkBetween(pathA, pathB) {
  if (!mmRaw) return null;
  return mmRaw.wikiLinks.find(w => (w.from === pathA && w.to === pathB) ||
                                   (w.from === pathB && w.to === pathA)) || null;
}

function mmForgetLink(pathA, pathB) {
  if (!mmRaw) return;
  mmRaw.wikiLinks = mmRaw.wikiLinks.filter(w => !((w.from === pathA && w.to === pathB) ||
                                                  (w.from === pathB && w.to === pathA)));
  mmWikiLinks = mmRaw.wikiLinks;
}

// How to spell a link to `node` inside markdown. A bare `[[README]]` is a lie
// when the vault holds seven of them — it always resolves to the first one — so
// an ambiguous name is written as a path, with the short name as the alias:
// `[[Web Applications/Web Attacks/README|README]]`.
function mmLinkTargetFor(node) {
  const name = node.label || '';
  let twins = 0;
  try {
    for (const n of flattenTree(state.notes)) {
      if ((n.name || '').toLowerCase() === name.toLowerCase() && ++twins > 1) break;
    }
  } catch (_) {}
  if (twins <= 1) return { target: name, alias: null };
  return { target: node.path.replace(/\.(md|markdown|txt)$/i, ''), alias: name };
}

// Shift+drag between two nodes: write `[[link]]` into the source note, or remove
// it if the pair is already linked. The graph then re-derives the edge from the
// note content, so what you see always matches what's on disk.
async function toggleMindmapLink(fromNode, toNode) {
  if (!fromNode || !toNode || fromNode === toNode) return;
  const fromPath = fromNode.path, toPath = toNode.path;
  try {
    if (mmLinkBetween(fromPath, toPath)) {
      // The `[[…]]` can be in either note and in either spelling — clear them all.
      for (const [path, other] of [[fromPath, toNode], [toPath, fromNode]]) {
        const { target } = mmLinkTargetFor(other);
        await removeWikiLinkFromNote(path, other.label).catch(() => {});
        if (target !== other.label) await removeWikiLinkFromNote(path, target).catch(() => {});
      }
      mmForgetLink(fromPath, toPath);
    } else {
      const { target, alias } = mmLinkTargetFor(toNode);
      await addWikiLinkToNote(fromPath, target, alias);
      if (mmRaw) { mmRaw.wikiLinks.push({ from: fromPath, to: toPath }); mmWikiLinks = mmRaw.wikiLinks; }
    }
  } catch (err) {
    console.error('[graph] link toggle failed', err);
  }
  rebuildMindmapGraph();
  kickMindmap(0.3);
  drawMindmap();
}

// ── Editing a note the graph is pointing at, not the one on screen ──────────
// The graph writes links into notes while the GRAPH is the active tab, so these
// two helpers exist to keep every copy of that note's text in step. Skipping
// them is silent data loss: switchTab flushes CodeMirror's live buffer back into
// tab.content, so a stale buffer quietly reverts whatever we wrote to disk.

// The freshest text for a note, without touching the disk. CM's buffer wins when
// it holds the note (tab.content lags it by up to 300ms), then the tab, then
// null so the caller reads the file.
function readNoteBufferSync(sourcePath) {
  if (_cmActive && _cmHandle && _cmLoadedPath === sourcePath) {
    try { const live = editor.value; if (live && live.length) return live; } catch (_) {}
  }
  const tab = getTab(sourcePath);
  if (tab && tab.content) return tab.content;
  return null;
}

// Push text we just wrote to disk into the tab AND into CM if it's holding that
// note — even when the note isn't the visible tab.
function applyExternalNoteEdit(sourcePath, content) {
  const tab = getTab(sourcePath);
  if (tab) tab.content = content;
  const cmHasIt = _cmActive && _cmHandle && _cmLoadedPath === sourcePath;
  const isActive = getActiveTab()?.path === sourcePath;
  if (!cmHasIt && !isActive) return;
  _cmSuppressChange = true;
  try {
    editor.value = content;
    if (!_cmActive) { try { editor.dispatchEvent(new Event('input')); } catch (_) {} }
  } catch (_) {
  } finally {
    _cmSuppressChange = false;
  }
  // Everything is in sync with the file now, so the note is NOT dirty.
  if (tab) tab.isDirty = false;
  if (isActive) { try { setSavedState(true); } catch (_) {} }
}

// Work out where "under the title" is and splice the link in there:
//   1. skip the managed frontmatter block,
//   2. skip the leading blank lines,
//   3. skip the title itself (`# Heading`, or a `====` underlined one),
//   4. if links are already sitting there, append to that SAME line separated by
//      a comma — `[[uno]], [[due]], [[tre]]` — instead of stacking new lines.
// A note with no title at all gets the link at the very top of its body.
function insertWikiLinkAfterTitle(content, markup) {
  if (!content.trim()) return `${markup}\n`;   // empty note: the link IS the note
  const lines = content.split('\n');
  // A "link line" holds nothing but wiki links and their separators, so both
  // `[[a]] [[b]]` (older notes) and `[[a]], [[b]]` (what we write now) count.
  const isLinkLine = (s) => /\[\[[^\]\n]+\]\]/.test(s)
    && s.replace(/\[\[[^\]\n]+\]\]/g, '').replace(/,/g, '').trim() === '';
  let i = 0;

  if (lines[0] !== undefined && lines[0].trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j < lines.length) i = j + 1;             // first line after the closing ---
  }
  while (i < lines.length && lines[i].trim() === '') i++;

  if (i < lines.length && /^#{1,6}\s/.test(lines[i])) {
    i++;                                          // ATX title
  } else if (i + 1 < lines.length && lines[i].trim() !== '' && /^=+\s*$/.test(lines[i + 1])) {
    i += 2;                                       // setext title (only `===`, `---` is too ambiguous)
  }

  // Already links right below the title? Extend that line instead of adding one.
  let k = i;
  while (k < lines.length && lines[k].trim() === '') k++;
  if (k < lines.length && isLinkLine(lines[k])) {
    let last = k;
    while (last + 1 < lines.length && isLinkLine(lines[last + 1])) last++;   // legacy multi-line block
    const cur = lines[last].replace(/[\s,]+$/, '');
    lines[last] = `${cur}, ${markup}`;
    let joined = lines.join('\n');
    if (!joined.endsWith('\n')) joined += '\n';
    return joined;
  }

  const ins = [];
  if (i > 0 && lines[i - 1] !== undefined && lines[i - 1].trim() !== '') ins.push('');
  ins.push(markup);
  if (i < lines.length && lines[i].trim() !== '') ins.push('');
  lines.splice(i, 0, ...ins);

  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

// Insert `[[targetName]]` near the TOP of the source note — right under the
// title, not appended at the bottom where you'd never see it. Idempotent, and
// it updates the open tab too. Used by the mindmap shift+drag-connect.
async function addWikiLinkToNote(sourcePath, targetName, alias) {
  if (!sourcePath || !targetName) return;
  const markup = alias ? `[[${targetName}|${alias}]]` : `[[${targetName}]]`;
  // Lazy tab restore: an OPEN-but-unloaded tab has an empty `content` sentinel.
  // Reading THAT (instead of the file) would put the link in "" and then
  // writeNote would WIPE the note on disk — so fall back to the file when empty.
  let content = readNoteBufferSync(sourcePath);
  if (content == null) content = await window.inkwell.readNote(sourcePath).catch(() => '');
  if (content == null) content = '';
  // Already linked? Match with or without an alias (`[[a]]` and `[[a|b]]`).
  const escT = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\[\\[${escT}(?:\\|[^\\]\\n]*)?\\]\\]`).test(content)) return;
  content = insertWikiLinkAfterTitle(content, markup);
  await window.inkwell.writeNote(sourcePath, content);
  applyExternalNoteEdit(sourcePath, content);
}

// Strip every `[[targetName]]` from the source note's content.
async function removeWikiLinkFromNote(sourcePath, targetName) {
  if (!sourcePath || !targetName) return;
  // Lazy tab restore: fall back to the file when the open tab hasn't loaded yet
  // (empty sentinel) so we edit the real content, not an empty string.
  let content = readNoteBufferSync(sourcePath);
  if (content == null) content = await window.inkwell.readNote(sourcePath).catch(() => '');
  if (!content) return;
  const esc = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Links written by the graph share one comma-separated line, so the separator
  // has to go with the link — otherwise removing the middle of
  // `[[a]], [[b]], [[c]]` would leave `[[a]], , [[c]]`. Take the comma BEFORE the
  // link when there is one, otherwise the comma after it.
  const L = `\\[\\[${esc}(?:\\|[^\\]\\n]*)?\\]\\]`;   // the link, with or without an |alias
  let next = content
    .replace(new RegExp(`[ \\t]*,[ \\t]*${L}`, 'g'), '')
    .replace(new RegExp(`${L}[ \\t]*,[ \\t]*`, 'g'), '');
  // Whatever is left stands alone. Swallow the surrounding blanks: on its own
  // line that means the line goes too (no leftover empty line), and inline in a
  // sentence the two spaces around it collapse back into one.
  next = next
    .replace(new RegExp(`(\\n?)[ \\t]*${L}[ \\t]*(\\n?)`, 'g'), (_m, a, b) => (a || b) ? '\n' : ' ')
    .replace(/\n{3,}/g, '\n\n');
  if (next === content) return;
  await window.inkwell.writeNote(sourcePath, next);
  applyExternalNoteEdit(sourcePath, next);
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy;
  if (len2 < 1e-3) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t*dx), py - (ay + t*dy));
}

// Find the nearest user-editable mindmap edge within `threshold` of (mx,my)
// in world coords. Only `custom` and `wiki` edges are considered removable.
function findMindmapEdgeAt(mx, my, threshold) {
  let best = null;
  let bestDist = threshold;
  for (let i = 0; i < mmEdges.length; i++) {
    const e = mmEdges[i];
    if (e.edgeType !== 'wiki') continue;   // folder/tag/attachment edges aren't user-editable
    const a = mmNodes[e.from], b = mmNodes[e.to];
    if (!a || !b) continue;
    const d = pointToSegmentDist(mx, my, a.x, a.y, b.x, b.y);
    if (d < bestDist) { bestDist = d; best = { edge: e, idx: i }; }
  }
  return best;
}

async function removeMindmapEdge(edge) {
  if (!edge) return;
  const fromNode = mmNodes[edge.from];
  const toNode   = mmNodes[edge.to];
  if (!fromNode || !toNode) return;

  if (edge.edgeType === 'wiki') {
    // The `[[…]]` can be in either note (the edge is drawn undirected), so try
    // both sides — removing a link that isn't there is a no-op.
    await removeWikiLinkFromNote(fromNode.path, toNode.label).catch(() => {});
    await removeWikiLinkFromNote(toNode.path, fromNode.label).catch(() => {});
    mmForgetLink(fromNode.path, toNode.path);
  }
  rebuildMindmapEdges();
  kickMindmap(0.3);
  drawMindmap();
}

function showMindmapEdgeContextMenu(clientX, clientY, edge) {
  document.querySelectorAll('.mm-edge-ctx-menu').forEach(el => el.remove());
  const menu = document.createElement('div');
  menu.className = 'mm-edge-ctx-menu';
  Object.assign(menu.style, {
    position: 'fixed', left: clientX + 'px', top: clientY + 'px', zIndex: 9999,
    background: 'var(--bg-3)', border: '1px solid var(--border-light)',
    borderRadius: '6px', padding: '4px 0', minWidth: '170px',
    boxShadow: '0 6px 18px rgba(0,0,0,.5)',
    fontFamily: 'var(--ui-font)', fontSize: '12px', color: 'var(--text-1)',
  });
  const item = document.createElement('div');
  item.textContent = window.i18n.t('toolbar.remove_link');
  Object.assign(item.style, { padding: '8px 14px', cursor: 'pointer' });
  item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-4)'; });
  item.addEventListener('mouseleave', () => { item.style.background = ''; });
  item.addEventListener('click', async () => {
    menu.remove();
    await removeMindmapEdge(edge);
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = (ev) => {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
    };
    document.addEventListener('mousedown', close);
  }, 0);
}

// Drag-to-resize for YouTube embeds — bottom-right handle, aspect-ratio
// keeps the height in sync automatically.
// Resolve a wiki-link target like `[[vista 2]]` to a note node in state.notes.
// Tries (in order): exact name, exact filename (basename minus extension),
// space/dash/underscore-normalized name, alphanumeric-only match. The last
// one means `[[vista2]]` finds "vista 2.md" / "vista-2.md" / "vista_2.md".
function resolveNoteLink(rawTarget) {
  if (!rawTarget) return null;
  const target = rawTarget.trim();
  if (!target) return null;

  const stripExt = (s) => s.replace(/\.(md|markdown|txt)$/i, '');
  const basename = (p) => stripExt((p || '').split('/').pop() || '');
  const normSpace = (s) => s.toLowerCase().replace(/[-_\s]+/g, ' ').trim();
  const normAlpha = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const tLower = target.toLowerCase();
  const tSpace = normSpace(target);
  const tAlpha = normAlpha(target);

  const all = flattenTree(state.notes);
  // 0) PATH-qualified target (`Folder/README`). Written when several notes share
  // a name, so the link can't silently resolve to the wrong one. Full path first,
  // then a trailing-path match so a partial prefix still works.
  if (target.includes('/')) {
    const tPath = stripExt(target).toLowerCase().replace(/^\.?\//, '');
    let byPath = all.find(n => stripExt(n.path).toLowerCase() === tPath);
    if (byPath) return byPath;
    byPath = all.find(n => stripExt(n.path).toLowerCase().endsWith('/' + tPath));
    if (byPath) return byPath;
  }
  // 1) exact name (case-insensitive)
  let hit = all.find(n => (n.name || '').toLowerCase() === tLower);
  if (hit) return hit;
  // 2) exact basename match
  hit = all.find(n => basename(n.path).toLowerCase() === tLower);
  if (hit) return hit;
  // 3) space/dash/underscore-normalized name OR basename
  hit = all.find(n => normSpace(n.name || '') === tSpace || normSpace(basename(n.path)) === tSpace);
  if (hit) return hit;
  // 4) alphanumeric-only (most forgiving)
  hit = all.find(n => normAlpha(n.name || '') === tAlpha || normAlpha(basename(n.path)) === tAlpha);
  if (hit) return hit;
  return null;
}

function flattenTree(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.type === 'folder') result.push(...flattenTree(n.children));
    else result.push(n);
  }
  return result;
}

// Seed the node positions and PRE-WARM the simulation headlessly, so opening the
// graph frames an already-organised layout instead of an exploding hairball. The
// caller then fits the view and reheats gently, which is the little settling
// motion you see in Obsidian when the graph appears.
function layoutMindmap() {
  const N = mmNodes.length;
  if (N === 0) return;

  const canvas = $('mindmap-canvas');
  const dpr = canvas._dpr || 1;
  const W = (canvas.width  || 1000) / dpr;
  const H = (canvas.height || 700)  / dpr;
  const cx = W / 2, cy = H / 2;

  // Phyllotaxis (golden-angle) spiral: an even, isotropic starting cloud with no
  // preferred direction — the force pass then does all the real arranging.
  const spread = mmSet.fDist * 0.75;
  for (let i = 0; i < N; i++) {
    const a = i * 2.399963229728653;
    const r = spread * Math.sqrt(i + 0.5);
    const n = mmNodes[i];
    n.x = cx + r * Math.cos(a);
    n.y = cy + r * Math.sin(a);
    n.vx = 0; n.vy = 0;
  }

  // Headless anneal. Big graphs get fewer iterations so opening never stalls the
  // UI — they just finish converging live in the rAF loop afterwards.
  const ITER = N > 900 ? 90 : N > 300 ? 160 : 260;
  const savedOffset = { x: mmOffset.x, y: mmOffset.y }, savedScale = mmScale;
  mmOffset = { x: 0, y: 0 }; mmScale = 1;      // pre-warm in plain canvas coords
  for (let i = 0; i < ITER; i++) mmSimStep(Math.max(0.03, Math.pow(0.02, i / ITER)));
  mmOffset = savedOffset; mmScale = savedScale;
  for (const n of mmNodes) { n.vx = 0; n.vy = 0; }
  mmAlpha = 0;
}

function centerMindmap() {
  const canvas = $('mindmap-canvas');
  const dpr = canvas._dpr || 1;
  if (!mmNodes.length) return;
  const xs = mmNodes.map(n=>n.x), ys = mmNodes.map(n=>n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cxN = (minX+maxX)/2, cyN = (minY+maxY)/2;
  mmOffset.x = (canvas.width/dpr)/2  - cxN;
  mmOffset.y = (canvas.height/dpr)/2 - cyN;
}

// "Reset" button (formerly "Zoom 100%", the "·" between + and −) AND the mindmap
// entry both call this: show the graph at EXACTLY 100% zoom, centred. NO
// fit-to-viewport rescale — that zoom-to-fit was the unwanted "zoom" effect on entry.
// Just centre at scale 1; the caller adds the wobble. Manual wheel/button zoom still
// works from here.
function resetMindmapView() {
  if (!mmNodes || !mmNodes.length) return;
  const canvas = $('mindmap-canvas');
  const dpr = canvas._dpr || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of mmNodes) { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; }
  mmScale = 1;                          // 100% — no fit-zoom
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  mmOffset.x = W / 2 - cx * mmScale;    // centre the graph
  mmOffset.y = H / 2 - cy * mmScale;
  drawMindmap();
}

// ENTRY view: fit the whole graph into the viewport so nothing is cut off at the
// edges — but never zoom IN past 100% (a small graph stays 1:1; a big one zooms
// OUT to fit). The Reset button keeps its 100%-centred behaviour above; only the
// initial open uses this. Extra right/bottom margin leaves room for the node
// LABELS, which extend to the right of each dot.
function fitMindmapView() {
  if (!mmNodes || !mmNodes.length) return;
  const canvas = $('mindmap-canvas');
  const dpr = canvas._dpr || 1;
  const W = canvas.width / dpr, H = canvas.height / dpr;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of mmNodes) { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; }
  // Labels are centred UNDER each dot now, so the frame needs symmetric side
  // padding plus a little extra at the bottom for the last row of text.
  const PAD = 70;
  minX -= PAD; maxX += PAD; minY -= 40; maxY += 46;
  const gw = (maxX - minX) || 1, gh = (maxY - minY) || 1;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const fit = Math.min(W / gw, H / gh);
  mmScale = Math.min(1.0, Math.max(0.2, fit));
  mmOffset.x = W / 2 - cx * mmScale;
  mmOffset.y = H / 2 - cy * mmScale;
  drawMindmap();
}

// ── Rendering (Obsidian look) ───────────────────────────────────────────────
// Flat dots, hairline links, and a centred label UNDER each node that fades in
// as you zoom past the "text fade threshold". No glow, no per-type link colours,
// no collision-avoided label placement — Obsidian just draws them all and lets
// the fade + zoom keep it readable.
const MM_BG          = '#0d0d0f';
const MM_NODE        = '#8d97a5';   // resting node fill
const MM_NODE_ORPHAN = '#4e5661';   // no links → dimmer, like Obsidian's orphans
const MM_NODE_FOLDER = '#6e8598';   // only visible with the "folders as nodes" filter on
const MM_LINK        = '#5a6472';
const MM_TEXT        = '#b9c2ce';
const MM_DIM         = 0.15;        // alpha for everything outside the hovered neighbourhood

function drawMindmap() {
  const canvas = $('mindmap-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = canvas._dpr || 1;
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = MM_BG;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.scale(dpr, dpr);          // normalize to CSS pixels
  ctx.translate(mmOffset.x, mmOffset.y);
  ctx.scale(mmScale, mmScale);

  const cs = getComputedStyle(document.documentElement);
  const clrAccent = cs.getPropertyValue('--accent').trim() || '#3d9970';

  // Visible world rectangle, with a margin, so off-screen nodes and links cost
  // nothing on a big vault.
  const vw = (W / dpr) / mmScale, vh = (H / dpr) / mmScale;
  const vx0 = -mmOffset.x / mmScale - 60, vy0 = -mmOffset.y / mmScale - 60;
  const vx1 = vx0 + vw + 120, vy1 = vy0 + vh + 120;
  const onScreen = (n) => n.x > vx0 && n.x < vx1 && n.y > vy0 && n.y < vy1;

  // Hovering (or dragging) a node focuses its immediate neighbourhood: it and
  // its direct links stay lit, everything else fades back.
  const focused = mmHover || mmDraggingNode;
  const focusIdx = focused ? mmNodes.indexOf(focused) : -1;
  const highlightIdx = new Set();
  const highlightEdges = new Set();
  if (focusIdx >= 0) {
    highlightIdx.add(focusIdx);
    mmEdges.forEach((e, i) => {
      if (e.from === focusIdx || e.to === focusIdx) {
        highlightEdges.add(i);
        highlightIdx.add(e.from); highlightIdx.add(e.to);
      }
    });
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  // Hairlines: width is in world units so they thicken naturally as you zoom in,
  // exactly like Obsidian's. Highlighted links are drawn last, on top.
  const lw = 0.9 * mmSet.linkWidth;
  const order = mmEdges.map((_, i) => i)
    .sort((i, j) => (highlightEdges.has(i) ? 1 : 0) - (highlightEdges.has(j) ? 1 : 0));

  ctx.setLineDash([]);
  ctx.lineCap = 'round';
  for (const ei of order) {
    const e = mmEdges[ei];
    const a = mmNodes[e.from], b = mmNodes[e.to];
    if (!a || !b) continue;
    if (!onScreen(a) && !onScreen(b)) continue;
    const lit = highlightEdges.has(ei);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = lit ? clrAccent : MM_LINK;
    ctx.lineWidth = lit ? lw * 1.7 : lw;
    ctx.globalAlpha = lit ? 0.95 : (focused ? MM_DIM * 0.7 : 0.42);
    ctx.stroke();

    // Optional direction arrows (Display → Arrows), pointing at the target.
    if (mmSet.arrows && (lit || !focused)) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const tip = mmNodeRadius(b) + 1.5;
      const hx = b.x - ux * tip, hy = b.y - uy * tip;
      const size = 4 + lw * 1.5;
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - ux * size + -uy * size * 0.5, hy - uy * size + ux * size * 0.5);
      ctx.lineTo(hx - ux * size - -uy * size * 0.5, hy - uy * size - ux * size * 0.5);
      ctx.closePath();
      ctx.fillStyle = lit ? clrAccent : MM_LINK;
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // ── Connection preview (shift+drag) ────────────────────────────────────────
  if (mmConnectFrom) {
    ctx.beginPath();
    ctx.moveTo(mmConnectFrom.x, mmConnectFrom.y);
    ctx.lineTo(mmMouseWorld.x, mmMouseWorld.y);
    ctx.strokeStyle = clrAccent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.7;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────
  for (let i = 0; i < mmNodes.length; i++) {
    const n = mmNodes[i];
    if (!onScreen(n)) continue;
    const isHover = focused === n;
    const lit = !focused || highlightIdx.has(i);
    const r = mmNodeRadius(n);

    ctx.globalAlpha = lit ? 1 : MM_DIM;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isHover
      ? clrAccent
      : (n.color
          || (n.type === 'folder' ? MM_NODE_FOLDER
              : n._conns ? MM_NODE : MM_NODE_ORPHAN));
    ctx.fill();

    // A thin ring marks the hovered node without the old blur/glow.
    if (isHover) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 2.5 / mmScale, 0, Math.PI * 2);
      ctx.strokeStyle = clrAccent;
      ctx.lineWidth = 1.4 / mmScale;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // ── Labels ─────────────────────────────────────────────────────────────────
  // Centred under the dot and scaled with the zoom, fading in around the "text
  // fade threshold" — that fade is what keeps a zoomed-out graph readable, so no
  // label ever has to be dropped or masked. The hovered neighbourhood is always
  // legible whatever the zoom.
  const fadeThr = mmSet.textFade;
  const zoomFade = fadeThr <= 0.01 ? 1
    : Math.max(0, Math.min(1, (mmScale / fadeThr - 1) * 1.6));
  if (zoomFade > 0.02 || focused) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `${11}px 'Roboto', system-ui, sans-serif`;
    for (let i = 0; i < mmNodes.length; i++) {
      const n = mmNodes[i];
      if (!onScreen(n)) continue;
      const isHover = focused === n;
      const near = !focused || highlightIdx.has(i);
      // Zoomed out, only the focused neighbourhood keeps its text.
      let alpha = near ? zoomFade : zoomFade * MM_DIM;
      if (isHover || (focused && near)) alpha = Math.max(alpha, 0.95);
      if (alpha < 0.03) continue;

      const full = n.displayLabel || n.label;
      const label = full.length > 30 ? full.slice(0, 29) + '…' : full;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = isHover ? '#ffffff' : (n.type === 'folder' ? '#a9bccd' : MM_TEXT);
      // Extra clearance on the hovered node so the highlight ring doesn't sit on
      // top of its own text.
      const gap = isHover ? 5 + 2.5 / mmScale : 4;
      ctx.fillText(label, n.x, n.y + mmNodeRadius(n) + gap);
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // ── Cursor ─────────────────────────────────────────────────────────────────
  if (mmConnectFrom)        canvas.style.cursor = 'crosshair';
  else if (mmDraggingNode)  canvas.style.cursor = 'grabbing';
  else if (mmDragging)      canvas.style.cursor = 'grabbing';
  else if (mmHover)         canvas.style.cursor = 'pointer';
  else                      canvas.style.cursor = 'grab';
}

function updateMindmapHover(e) {
  const found = getNodeAtEvent(e);
  if (found !== mmHover) {
    mmHover = found;
    drawMindmap();
  }
  const canvas = $('mindmap-canvas');
  canvas.style.cursor = found ? 'pointer' : (mmDragging ? 'grabbing' : 'grab');
  $('mindmap-tooltip').style.display = 'none';
}

// ─── Settings ─────────────────────────────────────────────────────────────────
// ─── Settings & Wizard ───────────────────────────────────────────────────────

const wizardState = {
  step: 1,
  totalSteps: 4,
  wgConfig: null,
  wgPeerIp: null,
  testResults: {},
};

function setupSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-backdrop').addEventListener('click', closeSettings);
  // About: check for new releases (opens in the browser).
  $('btn-check-updates')?.addEventListener('click', () => window.inkwell.openExternal('https://github.com/serekkr/amelie/releases').catch(() => {}));
  // No Save button: settings persist AUTOMATICALLY on any change. Toggles and
  // selects apply immediately (e.g. flipping the WireGuard flag on brings the
  // tunnel up via reloadConfig; off tears it down); text/number inputs are
  // debounced so we don't write the config on every keystroke.
  const settingsModal = $('settings-modal');
  if (settingsModal) {
    let _saveT = null;
    const autoSave = (immediate) => {
      if (_saveT) { clearTimeout(_saveT); _saveT = null; }
      const run = () => saveSettings().catch(err => console.error('[autosave]', err));
      if (immediate) run();
      else _saveT = setTimeout(run, 600);
    };
    // WebDAV connection fields (Backup + Sync) are NOT auto-saved while typing —
    // they're staged and persisted only by "Salva configurazione" (state._webdavSaved).
    const _WEBDAV_FIELDS = new Set(['cfg-webdav-url','cfg-webdav-user','cfg-webdav-pass','cfg-webdav-path',
      'tw-webdav-url','tw-webdav-user','tw-webdav-pass','tw-webdav-path']);
    settingsModal.addEventListener('change', (e) => {
      if (_WEBDAV_FIELDS.has(e.target.id)) return;
      if (e.target.matches('input,select,textarea')) autoSave(true);
    });
    settingsModal.addEventListener('input', (e) => {
      if (_WEBDAV_FIELDS.has(e.target.id)) return;
      if (e.target.matches('input[type="text"],input[type="number"],input[type="url"],input[type="password"],textarea')) autoSave(false);
    });
  }
  // GLOBAL backup format: two INDEPENDENT toggles — uncompressed folder snapshot
  // and/or .tar.gz archive. Both can be on (does both); BOTH can also be OFF =
  // "no backup content" (the backup engine then writes nothing). We deliberately
  // do NOT force one back on: unchecking .tar.gz must actually stick (and persist
  // across reopen) instead of springing back. Autosave (the settings 'change'
  // listener) writes each toggle; the saved `folder` flag is what makes both-off
  // survive a reload — see saveSettings()/openSettings().

  $('btn-new-note').addEventListener('click', () => createNewNote(newNoteFolder()));
  $('btn-new-folder').addEventListener('click', () => createNewFolder());

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      // Defer heavy panel rendering to the next frame so the tab highlight
      // (green strip) paints immediately. Running these synchronously here
      // blocked the repaint → the strip appeared with a delay.
      requestAnimationFrame(() => {
        if (btn.dataset.tab === 'security') openSecurityTab();
        if (btn.dataset.tab === 'shortcuts') renderShortcutsTab();
        // Theme tab: re-scan ~/.amelie/themes from disk so new files/blocks
        // appear as cards WITHOUT restarting the app.
        if (btn.dataset.tab === 'theme') reloadCustomThemes();
        // Backup ('sync') / Sync ('twoway') tabs: reset to the DEFAULT view on
        // entry — drop any open Riconfigura/expanded form so switching tabs
        // doesn't keep a half-edited wizard around.
        if (btn.dataset.tab === 'sync')   { _smbExpanded.backup = false; try { updateWgConfiguredView(); } catch (_) {} applySmbCollapse('backup'); }
        if (btn.dataset.tab === 'twoway') { _smbExpanded.sync   = false; try { updateTwowayConnView(); }   catch (_) {} applySmbCollapse('sync'); }
      });
    });
  });
  setupSecurityTab();
  setupSettingsPanelSizeMemory();
  setupColorCustomization();
  setupFolderIconStyle();

  // Sync section accordion headers
  [
    { hdr: 'ssh-vpn',    body: 'ssb-vpn',    chev: 'chevron-vpn'    },
    { hdr: 'ssh-webdav', body: 'ssb-webdav', chev: 'chevron-webdav' },
    { hdr: 'ssh-local',  body: 'ssb-local',  chev: 'chevron-local'  },
  ].forEach(({ hdr, body, chev }) => {
    const hdrEl = $(hdr);
    if (!hdrEl) return;
    hdrEl.addEventListener('click', e => {
      // Don't toggle when clicking the toggle switch itself
      if (e.target.closest('.toggle')) return;
      const bodyEl = $(body);
      const chevEl = $(chev);
      const open = bodyEl.style.display !== 'none';
      bodyEl.style.display = open ? 'none' : 'flex';
      if (chevEl) chevEl.classList.toggle('open', !open);
    });
  });

  // Backup destination chooser (pills) — show one section at a time, like Sync.
  document.querySelectorAll('#bk-transport-pills .dlp').forEach(b => b.addEventListener('click', async () => {
    const t = b.dataset.bktransport;
    state.config = state.config || {}; state.config.sync = state.config.sync || {};
    state.config.sync.backupTransport = t;
    updateBackupTransportView(t);
    try { await saveSettings(); } catch (_) {}
  }));

  // Flat layout: the WireGuard/Samba setup is now a single scrollable page with
  // no step navigation (the old Indietro/Avanti buttons and step dots were
  // removed). Saving happens on settings close (closeSettings → saveSettings).

  // Configured-view buttons: reopen the full wizard, or jump straight to the
  // final connection test.
  $('wg-reconfigure')?.addEventListener('click', () => updateWgConfiguredView(true));
  $('wg-test-quick')?.addEventListener('click', () => {
    updateWgConfiguredView(true);
    wizardGo(4);
    runConnectionTest();
  });
  // Remove: tear down + delete the NM connection and the saved .conf, clear the
  // Samba/WG sync config, then drop back to the empty setup wizard.
  // Dedicated "Remove" buttons: VPN-only (under the drop zones) and Samba-only
  // (under each Samba form), in both Backup and Sync. No confirm — remove directly.
  document.querySelectorAll('.vpn-remove-btn').forEach(b => b.addEventListener('click', () => _removeVpnOnly()));
  document.querySelectorAll('.samba-remove-btn').forEach(b => b.addEventListener('click', () => _removeSambaOnly(b.dataset.scope || 'backup')));

  $('wg-remove')?.addEventListener('click', async () => {
    // No confirm dialog — remove the VPN-with-Samba connection directly.
    const btn = $('wg-remove');
    const old = btn.textContent;
    btn.disabled = true; btn.textContent = '…';
    try {
      await window.inkwell.wg.removeConf();
      // Pull the cleared config back so wgSetupComplete()/two-way detection see
      // the removal immediately (the settings modal is still open).
      try { state.config = await window.inkwell.readConfig(); } catch (_) {}
      wizardState.wgConfig = null;   // else the next settings save re-persists it
      // BOTH flags off in the UI too (config already cleared by the removal).
      if ($('cfg-vpn-enabled'))    $('cfg-vpn-enabled').checked    = false;
      if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = false;
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
      if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
      if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
      // Reset the in-form fields.
      ['cfg-smb-ip','cfg-smb-share','cfg-smb-path','cfg-smb-user','cfg-smb-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      const wgConf = $('cfg-wg-conf'); if (wgConf) wgConf.value = '';
      // Clear the parsed WireGuard summary shown in BOTH wizards.
      _clearVpnConfigToggle('wg-parsed');
      _clearVpnConfigToggle('tw-wg-parsed');
      ['wg-iface','wg-local-ip','wg-endpoint','wg-allowed','wg-cfg-endpoint','wg-cfg-share',
       'tw-iface','tw-local-ip','tw-endpoint','tw-allowed','tw-cfg-endpoint'
      ].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
      const dl = $('wg-drop-label'); if (dl) dl.innerHTML = window.i18n.t('sync.wg_drop_label');
      const tdl = $('tw-wg-drop-label'); if (tdl) tdl.innerHTML = window.i18n.t('sync.wg_drop_label');
      _twHasSavedConf = false;
      ['tw-smb-ip','tw-smb-share','tw-smb-path','tw-smb-user','tw-smb-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      // OpenVPN side (the removal deletes the .ovpn too): clear pending content
      // and credentials, show the drop zones again in BOTH tabs.
      _ovpnContent = null;
      ['cfg-ovpn-user','cfg-ovpn-pass','tw-ovpn-user','tw-ovpn-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      [['ovpn-already','ovpn-drop-zone','ovpn-drop-label'], ['tw-ovpn-already','tw-ovpn-drop-zone','tw-ovpn-drop-label']].forEach(([al, dz, lb]) => {
        const a = $(al); if (a) a.style.display = 'none';
        const d = $(dz); if (d) d.style.display = '';
        const l = $(lb); if (l) l.innerHTML = window.i18n.t('sync.ovpn_drop_label');
      });
      setOvpnCredsVisible(true);
      setSmbPanelsVisible(true);
      resetVpnWizardUi();
      updateWgConfiguredView(true);   // forceEdit → show empty wizard
      updateTwowayConnView();         // Sync tab → now shows the inline WG+Samba setup
      updateVpnConfiguredBadge();     // badge off + re-enable both type buttons
    } catch (e) {
      alert(window.i18n.t('status.error') + ': ' + (e?.message || e));
    } finally {
      btn.disabled = false; btn.textContent = old;
    }
  });

  // "Importa un'altra" — reveal the drop zone again to replace the loaded .conf.
  $('wg-import-other')?.addEventListener('click', () => {
    const dz = $('wg-drop-zone'); if (dz) dz.style.display = '';
    const al = $('wg-already'); if (al) al.style.display = 'none';
  });
  // "Remove" links in the "config already present" notes (both wizards) → full
  // VPN removal. One connection at a time, so WireGuard and OpenVPN share the
  // same removal: NM connection + saved files + vpn/samba/twoway config.
  $('wg-already-remove')?.addEventListener('click', () => _removeWgCompletely());
  $('tw-already-remove')?.addEventListener('click', () => _removeWgCompletely());
  $('ovpn-already-remove')?.addEventListener('click', () => _removeWgCompletely());
  $('tw-ovpn-already-remove')?.addEventListener('click', () => _removeWgCompletely());

  // Importing a NEW VPN config (WireGuard or OpenVPN, from either wizard) must
  // start with the backup modes OFF: don't inherit "folder backup" / "archived
  // backup" from a previous connection — the user re-chooses them consciously.
  const resetVpnBackupModeFlags = () => {
    // The backup MODE toggles are cfg-backup-normal (dated folder snapshot) and
    // cfg-backup-archived (.tar.gz). They were previously reset via the wrong,
    // non-existent ids (cfg-vpn-folder/archive) — a no-op — so `cfg-backup-normal`
    // (checked by default) stayed ON and folder backup auto-activated when a VPN was
    // loaded. Reset the REAL toggles so a fresh VPN import leaves backup modes OFF
    // until the user turns one on explicitly.
    if ($('cfg-backup-normal'))   $('cfg-backup-normal').checked   = false;
    if ($('cfg-backup-archived')) $('cfg-backup-archived').checked = false;
    // A fresh import starts a FRESH setup: fields, old test results and
    // summaries of the previous connection must not leak into the new one.
    resetVpnWizardUi();
    // A fresh import REPLACES the connection: the backup/sync flags come off
    // (main does the same in the config) — re-enabled after testing the new
    // connection. Prevents auto-activating a credential-less VPN (OS secrets
    // dialog) and killing transfers on the old tunnel.
    if ($('cfg-vpn-enabled'))    $('cfg-vpn-enabled').checked    = false;
    if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = false;
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
    // A fresh import means reconfiguring → the Samba form must be visible.
    setSmbPanelsVisible(true);
    updateVpnModeWarn();
    updateActionNowButtons();
  };
  // "Salva configurazione" — the EXPLICIT commit: persists the tested Samba
  // connection + flags and blesses the staged VPN. Without this (or the Sync
  // tab's "Salva connessione"), closing the settings discards everything.
  // Backup Samba fields AUTO-SAVE on blur (no "Salva configurazione" button) —
  // saveSettings() serializes the cfg-smb-* fields into the config.
  function autosaveBackupSmb() {
    state._backupSmbCommitted = state._backupSmbTested || state._backupSmbCommitted;
    state._vpnStaged = false;
    const ip = $('cfg-smb-ip')?.value.trim() || '';
    const share = $('cfg-smb-share')?.value.trim() || '';
    saveSettings()
      .then(() => { if (ip && share) showToast('✓ ' + window.i18n.t('sync.smb_config_saved')); })
      .catch(() => {});
  }
  ['cfg-smb-ip', 'cfg-smb-share', 'cfg-smb-path', 'cfg-smb-user', 'cfg-smb-pass'].forEach(id =>
    $(id)?.addEventListener('blur', autosaveBackupSmb));
  // Invio nei campi Samba → committa (blur) e salva, come cliccare fuori.
  ['cfg-smb-ip', 'cfg-smb-share', 'cfg-smb-path', 'cfg-smb-user', 'cfg-smb-pass'].forEach(id =>
    $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }));
  // Server Address = 4-group IP input (auto-dot after 3 digits, clickable groups).
  initIpGroup('cfg-smb-ip');
  // The former "Salva configurazione" is now "Remove": wipe the (shared) VPN +
  // Samba params in both tabs.
  $('btn-vpn-save-config')?.addEventListener('click', () => _removeWgCompletely());

  // At least one backup mode is required to use the VPN backup flag.
  $('cfg-vpn-folder')?.addEventListener('change', updateVpnModeWarn);
  $('cfg-vpn-archive')?.addEventListener('change', updateVpnModeWarn);
  // Show/hide the "now" action buttons as the destination toggles change.
  ['cfg-local-enabled', 'cfg-vpn-enabled', 'cfg-webdav-enabled', 'cfg-twoway-enabled'].forEach(id =>
    $(id)?.addEventListener('change', updateActionNowButtons));
  $('cfg-vpn-enabled')?.addEventListener('change', e => {
    // Gate: can't enable VPN+Samba backup until the Samba connection test passed.
    if (e.target.checked && !backupSmbTested()) {
      e.target.checked = false;
      showToast('✗ ' + window.i18n.t('sync.test_first'));
      return;
    }
    if (e.target.checked && !$('cfg-backup-normal')?.checked && !$('cfg-backup-archived')?.checked) {
      e.target.checked = false;
      showToast('✗ ' + window.i18n.t('sync.vpn_need_mode'));
    }
  });
  // Backup: WebDAV and VPN-with-Samba are mutually exclusive REMOTE methods —
  // only one remote at a time. Local is independent (can stay on with either).
  // Trying to enable the second remote shows an error and reverts it.
  function backupRemoteExclusiveGuard(which) {
    const wd = $('cfg-webdav-enabled'), vp = $('cfg-vpn-enabled');
    const me = which === 'webdav' ? wd : vp;
    const other = which === 'webdav' ? vp : wd;
    if (me && me.checked && other && other.checked) {
      me.checked = false;
      showToast('✗ ' + window.i18n.t('sync.backup_one_remote'));
      try { updateActionNowButtons(); } catch (_) {}
      return true;
    }
    return false;
  }
  $('cfg-webdav-enabled')?.addEventListener('change', () => backupRemoteExclusiveGuard('webdav'));
  $('cfg-vpn-enabled')?.addEventListener('change', () => backupRemoteExclusiveGuard('vpn'));
  // Gate: can't enable WebDAV backup until the connection test passed.
  $('cfg-webdav-enabled')?.addEventListener('change', e => {
    if (e.target.checked && !backupWebdavTested()) {
      e.target.checked = false;
      showToast('✗ ' + window.i18n.t('sync.test_first'));
    }
  });
  // Editing the WebDAV fields invalidates the previous test.
  ['cfg-webdav-url', 'cfg-webdav-user', 'cfg-webdav-pass'].forEach(id =>
    $(id)?.addEventListener('input', () => { state._backupWebdavTested = false; }));
  window._resetVpnBackupModeFlags = resetVpnBackupModeFlags;

  // ── VPN type selector (WireGuard / OpenVPN — one at a time) ──
  setVpnType(localStorage.getItem('amelie-vpn-type') || 'wireguard');
  document.querySelectorAll('.vpn-type-btn').forEach(b =>
    b.addEventListener('click', () => {
      // Locked type (the OTHER VPN is configured) → explain WHY instead of
      // silently doing nothing: "Rimuovi prima la configurazione X…".
      if (b.dataset.locked) { showToast('✗ ' + window.i18n.t('sync.vpn_locked', { vpn: b.dataset.locked })); return; }
      setVpnType(b.dataset.vpn);
    }));
  // OpenVPN .ovpn import — IMMEDIATE, no test required: the .ovpn is saved and
  // imported into NetworkManager right away (left DOWN — the flag commands the
  // tunnel). Tests and backups then reuse the imported connection. Credentials
  // typed later are pushed via the field listeners below (no test needed).
  const importOvpnNow = async () => {
    if (!_ovpnContent) return;
    const imp = await window.inkwell.wg.saveOvpn({
      content: _ovpnContent,
      username: $('cfg-ovpn-user')?.value || $('tw-ovpn-user')?.value || '',
      password: _ovpnPassVal('cfg-ovpn-pass') || _ovpnPassVal('tw-ovpn-pass'),
    });
    if (!imp.ok) { showToast('✗ OpenVPN: ' + (imp.error || 'import fallito')); return; }
    _ovpnContent = null;   // next test reuses the imported connection (no flap)
    state._vpnStaged = true;   // provisional until "Salva configurazione"/"Salva connessione"
    showOvpnAlreadyRows(state._ovpnOrigin);
    updateVpnConfiguredBadge();
  };
  // Credentials typed/changed AFTER the import stick without a test. The fields
  // stay VISIBLE until a connection test succeeds (the test is what proves the
  // credentials work) — only then they disappear, back via "Importa un'altra"
  // or Remove.
  ['cfg-ovpn-user', 'cfg-ovpn-pass', 'tw-ovpn-user', 'tw-ovpn-pass'].forEach(id => {
    $(id)?.addEventListener('change', () => {
      if (_ovpnContent) return;   // not imported yet — they'll go in with the import
      // Read the PAIR the user actually edited — the twin tab may still hold
      // the OLD values (editing in Sync used to re-save the stale Backup
      // username). Then mirror onto the twin so both tabs agree.
      const isTw = id.startsWith('tw-');
      const uRaw = $(isTw ? 'tw-ovpn-user' : 'cfg-ovpn-user')?.value || '';
      const pRaw = $(isTw ? 'tw-ovpn-pass' : 'cfg-ovpn-pass')?.value || '';
      const twinU = $(isTw ? 'cfg-ovpn-user' : 'tw-ovpn-user');
      const twinP = $(isTw ? 'cfg-ovpn-pass' : 'tw-ovpn-pass');
      if (twinU) twinU.value = uRaw;
      if (twinP) twinP.value = pRaw;
      const p = pRaw === OVPN_PASS_SENTINEL ? '' : pRaw;   // sentinel = keep stored
      if (uRaw || p) {
        window.inkwell.wg.updateOvpnCreds({ username: uRaw, password: p })
          .then(r => { if (r?.ok) showToast('✓ ' + window.i18n.t('toast.ovpn_creds_saved')); })
          .catch(() => {});
      }
    });
  });
  const ovDrop = $('ovpn-drop-zone'), ovFile = $('ovpn-file-input'), ovLabel = $('ovpn-drop-label');
  const loadOvpn = (f) => { const r = new FileReader(); r.onload = () => { _ovpnContent = String(r.result || ''); if (ovLabel) ovLabel.textContent = '✓ ' + f.name; resetVpnBackupModeFlags(); state._ovpnOrigin = 'backup'; importOvpnNow(); }; r.readAsText(f); };
  ovDrop?.addEventListener('click', () => ovFile?.click());
  ovFile?.addEventListener('change', e => { if (e.target.files[0]) loadOvpn(e.target.files[0]); e.target.value = ''; });
  ovDrop?.addEventListener('dragover', e => { e.preventDefault(); ovDrop.classList.add('drag-over'); });
  ovDrop?.addEventListener('dragleave', () => ovDrop.classList.remove('drag-over'));
  ovDrop?.addEventListener('drop', e => { e.preventDefault(); ovDrop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) loadOvpn(e.dataTransfer.files[0]); });
  $('ovpn-import-other')?.addEventListener('click', () => { if (ovDrop) ovDrop.style.display = ''; const al = $('ovpn-already'); if (al) al.style.display = 'none'; setOvpnCredsVisible(true); setSmbPanelsVisible(true); });
  // "Riconfigura" — re-show the user/password fields to change the credentials
  // on the SAME imported connection (no re-import, no removal).
  const reconfigureOvpnCreds = () => { setOvpnCredsVisible(true); setSmbPanelsVisible(true); ($('cfg-ovpn-pass') || $('tw-ovpn-pass'))?.focus(); };
  $('ovpn-reconfigure')?.addEventListener('click', reconfigureOvpnCreds);
  $('tw-ovpn-reconfigure')?.addEventListener('click', reconfigureOvpnCreds);
  // OpenVPN in the SYNC wizard: same shared config (_ovpnContent), its own drop zone.
  const twOvDrop = $('tw-ovpn-drop-zone'), twOvFile = $('tw-ovpn-file-input'), twOvLabel = $('tw-ovpn-drop-label');
  const twLoadOvpn = (f) => { const r = new FileReader(); r.onload = () => { _ovpnContent = String(r.result || ''); if (twOvLabel) twOvLabel.textContent = '✓ ' + f.name; resetVpnBackupModeFlags(); state._ovpnOrigin = 'sync'; importOvpnNow(); }; r.readAsText(f); };
  twOvDrop?.addEventListener('click', () => twOvFile?.click());
  twOvFile?.addEventListener('change', e => { if (e.target.files[0]) twLoadOvpn(e.target.files[0]); e.target.value = ''; });
  twOvDrop?.addEventListener('dragover', e => { e.preventDefault(); twOvDrop.classList.add('drag-over'); });
  twOvDrop?.addEventListener('dragleave', () => twOvDrop.classList.remove('drag-over'));
  twOvDrop?.addEventListener('drop', e => { e.preventDefault(); twOvDrop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) twLoadOvpn(e.dataTransfer.files[0]); });
  $('tw-ovpn-import-other')?.addEventListener('click', () => { if (twOvDrop) twOvDrop.style.display = ''; const al = $('tw-ovpn-already'); if (al) al.style.display = 'none'; setOvpnCredsVisible(true); setSmbPanelsVisible(true); });

  // Step 1: WireGuard file import — calls real IPC to save .conf
  const dropZone = $('wg-drop-zone');
  const fileInput = $('wg-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) loadWgFile(e.target.files[0]); e.target.value = ''; });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) loadWgFile(e.dataTransfer.files[0]);
  });

  // The "Drag or select…" import instruction is only useful while no config is
  // loaded yet. Mirror each import desc to its drop-zone's visibility so it
  // disappears once a VPN is already imported (WG + OpenVPN, Backup + Sync).
  ['wg-drop-zone', 'ovpn-drop-zone', 'tw-wg-drop-zone', 'tw-ovpn-drop-zone'].forEach(dzId => {
    const dz = $(dzId);
    if (!dz || !dz.parentElement) return;
    const desc = dz.parentElement.querySelector('.wstep-desc');
    if (!desc) return;
    const sync = () => { desc.style.display = getComputedStyle(dz).display === 'none' ? 'none' : ''; };
    new MutationObserver(sync).observe(dz, { attributes: true, attributeFilter: ['style'] });
    sync();
  });

  // Eye toggle to reveal the Samba password in clear (Backup + Sync tabs), plus
  // the WebDAV password / app-token.
  [['cfg-smb-pass', 'cfg-smb-pass-eye'], ['tw-smb-pass', 'tw-smb-pass-eye'],
   ['cfg-webdav-pass', 'cfg-webdav-pass-eye'], ['tw-webdav-pass', 'tw-webdav-pass-eye']].forEach(([i, e]) =>
    wirePasswordSecEye($(i), $(e)));

  // Sync transport chooser (WireGuard+Samba ↔ WebDAV) + WebDAV test.
  document.querySelectorAll('#tw-transport-pills .dlp').forEach(b => b.addEventListener('click', async () => {
    document.querySelectorAll('#tw-transport-pills .dlp').forEach(x => x.classList.toggle('active', x === b));
    state.config = state.config || {}; state.config.sync = state.config.sync || {}; state.config.sync.twoway = state.config.sync.twoway || {};
    state.config.sync.twoway.transport = b.dataset.transport;
    try { await saveSettings(); } catch (_) {}
    try { await updateTwowayConnView(); } catch (_) {}
    try { updateSyncButtonVisibility(); } catch (_) {}
  }));
  $('tw-webdav-test')?.addEventListener('click', async () => {
    const res = $('tw-webdav-result');
    if (res) { res.style.display = 'block'; res.textContent = window.i18n.t('status.testing'); res.className = 'test-result'; }
    const result = await window.inkwell.testWebdav({ url: $('tw-webdav-url').value, username: $('tw-webdav-user').value, password: $('tw-webdav-pass').value });
    if (result && result.ok) { state._twWebdavTested = true; if (res) { res.textContent = '✓ ' + window.i18n.t('sync.connection_ok'); res.className = 'test-result ok'; } }
    else { state._twWebdavTested = false; if (res) { res.textContent = '✗ ' + ((result && result.error) || window.i18n.t('status.error')); res.className = 'test-result fail'; } }
  });
  // Editing the Sync WebDAV fields invalidates the previous test.
  ['tw-webdav-url', 'tw-webdav-user', 'tw-webdav-pass'].forEach(id =>
    $(id)?.addEventListener('input', () => { state._twWebdavTested = false; }));

  // "Salva configurazione" for WebDAV (backup + sync) — the EXPLICIT commit, like
  // the VPN+Samba button: the URL/user/password/folder fields are STAGED (not
  // auto-saved while typing) and only persisted when this is clicked.
  // WebDAV fields AUTO-SAVE on blur (no more "Salva configurazione" button) —
  // persist to state._webdavSaved.{sync,backup} (what saveSettings reads).
  function autosaveWebdav(scope) {
    state._webdavSaved = state._webdavSaved || { backup: {}, sync: {} };
    const pfx = scope === 'sync' ? 'tw-webdav-' : 'cfg-webdav-';
    state._webdavSaved[scope] = {
      url: $(pfx + 'url')?.value.trim() || '',
      username: $(pfx + 'user')?.value || '',
      password: $(pfx + 'pass')?.value || '',
      remotePath: $(pfx + 'path')?.value.trim() || (scope === 'sync' ? 'amelie/sync' : '/amelie/backup'),
    };
    saveSettings().catch(() => {});
  }
  [['sync', 'tw-webdav-'], ['backup', 'cfg-webdav-']].forEach(([scope, pfx]) => {
    ['url', 'user', 'pass', 'path'].forEach(s => $(pfx + s)?.addEventListener('blur', () => autosaveWebdav(scope)));
  });
  // The former "Salva configurazione" buttons are now "Remove": reset this
  // method's config (clear fields + persisted params + disable its toggle).
  $('tw-webdav-save')?.addEventListener('click', () => _removeWebdav('sync'));
  $('btn-webdav-save')?.addEventListener('click', () => _removeWebdav('backup'));

  // Restore saved .conf info on settings open
  window.inkwell.wg.getConf().then(({ exists, parsed, ovpnExists, ovpnMeta }) => {
    if (exists && parsed) showWgParsed(parsed);
    // OpenVPN config already saved (there's only ONE, shared Backup/Sync): show
    // "already loaded — will be reused" and hide the drop zones in BOTH tabs.
    if (ovpnExists) {
      showOvpnAlreadyRows();
      // Saved credentials: show the username and a *** sentinel for the stored
      // password (the real password lives only in NetworkManager — the sentinel
      // means "keep the saved one" and is never sent as a literal value).
      if (ovpnMeta) {
        ['cfg-ovpn-user', 'tw-ovpn-user'].forEach(id => { const el = $(id); if (el) el.value = ovpnMeta.username || ''; });
        ['cfg-ovpn-pass', 'tw-ovpn-pass'].forEach(id => { const el = $(id); if (el) el.value = ovpnMeta.hasPassword ? OVPN_PASS_SENTINEL : ''; });
      }
    }
    refreshVpnWizardVisibility();
    updateVpnConfiguredBadge();
  });

  // Step 2: REAL VPN test — brings the tunnel up via NetworkManager
  $('btn-run-wg-test')?.addEventListener('click', async () => {
    const btn = $('btn-run-wg-test');
    const resEl = $('wg-test-result');
    btn.disabled = true;
    resEl.style.display = 'none';

    // Set all dots to pending
    ['tc-wg-up','tc-wg-ping','tc-wg-latency'].forEach(id => {
      const dot = $(id)?.querySelector('.tc-dot');
      const res = $(id + '-res') || $(id.replace('tc-','') + '-res');
      if (dot) dot.className = 'tc-dot pending';
    });

    const result = await window.inkwell.wg.testTunnel($('cfg-smb-ip')?.value.trim() || null);

    // Apply step results
    if (result.steps) {
      const ids = ['tc-wg-up','tc-wg-ping','tc-wg-latency'];
      result.steps.forEach((step, i) => {
        const row = $(ids[i]);
        const dot = row?.querySelector('.tc-dot');
        const res = row?.querySelector('.tc-result');
        if (dot) dot.className = 'tc-dot ' + (step.ok ? 'ok' : 'fail');
        if (res)  res.textContent = step.ok ? ('✓ ' + (step.detail || '')) : ('✗ ' + (step.detail || window.i18n.t('status.error')));
      });
    }

    resEl.style.display = 'block';
    if (result.ok) {
      resEl.textContent = '✓ ' + window.i18n.t('sync.wg_connected');
      resEl.className = 'test-result ok';
      setTimeout(() => wizardGo(3), 1200);
    } else {
      resEl.textContent = '✗ ' + (result.error || result.steps?.find(s => !s.ok)?.detail || window.i18n.t('sync.connection_failed'));
      resEl.className = 'test-result fail';
    }
    btn.disabled = false;
  });

  // Step 3: Samba — live path preview
  const smbPreviewPath = $('smb-preview-path');
  const updateSmbPreview = () => {
    // Build the path from EXACTLY what the user typed — no auto-inserted
    // "share" segment. Empty fields are simply omitted.
    const ip    = $('cfg-smb-ip')?.value.trim()    || '';
    const share = $('cfg-smb-share')?.value.trim() || '';
    const path  = $('cfg-smb-path')?.value.trim()  || '';
    const parts = [ip, share, path].filter(Boolean);
    if (smbPreviewPath) smbPreviewPath.textContent = '//' + parts.join('/');
  };
  ['cfg-smb-ip','cfg-smb-share','cfg-smb-path'].forEach(id =>
    $(id)?.addEventListener('input', updateSmbPreview)
  );

  // Step 4: Test finale
  $('btn-run-test').addEventListener('click', runConnectionTest);

  // WebDAV test
  $('btn-test-webdav').addEventListener('click', async () => {
    const resultEl = $('webdav-test-result');
    resultEl.textContent = window.i18n.t('status.testing'); resultEl.className = 'test-result';
    try {
      const url = $('cfg-webdav-url').value;
      const user = $('cfg-webdav-user').value;
      const pass = $('cfg-webdav-pass').value;
      if (!url) { resultEl.textContent = '✗ ' + window.i18n.t('sync.enter_url'); resultEl.className = 'test-result fail'; return; }
      // Run the PROPFIND in MAIN (Node) via IPC. A renderer fetch() to an
      // external WebDAV server is blocked by the CSP (default-src 'self', no
      // connect-src) and CORS (file:// origin) → "Failed to fetch". Node has no
      // such restriction.
      const r = await window.inkwell.testWebdav({ url, username: user, password: pass });
      if (r && r.ok) {
        state._backupWebdavTested = true;   // enables the WebDAV backup toggle
        resultEl.textContent = '✓ ' + window.i18n.t('sync.connection_ok'); resultEl.className = 'test-result ok';
      } else {
        state._backupWebdavTested = false;
        resultEl.textContent = '✗ ' + ((r && r.error) || window.i18n.t('status.error')); resultEl.className = 'test-result fail';
      }
    } catch (e) { state._backupWebdavTested = false; resultEl.textContent = `✗ ${e.message}`; resultEl.className = 'test-result fail'; }
  });

  // Shared restore flow (from a .tar.gz OR a folder). `restoreFn(pass)` performs
  // the actual restore; an encrypted backup returns needsPassword → we ask for the
  // decrypt password in a modal that STAYS OPEN on a wrong try (validated inline,
  // with the Mr-Robot easter egg every 3rd fail). Current vault is kept aside.
  async function runRestoreFlow(restoreFn) {
    const res = $('restore-result');
    if (res) { res.style.display = 'block'; res.textContent = window.i18n.t('sync.restoring'); res.className = 'test-result'; }
    let r = await restoreFn(undefined);   // first pass, no password (plaintext restores directly)
    if (r && r.needsPassword) {
      let failCount = 0;
      const EGG = ['Hello, friend?', 'Control is an illusion.', 'Are you a 1 or a 0?'];
      const accepted = await showInputModal(window.i18n.t('sync.restore_ask_pass'), '', {
        password: true,
        validate: async (pass) => {
          const wrong = () => {
            failCount++;
            return (failCount % 3 === 0)
              ? { ok: false, error: EGG[(failCount / 3 - 1) % EGG.length], color: 'var(--green)' }
              : { ok: false, error: window.i18n.t('sync.restore_wrong_pass') };
          };
          if (!pass) return wrong();
          const rr = await restoreFn(pass);
          if (rr && rr.needsPassword) return wrong();
          return { ok: true, value: rr };
        },
      });
      if (accepted == null) { if (res) res.style.display = 'none'; return; }   // canceled
      r = accepted;
    }
    if (r && r.ok) {
      if (res) { res.style.display = 'block'; res.textContent = '✓ ' + window.i18n.t('sync.restore_done'); res.className = 'test-result ok'; }
    } else if (res) {
      res.style.display = 'block';
      res.textContent = '✗ ' + ((r && r.error) || window.i18n.t('status.error'));
      res.className = 'test-result fail';
    }
  }

  // ONE Restore button for both a .tar.gz file AND a backup folder: the picker
  // reports which was chosen; route to the matching restore (both encrypted-aware).
  $('btn-restore-vault')?.addEventListener('click', async () => {
    const pick = await window.inkwell.vault.pickRestore();
    if (!pick || pick.canceled) return;
    const fn = pick.isDir
      ? (pass) => window.inkwell.vault.restoreFolder(pick.path, pass)
      : (pass) => window.inkwell.vault.restoreArchive(pick.path, pass);
    await runRestoreFlow(fn);
  });

  // Browse the local folder with the native file manager
  $('btn-browse-local').addEventListener('click', async () => {
    const picked = await window.inkwell.pickFolder(window.i18n.t('sync.local_path'));
    if (picked) {
      const input = $('cfg-local-path');
      input.value = picked;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Import a folder of .md notes into the current vault (browse with the file manager)
  $('btn-import-folder')?.addEventListener('click', async () => {
    const res = $('import-result');
    const picked = await window.inkwell.pickFolder(window.i18n.t('settings.import'));
    if (!picked) return;
    $('cfg-import-path').value = picked;
    if (res) { res.textContent = window.i18n.t('settings.importing'); res.className = 'test-result'; }
    const result = await window.inkwell.vault.importFolder(picked);
    if (result && result.ok) {
      if (res) {
        res.textContent = '✓ ' + window.i18n.t('settings.import_done', { notes: result.notes, att: result.attachments, skip: result.skipped });
        res.className = 'test-result ok';
      }
      await loadTree();   // show the imported notes right away
    } else if (res) {
      res.textContent = '✗ ' + ((result && result.error) || window.i18n.t('status.error'));
      res.className = 'test-result fail';
    }
  });

  // Change the vault path by browsing with the native file manager
  $('btn-browse-vault')?.addEventListener('click', async () => {
    const res = $('vault-path-result');
    const picked = await window.inkwell.pickFolder(window.i18n.t('vault_settings.change_path'));
    if (!picked) return;
    const current = $('cfg-vault-path').value.trim();
    if (picked === current) return;
    if (res) { res.textContent = window.i18n.t('vault_settings.switching'); res.className = 'test-result'; }
    const result = await window.inkwell.vault.changePath(picked);
    if (result && result.ok) {
      $('cfg-vault-path').value = picked;
      if (res) { res.textContent = '✓ ' + window.i18n.t('vault_settings.switched'); res.className = 'test-result ok'; }
      // main reloads the renderer on the new vault
    } else if (res) {
      res.textContent = '✗ ' + ((result && result.error) || window.i18n.t('status.error'));
      res.className = 'test-result fail';
    }
  });

  // Local sync test
  $('btn-test-local').addEventListener('click', async () => {
    const resultEl = $('local-test-result');
    const p = $('cfg-local-path').value.trim();
    if (!p) { resultEl.textContent = '✗ ' + window.i18n.t('error.path_empty'); resultEl.className = 'test-result fail'; return; }
    resultEl.textContent = window.i18n.t('sync.checking_path', { path: p }); resultEl.className = 'test-result';
    const result = await window.inkwell.testLocalPath(p);
    if (result.ok) {
      resultEl.textContent = '✓ ' + window.i18n.t('sync.path_ok') + (result.created ? ' ' + window.i18n.t('sync.folder_created') : '');
      resultEl.className = 'test-result ok';
    } else {
      resultEl.textContent = `✗ ${result.error}`;
      resultEl.className = 'test-result fail';
    }
  });

  // Two-way sync: show the custom-minutes input only when "Custom" is selected.
  $('cfg-twoway-interval')?.addEventListener('change', e => {
    const w = $('twoway-custom-wrap');
    if (w) w.style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });

  // Backup frequency: show the custom-DAYS input only when "Custom" is selected.
  $('cfg-local-interval')?.addEventListener('change', e => {
    const w = $('local-interval-custom-wrap');
    if (w) w.style.display = e.target.value === 'custom' ? 'flex' : 'none';
  });

  // "Backup now": save settings first (so the latest path/mode is used), then
  // force a manual one-way backup to ALL enabled destinations. Shared by the
  // top-of-tab button and the per-section (Local) button.
  async function runManualBackup(resultElId) {
    const res = resultElId ? $(resultElId) : null;
    // Do nothing unless at least one backup FORMAT is selected (normal folder
    // and/or .tar.gz archive) — otherwise there's nothing to produce.
    if (!$('cfg-backup-normal')?.checked && !$('cfg-backup-archived')?.checked) {
      if (res) { res.style.display = ''; res.className = 'test-result fail'; res.textContent = '✗ ' + window.i18n.t('sync.no_backup_format'); }
      return;
    }
    try { await saveSettings(); } catch (_) {}
    if (res) { res.style.display = ''; res.textContent = window.i18n.t('toast.backup_running'); res.className = 'test-result'; }
    showToast(window.i18n.t('toast.backup_running'));
    const result = await window.inkwell.triggerBackup();
    if (result && result.success) {
      // Same style as the manual sync notification: "Manual backup … (18:36)" —
      // everywhere: inline result, toast AND the notifications bell.
      const when = (() => { const d = new Date(), p2 = n => String(n).padStart(2, '0'); return p2(d.getHours()) + ':' + p2(d.getMinutes()); })();
      const msgBase = window.i18n.t('toast.manual_backup_ok');
      const msg = msgBase + ' (' + when + ')';
      if (res) { res.textContent = '✓ ' + msg; res.className = 'test-result ok'; }
      showToast('✓ ' + msg);
      // Success is shown inline + as a toast; the bell is reserved for failures.
    } else if (result && result.noDestination) {
      if (res) { res.textContent = '✗ ' + window.i18n.t('toast.no_backup_dest'); res.className = 'test-result fail'; }
      showToast('✗ ' + window.i18n.t('toast.no_backup_dest'));
    } else {
      const err = (result && result.error) ? ': ' + result.error : '';
      if (res) { res.textContent = '✗ ' + window.i18n.t('toast.backup_failed') + err; res.className = 'test-result fail'; }
      // The bell entry comes from the sync:statusUpdate event (logSyncEventNotif),
      // so adding one here too would log the same failure twice.
    }
  }
  $('btn-backup-now-top')?.addEventListener('click', () => runManualBackup('backup-now-top-result'));

  // Two-way sync: browse remote folder
  $('btn-browse-twoway')?.addEventListener('click', async () => {
    const picked = await window.inkwell.pickFolder(window.i18n.t('sync.twoway_path'));
    if (picked) {
      const input = $('cfg-twoway-path');
      input.value = picked;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Two-way sync: test path
  // "Sincronizza ora": runs the real two-way sync over the WireGuard+Samba share.
  $('btn-test-twoway')?.addEventListener('click', async () => {
    const resultEl = $('twoway-test-result');
    resultEl.style.display = '';
    resultEl.textContent = window.i18n.t('toast.syncing'); resultEl.className = 'test-result';
    try { await saveSettings(); } catch (_) {}
    const result = await window.inkwell.triggerTwoway();
    if (result && result.success) {
      const r = (result.results && result.results.twoway) || {};
      resultEl.textContent = _fmtSyncResult(r);
      resultEl.className = 'test-result ok';
      // Success shows inline; the bell is reserved for failures.
      try { await loadTree(); } catch (_) {}
    } else {
      const msg = (result && result.error) ? result.error : window.i18n.t('toast.sync_failed');
      resultEl.textContent = '✗ ' + msg;
      resultEl.className = 'test-result fail';
      // Bell entry handled centrally by logSyncEventNotif.
    }
  });
  // Inline WireGuard+Samba setup directly in the Sync tab (when no connection
  // exists yet) — same backend as the Backup wizard, so it sets up the shared
  // WG+Samba connection that both backup and two-way sync reuse.
  setupTwowaySetup();

  // Toggling the two-way flag activates/deactivates the tunnel (via saveSettings
  // → reloadConfig). Re-check the tunnel status ONCE after a short delay so the
  // user sees the last-handshake update (no continuous ping).
  $('cfg-twoway-enabled')?.addEventListener('change', () => {
    setTimeout(() => { try { updateTunnelStatusInto('tw-wg-badge', 'tw-wg-state'); } catch (_) {} }, 1800);
  });

  // Two activation toggles (WebDAV / WireGuard+Samba), mutually exclusive. They
  // DRIVE the hidden master toggle + transport selector that the rest of the code
  // reads, so two-way sync still runs with a single transport.
  function applyTwowayMethodToggle(changed) {
    const w = $('cfg-tw-webdav-enabled'), s = $('cfg-tw-samba-enabled');
    if (!w || !s) return;
    const enabled = w.checked || s.checked;
    const transport = w.checked ? 'webdav' : (s.checked ? 'samba' : (state.config?.sync?.twoway?.transport || 'samba'));
    const master = $('cfg-twoway-enabled'); if (master) master.checked = enabled;
    document.querySelectorAll('#tw-transport-pills .dlp').forEach(b => b.classList.toggle('active', b.dataset.transport === transport));
    state.config = state.config || {}; state.config.sync = state.config.sync || {}; state.config.sync.twoway = state.config.sync.twoway || {};
    state.config.sync.twoway.enabled = enabled;
    state.config.sync.twoway.transport = transport;
    if (transport === 'samba') state.config.sync.twoway.useWireGuard = true;
  }
  // Reflect the saved config onto the two visible toggles (called on load and after
  // any flow that flips the master enable).
  window._refreshTwowayMethodToggles = function () {
    const tw = state.config?.sync?.twoway || {};
    const on = !!tw.enabled, tr = tw.transport || 'samba';
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = on && tr === 'webdav';
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = on && tr !== 'webdav';
  };
  ['webdav', 'samba'].forEach(which => {
    $('cfg-tw-' + which + '-enabled')?.addEventListener('change', async () => {
      const w = $('cfg-tw-webdav-enabled'), s = $('cfg-tw-samba-enabled');
      const me = which === 'webdav' ? w : s;
      const other = which === 'webdav' ? s : w;
      // You can enable only ONE method (the engine syncs with a single source).
      // Trying to turn the second one on shows an error and reverts it — instead
      // of silently switching — so the choice is explicit.
      if (me.checked && other && other.checked) {
        me.checked = false;
        const err = $('tw-method-error');
        if (err) { err.style.display = 'block'; err.textContent = window.i18n.t('sync.twoway_one_only'); }
        return;
      }
      // Gate: can't enable a two-way method until its connection test has passed.
      if (me.checked && !(which === 'webdav' ? syncWebdavTested() : syncSmbTested())) {
        me.checked = false;
        const err = $('tw-method-error');
        if (err) { err.style.display = 'block'; err.textContent = window.i18n.t('sync.test_first'); }
        return;
      }
      const err = $('tw-method-error'); if (err) err.style.display = 'none';
      applyTwowayMethodToggle(which);
      try { await saveSettings(); } catch (_) {}
      try { await updateTwowayConnView(); } catch (_) {}
      try { updateSyncButtonVisibility(); } catch (_) {}
      setTimeout(() => { try { updateTunnelStatusInto('tw-wg-badge', 'tw-wg-state'); } catch (_) {} }, 1800);
    });
  });

  // "Riconfigura" — reopen the wizard (same as Backup).
  $('tw-reconfigure')?.addEventListener('click', () => { updateTwowayConnView(true); });

  // Test button in the CONFIGURED sync view — runs ONLY the 3-step Samba test on
  // the saved connection (does not keep the tunnel up). No config change.
  $('tw-test-conn')?.addEventListener('click', async () => {
    const res = $('tw-conn-test-result');
    const conn = state.config?.sync?.twoway?.smb
      || state.config?.sync?.vpn?.smb
      || state.config?.sync?.samba || {};
    const smb = {
      ip:       conn.ip || conn.host || '',
      share:    conn.share || '',
      path:     $('cfg-twoway-subpath')?.value.trim() || conn.remoteSubPath || '',
      username: conn.username || '',
      password: conn.password || '',
    };
    const btn = $('tw-test-conn'); btn.disabled = true;
    if (res) { res.style.display = 'block'; res.className = 'test-result'; res.textContent = window.i18n.t('sync.tw_testing'); }
    try {
      const tf = await window.inkwell.wg.testSmbWrite(smb, 'sync');
      const stepsHtml = (tf.steps || []).map(s => { const d = vpnStepDetail(s); return `<div>${s.ok ? '✓' : '✗'} ${escHtml(vpnStepLabel(s))}${d ? ' — ' + escHtml(d) : ''}</div>`; }).join('');
      if (res) { res.style.display = 'block'; res.className = 'test-result ' + (tf.ok ? 'ok' : 'fail'); res.innerHTML = stepsHtml; }
      if (!tf.ok) {
        const failed = tf.steps?.find(s => !s.ok);
        const reason = failed ? (vpnStepLabel(failed) + (failed.detail ? ' — ' + vpnStepDetail(failed) : '')) : window.i18n.t('sync.test_failed');
        try { addEventNotif(window.i18n.t('sync.smbtest_title') + ': ' + reason, false); } catch (_) {}
      }
      // Refresh the tunnel status (last handshake) after the test.
      try { updateTunnelStatusInto('tw-wg-badge', 'tw-wg-state'); } catch (_) {}
    } catch (e) {
      if (res) { res.className = 'test-result fail'; res.textContent = '✗ ' + (e?.message || e); }
    } finally { btn.disabled = false; }
  });

  // Remove the two-way sync connection (and the tunnel, if backup doesn't use it).
  $('twoway-remove')?.addEventListener('click', async () => {
    // No confirm dialog — remove the VPN-with-Samba connection directly.
    const btn = $('twoway-remove'); const old = btn.textContent; btn.disabled = true; btn.textContent = '…';
    try {
      await window.inkwell.wg.removeSyncConnection();
      try { state.config = await window.inkwell.readConfig(); } catch (_) {}
      wizardState.wgConfig = null;   // else the next settings save re-persists it
      // BOTH flags off in the UI too (config already cleared by the removal) —
      // otherwise the next settings save would re-enable them.
      if ($('cfg-vpn-enabled'))    $('cfg-vpn-enabled').checked    = false;
      if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = false;
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
      if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
      if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
      ['tw-smb-ip','tw-smb-share','tw-smb-path','tw-smb-user','tw-smb-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      // Reset the WG import affordance (the .conf was fully removed).
      _twHasSavedConf = false;
      const dl = $('tw-wg-drop-label'); if (dl) dl.innerHTML = window.i18n.t('sync.wg_drop_label');
      const twres = $('tw-setup-result'); if (twres) { twres.style.display = 'none'; twres.innerHTML = ''; }
      // Clear the parsed WireGuard info (Interface / Local IP / Endpoint / …) in
      // BOTH wizards — the .conf is gone, so it must not linger on screen.
      _clearVpnConfigToggle('tw-wg-parsed');
      _clearVpnConfigToggle('wg-parsed');
      ['tw-iface','tw-local-ip','tw-endpoint','tw-allowed','tw-cfg-endpoint',
       'wg-iface','wg-local-ip','wg-endpoint','wg-allowed','wg-cfg-endpoint','wg-cfg-share'
      ].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
      const bdl = $('wg-drop-label'); if (bdl) bdl.innerHTML = window.i18n.t('sync.wg_drop_label');
      // OpenVPN side (the removal deletes the .ovpn too): clear pending content
      // and credentials, show the drop zones again in BOTH tabs.
      _ovpnContent = null;
      ['cfg-ovpn-user','cfg-ovpn-pass','tw-ovpn-user','tw-ovpn-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
      [['ovpn-already','ovpn-drop-zone','ovpn-drop-label'], ['tw-ovpn-already','tw-ovpn-drop-zone','tw-ovpn-drop-label']].forEach(([al, dz, lb]) => {
        const a = $(al); if (a) a.style.display = 'none';
        const d = $(dz); if (d) d.style.display = '';
        const l = $(lb); if (l) l.innerHTML = window.i18n.t('sync.ovpn_drop_label');
      });
      setOvpnCredsVisible(true);
      setSmbPanelsVisible(true);
      resetVpnWizardUi();
      // The backup view shares the same tunnel — refresh it too if present.
      try { await updateWgConfiguredView(true); } catch (_) {}
      await updateTwowayConnView();
      updateSyncButtonVisibility();
      updateVpnConfiguredBadge();     // badge off + re-enable both type buttons
    } catch (e) {
      alert(window.i18n.t('status.error') + ': ' + (e?.message || e));
    } finally { btn.disabled = false; btn.textContent = old; }
  });
}

// Compact WG+Samba setup embedded in the two-way Sync tab. Imports the .conf,
// then on "Configura e verifica" saves it, verifies the connection, and (on
// success) persists the connection — exactly like the Backup wizard, just
// inline. Reuses wg.saveConf / wg.testSmbWrite / wg.saveSyncConnection.
function setupTwowaySetup() {
  let twWgConf = null;
  const drop = $('tw-wg-drop-zone'), file = $('tw-wg-file-input'), label = $('tw-wg-drop-label');
  const loadFile = (f) => {
    const r = new FileReader();
    r.onload = async () => {
      twWgConf = String(r.result || '');
      if (label) label.textContent = '✓ ' + f.name;
      // Fresh VPN import → backup modes (folder/archive) start OFF.
      try { window._resetVpnBackupModeFlags?.(); } catch (_) {}
      // Save IMMEDIATELY (no test required) — same as the Backup wizard: the
      // .conf goes to disk + NetworkManager now, the test only verifies.
      try {
        const sc = await window.inkwell.wg.saveConf(twWgConf);
        if (sc.ok) { _twHasSavedConf = true; state._vpnStaged = true; state._wgOrigin = 'sync'; showWgAlreadyRows('sync'); updateVpnConfiguredBadge(); }
      } catch (_) {}
      // Show parsed WireGuard info, same as the Backup wizard.
      try {
        const p = parseWgConf(twWgConf);
        const pd = $('tw-wg-parsed');
        if (pd) {
          const set = (id, val) => { const el = $(id); if (el) el.textContent = val || '—'; };
          set('tw-iface', f.name.replace(/\.conf$/i, ''));
          set('tw-local-ip', p.address);
          set('tw-endpoint', p.endpoint);
          set('tw-allowed', p.allowedIPs);
          _armVpnConfigToggle('tw-wg-parsed');   // hidden behind "Show config"
        }
      } catch (_) {}
    };
    r.readAsText(f);
  };
  // "Importa un'altra" — reveal the drop zone to replace the loaded .conf.
  $('tw-import-other')?.addEventListener('click', () => {
    if (drop) drop.style.display = '';
    const al = $('tw-wg-already'); if (al) al.style.display = 'none';
  });
  drop?.addEventListener('click', () => file?.click());
  file?.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
  drop?.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop?.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop?.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

  const show = (res, ok, txt) => { res.style.display = 'block'; res.className = 'test-result ' + (ok ? 'ok' : 'fail'); res.textContent = txt; };
  const readSmb = () => ({
    ip:       $('tw-smb-ip')?.value.trim()    || '',
    share:    $('tw-smb-share')?.value.trim() || '',
    path:     $('tw-smb-path')?.value.trim()  || '',
    username: $('tw-smb-user')?.value         || '',
    password: $('tw-smb-pass')?.value         || '',
  });

  // STEP 1 — VERIFY ONLY. Imports the .conf (needed to reach the share through
  // the tunnel) and runs the 3-step test, shown in the checklist exactly like
  // the Backup. Does NOT save/configure. On success reveals "Salva connessione".
  const twRowByKey = { wg: 'tw-tc-wg', reach: 'tw-tc-reach', write: 'tw-tc-write' };
  $('tw-setup-test')?.addEventListener('click', async () => {
    const res = $('tw-setup-result');
    const smb = readSmb();
    // With WireGuard a .conf is required (new or already saved); with OpenVPN the
    // just-loaded .ovpn or an already-imported connection is enough (as in Backup).
    // Say EXACTLY what's missing: VPN not loaded and/or Samba fields empty.
    let vpnLoaded;
    if (_vpnType === 'openvpn') {
      vpnLoaded = !!_ovpnContent;
      if (!vpnLoaded) { try { const c = await window.inkwell.wg.getConf(); vpnLoaded = !!(c && c.ovpnExists); } catch (_) {} }
    } else {
      vpnLoaded = !!(twWgConf || _twHasSavedConf);
      if (!vpnLoaded) { try { const c = await window.inkwell.wg.getConf(); vpnLoaded = _twHasSavedConf = !!(c && c.exists); } catch (_) {} }
    }
    const sambaLoaded = !!(smb.ip && smb.share);
    if (!vpnLoaded || !sambaLoaded) {
      const key = (!vpnLoaded && !sambaLoaded) ? 'sync.vpn_samba_missing' : (!vpnLoaded ? 'sync.vpn_missing' : 'sync.samba_missing');
      res.style.display = 'block'; res.className = 'test-summary fail'; res.textContent = '✗ ' + window.i18n.t(key); return;
    }
    if (!isValidSmbHost(smb.ip))       { res.style.display = 'block'; res.className = 'test-summary fail'; res.textContent = '✗ ' + window.i18n.t('sync.invalid_ip'); return; }
    Object.values(twRowByKey).forEach(id => {
      const row = $(id); if (!row) return;
      const dot = row.querySelector('.tc-dot'); if (dot) dot.className = 'tc-dot pending';
      const r = row.querySelector('.tc-result'); if (r) { r.textContent = '…'; r.style.color = ''; }
    });
    // Label of the first entry based on the active VPN type.
    const twWgLbl = $('tw-tc-wg')?.querySelector('.tc-label');
    if (twWgLbl) twWgLbl.textContent = _vpnType === 'openvpn'
      ? window.i18n.t('sync.tc_ovpn_conn') : window.i18n.t('sync.tc_wg_conn');
    if (res) { res.style.display = 'block'; res.className = 'test-summary'; res.textContent = window.i18n.t('sync.tw_testing'); }
    const btn = $('tw-setup-test'); btn.disabled = true;
    try {
      if (_vpnType === 'openvpn') {
        // Import the just-loaded .ovpn (if present); otherwise reuse
        // the OpenVPN connection already imported into NetworkManager.
        if (_ovpnContent) {
          const imp = await window.inkwell.wg.saveOvpn({
            content: _ovpnContent,
            username: $('tw-ovpn-user')?.value || $('cfg-ovpn-user')?.value || '',
            password: _ovpnPassVal('tw-ovpn-pass') || _ovpnPassVal('cfg-ovpn-pass'),
          });
          if (!imp.ok) throw new Error('OpenVPN: ' + (imp.error || 'import fallito'));
          // Clear after a successful import: the next test reuses the imported
          // NM connection (re-importing flaps the active VPN down/up each time).
          _ovpnContent = null;
          updateVpnConfiguredBadge();
        } else {
          // No fresh .ovpn: push any (re)typed credentials onto the imported
          // connection (sentinel password = keep the one stored in NM).
          const u = $('tw-ovpn-user')?.value || $('cfg-ovpn-user')?.value || '';
          const p = _ovpnPassVal('tw-ovpn-pass') || _ovpnPassVal('cfg-ovpn-pass');
          if (u || p) await window.inkwell.wg.updateOvpnCreds({ username: u, password: p }).catch(() => {});
        }
      } else if (twWgConf) {
        const sc = await window.inkwell.wg.saveConf(twWgConf);
        if (!sc.ok) throw new Error(sc.error || 'saveConf');
        _twHasSavedConf = true;
        updateVpnConfiguredBadge();
      }
      const tf = await window.inkwell.wg.testSmbWrite(smb, 'sync');
      (tf.steps || []).forEach(step => {
        const row = $(twRowByKey[step.key]); if (!row) return;
        const dot = row.querySelector('.tc-dot'); const r = row.querySelector('.tc-result');
        if (dot) dot.className = 'tc-dot ' + (step.ok ? 'ok' : 'fail');
        if (r) { const d = vpnStepDetail(step); r.textContent = step.ok ? '✓' + (d ? ' ' + d : '') : '✗ ' + d; r.style.color = step.ok ? 'var(--green)' : 'var(--red)'; }
      });
      res.style.display = 'block';
      if (tf.ok) {
        res.className = 'test-summary ok'; res.textContent = '✓ ' + window.i18n.t('sync.all_ok_saving');
        // Test passed → OpenVPN credentials proven good: hide the fields.
        if (_vpnType === 'openvpn') setOvpnCredsVisible(false);
      } else {
        const failed = tf.steps?.find(s => !s.ok);
        const reason = failed ? (vpnStepLabel(failed) + (failed.detail ? ' — ' + vpnStepDetail(failed) : '')) : window.i18n.t('sync.test_failed');
        // Detailed reason lives in the checklist row; the box gives a short,
        // clearly visible failure signal (no duplication).
        res.className = 'test-summary fail';
        res.textContent = '✗ ' + (failed ? window.i18n.t('sync.test_failed') : reason);
        try { addEventNotif(window.i18n.t('sync.smbtest_title') + ': ' + reason, false); } catch (_) {}
      }
    } catch (e) {
      res.style.display = 'block'; res.className = 'test-summary fail'; res.textContent = '✗ ' + (e?.message || e);
    } finally { btn.disabled = false; }
  });

  // STEP 2 — SAVE the connection for SYNC ONLY (does NOT enable any backup),
  // then switch to the configured view. Only meaningful after a passing test.
  // Sync Samba fields AUTO-SAVE on blur (no "Salva configurazione" button). The
  // VPN .conf/.ovpn was already persisted at import; here we just save the Samba
  // connection once IP + share are present. Don't re-render to conn-ok mid-edit
  // (it would hide the fields the user is still filling).
  async function autosaveSyncSmb() {
    const smb = readSmb();
    if (!smb.ip || !smb.share) return;
    try {
      const sv = await window.inkwell.wg.saveSyncConnection(smb);
      if (sv.ok) { state._vpnStaged = false; state.config = await window.inkwell.readConfig(); updateActionNowButtons(); showToast('✓ ' + window.i18n.t('sync.smb_config_saved')); }
    } catch (_) {}
  }
  ['tw-smb-ip', 'tw-smb-share', 'tw-smb-path', 'tw-smb-user', 'tw-smb-pass'].forEach(id =>
    $(id)?.addEventListener('blur', autosaveSyncSmb));
  // Invio nei campi Samba → committa (blur) e salva, come cliccare fuori.
  ['tw-smb-ip', 'tw-smb-share', 'tw-smb-path', 'tw-smb-user', 'tw-smb-pass'].forEach(id =>
    $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }));
  // Server Address = 4-group IP input (auto-dot after 3 digits, clickable groups).
  initIpGroup('tw-smb-ip');
  // The former "Salva configurazione" is now "Remove": wipe the (shared) VPN +
  // the Samba params in both tabs — same as the other Remove buttons.
  $('tw-setup-save')?.addEventListener('click', () => _removeWgCompletely());
}

// Flat layout: all sections (import, WG test, Samba, full test) are visible at
// once, so this no longer hides/shows panels or drives any next/back nav. It
// just tracks the logical step and runs the per-section side-effects, and
// optionally scrolls the target section into view.
function wizardGo(step) {
  if (step < 1 || step > wizardState.totalSteps) return;
  wizardState.step = step;
  updatePathPreview();
  updatePathPrefixLabel();
  if (step >= 3) {
    const target = $(`wstep-${step}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// Complete WireGuard removal usable from either tab (Backup/Sync "Rimuovi"
// links): tears down the shared tunnel + .conf and clears all config, then
// refreshes both views and clears the parsed/fields.
async function _removeWgCompletely() {
  // No confirm dialog — remove the VPN-with-Samba connection directly.
  try {
    await window.inkwell.wg.removeSyncConnection();   // tunnel + .conf + vpn/samba/twoway
    try { state.config = await window.inkwell.readConfig(); } catch (_) {}
    wizardState.wgConfig = null;   // else the next settings save re-persists it
    ['cfg-smb-ip','cfg-smb-share','cfg-smb-path','cfg-smb-user','cfg-smb-pass',
     'tw-smb-ip','tw-smb-share','tw-smb-path','tw-smb-user','tw-smb-pass'
    ].forEach(id => { const el = $(id); if (el) el.value = ''; });
    if ($('wg-parsed')) $('wg-parsed').style.display = 'none';
    if ($('tw-wg-parsed')) $('tw-wg-parsed').style.display = 'none';
    ['wg-iface','wg-local-ip','wg-endpoint','wg-allowed','wg-cfg-endpoint','wg-cfg-share',
     'tw-iface','tw-local-ip','tw-endpoint','tw-allowed','tw-cfg-endpoint'
    ].forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
    const dl = $('wg-drop-label'); if (dl) dl.innerHTML = window.i18n.t('sync.wg_drop_label');
    const tdl = $('tw-wg-drop-label'); if (tdl) tdl.innerHTML = window.i18n.t('sync.wg_drop_label');
    if ($('cfg-vpn-enabled'))    $('cfg-vpn-enabled').checked    = false;
    if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = false;
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
    _twHasSavedConf = false;
    // OpenVPN side (the removal deletes the .ovpn + NM connection too): drop the
    // pending content, clear credentials and show the drop zones again.
    _ovpnContent = null;
    ['cfg-ovpn-user','cfg-ovpn-pass','tw-ovpn-user','tw-ovpn-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    [['ovpn-already','ovpn-drop-zone','ovpn-drop-label'], ['tw-ovpn-already','tw-ovpn-drop-zone','tw-ovpn-drop-label']].forEach(([al, dz, lb]) => {
      const a = $(al); if (a) a.style.display = 'none';
      const d = $(dz); if (d) d.style.display = '';
      const l = $(lb); if (l) l.innerHTML = window.i18n.t('sync.ovpn_drop_label');
    });
    setOvpnCredsVisible(true);
    setSmbPanelsVisible(true);
    resetVpnWizardUi();
    await updateWgConfiguredView(true);
    await updateTwowayConnView();
    updateSyncButtonVisibility();
    updateVpnConfiguredBadge();
  } catch (e) { alert(window.i18n.t('status.error') + ': ' + (e?.message || e)); }
}

// Reset a WebDAV connection (Sync or Backup): clear the fields + persisted
// params and turn its toggle off. No VPN involved here. Used by the former
// "Salva configurazione" buttons, now "Remove".
async function _removeWebdav(scope) {
  if (!confirm(window.i18n.t('sync.remove_confirm'))) return;
  const pfx = scope === 'sync' ? 'tw-webdav-' : 'cfg-webdav-';
  ['url', 'user', 'pass', 'path'].forEach(s => { const e = $(pfx + s); if (e) e.value = ''; });
  state._webdavSaved = state._webdavSaved || { backup: {}, sync: {} };
  state._webdavSaved[scope] = { url: '', username: '', password: '', remotePath: '' };
  if (scope === 'sync') {
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    // Keep the hidden master enable in sync with the two method toggles.
    const stillOn = !!$('cfg-tw-samba-enabled')?.checked;
    if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = stillOn;
    state.config = state.config || {}; state.config.sync = state.config.sync || {}; state.config.sync.twoway = state.config.sync.twoway || {};
    state.config.sync.twoway.enabled = stillOn;
    if (stillOn) state.config.sync.twoway.transport = 'samba';
  } else if ($('cfg-webdav-enabled')) {
    $('cfg-webdav-enabled').checked = false;
  }
  const res = $(scope === 'sync' ? 'tw-webdav-result' : 'webdav-test-result'); if (res) res.style.display = 'none';
  try { await saveSettings(); } catch (_) {}
  try { updateActionNowButtons(); } catch (_) {}
}

// Remove ONLY the VPN (WireGuard/OpenVPN): tears down the tunnel + .conf but KEEPS
// the Samba fields/config. Resets the VPN import UI (drop zones) in both tabs.
async function _removeVpnOnly() {
  try {
    await window.inkwell.wg.removeVpnKeepSamba();
    try { state.config = await window.inkwell.readConfig(); } catch (_) {}
    wizardState.wgConfig = null; _ovpnContent = null; _twHasSavedConf = false;
    // WireGuard: hide parsed, reset values + drop labels, show the drop zones.
    ['wg-parsed','tw-wg-parsed'].forEach(id => { const el = $(id); if (el) el.style.display = 'none'; });
    ['wg-iface','wg-local-ip','wg-endpoint','wg-allowed','tw-iface','tw-local-ip','tw-endpoint','tw-allowed']
      .forEach(id => { const el = $(id); if (el) el.textContent = '—'; });
    [['wg-already','wg-drop-zone','wg-drop-label'], ['tw-wg-already','tw-wg-drop-zone','tw-wg-drop-label']].forEach(([al, dz, lb]) => {
      const a = $(al); if (a) a.style.display = 'none';
      const d = $(dz); if (d) d.style.display = '';
      const l = $(lb); if (l) l.innerHTML = window.i18n.t('sync.wg_drop_label');
    });
    // OpenVPN: clear creds, hide parsed/already, show the drop zones.
    ['cfg-ovpn-user','cfg-ovpn-pass','tw-ovpn-user','tw-ovpn-pass'].forEach(id => { const el = $(id); if (el) el.value = ''; });
    ['ovpn-parsed','tw-ovpn-parsed'].forEach(id => { try { _clearVpnConfigToggle(id); } catch (_) {} });
    [['ovpn-already','ovpn-drop-zone','ovpn-drop-label'], ['tw-ovpn-already','tw-ovpn-drop-zone','tw-ovpn-drop-label']].forEach(([al, dz, lb]) => {
      const a = $(al); if (a) a.style.display = 'none';
      const d = $(dz); if (d) d.style.display = '';
      const l = $(lb); if (l) l.innerHTML = window.i18n.t('sync.ovpn_drop_label');
    });
    try { setOvpnCredsVisible(true); } catch (_) {}
    if ($('cfg-vpn-enabled')) $('cfg-vpn-enabled').checked = false;
    try { await updateWgConfiguredView(true); } catch (_) {}
    try { await updateTwowayConnView(); } catch (_) {}
    try { updateVpnConfiguredBadge(); } catch (_) {}
    try { updateActionNowButtons(); } catch (_) {}
  } catch (e) { console.error('removeVpnOnly failed:', e); }
}

// Remove ONLY the Samba config for a tab (scope 'backup'|'sync'): clears the Samba
// fields + persisted target, KEEPS the VPN.
async function _removeSambaOnly(scope) {
  try {
    await window.inkwell.wg.removeSambaOnly(scope);
    try { state.config = await window.inkwell.readConfig(); } catch (_) {}
    const pfx = scope === 'sync' ? 'tw-smb-' : 'cfg-smb-';
    ['ip','share','path','user','pass'].forEach(s => { const el = $(pfx + s); if (el) el.value = ''; });
    const ipGroup = document.querySelector('[data-ip="' + pfx + 'ip"]');
    if (ipGroup) ipGroup.querySelectorAll('.ip-oct').forEach(o => (o.value = ''));
    const prev = $(scope === 'sync' ? 'smb-preview-sync' : 'smb-preview-backup'); if (prev) prev.style.display = 'none';
    const form = $(scope === 'sync' ? 'smb-form-sync' : 'smb-form-backup'); if (form) form.style.display = '';
    if (scope === 'sync' && $('cfg-tw-samba-enabled')) $('cfg-tw-samba-enabled').checked = false;
    try { updateActionNowButtons(); } catch (_) {}
  } catch (e) { console.error('removeSambaOnly failed:', e); }
}

// ── WireGuard "configured" summary ──────────────────────────────────────────
// Once setup is complete, show a compact summary (share + endpoint + LIVE
// tunnel status) instead of the full 4-step wizard. "Riconfigura" reopens it.
function wgSetupComplete() {
  // Configured = the BACKUP connection passed its test (sync.samba is written
  // exclusively by a successful backup test). The vpn.smb mirror can be
  // polluted by the live field mirroring from the Sync tab — don't trust it.
  const sb = state.config?.sync?.samba;
  return !!(sb && (sb.host || sb.ip) && sb.share);
}

async function updateWgConfiguredView(forceEdit = false) {
  const summary = $('wg-configured');
  const wizard  = $('wg-wizard');
  if (!summary || !wizard) return;

  // Summary ONLY when the BACKUP is actually configured. If just a .conf exists
  // (e.g. loaded from the Sync tab) the wizard is shown with a "config already
  // present" note so the user sees it's there and can reuse/remove it.
  let confExists = false;
  try { const c = await window.inkwell.wg.getConf(); confExists = !!(c && c.exists); } catch (_) {}
  // "Test connection" stays grey until a VPN (WireGuard/OpenVPN) config is loaded.
  const runTestBtn = $('btn-run-test');
  if (runTestBtn) runTestBtn.classList.toggle('tc-disabled', !confExists);
  const showSummary = wgSetupComplete() && !forceEdit;
  summary.style.display = showSummary ? 'flex' : 'none';
  wizard.style.display  = showSummary ? 'none' : '';
  if (!showSummary) {
    // Wizard mode. The "already loaded — will be reused" note shows only when the
    // .conf came from the OTHER tab (Sync); if imported HERE, show the config
    // normally ("Show config") instead of a confusing reuse note.
    const drop = $('wg-drop-zone'), already = $('wg-already');
    const reuse = confExists && state._wgOrigin !== 'backup';
    if (drop)    drop.style.display    = confExists ? 'none' : '';
    if (already) already.style.display = reuse ? 'flex' : 'none';
    if (confExists && !reuse) { try { _armVpnConfigToggle('wg-parsed'); } catch (_) {} }
    wizardGo(1); stopWgStatusPolling(); return;
  }

  // Share path (from whichever connection is configured).
  const smb = state.config?.sync?.vpn?.smb || state.config?.sync?.samba || state.config?.sync?.twoway?.smb || {};
  const shareEl = $('wg-cfg-share');
  if (shareEl) shareEl.textContent = (smb.ip || smb.host) ? (`//${smb.ip || smb.host}/${smb.share || ''}`).replace(/\/$/, '') : '—';

  // Endpoint from the saved .conf
  try {
    const conf = await window.inkwell.wg.getConf();
    const ep = (conf?.parsed?.endpoint && conf.parsed.endpoint !== '?') ? conf.parsed.endpoint : conf?.ovpnParsed?.endpoint;
    if ($('wg-cfg-endpoint')) $('wg-cfg-endpoint').textContent = ep || '—';
  } catch (_) {}
  // VPN details hidden behind "Show config" (don't expose them by default).
  _armVpnConfigToggle('wg-cfg-parsed');

  // Tunnel status — checked ONCE when the view opens (no continuous ping).
  stopWgStatusPolling();
  refreshWgStatus();
}

let _wgStatusTimer = null;

// "12s fa" / "3m fa" / "2h fa" — human age of the last WireGuard handshake.
function _fmtHandshakeAgo(ts) {
  if (!ts) return null;
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (sec < 60)    return sec + 's';
  if (sec < 3600)  return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'g';
}

// Shared ONE-SHOT tunnel status writer (no continuous ping). Shows the last
// WireGuard handshake when readable; otherwise falls back to reachability.
// Used by BOTH the backup configured view and the Sync tab.
async function updateTunnelStatusInto(badgeId, labelId) {
  const badge = $(badgeId), label = $(labelId);
  if (!badge && !label) return;
  try {
    const st = await window.inkwell.wg.status();
    let hsAge = null;
    try { const h = await window.inkwell.wg.handshake(); if (h && h.ok && h.ts) hsAge = _fmtHandshakeAgo(h.ts); } catch (_) {}
    // Name the configured VPN in every status line ("Tunnel OpenVPN attivo",
    // "non serve WireGuard", …) so it's clear WHICH one is in use right now.
    let vpn = 'VPN';
    try {
      const c = await window.inkwell.wg.getConf();
      const names = [c?.exists && 'WireGuard', c?.ovpnExists && 'OpenVPN'].filter(Boolean);
      if (names.length === 1) vpn = names[0];
    } catch (_) {}
    const via = st && st.via ? ` (${st.via})` : '';
    const hsTxt = hsAge ? ` · ${window.i18n.t('sync.wg_handshake')} ${hsAge} ${window.i18n.t('sync.wg_ago')}` : '';
    if (st && !st.up && st.reachable) {
      if (badge) badge.style.background = 'var(--ok, #3fb950)';
      if (label) label.textContent = window.i18n.t('sync.wg_direct', { vpn });
    } else if (st && st.up && st.reachable) {
      if (badge) badge.style.background = 'var(--ok, #3fb950)';
      if (label) label.textContent = window.i18n.t('sync.wg_reachable', { vpn }) + via + hsTxt + (!hsAge && st.latency ? ` · ${st.latency}` : '');
    } else if (st && st.up) {
      if (badge) badge.style.background = 'var(--warn, #d29922)';
      if (label) label.textContent = window.i18n.t('sync.wg_up_unreachable', { vpn }) + via + hsTxt;
    } else {
      if (badge) badge.style.background = 'var(--accent-dim, #888)';
      if (label) label.textContent = window.i18n.t('sync.wg_inactive', { vpn });
    }
  } catch (_) {}
}
async function refreshWgStatus() { return updateTunnelStatusInto('wg-cfg-badge', 'wg-cfg-state'); }
function startWgStatusPolling() {
  stopWgStatusPolling();
  _wgStatusTimer = setInterval(refreshWgStatus, 4000);
}
function stopWgStatusPolling() {
  if (_wgStatusTimer) { clearInterval(_wgStatusTimer); _wgStatusTimer = null; }
}

function loadWgFile(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const confContent = e.target.result;
    wizardState.wgConfig = confContent;
    // Fresh VPN import → backup modes (folder/archive) start OFF.
    try { window._resetVpnBackupModeFlags?.(); } catch (_) {}

    // Save to disk via real IPC — wgManager.saveConf()
    const result = await window.inkwell.wg.saveConf(confContent);
    if (!result.ok) {
      showToast('✗ ' + window.i18n.t('toast.conf_save_error') + ': ' + result.error);
      return;
    }

    showWgParsed(result.parsed, file.name);
    // No "imported" toast. Still WARN if the .conf couldn't be applied to
    // NetworkManager (saved on disk only → the real tunnel won't come up).
    if (result.nm && !result.nm.ok)  showToast('⚠ ' + window.i18n.t('sync.wg_saved_no_nm'));
    state._vpnStaged = true;    // provisional until committed with a Save
    state._wgOrigin = 'backup'; // imported HERE → "reuse" note belongs only to Sync
    showWgAlreadyRows('backup');
    updateVpnConfiguredBadge();
  };
  reader.readAsText(file);
}

// The parsed VPN config (WireGuard/OpenVPN endpoint, IPs, protocol) is hidden
// by default after import — a "Show config" button reveals it on demand, so the
// Backup/Sync view doesn't expose the VPN details unless asked.
function _armVpnConfigToggle(blockId) {
  const block = document.getElementById(blockId);
  if (block) block.style.display = 'none';   // collapsed until the user clicks
  // There can be MORE than one "Show config" button per target (e.g. the standalone
  // one in the import step + the one inside the "already loaded" row) — arm them all.
  document.querySelectorAll(`.vpn-show-config[data-target="${blockId}"]`).forEach(btn => {
    btn.style.display = ''; btn.textContent = window.i18n.t('sync.show_config');
  });
}
function _clearVpnConfigToggle(blockId) {
  const block = document.getElementById(blockId);
  if (block) block.style.display = 'none';
  document.querySelectorAll(`.vpn-show-config[data-target="${blockId}"]`).forEach(btn => {
    btn.style.display = 'none';
  });
}
// Inject the FULL raw VPN config (the actual .conf/.ovpn text, secrets included)
// into a parsed block as a <pre>, so "Show config" reveals the whole thing.
async function _injectVpnRawConfig(block, target) {
  let pre = block.querySelector('.vpn-raw');
  if (!pre) { pre = document.createElement('pre'); pre.className = 'vpn-raw'; block.appendChild(pre); }
  let raw = '';
  try {
    const r = await window.inkwell.wg.getRawConf();
    if (/ovpn/.test(target)) raw = r?.ovpn || '';
    else if (/cfg/.test(target)) raw = r?.wg || r?.ovpn || '';   // summary: whichever is configured
    else raw = r?.wg || '';
  } catch (_) {}
  pre.textContent = raw || '—';
}

// One delegated handler for every "Show config" button (toggles its target).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('.vpn-show-config');
  if (!btn) return;
  const block = document.getElementById(btn.dataset.target);
  if (!block) return;
  const hidden = getComputedStyle(block).display === 'none';
  if (hidden) {
    await _injectVpnRawConfig(block, btn.dataset.target);   // full config text
    block.style.display = 'flex';
  } else {
    block.style.display = 'none';
  }
  // Keep every button that targets this block in sync (show/hide label).
  const label = window.i18n.t(hidden ? 'sync.hide_config' : 'sync.show_config');
  document.querySelectorAll(`.vpn-show-config[data-target="${btn.dataset.target}"]`).forEach(b => b.textContent = label);
});

// ── Samba share collapse/expand (Backup tab = 'backup', Sync tab = 'sync') ──────
// Once a Samba share is configured, its fields collapse to a one-line summary;
// they reappear only via "Mostra configurazione" (read-only) or "Riconfigura"
// (editable). Mirrors the VPN show-config/reconfigure pattern. `_smbExpanded`
// is reset on each settings open and forced true by an explicit reconfigure.
let _smbExpanded = { backup: false, sync: false };
function _smbFieldIds(tab) {
  return tab === 'backup'
    ? ['cfg-smb-ip', 'cfg-smb-share', 'cfg-smb-path', 'cfg-smb-user', 'cfg-smb-pass']
    : ['tw-smb-ip', 'tw-smb-share', 'tw-smb-path', 'tw-smb-user', 'tw-smb-pass'];
}
function setSmbFormReadonly(tab, ro) {
  _smbFieldIds(tab).forEach(id => { const el = $(id); if (el) el.readOnly = ro; });
}
function applySmbCollapse(tab) {
  const cfg = state.config || {};
  const smb = tab === 'backup'
    ? (cfg.sync?.vpn?.smb || cfg.sync?.samba)
    : cfg.sync?.twoway?.smb;
  const host = smb && (smb.ip || smb.host);
  const share = smb && smb.share;
  const form = $('smb-form-' + tab), prev = $('smb-preview-' + tab);
  const collapsed = !!(host && share) && !_smbExpanded[tab];
  if (form) form.style.display = collapsed ? 'none' : '';
  if (prev) prev.style.display = collapsed ? 'flex' : 'none';
  if (collapsed) {
    setSmbFormReadonly(tab, true);
    const folder = (tab === 'backup' ? (smb.path || smb.remotePath) : smb.remoteSubPath) || '';
    const sum = $('smb-summary-' + tab);
    if (sum) sum.textContent = (smb.username ? smb.username + '@' : '') + host + '/' + share + (folder ? '  ·  ' + folder : '');
    document.querySelectorAll(`.smb-show-config[data-target="${tab}"]`).forEach(b => b.textContent = window.i18n.t('sync.show_config'));
  }
}

// Delegated clicks for the Samba "Mostra configurazione" / "Riconfigura" buttons.
document.addEventListener('click', (e) => {
  const showBtn = e.target.closest && e.target.closest('.smb-show-config');
  if (showBtn) {
    const tab = showBtn.dataset.target, form = $('smb-form-' + tab);
    if (!form) return;
    const hidden = form.style.display === 'none';
    form.style.display = hidden ? '' : 'none';
    if (hidden) setSmbFormReadonly(tab, true);   // reveal read-only (view, not edit)
    document.querySelectorAll(`.smb-show-config[data-target="${tab}"]`).forEach(b =>
      b.textContent = window.i18n.t(hidden ? 'sync.hide_config' : 'sync.show_config'));
    return;
  }
  const reconfBtn = e.target.closest && e.target.closest('.smb-reconfigure');
  if (reconfBtn) {
    const tab = reconfBtn.dataset.target;
    _smbExpanded[tab] = true;
    const form = $('smb-form-' + tab), prev = $('smb-preview-' + tab);
    if (prev) prev.style.display = 'none';
    if (form) form.style.display = '';
    setSmbFormReadonly(tab, false);              // editable
    { const ipId = tab === 'backup' ? 'cfg-smb-ip' : 'tw-smb-ip';
      (document.querySelector('.ip-group[data-ip="' + ipId + '"] .ip-oct') || $(ipId))?.focus(); }
    return;
  }
});

// "Modify config": open the raw VPN config in an editable textarea (Save/Cancel),
// then persist via wg.saveConf (WireGuard) / wg.saveOvpn (OpenVPN). The config is
// shared between Backup and Sync, so editing here updates both.
document.addEventListener('click', async (e) => {
  const editBtn = e.target.closest && e.target.closest('.vpn-edit-config');
  if (editBtn) {
    const block = document.getElementById(editBtn.dataset.target);
    if (!block) return;
    const kind = editBtn.dataset.kind === 'ovpn' ? 'ovpn' : 'wg';
    let raw = '';
    try { const r = await window.inkwell.wg.getRawConf(); raw = (kind === 'ovpn' ? r?.ovpn : r?.wg) || ''; } catch (_) {}
    block.querySelector('.vpn-raw')?.remove();
    let ed = block.querySelector('.vpn-edit');
    if (!ed) {
      ed = document.createElement('div'); ed.className = 'vpn-edit';
      ed.innerHTML = '<textarea class="vpn-edit-ta" spellcheck="false" autocomplete="off"></textarea>'
        + '<div class="vpn-edit-actions"><button type="button" class="wiz-btn vpn-edit-save"></button>'
        + '<button type="button" class="wiz-btn secondary vpn-edit-cancel"></button>'
        + '<span class="vpn-edit-msg"></span></div>';
      block.appendChild(ed);
    }
    ed.dataset.kind = kind;
    ed.querySelector('.vpn-edit-ta').value = raw;
    ed.querySelector('.vpn-edit-save').textContent = window.i18n.t('sync.save_config');
    ed.querySelector('.vpn-edit-cancel').textContent = window.i18n.t('common.cancel');
    ed.querySelector('.vpn-edit-msg').textContent = '';
    ed.style.display = 'block';
    block.style.display = 'flex';
    document.querySelectorAll(`.vpn-show-config[data-target="${editBtn.dataset.target}"]`).forEach(b => b.textContent = window.i18n.t('sync.hide_config'));
    return;
  }
  const cancelBtn = e.target.closest && e.target.closest('.vpn-edit-cancel');
  if (cancelBtn) {
    const block = cancelBtn.closest('.wg-parsed');
    cancelBtn.closest('.vpn-edit')?.remove();
    if (block) {
      block.style.display = 'none';
      document.querySelectorAll(`.vpn-show-config[data-target="${block.id}"]`).forEach(b => b.textContent = window.i18n.t('sync.show_config'));
    }
    return;
  }
  const saveBtn = e.target.closest && e.target.closest('.vpn-edit-save');
  if (saveBtn) {
    const ed = saveBtn.closest('.vpn-edit');
    const block = saveBtn.closest('.wg-parsed');
    const kind = ed?.dataset.kind === 'ovpn' ? 'ovpn' : 'wg';
    const text = ed?.querySelector('.vpn-edit-ta')?.value || '';
    const msg = ed?.querySelector('.vpn-edit-msg');
    if (msg) msg.textContent = '…';
    try {
      const res = (kind === 'ovpn')
        ? await window.inkwell.wg.saveOvpn({ content: text })
        : await window.inkwell.wg.saveConf(text);
      if (res?.ok) {
        if (kind === 'wg' && res.parsed) { try { showWgParsed(res.parsed); } catch (_) {} }
        try { updateVpnConfiguredBadge(); } catch (_) {}
        try { showToast('✓ ' + window.i18n.t('sync.save_config')); } catch (_) {}
        ed?.remove();
        if (block) {
          block.style.display = 'none';
          document.querySelectorAll(`.vpn-show-config[data-target="${block.id}"]`).forEach(b => b.textContent = window.i18n.t('sync.show_config'));
        }
      } else if (msg) {
        msg.textContent = '✗ ' + (res?.error || window.i18n.t('status.error'));
      }
    } catch (err) {
      if (msg) msg.textContent = '✗ ' + (err?.message || '');
    }
    return;
  }
});

function showWgParsed(parsed, filename) {
  if (!parsed) return;
  $('wg-parsed').style.cssText = 'display:none;flex-direction:column;gap:5px';
  _armVpnConfigToggle('wg-parsed');
  $('wg-iface').textContent     = parsed.interface   || filename?.replace('.conf','') || 'wg0';
  $('wg-local-ip').textContent  = parsed.localIp     || '—';
  $('wg-endpoint').textContent  = parsed.endpoint    || '—';
  $('wg-allowed').textContent   = parsed.allowedIps  || '—';
  // A config is present → collapse the big drop zone into a compact "replace"
  // bar (saves vertical space) while keeping these parsed details visible.
  const dz = $('wg-drop-zone');
  if (dz) {
    dz.classList.add('loaded');
    const lbl = $('wg-drop-label');
    if (lbl) {
      const name = filename ? `<strong style="color:var(--green)">✓ ${escHtml(filename)}</strong>` : `<strong style="color:var(--green)">✓ .conf</strong>`;
      lbl.innerHTML = `${name} · ${window.i18n.t('sync.wg_replace')}`;
    }
  }
}

function parseWgConf(text) {
  const get = k => { const m = text.match(new RegExp(`^${k}\\s*=\\s*(.+)$`,'mi')); return m ? m[1].trim() : null; };
  return { address: get('Address'), endpoint: get('Endpoint'), allowedIPs: get('AllowedIPs') };
}

function updatePathPreview() {
  const sub = $('cfg-smb-path')?.value || '';
  const ppRoot = $('pp-root'); if (ppRoot) ppRoot.textContent = sub + '/';
  updatePathPrefixLabel();
}

function updatePathPrefixLabel() {
  const label = $('path-prefix-label'); if (!label) return;
  const ip = $('cfg-smb-ip')?.value.trim() || '';
  const share = $('cfg-smb-share')?.value.trim() || '';
  const parts = [ip, share].filter(Boolean);
  label.textContent = '//' + parts.join('/') + '/';
}

// VPN type for the Backup section: 'wireguard' | 'openvpn' (one at a time).
let _vpnType = 'wireguard';
let _ovpnContent = null;
// Shown in the password field when a password is already stored in NM. If the
// field still holds the sentinel on submit, no password is sent (NM keeps the
// saved secret); typing anything replaces it.
const OVPN_PASS_SENTINEL = '********';
const _ovpnPassVal = (id) => { const v = $(id)?.value || ''; return v === OVPN_PASS_SENTINEL ? '' : v; };
// OpenVPN username/password rows (Backup + Sync). Hidden once the config is
// imported AND the credentials are saved — they come back only via "Importa
// un'altra" or after a Remove (reconfigure path).
function setOvpnCredsVisible(show) {
  ['ovpn-creds', 'tw-ovpn-creds'].forEach(id => {
    const el = $(id); if (el) el.style.display = show ? '' : 'none';
  });
}

// "Esegui backup ora" appears only with at least one backup destination ON
// (Local / VPN with Samba / WebDAV); "Sincronizza ora" only with the two-way
// toggle ON — no action buttons for features that are switched off.
function updateActionNowButtons() {
  // Everything reads the SAVED config: the buttons appear only after "Save
  // configuration" persists the flags — toggling alone is not enough.
  const s = state.config?.sync || {};
  // Backup via VPN+Samba ready = flag saved + at least one mode (folder/tar)
  // saved + connection TESTED ok (sync.samba is written only by a passing test).
  const backupTested = !!(s.samba && (s.samba.host || s.samba.ip) && s.samba.share);
  const modeOk = (s.vpn?.folder !== false) || !!s.vpn?.archive;
  const vpnReady = !!s.vpn?.enabled && modeOk && backupTested;
  const anyBackup = !!(s.local?.enabled || s.webdav?.enabled || vpnReady);
  // Whole manual-backup block (label + hint + button) appears only with a backup.
  const topBlock = $('manual-backup-block'); if (topBlock) topBlock.style.display = anyBackup ? 'flex' : 'none';
  // Sync ready = toggle saved + its OWN connection saved by "Salva connessione"
  // (which appears only after a passing test).
  const syncReady = !!s.twoway?.enabled && (
    (s.twoway?.transport === 'webdav' && !!s.twoway?.webdav?.url)
    || (s.twoway?.transport !== 'webdav' && !!(s.twoway?.smb && (s.twoway.smb.ip || s.twoway.smb.host)))
  );
  const sblk = $('sync-now-block'); if (sblk) sblk.style.display = syncReady ? 'flex' : 'none';
}

// At least ONE backup mode (folder/archive) must be selected for the "VPN with
// Samba share" flag: turning the last mode off while the flag is on switches
// the flag off too (with a toast explaining why).
function updateVpnModeWarn() {
  const f = !!$('cfg-backup-normal')?.checked, a = !!$('cfg-backup-archived')?.checked;
  const flag = $('cfg-vpn-enabled');
  if (!f && !a && flag?.checked) {
    flag.checked = false;
    showToast('✗ ' + window.i18n.t('sync.vpn_need_mode'));
  }
}

// Valid Samba host: a STRICT IPv4 (4 octets 0-255 — "10.20.30.40.50" is not
// an IP) or a plain hostname.
function isValidSmbHost(v) {
  v = String(v || '').trim();
  if (!v) return false;
  if (/^[0-9.]+$/.test(v)) {
    const o = v.split('.');
    return o.length === 4 && o.every(x => /^\d{1,3}$/.test(x) && +x <= 255);
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(v);
}

// Localize a connection-test step detail: the backend ships an i18n `key`
// (+ params) with each detail — translate it in the ACTIVE language, falling
// back to the raw (Italian) detail for older shapes.
function vpnStepDetail(step) {
  if (step && step.dkey) { try { return window.i18n.t(step.dkey, step.params || {}); } catch (_) {} }
  return (step && step.detail) || '';
}

// Localize a connection-test step LABEL: the backend ships an i18n `lkey`
// alongside the raw (Italian) label — translate it, falling back to the raw
// label for older shapes. (Same idea as vpnStepDetail for the detail text.)
function vpnStepLabel(step) {
  if (step && step.lkey) { try { return window.i18n.t(step.lkey); } catch (_) {} }
  return (step && step.label) || '';
}

// FULL wizard UI reset (both tabs): Samba/credential fields, parsed info and
// — crucially — the connection-test checklist rows and result boxes, which
// otherwise keep showing the PREVIOUS connection's outcome after a Remove or a
// fresh import ("Connected via OpenVPN ✓" on a connection that no longer exists).
function resetVpnWizardUi() {
  state._backupSmbTested = null;   // a removed/replaced connection is not "tested"
  state._vpnStaged = false;
  // (Save button stays visible — like the Sync tab's "Salva connessione".)

  ['cfg-smb-ip','cfg-smb-share','cfg-smb-path','cfg-smb-user','cfg-smb-pass',
   'tw-smb-ip','tw-smb-share','tw-smb-path','tw-smb-user','tw-smb-pass',
   'cfg-ovpn-user','cfg-ovpn-pass','tw-ovpn-user','tw-ovpn-pass'
  ].forEach(id => { const el = $(id); if (el) el.value = ''; });
  // Test checklists → back to idle.
  ['tc-wg','tc-reach','tc-write','tw-tc-wg','tw-tc-reach','tw-tc-write',
   'tc-wg-up','tc-wg-ping','tc-wg-latency'
  ].forEach(id => {
    const row = $(id); if (!row) return;
    const dot = row.querySelector('.tc-dot');   if (dot) dot.className = 'tc-dot idle';
    const res = row.querySelector('.tc-result'); if (res) { res.textContent = ''; res.style.color = ''; }
  });
  // OpenVPN parsed info boxes → hidden.
  ['ovpn-parsed', 'tw-ovpn-parsed'].forEach(id => _clearVpnConfigToggle(id));
  // Result/summary boxes → hidden and empty.
  ['test-summary','wg-test-result','tw-setup-result','tw-conn-test-result','twoway-test-result'
  ].forEach(id => { const el = $(id); if (el) { el.style.display = 'none'; el.textContent = ''; } });
  updateActionNowButtons();
}

// Samba sections (Backup wizard + Sync wizard). Hidden together with the OpenVPN
// credentials once the connection test passes — shown again via Riconfigura /
// Importa un'altra / Remove.
function setSmbPanelsVisible(show) {
  ['wstep-3', 'tw-smb-panel'].forEach(id => {
    const el = $(id); if (el) el.style.display = show ? '' : 'none';
  });
  // An explicit reconfigure/import flow asks for the panels → reveal the EDITABLE
  // fields (not the collapsed summary) in both tabs.
  if (show) {
    ['backup', 'sync'].forEach(tab => {
      _smbExpanded[tab] = true;
      const f = $('smb-form-' + tab), p = $('smb-preview-' + tab);
      if (f) f.style.display = '';
      if (p) p.style.display = 'none';
      setSmbFormReadonly(tab, false);
    });
  }
}

// During the INITIAL setup (import → credentials → Samba → test) all fields
// are visible. Once the initial test has PASSED (connection works, Samba
// write/permissions OK → the Samba connection gets saved), the wizards show
// ONLY the "config loaded" row (Importa un'altra / Riconfigura / Rimuovi) and
// the connection test — user/password and the Samba form come back ONLY via
// Riconfigura. Re-evaluated on EVERY settings open.
async function refreshVpnWizardVisibility() {
  try {
    const c = await window.inkwell.wg.getConf();
    const vpnOnDisk = !!(c?.exists || c?.ovpnExists);
    // OpenVPN creds: hidden once the VPN is imported and user+pass are saved in
    // NM — back via Riconfigura. The SAMBA form instead stays ALWAYS visible:
    // Backup and Sync must point to DIFFERENT folders (each claims its own with
    // a marker file), so each tab needs its share fields at hand. Using the
    // other purpose's folder fails the connection test with a clear error.
    const credsSaved = !!(c?.ovpnMeta?.username && c?.ovpnMeta?.hasPassword);
    setOvpnCredsVisible(!(vpnOnDisk && credsSaved));
    // Show the Samba panels, but collapse the fields to a summary when already
    // configured (reappear via Mostra configurazione / Riconfigura). Honors any
    // active reconfigure (_smbExpanded set true by setSmbPanelsVisible/Riconfigura).
    ['wstep-3', 'tw-smb-panel'].forEach(id => { const el = $(id); if (el) el.style.display = ''; });
    applySmbCollapse('backup');
    applySmbCollapse('sync');
  } catch (_) {}
}

// Name of the VPN currently configured on disk — used by the Remove confirms
// ("OpenVPN will be removed" vs "WireGuard will be removed").
async function configuredVpnName() {
  try {
    const c = await window.inkwell.wg.getConf();
    if (c?.ovpnExists) return 'OpenVPN';
    if (c?.exists)     return 'WireGuard';
  } catch (_) {}
  return 'VPN';
}

// After a WireGuard .conf import, show the "config already loaded" row (with
// the Import-another / Remove buttons) in BOTH tabs — the connection is shared.
function showWgAlreadyRows(origin) {
  origin = origin || state._wgOrigin;
  // Show the "already loaded — will be reused" note ONLY in the tab that did NOT
  // import the config. In the importing tab the config is shown normally (the
  // "Show config" button), not a confusing "it will be reused" note.
  [['backup', 'wg-already', 'wg-drop-zone', 'wg-parsed'],
   ['sync', 'tw-wg-already', 'tw-wg-drop-zone', 'tw-wg-parsed']].forEach(([tab, al, dz, parsed]) => {
    const a = $(al), d = $(dz);
    if (d) d.style.display = 'none';
    // Sync ALWAYS shows the "config loaded" row (so Remove/Reconfigure are there
    // even when the VPN was imported here). Backup keeps the original reuse rule.
    const show = tab === 'sync' ? true : (origin !== tab);
    if (a) a.style.display = show ? 'flex' : 'none';
    try { _armVpnConfigToggle(parsed); } catch (_) {}
  });
  // The .conf is on disk now — the Sync tab's cached flag must know it too
  // (importing from the Backup tab used to leave it stale → "import first").
  _twHasSavedConf = true;
}

// Same as showWgAlreadyRows but for OpenVPN: the "already loaded — will be reused"
// note shows ONLY in the tab that did NOT import the .ovpn; the importing tab gets
// the normal "Show config" instead.
function showOvpnAlreadyRows(origin) {
  origin = origin || state._ovpnOrigin;
  [['backup', 'ovpn-already', 'ovpn-drop-zone', 'ovpn-parsed'],
   ['sync', 'tw-ovpn-already', 'tw-ovpn-drop-zone', 'tw-ovpn-parsed']].forEach(([tab, al, dz, parsed]) => {
    const a = $(al), d = $(dz);
    if (d) d.style.display = 'none';
    // Sync ALWAYS shows the row (Remove/Reconfigure even when imported here);
    // Backup keeps the original reuse rule.
    const show = tab === 'sync' ? true : (origin !== tab);
    if (a) a.style.display = show ? 'flex' : 'none';
    try { _armVpnConfigToggle(parsed); } catch (_) {}
  });
}

// Green "✓ WireGuard/OpenVPN configurato" badge next to the VPN type selector
// (Backup AND Sync): tells which VPN is actually configured right now,
// regardless of which type button happens to be selected.
async function updateVpnConfiguredBadge() {
  let names = [];
  try {
    const c = await window.inkwell.wg.getConf();
    if (c?.exists)     names.push('WireGuard');
    if (c?.ovpnExists) names.push('OpenVPN');
  } catch (_) {}
  const txt = names.length ? window.i18n.t('sync.vpn_configured', { vpn: names.join(' + ') }) : '';
  // OpenVPN parsed info (peer endpoint from the `remote` line + protocol) —
  // same treatment as the WireGuard parsed grid, in BOTH tabs.
  try {
    const c2 = await window.inkwell.wg.getConf();
    const op = c2?.ovpnParsed;
    [['ovpn-parsed', 'ovpn-endpoint', 'ovpn-proto'], ['tw-ovpn-parsed', 'tw-ovpn-endpoint', 'tw-ovpn-proto']].forEach(([box, epId, prId]) => {
      const b = $(box); if (!b) return;
      if (op) {
        const e = $(epId); if (e) e.textContent = (op.endpoint || '—') + (op.remotes > 1 ? ` (+${op.remotes - 1})` : '');
        const pr = $(prId); if (pr) pr.textContent = op.proto ? op.proto.toUpperCase() : '—';
        _armVpnConfigToggle(box);    // hidden behind "Show config"
      } else {
        _clearVpnConfigToggle(box);
      }
    });
  } catch (_) {}
  ['vpn-configured-badge', 'tw-vpn-configured-badge'].forEach(id => {
    const el = $(id); if (!el) return;
    el.style.display = txt ? 'inline-flex' : 'none';
    const span = el.querySelector('span'); if (span) span.textContent = txt;
  });
  // ONE VPN at a time: while one type is configured, the OTHER type's selector
  // button is disabled (in Backup AND Sync) until the user removes the current
  // config. Also keep the selection on the configured type.
  const lock = names.length === 1 ? names[0] : null;
  document.querySelectorAll('.vpn-type-btn').forEach(b => {
    const disabled = !!lock &&
      ((lock === 'WireGuard' && b.dataset.vpn === 'openvpn') ||
       (lock === 'OpenVPN'   && b.dataset.vpn === 'wireguard'));
    // NOT b.disabled: a disabled button swallows clicks, so the user gets NO
    // feedback at all ("import looks broken"). Keep it clickable and let the
    // click handler show the toast explaining the lock.
    b.disabled = false;
    b.dataset.locked = disabled ? lock : '';
    b.style.opacity = disabled ? '.4' : '';
    b.style.cursor  = disabled ? 'not-allowed' : '';
    b.title = disabled ? window.i18n.t('sync.vpn_locked', { vpn: lock }) : '';
  });
  if (lock) setVpnType(lock === 'WireGuard' ? 'wireguard' : 'openvpn');
}

function setVpnType(t) {
  _vpnType = (t === 'openvpn') ? 'openvpn' : 'wireguard';
  document.querySelectorAll('.vpn-type-btn').forEach(b => b.classList.toggle('active', b.dataset.vpn === _vpnType));
  // Backup and Sync share the VPN type: the panels swap in both tabs.
  const wgP = $('wstep-1'), ovP = $('ovpn-step');
  if (wgP) wgP.style.display = _vpnType === 'wireguard' ? '' : 'none';
  if (ovP) ovP.style.display = _vpnType === 'openvpn' ? '' : 'none';
  const twWgP = $('tw-wstep-1'), twOvP = $('tw-ovpn-step');
  if (twWgP) twWgP.style.display = _vpnType === 'wireguard' ? '' : 'none';
  if (twOvP) twOvP.style.display = _vpnType === 'openvpn' ? '' : 'none';
  try { localStorage.setItem('amelie-vpn-type', _vpnType); } catch (_) {}
}

async function runConnectionTest() {
  // Three sub-checks: VPN connected · Samba reachable · write to folder.
  const rowByKey = { wg: 'tc-wg', reach: 'tc-reach', write: 'tc-write' };
  Object.values(rowByKey).forEach(id => {
    const row = $(id); if (!row) return;
    const dot = row.querySelector('.tc-dot'); if (dot) dot.className = 'tc-dot pending';
    const r = row.querySelector('.tc-result'); if (r) { r.textContent = '…'; r.style.color = ''; }
  });
  { const sm0 = $('test-summary'); if (sm0) { sm0.style.display = 'block'; sm0.className = 'test-summary'; sm0.textContent = window.i18n.t('sync.tw_testing'); } }
  $('btn-run-test').disabled = true;
  // Label the first row for the active VPN type.
  const wgLbl = $('tc-wg')?.querySelector('.tc-label');
  if (wgLbl) wgLbl.textContent = _vpnType === 'openvpn' ? window.i18n.t('sync.tc_ovpn_conn') : window.i18n.t('sync.tc_wg_conn');

  // Required fields — don't even start the test without IP and share name
  // (running with an empty share produced a raw smbclient error).
  // Say EXACTLY what's missing: VPN not loaded and/or Samba fields empty.
  let vpnLoaded = false;
  try { const c = await window.inkwell.wg.getConf(); vpnLoaded = !!(c && (c.exists || c.ovpnExists)); } catch (_) {}
  if (!vpnLoaded && _ovpnContent) vpnLoaded = true;
  const reqIp = $('cfg-smb-ip')?.value.trim(), reqShare = $('cfg-smb-share')?.value.trim();
  const sambaLoaded = !!(reqIp && reqShare);
  if (!vpnLoaded || !sambaLoaded) {
    const key = (!vpnLoaded && !sambaLoaded) ? 'sync.vpn_samba_missing' : (!vpnLoaded ? 'sync.vpn_missing' : 'sync.samba_missing');
    const sm = $('test-summary');
    if (sm) { sm.style.display = 'block'; sm.className = 'test-summary fail'; sm.textContent = '✗ ' + window.i18n.t(key); }
    $('btn-run-test').disabled = false;
    return;
  }
  if (!isValidSmbHost(reqIp)) {
    const sm = $('test-summary');
    if (sm) { sm.style.display = 'block'; sm.className = 'test-summary fail'; sm.textContent = '✗ ' + window.i18n.t('sync.invalid_ip'); }
    $('btn-run-test').disabled = false;
    return;
  }

  // If OpenVPN is selected and a fresh .ovpn was loaded, import it first.
  if (_vpnType === 'openvpn' && _ovpnContent) {
    const imp = await window.inkwell.wg.saveOvpn({
      content: _ovpnContent,
      username: $('cfg-ovpn-user')?.value || '',
      password: _ovpnPassVal('cfg-ovpn-pass'),
    });
    if (!imp.ok) {
      const summary = $('test-summary');
      summary.style.display = 'block'; summary.className = 'test-summary fail';
      summary.textContent = '✗ OpenVPN: ' + (imp.error || 'import fallito');
      $('btn-run-test').disabled = false;
      return;
    }
    // Imported into NM: clear the pending content so the NEXT test reuses the
    // imported connection instead of re-importing (each re-import tears the
    // active connection down + deletes it → visible OpenVPN up/down flaps).
    _ovpnContent = null;
    updateVpnConfiguredBadge();
  } else if (_vpnType === 'openvpn') {
    // No fresh .ovpn: push any (re)typed credentials onto the already-imported
    // connection (sentinel password = keep the one stored in NM).
    const u = $('cfg-ovpn-user')?.value || '', p = _ovpnPassVal('cfg-ovpn-pass');
    if (u || p) await window.inkwell.wg.updateOvpnCreds({ username: u, password: p }).catch(() => {});
  }

  // Build Samba config from step 3 fields
  const smbConfig = {
    ip:       $('cfg-smb-ip')?.value.trim()    || '',
    share:    $('cfg-smb-share')?.value.trim() || '',
    path:     $('cfg-smb-path')?.value.trim()  || '',
    username: $('cfg-smb-user')?.value         || '',
    password: $('cfg-smb-pass')?.value         || '',
  };

  // Write test — reports VPN / reachable / write sub-steps. Does NOT keep the
  // tunnel up (the flag does).
  const result = await window.inkwell.wg.testSmbWrite(smbConfig, 'backup');

  // Apply each sub-step to its row.
  (result.steps || []).forEach(step => {
    const row = $(rowByKey[step.key]); if (!row) return;
    const dot = row.querySelector('.tc-dot');
    const res = row.querySelector('.tc-result');
    if (dot) dot.className = 'tc-dot ' + (step.ok ? 'ok' : 'fail');
    if (res) {
      const d = vpnStepDetail(step);
      res.textContent = step.ok ? '✓' + (d ? ' ' + d : '') : '✗ ' + (d || window.i18n.t('status.error'));
      res.style.color = step.ok ? 'var(--green)' : 'var(--red)';
    }
  });

  const summary = $('test-summary');
  summary.style.display = 'block';

  if (result.ok) {
    summary.className = 'test-summary ok';
    // The test only VERIFIES — nothing is persisted until the user presses
    // "Save configuration". Remember the tested connection in memory: the
    // save will persist exactly what passed the test.
    state._backupSmbTested = smbConfig;
    summary.textContent = '✓ ' + window.i18n.t('sync.test_ok_now_save');
    { const sb = $('btn-vpn-save-config'); if (sb) sb.style.display = ''; }
    // Test passed → the OpenVPN credentials are proven good: hide the fields
    // (back via Riconfigura / "Importa un'altra" / Remove). The Samba form
    // stays: Backup and Sync use DIFFERENT folders, each tab keeps its fields.
    if (_vpnType === 'openvpn') setOvpnCredsVisible(false);
  } else {
    const failedStep = result.steps?.find(s => !s.ok);
    const reason = failedStep
      ? (vpnStepLabel(failedStep) + (failedStep.detail ? ' — ' + vpnStepDetail(failedStep) : ''))
      : (result.error || window.i18n.t('sync.test_failed'));
    // The failed step row shows the detailed message — the summary box gives a
    // SHORT visible failure signal (a long wait ending in a tiny row note went
    // unnoticed), without duplicating the full reason.
    summary.className = 'test-summary fail';
    summary.textContent = '✗ ' + (failedStep ? window.i18n.t('sync.test_failed') : reason);
    // Also report the failure (WireGuard vs Samba/write) in the notifications.
    try { addEventNotif(window.i18n.t('sync.smbtest_title') + ': ' + reason, false); } catch (_) {}
  }

  $('btn-run-test').disabled = false;
}

// Null-safe reads: the WireGuard/Samba wizard UI was simplified over time, so
// some legacy inputs no longer exist. Reading `.value` off a missing element
// used to throw and silently abort the whole saveSettings() — never do that.
function buildVpnConfig() {
  const val = (id) => { const el = $(id); return el && typeof el.value === 'string' ? el.value.trim() : ''; };
  const raw = (id) => { const el = $(id); return el ? el.value : ''; };
  return {
    wgConfig: wizardState.wgConfig,
    peerIp: val('cfg-smb-ip'),
    smb: {
      ip: val('cfg-smb-ip'),
      share: val('cfg-smb-share'),
      path: val('cfg-smb-path'),
      username: raw('cfg-smb-user'),
      password: raw('cfg-smb-pass'),
      // No mount point: WireGuard+Samba always pushes over the amelie-smb
      // helper. The "share already mounted by the OS" case is configured as a
      // Local backup destination instead.
    },
    remotePath: val('cfg-smb-path'),
    // Two positive toggles: dated folder snapshot and/or .tar.gz archive.
    // "archive only" = archive requested but the folder snapshot turned off.
    // `folder` persisted explicitly so "both off" is representable (backup
    // then skips with a clear "no mode selected" error instead of guessing).
    folder: !!$('cfg-backup-normal')?.checked,
    archive: !!$('cfg-backup-archived')?.checked,
    archiveOnly: !!$('cfg-backup-archived')?.checked && !$('cfg-backup-normal')?.checked,
    keepLast: parseInt($('cfg-backup-keep')?.value) || 0,
  };
}

async function openSettings() {
  const cfg = await window.inkwell.readConfig();
  state.config = cfg;
  _smbExpanded = { backup: false, sync: false };   // each open starts collapsed-if-configured
  $('cfg-autosave').value = cfg.autoSaveSeconds || 3;

  // Restore VPN section open state if enabled
  const vpnEnabled = !!cfg.sync?.vpn?.enabled;
  $('cfg-vpn-enabled').checked = vpnEnabled;
  if (vpnEnabled) {
    $('ssb-vpn').style.display = 'flex';
    const chev = $('chevron-vpn'); if (chev) chev.classList.add('open');
  }
  const vpn = cfg.sync?.vpn;
  if (vpn) {
    // Null-safe: some legacy inputs may no longer exist in the simplified UI.
    const setVal = (id, v) => { const el = $(id); if (el) el.value = v; };
    setVal('cfg-smb-ip', vpn.smb?.ip || vpn.peerIp || '');
    setVal('cfg-smb-share', vpn.smb?.share    || '');
    setVal('cfg-smb-path',  vpn.smb?.path     || vpn.remotePath || cfg.sync?.samba?.remoteSubPath || 'amelie/backup');
    setVal('cfg-smb-user',  vpn.smb?.username || '');
    setVal('cfg-smb-pass',  vpn.smb?.password || '');
  }
  // Backup server fields empty but a Sync connection exists → prefill the
  // SERVER part from it (same shared connection); the folder stays empty
  // (Backup and Sync must use different folders).
  {
    const twS = cfg.sync?.twoway?.smb;
    if (twS && !($('cfg-smb-ip')?.value || '').trim()) {
      const setVal2 = (id, v) => { const el = $(id); if (el) el.value = v; };
      setVal2('cfg-smb-ip',    twS.ip || twS.host || '');
      setVal2('cfg-smb-share', twS.share    || '');
      setVal2('cfg-smb-user',  twS.username || '');
      setVal2('cfg-smb-pass',  twS.password || '');
    }
    // Prefill the Sync (two-way) Samba fields too, so the collapsed form shows
    // real values the moment it's expanded (Mostra configurazione / Riconfigura)
    // — without waiting for the Sync tab's updateTwowayConnView to run.
    if (twS) {
      const setTw = (id, v) => { const el = $(id); if (el) el.value = v || ''; };
      setTw('tw-smb-ip',    twS.ip || twS.host);
      setTw('tw-smb-share', twS.share);
      setTw('tw-smb-path',  twS.remoteSubPath || twS.path || 'amelie/sync');
      setTw('tw-smb-user',  twS.username);
      setTw('tw-smb-pass',  twS.password);
    }
  }

  // WebDAV
  const webdavEnabled = !!cfg.sync?.webdav?.enabled;
  $('cfg-webdav-enabled').checked = webdavEnabled;
  if (webdavEnabled) {
    $('ssb-webdav').style.display = 'flex';
    const chev = $('chevron-webdav'); if (chev) chev.classList.add('open');
  }
  $('cfg-webdav-url').value  = cfg.sync?.webdav?.url      || '';
  $('cfg-webdav-user').value = cfg.sync?.webdav?.username || '';
  $('cfg-webdav-pass').value = cfg.sync?.webdav?.password || '';
  $('cfg-webdav-path').value = cfg.sync?.webdav?.remotePath || '/amelie/backup';
  if ($('cfg-webdav-archive'))      $('cfg-webdav-archive').checked      = !!cfg.sync?.webdav?.archive;
  if ($('cfg-webdav-archive-only')) $('cfg-webdav-archive-only').checked = !!cfg.sync?.webdav?.archiveOnly;
  // STAGED WebDAV connections (Backup + Sync): the live fields can be edited
  // freely but only "Salva configurazione" commits them here → saveSettings.
  state._webdavSaved = {
    backup: {
      url:        cfg.sync?.webdav?.url        || '',
      username:   cfg.sync?.webdav?.username   || '',
      password:   cfg.sync?.webdav?.password   || '',
      remotePath: cfg.sync?.webdav?.remotePath || '',
    },
    sync: {
      url:        cfg.sync?.twoway?.webdav?.url        || '',
      username:   cfg.sync?.twoway?.webdav?.username   || '',
      password:   cfg.sync?.twoway?.webdav?.password   || '',
      remotePath: cfg.sync?.twoway?.webdav?.remotePath || '',
    },
  };

  // Local sync
  const localEnabled = !!cfg.sync?.local?.enabled;
  $('cfg-local-enabled').checked = localEnabled;
  if (localEnabled) {
    $('ssb-local').style.display = 'flex';
    const chev = $('chevron-local'); if (chev) chev.classList.add('open');
  }
  $('cfg-local-path').value = cfg.sync?.local?.path || '';
  // Backup destination tab: saved choice, else the enabled destination, else Local.
  updateBackupTransportView(cfg.sync?.backupTransport
    || (cfg.sync?.vpn?.enabled ? 'vpn' : cfg.sync?.webdav?.enabled ? 'webdav' : 'local'));
  // Restore GLOBAL backup format — two INDEPENDENT flags (folder and/or .tar.gz).
  const _L = cfg.sync?.local || {}, _V = cfg.sync?.vpn || {}, _W = cfg.sync?.webdav || {};
  const wantArchive = !!(_L.archive || _L.archiveOnly || _V.archive || _W.archive);
  // Folder snapshot: prefer the EXPLICIT `folder` flag saved per destination (so a
  // deliberate "both formats off" survives a reopen — it must NOT spring back on).
  // Legacy configs without it: derive from "archive only" (off) / nothing yet (on).
  const anyConfigured = !!(_L.path || _V.host || _V.share || _W.url);
  const explicitFolder = [_V.folder, _L.folder, _W.folder].find(v => v !== undefined);
  let wantFolder;
  if (explicitFolder !== undefined) {
    wantFolder = !!explicitFolder;
  } else {
    const archiveOnlyAll = !!(_L.archiveOnly || _W.archiveOnly);
    wantFolder = anyConfigured ? !archiveOnlyAll : true;
  }
  if ($('cfg-backup-archived')) $('cfg-backup-archived').checked = wantArchive;
  if ($('cfg-backup-normal'))   $('cfg-backup-normal').checked   = wantFolder;
  // Restore backup frequency: preset (60 / 1440) or Custom (in days).
  const blMin = parseInt(cfg.sync?.local?.intervalMinutes) || 1440;
  const blSel = $('cfg-local-interval');
  if (blSel) {
    if (blMin === 60 || blMin === 1440) {
      blSel.value = String(blMin);
      if ($('local-interval-custom-wrap')) $('local-interval-custom-wrap').style.display = 'none';
    } else {
      blSel.value = 'custom';
      if ($('cfg-local-interval-custom')) $('cfg-local-interval-custom').value = Math.max(1, Math.round(blMin / 1440));
      if ($('local-interval-custom-wrap')) $('local-interval-custom-wrap').style.display = 'flex';
    }
  }
  if ($('cfg-backup-keep'))    $('cfg-backup-keep').value    = String(cfg.sync?.local?.keepLast ?? 5);

  // Two-way sync (its own tab)
  if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = !!cfg.sync?.twoway?.enabled;
  try { if (window._refreshTwowayMethodToggles) window._refreshTwowayMethodToggles(); } catch (_) {}
  // Conflict toggle (On = keep both versions, Off = latest wins). Deletions
  // always propagate regardless. Default ON (no silent data loss on conflict).
  if ($('cfg-twoway-fullsync')) $('cfg-twoway-fullsync').checked = cfg.sync?.twoway?.conflictCopies !== false;
  // Two-way transport + WebDAV fields.
  {
    const tw = cfg.sync?.twoway || {};
    const wd = tw.webdav || {};
    if ($('tw-webdav-url'))  $('tw-webdav-url').value  = wd.url || '';
    if ($('tw-webdav-user')) $('tw-webdav-user').value = wd.username || '';
    if ($('tw-webdav-pass')) $('tw-webdav-pass').value = wd.password || '';
    if ($('tw-webdav-path')) $('tw-webdav-path').value = wd.remotePath || 'amelie/sync';
    const transport = tw.transport || 'samba';
    document.querySelectorAll('#tw-transport-pills .dlp').forEach(b => b.classList.toggle('active', b.dataset.transport === transport));
  }
  updateActionNowButtons();
  if ($('cfg-twoway-subpath'))  $('cfg-twoway-subpath').value  = cfg.sync?.twoway?.subPath || '';
  updateTwowayConnView();   // show the reused WireGuard+Samba connection
  // Restore two-way frequency: Real-time, a preset, or Custom.
  const twSel = $('cfg-twoway-interval');
  if (twSel) {
    if (cfg.sync?.twoway?.realtime) {
      twSel.value = 'realtime';
      if ($('twoway-custom-wrap')) $('twoway-custom-wrap').style.display = 'none';
    } else {
      const twMin = parseInt(cfg.sync?.twoway?.intervalMinutes) || 15;
      const presets = ['15', '60', '1440'];
      if (presets.includes(String(twMin))) {
        twSel.value = String(twMin);
        if ($('twoway-custom-wrap')) $('twoway-custom-wrap').style.display = 'none';
      } else {
        twSel.value = 'custom';
        if ($('cfg-twoway-interval-custom')) $('cfg-twoway-interval-custom').value = twMin;
        if ($('twoway-custom-wrap')) $('twoway-custom-wrap').style.display = 'flex';
      }
    }
  }
  if ($('cfg-vpn-archive'))        $('cfg-vpn-archive').checked        = !!(cfg.sync?.vpn?.archive || cfg.sync?.samba?.archive);
  // Folder toggle = the inverse of archiveOnly (folder snapshot happens unless
  // "archive only" was set). Defaults to ON for a fresh config.
  if ($('cfg-vpn-folder'))         $('cfg-vpn-folder').checked         = cfg.sync?.vpn?.folder !== undefined
    ? !!cfg.sync.vpn.folder
    : !(cfg.sync?.vpn?.archiveOnly || cfg.sync?.samba?.archiveOnly);
  updateVpnModeWarn();

  // Theme/appearance
  document.querySelectorAll('.theme-card').forEach(c =>
    c.classList.toggle('active', c.dataset.theme === state.theme));
  const ap = loadAppearance();
  const edSize   = ap.editorFontSize ?? 14;
  const treePy   = ap.treeSpacing    ?? 3;
  const treeSize = ap.treeFontSize   ?? 13;
  const fontKey  = ap.editorFont     ?? 'jetbrains';
  const tbZoom   = ap.toolbarZoom     ?? 100;
  updateNumberDdCurrent('edsize-dd', edSize,   'px');
  updateNumberDdCurrent('treesp-dd', treePy,   'px');
  updateNumberDdCurrent('treesz-dd', treeSize, 'px');
  updateNumberDdCurrent('tbsize-dd', tbZoom,   '%');
  updateFontDropdownCurrent(fontKey);
  updateDrawLocationPills(ap.drawLocation ?? 'root');
  updateNoteLocationPills(ap.noteLocation ?? 'current');

  wizardGo(1);
  // Show the compact "configured" summary instead of the wizard when WG+Samba
  // setup is already complete.
  updateWgConfiguredView();
  // Configured connection → only the "config loaded" row (Importa un'altra /
  // Riconfigura / Rimuovi) and the connection test stay visible in the wizards.
  refreshVpnWizardVisibility();
  // Always reopen on the DEFAULT (Vault/Security) tab — never the last sub-view
  // the user left open (Backup/Samba, Sync/VPN, WebDAV wizard…). The .active
  // class otherwise lingers in the DOM from the previous session and the modal
  // reopens deep in a half-configured panel instead of the overview.
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === 'security'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-security'));
  $('settings-modal').style.display = 'flex';
  // Vault is the default active tab: populate path/encryption right away.
  if (typeof openSecurityTab === 'function') openSecurityTab();
  window.inkwell.appVersion().then(v => {
    const el = $('about-version');
    if (el) el.textContent = v;
  }).catch(() => {});
}

function closeSettings() {
  $('settings-modal').style.display = 'none';
  stopWgStatusPolling();
  // A VPN imported in this session but never committed (no "Salva
  // configurazione"/"Salva connessione") is DISCARDED on close: form cleared,
  // flags off, files + NetworkManager connection removed — in both tabs.
  if (state._vpnStaged) {
    state._vpnStaged = false;
    wizardState.wgConfig = null;
    resetVpnWizardUi();
    if ($('cfg-vpn-enabled'))    $('cfg-vpn-enabled').checked    = false;
    if ($('cfg-twoway-enabled')) $('cfg-twoway-enabled').checked = false;
    if ($('cfg-tw-webdav-enabled')) $('cfg-tw-webdav-enabled').checked = false;
    if ($('cfg-tw-samba-enabled'))  $('cfg-tw-samba-enabled').checked  = false;
    window.inkwell.wg.removeSyncConnection().then(async () => {
      try { state.config = await window.inkwell.readConfig(); } catch (_) {}
      updateVpnConfiguredBadge();
      updateActionNowButtons();
    }).catch(() => {});
  }
  state._backupSmbTested = null;   // an uncommitted test dies with the modal
  saveSettings();
}

async function saveSettings() {
  const vpnCfg = buildVpnConfig();
  const config = {
    autoSaveSeconds: parseInt($('cfg-autosave').value) || 3,
    sync: {
      enabled: !!$('cfg-vpn-enabled')?.checked || $('cfg-webdav-enabled').checked
        || !!$('cfg-local-enabled').checked || !!$('cfg-twoway-enabled')?.checked,
      // Which backup destination tab is shown (Local / WireGuard+Samba / WebDAV).
      backupTransport: (document.querySelector('#bk-transport-pills .dlp.active')?.dataset.bktransport)
        || state.config?.sync?.backupTransport || 'local',
      vpn: { enabled: !!$('cfg-vpn-enabled')?.checked, ...vpnCfg },
      // The WG+Samba backup connection: persisted HERE (the test only
      // verifies and parks it in state._backupSmbTested). Its enabled state
      // always follows the flag.
      samba: (() => {
        const t = state._backupSmbCommitted;
        const prev = state.config?.sync?.samba;
        if (!t && !prev) return undefined;
        const base = t
          ? { host: t.ip, share: t.share, remoteSubPath: t.path || '', username: t.username, password: t.password, useWireGuard: true }
          : prev;
        return { ...base, enabled: !!$('cfg-vpn-enabled')?.checked };
      })(),
      webdav: {
        enabled: $('cfg-webdav-enabled').checked,
        // WebDAV connection is STAGED: persisted ONLY by "Salva configurazione"
        // (which writes state._webdavSaved.backup), NOT auto-saved while typing.
        url:        state._webdavSaved?.backup?.url        ?? (state.config?.sync?.webdav?.url || ''),
        username:   state._webdavSaved?.backup?.username   ?? (state.config?.sync?.webdav?.username || ''),
        password:   state._webdavSaved?.backup?.password   ?? (state.config?.sync?.webdav?.password || ''),
        remotePath: state._webdavSaved?.backup?.remotePath || (state.config?.sync?.webdav?.remotePath || '/amelie/backup'),
        folder: !!$('cfg-backup-normal')?.checked,   // explicit: false = no folder snapshot (lets both formats be off)
        archive: !!$('cfg-backup-archived')?.checked,
        archiveOnly: !!$('cfg-backup-archived')?.checked && !$('cfg-backup-normal')?.checked,
        keepLast: parseInt($('cfg-backup-keep')?.value) || 0,
      },
      local: (() => {
        // Backup is ONE-WAY (local → remote). GLOBAL format: folder snapshot
        // and/or .tar.gz (both independent). archiveOnly only when archived AND
        // the folder snapshot is off → skips the folder, keeps just the .tar.gz.
        const wantArchive = !!$('cfg-backup-archived')?.checked;
        const wantFolder  = !!$('cfg-backup-normal')?.checked;
        return {
          enabled: !!$('cfg-local-enabled').checked,
          path: $('cfg-local-path').value.trim(),
          folder: wantFolder,   // explicit: false = no folder snapshot (lets both formats be off)
          archive: wantArchive,
          archiveOnly: wantArchive && !wantFolder,
          intervalMinutes: (() => {
            const v = $('cfg-local-interval')?.value;
            if (v === 'custom') return (parseInt($('cfg-local-interval-custom')?.value) || 2) * 1440; // days → minutes
            return parseInt(v) || 1440;
          })(),
          keepLast: parseInt($('cfg-backup-keep')?.value) || 0,
        };
      })(),
      // Two-way sync (read remote + update local + push). Separate from backup.
      twoway: {
        enabled: !!$('cfg-twoway-enabled')?.checked,
        useWireGuard: true,
        // Transport: 'samba' (WireGuard+Samba, default) or 'webdav'.
        transport: (document.querySelector('#tw-transport-pills .dlp.active')?.dataset.transport)
          || state.config?.sync?.twoway?.transport || 'samba',
        // WebDAV two-way connection (used when transport === 'webdav'). STAGED:
        // persisted ONLY by "Salva configurazione" (state._webdavSaved.sync).
        webdav: {
          url:        state._webdavSaved?.sync?.url        ?? (state.config?.sync?.twoway?.webdav?.url || ''),
          username:   state._webdavSaved?.sync?.username   ?? (state.config?.sync?.twoway?.webdav?.username || ''),
          password:   state._webdavSaved?.sync?.password   ?? (state.config?.sync?.twoway?.webdav?.password || ''),
          remotePath: state._webdavSaved?.sync?.remotePath || (state.config?.sync?.twoway?.webdav?.remotePath || 'amelie/sync'),
        },
        // PRESERVE the dedicated two-way Samba connection saved by "Configure &
        // verify" — it lives only in config (no form field), so rebuilding the
        // config here would otherwise wipe it and break syncing.
        smb: state.config?.sync?.twoway?.smb,
        subPath: $('cfg-twoway-subpath')?.value.trim() || '',
        // Single toggle = conflict handling only (On = keep both, Off = latest
        // wins). Deletions ALWAYS propagate, regardless of this toggle.
        conflictCopies: !!$('cfg-twoway-fullsync')?.checked,
        propagateDeletes: true,
        realtime: $('cfg-twoway-interval')?.value === 'realtime',
        intervalMinutes: (() => {
          const v = $('cfg-twoway-interval')?.value;
          if (v === 'realtime') return 15;   // backstop interval (also pulls other devices' changes)
          if (v === 'custom') return parseInt($('cfg-twoway-interval-custom')?.value) || 15;
          return parseInt(v) || 15;
        })(),
      },
    }
  };
  await window.inkwell.writeConfig(config);
  state.config = config;
  state._backupSmbCommitted = null;   // now persisted in config.sync.samba
  updateSyncButtonVisibility();
  updateActionNowButtons();
}


// ─── Sync UI ──────────────────────────────────────────────────────────────────
// The sync/backup button only makes sense when a backup method is enabled in
// Settings → Backup; otherwise it's hidden.
// Sync tab: show the reused WireGuard+Samba connection (or a "set it up" note).
// Human-readable two-way sync result: "✓ Sincronizzato — 105 file inviati, 0
// ricevuti" (with up/down counts). Falls back to a plain OK when no counts.
function _fmtSyncResult(r) {
  const up = (typeof r?.uploaded === 'number') ? r.uploaded : null;
  const dn = (typeof r?.downloaded === 'number') ? r.downloaded : null;
  if (up === null && dn === null) return '✓ ' + window.i18n.t('toast.sync_ok');
  if ((up || 0) === 0 && (dn || 0) === 0) return '✓ ' + window.i18n.t('toast.sync_nochange');
  const counts = window.i18n.t('toast.sync_counts')
    .replace('{up}', up ?? 0)
    .replace('{down}', dn ?? 0);
  return '✓ ' + window.i18n.t('toast.sync_done') + ' — ' + counts;
}

// Mirrors updateWgConfiguredView (Backup) but for the Sync tab. Shows the
// configured summary (status + endpoint + share + Remove/Reconfigure/Verify)
// when a two-way connection exists; otherwise shows the same wizard as Backup.
// Backup destination chooser (pills like the Sync transport): show ONE of the
// three destination sections at a time (Local / WireGuard+Samba / WebDAV). The
// per-section enable toggle still controls what's active — this only switches the
// visible section. Persisted in sync.backupTransport (which tab to show on open).
function updateBackupTransportView(transport) {
  const t = transport
    || (document.querySelector('#bk-transport-pills .dlp.active')?.dataset.bktransport)
    || 'local';
  document.querySelectorAll('#bk-transport-pills .dlp').forEach(b => b.classList.toggle('active', b.dataset.bktransport === t));
  const sec = { local: 'bksec-local', vpn: 'bksec-vpn', webdav: 'bksec-webdav' };
  const body = { local: 'ssb-local', vpn: 'ssb-vpn', webdav: 'ssb-webdav' };
  const chev = { local: 'chevron-local', vpn: 'chevron-vpn', webdav: 'chevron-webdav' };
  Object.entries(sec).forEach(([k, id]) => { const el = $(id); if (el) el.style.display = (k === t) ? 'block' : 'none'; });
  const b = $(body[t]); if (b) b.style.display = 'flex';          // tab = expanded
  const c = $(chev[t]); if (c) c.classList.add('open');
}

async function updateTwowayConnView(forceEdit = false) {
  // Transport chooser: Samba (WireGuard) vs WebDAV. With WebDAV we hide the whole
  // Samba wizard/summary and show the WebDAV panel instead.
  const transport = state.config?.sync?.twoway?.transport || 'samba';
  document.querySelectorAll('#tw-transport-pills .dlp').forEach(b => b.classList.toggle('active', b.dataset.transport === transport));
  const webPanel = $('tw-webdav-panel');
  // Show as FLEX (not block) so the .wizard-panel column `gap` actually applies —
  // with display:block the 18px gap between fields is ignored and they crowd.
  if (webPanel) webPanel.style.display = transport === 'webdav' ? 'flex' : 'none';
  if (transport === 'webdav') {
    if ($('twoway-conn-ok')) $('twoway-conn-ok').style.display = 'none';
    if ($('twoway-conn-missing')) $('twoway-conn-missing').style.display = 'none';
    return;
  }
  const tw = state.config?.sync?.twoway?.smb;
  const v = state.config?.sync?.vpn;
  const backupSmb = (v && v.smb) || state.config?.sync?.samba;
  // The Sync view is "configured" ONLY by its OWN saved connection — the
  // backup's one must not make this tab look configured (and vice versa).
  const host = tw && (tw.ip || tw.host);
  const share = tw && tw.share;
  const configured = !!(host && share) && !forceEdit;
  const ok = $('twoway-conn-ok'), missing = $('twoway-conn-missing'), shareEl = $('twoway-conn-share');
  if (ok) ok.style.display = configured ? 'flex' : 'none';
  if (missing) missing.style.display = configured ? 'none' : 'block';

  if (configured) {
    if (shareEl) shareEl.textContent = (`//${host}/${share}`).replace(/\/$/, '');
    // Peer endpoint from the saved .conf.
    try { const c = await window.inkwell.wg.getConf(); const ep = (c?.parsed?.endpoint && c.parsed.endpoint !== '?') ? c.parsed.endpoint : c?.ovpnParsed?.endpoint; const e = $('tw-cfg-endpoint'); if (e) e.textContent = ep || '—'; } catch (_) {}
    // One-shot tunnel status (last handshake) — no continuous ping.
    try { updateTunnelStatusInto('tw-wg-badge', 'tw-wg-state'); } catch (_) {}
    // VPN details hidden behind "Show config" (don't expose them by default).
    _armVpnConfigToggle('tw-cfg-parsed');
    return;
  }

  // Wizard mode: detect whether a WireGuard .conf is already imported (e.g. from
  // the Backup, or a previous load) so the user can REUSE it instead of
  // re-importing. Also prefill Samba fields from any known backup connection.
  let confExists = false;
  try { const c = await window.inkwell.wg.getConf(); confExists = !!(c && c.exists); } catch (_) {}
  const drop = $('tw-wg-drop-zone'), already = $('tw-wg-already');
  // Show the "config loaded" row (with Show/Modify config · Import another ·
  // Remove) whenever a WireGuard config exists — even if it was imported HERE in
  // the Sync tab. Before, origin==='sync' hid it, leaving no Remove/Reconfigure.
  if (drop)    drop.style.display    = confExists ? 'none' : '';
  if (already) already.style.display = confExists ? 'flex' : 'none';
  if (confExists) { try { _armVpnConfigToggle('tw-wg-parsed'); } catch (_) {} }
  _twHasSavedConf = confExists;
  // "Test connection" stays grey until a VPN config is loaded/saved (you can't
  // test before there's a connection to test).
  const stTest = $('tw-setup-test');
  if (stTest) stTest.classList.toggle('tc-disabled', !confExists);
  // Riconfigura: a two-way connection was already saved → show ITS own values in
  // the wizard, including the remote folder (lives in remoteSubPath and has no
  // other form field, so it was disappearing on reconfigure). Otherwise (first
  // setup) prefill only the shared server fields from any known backup connection.
  if (tw && (tw.ip || tw.host || tw.share)) {
    const force = (id, val) => { const el = $(id); if (el) el.value = val || ''; };
    force('tw-smb-ip',    tw.ip || tw.host);
    force('tw-smb-share', tw.share);
    force('tw-smb-path',  tw.remoteSubPath);
    force('tw-smb-user',  tw.username);
    force('tw-smb-pass',  tw.password);
  } else if (backupSmb) {
    const set = (id, val) => { const el = $(id); if (el && !el.value) el.value = val || ''; };
    set('tw-smb-ip',    backupSmb.ip || backupSmb.host || (v && v.peerIp));
    set('tw-smb-share', backupSmb.share);
    set('tw-smb-user',  backupSmb.username);
    set('tw-smb-pass',  backupSmb.password);
  }
}
let _twHasSavedConf = false;

// A remote destination can be ENABLED only after its connection test has passed.
// "Tested" = passed this session (session flag) OR already saved in the config
// (a saved destination was tested when it was set up, so it stays enable-able).
function backupSmbTested() {
  const v = state.config?.sync?.vpn?.smb, sa = state.config?.sync?.samba;
  return !!state._backupSmbTested
    || !!(v && (v.ip || v.host) && v.share)
    || !!(sa && (sa.ip || sa.host) && sa.share);
}
function backupWebdavTested() {
  return !!state._backupWebdavTested || !!state.config?.sync?.webdav?.url;
}
function syncSmbTested() {
  const tw = state.config?.sync?.twoway?.smb;
  return !!_twHasSavedConf || !!(tw && (tw.ip || tw.host) && tw.share);
}
function syncWebdavTested() {
  return !!state._twWebdavTested || !!state.config?.sync?.twoway?.webdav?.url;
}

function updateSyncButtonVisibility() {
  // Local UI preference: hide the toolbar Backup/Sync icons entirely (Settings →
  // Appearance), regardless of whether a destination is configured.
  const hide = localStorage.getItem('amelie-hide-syncbackup') === '1';
  const btn = $('btn-sync');
  if (btn) {
    // The toolbar Sync button drives the TWO-WAY sync, so show it only when
    // two-way sync is enabled.
    const enabled = !!state.config?.sync?.twoway?.enabled;
    btn.style.display = (!hide && enabled) ? '' : 'none';
  }
  // Global "Backup ora": visible whenever ANY backup destination is enabled
  // (Local folder, Samba/WireGuard, or WebDAV). One click forces a one-way
  // backup to ALL enabled destinations at once (runBackup → _runBackupInner).
  const bbtn = $('btn-backup-global');
  if (bbtn) {
    const s = state.config?.sync || {};
    const anyBackup = !!(s.local?.enabled || s.vpn?.enabled || s.samba?.enabled || s.webdav?.enabled);
    bbtn.style.display = (!hide && anyBackup) ? '' : 'none';
  }
}

function setupSync() {
  updateSyncButtonVisibility();

  // "Hide Backup/Sync icons" appearance toggle (local UI pref in localStorage).
  const hideCb = $('cfg-hide-syncbackup');
  if (hideCb) {
    hideCb.checked = localStorage.getItem('amelie-hide-syncbackup') === '1';
    hideCb.addEventListener('change', () => {
      if (hideCb.checked) localStorage.setItem('amelie-hide-syncbackup', '1');
      else localStorage.removeItem('amelie-hide-syncbackup');
      updateSyncButtonVisibility();
    });
  }

  // Global "Backup ora" toolbar button — forces a one-way backup to every
  // enabled destination (Local + Samba/WireGuard + WebDAV) via triggerBackup.
  const backupBtn = $('btn-backup-global');
  if (backupBtn) backupBtn.addEventListener('click', async () => {
    const dot = $('backup-status');
    if (dot) dot.className = 'sync-syncing';
    showToast(window.i18n.t('toast.backup_running'));
    const result = await window.inkwell.triggerBackup();
    if (result && result.success) {
      if (dot) dot.className = 'sync-ok';
      // Manual backup → say so, with the time (like the manual sync notif).
      const when = (() => { const d = new Date(), p2 = n => String(n).padStart(2, '0'); return p2(d.getHours()) + ':' + p2(d.getMinutes()); })();
      const msgBase = window.i18n.t('toast.manual_backup_ok');
      showToast('✓ ' + msgBase + ' (' + when + ')');
      // Success is shown as a toast; the bell is reserved for failures.
    } else if (result && result.noDestination) {
      // Nothing selected — clear message, not a "failure".
      if (dot) dot.className = 'sync-idle';
      showToast(window.i18n.t('toast.no_backup_dest'));
    } else {
      // No red flash on the icon — logSyncEventNotif files the failure in the bell.
      if (dot) dot.className = 'sync-idle';
    }
    if (dot) setTimeout(() => dot.className = 'sync-idle', 4000);
  });

  $('btn-sync').addEventListener('click', async () => {
    syncStatusDot.className = 'sync-syncing';
    showToast(window.i18n.t('toast.syncing'));
    const result = await window.inkwell.triggerTwoway();
    await loadTree(); // Refresh tree after sync
    if (result.success) {
      syncStatusDot.className = 'sync-ok';
      const r2 = (result.results && result.results.twoway) || {};
      // Success shows as a toast + the green dot; the bell is reserved for failures.
      showToast(_fmtSyncResult(r2));
    } else {
      // No error flash on the icon — logSyncEventNotif files the failure in the bell.
      syncStatusDot.className = 'sync-idle';
    }
    setTimeout(() => syncStatusDot.className = 'sync-idle', 4000);
  });

  window.inkwell.onSyncStatus(data => {
    // Automatic/background syncs (e.g. the initial one at startup) must NOT pulse
    // the icon orange — leave it neutral while they run and only go green when
    // they finish. (The manual buttons set their own "syncing" state.)
    if (data.status === 'ok') {
      syncStatusDot.className = 'sync-ok';
      loadTree();
      setTimeout(() => syncStatusDot.className = 'sync-idle', 4000);
    } else if (data.status === 'error') {
      // Don't flash the icon orange/red; the error is reported via notifications.
      syncStatusDot.className = 'sync-idle';
      console.error('[Sync error]', data.error);
    }
    logSyncEventNotif(data);
  });

  // Refresh the sidebar tree when notes/folders are added, deleted or renamed on disk
  // from OUTSIDE the app (file manager, external sync) — no restart needed. loadTree()
  // re-reads the vault; the note open in the editor is left untouched. Debounced in main.
  window.inkwell.onVaultChanged?.(() => { try { loadTree(); } catch (_) {} });
}

// ─── Configurable shortcuts ───────────────────────────────────────────────────
const DEFAULT_SHORTCUTS = {
  // "Salva nota" (Ctrl+S) removed from the configurable list (the note auto-saves);
  // Ctrl/Cmd+S is still handled (hardcoded) in setupKeyboard as a silent force-save.
  newNote:    { ctrl:true,  shift:false, alt:false, key:'n',   group:'Note',    gk:'sc.group_notes',  label:'Nuova nota',          lk:'sc.new_note' },
  closeTab:   { ctrl:true,  shift:false, alt:false, key:'w',   group:'Note',    gk:'sc.group_notes',  label:'Chiudi tab',          lk:'sc.close_tab' },
  nextTab:    { ctrl:true,  shift:false, alt:false, key:'tab', group:'Note',    gk:'sc.group_notes',  label:'Tab successivo',       lk:'sc.next_tab' },
  prevTab:    { ctrl:true,  shift:true,  alt:false, key:'tab', group:'Note',    gk:'sc.group_notes',  label:'Tab precedente',       lk:'sc.prev_tab' },
  toggleView: { ctrl:true,  shift:false, alt:false, key:'p',   group:'Editor',  gk:'sc.group_editor', label:'Modifica / Anteprima', lk:'sc.toggle_view' },
  bold:       { ctrl:true,  shift:false, alt:false, key:'b',   group:'Editor',  gk:'sc.group_editor', label:'Grassetto',           lk:'sc.bold' },
  italic:     { ctrl:true,  shift:false, alt:false, key:'i',   group:'Editor',  gk:'sc.group_editor', label:'Corsivo',             lk:'sc.italic' },
  bullet:     { ctrl:true,  shift:false, alt:false, key:'l',   group:'Editor',  gk:'sc.group_editor', label:'Lista puntata',       lk:'sc.bullet' },
  code:       { ctrl:true,  shift:false, alt:false, key:'e',   group:'Editor',  gk:'sc.group_editor', label:'Codice',              lk:'sc.code' },
  checklist:  { ctrl:true,  shift:false, alt:false, key:'t',   group:'Editor',  gk:'sc.group_editor', label:'Checklist',           lk:'sc.checklist' },
  link:       { ctrl:true,  shift:false, alt:false, key:'k',   group:'Editor',  gk:'sc.group_editor', label:'Link',                lk:'sc.link' },
  search:     { ctrl:true,  shift:false, alt:false, key:'f',   group:'Editor',  gk:'sc.group_editor', label:'Cerca nella nota',    lk:'sc.search' },
  undo:       { ctrl:true,  shift:false, alt:false, key:'z',   group:'Editor',  gk:'sc.group_editor', label:'Annulla',             lk:'sc.undo' },
  redo:       { ctrl:true,  shift:false, alt:false, key:'y',   group:'Editor',  gk:'sc.group_editor', label:'Ripeti',              lk:'sc.redo' },
  toc:        { ctrl:true,  shift:true,  alt:false, key:'o',   group:'Vista',   gk:'sc.group_view',   label:'Indice',              lk:'sc.toc' },
  graph:      { ctrl:true,  shift:false, alt:false, key:'m',   group:'Vista',   gk:'sc.group_view',   label:'Graph view',          lk:'sc.graph' },
  canvas:     { ctrl:true,  shift:true,  alt:false, key:'c',   group:'Vista',   gk:'sc.group_view',   label:'Canvas',              lk:'sc.canvas' },
};
const shortcuts = {};

function loadShortcuts() {
  for (const id of Object.keys(DEFAULT_SHORTCUTS)) shortcuts[id] = { ...DEFAULT_SHORTCUTS[id] };
  try {
    const saved = JSON.parse(localStorage.getItem('amelie-shortcuts') || '{}');
    for (const id of Object.keys(saved)) {
      if (shortcuts[id]) Object.assign(shortcuts[id], saved[id]);
    }
  } catch(_) {}
  // Sanitize: a custom shortcut without Ctrl/Alt/Cmd (bare key or Shift-only)
  // can't work while typing in the editor — revert it to its default (which has
  // a modifier) so every shortcut works everywhere. Persist the cleanup.
  let changed = false;
  for (const id of Object.keys(shortcuts)) {
    const s = shortcuts[id];
    if (!s.ctrl && !s.alt && !s.meta) { shortcuts[id] = { ...DEFAULT_SHORTCUTS[id] }; changed = true; }
  }
  if (changed) { try { saveShortcuts(); } catch(_) {} }
}

function saveShortcuts() {
  const out = {};
  for (const id of Object.keys(shortcuts)) {
    const d = DEFAULT_SHORTCUTS[id], c = shortcuts[id];
    if (c.key !== d.key || c.ctrl !== d.ctrl || c.shift !== d.shift || c.alt !== d.alt)
      out[id] = { key: c.key, ctrl: c.ctrl, shift: c.shift, alt: c.alt };
  }
  try { localStorage.setItem('amelie-shortcuts', JSON.stringify(out)); } catch(_) {}
}

function matchSC(e, id) {
  const sc = shortcuts[id]; if (!sc) return false;
  return e.key.toLowerCase() === sc.key.toLowerCase()
    && !!e.ctrlKey === sc.ctrl && !!e.shiftKey === sc.shift && !!e.altKey === (sc.alt||false);
}

function fmtSC(sc) {
  const p = [];
  if (sc.ctrl)  p.push('Ctrl');
  if (sc.alt)   p.push('Alt');
  if (sc.shift) p.push('Shift');
  p.push(sc.key === 'tab' ? 'Tab' : sc.key.length === 1 ? sc.key.toUpperCase() : sc.key);
  return p.join('+');
}

// True if `combo` (key/ctrl/shift/alt) is already bound to a DIFFERENT command —
// used to block assigning one shortcut to two commands.
function shortcutConflict(combo, exceptId) {
  const k = (combo.key || '').toLowerCase();
  return Object.keys(shortcuts).find(id => id !== exceptId
    && (shortcuts[id].key || '').toLowerCase() === k
    && !!shortcuts[id].ctrl  === !!combo.ctrl
    && !!shortcuts[id].shift === !!combo.shift
    && !!shortcuts[id].alt   === !!combo.alt) || null;
}

// Keep the Bold/Italic toolbar tooltips showing the CURRENT shortcut (they used
// to be hardcoded "Ctrl+B"/"Ctrl+I" in i18n). Re-run on load, on a binding
// change, and on language change.
function updateToolbarShortcutTips() {
  const setTip = (btn, key, scId) => {
    if (!btn) return;
    const base = window.i18n.t(key);
    const sc = shortcuts[scId];
    btn.title = (sc && (sc.ctrl || sc.alt || sc.shift)) ? `${base} (${fmtSC(sc)})` : base;
  };
  [['bold', 'toolbar.bold'], ['italic', 'toolbar.italic'], ['bullet', 'toolbar.bullet'],
   ['code', 'toolbar.code'], ['checklist', 'toolbar.checklist'], ['link', 'toolbar.link']
  ].forEach(([id, key]) => setTip(document.querySelector(`.tool-btn[data-cmd="${id}"]`), key, id));
  // Header Undo/Redo buttons (by id) — tooltip shows the current shortcut too.
  setTip(document.getElementById('btn-undo'), 'toolbar.undo', 'undo');
  setTip(document.getElementById('btn-redo'), 'toolbar.redo', 'redo');
}

let _scRecordId = null, _scRecordHandler = null;

function renderShortcutsTab() {
  const container = $('tab-shortcuts');
  if (!container) return;
  if (_scRecordId) cancelShortcutRecord();
  container.innerHTML = '';
  const hint = document.createElement('div');
  hint.className = 'sc-hint';
  hint.style.cssText = 'grid-column:1 / -1';
  hint.textContent = window.i18n.t('shortcuts.modifier_required');
  container.appendChild(hint);
  const groups = {};
  for (const [id, sc] of Object.entries(shortcuts)) {
    const gk = sc.gk || sc.group;
    (groups[gk] = groups[gk] || []).push({ id, ...sc });
  }
  for (const [gk, items] of Object.entries(groups)) {
    const grp = document.createElement('div');
    grp.className = 'sc-group';
    const ttl = document.createElement('div');
    ttl.className = 'sc-group-title';
    ttl.textContent = window.i18n.t(gk);
    grp.appendChild(ttl);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'sc-row sc-row-editable';
      const lbl = document.createElement('span');
      lbl.className = 'sc-label'; lbl.textContent = item.lk ? window.i18n.t(item.lk) : item.label;
      const badge = document.createElement('span');
      badge.className = 'sc-badge'; badge.textContent = fmtSC(item);
      const btn = document.createElement('button');
      btn.className = 'sc-change-btn'; btn.textContent = window.i18n.t('common.change');
      btn.addEventListener('click', () => startShortcutRecord(item.id, badge, btn));
      row.append(lbl, badge, btn);
      grp.appendChild(row);
    }
    container.appendChild(grp);
  }
  // Reset button
  const resetWrap = document.createElement('div');
  resetWrap.style.cssText = 'margin-top:4px;display:flex;justify-content:flex-end;grid-column:1 / -1';
  const resetBtn = document.createElement('button');
  // btn-test → matches every other settings action button (uniform 30px height,
  // right-aligned via the wrapper). NOT sc-change-btn (that's the small per-row
  // keybind button, which made this Reset look undersized).
  resetBtn.className = 'btn-test';
  resetBtn.textContent = window.i18n.t('shortcuts.reset_defaults');
  resetBtn.addEventListener('click', () => {
    try { localStorage.removeItem('amelie-shortcuts'); } catch(_) {}
    loadShortcuts();
    renderShortcutsTab();
  });
  resetWrap.appendChild(resetBtn);
  container.appendChild(resetWrap);
}

function startShortcutRecord(id, badgeEl, btnEl) {
  if (_scRecordId) cancelShortcutRecord();
  _scRecordId = id;
  badgeEl.textContent = window.i18n.t('shortcuts.press_key');
  badgeEl.classList.add('recording');
  btnEl.textContent = window.i18n.t('common.cancel');
  const prevClick = btnEl.onclick;
  btnEl.onclick = () => { cancelShortcutRecord(); };
  _scRecordHandler = e => {
    if (['control','shift','alt','meta'].includes(e.key.toLowerCase())) return;
    if (e.key === 'Escape') { cancelShortcutRecord(); return; }
    e.preventDefault(); e.stopPropagation();
    // Require Ctrl or Alt (or Cmd): a Shift-only / bare-key shortcut collides
    // with typing, so it would never work inside the editor. Reject and keep
    // listening until the user presses a combo with a real modifier.
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      badgeEl.textContent = window.i18n.t('shortcuts.need_modifier');
      return;
    }
    const combo = { key: e.key.toLowerCase(), ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
    // Refuse a shortcut already bound to another command — keep listening so the
    // user can pick a different combo.
    if (shortcutConflict(combo, id)) {
      badgeEl.textContent = window.i18n.t('shortcuts.conflict');
      return;
    }
    shortcuts[id] = { ...shortcuts[id], ...combo };
    saveShortcuts();
    updateToolbarShortcutTips();   // refresh Bold/Italic tooltips if they changed
    badgeEl.textContent = fmtSC(shortcuts[id]);
    badgeEl.classList.remove('recording');
    btnEl.textContent = window.i18n.t('common.change');
    btnEl.onclick = prevClick;
    document.removeEventListener('keydown', _scRecordHandler, true);
    _scRecordId = null; _scRecordHandler = null;
  };
  document.addEventListener('keydown', _scRecordHandler, true);
}

function cancelShortcutRecord() {
  if (_scRecordHandler) document.removeEventListener('keydown', _scRecordHandler, true);
  _scRecordId = null; _scRecordHandler = null;
  renderShortcutsTab();
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
function setupKeyboard() {
  document.addEventListener('keydown', async e => {
    // Shortcut dispatch for ANY modifier combo the user set. matchSC checks the
    // exact key+modifier set. A combo WITHOUT Ctrl/Cmd/Alt (a bare key, or
    // Shift+key) would collide with normal typing, so honour it only when focus
    // isn't in a text field (editor/inputs) — fires from the sidebar/preview.
    {
      const a = document.activeElement;
      const inText = !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      const fires = (id) => {
        if (!matchSC(e, id)) return false;
        const s = shortcuts[id];
        return (s.ctrl || s.alt || e.metaKey) ? true : !inText;   // modifierless/Shift-only: only outside text fields
      };
      // Ctrl/Cmd+S still force-saves (hardcoded — no longer a configurable shortcut).
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); await saveCurrentNote(); return; }
      if (fires('newNote'))    { e.preventDefault(); await createNewNote(newNoteFolder()); return; }
      if (fires('toggleView')) { e.preventDefault(); toggleViewMode(); return; }
      if (fires('search'))     { e.preventDefault(); toggleNoteSearch(); return; }
      if (fires('closeTab'))   { e.preventDefault(); if (activeTabIdx !== -1) closeTab(activeTabIdx); return; }
      if (fires('toc'))        { e.preventDefault(); toggleTOC(); return; }
      if (fires('graph'))      { e.preventDefault(); const ov=$('mindmap-overlay'); if(!ov.style.display||ov.style.display==='none') openMindmap(); else closeMindmap(); return; }
      if (fires('canvas'))     { e.preventDefault(); toggleCanvas(); return; }
      if (fires('nextTab') || fires('prevTab')) {
        e.preventDefault();
        if (tabs.length > 1) {
          const next = matchSC(e,'prevTab') ? (activeTabIdx-1+tabs.length)%tabs.length : (activeTabIdx+1)%tabs.length;
          await switchTab(next);
        }
        return;
      }
      if (matchSC(e,'bold')      && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('bold'); return; }
      if (matchSC(e,'italic')    && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('italic'); return; }
      if (matchSC(e,'bullet')    && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('bullet'); return; }
      if (matchSC(e,'code')      && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('code'); return; }
      if (matchSC(e,'checklist') && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('checklist'); return; }
      if (matchSC(e,'link')      && editorHasFocus()) { e.preventDefault(); handleToolbarCmd('link'); return; }
      // undo/redo: let CM's own history handle it (its keymap has Ctrl+Z/Y); only
      // drive execCommand for the legacy textarea.
      if (matchSC(e,'undo')      && editorHasFocus() && !_cmActive) { e.preventDefault(); document.execCommand('undo'); return; }
      if (matchSC(e,'redo')      && editorHasFocus() && !_cmActive) { e.preventDefault(); document.execCommand('redo'); return; }
    }
    if (e.key === 'Escape') {
      closeSettings();
      $('context-menu').style.display = 'none';
      if (searchInput === document.activeElement) { searchInput.value=''; state.searchQuery=''; renderTree(); }
    }
  });
}

// ─── Sidebar resize ───────────────────────────────────────────────────────────
function setupResize() {
  const handle  = $('resize-handle');
  const sidebar = $('sidebar');
  if (!handle || !sidebar) return;

  const MIN_W = 235, MAX_W = 480, DEFAULT_W = 235;

  // Restore saved width
  const saved = parseInt(localStorage.getItem('amelie-sidebar-w'));
  if (saved && saved >= MIN_W && saved <= MAX_W) sidebar.style.width = saved + 'px';

  // Keep sidebar-section-tabs always the same width as sidebar
  const sst = $('sidebar-section-tabs');
  const syncSSTWidth = () => { if (sst) sst.style.width = sidebar.offsetWidth + 'px'; };
  syncSSTWidth();
  new ResizeObserver(syncSSTWidth).observe(sidebar);

  let dragging = false, startX, startW;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(MIN_W, Math.min(MAX_W, startW + (e.clientX - startX)));
    sidebar.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor    = '';
    document.body.style.userSelect = '';
    handle.classList.remove('dragging');
    // Persist
    try { localStorage.setItem('amelie-sidebar-w', sidebar.offsetWidth); } catch(_) {}
  });

  // Double-click → reset to default width
  handle.addEventListener('dblclick', () => {
    sidebar.style.width = DEFAULT_W + 'px';
    try { localStorage.setItem('amelie-sidebar-w', DEFAULT_W); } catch(_) {}
  });
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function findNote(nodes, path) {
  for (const n of nodes) {
    if (n.type === 'note' && n.path === path) return n;
    if (n.type === 'folder') { const f = findNote(n.children, path); if (f) return f; }
  }
  return null;
}

// ─── Canvas (Excalidraw iframe) ───────────────────────────────────────────────

let canvasSaveTimer = null;
let activeCanvasPath = null;
// Latest LIVE snapshot of the on-screen drawing (from CANVAS_CHANGE). Export reads
// this instead of the disk file, which can lag up to the 1.5s autosave debounce
// (exporting right after drawing would otherwise produce a stale/empty file).
let _liveCanvasJson = null;
let canvasIframeReady = false;
const EMPTY_DRAW = '{}';

function setupCanvas() {
  $('btn-canvas').addEventListener('click', () => {
    // Toggle: clicking the icon while a draw is already on screen closes it and
    // returns to the notes (a re-click never spawns a second draw file).
    const ov = $('canvas-overlay');
    if (ov.style.display && ov.style.display !== 'none') { closeCanvas(); return; }
    newDraw();
  });
  $('btn-canvas-close').addEventListener('click', closeCanvas);

  // Import / Export buttons on the drawing's header bar — visible while you're
  // inside a drawing (the right-click title menu was too hidden to find).
  // Double-click the Draw title → inline rename (same gesture as the note name
  // in the breadcrumb). Single clicks do nothing — the title stays put.
  const ct = $('canvas-title');
  if (ct) {
    ct.title = window.i18n.t('ctx.rename');
    ct.addEventListener('dblclick', () => renameDrawTitle());
    ct.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const menu = $('draw-context-menu'); if (!menu) return;
      menu.style.display = 'block';
      menu.style.left = e.clientX + 'px';
      menu.style.top = e.clientY + 'px';
    });
  }
  setupDrawContextMenu();

  let _iframeCompositorKicked = false;
  function _kickIframeCompositor() {
    // With disableHardwareAcceleration the software compositor caches the
    // iframe's initial (white) frame. display:none destroys the compositor
    // layer entirely; display:block forces creation of a fresh layer that
    // must read current (dark) content from the renderer.
    const iframe = $('canvas-iframe');
    if (!iframe) return;
    iframe.style.display = 'none';
    void iframe.offsetHeight; // force layout flush
    requestAnimationFrame(() => { iframe.style.display = 'block'; });
  }

  window.addEventListener('message', async (e) => {
    const msg = e.data;
    if (msg?.type === 'CANVAS_READY') {
      canvasIframeReady = true;
      _iframeCompositorKicked = false;
      if (activeCanvasPath) _sendDrawToIframe(activeCanvasPath);
    }
    // The canvas refused the file. Say so and STOP tracking it as the active
    // drawing: otherwise the empty editor would autosave over the real file and
    // destroy whatever couldn't be read.
    if (msg?.type === 'CANVAS_LOAD_ERROR') {
      const why = msg.reason === 'legacy-tldraw'
        ? window.i18n.t('canvas.legacy_tldraw')
        : window.i18n.t('canvas.load_failed');
      showToast('✗ ' + why, 6000);
      if (canvasSaveTimer) { clearTimeout(canvasSaveTimer); canvasSaveTimer = null; }
      activeCanvasPath = null;
      _liveCanvasJson = null;
      return;
    }
    if (msg?.type === 'CANVAS_CHANGE' && msg.json && activeCanvasPath) {
      _liveCanvasJson = msg.json;   // keep the freshest snapshot for export
      // Kick compositor on first render so dark background becomes visible
      if (!_iframeCompositorKicked) {
        _iframeCompositorKicked = true;
        setTimeout(_kickIframeCompositor, 200);
        setTimeout(_kickIframeCompositor, 700);
      }
      if (canvasSaveTimer) clearTimeout(canvasSaveTimer);
      canvasSaveTimer = setTimeout(async () => {
        try { await window.inkwell.writeNote(activeCanvasPath, msg.json); } catch(_) {}
      }, 1500);
    }
  });

  document.addEventListener('keydown', e => {
    if ($('canvas-overlay').style.display === 'none') return;
    if (e.key === 'Escape') closeCanvas();
  });
}

async function _sendDrawToIframe(filePath) {
  try {
    const json = await window.inkwell.readNote(filePath).catch(() => null);
    $('canvas-iframe').contentWindow?.postMessage({ type: 'LOAD_DATA', json: json || EMPTY_DRAW }, '*');
  } catch(_) {}
}

async function newDraw() {
  const now = new Date();
  // Default name: day-month-year + time (dd-mm-yyyy-HHMM). "-" not "/" — the
  // slash is a path separator and is blocked in file names.
  const stamp = `${String(now.getDate()).padStart(2,'0')}-${String(now.getMonth()+1).padStart(2,'0')}-${now.getFullYear()}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  // No dedicated "draws" folder: a new drawing lands either at the vault root or
  // in the currently-selected folder, per Settings → User Interface.
  const folder = (loadAppearance().drawLocation === 'current') ? currentFolderPath() : '';
  const pathFor = n => folder ? `${folder}/${n}.draw` : `${n}.draw`;
  const flat = flattenTree(state.notes);
  let name = stamp, counter = 1;
  while (flat.some(x => x.path === pathFor(name))) name = `${stamp} (${counter++})`;
  const filePath = pathFor(name);
  await window.inkwell.writeNote(filePath, EMPTY_DRAW);
  if (folder) openFolderAncestors(folder);
  await loadTree();
  openDrawFile({ type: 'draw', name, path: filePath, modified: now.toISOString(), created: now.toISOString(), size: EMPTY_DRAW.length });
}

function openDrawFile(node, activate = true) {
  // Where to come back to when the drawing closes: its tab is appended at the end, so the
  // neighbour rule would drop you on the last tab in the bar instead.
  const cur = getActiveTab();
  if (activate && cur && cur.path && !cur.type) _drawReturnPath = cur.path;
  const existingIdx = tabs.findIndex(t => t.type === 'canvas' && t.path === node.path);
  if (existingIdx >= 0) { if (activate) switchTab(existingIdx); return; }
  tabs.push({ type: 'canvas', name: node.name, path: node.path, isDirty: false });
  if (activate) switchTab(tabs.length - 1);
}

function openPdfFile(node, activate = true) {
  const attachmentName = node.attachmentName || (node.path ? node.path.split('/').pop() : node.name);
  const existingIdx = tabs.findIndex(t => t.type === 'pdf' && t.attachmentName === attachmentName);
  if (existingIdx >= 0) { if (activate) switchTab(existingIdx); return; }
  tabs.push({
    type: 'pdf',
    name: node.name,
    path: node.path || `attachments/${attachmentName}`,
    attachmentName,
  });
  if (activate) switchTab(tabs.length - 1);
}

// ─── Image viewer (photos surfaced in the sidebar, opened like PDFs) ─────────
let _imgZoom = 1.0;
function _updateImgZoomLabel() {
  const l = $('img-zoom-label');
  if (l) l.textContent = Math.round(_imgZoom * 100) + '%';
}
function setImgZoom(z) {
  _imgZoom = Math.min(5, Math.max(0.2, z));
  const img = $('img-view-content');
  if (img && img.naturalWidth) {
    if (_imgZoom === 1) { img.style.width = ''; img.style.maxWidth = '100%'; }
    else { img.style.width = (img.naturalWidth * _imgZoom) + 'px'; img.style.maxWidth = 'none'; }
  }
  _updateImgZoomLabel();
}
function openImageFile(node, activate = true) {
  const attachmentName = node.attachmentName
    || (node.path ? node.path.replace(/^attachments\//, '') : node.name);
  const existingIdx = tabs.findIndex(t => t.type === 'image' && t.attachmentName === attachmentName);
  if (existingIdx >= 0) { if (activate) switchTab(existingIdx); return; }
  tabs.push({
    type: 'image',
    name: node.name,
    path: node.path || `attachments/${attachmentName}`,
    attachmentName,
  });
  if (activate) switchTab(tabs.length - 1);
}

// A photo, recording or video in the vault almost always BELONGS to a note, so clicking
// it reopens that note and lands on the link — where the media shows or plays in place.
// Only a file no note links to (dropped into the vault and never embedded) opens on its
// own in the viewer/player. PDFs never come through here: a PDF is a document in its own
// right, not note media, so it always opens in its viewer.
async function openAttachmentNode(node, activate = true) {
  const attachmentName = node.attachmentName
    || (node.path ? node.path.replace(/^attachments\//, '') : node.name);
  let owners = [];
  try { owners = (await window.inkwell.attachmentUsedBy(attachmentName)) || []; } catch (_) {}
  const owner = owners.length ? findNote(state.notes, owners[0]) : null;
  if (owner) {
    await openNote(owner);            // a note node: no way back into this branch
    _revealAttachmentInNote(attachmentName);
    return;
  }
  if (node.type === 'image') openImageFile(node, activate);
  else openMediaFile(node, activate);
}

// Put the link on screen once the note is up: the caret on it while editing, the media
// itself scrolled into view while reading. Best effort — landing on the right note is
// what matters, so a miss here is silent.
function _revealAttachmentInNote(attachmentName) {
  requestAnimationFrame(() => {
    try {
      if (state.viewMode === 'edit') {
        const text = editor.value || '';
        const at = text.indexOf('attachments/' + attachmentName);
        if (at < 0) return;
        if (_cmActive && _cmHandle) { _cmHandle.setSelection(at, at); _cmHandle.scrollToPos(at, 'center'); return; }
        editor.focus();
        editor.setSelectionRange(at, at);
        const lh = parseFloat(getComputedStyle(editor).lineHeight) || 20;
        editor.scrollTop = Math.max(0, text.slice(0, at).split('\n').length * lh - editor.clientHeight / 2);
      } else if (previewContent) {
        // The link may be written raw or percent-encoded — look for both.
        const enc = attachmentName.split('/').map(encodeURIComponent).join('/');
        const el = [attachmentName, enc].map(v =>
          previewContent.querySelector(`[src*="${CSS.escape(v)}"], [href*="${CSS.escape(v)}"]`)).find(Boolean);
        if (el) el.scrollIntoView({ block: 'center' });
      }
    } catch (_) {}
  });
}

// Audio/video from the tree, in a tab of its own — same shape as the image viewer.
// The type comes from the node (main.js already decided it from the extension), so a
// file whose extension says audio never lands in the <video> element.
function openMediaFile(node, activate = true) {
  const attachmentName = node.attachmentName
    || (node.path ? node.path.replace(/^attachments\//, '') : node.name);
  const type = node.type === 'video' ? 'video' : 'audio';
  const existingIdx = tabs.findIndex(t => t.type === type && t.attachmentName === attachmentName);
  if (existingIdx >= 0) { if (activate) switchTab(existingIdx); return; }
  tabs.push({
    type,
    name: node.name,
    path: node.path || `attachments/${attachmentName}`,
    attachmentName,
  });
  if (activate) switchTab(tabs.length - 1);
}

// PDF.js library, lazy-loaded the first time a PDF is opened.
let _pdfjsLib = null;
async function getPdfJs() {
  if (_pdfjsLib) return _pdfjsLib;
  _pdfjsLib = await import('./pdfjs/pdf.mjs');
  _pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL('./pdfjs/pdf.worker.mjs', location.href).toString();
  return _pdfjsLib;
}

// ─── PDF viewer (canvas + selectable text layer + zoom) ───────────────────────
const PDF_BASE_SCALE = 1.4;   // display scale at zoom 100%
let _pdfDoc = null;           // currently loaded pdf.js document
let _pdfContainer = null;     // #pdf-embed
let _pdfZoom = 1.0;           // user zoom multiplier
let _pdfRenderToken = 0;      // cancels a stale re-render when zoom changes fast

// ─── PDF annotation editor (freehand pen / highlighter) ──────────────────────
const SVGNS = 'http://www.w3.org/2000/svg';
let _pdfTool = null;          // null | 'pen' | 'highlight' | 'text' | 'image'
let _pdfSelText = null;       // currently selected object annot — text OR image (text is
                              // recoloured by the picker; either can be deleted via Delete/Backspace)
let _pdfSelTextEl = null;     // its DOM element (for live restyle / selection outline)
let _pdfAttName = null;       // attachment name of the loaded PDF (for save)
let _pdfAnnots = [];          // pen/hl: {type,page,color,width,points} ; text: {type:'text',page,x,y,size,color,text} ; image: {type:'image',page,x,y,w,h,ratio,mime,dataB64} — coords in PDF points (origin bottom-left, y = top edge from bottom)
let _pdfDirty = false;
// PDF AcroForm fields: rendered as interactive inputs via pdf.js AnnotationLayer
// (renderForms). Edits live in _pdfDoc.annotationStorage; saved via saveDocument().
let _pdfHasForm = false;
let _pdfFormDirty = false;
// Pen, highlighter AND text boxes share ONE colour (set via the picker).
// Highlighter differs only in width + translucency. Default red.
const PDF_PEN  = { color: '#e5484d', width: 2 };
const PDF_HL   = { color: '#e5484d', width: 14 };  // thick, translucent
const PDF_TEXT = { size: 14, color: '#e5484d', font: 'Helvetica' };   // text box default (size in PDF points)

// Text fonts offered in the toolbar. `id` is stored on the annot and mapped to a
// pdf-lib StandardFont at bake time (main.js); `css`/`weight`/`style` drive the
// on-screen preview. Kept to the PDF base-14 families (each in Regular / Bold /
// Italic / Bold-Italic) so no font file needs bundling and every viewer can
// render them. Keep the ids in sync with the baker's map (_FONT_STD in main.js).
const _SANS = 'Helvetica, Arial, sans-serif';
const _SERIF = '"Times New Roman", Times, serif';
const _MONO = '"Courier New", Courier, monospace';
const PDF_FONTS = [
  { id: 'Helvetica',            family: 'Helvetica', css: _SANS,  weight: 'normal', style: 'normal' },
  { id: 'HelveticaBold',        family: 'Helvetica', css: _SANS,  weight: 'bold',   style: 'normal' },
  { id: 'HelveticaOblique',     family: 'Helvetica', css: _SANS,  weight: 'normal', style: 'italic' },
  { id: 'HelveticaBoldOblique', family: 'Helvetica', css: _SANS,  weight: 'bold',   style: 'italic' },
  { id: 'Times',                family: 'Times',     css: _SERIF, weight: 'normal', style: 'normal' },
  { id: 'TimesBold',            family: 'Times',     css: _SERIF, weight: 'bold',   style: 'normal' },
  { id: 'TimesItalic',          family: 'Times',     css: _SERIF, weight: 'normal', style: 'italic' },
  { id: 'TimesBoldItalic',      family: 'Times',     css: _SERIF, weight: 'bold',   style: 'italic' },
  { id: 'Courier',              family: 'Courier',   css: _MONO,  weight: 'normal', style: 'normal' },
  { id: 'CourierBold',          family: 'Courier',   css: _MONO,  weight: 'bold',   style: 'normal' },
  { id: 'CourierOblique',       family: 'Courier',   css: _MONO,  weight: 'normal', style: 'italic' },
  { id: 'CourierBoldOblique',   family: 'Courier',   css: _MONO,  weight: 'bold',   style: 'italic' },
];
function _pdfFontOf(id) { return PDF_FONTS.find(f => f.id === id) || PDF_FONTS[0]; }
// Which standard PDF family sits closest to the font chosen for the editor. The text added to
// a PDF must be one of the base-14 families — anything else would have to be embedded in the
// file — so the best we can do is start from the matching KIND: a monospace editor font opens
// the text tool on Courier, a serif one on Times, anything else on Helvetica.
function _pdfFontForEditorFont() {
  const fam = _editorFontFamily().toLowerCase();
  if (/mono|courier|consol/.test(fam)) return 'Courier';
  if (/serif|garamond|georgia|times|lora|merriweather|fraunces/.test(fam) && !/sans-serif/.test(fam)) return 'Times';
  return 'Helvetica';
}
function _pdfFontCss(id) { return _pdfFontOf(id).css; }
// Apply family + weight + style of a PDF font id to an on-screen element.
function _applyPdfFont(el, id) {
  const f = _pdfFontOf(id);
  el.style.fontFamily = f.css;
  el.style.fontWeight = f.weight;
  el.style.fontStyle  = f.style;
}
// Display label: family name + localized "Bold"/"Italic" (reuses toolbar keys).
function _pdfFontLabel(f) {
  const t = (k) => (window.i18n && window.i18n.t) ? window.i18n.t(k) : k;
  let s = f.family;
  if (f.weight === 'bold')  s += ' ' + t('toolbar.bold');
  if (f.style === 'italic') s += ' ' + t('toolbar.italic');
  return s;
}
// Font sizes (in PDF points) offered in the toolbar.
const PDF_SIZES = [8, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];

// ─── PDF page operations (thumbnail panel: reorder / rotate / delete / merge) ─
// The panel stages a "page plan": an ordered list of pages, each pointing at a
// source document ('main' = the open PDF, 'mergeN' = an imported PDF) and a
// source page index + an ADDED rotation. Applying it rebuilds the PDF in main.
let _pdfPagePanelOpen = false;
let _pdfPages = [];           // ordered [{key, src, srcIndex, rot}]
let _pdfMergeSources = {};    // { mergeN: { bytes:Uint8Array, doc:pdfjsDoc } }
let _pdfMergeSeq = 0;
let _pdfPagesDirty = false;
let _pdfPageKeySeq = 0;
const _pdfThumbCache = new Map();   // 'src:index' -> dataURL

function _pdfToolStyle() { return _pdfTool === 'highlight' ? PDF_HL : PDF_PEN; }
function _markPdfDirty() { _pdfDirty = true; _updatePdfDirty(); }

// ─── PDF pen / highlighter colour picker ─────────────────────────────────────
// Preset palette; each choice mutates PDF_PEN.color or PDF_HL.color so that the
// NEXT stroke uses it (existing strokes keep the colour they were drawn with).
const PDF_COLORS = ['#000000', '#e5484d', '#f5a524', '#ffd23f',
                    '#30a46c', '#2563eb', '#8e4ec6', '#8b8b8b'];
let _pdfColorPopOpen = false;

// Update the toolbar swatch button to mirror the current colour. The button stays
// enabled even with no active tool, so the colour can be set beforehand.
function _syncPdfColorBtn() {
  const btn = document.getElementById('pdf-color');
  if (!btn) return;
  const dot = btn.querySelector('.pdf-color-dot');
  if (dot) dot.style.background = PDF_PEN.color;
  if (_pdfColorPopOpen) _renderPdfColorSwatches();
}

function _renderPdfColorSwatches() {
  const wrap = document.querySelector('#pdf-color-pop .pdf-color-swatches');
  if (!wrap) return;
  const cur = PDF_PEN.color.toLowerCase();
  wrap.innerHTML = '';
  for (const c of PDF_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pdf-swatch' + (c.toLowerCase() === cur ? ' sel' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => { setPdfToolColor(c); _closePdfColorPop(); });
    wrap.appendChild(b);
  }
  const input = document.getElementById('pdf-color-input');
  if (input) input.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#000000';
}

// Mark one text box as selected (so the colour picker recolours it). Passing null
// clears the selection. Only one text box is selected at a time.
function _selectPdfText(annot, el) {
  if (_pdfSelTextEl && _pdfSelTextEl !== el) _pdfSelTextEl.classList.remove('sel');
  _pdfSelText = annot || null;
  _pdfSelTextEl = annot ? (el || null) : null;
  if (_pdfSelTextEl) _pdfSelTextEl.classList.add('sel');
  // Reflect the selected text box's font + size in the toolbar pickers.
  if (annot && annot.type === 'text') { _syncPdfFontSelect(annot.font); _syncPdfSizeSelect(annot.size); }
}
function _deselectPdfText() { _selectPdfText(null, null); }

// Keep the toolbar font <select> showing the given font id (falls back to the
// current default). Used when a box is selected or the default changes.
function _syncPdfFontSelect(id) {
  const sel = document.getElementById('pdf-font');
  if (sel) sel.value = PDF_FONTS.some(f => f.id === id) ? id : PDF_TEXT.font;
}
function _syncPdfSizeSelect(size) {
  const sel = document.getElementById('pdf-fontsize');
  if (sel) sel.value = String(size || PDF_TEXT.size);
}

// Toolbar font picker. Sets the default for the NEXT text box and, if a text box
// is currently selected/being edited, restyles it live (mirrors setPdfToolColor).
function setPdfTextFont(id) {
  if (!PDF_FONTS.some(f => f.id === id)) return;
  PDF_TEXT.font = id;
  if (_pdfSelText && _pdfSelText.type === 'text') {
    _pdfSelText.font = id;
    if (_pdfSelTextEl) _applyPdfFont(_pdfSelTextEl, id);
    _markPdfDirty();
  }
}

// Toolbar font-size picker. Sets the default for the NEXT text box and, if a text
// box is selected/being edited, resizes it live (fontSize is in screen px =
// point-size × current zoom scale).
function setPdfTextSize(pt) {
  const size = Math.max(1, +pt || PDF_TEXT.size);
  PDF_TEXT.size = size;
  if (_pdfSelText && _pdfSelText.type === 'text') {
    _pdfSelText.size = size;
    if (_pdfSelTextEl) _pdfSelTextEl.style.fontSize = (size * PDF_BASE_SCALE * _pdfZoom) + 'px';
    _markPdfDirty();
  }
}

// One shared colour for pen, highlighter and text boxes. If a text box is
// currently selected, its colour is changed too (so you can recolour text you
// inserted earlier: select it, then pick a colour).
function setPdfToolColor(hex) {
  PDF_PEN.color = hex;
  PDF_HL.color = hex;
  PDF_TEXT.color = hex;
  if (_pdfSelText && _pdfSelText.type === 'text') {
    _pdfSelText.color = hex;
    if (_pdfSelTextEl) _pdfSelTextEl.style.color = hex;
    _markPdfDirty();
  }
  _syncPdfColorBtn();
  _renderPdfColorSwatches();
}

function _openPdfColorPop() {
  const btn = document.getElementById('pdf-color');
  const pop = document.getElementById('pdf-color-pop');
  if (!btn || !pop || btn.disabled) return;
  _renderPdfColorSwatches();
  pop.style.display = 'block';
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  let left = r.left;
  const pw = pop.offsetWidth;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  pop.style.left = Math.max(8, left) + 'px';
  _pdfColorPopOpen = true;
}

function _closePdfColorPop() {
  const pop = document.getElementById('pdf-color-pop');
  if (pop) pop.style.display = 'none';
  _pdfColorPopOpen = false;
}

function togglePdfColorPop() {
  if (_pdfColorPopOpen) _closePdfColorPop(); else _openPdfColorPop();
}

// ─── PDF compression (Ghostscript, in place) ─────────────────────────────────
let _pdfComprPopOpen = false;
function _fmtBytes(b) {
  return b < 1024 ? b + ' B'
    : b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB'
    : (b / (1024 * 1024)).toFixed(1) + ' MB';
}
function _openPdfComprPop() {
  const btn = document.getElementById('pdf-compress');
  const pop = document.getElementById('pdf-compress-pop');
  if (!btn || !pop || btn.disabled) return;
  pop.style.display = 'block';
  const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  let left = r.left;
  const pw = pop.offsetWidth;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  pop.style.left = Math.max(8, left) + 'px';
  _pdfComprPopOpen = true;
}
function _closePdfComprPop() {
  const pop = document.getElementById('pdf-compress-pop');
  if (pop) pop.style.display = 'none';
  _pdfComprPopOpen = false;
}
function togglePdfComprPop() {
  if (_pdfComprPopOpen) _closePdfComprPop(); else _openPdfComprPop();
}

// Compress the open PDF in place at the chosen quality level, then reload it.
async function compressPdfFile(level) {
  _closePdfComprPop();
  if (!_pdfAttName) return;
  const btn = document.getElementById('pdf-compress');
  if (btn) { btn.disabled = true; btn.classList.add('active'); }
  // Show the sticky "working…" toast IMMEDIATELY on click, before any save/bake,
  // so there's instant feedback (the save + reloads can take a beat).
  showToast(window.i18n.t('pdf.compress_working'), 0);
  // Compression works on the ON-DISK file → unsaved annotations/form edits/page
  // ops would be lost. Save them first (skipReload: compress reloads right after,
  // so we skip a redundant refresh of the main view). Abort if the save fails.
  if (_pdfDirty || _pdfFormDirty || _pdfPagesDirty) {
    await savePdfEdits(true);
    if (_pdfDirty || _pdfFormDirty || _pdfPagesDirty) {
      hideToast();
      if (btn) { btn.disabled = false; btn.classList.remove('active'); }
      return;   // save failed
    }
  }
  try {
    const label = window.i18n.t('pdf.compressed_suffix');
    const res = await window.inkwell.compressPdf(_pdfAttName, level, label);
    if (res?.ok && res.name) {
      // Compression produced a NEW file (…"compresso".pdf) that looks IDENTICAL to
      // the original. So DON'T reload the main view or switch the open tab —
      // reloading would just flicker with no visible change. Leave the original
      // open; only surface the new file in the sidebar and flash it.
      const newName = res.name;
      try { await loadTree(); } catch (_) {}
      _revealTreeNode(`attachments/${newName}`);
      const before = _fmtBytes(res.before), after = _fmtBytes(res.after);
      if (res.after < res.before) {
        const pct = Math.max(0, Math.round((1 - res.after / res.before) * 100));
        showToast(window.i18n.t('pdf.compress_done', { before, after, pct: pct + '%' }));
      } else {
        // File created at the chosen quality level, but no size reduction (the
        // source was already at or below that level). Report honestly.
        showToast(window.i18n.t('pdf.compress_done_same', { before, after }));
      }
    } else if (res?.error === 'NO_GS') {
      showToast(window.i18n.t('pdf.compress_nogs'));
    } else {
      showToast(window.i18n.t('pdf.compress_fail'));
    }
  } catch (e) {
    console.error('PDF compress failed:', e);
    showToast(window.i18n.t('pdf.compress_fail'));
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('active'); }
  }
}

function _updatePdfDirty() {
  // The toolbar Save / Save-as commit ANY pending change: annotations, form
  // fills, or page operations (reorder/rotate/delete/merge).
  const dirty = _pdfDirty || _pdfFormDirty || _pdfPagesDirty;
  const btn = document.getElementById('pdf-save');
  if (btn) btn.disabled = !dirty;
  const btnAs = document.getElementById('pdf-save-as');
  if (btnAs) btnAs.disabled = !dirty;
}

// Minimal link service so pdf.js AnnotationLayer can render form widgets without
// the full viewer package (we only care about form fields, not link navigation).
function _pdfLinkStub() {
  return {
    eventBus: null, externalLinkEnabled: false,
    getDestinationHash: () => '#', getAnchorUrl: () => '',
    goToDestination: () => {}, executeNamedAction: () => {}, executeSetOCGState: () => {},
    addLinkAttributes: () => {},
  };
}

function _onPdfFormInput() {
  if (_pdfFormDirty) return;
  _pdfFormDirty = true;
  _updatePdfDirty();
}

function setPdfTool(tool) {
  _pdfTool = (_pdfTool === tool) ? null : tool;
  _deselectPdfText();
  const c = _pdfContainer;
  c?.classList.toggle('pdf-editing', !!_pdfTool);
  c?.classList.toggle('pdf-tool-text', _pdfTool === 'text');
  c?.classList.toggle('pdf-tool-image', _pdfTool === 'image');
  document.getElementById('pdf-tool-pen')?.classList.toggle('active', _pdfTool === 'pen');
  document.getElementById('pdf-tool-hl')?.classList.toggle('active', _pdfTool === 'highlight');
  document.getElementById('pdf-tool-text')?.classList.toggle('active', _pdfTool === 'text');
  document.getElementById('pdf-tool-image')?.classList.toggle('active', _pdfTool === 'image');
  _syncPdfColorBtn();
}

// Redraw all stored annotations for one page onto its SVG overlay.
function _drawPageAnnots(svg, page, scale, pageHpt) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const a of _pdfAnnots) {
    if (a.page !== page) continue;
    if (a.type !== 'pen' && a.type !== 'highlight') continue;   // text/image live on the obj layer
    const pl = document.createElementNS(SVGNS, 'polyline');
    pl.setAttribute('points', a.points.map(([x, y]) => `${x * scale},${(pageHpt - y) * scale}`).join(' '));
    pl.setAttribute('fill', 'none');
    pl.setAttribute('stroke', a.color);
    pl.setAttribute('stroke-width', String(a.width * scale));
    pl.setAttribute('stroke-linecap', 'round');
    pl.setAttribute('stroke-linejoin', 'round');
    if (a.type === 'highlight') pl.setAttribute('stroke-opacity', '0.4');
    svg.appendChild(pl);
  }
}

// Wire pointer drawing on a page's SVG overlay. Coords stored in PDF points
// (origin bottom-left) so they survive zoom and feed pdf-lib directly.
function _wirePdfAnnotLayer(svg, page, scale, pageHpt) {
  let cur = null, curEl = null;
  const toPt = (ev) => {
    const r = svg.getBoundingClientRect();
    return [(ev.clientX - r.left) / scale, pageHpt - (ev.clientY - r.top) / scale];
  };
  const redraw = () => curEl?.setAttribute('points',
    cur.points.map(([x, y]) => `${x * scale},${(pageHpt - y) * scale}`).join(' '));
  svg.addEventListener('pointerdown', (ev) => {
    if (!_pdfTool) return;
    ev.preventDefault();
    _deselectPdfText();
    try { svg.setPointerCapture(ev.pointerId); } catch (_) {}
    const st = _pdfToolStyle();
    cur = { type: _pdfTool, page, color: st.color, width: st.width, points: [toPt(ev)] };
    curEl = document.createElementNS(SVGNS, 'polyline');
    curEl.setAttribute('fill', 'none');
    curEl.setAttribute('stroke', st.color);
    curEl.setAttribute('stroke-width', String(st.width * scale));
    curEl.setAttribute('stroke-linecap', 'round');
    curEl.setAttribute('stroke-linejoin', 'round');
    if (_pdfTool === 'highlight') curEl.setAttribute('stroke-opacity', '0.4');
    svg.appendChild(curEl);
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!cur) return;
    cur.points.push(toPt(ev));
    redraw();
  });
  const finish = () => {
    if (!cur) return;
    if (cur.points.length >= 2) { _pdfAnnots.push(cur); _pdfDirty = true; _updatePdfDirty(); }
    else if (curEl) svg.removeChild(curEl);
    cur = null; curEl = null;
  };
  svg.addEventListener('pointerup', finish);
  svg.addEventListener('pointercancel', finish);
}

function undoPdfAnnot() {
  const last = _pdfAnnots.pop();
  if (!last) return;
  if (_pdfSelText === last) _deselectPdfText();
  _pdfDirty = _pdfAnnots.length > 0;
  _updatePdfDirty();
  _redrawPage(last.page);
}

// Re-render both overlays (strokes + text/image objects) for one page.
function _redrawPage(page) {
  const scale = PDF_BASE_SCALE * _pdfZoom;
  const svg = _pdfContainer?.querySelector(`.pdf-annot-layer[data-page="${page}"]`);
  if (svg) _drawPageAnnots(svg, page, scale, (+svg.getAttribute('height')) / scale);
  const ol = _pdfContainer?.querySelector(`.pdf-obj-layer[data-page="${page}"]`);
  if (ol) _drawPageObjs(ol, page, scale, +ol.dataset.hpt);
}

// ─── PDF text boxes & images (HTML object layer over each page) ───────────────
// Convert a pointer event to PDF points (origin bottom-left, x right / y up).
function _objEvtPt(layer, scale, pageHpt, ev) {
  const r = layer.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / scale, y: pageHpt - (ev.clientY - r.top) / scale };
}

// Drag an object element; onMove(dxPt, dyPt) receives the delta in PDF points.
function _dragObj(handleEl, scale, onStart, onMove, onDone) {
  handleEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    try { handleEl.setPointerCapture(ev.pointerId); } catch (_) {}
    const sx = ev.clientX, sy = ev.clientY;
    // Capture the base position WHEN the drag starts — not when the object was
    // drawn. Reading a stale draw-time origin made a second drag jump back.
    const base = onStart ? onStart() : null;
    const move = (e) => onMove((e.clientX - sx) / scale, -(e.clientY - sy) / scale, base);
    const up = () => {
      handleEl.removeEventListener('pointermove', move);
      handleEl.removeEventListener('pointerup', up);
      onDone && onDone();
    };
    handleEl.addEventListener('pointermove', move);
    handleEl.addEventListener('pointerup', up);
  });
}

// Remove a text/image object annotation and redraw its page.
function _deletePdfObj(annot, page) {
  const i = _pdfAnnots.indexOf(annot);
  if (i >= 0) _pdfAnnots.splice(i, 1);
  if (_pdfSelText === annot) _deselectPdfText();
  _markPdfDirty();
  _redrawPage(page);
}
// Render all text/image objects of a page as positioned HTML elements.
function _drawPageObjs(layer, page, scale, pageHpt) {
  while (layer.firstChild) layer.removeChild(layer.firstChild);
  const toTop = (yPt) => (pageHpt - yPt) * scale;   // PDF top-from-bottom → CSS top px
  for (const a of _pdfAnnots) {
    if (a.page !== page) continue;

    if (a.type === 'text') {
      const el = document.createElement('div');
      el.className = 'pdf-obj pdf-obj-text';
      el.style.left = (a.x * scale) + 'px';
      el.style.top  = toTop(a.y) + 'px';
      el.style.fontSize = (a.size * scale) + 'px';
      _applyPdfFont(el, a.font);
      el.style.color = a.color;
      el.textContent = a.text || '';
      if (a === _pdfSelText) { el.classList.add('sel'); _pdfSelTextEl = el; }
      // Single click selects the box (so the colour picker recolours it).
      el.addEventListener('pointerdown', () => _selectPdfText(a, el));
      _dragObj(el, scale,
        () => ({ x: a.x, y: a.y }),
        (dx, dy, s) => {
          if (el.isContentEditable) return;
          a.x = s.x + dx; a.y = s.y + dy;
          el.style.left = (a.x * scale) + 'px';
          el.style.top  = toTop(a.y) + 'px';
        }, _markPdfDirty);
      el.addEventListener('dblclick', () => _editTextObj(el, a, layer, page));
      layer.appendChild(el);

    } else if (a.type === 'image') {
      const box = document.createElement('div');
      box.className = 'pdf-obj pdf-obj-img';
      box.style.left = (a.x * scale) + 'px';
      box.style.top  = toTop(a.y) + 'px';
      box.style.width  = (a.w * scale) + 'px';
      box.style.height = (a.h * scale) + 'px';
      const img = document.createElement('img');
      img.src = `data:${a.mime};base64,${a.dataB64}`;
      img.draggable = false;
      box.appendChild(img);
      box.addEventListener('pointerdown', () => _selectPdfText(a, box));   // click selects (for Delete/Backspace)
      if (a === _pdfSelText) { box.classList.add('sel'); _pdfSelTextEl = box; }
      const grip = document.createElement('div');
      grip.className = 'pdf-obj-grip';
      box.appendChild(grip);
      _dragObj(box, scale,
        () => ({ x: a.x, y: a.y }),
        (dx, dy, s) => {
          a.x = s.x + dx; a.y = s.y + dy;
          box.style.left = (a.x * scale) + 'px';
          box.style.top  = toTop(a.y) + 'px';
        }, _markPdfDirty);
      _dragObj(grip, scale,
        () => ({ w: a.w, y: a.y }),
        (dx, _dy, s) => {
          const nw = Math.max(12, s.w + dx);
          a.w = nw; a.h = nw * a.ratio; a.y = s.y;   // top edge stays put as it grows down
          box.style.width  = (a.w * scale) + 'px';
          box.style.height = (a.h * scale) + 'px';
        }, _markPdfDirty);
      layer.appendChild(box);
    }
  }
}

// Make a text element editable; commit (or drop if empty) on blur.
function _editTextObj(el, annot, layer, page) {
  el.contentEditable = 'true';
  el.classList.add('editing');
  el.focus();
  const sel = window.getSelection();
  if (sel && el.textContent) { sel.selectAllChildren(el); sel.collapseToEnd(); }
  const commit = () => {
    el.contentEditable = 'false';
    el.classList.remove('editing');
    annot.text = el.innerText.replace(/ /g, ' ').replace(/\n$/, '');
    el.removeEventListener('blur', commit);
    el.removeEventListener('keydown', onKey);
    if (!annot.text.trim()) {
      const i = _pdfAnnots.indexOf(annot);
      if (i >= 0) _pdfAnnots.splice(i, 1);
      if (_pdfSelText === annot) _deselectPdfText();
      _redrawPage(page);
    }
    _pdfDirty = _pdfAnnots.length > 0; _updatePdfDirty();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); return; }
    // Delete/Backspace on an ALREADY-EMPTY box removes the whole box (commit()
    // drops an empty annot on blur), instead of leaving an empty square that
    // lingers on screen until focus happens to move away.
    if ((e.key === 'Delete' || e.key === 'Backspace') && !el.innerText.trim()) {
      e.preventDefault(); el.blur(); return;
    }
    e.stopPropagation();   // keep app shortcuts from firing while typing
  };
  el.addEventListener('blur', commit);
  el.addEventListener('keydown', onKey);
}

// Wire the obj layer: in text mode, a click on empty space starts a new text box.
function _wirePdfObjLayer(layer, page, scale, pageHpt) {
  layer.addEventListener('pointerdown', (ev) => {
    if (_pdfTool !== 'text' || ev.target !== layer) return;
    ev.preventDefault();
    const p = _objEvtPt(layer, scale, pageHpt, ev);
    const spawn = () => {
      _deselectPdfText();   // clicking empty space clears any selected text box
      const a = { type: 'text', page, x: p.x, y: p.y, size: PDF_TEXT.size, color: PDF_TEXT.color, font: PDF_TEXT.font, text: '' };
      _pdfAnnots.push(a);
      const el = document.createElement('div');
      el.className = 'pdf-obj pdf-obj-text';
      el.style.left = (a.x * scale) + 'px';
      el.style.top  = ((pageHpt - a.y) * scale) + 'px';
      el.style.fontSize = (a.size * scale) + 'px';
      _applyPdfFont(el, a.font);
      el.style.color = a.color;
      layer.appendChild(el);
      // Select the fresh box so the colour/font pickers restyle THIS box while you
      // type it (without this, _pdfSelText stays null during the first edit and
      // picking a colour/font would only affect the next box).
      _selectPdfText(a, el);
      // re-bind drag/dblclick by redrawing after commit; for now just edit it.
      _editTextObj(el, a, layer, page);
      el.addEventListener('blur', () => _redrawPage(page), { once: true });
    };
    // If ANOTHER text box is mid-edit, committing it (blur) triggers a redraw of
    // this page. If we spawned the new box first, that redraw would immediately
    // wipe it out — which is why creating a second box "didn't let you type" until
    // you clicked again. So: commit the old box, then spawn the new one AFTER its
    // redraw settles (next tick).
    const editing = document.activeElement;
    if (editing && editing.isContentEditable && editing.classList && editing.classList.contains('pdf-obj-text')) {
      editing.blur();
      setTimeout(spawn, 0);
    } else {
      spawn();
    }
  });
}

// Index of the PDF page currently most in view (for placing new images).
function _currentPdfPage() {
  const c = _pdfContainer;
  if (!c) return 1;
  const mid = c.scrollTop + c.clientHeight / 2;
  let best = 1, bestD = Infinity;
  c.querySelectorAll('.pdf-page-wrap').forEach((w, i) => {
    const center = w.offsetTop + w.offsetHeight / 2;
    const d = Math.abs(center - mid);
    if (d < bestD) { bestD = d; best = i + 1; }
  });
  return best;
}

// Pick an image file and drop it centered on the current page (drag/resize, baked on save).
async function addPdfImage() {
  if (!_pdfAttName) return;
  if (_pdfTool !== 'image') setPdfTool('image');
  let res;
  try { res = await window.inkwell.pickPdfImage(); } catch (e) { console.error(e); return; }
  if (!res || !res.dataB64) return;
  const url = `data:${res.mime};base64,${res.dataB64}`;
  const dim = await new Promise((r) => {
    const im = new Image();
    im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => r(null);
    im.src = url;
  });
  if (!dim || !dim.w) { alert(window.i18n.t('pdf.invalid_image')); return; }
  const page = _currentPdfPage();
  const ol = _pdfContainer?.querySelector(`.pdf-obj-layer[data-page="${page}"]`);
  if (!ol) return;
  const pageWpt = +ol.dataset.wpt, pageHpt = +ol.dataset.hpt;
  const ratio = dim.h / dim.w;
  const w = pageWpt * 0.4;
  const h = w * ratio;
  const a = {
    type: 'image', page, mime: res.mime, dataB64: res.dataB64, ratio,
    x: (pageWpt - w) / 2, y: (pageHpt + h) / 2,   // centered
    w, h,
  };
  _pdfAnnots.push(a);
  _markPdfDirty();
  _redrawPage(page);
}

// If the form has user edits, return the filled PDF bytes (base64) via pdf.js
// saveDocument(); else null. saveDocument bakes annotationStorage into the doc.
async function _collectPdfFormBytes() {
  if (!_pdfFormDirty || !_pdfDoc) return null;
  try {
    const saved = await _pdfDoc.saveDocument();
    const u = saved instanceof Uint8Array ? saved : new Uint8Array(saved);
    return _u8ToB64(u);
  } catch (e) {
    console.error('saveDocument failed:', e);
    throw new Error(window.i18n.t('pdf.save_failed', { err: e?.message || String(e) }));
  }
}

function _pdfSaveErrMsg(e) {
  const raw = e?.message || String(e);
  // main throws the marker 'ENCRYPTED_PDF' for PDFs with their own encryption.
  return /ENCRYPTED_PDF/.test(raw)
    ? window.i18n.t('pdf.protected')
    : (/save_failed|Salvataggio|failed/i.test(raw) ? raw : window.i18n.t('pdf.save_failed', { err: raw }));
}

// A text box commits its typed content into the annot only on blur. If Save is
// pressed while a box is still being edited, blur it FIRST so the just-typed
// text (and any last colour/font tweak) lands in _pdfAnnots — otherwise the
// baker skips the still-empty annot and the PDF saves without that text.
function _flushPdfTextEdit() {
  const ae = document.activeElement;
  if (ae && ae.isContentEditable && ae.classList && ae.classList.contains('pdf-obj-text')) {
    ae.blur();
  }
}

// skipReload=true bakes the edits to disk but doesn't re-render the view — used
// by compress, which reloads (a different, compressed file) right after anyway,
// so we avoid a redundant refresh of the main view before compression starts.
// Persist PDF save errors (with full stack) to the debug log so an elusive,
// hard-to-reproduce failure can be diagnosed after the fact. Grep the log for
// "[PDF-SAVE]". Writes to /tmp/amelie-cm-debug.log via the existing debug hook.
function _pdfDebugLog(where, e) {
  try {
    const msg = (e && (e.stack || e.message)) || String(e);
    window.inkwell.debugLog?.('[PDF-SAVE] ' + where + ' | ' + (_pdfAttName || '?') + ' :: ' + msg);
  } catch (_) {}
}

async function savePdfEdits(skipReload) {
  if (!_pdfAttName) return;
  _flushPdfTextEdit();   // commit any in-progress text box before reading _pdfAnnots
  // Page operations (reorder/rotate/delete/merge) take precedence — they rebuild
  // the whole document, so they commit via the page-plan path.
  if (_pdfPagesDirty) { await applyPdfPageOps(false); return; }
  const btn = document.getElementById('pdf-save');
  if (btn) btn.disabled = true;
  // ── Phase 1: the actual save. Only a failure here means the edits weren't
  // written, so only this shows the "save failed" popup. ───────────────────────
  try {
    const formB64 = await _collectPdfFormBytes();   // null if no form edits
    if (!_pdfAnnots.length && !formB64) { _updatePdfDirty(); if (btn) btn.disabled = false; return; }
    let res;
    if (!_pdfAnnots.length) {
      // pure form fill — write the saveDocument() bytes straight back
      res = await window.inkwell.savePdfBytes(_pdfAttName, formB64);
    } else {
      // freehand/text/image annotations (baked onto the form-filled buffer if any)
      res = await window.inkwell.bakePdfAnnotations(_pdfAttName, _pdfAnnots, formB64);
    }
    if (!res?.ok) throw new Error(res?.error || 'save failed');
    _pdfAnnots = [];
    _pdfDirty = false;
    _pdfFormDirty = false;
  } catch (e) {
    console.error('PDF save failed:', e);
    _pdfDebugLog('save phase1-write', e);
    _updatePdfDirty();
    alert(_pdfSaveErrMsg(e));
    if (btn) btn.disabled = false;
    return;
  }
  // ── Phase 2: reload the saved file. The edits are ALREADY on disk; a reload
  // hiccup must NOT be reported as a save failure. ─────────────────────────────
  try {
    setPdfTool(null);
    if (!skipReload) await renderPdfPages(_pdfAttName, _pdfContainer);   // reload the saved file
  } catch (e) {
    console.error('PDF saved OK, but reloading the view failed:', e);
    _pdfDebugLog('save phase2-reload', e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Remove the on-screen edit overlays (text/image boxes + freehand strokes) from
// the current view. Used right after a "save as new" bake: the edits went into
// the NEW file, so the CURRENT view (still showing the untouched original while
// the new file loads) must not keep the edits drawn on top — otherwise the
// original briefly looks modified before the new file swaps in.
function _clearPdfOverlays() {
  if (!_pdfContainer) return;
  _pdfContainer.querySelectorAll('.pdf-obj-layer, .pdf-annot-layer').forEach(l => {
    while (l.firstChild) l.removeChild(l.firstChild);
  });
}

// Save the edits into a NEW PDF file (a sibling copy), leaving the original
// untouched, then switch the open tab to the new file so further edits land on
// the copy too.
async function savePdfEditsAsNew() {
  if (!_pdfAttName) return;
  _flushPdfTextEdit();   // commit any in-progress text box before reading _pdfAnnots
  if (_pdfPagesDirty) { await applyPdfPageOps(true); return; }
  const btn = document.getElementById('pdf-save-as');
  if (btn) btn.disabled = true;
  let newName = null;
  // ── Phase 1: the actual save (bake + write to disk). ONLY a failure here means
  // the edits weren't saved, so ONLY this shows the "save failed" popup. ────────
  try {
    const formB64 = await _collectPdfFormBytes();
    if (!_pdfAnnots.length && !formB64) { _updatePdfDirty(); if (btn) btn.disabled = false; return; }
    const suffix = window.i18n.t('pdf.copy_suffix');
    const res = _pdfAnnots.length
      ? await window.inkwell.bakePdfAnnotationsAsNew(_pdfAttName, _pdfAnnots, suffix, formB64)
      : await window.inkwell.savePdfBytesAsNew(_pdfAttName, formB64, suffix);
    if (!res?.ok || !res.name) throw new Error(res?.error || 'save failed');
    newName = res.name;
    _pdfAnnots = [];
    _pdfDirty = false;
    _pdfFormDirty = false;
  } catch (e) {
    console.error('PDF save-as-new failed:', e);
    _pdfDebugLog('saveAsNew phase1-write', e);
    _updatePdfDirty();
    alert(_pdfSaveErrMsg(e));
    if (btn) btn.disabled = false;
    return;
  }
  // ── Phase 2: open the NEW file in its OWN tab and switch to it. The original
  // tab is left UNTOUCHED so the original stays clean. Previously we hijacked the
  // current tab into the new file — so the tab that had been "the original" ended
  // up showing the edited copy, making the untouched original look modified until
  // you navigated away and back. The file is already saved; a UI hiccup here must
  // NOT be reported as a save failure.
  try {
    const base = newName.split('/').pop();
    setPdfTool(null);
    // Drop the edit overlays from the current (original) view so it never flashes
    // as "modified" while the new file's tab takes over.
    _clearPdfOverlays();
    openPdfFile({ name: base, path: `attachments/${newName}`, attachmentName: newName }, true);
    try { await loadTree(); } catch (_) {}           // surface it in the sidebar
    // PDFs sort to the very bottom of the tree — scroll the new file into view
    // and flash it so it's obvious it was created.
    _revealTreeNode(`attachments/${newName}`);
    // No "Saved as…" toast — the new file flashes in the sidebar as feedback.
  } catch (e) {
    console.error('PDF saved OK, but refreshing the view failed:', e);
    _pdfDebugLog('saveAsNew phase2-reload', e);
    // The new file exists on disk WITH the edits — don't alarm the user with a
    // "save failed" popup. Worst case the view didn't switch; reopening shows it.
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─── PDF page-operations panel ───────────────────────────────────────────────
function _u8ToB64(u8) {
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function _b64ToU8(b64) {
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// (Re)build the page plan as the identity of the freshly-loaded PDF.
function _initPdfPagePlan() {
  _pdfPages = [];
  _pdfMergeSources = {};
  _pdfMergeSeq = 0;
  _pdfPagesDirty = false;
  _pdfThumbCache.clear();
  if (_pdfDoc) {
    for (let i = 1; i <= _pdfDoc.numPages; i++)
      _pdfPages.push({ key: 'k' + (_pdfPageKeySeq++), src: 'main', srcIndex: i - 1, rot: 0 });
  }
  if (_pdfPagePanelOpen) renderPdfPagePanel();
}

function setPdfPagePanel(open) {
  _pdfPagePanelOpen = open;
  document.getElementById('pdf-pages')?.classList.toggle('active', open);
  renderPdfPagePanel();
}

function _updatePdfPageDirty() {
  const rev = document.getElementById('pp-revert');
  if (rev) rev.disabled = !_pdfPagesDirty;
  _updatePdfDirty();   // page edits also light up the toolbar Save / Save-as
}

// Lazy thumbnail loading + a render-concurrency cap. A large PDF (hundreds of
// pages) would otherwise fire ONE pdf.js render per page the instant the Pages
// panel opens — flooding the single pdf.js worker so the panel takes forever or
// never paints. Instead a page's thumbnail renders only when its card scrolls
// into the list (IntersectionObserver), at most a few at a time.
let _pdfThumbIO = null;
let _thumbActive = 0;
const _thumbQueue = [];
function _thumbPump() {
  while (_thumbActive < 3 && _thumbQueue.length) {
    const job = _thumbQueue.shift();
    _thumbActive++;
    Promise.resolve(job()).catch(() => {}).finally(() => { _thumbActive--; _thumbPump(); });
  }
}
function _queueThumb(img) {
  if (!img || img.dataset.loaded) return;
  _thumbQueue.push(async () => {
    if (img.dataset.loaded) return;
    const url = await _getPageThumb(img.dataset.src, parseInt(img.dataset.srcindex, 10)).catch(() => null);
    if (url) { img.src = url; img.dataset.loaded = '1'; }
  });
  _thumbPump();
}

// Render one page of a source doc to a cached PNG data URL for the thumbnail.
async function _getPageThumb(src, srcIndex) {
  const ck = src + ':' + srcIndex;
  if (_pdfThumbCache.has(ck)) return _pdfThumbCache.get(ck);
  const doc = src === 'main' ? _pdfDoc : _pdfMergeSources[src]?.doc;
  if (!doc) return null;
  const page = await doc.getPage(srcIndex + 1);
  const vp = page.getViewport({ scale: 0.32 });
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(vp.width));
  cv.height = Math.max(1, Math.ceil(vp.height));
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  const url = cv.toDataURL('image/png');
  _pdfThumbCache.set(ck, url);
  return url;
}

function _svgIcon(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

function _buildPdfThumb(p, idx) {
  const t = (k, v) => window.i18n.t(k, v);
  const card = document.createElement('div');
  card.className = 'pp-thumb';
  card.dataset.key = p.key;

  const imgWrap = document.createElement('div');
  imgWrap.className = 'pp-thumb-imgwrap';
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;   // don't let the native image-drag hijack the reorder
  img.style.transform = `rotate(${p.rot}deg)`;
  // Lazy: the thumbnail renders when the card scrolls into view (observed in
  // renderPdfPagePanel). An already-cached page paints instantly.
  img.dataset.src = p.src;
  img.dataset.srcindex = String(p.srcIndex);
  const _ck = p.src + ':' + p.srcIndex;
  if (_pdfThumbCache.has(_ck)) { img.src = _pdfThumbCache.get(_ck); img.dataset.loaded = '1'; }
  imgWrap.appendChild(img);
  card.appendChild(imgWrap);

  const foot = document.createElement('div');
  foot.className = 'pp-thumb-foot';
  const num = document.createElement('span');
  num.className = 'pp-thumb-num';
  num.textContent = String(idx + 1);
  const btns = document.createElement('div');
  btns.className = 'pp-thumb-btns';

  const rotBtn = document.createElement('button');
  rotBtn.className = 'pp-mini';
  rotBtn.title = t('pdf.rotate_page');
  rotBtn.innerHTML = _svgIcon('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>');
  rotBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    p.rot = (p.rot + 90) % 360;
    _pdfPagesDirty = true;
    renderPdfPagePanel();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'pp-mini del';
  delBtn.title = t('pdf.delete_page');
  delBtn.innerHTML = _svgIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>');
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_pdfPages.length <= 1) { alert(t('pdf.min_one_page')); return; }
    _pdfPages = _pdfPages.filter(x => x.key !== p.key);
    _pdfPagesDirty = true;
    renderPdfPagePanel();
  });

  btns.appendChild(rotBtn);
  btns.appendChild(delBtn);
  foot.appendChild(num);
  foot.appendChild(btns);
  card.appendChild(foot);

  // Pointer-based drag-reorder. HTML5 native DnD is unreliable here (the app's
  // window-level external-drop blocker interferes and the thumbnail image steals
  // the drag), so we sort with pointer events and commit on pointerup.
  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.pp-thumb-btns')) return;   // let rotate/delete work
    _startPdfThumbDrag(e, card);
  });
  return card;
}

// Live-sort the thumbnail cards in the DOM while dragging; on release, rebuild
// _pdfPages from the final DOM order.
function _startPdfThumbDrag(e, card) {
  e.preventDefault();
  const list = card.parentElement;
  if (!list) return;
  card.classList.add('pp-dragging');
  card.setPointerCapture?.(e.pointerId);

  // v1.0.984: coalesce pointermove → ONE reorder computation per animation frame.
  // Previously onMove ran on every pointermove (fires dozens of times/sec) and each
  // run read getBoundingClientRect for EVERY thumbnail — right after an insertBefore
  // that dirtied layout, forcing a synchronous reflow per card. On a PDF with many
  // pages that made dragging a page visibly lag. rAF-throttling reads layout at most
  // once per frame, which is all the display can show anyway.
  let _lastY = 0, _rafId = 0;
  const _reorder = () => {
    _rafId = 0;
    const cards = [...list.querySelectorAll('.pp-thumb')];
    let before = null;
    for (const c of cards) {
      if (c === card) continue;
      const r = c.getBoundingClientRect();
      if (_lastY < r.top + r.height / 2) { before = c; break; }
    }
    if (before) { if (card.nextElementSibling !== before) list.insertBefore(card, before); }
    else if (card !== list.lastElementChild) { list.appendChild(card); }
  };
  const onMove = (ev) => {
    _lastY = ev.clientY;
    if (!_rafId) _rafId = requestAnimationFrame(_reorder);
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
    card.classList.remove('pp-dragging');
    const order = [...list.querySelectorAll('.pp-thumb')].map(c => c.dataset.key);
    const changed = order.some((k, i) => _pdfPages[i] && _pdfPages[i].key !== k);
    if (changed) {
      _pdfPages = order.map(k => _pdfPages.find(p => p.key === k)).filter(Boolean);
      _pdfPagesDirty = true;
    }
    renderPdfPagePanel();   // refresh page numbers + dirty state
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function renderPdfPagePanel() {
  const panel = document.getElementById('pdf-page-panel');
  if (!panel) return;
  panel.style.display = _pdfPagePanelOpen ? 'flex' : 'none';
  if (!_pdfPagePanelOpen) { panel.innerHTML = ''; return; }
  const t = (k, v) => window.i18n.t(k, v);
  panel.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'pp-head';
  head.textContent = t('pdf.pages_panel');
  panel.appendChild(head);

  const top = document.createElement('div');
  top.className = 'pp-actions';
  const mergeBtn = document.createElement('button');
  mergeBtn.className = 'pp-btn';
  mergeBtn.textContent = t('pdf.merge_pdf');
  mergeBtn.addEventListener('click', () => pdfMergePick());
  top.appendChild(mergeBtn);
  panel.appendChild(top);

  const list = document.createElement('div');
  list.className = 'pp-list';
  _pdfPages.forEach((p, idx) => list.appendChild(_buildPdfThumb(p, idx)));
  panel.appendChild(list);

  // Lazy-render thumbnails as their cards scroll into the list (only visible
  // pages hit pdf.js → a 500-page PDF opens instantly instead of flooding the
  // worker). Recreate the observer each render; drop any queued work from a
  // previous PDF/panel (cached pages already painted in _buildPdfThumb).
  if (_pdfThumbIO) { try { _pdfThumbIO.disconnect(); } catch (_) {} }
  _thumbQueue.length = 0;
  _pdfThumbIO = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      _queueThumb(en.target.querySelector('img'));
      _pdfThumbIO.unobserve(en.target);
    }
  }, { root: list, rootMargin: '300px 0px' });
  // Observe all cards; eagerly render the first handful (visible on open) so the
  // top of the list paints even before the observer's first async callback.
  list.querySelectorAll('.pp-thumb').forEach((card, i) => {
    _pdfThumbIO.observe(card);
    if (i < 8) _queueThumb(card.querySelector('img'));
  });

  // Saving is done from the toolbar Save / Save-as (they commit page ops too).
  // The panel only needs a Revert to undo the staged reorder/rotate/delete/merge.
  const bottom = document.createElement('div');
  bottom.className = 'pp-actions pp-actions-bottom';
  const revertBtn = document.createElement('button');
  revertBtn.className = 'pp-btn'; revertBtn.id = 'pp-revert';
  revertBtn.textContent = t('pdf.revert');
  revertBtn.addEventListener('click', () => _initPdfPagePlan());
  bottom.appendChild(revertBtn);
  panel.appendChild(bottom);

  _updatePdfPageDirty();
}

// Import another PDF and append its pages to the plan (the "merge" operation).
async function pdfMergePick() {
  const t = (k, v) => window.i18n.t(k, v);
  let res;
  try { res = await window.inkwell.pickPdfForMerge(); } catch (_) { res = null; }
  if (!res || !res.dataB64) return;
  const bytes = _b64ToU8(res.dataB64);
  let doc;
  try {
    const pdfjsLib = await getPdfJs();
    doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;   // copy: getDocument detaches its buffer
  } catch (e) {
    alert(t('pdf.load_error') + ': ' + (e?.message || String(e)));
    return;
  }
  const src = 'merge' + (_pdfMergeSeq++);
  _pdfMergeSources[src] = { bytes, doc };
  for (let i = 0; i < doc.numPages; i++)
    _pdfPages.push({ key: 'k' + (_pdfPageKeySeq++), src, srcIndex: i, rot: 0 });
  _pdfPagesDirty = true;
  renderPdfPagePanel();
}

async function applyPdfPageOps(asNew) {
  const t = (k, v) => window.i18n.t(k, v);
  if (!_pdfAttName || !_pdfPagesDirty) return;
  if (!_pdfPages.length) { alert(t('pdf.min_one_page')); return; }
  ['pdf-save', 'pdf-save-as', 'pp-revert'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
  try {
    const plan = _pdfPages.map(p => ({ src: p.src, i: p.srcIndex, rot: ((p.rot % 360) + 360) % 360 }));
    const usedSrcs = new Set(plan.map(p => p.src).filter(s => s !== 'main'));
    const sources = {};
    for (const s of usedSrcs) {
      const b = _pdfMergeSources[s]?.bytes;
      if (b) sources[s] = _u8ToB64(b);
    }
    const res = await window.inkwell.applyPdfPageOps(_pdfAttName, plan, sources,
      { asNew: !!asNew, suffix: t('pdf.copy_suffix') });
    if (!res?.ok) throw new Error(res?.error || 'failed');
    if (asNew && res.name) {
      const newName = res.name, base = newName.split('/').pop();
      // Open the new file in its OWN tab (leave the original tab untouched) —
      // same reasoning as "save as new" for annotations.
      openPdfFile({ name: base, path: `attachments/${newName}`, attachmentName: newName }, true);
      try { await loadTree(); } catch (_) {}
      _revealTreeNode(`attachments/${newName}`);
      // No "Saved as…" toast — the new file flashes in the sidebar as feedback.
    } else {
      await renderPdfPages(_pdfAttName, _pdfContainer);
      showToast(t('pdf.pageops_done'));
    }
  } catch (e) {
    console.error('PDF page ops failed:', e);
    _updatePdfPageDirty();
    const raw = e?.message || String(e);
    const msg = /ENCRYPTED_PDF/.test(raw)
      ? t('pdf.protected')
      : t('pdf.pageops_failed', { err: raw });
    alert(msg);
  }
}

// Free pdf.js resources: a PDFDocumentProxy holds worker-side memory + the
// transferred ArrayBuffer, none of which is reclaimed until .destroy() is called.
// Without this, every PDF open/close left the previous doc (and each merge
// source's doc + raw bytes) leaking until GC. Call on reopen and on PDF close.
async function _destroyPdfDoc() {
  try { await _pdfDoc?.destroy?.(); } catch (_) {}
  _pdfDoc = null;
  for (const k in _pdfMergeSources) { try { await _pdfMergeSources[k]?.doc?.destroy?.(); } catch (_) {} }
  _pdfMergeSources = {};
}

async function renderPdfPages(attachmentName, container) {
  // Claim this render up front so any in-flight render (a previous PDF still
  // painting, or a zoom) is superseded IMMEDIATELY — before we destroy its doc.
  // Otherwise the interrupted render can call getPage() on the just-destroyed doc,
  // throw, and flash a red "failed to load" while switching PDFs quickly.
  const myToken = ++_pdfRenderToken;
  _pdfContainer = container;
  await _destroyPdfDoc();   // release the previously-open PDF before loading the next
  _pdfZoom = 1.0;
  _pdfAttName = attachmentName;   // for the annotation editor's save
  _pdfAnnots = [];
  _pdfDirty = false;
  _pdfHasForm = false;
  _pdfFormDirty = false;
  setPdfTool(null);
  _updatePdfDirty();
  _updatePdfZoomLabel();
  // Don't blank the container to its dark background while the next PDF loads —
  // that's the "black flash" when switching PDFs. Keep the previously rendered
  // pages up; _renderPdfDoc swaps them for the new ones atomically the moment its
  // first page is ready. No "loading" text — the swap is fast and the old pages
  // stay visible until then, so an indicator only added visual noise.
  try {
    const pdfjsLib = await getPdfJs();
    const bytes = await window.inkwell.readAttachment(attachmentName);
    const data = bytes instanceof Uint8Array
      ? bytes
      : (bytes?.buffer ? new Uint8Array(bytes.buffer) : new Uint8Array(bytes));
    // Guard against an empty / non-PDF attachment (e.g. a 0-byte leftover from an
    // interrupted save): pdf.js throws a cryptic InvalidPDFException and we'd log a
    // scary console.error. Detect it up front and show a clear, calm message.
    const hasPdfHeader = data.length >= 5
      && data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46; // "%PDF"
    if (!data.length || !hasPdfHeader) {
      if (myToken !== _pdfRenderToken) return;   // superseded — leave the newer render's view
      console.warn('PDF empty or not a PDF (skipped):', attachmentName, 'bytes=' + data.length);
      container.innerHTML =
        `<div style="padding:18px;color:#e0758a;font-size:13px;text-align:center">` +
        `${escHtml(window.i18n.t('pdf.empty'))}</div>`;
      return;
    }
    const doc = await pdfjsLib.getDocument({ data }).promise;
    if (myToken !== _pdfRenderToken) { try { await doc.destroy(); } catch (_) {} return; }   // superseded while parsing
    _pdfDoc = doc;
    _initPdfPagePlan();   // reset the page-ops plan to the identity of the new doc
    await _renderPdfDoc();
  } catch (err) {
    // Superseded by a newer switch/zoom? Then this throw is just the interruption
    // (getPage on a destroyed doc, etc.) — stay silent, the newer render owns the view.
    if (myToken !== _pdfRenderToken) return;
    console.error('PDF render failed:', err);
    container.innerHTML =
      `<div style="padding:18px;color:#e0758a;font-size:13px;text-align:center">` +
      `${escHtml(window.i18n.t('pdf.load_error'))}: ${escHtml(err?.message || String(err))}</div>`;
  }
}

async function _renderPdfDoc() {
  const pdf = _pdfDoc, container = _pdfContainer;
  if (!pdf || !container) return;
  const pdfjsLib = await getPdfJs();
  const token = _pdfRenderToken;   // callers (renderPdfPages / setPdfZoom) own the bump; we only observe it
  const dpr = window.devicePixelRatio || 1;
  const displayScale = PDF_BASE_SCALE * _pdfZoom;

  // Built off-DOM so the user never sees a half-empty container while pages
  // render progressively.
  const inner = document.createElement('div');
  inner.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px';

  let firstAttached = false;
  for (let i = 1; i <= pdf.numPages; i++) {
    if (token !== _pdfRenderToken) return;   // a newer render started → abort
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: displayScale });          // CSS px
    const renderViewport = page.getViewport({ scale: displayScale * dpr }); // device px

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap';
    wrap.style.width = viewport.width + 'px';
    wrap.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.width = renderViewport.width;
    canvas.height = renderViewport.height;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    wrap.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport }).promise;

    // Selectable/copyable text layer overlaid on the canvas.
    try {
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      textDiv.style.setProperty('--scale-factor', String(displayScale));
      const textContent = await page.getTextContent();
      const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textDiv, viewport });
      await tl.render();
      wrap.appendChild(textDiv);
    } catch (e) { /* text selection not available for this page */ }

    // Freehand annotation overlay (on top of the text layer). pointer-events are
    // off unless a tool is active (so text stays selectable in view mode).
    const annotSvg = document.createElementNS(SVGNS, 'svg');
    annotSvg.setAttribute('class', 'pdf-annot-layer');
    annotSvg.setAttribute('width', String(viewport.width));
    annotSvg.setAttribute('height', String(viewport.height));
    annotSvg.dataset.page = String(i);
    wrap.appendChild(annotSvg);
    const pageHpt = viewport.height / displayScale;   // page height in PDF points
    _drawPageAnnots(annotSvg, i, displayScale, pageHpt);
    _wirePdfAnnotLayer(annotSvg, i, displayScale, pageHpt);

    // HTML object layer (text boxes + images) above the stroke layer.
    const objLayer = document.createElement('div');
    objLayer.className = 'pdf-obj-layer';
    objLayer.dataset.page = String(i);
    objLayer.dataset.hpt = String(pageHpt);
    objLayer.dataset.wpt = String(viewport.width / displayScale);
    objLayer.style.width = viewport.width + 'px';
    objLayer.style.height = viewport.height + 'px';
    wrap.appendChild(objLayer);
    _drawPageObjs(objLayer, i, displayScale, pageHpt);
    _wirePdfObjLayer(objLayer, i, displayScale, pageHpt);

    // Interactive AcroForm fields (text/checkbox/radio/dropdown) via pdf.js.
    // Only build the layer when the page actually has form widgets. Edits bind
    // to pdf.annotationStorage; saved with pdf.saveDocument().
    try {
      const pageAnnots = await page.getAnnotations({ intent: 'display' });
      if (token !== _pdfRenderToken) return;
      if (pageAnnots.some(a => a.subtype === 'Widget')) {
        _pdfHasForm = true;
        const formDiv = document.createElement('div');
        formDiv.className = 'annotationLayer pdf-formfield-layer';
        formDiv.style.setProperty('--scale-factor', String(displayScale));
        formDiv.style.setProperty('--total-scale-factor', String(displayScale));
        wrap.appendChild(formDiv);
        const flVp = viewport.clone({ dontFlip: true });
        const layer = new pdfjsLib.AnnotationLayer({
          div: formDiv, accessibilityManager: null, annotationCanvasMap: null,
          annotationEditorUIManager: null, page, viewport: flVp,
        });
        await layer.render({
          annotations: pageAnnots, div: formDiv, page, viewport: flVp,
          linkService: _pdfLinkStub(), downloadManager: null, renderForms: true,
          annotationStorage: pdf.annotationStorage,
        });
        formDiv.addEventListener('input', _onPdfFormInput, true);
        formDiv.addEventListener('change', _onPdfFormInput, true);
      }
    } catch (e) { /* no forms on this page, or render unsupported — ignore */ }

    if (token !== _pdfRenderToken) return;
    inner.appendChild(wrap);
    if (!firstAttached) { container.innerHTML = ''; container.appendChild(inner); firstAttached = true; }
  }
}

function _updatePdfZoomLabel() {
  const lbl = $('pdf-zoom-label');
  if (lbl) lbl.textContent = Math.round(_pdfZoom * 100) + '%';
}

function setPdfZoom(z) {
  _pdfZoom = Math.max(0.4, Math.min(4, z));
  _updatePdfZoomLabel();
  ++_pdfRenderToken;   // supersede any in-flight render before re-painting at the new zoom
  _renderPdfDoc();
}

function pdfZoomFitWidth() {
  if (!_pdfDoc || !_pdfContainer) return;
  _pdfDoc.getPage(1).then(page => {
    const natural = page.getViewport({ scale: 1 });               // natural width in pt
    const avail = _pdfContainer.clientWidth - 40;                  // minus padding (20px each side)
    if (avail > 0) setPdfZoom((avail / natural.width) / PDF_BASE_SCALE);
  }).catch(() => {});
}

let _drawReturnPath = null;   // the note the drawing was opened from

async function closeCanvas() {
  const idx = tabs.findIndex((t, i) => t.type === 'canvas' && i === activeTabIdx);
  const anyIdx = idx >= 0 ? idx : tabs.findIndex(t => t.type === 'canvas');
  if (anyIdx >= 0) {
    const back = _drawReturnPath;
    await closeTab(anyIdx);
    // Back to the note the drawing was opened from, if it is still open.
    if (back) {
      const i = tabs.findIndex(t => t.path === back && !t.type);
      if (i !== -1 && i !== activeTabIdx) await switchTab(i);
    }
    return;
  }
  $('canvas-overlay').style.display = 'none';
  $('btn-canvas').classList.remove('active');
}

// Inline-rename the open .draw file from its title in the canvas header.
// Preserves the ".draw" extension (NOT a .md note).
function renameDrawTitle() {
  const titleEl = $('canvas-title');
  if (!titleEl || !activeCanvasPath) return;
  const oldPath = activeCanvasPath;
  const curName = oldPath.split('/').pop().replace(/\.draw$/i, '');
  const parent = oldPath.includes('/') ? oldPath.split('/').slice(0, -1).join('/') : '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'canvas-title-input';
  input.value = curName;
  input.spellcheck = false;
  titleEl.style.display = 'none';
  titleEl.after(input);
  attachNameGuard(input);   // block forbidden filename chars as you type (like notes)

  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const val = input.value.trim().replace(FORBIDDEN_NAME_RE_G, '-').replace(/\.draw$/i, '');
    input.remove();
    titleEl.style.display = '';
    if (!commit || !val || val === curName) return;
    const newPath = (parent ? `${parent}/${val}` : val) + '.draw';
    if (newPath === oldPath) return;
    await window.inkwell.renameNote(oldPath, newPath);
    renameInTreeOrder(oldPath, newPath);
    // Update the open tab + active state.
    const tab = tabs.find(t => t.type === 'canvas' && t.path === oldPath);
    if (tab) { tab.path = newPath; tab.name = val; }
    if (activeCanvasPath === oldPath) activeCanvasPath = newPath;
    if (state.currentPath === oldPath) state.currentPath = newPath;
    titleEl.textContent = val;
    renderTabBar();
    await loadTree();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.focus(); input.select();
}

// Wire the draw-title context menu (Rename / Copy / Paste). Idempotent.
let _drawCtxWired = false;
function setupDrawContextMenu() {
  if (_drawCtxWired) return;
  const menu = $('draw-context-menu');
  if (!menu) return;
  _drawCtxWired = true;
  document.addEventListener('click', e => {
    if (!e.target.closest('#draw-context-menu')) menu.style.display = 'none';
  });
  const curName = () => activeCanvasPath
    ? activeCanvasPath.split('/').pop().replace(/\.draw$/i, '') : '';
  $('drawctx-rename')?.addEventListener('click', () => {
    menu.style.display = 'none';
    renameDrawTitle();
  });
  $('drawctx-copy')?.addEventListener('click', async () => {
    menu.style.display = 'none';
    try { await navigator.clipboard.writeText(curName()); } catch(_) {}
  });
  $('drawctx-paste')?.addEventListener('click', async () => {
    menu.style.display = 'none';
    if (!activeCanvasPath) return;
    let txt = '';
    try { txt = await navigator.clipboard.readText(); } catch(_) {}
    txt = (txt || '').split('\n')[0].trim().replace(FORBIDDEN_NAME_RE_G, '-').replace(/\.draw$/i, '');
    if (!txt || txt === curName()) return;
    const oldPath = activeCanvasPath;
    const parent = oldPath.includes('/') ? oldPath.split('/').slice(0, -1).join('/') : '';
    const newPath = (parent ? `${parent}/${txt}` : txt) + '.draw';
    if (newPath === oldPath) return;
    await window.inkwell.renameNote(oldPath, newPath);
    renameInTreeOrder(oldPath, newPath);
    const tab = tabs.find(t => t.type === 'canvas' && t.path === oldPath);
    if (tab) { tab.path = newPath; tab.name = txt; }
    if (activeCanvasPath === oldPath) activeCanvasPath = newPath;
    if (state.currentPath === oldPath) state.currentPath = newPath;
    const titleEl = $('canvas-title'); if (titleEl) titleEl.textContent = txt;
    renderTabBar();
    await loadTree();
  });
}

// ─── Vault & Security ────────────────────────────────────────────────────────

async function checkVaultLock() {
  const info = await window.inkwell.vault.getInfo().catch(() => null);
  if (!info) return;
  if (info.encryptionEnabled) {
    // The passphrase is never stored ("remember password" was removed), so there's
    // no silent passkey unlock. autoUnlock now only reports whether the vault is
    // ALREADY unlocked in main (e.g. right after a restore set the DEK) — in that
    // case skip the overlay; otherwise ALWAYS prompt.
    const auto = await window.inkwell.vault.autoUnlock().catch(() => ({ ok: false }));
    if (auto && auto.ok) return;
    // BLOCK init here until the user actually unlocks: loadTree()/restoreSession()
    // must run with ENCRYPTION_KEY set, else the tree is empty and encrypted PDFs
    // read as ciphertext ("Invalid PDF structure").
    await showUnlockOverlay();
  }
}

function showUnlockOverlay() {
  // Resolves once the vault is successfully unlocked, so init can wait for it.
  let _resolveUnlock = () => {};
  const _unlocked = new Promise(r => { _resolveUnlock = r; });
  const ov = document.getElementById('unlock-overlay');
  if (ov) {
    ov.style.display = 'flex';
    setTimeout(() => document.getElementById('unlock-pass')?.focus(), 100);
  }

  const btn = document.getElementById('unlock-btn');
  const pass = document.getElementById('unlock-pass');
  const err  = document.getElementById('unlock-err');

  let failCount = 0;
  let _failNotif = null;   // the single bell entry for THIS unlock session (updated with the running count)
  const doUnlock = async () => {
    if (btn.disabled) return;   // ignore re-entrant submits while checking
    btn.disabled = true; btn.textContent = window.i18n.t('unlock.checking'); err.textContent = '';
    const result = await window.inkwell.vault.unlock(pass.value);
    if (result.ok) {
      failCount = 0;
      // The passphrase is NEVER stored (the "remember password" option was removed):
      // it lives only in your head + RAM while the vault is open. Strongest at-rest.
      ov.style.display = 'none';
      _resolveUnlock();   // unblock init: now ENCRYPTION_KEY is set in main
    } else {
      failCount++;
      // Easter egg: every 3rd wrong try (3rd, 6th, 9th…) show one of these in
      // white, cycling through them, instead of the usual red error. White is
      // hard-coded (not var(--text-0)) because the unlock overlay is always dark.
      const EGG = ['Hello, friend?', 'Control is an illusion.', 'Are you a 1 or a 0?'];
      if (failCount % 3 === 0) {
        err.textContent = EGG[(failCount / 3 - 1) % EGG.length];
        err.style.color = '#fff';
      } else {
        // Always use the localized string: vault:unlock only ever returns the
        // generic (hardcoded-Italian) 'Passphrase errata', so preferring
        // result.error would leak Italian into every other UI language.
        err.textContent = window.i18n.t('unlock.error');
        err.style.color = 'var(--red)';
      }
      btn.disabled = false; btn.textContent = window.i18n.t('unlock.btn');
      pass.value = ''; pass.focus();
      // Security trail: after MORE than 3 wrong tries, keep ONE bell entry for
      // this unlock session showing the running total (so 6 wrong tries → a
      // single "6 failed unlock attempts", not six rows) with the date/time.
      // Under 4 tries → a simple typo, not worth a notification.
      if (failCount > 3) {
        try {
          if (_failNotif) _eventNotifs = _eventNotifs.filter(x => x !== _failNotif);
          else _eventUnread++;   // count this session once toward the bell badge
          _failNotif = { text: window.i18n.t('notif.unlock_failed', { n: failCount }), ts: Date.now(), ok: false };
          _eventNotifs.unshift(_failNotif);
          _eventNotifs = _eventNotifs.slice(0, 30);
          _saveEventNotifs();
          updateNotifBell();
        } catch (_) {}
      }
    }
  };

  // Wire submit handlers ONCE even if showUnlockOverlay runs again, else the
  // listeners (and the fail counter) would fire multiple times per click.
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', doUnlock);
    pass?.addEventListener('keydown', e => { if (e.key === 'Enter') doUnlock(); });
  }

  // Eye toggle: reveal/hide the typed passphrase (so the user can check it).
  const eye = document.getElementById('unlock-eye');
  if (eye && !eye.dataset.wired) {
    eye.dataset.wired = '1';
    const EYE_OPEN  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF   = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    eye.addEventListener('click', () => {
      const revealed = pass.dataset.revealed === '1';
      if (revealed) {
        // hide again: re-apply the asterisk-mask font
        pass.style.fontFamily = "'AmelieMask', monospace";
        pass.style.letterSpacing = '3px';
        pass.dataset.revealed = '0';
        eye.innerHTML = EYE_OPEN;
      } else {
        // reveal: switch to the readable editor font
        pass.style.fontFamily = 'var(--editor-font)';
        pass.style.letterSpacing = 'normal';
        pass.dataset.revealed = '1';
        eye.innerHTML = EYE_OFF;
      }
      pass.focus();
    });
  }

  return _unlocked;
}

// The settings window always OPENS at its default CSS size (~850×525): drag
// resizes last only for the current app session and are NOT persisted.
function setupSettingsPanelSizeMemory() {
  try { localStorage.removeItem('amelie-settings-size'); } catch (_) {}   // drop sizes saved by v305
}

async function openSecurityTab() {
  const info = await window.inkwell.vault.getInfo().catch(() => ({}));

  const vaultPathEl  = document.getElementById('sec-vault-path');
  const encIconEl    = document.getElementById('sec-enc-icon');
  const encStatusEl  = document.getElementById('sec-enc-status');
  const noteCountEl  = document.getElementById('sec-note-count');

  if (vaultPathEl) vaultPathEl.textContent = info.vaultPath || '—';
  const vaultPathInput = document.getElementById('cfg-vault-path');
  if (vaultPathInput) vaultPathInput.value = info.vaultPath || '';
  if (encIconEl) {
    // Closed/open padlock SVG (stroke style like the rest of the app)
    encIconEl.innerHTML = info.encryptionEnabled
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.83-1.2"/></svg>';
    encIconEl.classList.toggle('enc-on', !!info.encryptionEnabled);
  }
  if (encStatusEl) encStatusEl.textContent = info.encryptionEnabled
    ? window.i18n.t('vault_settings.enc_on')
    : window.i18n.t('vault_settings.enc_off');
  if (noteCountEl) noteCountEl.textContent = window.i18n.t('vault_settings.note_count', { n: (info.noteCount ?? '—') });
  // Single "Contenuto" block: notes + every attachment type, one per row.
  const contentEl = document.getElementById('sec-content-stats');
  if (contentEl) {
    const a = info.attachments || {};
    const cap = (x) => String(x || '').charAt(0).toUpperCase() + String(x || '').slice(1);
    const rows = [
      [window.i18n.t('vault_settings.card_notes'), info.noteCount ?? '—'],
      ['PDF',    a.pdf    ?? 0],
      ['Video',  a.video  ?? 0],
      ['Audio',  a.audio  ?? 0],
      [cap(window.i18n.t('vault_settings.att_images')), a.image ?? 0],
    ];
    // Two voices per row → zebra-striped full-width rows (alternating shades).
    // An odd count gets an empty cell so the last row keeps the two-column look.
    const cells = rows.map(([label, n]) =>
      `<div class="vc-cell"><span>${escHtml(String(label))}</span><span class="vc-num">${escHtml(String(n))}</span></div>`);
    let html = '<div class="vc-table">';
    for (let i = 0; i < cells.length; i += 2) html += '<div class="vc-row">' + cells[i] + (cells[i + 1] || '<div class="vc-cell"></div>') + '</div>';
    contentEl.innerHTML = html + '</div>';
  }

  // Encryption is driven by a master toggle. Reset to the real state: the
  // enable/disable forms stay hidden until the user flips the toggle.
  const enc = !!info.encryptionEnabled;
  const toggle      = document.getElementById('cfg-encryption-toggle');
  const algoRow     = document.getElementById('sec-algo-row');
  const enableForm  = document.getElementById('sec-enable-enc');
  const disableForm = document.getElementById('sec-disable-enc');
  if (toggle) { toggle.checked = enc; toggle.dataset.enc = enc ? '1' : '0'; }
  if (enableForm)  enableForm.style.display  = 'none';
  if (disableForm) disableForm.style.display = 'none';
  // Single cipher available (AES — this Electron's BoringSSL has no ChaCha), so
  // the chooser is just a static "AES-256-GCM" label. Keep data-algo in sync so
  // the enable handler reads the right value.
  const algoBox = document.getElementById('sec-enc-algo');
  if (algoBox) {
    const active = enc ? (info.encryptionAlgo === 'chacha' ? 'chacha' : 'aes') : 'aes';
    algoBox.dataset.algo = active;
    algoBox.textContent = active === 'chacha' ? 'ChaCha20-Poly1305' : 'AES-256-GCM';
  }
  if (algoRow) algoRow.style.display = enc ? 'flex' : 'none';

  // "Remember password" was removed: the passphrase is never stored (typed each
  // launch), so there's no keyring/obfuscation concern to surface here.

  // Rest-mode switch — reflect the current mode (at-rest vs plaintext-while-open).
  const restmodeRow = document.getElementById('sec-restmode-row');
  if (restmodeRow) restmodeRow.style.display = enc ? '' : 'none';
  const restmodeRes = document.getElementById('sec-restmode-result');
  if (restmodeRes) { restmodeRes.textContent = ''; restmodeRes.className = 'test-result'; }
  if (enc) {
    const openPlain = !!info.encryptionOpenPlaintext;
    const liveTgl = document.getElementById('sec-enc-rest-live-tgl');
    if (liveTgl) liveTgl.checked = !openPlain;   // toggle = "encrypt at rest": ON = encrypted
    // The plaintext+sync warning lives only in the Backup/Sync tabs (not here in
    // Vault, where you'd enable it anyway).
  }
}

// Reveal/hide toggle for a masked password input (same trick as the unlock
// overlay: swap the AmelieMask font for the readable one; the input stays
// type=text so .value is always the real text).
const _EYE_OPEN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const _EYE_OFF_SVG  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
function wirePasswordEye(input, eye) {
  if (!input || !eye || eye.dataset.wired) return;
  eye.dataset.wired = '1';
  eye.innerHTML = _EYE_OPEN_SVG;
  eye.addEventListener('click', () => {
    const revealed = input.dataset.revealed === '1';
    input.style.fontFamily   = revealed ? "'AmelieMask', monospace" : 'var(--editor-font)';
    input.style.letterSpacing = revealed ? '3px' : 'normal';
    input.dataset.revealed = revealed ? '0' : '1';
    eye.innerHTML = revealed ? _EYE_OPEN_SVG : _EYE_OFF_SVG;
    input.focus();
  });
}

// Eye toggle for a masked type=text input (Samba/WebDAV password): flips the
// CSS mask (-webkit-text-security) so the value shows in clear on demand. The
// field stays type=text on purpose — a real type=password would let Chromium's
// password manager harvest/autofill the credential into its profile (userData).
function wirePasswordSecEye(input, eye) {
  if (!input || !eye || eye.dataset.wired) return;
  eye.dataset.wired = '1';
  eye.innerHTML = _EYE_OPEN_SVG;
  eye.addEventListener('click', () => {
    const revealed = input.style.webkitTextSecurity === 'none';
    input.style.webkitTextSecurity = revealed ? 'disc' : 'none';
    eye.innerHTML = revealed ? _EYE_OPEN_SVG : _EYE_OFF_SVG;
    input.focus();
  });
}

function setupSecurityTab() {
  // Eye toggles on the enable-encryption passphrase + confirm fields.
  wirePasswordEye(document.getElementById('sec-new-pass'),  document.getElementById('sec-new-pass-eye'));
  wirePasswordEye(document.getElementById('sec-new-pass2'), document.getElementById('sec-new-pass2-eye'));
  wirePasswordEye(document.getElementById('sec-disable-pass'), document.getElementById('sec-disable-pass-eye'));

  // Master encryption toggle: flip ON (when off) → reveal algo + passphrase to
  // enable; flip OFF (when on) → reveal passphrase to decrypt/disable.
  const encToggle = document.getElementById('cfg-encryption-toggle');
  if (encToggle && !encToggle.dataset.wired) {
    encToggle.dataset.wired = '1';
    encToggle.addEventListener('change', (e) => {
      const on  = e.target.checked;
      const enc = e.target.dataset.enc === '1';   // real current state
      const algoRow     = document.getElementById('sec-algo-row');
      const enableForm  = document.getElementById('sec-enable-enc');
      const disableForm = document.getElementById('sec-disable-enc');
      const algoBox     = document.getElementById('sec-enc-algo');
      if (!enc) {
        // not encrypted yet → toggle reveals the enable flow (selectable cipher)
        if (algoBox) algoBox.classList.remove('locked');
        if (algoRow)     algoRow.style.display     = on ? 'flex' : 'none';
        if (enableForm)  enableForm.style.display  = on ? 'block' : 'none';
        if (disableForm) disableForm.style.display = 'none';
        if (on) document.getElementById('sec-new-pass')?.focus();
      } else {
        // encrypted → toggle OFF reveals the disable (decrypt) flow
        if (algoBox) algoBox.classList.add('locked');
        if (algoRow)     algoRow.style.display     = 'flex';
        if (enableForm)  enableForm.style.display  = 'none';
        if (on) {
          // toggled back ON → just hide the disable form, nothing changed
          if (disableForm) disableForm.style.display = 'none';
        } else {
          // User wants to DISABLE. Do NOT show the switch as off yet: encryption
          // stays ACTIVE until the correct passphrase actually decrypts the vault.
          // Revert the switch to ON and reveal the decrypt form — it flips to OFF
          // only after a successful disable (openSecurityTab re-reads the state).
          e.target.checked = true;
          if (disableForm) disableForm.style.display = 'block';
          document.getElementById('sec-disable-pass')?.focus();
        }
      }
    });
  }

  // "Remember password" and the keyring-backend toggle were removed: the vault
  // passphrase is never persisted, so there's no keyring/obfuscation to manage.

  // Enable encryption — single cipher (AES-256-GCM), shown as a static label.
  // Remove unused media: scan (dry-run) → confirm with count/size → delete.
  document.getElementById('btn-remove-unused-media')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-remove-unused-media');
    const fmtBytes = (b) => b < 1024 ? b + ' B'
      : b < 1024 * 1024 ? (b / 1024).toFixed(0) + ' KB'
      : (b / (1024 * 1024)).toFixed(1) + ' MB';
    if (btn) btn.disabled = true;
    try {
      // No confirm popup — delete directly and just report how many were removed.
      const res = await window.inkwell.removeUnusedMedia(true);
      if (!res || !res.count) { showToast(window.i18n.t('vault_settings.unused_none')); return; }
      showToast(window.i18n.t('vault_settings.unused_done', { count: res.count, size: fmtBytes(res.bytes) }));
      try { await openSecurityTab(); } catch (_) {}                 // refresh content stats
    } catch (_) {
      showToast(window.i18n.t('vault_settings.unused_scan_err'));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // Map a vault IPC error to a localized message. The main process returns a
  // machine `code` (WRONG_PASS, …) plus a hardcoded-Italian `error` string;
  // prefer the localized code so the message follows the UI language.
  const vaultErrMsg = (r) => {
    const KEY = {
      WRONG_PASS:         'error.wrong_pass',
      WRONG_CURRENT_PASS: 'error.wrong_current_pass',
      ENC_INACTIVE:       'error.enc_inactive',
      PASS_REQUIRED:      'error.pass_required',
      AES_UNAVAILABLE:    'error.aes_unavailable',
    }[r && r.code];
    return KEY ? window.i18n.t(KEY) : ((r && r.error) || window.i18n.t('status.error'));
  };

  document.getElementById('sec-btn-enable-enc')?.addEventListener('click', async () => {
    const p1 = document.getElementById('sec-new-pass').value;
    const p2 = document.getElementById('sec-new-pass2').value;
    const res = document.getElementById('sec-enc-result');
    if (p1.length < 8) { res.textContent = '✗ ' + window.i18n.t('error.pass_short'); res.className = 'test-result fail'; return; }
    if (p1 !== p2)       { res.textContent = '✗ ' + window.i18n.t('error.pass_mismatch'); res.className = 'test-result fail'; return; }
    res.textContent = window.i18n.t('vault_settings.encrypting'); res.className = 'test-result';
    const algo = document.getElementById('sec-enc-algo')?.dataset.algo || 'aes';
    const restTgl = document.getElementById('sec-enc-rest-tgl');
    const openPlaintext = restTgl ? !restTgl.checked : false;   // toggle = "encrypt at rest": ON = encrypted (default)
    try {
      const result = await window.inkwell.vault.enableEncryption(p1, algo, openPlaintext);
      if (result.ok) {
        const rep = result.failed ? '  ⚠ ' + window.i18n.t('vault_settings.convert_report', { converted: result.converted ?? 0, failed: result.failed }) : '';
        res.textContent = '✓ ' + window.i18n.t('vault_settings.enc_enabled_msg') + rep;
        res.className = result.failed ? 'test-result fail' : 'test-result ok';
        await openSecurityTab();
      } else {
        res.textContent = '✗ ' + vaultErrMsg(result); res.className = 'test-result fail';
      }
    } catch (e) {
      res.textContent = '✗ ' + (e && e.message || window.i18n.t('status.error')); res.className = 'test-result fail';
    }
  });

  // Rest-mode live switch (when encryption is already active): decrypt-to-disk
  // or re-encrypt the whole vault via setRestMode.
  const restLiveTgl = document.getElementById('sec-enc-rest-live-tgl');
  if (restLiveTgl) restLiveTgl.addEventListener('change', async () => {
    const res  = document.getElementById('sec-restmode-result');
    const openPlaintext = !restLiveTgl.checked;   // toggle = "encrypt at rest": ON = encrypted, OFF = plaintext
    if (res) { res.textContent = window.i18n.t('vault_settings.applying'); res.className = 'test-result'; }
    try {
      const result = await window.inkwell.vault.setRestMode(openPlaintext);
      if (result?.ok) {
        if (res) {
          const rep = result.failed ? '  ⚠ ' + window.i18n.t('vault_settings.convert_report', { converted: result.converted ?? 0, failed: result.failed }) : '';
          res.textContent = '✓ ' + window.i18n.t('vault_settings.rest_applied') + rep;
          res.className = result.failed ? 'test-result fail' : 'test-result ok';
        }
      } else {
        if (res) { res.textContent = '✗ ' + (result?.error || window.i18n.t('status.error')); res.className = 'test-result fail'; }
        await openSecurityTab();   // revert the toggle to the real state
      }
    } catch (e) {
      if (res) { res.textContent = '✗ ' + (e?.message || window.i18n.t('status.error')); res.className = 'test-result fail'; }
      await openSecurityTab();
    }
  });

  // Enable-flow rest-mode toggle ("encrypt at rest"): reveal the plaintext-mode
  // security caveat only when the toggle is OFF (i.e. plaintext-while-open).
  const restEnableTgl = document.getElementById('sec-enc-rest-tgl');
  if (restEnableTgl) restEnableTgl.addEventListener('change', () => {
    const w = document.getElementById('sec-enc-restmode-warn');
    if (w) w.style.display = restEnableTgl.checked ? 'none' : '';
  });

  // Disable encryption
  document.getElementById('sec-btn-disable-enc')?.addEventListener('click', async () => {
    const pass = document.getElementById('sec-disable-pass').value;
    const res  = document.getElementById('sec-disable-result');
    if (!pass) { res.textContent = '✗ ' + window.i18n.t('vault_settings.enter_passphrase'); res.className = 'test-result fail'; return; }
    res.textContent = window.i18n.t('vault_settings.decrypting'); res.className = 'test-result';
    const result = await window.inkwell.vault.disableEncryption(pass);
    if (result.ok) {
      const rep = result.failed ? '  ⚠ ' + window.i18n.t('vault_settings.convert_report', { converted: result.converted ?? 0, failed: result.failed }) : '';
      res.textContent = '✓ ' + window.i18n.t('vault_settings.enc_disabled_msg') + rep;
      res.className = result.failed ? 'test-result fail' : 'test-result ok';
      await openSecurityTab();
    } else {
      res.textContent = '✗ ' + vaultErrMsg(result); res.className = 'test-result fail';
    }
  });

  // Cancel the disable-encryption flow: hide the decrypt form, clear the field,
  // and leave encryption ACTIVE (the toggle was kept ON, so nothing to revert).
  document.getElementById('sec-btn-cancel-disable')?.addEventListener('click', () => {
    const form = document.getElementById('sec-disable-enc');
    const pass = document.getElementById('sec-disable-pass');
    const res  = document.getElementById('sec-disable-result');
    if (form) form.style.display = 'none';
    if (pass) pass.value = '';
    if (res) { res.textContent = ''; res.className = 'test-result'; }
    const tgl = document.getElementById('cfg-encryption-toggle');
    if (tgl) tgl.checked = true;   // encryption stays on
  });

  // Change passphrase
  document.getElementById('sec-btn-change')?.addEventListener('click', async () => {
    const oldP = document.getElementById('sec-old-pass').value;
    const newP = document.getElementById('sec-change-new').value;
    const res  = document.getElementById('sec-change-result');
    if (!oldP || newP.length < 8) { res.textContent = '✗ ' + window.i18n.t('vault_settings.invalid_passphrase'); res.className = 'test-result fail'; return; }
    res.textContent = window.i18n.t('vault_settings.updating'); res.className = 'test-result';
    const result = await window.inkwell.vault.changePassphrase(oldP, newP);
    if (result.ok) {
      res.textContent = '✓ ' + window.i18n.t('vault_settings.pass_updated_msg'); res.className = 'test-result ok';
      document.getElementById('sec-old-pass').value = '';
      document.getElementById('sec-change-new').value = '';
    } else {
      res.textContent = '✗ ' + vaultErrMsg(result); res.className = 'test-result fail';
    }
  });
}

// ─── Table builder ────────────────────────────────────────────────────────────

function setupTableBuilder() {
  const btn = $('btn-table');
  const popup = $('table-popup');
  if (!btn || !popup) return;

  // Build 8×8 grid
  const grid = $('tp-grid');
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'tp-cell';
      cell.dataset.row = r; cell.dataset.col = c;
      cell.addEventListener('mouseover', () => highlightGrid(r, c));
      cell.addEventListener('click', () => insertTable(r + 1, c + 1));
      grid.appendChild(cell);
    }
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = popup.style.display === 'none';
    if (willOpen) closeOtherDropdowns(popup);
    const r = btn.getBoundingClientRect();
    popup.style.left = r.left + 'px';
    popup.style.top  = (r.bottom + 4) + 'px';
    popup.style.display = willOpen ? 'block' : 'none';
    highlightGrid(-1, -1);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-table') && !e.target.closest('#table-popup'))
      popup.style.display = 'none';
  });
}

function highlightGrid(row, col) {
  document.querySelectorAll('.tp-cell').forEach(cell => {
    cell.classList.toggle('on',
      parseInt(cell.dataset.row) <= row && parseInt(cell.dataset.col) <= col);
  });
  $('tp-hint').textContent = row >= 0 ? `${row + 1} × ${col + 1}` : '1 × 1';
}

let _headingCaret = null;

function setupHeadingPicker() {
  const btn = $('btn-heading');
  const popup = $('heading-popup');
  if (!btn || !popup) return;

  // Capture editor caret BEFORE the click steals focus.
  btn.addEventListener('mousedown', () => {
    _headingCaret = { s: editor.selectionStart, e: editor.selectionEnd };
  });

  popup.querySelectorAll('.hp-btn').forEach(b => {
    // mousedown.preventDefault keeps editor focus (and selection) intact.
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const level = parseInt(b.dataset.level, 10) || 2;
      insertHeading(level);
      popup.style.display = 'none';
    });
  });

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = popup.style.display === 'none';
    if (willOpen) closeOtherDropdowns(popup);
    const r = btn.getBoundingClientRect();
    popup.style.left = r.left + 'px';
    popup.style.top  = (r.bottom + 4) + 'px';
    popup.style.display = willOpen ? 'block' : 'none';
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#btn-heading') && !e.target.closest('#heading-popup'))
      popup.style.display = 'none';
  });
}

function insertHeading(level) {
  // Prefer the caret captured when the picker opened (before focus shift).
  const sel = _headingCaret || { s: editor.selectionStart, e: editor.selectionEnd };
  const text = editor.value.substring(sel.s, sel.e);
  const hashes = '#'.repeat(Math.max(1, Math.min(6, level)));
  const atLineStart = sel.s === 0 || editor.value.charAt(sel.s - 1) === '\n';
  const leading = atLineStart ? '' : '\n';
  let insert;
  if (text) {
    // Wrap the selected text as a heading; keep the trailing newline.
    insert = `${leading}${hashes} ${text}\n`;
  } else {
    // No selection: insert just `## ` — no placeholder, no trailing newline.
    // Caret lands right after the space so the user can type the title.
    // Avoids the "delete also removes the next line" trap the placeholder caused.
    insert = `${leading}${hashes} `;
  }
  insertAtCursor(insert, sel.s, sel.e);
  editor.focus();
  _headingCaret = null;
}

function insertTable(rows, cols) {
  $('table-popup').style.display = 'none';

  const header = '| ' + Array(cols).fill('   ').join(' | ') + ' |';
  const sep    = '| ' + Array(cols).fill('---').join(' | ') + ' |';
  const row    = '| ' + Array(cols).fill('   ').join(' | ') + ' |';
  const body   = Array(rows - 1).fill(row).join('\n');

  // A markdown table must be its own block. If the caret sits right after a
  // line of text (e.g. a "- [ ]" list item) a single newline lets the table
  // get absorbed into that block and render broken (rows leak out as literal
  // "| | |" text). Pad with a blank line before and after — but only as many
  // newlines as the surrounding text still needs, so we don't pile up gaps.
  const val    = editor.value;
  const before = val.slice(0, editor.selectionStart);
  const after  = val.slice(editor.selectionEnd);
  const lead  = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after  === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const table = `${lead}${header}\n${sep}\n${body}${trail}`;
  insertAtCursor(table);
  editor.focus();
}

// ─── Table context menu (in preview) ─────────────────────────────────────────

let tableCtxCell = null;

function showTableContextMenu(e, cell) {
  tableCtxCell = cell;
  const menu = $('table-ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.style.display = 'block';
}

function setupTableContextMenu() {
  const menu = $('table-ctx-menu');
  if (!menu) return;

  document.addEventListener('click', e => {
    if (!e.target.closest('#table-ctx-menu')) menu.style.display = 'none';
  });

  $('tctx-add-row-below')?.addEventListener('click',  () => tableEditRow('add-below'));
  $('tctx-add-row-above')?.addEventListener('click',  () => tableEditRow('add-above'));
  $('tctx-add-col-right')?.addEventListener('click',  () => tableEditCol('add-right'));
  $('tctx-add-col-left')?.addEventListener('click',   () => tableEditCol('add-left'));
  $('tctx-del-row')?.addEventListener('click',        () => tableEditRow('delete'));
  $('tctx-del-col')?.addEventListener('click',        () => tableEditCol('delete'));
}

function getTableInfo(cell) {
  const row   = cell.closest('tr');
  const table = cell.closest('table');
  if (!row || !table) return null;

  const rows     = [...table.querySelectorAll('tr')];
  const cells    = [...row.querySelectorAll('td, th')];
  const rowIdx   = rows.indexOf(row);
  const colIdx   = cells.indexOf(cell);
  const colCount = rows.reduce((m, r) => Math.max(m, r.querySelectorAll('td,th').length), 0);

  return { table, rows, rowIdx, colIdx, colCount };
}

function tableEditRow(action) {
  if (!tableCtxCell) return;
  $('table-ctx-menu').style.display = 'none';
  const info = getTableInfo(tableCtxCell);
  if (!info) return;

  // Parse markdown table from editor
  const lines = editor.value.split('\n');
  // Find the table block in markdown
  const tableLines = findMarkdownTable(lines, info.colCount);
  if (!tableLines) return;

  const { start, end } = tableLines;
  const emptyRow = '| ' + Array(info.colCount).fill('   ').join(' | ') + ' |';

  let newLines = [...lines];
  // DOM rowIdx 0 = header, 1+ = data rows.
  // Markdown: lines[start]=header, lines[start+1]=separator, lines[start+2+]=data rows.
  // → Header row maps to `start`; data row k (k≥1) maps to `start + k + 1` (skip separator).
  const mdRowIdx = info.rowIdx === 0 ? start : start + info.rowIdx + 1;

  if (action === 'add-below') {
    // Header: insert just after separator. Data row: insert after the row.
    const insertAt = info.rowIdx === 0 ? start + 2 : mdRowIdx + 1;
    newLines.splice(insertAt, 0, emptyRow);
  } else if (action === 'add-above') {
    if (info.rowIdx === 0) return; // can't add above header
    newLines.splice(mdRowIdx, 0, emptyRow);
  } else if (action === 'delete') {
    if (info.rowIdx === 0) return; // don't delete header
    newLines.splice(mdRowIdx, 1);
  }

  const newContent = newLines.join('\n');
  editor.value = newContent;
  editor.dispatchEvent(new Event('input'));
}

function tableEditCol(action) {
  if (!tableCtxCell) return;
  $('table-ctx-menu').style.display = 'none';
  const info = getTableInfo(tableCtxCell);
  if (!info) return;

  const lines = editor.value.split('\n');
  const tableLines = findMarkdownTable(lines, info.colCount);
  if (!tableLines) return;

  const { start, end } = tableLines;
  let newLines = [...lines];

  for (let i = start; i <= end; i++) {
    const cells = newLines[i].split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
    const isSep = cells.every(c => c.trim().match(/^:?-+:?$/));
    const newCell = isSep ? ' --- ' : '     ';

    if (action === 'add-right') {
      cells.splice(info.colIdx + 1, 0, newCell);
    } else if (action === 'add-left') {
      cells.splice(info.colIdx, 0, newCell);
    } else if (action === 'delete') {
      if (cells.length <= 1) continue;
      cells.splice(info.colIdx, 1);
    }
    newLines[i] = '| ' + cells.join('|') + ' |';
  }

  editor.value = newLines.join('\n');
  editor.dispatchEvent(new Event('input'));
}

function findMarkdownTable(lines, colCount) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('|') && lines[i].split('|').length - 2 === colCount) {
      let end = i;
      while (end + 1 < lines.length && lines[end + 1].includes('|')) end++;
      return { start: i, end };
    }
  }
  return null;
}

// ─── Note link autocomplete [[ ────────────────────────────────────────────────

let linkPopupActive = false;
let linkPopupStart  = -1;
let linkPopupIdx    = 0;
// Set true only around the toolbar Link button's explicit open, so the popup
// still works there even when typing-suggestions are turned off in Settings.
let _wikilinkForce  = false;
// Tracks where the toolbar link button inserted an empty `[[]]`. Reset to -1
// once the popup is consumed (selection picked) so we don't strip it. If the
// popup is hidden while this is >= 0 and `[[]]` is still empty at that pos,
// the empty link is removed.
let _toolbarEmptyLinkPos = -1;

function checkNoteLinkTrigger() {
  // Wiki-link `[[` autocomplete is always on: the popup appears while typing.
  const pos  = editor.selectionStart;
  const text = editor.value.substring(0, pos);
  const m    = text.match(/\[\[([^\]\n]*)$/);
  if (!m) { hideLinkPopup(); return; }
  const query = m[1];
  linkPopupStart = pos - m[1].length;
  showLinkPopup(query, pos);
}

// Build the matches list for a query. Searches by note name AND folder path, so
// you can type a folder to narrow. Shown in #link-list; empty → a "no results" row.
function renderLinkMatches(query) {
  // Notes/drawings + single-file PDFs. Exclude folders and embedded images
  // (those belong inside notes). Keep type-less entries (plain .md notes often
  // have no `type` field) so they're not accidentally dropped.
  const allNotes = flattenTree(state.notes).filter(n => n.type !== 'folder'
    && n.type !== 'image' && n.type !== 'audio' && n.type !== 'video');
  const q = (query || '').toLowerCase().trim();
  const qAlpha = q.replace(/[^a-z0-9]/g, '');
  const scored = [];
  for (const n of allNotes) {
    const name = (n.name || '').toLowerCase();
    const nameAlpha = name.replace(/[^a-z0-9]/g, '');
    let score = -1;
    if (q === '') score = 0;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (qAlpha && nameAlpha.includes(qAlpha)) score = 40;
    else if (q && (n.path || '').replace(/^attachments\/(pdf|images)\//, '').replace(/^attachments\//, '').toLowerCase().includes(q)) score = 30;  // match the (clean) folder path too
    if (score >= 0) scored.push({ n, score });
  }
  scored.sort((a, b) => b.score - a.score || a.n.name.localeCompare(b.n.name));
  // Show ALL matching notes (the list scrolls); don't cap at a handful, so the
  // popup isn't mistaken for "only this folder". 500 is a safe upper bound.
  const matches = scored.slice(0, 500).map(s => s.n);
  const list = $('link-list');
  list.innerHTML = '';
  linkPopupIdx = 0;
  if (!matches.length) {
    list.innerHTML = '<div class="link-empty">' + (window.i18n ? window.i18n.t('editor.link_none') : 'Nessuna nota trovata') + '</div>';
    return;
  }
  matches.forEach((n, i) => {
    const item = document.createElement('div');
    item.className = 'link-item' + (i === 0 ? ' active' : '');
    // Hide the internal attachments/ path: PDFs are single files (show just the
    // name), notes show their folder (e.g. "serbia"); only a real sub-folder is shown.
    const clean = (n.path || '').replace(/^attachments\/(pdf|images|audio|videos)\//, '').replace(/^attachments\//, '');
    const showPath = clean.includes('/') ? clean : '';
    const icon = n.type === 'pdf' ? '📕' : n.type === 'audio' ? '🎵' : n.type === 'video' ? '🎬' : '📄';
    const modMs = n.modified ? new Date(n.modified).getTime() : NaN;
    const modStr = isNaN(modMs) ? '' : _fmtDateDMY(modMs);   // gg/mm/aaaa
    item.innerHTML = `<span class="link-item-icon">${icon}</span>
      <span class="link-item-name">${escHtml(n.name)}</span>
      ${showPath ? `<span class="link-item-path">${escHtml(showPath)}</span>` : ''}
      ${modStr ? `<span class="link-item-date">${modStr}</span>` : ''}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      insertNoteLink(n.name);
    });
    list.appendChild(item);
  });
}

function showLinkPopup(query, cursorPos) {
  const wasOpen = linkPopupActive;
  renderLinkMatches(query);
  const popup = $('link-popup');

  // Search box: a row at the top to find the note to link. Wire once; focus it
  // when the popup first opens so you can type to search (Up/Down/Enter navigate).
  const search = $('link-search');
  if (search) {
    if (!search.dataset.wired) {
      search.dataset.wired = '1';
      search.addEventListener('input', () => renderLinkMatches(search.value));
      search.addEventListener('keydown', handleLinkPopupKey);
      search.addEventListener('mousedown', e => e.stopPropagation());
    }
    if (!wasOpen) { search.value = query || ''; setTimeout(() => { try { search.focus(); } catch (_) {} }, 0); }
  }

  // Compute the caret's VIEWPORT position directly, then anchor the popup
  // below the caret line. Old formula mixed viewport and content coordinates
  // — leading the popup to land off-screen on long notes.
  popup.style.display = 'block';
  popup.style.left = '0px'; popup.style.top = '0px';
  // CM engine: the textarea is hidden, so its caret coords are wrong (popup landed
  // too low). Use CodeMirror's real caret viewport position.
  const cmc = (_cmActive && _cmHandle) ? _cmHandle.caretCoords() : null;
  const caret = cmc ? { left: cmc.left, top: cmc.top } : getCaretViewportPosition(editor);
  const lineH = cmc ? Math.max(16, cmc.bottom - cmc.top) : (parseInt(getComputedStyle(editor).lineHeight) || 22);
  const popupH = popup.offsetHeight || 240;
  const popupW = popup.offsetWidth || 260;

  let left = caret.left;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  if (left < 8) left = 8;

  let top = caret.top + lineH + 4;
  if (top + popupH > window.innerHeight - 8) top = caret.top - popupH - 4;
  if (top < 8) top = 8;

  popup.style.left = left + 'px';
  popup.style.top  = top + 'px';
  linkPopupActive = true;
}

// Caret's position in *viewport* coordinates, accounting for textarea scroll.
function getCaretViewportPosition(textarea) {
  const style = getComputedStyle(textarea);
  const div = document.createElement('div');
  ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing','tabSize',
   'paddingTop','paddingRight','paddingBottom','paddingLeft',
   'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
   'whiteSpace','wordWrap','wordBreak','overflowWrap','boxSizing'
  ].forEach(p => { div.style[p] = style[p]; });
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.top = '0';
  div.style.left = '-9999px';
  div.style.width = textarea.clientWidth + 'px';
  div.style.height = 'auto';
  div.style.overflow = 'hidden';
  div.textContent = textarea.value.substring(0, textarea.selectionStart);
  const marker = document.createElement('span');
  marker.textContent = '|';
  div.appendChild(marker);
  document.body.appendChild(div);
  const spanTop = marker.offsetTop;
  const spanLeft = marker.offsetLeft;
  document.body.removeChild(div);
  const taRect = textarea.getBoundingClientRect();
  return {
    top:  taRect.top  + spanTop  - textarea.scrollTop,
    left: taRect.left + spanLeft - textarea.scrollLeft,
  };
}

function hideLinkPopup() {
  $('link-popup').style.display = 'none';
  linkPopupActive = false;
  linkPopupStart  = -1;
  // If the toolbar link button inserted an empty `[[]]` and the user dismissed
  // the popup without picking a note, strip the orphan brackets.
  if (_toolbarEmptyLinkPos >= 0) {
    const pos = _toolbarEmptyLinkPos;
    _toolbarEmptyLinkPos = -1;
    if (editor.value.substring(pos, pos + 4) === '[[]]') {
      const before = editor.value.substring(0, pos);
      const after  = editor.value.substring(pos + 4);
      editor.value = before + after;
      editor.selectionStart = editor.selectionEnd = pos;
      try { editor.dispatchEvent(new Event('input')); } catch(_) {}
    }
  }
}

function insertNoteLink(name) {
  const pos  = editor.selectionStart;
  const text = editor.value;
  const before = text.substring(0, pos);
  const bracketPos = before.lastIndexOf('[[');
  if (bracketPos === -1) return;
  // Skip a trailing `]]` if it's already there (e.g., from the toolbar's
  // `[[]]` insert with caret in the middle) so we don't end up with `]]]]`.
  let after = text.substring(pos);
  if (after.startsWith(']]')) after = after.substring(2);

  const newText = text.substring(0, bracketPos) + `[[${name}]]` + after;
  editor.value = newText;
  try { editor.focus(); } catch (_) {}   // focus may be in the search box → bring it back
  editor.selectionStart = editor.selectionEnd = bracketPos + name.length + 4;
  // The toolbar's empty link has been consumed; don't let hideLinkPopup strip it.
  _toolbarEmptyLinkPos = -1;
  editor.dispatchEvent(new Event('input'));
  hideLinkPopup();
}

// Rough caret coordinate estimation for textarea
function getCaretCoords(textarea) {
  const div = document.createElement('div');
  const style = getComputedStyle(textarea);
  ['fontFamily','fontSize','fontWeight','lineHeight','letterSpacing',
   'paddingTop','paddingLeft','paddingRight','wordWrap','whiteSpace'].forEach(p => {
    div.style[p] = style[p];
  });
  div.style.position = 'absolute'; div.style.visibility = 'hidden';
  div.style.width = textarea.clientWidth + 'px';
  div.style.height = 'auto'; div.style.overflow = 'hidden';
  const text = textarea.value.substring(0, textarea.selectionStart);
  div.textContent = text;
  const span = document.createElement('span');
  span.textContent = '|';
  div.appendChild(span);
  document.body.appendChild(div);
  const rect = span.getBoundingClientRect();
  const taRect = textarea.getBoundingClientRect();
  document.body.removeChild(div);
  return { left: rect.left - taRect.left, top: rect.top - taRect.top + textarea.scrollTop };
}

// Keyboard nav for link popup
// Shared so it works whether focus is in the editor OR the link search box.
function handleLinkPopupKey(e) {
  if (!linkPopupActive) return;
  if (e.key === 'Escape') { e.preventDefault(); hideLinkPopup(); try { editor.focus(); } catch (_) {} return; }
  const items = [...$('link-list').querySelectorAll('.link-item')];
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    items[linkPopupIdx]?.classList.remove('active');
    linkPopupIdx = (linkPopupIdx + 1) % items.length;
    items[linkPopupIdx]?.classList.add('active');
    items[linkPopupIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    items[linkPopupIdx]?.classList.remove('active');
    linkPopupIdx = (linkPopupIdx - 1 + items.length) % items.length;
    items[linkPopupIdx]?.classList.add('active');
    items[linkPopupIdx]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const active = $('link-list').querySelector('.link-item.active') || items[0];
    if (active) insertNoteLink(active.querySelector('span:nth-child(2)').textContent);
  }
}
editor.addEventListener('keydown', handleLinkPopupKey);

const _isFenceLine = l => /^\s*(```|~~~)/.test(l);

// Auto-close a code fence: typing the 3rd backtick of "```" at the start of a
// line (not already inside a block) replaces it with a complete, ALREADY
// 2-space-indented empty block, caret on the indented middle line so the first
// code line is aligned. Inserting it pre-indented means the live re-indent is a
// no-op here (otherwise it would shift the fences +2 and the old absolute caret
// would land after the 2nd backtick). execCommand keeps undo/redo intact.
editor.addEventListener('beforeinput', e => {
  if (e.inputType !== 'insertText' || e.data !== '`') return;
  if (editor.selectionStart !== editor.selectionEnd) return;
  const pos = editor.selectionStart;
  const text = editor.value;
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const atLineEnd = (pos === text.length || text.charAt(pos) === '\n');
  const fencesBefore = text.slice(0, lineStart).split('\n').filter(_isFenceLine).length;
  if (text.slice(lineStart, pos) === '``' && atLineEnd && fencesBefore % 2 === 0) {
    e.preventDefault();
    editor.setSelectionRange(lineStart, pos);                // select the "``"
    document.execCommand('insertText', false, '  ```\n  \n  ```');
    const caret = lineStart + 8;                             // end of the indented middle line ("  ```\n  ")
    editor.setSelectionRange(caret, caret);
  }
});

// ─── Image resize in preview ──────────────────────────────────────────────────

// Pointer capture (see _setupVideoResize): guarantees the release event lands
// on the handle, so the drag can never "stick" past the mouse-button release.
function setupImageResize(img, handle) {
  let startX, startW;

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = img.offsetWidth;

    const onMove = ev => {
      const newW = Math.max(60, startW + (ev.clientX - startX));
      img.style.width  = newW + 'px';
      img.style.height = 'auto';
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      // Write width into markdown source
      syncImageSizeToMarkdown(img);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function syncImageSizeToMarkdown(img) {
  const src  = img.src;
  const w    = Math.round(img.offsetWidth);
  // Find the markdown image ref and add/update width attribute
  // Supports: ![alt](url) → ![alt](url){width=300}
  // or HTML: <img src="..." width="300">
  const current = editor.value;
  // Extract filename from src URL
  const filename = decodeURIComponent(src.split('/').pop().split('?')[0]);
  // Replace or add width in markdown image syntax
  const updated = current.replace(
    new RegExp(`(!\\[[^\\]]*\\]\\([^)]*${filename.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[^)]*\\))(?:\\{[^}]*\\})?`, 'g'),
    `$1{width=${w}}`
  );
  if (updated !== current) {
    editor.value = updated;
    // No 'input' dispatch: a preview re-render would rebuild this very <img>
    // right after the drag (visible flash). See _persistEditorNoRender.
    _persistMediaSize();   // stored, but it does not count as editing the note
  }
}

// ─── Image context menu (move / copy to note) ────────────────────────────────

let imgCtxTarget = null;   // { src, alt, markdownRef, width }
let imgPickerMode = 'move'; // 'move' | 'copy'

function setupImageContextMenu() {
  const menu   = $('img-ctx-menu');
  const picker = $('img-note-picker');
  if (!menu) return;

  // Close on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('#img-ctx-menu'))   menu.style.display   = 'none';
    if (!e.target.closest('#img-note-picker') &&
        !e.target.closest('#img-ctx-move') &&
        !e.target.closest('#img-ctx-copy'))   picker.style.display = 'none';
  });

  $('img-ctx-move').addEventListener('click', () => {
    menu.style.display = 'none';
    imgPickerMode = 'move';
    openImagePicker();
  });
  $('img-ctx-copy').addEventListener('click', () => {
    menu.style.display = 'none';
    imgPickerMode = 'copy';
    openImagePicker();
  });
  $('img-ctx-open').addEventListener('click', () => {
    menu.style.display = 'none';
    if (imgCtxTarget?.src) window.inkwell.openExternal(imgCtxTarget.src).catch(() => {});
  });
  $('img-ctx-remove').addEventListener('click', () => {
    menu.style.display = 'none';
    if (imgCtxTarget) removeImageFromNote(imgCtxTarget);
  });

  // Picker search
  $('img-picker-search').addEventListener('input', e =>
    renderImagePickerList(e.target.value));
}

function showImageContextMenu(e, img) {
  // Extract info from the image
  const src = img.src || '';
  const alt = img.alt || '';
  // Try to get filename
  const filename = decodeURIComponent(src.split('/').pop().split('?')[0]) || alt || 'immagine';

  // Build the markdown reference string that represents this image in the source
  imgCtxTarget = { src, alt, filename };

  const menu = $('img-ctx-menu');
  $('img-ctx-name').textContent = filename;
  menu.style.left    = Math.min(e.clientX, window.innerWidth - 220) + 'px';
  menu.style.top     = Math.min(e.clientY, window.innerHeight - 200) + 'px';
  menu.style.display = 'block';
}

function openImagePicker() {
  const picker = $('img-note-picker');
  const title  = $('img-picker-title');
  title.textContent = imgPickerMode === 'move'
    ? window.i18n.t('img.move_title') || 'Sposta in nota'
    : window.i18n.t('img.copy_title') || 'Copia in nota';

  $('img-picker-search').value = '';
  renderImagePickerList('');

  // Position in center of screen
  picker.style.left    = (window.innerWidth  / 2 - 150) + 'px';
  picker.style.top     = (window.innerHeight / 2 - 160) + 'px';
  picker.style.display = 'block';
  $('img-picker-search').focus();
}

function renderImagePickerList(query) {
  const list     = $('img-picker-list');
  const allNotes = flattenTree(state.notes);
  const q        = query.toLowerCase();
  const current  = state.currentPath;

  const filtered = allNotes
    .filter(n => n.path !== current)                        // exclude current note
    .filter(n => !q || n.name.toLowerCase().includes(q))
    .slice(0, 25);

  list.innerHTML = '';
  if (!filtered.length) {
    list.innerHTML = `<div class="cnp-item" style="color:var(--text-3)">${escHtml(window.i18n.t('canvas.empty'))}</div>`;
    return;
  }

  filtered.forEach(n => {
    const item = document.createElement('div');
    item.className = 'cnp-item';
    item.innerHTML = `<span>📄</span><span>${escHtml(n.name)}</span>
      <span class="cnp-item-path">${escHtml(n.path)}</span>`;
    item.addEventListener('click', () => moveOrCopyImageToNote(n));
    list.appendChild(item);
  });
}

async function moveOrCopyImageToNote(targetNode) {
  $('img-note-picker').style.display = 'none';
  if (!imgCtxTarget) return;

  const { src, alt, filename } = imgCtxTarget;

  // Build the markdown image syntax to INSERT in target
  // Preserve original src (inkwell:// or http:// or relative)
  const insertRef = `\n![${alt || filename}](${src})\n`;

  // 1. Read target note, append image ref, save
  const targetContent = await window.inkwell.readNote(targetNode.path).catch(() => '');
  await window.inkwell.writeNote(targetNode.path, targetContent + insertRef);

  // 2. If MOVE: remove from current note
  if (imgPickerMode === 'move') {
    removeImageFromNote(imgCtxTarget);
    showToast(window.i18n.t('toast.image_moved', { name: targetNode.name }));
  } else {
    showToast(window.i18n.t('toast.image_copied', { name: targetNode.name }));
  }

  // 3. If target note is already open in a tab, refresh it
  const targetTab = getTab(targetNode.path);
  if (targetTab) {
    targetTab.content = targetContent + insertRef;
    targetTab.isDirty = true;
    renderTabBar();
  }
}

function removeImageFromNote(imgInfo) {
  const { src, alt, filename } = imgInfo;
  const current = editor.value;

  // Match markdown image syntax: ![alt](src) or ![alt](src){width=N}
  // Escape special chars in src for regex
  const escapedSrc = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedAlt = (alt || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Try full src match first
  let updated = current.replace(
    new RegExp(`\\n?!\\[[^\\]]*\\]\\(${escapedSrc}\\)(?:\\{[^}]*\\})?\\n?`, 'g'), '\n'
  );

  // Fallback: match by filename in src
  if (updated === current) {
    const escapedFile = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    updated = current.replace(
      new RegExp(`\\n?!\\[[^\\]]*\\]\\([^)]*${escapedFile}[^)]*\\)(?:\\{[^}]*\\})?\\n?`, 'g'), '\n'
    );
  }

  if (updated !== current) {
    editor.value = updated;
    editor.dispatchEvent(new Event('input'));
  }
}

// ─── Toast notification ───────────────────────────────────────────────────────

// Throttled "octet out of range" toast (each IP group must be 0–254).
let _ipErrAt = 0;
function showIpRangeError() {
  const now = Date.now();
  if (now - _ipErrAt > 1200) { showToast(window.i18n.t('sync.ip_octet_max'), 4000); _ipErrAt = now; }
}

// Segmented IP input: 4 octet boxes with visible dots. Mirrors to the real
// hidden input (same id) so ALL existing read/write/load/save/focus code stays
// untouched — user types in the boxes, we keep the hidden input in sync and
// re-dispatch input/blur so autosave + preview fire as before.
function initIpGroup(hiddenId) {
  const hidden = document.getElementById(hiddenId);
  if (!hidden || hidden._ipGroupInit) return;
  const group = document.querySelector('.ip-group[data-ip="' + hiddenId + '"]');
  if (!group) return;
  hidden._ipGroupInit = true;
  const octs = Array.from(group.querySelectorAll('.ip-oct'));
  const nativeVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const readHidden = () => nativeVal.get.call(hidden);

  // Boxes ← hidden value (load/reset path).
  function fillFromHidden() {
    const parts = (readHidden() || '').split('.');
    octs.forEach((o, i) => { o.value = (parts[i] || '').replace(/[^0-9]/g, '').slice(0, 3); });
  }
  // Boxes → hidden value + notify existing listeners. Drop trailing empty
  // octets so a partial IP (e.g. "192.168") stays clean.
  function pushToHidden() {
    const vals = octs.map(o => o.value);
    while (vals.length && vals[vals.length - 1] === '') vals.pop();
    nativeVal.set.call(hidden, vals.join('.'));   // native setter → no re-fill loop
    hidden.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // Hook programmatic writes (el.value = x) so the boxes refresh on load/reset.
  Object.defineProperty(hidden, 'value', {
    configurable: true,
    get() { return nativeVal.get.call(this); },
    set(v) { nativeVal.set.call(this, v); fillFromHidden(); }
  });

  octs.forEach((o, i) => {
    o.addEventListener('input', () => {
      let v = o.value.replace(/[^0-9]/g, '').slice(0, 3);
      if (v !== '' && Number(v) > 254) {
        // Reject the offending digit (don't silently force 254) and warn.
        v = v.slice(0, -1);   // a 3-digit >254 always drops to a valid ≤99
        showIpRangeError();
      }
      o.value = v;
      if (o.value.length === 3 && i < octs.length - 1) { octs[i + 1].focus(); octs[i + 1].select(); }
      pushToHidden();
    });
    o.addEventListener('keydown', (e) => {
      if (e.key === '.' || e.key === ' ') { e.preventDefault(); if (i < octs.length - 1) { octs[i + 1].focus(); octs[i + 1].select(); } }
      else if (e.key === 'Backspace' && o.value === '' && i > 0) { e.preventDefault(); const p = octs[i - 1]; p.focus(); try { p.setSelectionRange(p.value.length, p.value.length); } catch (_) {} }
      else if (e.key === 'ArrowLeft' && o.selectionStart === 0 && i > 0) { e.preventDefault(); octs[i - 1].focus(); }
      else if (e.key === 'ArrowRight' && o.selectionStart === o.value.length && i < octs.length - 1) { e.preventDefault(); octs[i + 1].focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); o.blur(); }
    });
    o.addEventListener('focus', () => { try { o.select(); } catch (_) {} });
    o.addEventListener('paste', (e) => {
      const t = ((e.clipboardData || window.clipboardData)?.getData('text') || '');
      if (t.indexOf('.') >= 0 || /\d/.test(t)) {
        e.preventDefault();
        const parts = t.replace(/[^0-9.]/g, '').split('.').slice(0, 4);
        let bad = false;
        octs.forEach((x, k) => { let p = (parts[k] || '').slice(0, 3); if (p !== '' && Number(p) > 254) { p = p.slice(0, -1); bad = true; } x.value = p; });
        if (bad) showIpRangeError();
        pushToHidden();
      }
    });
  });

  // Focus leaves the whole group → fire change+blur on the hidden input so the
  // existing autosave (which listens on the hidden input) runs.
  group.addEventListener('focusout', (e) => {
    if (!group.contains(e.relatedTarget)) {
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      hidden.dispatchEvent(new Event('blur'));
    }
  });

  fillFromHidden();
}

function showToast(msg, duration = 2800) {
  let toast = $('amelie-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'amelie-toast';
    toast.style.cssText = `
      position:fixed;bottom:28px;left:50%;transform:translateX(-50%) translateY(10px);
      background:var(--bg-3);border:1px solid var(--border-light);border-radius:7px;
      padding:9px 20px;font-family:var(--ui-font);font-size:13px;color:var(--text-0);
      box-shadow:0 6px 20px rgba(0,0,0,.5);z-index:9999;
      opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });
  clearTimeout(toast._t);
  // duration <= 0 (or non-finite) → sticky: stays until replaced or hideToast().
  if (duration > 0 && isFinite(duration)) {
    toast._t = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
    }, duration);
  }
}

// Dismiss the shared toast now (used to clear a sticky "working…" message).
function hideToast() {
  const toast = $('amelie-toast');
  if (!toast) return;
  clearTimeout(toast._t);
  toast.style.opacity = '0';
  toast.style.transform = 'translateX(-50%) translateY(10px)';
}

// ─── In-note search ───────────────────────────────────────────────────────────

let noteSearchMatches = [];
let noteSearchIdx = 0;

function setupNoteSearch() {
  const btnSearch = $('btn-note-search');
  const bar       = $('note-search-bar');
  const input     = $('note-search-input');
  const countEl   = $('note-search-count');
  if (!btnSearch) return;

  btnSearch.addEventListener('click', () => toggleNoteSearch());

  $('note-search-close').addEventListener('click', closeNoteSearch);

  input.addEventListener('input', () => runNoteSearch(input.value));

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); noteSearchStep(-1); }
    else if (e.key === 'Enter')          { e.preventDefault(); noteSearchStep(1);  }
    else if (e.key === 'Escape')         { closeNoteSearch(); }
  });

  $('note-search-next').addEventListener('click', () => noteSearchStep(1));
  $('note-search-prev').addEventListener('click', () => noteSearchStep(-1));
}

// Ctrl+F (and the toolbar lens): open the search bar, or close it if it's already
// open — a real toggle.
function toggleNoteSearch() {
  const bar = $('note-search-bar');
  if (bar && bar.style.display === 'flex') closeNoteSearch();
  else openNoteSearch();
}

function openNoteSearch() {
  const bar = $('note-search-bar');
  bar.style.display = 'flex';
  $('btn-note-search').classList.add('active');
  const input = $('note-search-input');
  input.value = '';
  $('note-search-count').textContent = '';
  noteSearchMatches = []; noteSearchIdx = 0;
  input.focus();
}

function closeNoteSearch() {
  $('note-search-bar').style.display = 'none';
  $('btn-note-search').classList.remove('active');
  // Clear highlights (both in-editor overlay and preview <mark>s)
  clearNoteSearchHighlights();
  _searchHL = { query: '', currentPos: -1 };
  if (_cmActive && _cmHandle) { try { _cmHandle.setSearchHighlight('', -1); } catch (_) {} }
  applyEditorHighlight();
  noteSearchMatches = []; noteSearchIdx = 0;
}

// In split mode the search follows the SELECTED half: searching while the second pane is the
// one you are working in used to comb the main note instead, which is the wrong text.
function _searchInSplitHalf() { return !!_splitPath && _focusedPane === 'split'; }

function runNoteSearch(query) {
  clearNoteSearchHighlights();
  noteSearchMatches = []; noteSearchIdx = 0;
  const countEl = $('note-search-count');

  if (!query.trim()) { countEl.textContent = ''; return; }

  const inHalf = _searchInSplitHalf();

  if (state.viewMode === 'view') {
    // Highlight in preview DOM — the selected half's
    const container = inHalf ? $('preview-content-b') : previewContent;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const q = query.toLowerCase();
    const ranges = [];
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      let idx = 0;
      while ((idx = text.toLowerCase().indexOf(q, idx)) !== -1) {
        ranges.push({ node, start: idx, end: idx + q.length });
        idx += q.length;
      }
    }
    // Wrap matches in spans (reverse order to preserve offsets). surroundContents
    // can throw on some ranges — skip those instead of crashing the whole search.
    [...ranges].reverse().forEach((r, i) => {
      try {
        const range = document.createRange();
        range.setStart(r.node, r.start);
        range.setEnd(r.node, r.end);
        const span = document.createElement('mark');
        span.className = 'note-search-highlight';
        span.dataset.idx = ranges.length - 1 - i;
        range.surroundContents(span);
        noteSearchMatches.unshift(span);
      } catch (_) {}
    });
    countEl.textContent = noteSearchMatches.length ? `1 / ${noteSearchMatches.length}` : window.i18n.t('search.no_results');
    if (noteSearchMatches.length) { noteSearchIdx = 0; scrollToMatch(0); }
  } else {
    // Edit mode: find in the text of the half being searched
    const src = inHalf ? ($('markdown-editor-b') || {}).value || '' : editor.value;
    const content = src.toLowerCase();
    const q = query.toLowerCase();
    let idx = 0, pos;
    while ((pos = content.indexOf(q, idx)) !== -1) {
      noteSearchMatches.push(pos);
      idx = pos + q.length;
    }
    countEl.textContent = noteSearchMatches.length ? `1 / ${noteSearchMatches.length}` : window.i18n.t('search.no_results');
    if (noteSearchMatches.length) {
      noteSearchIdx = 0;
      if (inHalf) { _showMatchInSplitEditor(noteSearchMatches[0], query.length); }
      else if (_cmActive && _cmHandle) { _cmHandle.setSearchHighlight(query, noteSearchMatches[0]); }
      else { _searchHL = { query, currentPos: noteSearchMatches[0] }; applyEditorHighlight(); _scrollEditorToPos(noteSearchMatches[0]); }
    } else {
      if (inHalf) { /* nothing to show */ }
      else if (_cmActive && _cmHandle) { _cmHandle.setSearchHighlight('', -1); }
      else { _searchHL = { query, currentPos: -1 }; applyEditorHighlight(); }
    }
  }
}

// The split half is a plain textarea (not the CodeMirror engine), so a match is shown by
// selecting it and scrolling it into view. The selection stays visible while the search box
// keeps the keyboard, so Enter goes on stepping instead of typing into the note.
function _showMatchInSplitEditor(pos, len) {
  const edB = $('markdown-editor-b');
  if (!edB) return;
  try { edB.setSelectionRange(pos, pos + len); } catch (_) {}
  const before = edB.value.slice(0, pos).split('\n').length;
  const lineH = parseFloat(getComputedStyle(edB).lineHeight) || 22;
  edB.scrollTop = Math.max(0, (before - 4) * lineH);
}

function _scrollEditorToPos(pos) {
  const lines = editor.value.substring(0, pos).split('\n');
  const lineH = parseFloat(getComputedStyle(editor).lineHeight) || 22;
  editor.scrollTop = Math.max(0, (lines.length - 4) * lineH);
}

function noteSearchStep(dir) {
  if (!noteSearchMatches.length) return;
  noteSearchIdx = (noteSearchIdx + dir + noteSearchMatches.length) % noteSearchMatches.length;
  $('note-search-count').textContent = `${noteSearchIdx + 1} / ${noteSearchMatches.length}`;
  if (state.viewMode === 'view') {
    scrollToMatch(noteSearchIdx);
  } else if (_searchInSplitHalf()) {
    _showMatchInSplitEditor(noteSearchMatches[noteSearchIdx], $('note-search-input').value.length);
  } else {
    jumpEditorToMatch(noteSearchIdx, $('note-search-input').value.length);
  }
}

function scrollToMatch(idx) {
  noteSearchMatches.forEach((m, i) => m.classList.toggle('current', i === idx));
  noteSearchMatches[idx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function jumpEditorToMatch(idx, len) {
  const pos = noteSearchMatches[idx];
  // CM engine: highlight all matches (current distinct) + scroll it into view,
  // WITHOUT moving focus off the search input (so Enter keeps stepping).
  if (_cmActive && _cmHandle) { _cmHandle.setSearchHighlight($('note-search-input').value, pos); return; }
  // Update the "current" highlight in the overlay, scroll into view, but DO
  // NOT focus the editor — that would steal focus from the search input and
  // make Enter open a newline in the note instead of stepping to next match.
  _searchHL = { query: $('note-search-input').value, currentPos: pos };
  applyEditorHighlight();
  _scrollEditorToPos(pos);
}

function clearNoteSearchHighlights() {
  // Both previews: a search can have marked either half, and leftovers in the other one
  // would stay lit after the next search.
  [previewContent, $('preview-content-b')].filter(Boolean).forEach(root => {
    root.querySelectorAll('.note-search-highlight').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
    root.normalize();
  });
}

// ─── Sidebar view buttons ─────────────────────────────────────────────────────
// Wire graph/canvas buttons that are now in the sidebar
// (setupMindmap and setupCanvas already bind btn-mindmap and btn-canvas)

// ─── Custom text colors ───────────────────────────────────────────────────────

const COLOR_VARS = [
  // --bg-0 (editor/main background) customization removed (user request) — the
  // editor background always follows the theme now (also avoids the GPU "mask"
  // artifact when bg-0 was set below #111111).
  { id: 'clr-text-0', varName: '--text-0', defaultVal: '#e6edf3', prevId: 'prev-text-0' },
  { id: 'clr-text-1', varName: '--text-1', defaultVal: '#8b949e', prevId: 'prev-text-1' },
  { id: 'clr-accent', varName: '--accent', defaultVal: '#3fb950', prevId: 'prev-accent'  },
];

function applyCustomColors() {
  let accentKept = false;
  COLOR_VARS.forEach(({ varName, defaultVal }) => {
    const saved = localStorage.getItem('amelie-color' + varName);
    if (!saved) return;
    // A saved value identical to the stock default is a no-op override left
    // behind by older versions: it only masks the theme palettes (e.g. a
    // stored default-green --accent kept every theme's icons green). Drop it.
    if (saved.toLowerCase() === defaultVal.toLowerCase()) {
      try { localStorage.removeItem('amelie-color' + varName); } catch (_) {}
      return;
    }
    document.documentElement.style.setProperty(varName, saved);
    if (varName === '--accent') accentKept = true;
  });
  // Accent derivatives set by the folder-color swatches — only meaningful
  // alongside their saved accent; orphaned ones are dropped with it.
  ['--accent-dim', '--accent-glow'].forEach(v => {
    const s = localStorage.getItem('amelie-color' + v);
    if (!s) return;
    if (!accentKept) { try { localStorage.removeItem('amelie-color' + v); } catch (_) {} return; }
    document.documentElement.style.setProperty(v, s);
  });
}

// Align the color pickers / previews / accent swatches with whatever palette is
// in effect right now (theme vars + any surviving overrides).
function syncColorPickersToTheme() {
  COLOR_VARS.forEach(({ id, varName, prevId, isBg, defaultVal }) => {
    const cur = rgbToHex(getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim()) || defaultVal;
    const input   = $(id);
    const preview = $(prevId);
    if (input) input.value = cur;
    if (preview) {
      if (isBg) preview.style.background = cur;
      else       preview.style.color      = cur;
    }
  });
  const curAccent = rgbToHex(getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim()) || '';
  document.querySelectorAll('.accent-swatch').forEach(s =>
    s.classList.toggle('active', (s.dataset.accent || '').toLowerCase() === curAccent.toLowerCase()));
}

// Drop EVERY per-user color override (inline :root vars + localStorage) so the
// active theme's palette shows through. Custom colors are overrides on top of
// a theme; "reset" and "switch theme" both mean "back to the theme's colors" —
// a lingering inline --accent would otherwise override every theme (seen as
// "icons stay green no matter which theme I pick").
function clearCustomColorOverrides() {
  const root = document.documentElement.style;
  COLOR_VARS.forEach(({ varName }) => {
    root.removeProperty(varName);
    try { localStorage.removeItem('amelie-color' + varName); } catch (_) {}
  });
  ['--accent-dim', '--accent-glow'].forEach(v => {
    root.removeProperty(v);
    try { localStorage.removeItem('amelie-color' + v); } catch (_) {}
  });
  syncColorPickersToTheme();
}

// Folder/accent color: set --accent and its derived shades together so the
// folder icons, active note, links and highlights all move as one. Persists to
// localStorage (restored by applyCustomColors on next launch).
function _accentHexToRgb(hex) { const m = hex.replace('#', '').match(/.{2}/g); return m ? m.map(x => parseInt(x, 16)) : [0, 0, 0]; }
function _accentDarken(hex, f) { const d = n => Math.round(n * f).toString(16).padStart(2, '0'); const [r, g, b] = _accentHexToRgb(hex); return '#' + d(r) + d(g) + d(b); }
function _accentRgba(hex, a) { const [r, g, b] = _accentHexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
function setAccentColor(hex) {
  const dim  = _accentDarken(hex, 0.62);
  const glow = _accentRgba(hex, 0.13);
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-dim', dim);
  root.setProperty('--accent-glow', glow);
  localStorage.setItem('amelie-color--accent', hex);
  localStorage.setItem('amelie-color--accent-dim', dim);
  localStorage.setItem('amelie-color--accent-glow', glow);
  // Keep the accent picker + preview + active swatch in sync.
  const inp = $('clr-accent'); if (inp) inp.value = hex;
  const prev = $('prev-accent'); if (prev) prev.style.color = hex;
  document.querySelectorAll('.accent-swatch').forEach(s =>
    s.classList.toggle('active', (s.dataset.accent || '').toLowerCase() === hex.toLowerCase()));
}

function setupColorCustomization() {
  COLOR_VARS.forEach(({ id, varName, defaultVal, prevId, isBg }) => {
    const input   = $(id);
    const preview = $(prevId);
    if (!input) return;

    const current = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim() || defaultVal;
    input.value = rgbToHex(current) || defaultVal;
    if (preview) {
      if (isBg) preview.style.background = input.value;
      else       preview.style.color      = input.value;
    }

    input.addEventListener('input', () => {
      // Accent picker also drives its derived shades + the preset swatches.
      if (varName === '--accent') { setAccentColor(input.value); return; }
      document.documentElement.style.setProperty(varName, input.value);
      if (preview) {
        if (isBg) preview.style.background = input.value;
        else       preview.style.color      = input.value;
      }
      localStorage.setItem('amelie-color' + varName, input.value);
    });
  });

  // Folder/accent color preset swatches.
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.addEventListener('click', () => setAccentColor(sw.dataset.accent));
  });
  // Mark the swatch matching the current accent (if any).
  const curAccent = rgbToHex(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()) || '';
  document.querySelectorAll('.accent-swatch').forEach(s =>
    s.classList.toggle('active', (s.dataset.accent || '').toLowerCase() === curAccent.toLowerCase()));

  // Reset = "back to the ACTIVE theme's color" (remove the override), not back
  // to the hardcoded github-dark default.
  document.querySelectorAll('.color-reset').forEach(btn => {
    btn.addEventListener('click', () => {
      const varName = btn.dataset.var;
      const cfg     = COLOR_VARS.find(c => c.varName === varName);
      if (!cfg) return;
      document.documentElement.style.removeProperty(varName);
      localStorage.removeItem('amelie-color' + varName);
      // Resetting the accent also drops its derived shades.
      if (varName === '--accent') {
        ['--accent-dim', '--accent-glow'].forEach(v => { document.documentElement.style.removeProperty(v); localStorage.removeItem('amelie-color' + v); });
      }
      syncColorPickersToTheme();
    });
  });

  $('btn-reset-all-colors')?.addEventListener('click', clearCustomColorOverrides);
}

// Helper: convert rgb(...) string to #rrggbb
function rgbToHex(color) {
  if (color.startsWith('#')) return color;
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return '#' + m.slice(0,3).map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}

// marked vendored locally (was a cloudflare CDN load): offline + no per-launch
// external request, and required now that the CSP no longer allows cloudflare.
const markedScript = document.createElement('script');
markedScript.src = 'marked.min.js';
markedScript.onload = () => { if (editor.value) updatePreview(); };
document.head.appendChild(markedScript);


// Re-apply dynamic translated strings when language changes
document.addEventListener('amelie:lang-changed', () => {
  // Update word count
  updateWordCount();
  // Update saved state (re-read current)
  const tab = getActiveTab();
  if (tab) setSavedState(!tab.isDirty);
  // Re-render TOC if visible
  if (tocVisible) renderTOC();
  // If the settings modal is open, re-render its dynamically-built content
  // (note count, encryption status, shortcuts list) so they switch language too.
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal && settingsModal.style.display !== 'none') {
    if (typeof openSecurityTab === 'function') openSecurityTab();
    const scTab = document.getElementById('tab-shortcuts');
    if (scTab && scTab.classList.contains('active')) renderShortcutsTab();
  }
});

// ─── File drag & drop (.md files onto app window) ────────────────────────────

// Recursively read dropped FileSystem entries (files + folders) → [{file, rel}],
// where `rel` is the path relative to the drop (folder structure preserved).
function _gatherEntries(entries) {
  const out = [];
  const readEntry = (entry, prefix) => new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(f => { out.push({ file: f, rel: prefix + entry.name }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const e of batch) await readEntry(e, prefix + entry.name + '/');
        readBatch();   // readEntries returns in chunks — keep going until empty
      }, () => resolve());
      readBatch();
    } else resolve();
  });
  return Promise.all(entries.map(e => readEntry(e, ''))).then(() => out);
}

// During an external (file-explorer) drag, highlight the tree folder under the
// cursor so you can see which folder the dropped note/folder will go into.
let _extDropTarget = '';   // path of that folder ('' = vault root)
function _highlightExtDropTarget(target) {
  const folder = target && target.closest ? target.closest('.tree-folder') : null;
  document.querySelectorAll('.tree-folder.drag-over-folder').forEach(el => { if (el !== folder) el.classList.remove('drag-over-folder'); });
  if (folder) { folder.classList.add('drag-over-folder'); _extDropTarget = folder.dataset.folder || ''; }
  else _extDropTarget = '';
}
function _clearExtDropTarget() {
  document.querySelectorAll('.tree-folder.drag-over-folder').forEach(el => el.classList.remove('drag-over-folder'));
  _extDropTarget = '';
}

function setupFileDrop() {
  // Always allow drops on the whole window (except during internal note/folder
  // drags). On Linux/Wayland, `dataTransfer.types` is sometimes empty during
  // `dragover`, so gating on "is this a file drag?" makes drop fail silently
  // outside the editor area. Unconditionally enabling drop everywhere makes
  // the drop event fire reliably — we filter by files inside the drop handler.
  const blockExternal = e => {
    if (state.draggingNote || state.draggingFolder || state.draggingAttach || _todoDragFrom) return false;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    _highlightExtDropTarget(e.target);   // show which tree folder you'd drop into
    return true;
  };

  window.addEventListener('dragenter', blockExternal, true);
  window.addEventListener('dragover',  blockExternal, true);
  // Clear the highlight when the external drag leaves the window entirely.
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) _clearExtDropTarget(); }, true);

  window.addEventListener('drop', async e => {
    if (state.draggingNote || state.draggingFolder || state.draggingAttach || _todoDragFrom) return;
    // Capture FileSystem entries synchronously (must happen before any await),
    // so dropping a FOLDER of notes recurses into it and preserves subfolders.
    const items = [...(e.dataTransfer?.items || [])];
    const entries = items.map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    const flat = [...(e.dataTransfer?.files || [])];

    // RELIABLE folder detection: webkitGetAsEntry is flaky for directories on Linux
    // (and Electron 32+ removed File.path), so resolve the real FS path via
    // webUtils.getPathForFile and let MAIN decide which are folders. A dropped FOLDER
    // → main-process Obsidian import (reads from disk; notes + images + PDFs + embed
    // rewriting). This is the primary path; the webkitGetAsEntry logic below is a fallback.
    const _paths = flat.map(f => { try { return window.inkwell.getPathForFile ? window.inkwell.getPathForFile(f) : ''; } catch (_) { return ''; } }).filter(Boolean);
    if (_paths.length) {
      // Stop the browser's default open, but DON'T stopPropagation yet: a loose media
      // file (audio/video/image/PDF) must still reach the editor's drop handler, which
      // imports it into the open note. Only a FOLDER is fully owned here (main import).
      e.preventDefault();
      let folderPaths = [];
      try { folderPaths = (await window.inkwell.vault.filterDirs(_paths)) || []; } catch (_) {}
      if (folderPaths.length) {
        e.stopPropagation();
        const dest = _extDropTarget; _clearExtDropTarget();
        const tot = { notes: 0, images: 0, pdfs: 0, media: 0, skipped: 0 };
        showToast(window.i18n.t('toast.importing'));
        for (const dir of folderPaths) {
          try {
            const r = await window.inkwell.vault.importObsidian(dir, dest);
            if (r && r.ok) { tot.notes += r.notes || 0; tot.images += r.images || 0; tot.pdfs += r.pdfs || 0; tot.media += r.media || 0; tot.skipped += r.skipped || 0; }
          } catch (err) { console.error('Obsidian import failed', dir, err); }
        }
        await loadTree();
        showToast(`${window.i18n.t(tot.notes === 1 ? 'toast.note_imported' : 'toast.notes_imported', { n: tot.notes })} · ${tot.images} img · ${tot.pdfs} pdf`);
        return;
      }
      // Not a folder → fall through to the loose-file logic below.
    }

    const hasDir = entries.some(en => en.isDirectory);
    // Only notes (.md/.txt), PDFs and drawings (.draw) are imported into the
    // vault — images, audio, video, scripts and everything else are DISCARDED.
    // Own the drop only if there's a folder or an importable md/pdf/draw file.
    if (!hasDir && !flat.some(f => /\.(md|markdown|txt|pdf|draw)$/i.test(f.name))) return;

    e.preventDefault();
    e.stopPropagation();

    // Import INTO the folder that was highlighted under the cursor ('' = root).
    const baseFolder = _extDropTarget;
    _clearExtDropTarget();

    // Drop anything inside a hidden/dot segment (.obsidian/.trash/.stversions/.git…) so
    // an Obsidian vault's service folders never get imported as notes/attachments.
    const gathered = (entries.length ? await _gatherEntries(entries) : flat.map(f => ({ file: f, rel: f.name })))
      .filter(g => !g.rel.split('/').some(s => s.startsWith('.')));
    const mdFiles   = gathered.filter(g => /\.(md|markdown|txt)$/i.test(g.rel));
    const pdfFiles  = gathered.filter(g => /\.pdf$/i.test(g.rel));
    const drawFiles = gathered.filter(g => /\.draw$/i.test(g.rel));
    if (!mdFiles.length && !pdfFiles.length && !drawFiles.length) return;

    // ── Obsidian-style import: bring in referenced images/PDFs/media and rewrite
    // Obsidian embeds (![[file]]) + local links into Amelie's format, so attachments
    // survive the import instead of being discarded. Attachments are saved FIRST so the
    // note rewrite can point at their final (sanitized) names. Only for FOLDER drops
    // (hasDir) — a loose file drop keeps its old behaviour (a single PDF opens in a tab
    // below). Skips hidden dirs (.obsidian/.trash/.stversions/…).
    const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
    const AV_EXT_RE  = /\.(mp4|mov|webm|mp3|wav|m4a)$/i;
    const ATT_ANY_RE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|mp4|mov|webm|mp3|wav|m4a)$/i;
    const _hiddenRel = (r) => r.split('/').some(s => s.startsWith('.'));
    const _attByBase = new Map(), _attByRel = new Map();
    let mediaImported = 0;
    if (hasDir) {
      for (const g of gathered) {
        if (!ATT_ANY_RE.test(g.rel) || _hiddenRel(g.rel)) continue;
        // images → attachments/ ; pdf → attachments/pdf/ ; audio+video → attachments/media/
        const sub = /\.pdf$/i.test(g.rel) ? 'pdf/' : AV_EXT_RE.test(g.rel) ? 'media/' : '';
        try {
          const buf = new Uint8Array(await g.file.arrayBuffer());
          const saved = await window.inkwell.saveAttachment(sub + g.file.name, buf);  // sanitize + dedup + encrypt in main
          _attByBase.set(g.rel.split('/').pop().toLowerCase(), saved);
          _attByRel.set(g.rel.toLowerCase(), saved);
          mediaImported++;
        } catch (err) { console.error('Import attachment failed:', g.rel, err); }
      }
    }
    const _attLookup = (t) => { t = t.replace(/^\.\//, ''); return _attByRel.get(t.toLowerCase()) || _attByBase.get(t.split('/').pop().toLowerCase()) || null; };
    const _attUrl = (leaf) => 'attachments/' + leaf.split('/').map(encodeURIComponent).join('/');
    // Images render inline (![]); PDFs/audio/video become a labelled LINK (Amelie can't
    // inline them) — matching insertAttachmentRef's 📎/🎵/🎬 format so clicking opens them.
    const _attMarkup = (leaf, label, alias) => {
      if (IMG_EXT_RE.test(leaf)) { const w = /^\d+$/.test(alias) ? `{width=${alias}}` : ''; return `![📷](${_attUrl(leaf)})${w}`; }   // 📷 marker (filename already in the URL; icon makes the image locatable in edit view)
      const isAudio = /\.(mp3|wav|m4a)$/i.test(leaf), isVideo = /\.(mp4|mov|webm)$/i.test(leaf);
      const icon = isAudio ? '🎵' : isVideo ? '🎬' : '📎';
      // a/v use the embed form ![…] (uniform with images; preview → player). Non-media
      // (pdf/…) stays a plain link — ![](non-image) would render as a broken <img>.
      return (isAudio || isVideo) ? `![${icon}](${_attUrl(leaf)})` : `[${icon}](${_attUrl(leaf)})`;   // short: filename already in the URL
    };
    const rewriteObsidian = (md) => {
      // ![[file.ext]] / ![[img.png|300]] → image embed or 📎 link (by file type)
      md = md.replace(/!\[\[([^\]]+)\]\]/g, (m, inner) => {
        const parts = inner.split('|'); const target = parts[0].split('#')[0].trim(); const alias = parts[1] ? parts[1].trim() : '';
        if (ATT_ANY_RE.test(target)) {
          const leaf = _attLookup(target);
          if (!leaf) return m;                          // dangling embed (file not present) → leave as-is
          return _attMarkup(leaf, target.split('/').pop(), alias);
        }
        return `[[${inner}]]`;                           // ![[Note]] transclusion → plain note link
      });
      // local ![alt](path/file) → attachments/… (leave http/data/inkwell/attachments alone)
      md = md.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, alt, url, title) => {
        if (/^(https?:|data:|inkwell:|attachments\/)/i.test(url)) return m;
        let dec; try { dec = decodeURIComponent(url); } catch (_) { dec = url; }
        const leaf = _attLookup(dec);
        if (!leaf) return m;
        return IMG_EXT_RE.test(leaf) ? `![${alt || '📷'}](${_attUrl(leaf)}${title || ''})` : _attMarkup(leaf, dec.split('/').pop(), '');
      });
      return md;
    };

    // Import .md notes, preserving the dropped folder structure inside the vault,
    // under the target folder you dropped onto.
    let imported = 0;
    for (const g of mdFiles) {
      try {
        const content = rewriteObsidian(await g.file.text());
        let rel = g.rel.replace(/\.(markdown|txt)$/i, '.md');
        if (!/\.md$/i.test(rel)) rel += '.md';
        rel = rel.split('/').map(s => s.replace(/[\\?%*:|"<>]/g, '-')).filter(Boolean).join('/');
        const dest = baseFolder ? `${baseFolder}/${rel}` : rel;
        await window.inkwell.writeNote(dest, content);
        imported++;
      } catch (err) { console.error('Import md failed:', g.rel, err); }
    }

    if (imported > 0) {
      await loadTree();
      showToast(window.i18n.t(imported === 1 ? 'toast.note_imported' : 'toast.notes_imported', { n: imported }));
    }

    // Import .draw drawings (plain files in the tree), preserving folder structure.
    let drawImported = 0;
    for (const g of drawFiles) {
      try {
        const content = await g.file.text();
        const rel = g.rel.split('/').map(s => s.replace(/[\\?%*:|"<>]/g, '-')).filter(Boolean).join('/');
        const dest = baseFolder ? `${baseFolder}/${rel}` : rel;
        await window.inkwell.writeNote(dest, content);
        drawImported++;
      } catch (err) { console.error('Import draw failed:', g.rel, err); }
    }
    if (drawImported > 0) {
      await loadTree();
      showToast(window.i18n.t('toast.files_imported', { n: drawImported }));
    }

    // Images/audio/video referenced by the notes ARE imported (above) and their
    // Obsidian embeds rewritten; loose scripts and other unref'd types are skipped.

    // Loose single-PDF drop → save to attachments/pdf/ and open it in a viewer tab.
    // For a FOLDER import the PDFs are already handled above (saved to attachments/pdf/
    // and linked inside the notes), so we do NOT open a tab per PDF — a vault with many
    // PDFs would otherwise spawn a tab for each.
    let pdfImported = 0;
    for (const g of (hasDir ? [] : pdfFiles)) {
      const file = g.file;
      // Reject >512 MB BEFORE reading the whole file into the renderer heap
      // (main also caps it, but only after the bytes already exist here).
      if (file.size > 512 * 1024 * 1024) { showToast(window.i18n.t('attach.too_large')); continue; }
      try {
        const buf = await file.arrayBuffer();
        const savedName = await window.inkwell.saveAttachment('pdf/' + file.name, new Uint8Array(buf));
        const existingIdx = tabs.findIndex(t => t.type === 'pdf' && t.attachmentName === savedName);
        if (existingIdx >= 0) {
          await switchTab(existingIdx);
        } else {
          tabs.push({ type: 'pdf', name: savedName.split('/').pop(), attachmentName: savedName, path: `attachments/${savedName}` });
          await switchTab(tabs.length - 1);
        }
        pdfImported++;
        // No "PDF added" toast — the imported PDF opens in a tab as feedback.
      } catch (err) { console.error('Import pdf failed:', file.name, err); }
    }
    if (pdfImported > 0) await loadTree();

  }, true);

  // Close button
  $('btn-pdf-close')?.addEventListener('click', () => {
    if (tabs[activeTabIdx]?.type === 'pdf') closeTab(activeTabIdx);
    else $('pdf-overlay').style.display = 'none';
  });

  // Image viewer controls (sidebar photos)
  $('btn-img-view-close')?.addEventListener('click', () => {
    if (tabs[activeTabIdx]?.type === 'image') closeTab(activeTabIdx);
    else $('img-view-overlay').style.display = 'none';
  });
  // Media player close (same rule as the image viewer: close the tab if it owns one)
  $('btn-media-view-close')?.addEventListener('click', () => {
    const t = tabs[activeTabIdx];
    if (t?.type === 'audio' || t?.type === 'video') closeTab(activeTabIdx);
    else { $('media-view-overlay').style.display = 'none'; pauseMediaViewUnlessActive(); }
  });
  $('img-zoom-in')?.addEventListener('click', () => setImgZoom(_imgZoom + 0.2));
  $('img-zoom-out')?.addEventListener('click', () => setImgZoom(_imgZoom - 0.2));

  // PDF zoom controls
  $('pdf-zoom-in')?.addEventListener('click', () => setPdfZoom(_pdfZoom + 0.2));
  $('pdf-zoom-out')?.addEventListener('click', () => setPdfZoom(_pdfZoom - 0.2));
  $('pdf-zoom-fit')?.addEventListener('click', () => pdfZoomFitWidth());
  // PDF annotation editor tools
  $('pdf-tool-pen')?.addEventListener('click', () => setPdfTool('pen'));
  $('pdf-tool-hl')?.addEventListener('click', () => setPdfTool('highlight'));
  // Colour picker for pen / highlighter
  $('pdf-color')?.addEventListener('click', (e) => { e.stopPropagation(); togglePdfColorPop(); });
  $('pdf-color-input')?.addEventListener('input', (e) => setPdfToolColor(e.target.value));
  // Compress PDF: button opens a quality menu; each item runs the compression
  $('pdf-compress')?.addEventListener('click', (e) => { e.stopPropagation(); togglePdfComprPop(); });
  document.querySelectorAll('#pdf-compress-pop .pdf-cmp-item').forEach((it) =>
    it.addEventListener('click', () => compressPdfFile(it.dataset.level)));
  document.addEventListener('click', (e) => {
    if (_pdfColorPopOpen && !e.target.closest('#pdf-color-pop') && !e.target.closest('#pdf-color')) _closePdfColorPop();
    if (_pdfComprPopOpen && !e.target.closest('#pdf-compress-pop') && !e.target.closest('#pdf-compress')) _closePdfComprPop();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { _closePdfColorPop(); _closePdfComprPop(); } });
  $('pdf-tool-text')?.addEventListener('click', () => setPdfTool('text'));
  // Text font picker: fill it from PDF_FONTS (single source of truth) and apply
  // the choice to the default + any selected/editing text box.
  const _pdfFontSel = $('pdf-font');
  if (_pdfFontSel && !_pdfFontSel.options.length) {
    for (const f of PDF_FONTS) {
      const o = document.createElement('option');
      o.value = f.id; o.textContent = _pdfFontLabel(f);
      o.style.fontFamily = f.css; o.style.fontWeight = f.weight; o.style.fontStyle = f.style;
      _pdfFontSel.appendChild(o);
    }
    // Start on the standard family closest to the editor font, so text added to a PDF looks
    // as much like the notes as the format allows. Still fully changeable from this picker.
    PDF_TEXT.font = _pdfFontForEditorFont();
    _pdfFontSel.value = PDF_TEXT.font;
    _pdfFontSel.addEventListener('change', (e) => setPdfTextFont(e.target.value));
  }
  // Text size picker: fill from PDF_SIZES and apply to the default + selected box.
  const _pdfSizeSel = $('pdf-fontsize');
  if (_pdfSizeSel && !_pdfSizeSel.options.length) {
    for (const s of PDF_SIZES) {
      const o = document.createElement('option');
      o.value = String(s); o.textContent = String(s);
      _pdfSizeSel.appendChild(o);
    }
    _pdfSizeSel.value = String(PDF_TEXT.size);
    _pdfSizeSel.addEventListener('change', (e) => setPdfTextSize(e.target.value));
  }
  $('pdf-tool-image')?.addEventListener('click', () => addPdfImage());
  $('pdf-undo')?.addEventListener('click', () => undoPdfAnnot());
  $('pdf-save')?.addEventListener('click', () => savePdfEdits());
  $('pdf-save-as')?.addEventListener('click', () => savePdfEditsAsNew());
  // PDF page operations (thumbnail panel: reorder/rotate/delete/merge)
  $('pdf-pages')?.addEventListener('click', () => setPdfPagePanel(!_pdfPagePanelOpen));
  // Ctrl/Cmd + wheel to zoom the PDF (like the note editor).
  $('pdf-embed')?.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setPdfZoom(_pdfZoom + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  // Delete / Backspace removes the currently selected added text or image object (click
  // one first to select it). Guarded so it never fires while typing in a field / editing
  // a text box, and only while the PDF editor is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace' || !_pdfSelText) return;
    const ov = document.getElementById('pdf-overlay');
    if (!ov || ov.style.display === 'none' || ov.style.display === '') return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    _deletePdfObj(_pdfSelText, _pdfSelText.page);
  });

  // Text color button → palette popup → wrap the selection in a colored <span>.
  // Self-contained: uses applyTextColor()/removeTextColor() (which read the
  // textarea selection). mousedown preventDefault keeps the selection alive.
  // 12 colors = EXACTLY those from the text right-click menu (TEXT_COLORS),
  // shown by NAME instead of the hex code.
  const _TC_NAMES = {
    '#e0758a': 'Rosa',  '#c9a96e': 'Sabbia',   '#6ab0d4': 'Azzurro', '#a78bda': 'Viola',
    '#7ec97a': 'Verde', '#d4916a': 'Pesca',    '#e05c6a': 'Rosso',   '#3d9970': 'Verde scuro',
    '#9aacbe': 'Grigio','#dde6f0': 'Ghiaccio', '#e0a84a': 'Oro',     '#c4a7e7': 'Lavanda',
  };
  const _TC12 = TEXT_COLORS.map(hex => ({ hex, label: _TC_NAMES[hex] || hex }));
  let _colorPop = null;
  const _closeColorPop = () => { if (_colorPop) { _colorPop.remove(); _colorPop = null; } };
  $('btn-color')?.addEventListener('mousedown', (e) => e.preventDefault());
  $('btn-color')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_colorPop) { _closeColorPop(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.style.cssText = 'position:fixed;z-index:3000;padding:10px;background:var(--bg-2);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.5);font-family:var(--ui-font)';
    // 4 × 3 grid: each cell is a colored square with the name below.
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px';
    const mkCell = (label, color, onClick) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.title = label;
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;width:58px;padding:6px 2px;background:transparent;border:1px solid transparent;border-radius:7px;cursor:pointer;color:var(--text-2);font:inherit';
      cell.addEventListener('mouseenter', () => { cell.style.background = 'var(--bg-3)'; cell.style.borderColor = 'var(--border)'; cell.style.color = 'var(--text-0)'; });
      cell.addEventListener('mouseleave', () => { cell.style.background = 'transparent'; cell.style.borderColor = 'transparent'; cell.style.color = 'var(--text-2)'; });
      const sw = document.createElement('span');
      if (color) {
        sw.style.cssText = 'width:26px;height:26px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:' + color;
      } else {
        sw.textContent = '✕';
        sw.style.cssText = 'width:26px;height:26px;border-radius:6px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:13px;color:var(--text-2)';
      }
      const tx = document.createElement('span');
      tx.textContent = label;
      tx.style.cssText = 'font-size:10px;line-height:1.1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:54px';
      cell.appendChild(sw); cell.appendChild(tx);
      cell.addEventListener('mousedown', ev => ev.preventDefault());
      cell.addEventListener('click', () => { onClick(); _closeColorPop(); editor.focus(); });
      return cell;
    };
    _TC12.forEach(({ hex, label }) => grid.appendChild(mkCell(label, hex, () => applyTextColor(hex))));
    pop.appendChild(grid);
    // Full-width "Remove color" row below the grid.
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '✕  Rimuovi colore';
    rm.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;width:100%;margin-top:8px;padding:6px;background:transparent;border:1px solid var(--border);border-radius:7px;cursor:pointer;color:var(--text-2);font:inherit;font-size:12px';
    rm.addEventListener('mouseenter', () => { rm.style.background = 'var(--bg-3)'; rm.style.color = 'var(--text-0)'; });
    rm.addEventListener('mouseleave', () => { rm.style.background = 'transparent'; rm.style.color = 'var(--text-2)'; });
    rm.addEventListener('mousedown', ev => ev.preventDefault());
    rm.addEventListener('click', () => { removeTextColor(); _closeColorPop(); editor.focus(); });
    pop.appendChild(rm);
    document.body.appendChild(pop);
    // Position below the button, keeping it within the screen on the right.
    const pw = pop.offsetWidth;
    let left = Math.round(r.left);
    if (left + pw + 8 > window.innerWidth) left = Math.max(8, window.innerWidth - pw - 8);
    pop.style.left = left + 'px';
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    _colorPop = pop;
    setTimeout(() => {
      const onDoc = (ev) => { if (_colorPop && !_colorPop.contains(ev.target)) { _closeColorPop(); document.removeEventListener('mousedown', onDoc, true); } };
      document.addEventListener('mousedown', onDoc, true);
    }, 0);
  });
}

// ─── Todo system ──────────────────────────────────────────────────────────────

const TASKS_KEY = 'amelie-tasks';
let tasks = [];
let taskEditId = null;
let todoFilter = 'all';
let notifTimers = {};

function loadTasks() {
  try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'); } catch(_) { tasks = []; }
}
function saveTasks() {
  try { localStorage.setItem(TASKS_KEY, JSON.stringify(tasks)); } catch(_) {}
}
function genTaskId() { return 't' + Date.now() + Math.random().toString(36).slice(2,6); }

// ═══ Viste sidebar: Files · Recent · Bookmarks · Tags · ToDo ═══════════════════
const RECENT_KEY = 'amelie-recent';
const BOOKMARKS_KEY = 'amelie-bookmarks';
let _sidebarView = 'files';

function _lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch(_) { return []; } }
function _lsSet(k, a) { try { localStorage.setItem(k, JSON.stringify(a)); } catch(_) {} }
function _baseName(p) { return (p || '').split('/').pop().replace(/\.md$/, ''); }

function pushRecent(node) {
  if (!node || !node.path) return;
  let r = _lsGet(RECENT_KEY).filter(x => x.path !== node.path);
  r.unshift({ path: node.path, name: node.name || _baseName(node.path) });
  _lsSet(RECENT_KEY, r.slice(0, 30));
  if (_sidebarView === 'recent') renderRecentView();
}

function isBookmarked(p) { return _lsGet(BOOKMARKS_KEY).some(x => x.path === p); }
function toggleBookmark(node) {
  if (!node || !node.path) return;
  let b = _lsGet(BOOKMARKS_KEY);
  if (b.some(x => x.path === node.path)) b = b.filter(x => x.path !== node.path);
  else b.unshift({ path: node.path, name: node.name || _baseName(node.path) });
  _lsSet(BOOKMARKS_KEY, b);
  if (_sidebarView === 'bookmarks') renderBookmarksView();
}

function _findNode(path) {
  return (function find(nodes) {
    for (const n of (nodes || [])) { if (n.path === path) return n; if (n.children) { const f = find(n.children); if (f) return f; } }
    return null;
  })(state.notes || []);
}
function _openByPath(path, name) { openTab(_findNode(path) || { path, name: name || _baseName(path) }); }

function _simpleRow(label, onClick, onRemove) {
  const row = document.createElement('div'); row.className = 'simple-row';
  const span = document.createElement('span'); span.className = 'simple-name'; span.textContent = label;
  span.addEventListener('click', onClick); row.appendChild(span);
  if (onRemove) { const x = document.createElement('button'); x.className = 'simple-remove'; x.textContent = '×'; x.addEventListener('click', e => { e.stopPropagation(); onRemove(); }); row.appendChild(x); }
  return row;
}

function renderRecentView() {
  const c = $('recent-list'); if (!c) return; c.innerHTML = '';
  const r = _lsGet(RECENT_KEY);
  if (!r.length) { c.innerHTML = `<div class="view-empty">${window.i18n.t('section.recent_empty')}</div>`; return; }
  r.forEach(it => {
    const node = _findNode(it.path);
    const mod = node && node.modified ? new Date(node.modified).getTime() : null;
    const row = document.createElement('div'); row.className = 'simple-row';
    const main = document.createElement('div'); main.className = 'simple-main';
    const name = document.createElement('div'); name.className = 'simple-name'; name.textContent = it.name;
    main.appendChild(name);
    if (mod) { const sub = document.createElement('div'); sub.className = 'simple-sub'; sub.textContent = window.i18n.t('recent.modified') + ' ' + _fmtDateDMY(mod); main.appendChild(sub); }
    main.addEventListener('click', () => _openByPath(it.path, it.name));
    row.appendChild(main);
    c.appendChild(row);
  });
}

function renderBookmarksView() {
  const c = $('bookmarks-list'); if (!c) return; c.innerHTML = '';
  const b = _lsGet(BOOKMARKS_KEY);
  if (!b.length) { c.innerHTML = `<div class="view-empty">${window.i18n.t('section.bookmarks_empty')}</div>`; return; }
  b.forEach(it => {
    const removeFn = () => { toggleBookmark({ path: it.path }); renderBookmarksView(); };
    const row = _simpleRow(it.name, () => _openByPath(it.path, it.name), removeFn);
    // For the search bar filter: note name and path.
    row.dataset.name = ((it.name || '') + '\n' + (it.path || '')).toLowerCase();
    // Right-click → remove from bookmarks (no extra tab opened).
    row.addEventListener('contextmenu', (e) => showBookmarkContextMenu(e, it.path));
    c.appendChild(row);
  });
  _wireBookmarksSearch();
  _applyBookmarksFilter();
}

// ── Bookmark section search bar: live filter on name and path ─────────────────
let _bookmarksSearchWired = false;
function _wireBookmarksSearch() {
  if (_bookmarksSearchWired) return;
  const inp = $('bookmarks-search-input');
  if (!inp) return;
  _bookmarksSearchWired = true;
  inp.addEventListener('input', _applyBookmarksFilter);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; _applyBookmarksFilter(); }
  });
}
function _applyBookmarksFilter() {
  const inp = $('bookmarks-search-input');
  const c = $('bookmarks-list');
  if (!inp || !c) return;
  const q = inp.value.trim().toLowerCase();
  let visible = 0;
  c.querySelectorAll('.simple-row').forEach(r => {
    const hit = !q || (r.dataset.name || '').includes(q);
    r.style.display = hit ? '' : 'none';
    if (hit) visible++;
  });
  // "No bookmark" message when the filter matches nothing.
  let empty = c.querySelector('.bookmarks-filter-empty');
  if (q && !visible && c.querySelector('.simple-row')) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'view-empty bookmarks-filter-empty';
      empty.textContent = window.i18n.t('section.bookmarks_empty');
      c.appendChild(empty);
    }
    empty.style.display = '';
  } else if (empty) {
    empty.style.display = 'none';
  }
}

// ─── Bookmark row context menu (left sidebar) ─────────────────────────────────
let _bmCtxPath = null;
function showBookmarkContextMenu(e, path) {
  e.preventDefault();
  e.stopPropagation();
  _bmCtxPath = path;
  const menu = $('bookmark-context-menu');
  if (!menu) return;
  menu.style.display = 'block';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
}

function setupBookmarkContextMenu() {
  const menu = $('bookmark-context-menu');
  if (!menu) return;
  document.addEventListener('click', e => {
    if (!e.target.closest('#bookmark-context-menu')) menu.style.display = 'none';
  });
  $('bmctx-remove')?.addEventListener('click', () => {
    menu.style.display = 'none';
    if (_bmCtxPath) { toggleBookmark({ path: _bmCtxPath }); renderBookmarksView(); }
  });
}

async function renderTagsView() {
  const c = $('tags-list'); if (!c) return;
  c.innerHTML = `<div class="view-empty">…</div>`;
  const flat = flattenTree(state.notes || []).filter(n => n.type !== 'folder' && n.path && n.path.endsWith('.md'));
  const tagMap = {};
  for (const n of flat) {
    let content = ''; try { content = await window.inkwell.readNote(n.path); } catch(_) {}
    const seen = new Set();
    const add = (t) => {
      const tag = t.trim().replace(/^#/, '');
      if (!tag || seen.has(tag.toLowerCase())) return;
      seen.add(tag.toLowerCase());
      (tagMap[tag] = tagMap[tag] || []).push(n);
    };

    // 1) Frontmatter "tags:" line.
    let body = content;
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (m) {
      const tline = m[1].split('\n').find(l => /^tags\s*:/i.test(l));
      if (tline) tline.replace(/^tags\s*:/i, '').split(/[,\s]+/).forEach(add);
      body = content.slice(m[0].length);   // strip frontmatter before inline scan
    }

    // 2) Inline hashtags in the body — "#mytag" written anywhere in the text.
    //    Must start with a letter, may contain letters/digits/_/-/ (no spaces).
    //    Preceded by start-of-string or whitespace so "#" inside a URL/word and
    //    markdown headings ("# Titolo", followed by a space) are NOT matched.
    const re = /(^|\s)#([A-Za-z][\w-]*)/g;
    let mm;
    while ((mm = re.exec(body)) !== null) add(mm[2]);
  }
  const keys = Object.keys(tagMap).sort();
  c.innerHTML = '';
  if (!keys.length) { c.innerHTML = `<div class="view-empty">${window.i18n.t('section.tags_empty')}</div>`; return; }
  for (const t of keys) {
    const group = document.createElement('div'); group.className = 'tag-group';
    // For the search bar filter: tag and source note names.
    group.dataset.tag = t.toLowerCase();
    group.dataset.srcs = tagMap[t].map(n => (n.name || '').toLowerCase()).join('\n');
    tagMap[t].forEach(n => {
      const row = document.createElement('div'); row.className = 'tag-row';
      // Column 1: the hashtag itself — clicking jumps to "#tag" inside the note
      // with the caret placed right before it.
      const tagBtn = document.createElement('span');
      tagBtn.className = 'tag-chip';
      tagBtn.textContent = `#${t}`;
      tagBtn.title = window.i18n.t('tags.goto_tag');
      tagBtn.addEventListener('click', () => _openByPathAtTag(n.path, n.name, t));
      // Column 2: the source (note name) in blue — opens the note at the top.
      const src = document.createElement('span');
      src.className = 'tag-src';
      src.textContent = n.name;
      src.title = n.path;
      src.addEventListener('click', () => _openByPath(n.path, n.name));
      row.append(tagBtn, src);
      group.appendChild(row);
    });
    c.appendChild(group);
  }
  _wireTagsSearch();
  _applyTagsFilter();
}

// ── Tag section search bar: live filter on tag name and note name ─────────────
let _tagsSearchWired = false;
function _wireTagsSearch() {
  if (_tagsSearchWired) return;
  const inp = $('tags-search-input');
  if (!inp) return;
  _tagsSearchWired = true;
  inp.addEventListener('input', _applyTagsFilter);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Escape') { inp.value = ''; _applyTagsFilter(); }
  });
}
function _applyTagsFilter() {
  const inp = $('tags-search-input');
  const c = $('tags-list');
  if (!inp || !c) return;
  const q = inp.value.trim().replace(/^#/, '').toLowerCase();
  let visible = 0;
  c.querySelectorAll('.tag-group').forEach(g => {
    const hit = !q || (g.dataset.tag || '').includes(q) || (g.dataset.srcs || '').includes(q);
    g.style.display = hit ? '' : 'none';
    if (hit) visible++;
  });
  // "No results" message when the filter matches nothing.
  let empty = c.querySelector('.tags-filter-empty');
  if (q && !visible && c.querySelector('.tag-group')) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'view-empty tags-filter-empty';
      empty.textContent = window.i18n.t('section.tags_empty');
      c.appendChild(empty);
    }
    empty.style.display = '';
  } else if (empty) {
    empty.style.display = 'none';
  }
}

// Open a note and place the caret right before its "#tag" occurrence, scrolling
// it into view. Used when clicking a tag in the Tags sidebar view.
async function _openByPathAtTag(path, name, tag) {
  _openByPath(path, name);
  // Wait for switchTab to finish loading content + its own cursor restore
  // (which runs in a requestAnimationFrame), then override the caret.
  const place = () => {
    const tab = getActiveTab();
    if (!tab || tab.path !== path) return;
    const text = editor.value || '';
    // Match the inline hashtag (#tag) — same rule as the parser. Fall back to a
    // frontmatter mention if there's no inline one.
    const re = new RegExp('(^|\\s)(#' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\w-])', 'i');
    const m = re.exec(text);
    let pos = m ? m.index + m[1].length : text.toLowerCase().indexOf('#' + tag.toLowerCase());
    if (pos < 0) pos = 0;
    if (state.viewMode !== 'edit') { try { setViewMode('edit'); } catch(_) {} }
    editor.focus();
    try { editor.setSelectionRange(pos, pos); } catch(_) {}
    // Scroll the caret line roughly into the middle of the viewport.
    const before = text.slice(0, pos);
    const line = before.split('\n').length - 1;
    const lh = parseFloat(getComputedStyle(editor).lineHeight) || 20;
    editor.scrollTop = Math.max(0, line * lh - editor.clientHeight / 2);
  };
  // Two RAFs: one for switchTab's own restore, one to land after it.
  requestAnimationFrame(() => requestAnimationFrame(place));
}

// ── Kanban ToDo board (cartella ToDo nell'albero → board nell'area principale) ──
let _kanbanOpen = false;
let _todoFilter = 'all';
let _todoDragFrom = null;
let _todoDragFile = null;   // file currently being dragged (for in-bucket reorder)

// Manual ordering per bucket (file names in desired order), persisted locally.
const _todoOrder = (() => {
  try { return JSON.parse(localStorage.getItem('amelie-todo-order') || '{}'); } catch(_) { return {}; }
})();
function _saveTodoOrder() {
  try { localStorage.setItem('amelie-todo-order', JSON.stringify(_todoOrder)); } catch(_) {}
}
// Sort a bucket's items by the saved manual order; unknown files keep their
// incoming (mtime) order at the end.
function _applyTodoOrder(bucket, items) {
  const ord = _todoOrder[bucket];
  if (!ord || !ord.length) return items;
  const idx = new Map(ord.map((f, i) => [f, i]));
  return items.slice().sort((a, b) => {
    const ia = idx.has(a.file) ? idx.get(a.file) : Infinity;
    const ib = idx.has(b.file) ? idx.get(b.file) : Infinity;
    if (ia !== ib) return ia - ib;
    return 0;
  });
}
// Reorder `file` within `bucket` so it sits before `beforeFile` (or at the end
// if beforeFile is null).
function _reorderTodo(bucket, file, beforeFile) {
  const items = (_todoCache[bucket] || []).map(x => x.file);
  let order = (_todoOrder[bucket] && _todoOrder[bucket].length)
    ? _todoOrder[bucket].filter(f => items.includes(f))
    : items.slice();
  // Ensure all current files are present.
  items.forEach(f => { if (!order.includes(f)) order.push(f); });
  order = order.filter(f => f !== file);
  const at = beforeFile ? order.indexOf(beforeFile) : -1;
  if (at < 0) order.push(file); else order.splice(at, 0, file);
  _todoOrder[bucket] = order;
  _saveTodoOrder();
  renderTodoView();
}
const ALERT_OPTS = [['', 'todo.no_alert'], ['5', 'todo.alert_5'], ['15', 'todo.alert_15'], ['30', 'todo.alert_30'], ['60', 'todo.alert_60'], ['1440', 'todo.alert_1d'], ['custom', 'todo.alert_custom']];
const ALERT_PRESETS = ['5', '15', '30', '60', '1440'];

function _fmtDue(due) { const d = new Date(due); if (isNaN(d)) return ''; return d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
// Reminder due date as explicit day/month/year + time (Notifications view).
function _fmtDueDMY(due) { const d = new Date(due); if (isNaN(d)) return ''; const p = n => String(n).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); }
function _fmtDate(ms) { const d = new Date(ms); if (isNaN(d)) return '—'; return d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
// Explicit day/month/year (never locale-reordered) — used in the Recents view.
function _fmtDateDMY(ms) { const d = new Date(ms); if (isNaN(d)) return '—'; const p = n => String(n).padStart(2, '0'); return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear(); }
function _isOverdue(due) { const d = new Date(due); return !isNaN(d) && d.getTime() < Date.now(); }

// The board lives in a TAB of its own, like the graph: opening it from a notification (or
// the sections bar) used to leave the tab bar showing the note you had open before, so the
// tab said "shopping list" while the ToDo board was on screen.
function openTodoView() {
  // Already on the board → stay put, no refresh: re-opening must not rebuild
  // the list (which would close any open editor and reset the scroll).
  const tv0 = $('todo-view');
  if (_kanbanOpen && tv0 && tv0.style.display !== 'none') return;
  // Remember where to come back to: the board's tab is appended at the END, so closing it
  // would otherwise fall to the neighbour rule and land on the last tab in the bar.
  const cur = getActiveTab();
  if (cur && cur.path && !cur.type) _todoReturnPath = cur.path;
  const existing = tabs.findIndex(t => t.type === 'todo');
  if (existing !== -1) { switchTab(existing); return; }
  tabs.push({ type: 'todo', name: 'ToDo', path: null, isDirty: false });
  switchTab(tabs.length - 1);
}
// Put the board on screen. Called from switchTab, so every route in (a click on the tab,
// a notification, the sections bar) goes through the same place.
function showTodoView() {
  try { closeTOC(); } catch (_) {}   // the index belongs to a note, not the ToDo board
  _kanbanOpen = true;
  const es = $('empty-state'); if (es) es.style.display = 'none';
  const ec = $('editor-container'); if (ec) ec.style.display = 'none';
  const tv = $('todo-view'); if (tv) tv.style.display = 'flex';
  // Hint on the Files icon: it turns into a "back to notes" affordance so the
  // user knows clicking it again leaves the ToDo board.
  const vf = $('view-files'); if (vf) vf.classList.add('kanban-active');
  renderTodoView();
}
function openKanban() { openTodoView(); }   // alias (voce ToDo nell'albero / addTodo)
let _todoReturnPath = null;   // the note the board was opened from

async function closeKanban() {
  if (!_kanbanOpen) return;
  // Its own tab now: closing the board means closing that tab, which switches to the
  // neighbouring note and hides the view through hideAllSpecialViews — then back to the note
  // the board was opened from, which is rarely that neighbour.
  const idx = tabs.findIndex(t => t.type === 'todo');
  if (idx !== -1) {
    const back = _todoReturnPath;
    await closeTab(idx);
    if (back) {
      const i = tabs.findIndex(t => t.path === back && !t.type);
      if (i !== -1 && i !== activeTabIdx) await switchTab(i);
    }
    return;
  }
  _kanbanOpen = false;
  const tv = $('todo-view'); if (tv) tv.style.display = 'none';
  const vf = $('view-files'); if (vf) vf.classList.remove('kanban-active');
}
function setTodoFilter(f) { _todoFilter = f; renderTodoView(); }

async function renderTodoView() {
  const list = $('todo-view-list'); if (!list) return;
  let data; try { data = await window.inkwell.todo.list(); } catch(_) { data = _emptyTodoBuckets(); }
  _todoCache = data;
  document.querySelectorAll('.tv-filter').forEach(b => b.classList.toggle('active', b.dataset.f === _todoFilter));
  const addRow = $('todo-add-row');
  if (addRow) { addRow.style.display = (_todoFilter === 'done') ? 'none' : ''; addRow.innerHTML = ''; addRow.appendChild(_todoAddTrigger()); }
  list.innerHTML = '';
  const sections = _todoFilter === 'all'
    ? [['today', 'todo.filter_today'], ['tomorrow', 'todo.filter_tomorrow'], ['upcoming', 'todo.filter_upcoming'], ['done', 'todo.filter_done']]
    : [[_todoFilter, 'todo.filter_' + _todoFilter]];
  for (const [bucket, labelKey] of sections) {
    const items = data[bucket] || [];
    const sec = document.createElement('div'); sec.className = 'todo-section'; sec.dataset.bucket = bucket;
    if (_todoFilter === 'all') {
      const h = document.createElement('div'); h.className = 'todo-sec-head';
      h.innerHTML = `<span>${window.i18n.t(labelKey)}</span><span class="todo-sec-count">${items.length}</span>`;
      sec.appendChild(h);
    }
    // Drop on the section background: move into this bucket (from another), or
    // — if from the same bucket — drop at the end (reorder to last).
    sec.addEventListener('dragover', e => {
      if (!_todoDragFrom) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      sec.classList.add('drop-hover');
    });
    sec.addEventListener('dragleave', e => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('drop-hover'); });
    sec.addEventListener('drop', async e => {
      e.preventDefault(); sec.classList.remove('drop-hover');
      const file = e.dataTransfer.getData('text/file'); const from = e.dataTransfer.getData('text/from');
      if (!file || !from) return;
      if (from !== bucket) { await window.inkwell.todo.move(file, from, bucket); renderTodoView(); refreshTodoAlerts(); }
      else { _reorderTodo(bucket, file, null); }   // same bucket → send to end
    });
    if (!items.length) { const e = document.createElement('div'); e.className = 'todo-sec-empty'; e.textContent = window.i18n.t('todo.section_empty'); sec.appendChild(e); }
    _applyTodoOrder(bucket, items).forEach(it => sec.appendChild(_todoRow(it)));
    list.appendChild(sec);
  }
  updateNotifBell();
}

// Close any currently-open inline editors (re-render restores their rows), so
// only one editor is ever open at a time (avoids the "two boxes" glitch).
function _closeTodoEditors() {
  if (document.querySelector('.todo-editor')) renderTodoView();
}

function _todoAddTrigger() {
  const row = document.createElement('div'); row.className = 'todo-add-trigger';
  row.innerHTML = `<span class="todo-add-plus">+</span><span>${window.i18n.t('todo.new_task')}</span>`;
  row.addEventListener('click', () => {
    if (document.querySelector('.todo-editor')) return;   // an editor is already open
    const bucket = _todoFilter === 'upcoming' ? 'upcoming' : 'today';
    row.replaceWith(_todoInlineEditor(bucket, null));
  });
  return row;
}

function _todoRow(it) {
  const row = document.createElement('div'); row.className = 'todo-row' + (it.bucket === 'done' ? ' done' : '');
  row.draggable = true;
  row.addEventListener('dragstart', e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/file', it.file); e.dataTransfer.setData('text/from', it.bucket); _todoDragFrom = it.bucket; _todoDragFile = it.file; row.classList.add('dragging'); });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); _todoDragFrom = null; _todoDragFile = null; document.querySelectorAll('.todo-section.drop-hover').forEach(s => s.classList.remove('drop-hover')); document.querySelectorAll('.todo-row.drop-before').forEach(r => r.classList.remove('drop-before')); });
  // Drop ONTO another row → insert before it (works within the same bucket for
  // manual reordering, and across buckets for move + position).
  row.addEventListener('dragover', e => {
    if (!_todoDragFrom || _todoDragFile === it.file) return;
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-before');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-before'));
  row.addEventListener('drop', async e => {
    e.preventDefault(); e.stopPropagation();
    row.classList.remove('drop-before');
    const file = e.dataTransfer.getData('text/file'); const from = e.dataTransfer.getData('text/from');
    if (!file || !from || file === it.file) return;
    if (from !== it.bucket) {
      await window.inkwell.todo.move(file, from, it.bucket);
      // After the move, position the moved file before this row.
      _todoCache[it.bucket] = _todoCache[it.bucket] || [];
      if (!_todoCache[it.bucket].some(x => x.file === file)) _todoCache[it.bucket].push({ file });
      _reorderTodo(it.bucket, file, it.file);
      refreshTodoAlerts();
    } else {
      _reorderTodo(it.bucket, file, it.file);
    }
  });
  const chk = document.createElement('button'); chk.className = 'todo-check'; chk.innerHTML = it.bucket === 'done' ? '✓' : '';
  chk.title = it.bucket === 'done' ? window.i18n.t('todo.reopen') : window.i18n.t('todo.complete');
  chk.addEventListener('click', async () => { await window.inkwell.todo.move(it.file, it.bucket, it.bucket === 'done' ? 'today' : 'done'); renderTodoView(); refreshTodoAlerts(); });
  const main = document.createElement('div'); main.className = 'todo-main';
  const title = document.createElement('div'); title.className = 'todo-title'; title.textContent = it.title || '(vuoto)';
  title.addEventListener('click', () => {
    if (document.querySelector('.todo-editor')) return;   // one editor at a time
    row.replaceWith(_todoInlineEditor(it.bucket, it));
  });
  main.appendChild(title);
  if (it.due) {
    const chip = document.createElement('span'); chip.className = 'todo-chip' + ((_isOverdue(it.due) && it.bucket !== 'done') ? ' overdue' : '');
    chip.textContent = ((it.alert !== '' && it.alert != null) ? '🔔 ' : '🕒 ') + _fmtDue(it.due);
    main.appendChild(chip);
  }
  const meta = document.createElement('div'); meta.className = 'todo-meta';
  let metaTxt = window.i18n.t('todo.created') + ' ' + _fmtDate(it.created);
  if (it.bucket === 'done' && it.completed) metaTxt += '  ·  ' + window.i18n.t('todo.completed_on') + ' ' + _fmtDate(new Date(it.completed).getTime());
  meta.textContent = metaTxt;
  main.appendChild(meta);
  const actions = document.createElement('div'); actions.className = 'todo-row-actions';
  if (it.bucket !== 'done') {
    const order = ['today', 'tomorrow', 'upcoming'];
    const next = order[(order.indexOf(it.bucket) + 1) % order.length];
    const mv = document.createElement('button'); mv.className = 'todo-row-btn';
    mv.title = window.i18n.t('todo.move_to') + ' ' + window.i18n.t('todo.filter_' + next);
    mv.textContent = '»';
    mv.addEventListener('click', async e => { e.stopPropagation(); await window.inkwell.todo.move(it.file, it.bucket, next); renderTodoView(); });
    actions.appendChild(mv);
  }
  const del = document.createElement('button'); del.className = 'todo-row-btn del'; del.textContent = '×';
  del.addEventListener('click', async e => { e.stopPropagation(); await window.inkwell.todo.remove(it.bucket, it.file); renderTodoView(); refreshTodoAlerts(); });
  actions.appendChild(del);
  row.append(chk, main, actions);
  return row;
}

// Custom calendar (calendar + time selection only, with OK). No manual input.
function _buildDateField(initial) {
  const wrap = document.createElement('div'); wrap.className = 'dp-wrap';
  let value = initial || '';
  const CAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'dp-trigger';
  const fmt = v => { if (!v) return window.i18n.t('todo.set_date'); const d = new Date(v); return isNaN(d) ? window.i18n.t('todo.set_date') : d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const renderTrigger = () => { trigger.innerHTML = CAL_ICON + `<span>${fmt(value)}</span>`; };
  renderTrigger();
  const pop = document.createElement('div'); pop.className = 'dp-pop'; pop.style.display = 'none';
  let view = value && !isNaN(new Date(value)) ? new Date(value) : new Date();
  let selDate = value && !isNaN(new Date(value)) ? new Date(value) : null;
  let hh = selDate ? selDate.getHours() : 9, mm = selDate ? selDate.getMinutes() : 0;
  function renderCal() {
    pop.innerHTML = '';
    const head = document.createElement('div'); head.className = 'dp-head';
    const prev = document.createElement('button'); prev.type = 'button'; prev.className = 'dp-nav'; prev.textContent = '‹';
    const lbl = document.createElement('span'); lbl.className = 'dp-month'; lbl.textContent = view.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const next = document.createElement('button'); next.type = 'button'; next.className = 'dp-nav'; next.textContent = '›';
    prev.onclick = () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderCal(); };
    next.onclick = () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderCal(); };
    head.append(prev, lbl, next); pop.appendChild(head);
    const wd = document.createElement('div'); wd.className = 'dp-weekdays';
    ['L', 'M', 'M', 'G', 'V', 'S', 'D'].forEach(d => { const s = document.createElement('span'); s.textContent = d; wd.appendChild(s); });
    pop.appendChild(wd);
    const grid = document.createElement('div'); grid.className = 'dp-grid';
    const year = view.getFullYear(), month = view.getMonth();
    const startDow = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    for (let i = 0; i < startDow; i++) { const e = document.createElement('span'); e.className = 'dp-day empty'; grid.appendChild(e); }
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'dp-day'; cell.textContent = d;
      if (selDate && selDate.getFullYear() === year && selDate.getMonth() === month && selDate.getDate() === d) cell.classList.add('sel');
      if (today.getFullYear() === year && today.getMonth() === month && today.getDate() === d) cell.classList.add('today');
      cell.onclick = () => { selDate = new Date(year, month, d); renderCal(); };
      grid.appendChild(cell);
    }
    pop.appendChild(grid);
    const timeRow = document.createElement('div'); timeRow.className = 'dp-time';
    const clk = document.createElement('span'); clk.textContent = '🕒';
    const hSel = document.createElement('select'); for (let h = 0; h < 24; h++) { const o = document.createElement('option'); o.value = h; o.textContent = String(h).padStart(2, '0'); if (h === hh) o.selected = true; hSel.appendChild(o); }
    const mSel = document.createElement('select'); for (let m = 0; m < 60; m += 5) { const o = document.createElement('option'); o.value = m; o.textContent = String(m).padStart(2, '0'); if (m === mm) o.selected = true; mSel.appendChild(o); }
    hSel.onchange = () => hh = parseInt(hSel.value, 10); mSel.onchange = () => mm = parseInt(mSel.value, 10);
    const colon = document.createElement('span'); colon.textContent = ':'; colon.className = 'dp-colon';
    timeRow.append(clk, hSel, colon, mSel); pop.appendChild(timeRow);
    const act = document.createElement('div'); act.className = 'dp-actions';
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'dp-clear'; clear.textContent = window.i18n.t('todo.clear_date');
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'dp-ok'; ok.textContent = 'OK';
    clear.onclick = () => { value = ''; selDate = null; renderTrigger(); pop.style.display = 'none'; };
    ok.onclick = () => {
      if (selDate) { const y = selDate.getFullYear(), mo = String(selDate.getMonth() + 1).padStart(2, '0'), da = String(selDate.getDate()).padStart(2, '0'); value = `${y}-${mo}-${da}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; }
      else value = '';
      renderTrigger(); pop.style.display = 'none';
    };
    act.append(clear, ok); pop.appendChild(act);
  }
  // Close the calendar when clicking outside it (or pressing Esc) without
  // selecting anything.
  const onDocDown = (ev) => { if (!wrap.contains(ev.target)) closePop(); };
  const onKey = (ev) => { if (ev.key === 'Escape') closePop(); };
  function openPop() {
    renderCal();
    pop.style.display = 'block';
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }
  function closePop() {
    pop.style.display = 'none';
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
  trigger.onclick = e => { e.stopPropagation(); if (pop.style.display === 'none') openPop(); else closePop(); };
  // Selecting a date / clearing already sets pop.style.display = 'none' directly,
  // but make sure the outside listeners are detached in those cases too.
  pop.addEventListener('click', () => {
    if (pop.style.display === 'none') {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    }
  });
  wrap.append(trigger, pop);
  return { el: wrap, getValue: () => value };
}

function _todoInlineEditor(bucket, it) {
  const wrap = document.createElement('div'); wrap.className = 'todo-editor';
  const ta = document.createElement('textarea'); ta.className = 'kc-text'; ta.rows = 1; ta.placeholder = window.i18n.t('todo.new_task'); ta.value = it ? it.text : '';
  const meta = document.createElement('div'); meta.className = 'kc-meta';
  const datePicker = _buildDateField(it && it.due ? it.due : '');
  const alert = document.createElement('select'); alert.className = 'kc-alert';
  const curAlert = it ? String(it.alert || '') : '';
  const isCustom = curAlert !== '' && !ALERT_PRESETS.includes(curAlert);
  ALERT_OPTS.forEach(([v, k]) => { const o = document.createElement('option'); o.value = v; o.textContent = window.i18n.t(k); if (v === curAlert || (v === 'custom' && isCustom)) o.selected = true; alert.appendChild(o); });
  const customInp = document.createElement('input'); customInp.type = 'number'; customInp.min = '1'; customInp.className = 'kc-alert-custom';
  customInp.placeholder = window.i18n.t('todo.minutes_before'); customInp.style.display = isCustom ? '' : 'none';
  if (isCustom) customInp.value = curAlert;
  alert.addEventListener('change', () => { customInp.style.display = alert.value === 'custom' ? '' : 'none'; if (alert.value === 'custom') customInp.focus(); });
  meta.append(datePicker.el, alert, customInp);
  const actions = document.createElement('div'); actions.className = 'kc-actions';
  const save = document.createElement('button'); save.className = 'kc-save'; save.textContent = window.i18n.t('todo.save');
  const cancel = document.createElement('button'); cancel.className = 'kc-cancel'; cancel.textContent = window.i18n.t('common.cancel');
  actions.append(cancel, save);
  wrap.append(ta, meta, actions);
  const getAlert = () => alert.value === 'custom' ? (customInp.value ? String(parseInt(customInp.value, 10)) : '') : alert.value;
  const doSave = async () => {
    const text = ta.value.trim();
    if (!text) { renderTodoView(); return; }
    const av = getAlert();
    const dueVal = datePicker.getValue();
    if (it) await window.inkwell.todo.update(bucket, it.file, text, dueVal, av);
    else await window.inkwell.todo.create(bucket, text, dueVal, av);
    renderTodoView(); refreshTodoAlerts();
  };
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', () => renderTodoView());
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSave(); }
    else if (e.key === 'Escape') { e.preventDefault(); renderTodoView(); }
  });
  setTimeout(() => ta.focus(), 30);
  return wrap;
}

async function addTodo() {
  const wasOpen = _kanbanOpen;
  openTodoView();   // re-renders, clearing any stray open editor
  setTimeout(() => {
    const t = $('todo-add-row')?.querySelector('.todo-add-trigger');
    if (t && !document.querySelector('.todo-editor')) t.click();
  }, wasOpen ? 30 : 150);
}

// ── Notifiche ToDo (scadenze + avvisi) ─────────────────────────────────────
const TODO_MISSED_WINDOW_MS = 7 * 24 * 3600 * 1000;   // how far back a missed reminder still fires
let _todoAlertTimers = [];
// Every bucket the board has. 'tomorrow' was missing from the fallbacks and from both
// places that scan for deadlines, so a task moved to Tomorrow silently stopped being
// watched: no bell, no reminder, however overdue it was.
const TODO_ALERT_BUCKETS = ['today', 'tomorrow', 'upcoming'];   // 'done' never alerts
const _emptyTodoBuckets = () => ({ today: [], tomorrow: [], upcoming: [], done: [] });
let _todoCache = _emptyTodoBuckets();

function _todoFireKeySeen(key) {
  try { const s = JSON.parse(localStorage.getItem('amelie-todo-fired') || '[]'); return s.includes(key); } catch(_) { return false; }
}
function _todoMarkFired(key) {
  try { const s = JSON.parse(localStorage.getItem('amelie-todo-fired') || '[]'); s.push(key); localStorage.setItem('amelie-todo-fired', JSON.stringify(s.slice(-200))); } catch(_) {}
}

async function refreshTodoAlerts() {
  try { _todoCache = await window.inkwell.todo.list(); } catch(_) { _todoCache = _emptyTodoBuckets(); }
  _todoAlertTimers.forEach(t => clearTimeout(t)); _todoAlertTimers = [];
  const all = TODO_ALERT_BUCKETS.flatMap(b => _todoCache[b] || []);
  const now = Date.now();
  for (const it of all) {
    if (!it.due || it.alert === '' || it.alert == null) continue;
    const dueMs = new Date(it.due).getTime(); if (isNaN(dueMs)) continue;
    const fireAt = dueMs - parseInt(it.alert || '0', 10) * 60000;
    const key = it.file + '@' + it.due + '+' + it.alert;
    const delay = fireAt - now;
    if (delay > 0 && delay < 2147483647 && !_todoFireKeySeen(key)) {
      _todoAlertTimers.push(setTimeout(() => { _fireTodoNotif(it); _todoMarkFired(key); updateNotifBell(); }, delay));
    } else if (delay <= 0 && fireAt > now - TODO_MISSED_WINDOW_MS && !_todoFireKeySeen(key)) {
      // The moment passed while Amelie was closed. Say so once — the point of a reminder
      // is missed otherwise. Bounded to the last few days, so opening an old vault does
      // not fire a burst of ancient deadlines, and marked as fired so it stays once.
      _fireTodoNotif(it); _todoMarkFired(key);
    }
  }
  updateNotifBell();
}

function _fireTodoNotif(it) {
  try { new Notification('ToDo — ' + (it.title || ''), { body: window.i18n.t('todo.due') + ': ' + _fmtDue(it.due) }); } catch(_) {}
}

function _notifKey(it) { return it.file + '@' + it.due; }
function _notifDismissed() { try { return JSON.parse(localStorage.getItem('amelie-notif-dismissed') || '[]'); } catch(_) { return []; } }
function _dismissNotif(it) {
  try { const s = _notifDismissed(); s.push(_notifKey(it)); localStorage.setItem('amelie-notif-dismissed', JSON.stringify(s.slice(-300))); } catch(_) {}
}

function _dueTodos() {
  const now = Date.now(), soon = now + 24 * 3600 * 1000;
  const dis = _notifDismissed();
  return TODO_ALERT_BUCKETS.flatMap(b => _todoCache[b] || [])
    .filter(it => it.due)
    // A deadline that has ALREADY passed belongs in the bell whether or not a reminder
    // was set: the reminder says "warn me before", it does not decide whether an expired
    // task is worth knowing about. Still-to-come ones only show when asked for (a
    // reminder is set), so the bell doesn't turn into a list of everything scheduled.
    .filter(it => {
      const m = new Date(it.due).getTime();
      if (isNaN(m)) return false;
      if (m <= now) return true;                                  // overdue
      return m <= soon && it.alert !== '' && it.alert != null;     // due soon, reminder asked for
    })
    .filter(it => !dis.includes(_notifKey(it)))
    .sort((a, b) => new Date(a.due) - new Date(b.due));
}

// ── Event notifications (backup done, etc.) — shown in the bell with a time ──
let _eventNotifs = [];
let _eventUnread = 0;
// Event notifs auto-expire after 7 days so old logs (backup done, etc.) don't
// pile up forever — they're transient info, not something to keep indefinitely.
const NOTIF_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
function _loadEventNotifs() {
  try { _eventNotifs = JSON.parse(localStorage.getItem('amelie-event-notifs') || '[]'); } catch (_) { _eventNotifs = []; }
  // Drop entries older than the retention window (no ts → treat as old).
  const cut = Date.now() - NOTIF_MAX_AGE_MS;
  const before = _eventNotifs.length;
  _eventNotifs = _eventNotifs.filter(ev => ev && typeof ev.ts === 'number' && ev.ts >= cut);
  if (_eventNotifs.length !== before) _saveEventNotifs();
}
function _saveEventNotifs() {
  try { localStorage.setItem('amelie-event-notifs', JSON.stringify(_eventNotifs.slice(0, 30))); } catch (_) {}
}
// Clear the whole event-notification log at once (the "Svuota tutto" button).
function _clearAllEventNotifs() {
  _eventNotifs = [];
  _saveEventNotifs();
  updateNotifBell();
  if (_sidebarView === 'notifications') renderNotificationsView();
  const pop = $('notif-popup'); if (pop && pop.style.display !== 'none') toggleNotifPopup();
}
// "Clear all" as the user means it: mark everything currently listed as read, deadlines
// included. Coming back after a few days away, the bell holds every deadline that expired
// meanwhile, and dismissing them one by one is not a plan. Dismissing a deadline only
// silences the notification — the task itself stays on the board, untouched.
function _clearAllNotifs() {
  _dueTodos().forEach(it => _dismissNotif(it));
  _clearAllEventNotifs();          // also refreshes the bell / closes the popup
}
function _fmtNotifTime(ts) {
  try {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (_) { return ''; }
}
// Every backup / sync run reports here, from ONE place: the `sync:statusUpdate`
// event the main process emits. Doing it here rather than in each button handler
// is what keeps a manual backup from being logged twice (once by the button,
// once by the event) and is why automatic runs get logged at all — nothing in
// the renderer knows they happened otherwise.
//
// Scheduled backups that find the vault unchanged return early WITHOUT touching
// the status, so an idle vault never fills the bell with identical lines.
function logSyncEventNotif(data) {
  if (!data || !data.op) return;                       // untagged/legacy event
  if (data.status !== 'ok' && data.status !== 'error') return;   // 'syncing'/'idle' aren't outcomes
  const key = data.manual ? 'manual' : 'auto';
  const label = window.i18n.t(`notif.${data.op}_${key}`);
  if (data.status === 'ok') {
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    addEventNotif(`${label} (${p2(d.getHours())}:${p2(d.getMinutes())})`, true);
  } else {
    addEventNotif(`${label}: ${data.error || window.i18n.t('notif.unknown_error')}`, false);
  }
}

// Add an event notification (e.g. "Backup completato") to the bell.
function addEventNotif(text, ok = true) {
  _eventNotifs.unshift({ text, ts: Date.now(), ok: !!ok });
  _eventNotifs = _eventNotifs.slice(0, 30);
  _eventUnread++;
  _saveEventNotifs();
  updateNotifBell();
  if (_sidebarView === 'notifications') renderNotificationsView();
}
function _markEventNotifsRead() { if (_eventUnread) { _eventUnread = 0; updateNotifBell(); } }

function updateNotifBell() {
  const badge = $('notif-badge'); if (!badge) return;
  const n = _dueTodos().length + _eventUnread;
  badge.textContent = n; badge.style.display = n ? '' : 'none';
  $('btn-notifications')?.classList.toggle('has-notif', n > 0);
  // Keep the notifications sidebar view fresh if it's the one showing.
  if (_sidebarView === 'notifications') renderNotificationsView();
}

let _notifToggleTs = 0;
function toggleNotifPopup() {
  const pop = $('notif-popup'); if (!pop) return;
  // The button is in a drag zone (.sst): pointerup→click + native click can
  // arrive together. Ignore the second one within 280ms to avoid reopen/reclose.
  const t = (performance && performance.now) ? performance.now() : Date.now();
  if (t - _notifToggleTs < 280) return;
  _notifToggleTs = t;
  if (pop.style.display !== 'none') { pop.style.display = 'none'; return; }
  const list = $('notif-popup-list'); list.innerHTML = '';
  const items = _dueTodos();
  if (!items.length && !_eventNotifs.length) { list.innerHTML = `<div class="notif-empty">${window.i18n.t('todo.no_due')}</div>`; }
  if (items.length || _eventNotifs.length) {
    const bar = document.createElement('div'); bar.className = 'notif-clear-bar';
    const clr = document.createElement('button'); clr.className = 'notif-clear-all';
    clr.textContent = window.i18n.t('notif.clear_all');
    clr.addEventListener('click', (e) => { e.stopPropagation(); _clearAllNotifs(); });
    bar.appendChild(clr); list.appendChild(bar);
  }
  // Event notifications (backup done, etc.) — newest first, with their time.
  _eventNotifs.forEach(ev => {
    const row = document.createElement('div'); row.className = 'notif-row';
    const info = document.createElement('div'); info.className = 'notif-row-info';
    info.innerHTML = `<div class="notif-row-title">${ev.ok ? '✓' : '✗'} ${escHtml(ev.text)}</div><div class="notif-row-due">${_fmtNotifTime(ev.ts)}</div>`;
    const dis = document.createElement('button'); dis.className = 'notif-dismiss'; dis.textContent = '×'; dis.title = window.i18n.t('todo.dismiss');
    dis.addEventListener('click', e => {
      e.stopPropagation(); _eventNotifs = _eventNotifs.filter(x => x !== ev); _saveEventNotifs(); updateNotifBell(); row.remove();
      if (!list.querySelector('.notif-row')) list.innerHTML = `<div class="notif-empty">${window.i18n.t('todo.no_due')}</div>`;
    });
    row.append(info, dis);
    list.appendChild(row);
  });
  items.forEach(it => {
    const row = document.createElement('div'); row.className = 'notif-row' + (_isOverdue(it.due) ? ' overdue' : '');
    const info = document.createElement('div'); info.className = 'notif-row-info';
    info.innerHTML = `<div class="notif-row-title">${escHtml(it.title || '')}</div><div class="notif-row-due">🔔 ${_fmtDueDMY(it.due)}</div>`;
    info.addEventListener('click', () => { $('notif-popup').style.display = 'none'; openTodoView(); });
    const dis = document.createElement('button'); dis.className = 'notif-dismiss'; dis.textContent = '×'; dis.title = window.i18n.t('todo.dismiss');
    dis.addEventListener('click', e => {
      e.stopPropagation(); _dismissNotif(it); updateNotifBell(); row.remove();
      if (!list.querySelector('.notif-row')) list.innerHTML = `<div class="notif-empty">${window.i18n.t('todo.no_due')}</div>`;
    });
    row.append(info, dis);
    list.appendChild(row);
  });
  _markEventNotifsRead();
  const btn = $('btn-notifications'); const r = btn.getBoundingClientRect();
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.left = Math.max(8, r.left - 4) + 'px';
  pop.style.right = 'auto';
  pop.style.display = 'block';
}

// Opening or creating a note (or any file) while a non-Files sidebar view is
// showing (Recent / Bookmarks / Tags / Notifications) returns the sidebar to
// Files — so the user just sees the note + the tree, not the list they came from.
function _returnToFilesView() {
  if (_sidebarView !== 'files') switchSidebarView('files');
}

function switchSidebarView(view) {
  _sidebarView = view;
  // If we were in the ToDo (kanban) view, leave it and restore the editor /
  // empty-state in the main area so the sidebar tabs (Files, Recent, …) bring
  // the user back to their notes.
  if (_kanbanOpen) {
    const hadTab = tabs.some(t => t.type === 'todo');
    closeKanban();
    // With a board tab, closeKanban already lands on the right note — switching again here
    // would race it and could hand you a different tab.
    if (hadTab) { /* handled by closeKanban */ }
    else if (activeTabIdx >= 0 && tabs[activeTabIdx]) {
      switchTab(activeTabIdx);
    } else {
      const es = $('empty-state'); if (es) es.style.display = 'flex';
      const ec = $('editor-container'); if (ec) ec.style.display = 'none';
    }
  }
  const map = { files: 'section-notes', recent: 'section-recent', bookmarks: 'section-bookmarks', tags: 'section-tags', notifications: 'section-notifications' };
  Object.entries(map).forEach(([v, id]) => { const el = $(id); if (el) el.style.display = (v === view) ? 'flex' : 'none'; });
  const oldTodo = $('section-todo'); if (oldTodo) oldTodo.style.display = 'none';
  document.querySelectorAll('#sidebar-section-tabs .sst').forEach(b => b.classList.remove('active'));
  const bid = { files: 'view-files', recent: 'view-recent', bookmarks: 'view-bookmarks', tags: 'view-tags', notifications: 'btn-notifications' }[view];
  if (bid && $(bid)) $(bid).classList.add('active');
  if (view === 'recent') renderRecentView();
  else if (view === 'bookmarks') renderBookmarksView();
  else if (view === 'tags') renderTagsView();
  else if (view === 'notifications') renderNotificationsView();
}

// Notifications as a sidebar view (like Bookmarks/Tags) — no separate popup.
function renderNotificationsView() {
  const c = $('notifications-list'); if (!c) return; c.innerHTML = '';
  const items = _dueTodos();
  // "Clear all" — mark everything shown as read, deadlines included (it used to appear
  // only when there were backup/sync events, so a screen full of expired deadlines had
  // no way out but one × at a time).
  if (_eventNotifs.length || items.length) {
    const bar = document.createElement('div'); bar.className = 'notif-clear-bar';
    const btn = document.createElement('button'); btn.className = 'notif-clear-all';
    btn.textContent = window.i18n.t('notif.clear_all');
    btn.addEventListener('click', () => _clearAllNotifs());
    bar.appendChild(btn); c.appendChild(bar);
  }
  // Event notifications (backup done, etc.) first, with their time.
  _eventNotifs.forEach(ev => {
    const row = document.createElement('div'); row.className = 'simple-row notif-row';
    const info = document.createElement('div'); info.className = 'simple-main';
    info.innerHTML = `<div class="simple-name">${ev.ok ? '✓' : '✗'} ${escHtml(ev.text)}</div><div class="simple-sub">${_fmtNotifTime(ev.ts)}</div>`;
    const dis = document.createElement('button'); dis.className = 'simple-remove'; dis.textContent = '×'; dis.title = window.i18n.t('todo.dismiss');
    dis.addEventListener('click', e => { e.stopPropagation(); _eventNotifs = _eventNotifs.filter(x => x !== ev); _saveEventNotifs(); updateNotifBell(); renderNotificationsView(); });
    row.append(info, dis);
    c.appendChild(row);
  });
  _markEventNotifsRead();
  if (!items.length) { return; }   // only event notifs (or nothing)
  items.forEach(it => {
    const row = document.createElement('div'); row.className = 'simple-row notif-row' + (_isOverdue(it.due) ? ' overdue' : '');
    const info = document.createElement('div'); info.className = 'simple-main';
    info.innerHTML = `<div class="simple-name">${escHtml(it.title || '')}</div><div class="simple-sub">🔔 ${_fmtDueDMY(it.due)}</div>`;
    info.addEventListener('click', () => openTodoView());
    const dis = document.createElement('button'); dis.className = 'simple-remove'; dis.textContent = '×'; dis.title = window.i18n.t('todo.dismiss');
    dis.addEventListener('click', e => { e.stopPropagation(); _dismissNotif(it); updateNotifBell(); renderNotificationsView(); });
    row.append(info, dis);
    c.appendChild(row);
  });
}

async function migrateLocalTodos() {
  try {
    if (localStorage.getItem('amelie-todos-migrated')) return;
    const old = JSON.parse(localStorage.getItem('amelie-tasks') || '[]');
    for (const t of old) {
      const text = ((t.name || '') + (t.notes ? '\n\n' + t.notes : '')).trim();
      if (!text) continue;
      const bucket = t.done ? 'done' : (t.due && new Date(t.due).getTime() > Date.now() + 24 * 3600 * 1000) ? 'upcoming' : 'today';
      await window.inkwell.todo.create(bucket, text);
    }
    localStorage.setItem('amelie-todos-migrated', '1');
  } catch(_) {}
}

function setupSidebarViews() {
  // Files icon is a pure toggle: in the ToDo board → back to notes; otherwise
  // → open the ToDo board. Guarded against the double-trigger that can happen
  // on .sst buttons (native click + synthesized click from the drag handler):
  // ignore a second activation within 280ms.
  let _filesToggleTs = 0;
  $('view-files')?.addEventListener('click', () => {
    const t = (performance && performance.now) ? performance.now() : Date.now();
    if (t - _filesToggleTs < 280) return;
    _filesToggleTs = t;
    // Decide from the ACTUAL DOM (robust to any stale state): are we currently
    // showing the Files/notes section?
    const notes = $('section-notes');
    const onFilesView = !!notes && getComputedStyle(notes).display !== 'none';
    if (_kanbanOpen || !onFilesView) {
      // In the ToDo board, or in another sidebar view (Notifications/Recent/…)
      // → go straight to Files (notes).
      switchSidebarView('files');
    } else {
      // Already on the Files view → toggle into the ToDo board.
      openTodoView();
    }
  });
  $('view-recent')?.addEventListener('click', () => switchSidebarView('recent'));
  $('view-bookmarks')?.addEventListener('click', () => switchSidebarView('bookmarks'));
  $('view-tags')?.addEventListener('click', () => switchSidebarView('tags'));
  $('btn-new-todo')?.addEventListener('click', () => {
    // Toggle: if the ToDo board is already open, a second click returns to the
    // notes (restores the editor), matching the Files-icon toggle.
    if (_kanbanOpen) { switchSidebarView('files'); return; }
    addTodo();
  });
  $('ctx-bookmark')?.addEventListener('click', () => { if (state.contextTarget) toggleBookmark(state.contextTarget); const m = $('context-menu'); if (m) m.style.display = 'none'; });
  document.querySelectorAll('.tv-filter').forEach(b => b.addEventListener('click', () => setTodoFilter(b.dataset.f)));
  // Notifications behave like Bookmarks/Tags: open the sidebar view, no popup.
  $('btn-notifications')?.addEventListener('click', e => { e.stopPropagation(); switchSidebarView('notifications'); });
  _loadEventNotifs();   // restore backup/event notifications
  migrateLocalTodos().then(() => refreshTodoAlerts()).catch(() => { refreshTodoAlerts(); });
}

function setupTodo() {
  loadTasks();

  // (the old Notes/Todo tabs have been replaced by the view icons)
  $('btn-add-task')?.addEventListener('click', () => openTaskModal());

  // Filters
  document.querySelectorAll('.todo-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      todoFilter = btn.dataset.filter;
      document.querySelectorAll('.todo-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTodoList();
    });
  });

  // Modal
  $('task-modal-close').addEventListener('click',  closeTaskModal);
  $('task-modal-backdrop').addEventListener('click', closeTaskModal);
  $('task-modal-cancel').addEventListener('click',  closeTaskModal);
  $('task-modal-save').addEventListener('click',   saveTask);
  $('task-modal-delete').addEventListener('click', deleteCurrentTask);

  // Enter to save
  $('task-name-input').addEventListener('keydown', e => { if (e.key === 'Enter') saveTask(); });

  renderTodoList();
  scheduleAllNotifications();
}

function switchSidebarSection(section) {
  $('section-notes').style.display  = section === 'notes' ? 'flex' : 'none';
  $('section-todo').style.display   = section === 'todo'  ? 'flex' : 'none';
  $('sst-notes').classList.toggle('active', section === 'notes');
  $('sst-todo').classList.toggle('active',  section === 'todo');
}

// ── Task modal ──────────────────────────────────────────────────────────────

function openTaskModal(task = null) {
  taskEditId = task ? task.id : null;
  $('task-modal-title').textContent = task ? window.i18n.t('todo.edit_task') : window.i18n.t('todo.new_task');
  $('task-name-input').value   = task?.name   || '';
  $('task-notes-input').value  = task?.notes  || '';
  $('task-due-input').value    = task?.due    ? toLocalInputValue(task.due) : '';
  $('task-alert-input').value  = task?.alert  != null ? String(task.alert) : '';
  $('task-modal-delete').style.display = task ? 'block' : 'none';
  $('task-modal').style.display = 'flex';
  setTimeout(() => $('task-name-input').focus(), 50);
}

function closeTaskModal() {
  $('task-modal').style.display = 'none';
  taskEditId = null;
}

function saveTask() {
  const name = $('task-name-input').value.trim();
  if (!name) { $('task-name-input').focus(); return; }

  const dueVal   = $('task-due-input').value;
  const alertVal = $('task-alert-input').value;

  if (taskEditId) {
    const task = tasks.find(t => t.id === taskEditId);
    if (task) {
      task.name  = name;
      task.notes = $('task-notes-input').value.trim();
      task.due   = dueVal ? new Date(dueVal).toISOString() : null;
      task.alert = alertVal !== '' ? parseInt(alertVal) : null;
    }
  } else {
    tasks.push({
      id:    genTaskId(),
      name,
      notes: $('task-notes-input').value.trim(),
      due:   dueVal ? new Date(dueVal).toISOString() : null,
      alert: alertVal !== '' ? parseInt(alertVal) : null,
      done:  false,
      created: new Date().toISOString(),
    });
  }

  saveTasks();
  renderTodoList();
  scheduleAllNotifications();
  closeTaskModal();
}

async function deleteCurrentTask() {
  if (!taskEditId) return;
  if (!await showConfirmModal(window.i18n.t('confirm.delete_task'))) return;
  tasks = tasks.filter(t => t.id !== taskEditId);
  saveTasks();
  renderTodoList();
  closeTaskModal();
}

function toggleTaskDone(id) {
  const task = tasks.find(t => t.id === id);
  if (task) { task.done = !task.done; saveTasks(); renderTodoList(); }
}

// ── Render ──────────────────────────────────────────────────────────────────

function renderTodoList() {
  const list = $('todo-list');
  const now  = new Date();

  const filtered = tasks.filter(t => {
    if (todoFilter === 'done')     return t.done;
    if (todoFilter === 'all')      return !t.done;
    if (todoFilter === 'today') {
      if (t.done || !t.due) return false;
      const d = new Date(t.due);
      return d.toDateString() === now.toDateString();
    }
    if (todoFilter === 'upcoming') {
      if (t.done || !t.due) return false;
      const d = new Date(t.due);
      return d > now && d.toDateString() !== now.toDateString();
    }
    return true;
  });

  // Sort: overdue first, then by due date, then no-due last
  filtered.sort((a, b) => {
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return new Date(a.due) - new Date(b.due);
  });

  // (badge now handled by renderTodoVaultView on the vault todos)

  if (filtered.length === 0) {
    list.innerHTML = `<div class="todo-empty">${escHtml(window.i18n.t(todoFilter !== 'all' ? 'todo.empty_category' : 'todo.empty'))}</div>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(task => {
    const item = document.createElement('div');
    const dueInfo = getDueInfo(task.due, now);
    item.className = 'todo-item' + (task.done ? ' done' : '') + (dueInfo.cls ? ' ' + dueInfo.cls : '');

    const check = document.createElement('div');
    check.className = 'todo-check';
    check.addEventListener('click', e => { e.stopPropagation(); toggleTaskDone(task.id); });

    const content = document.createElement('div');
    content.className = 'todo-content';

    const nameEl = document.createElement('div');
    nameEl.className = 'todo-name';
    nameEl.textContent = task.name;

    content.appendChild(nameEl);

    if (task.due) {
      const dueEl = document.createElement('div');
      dueEl.className = 'todo-due ' + dueInfo.cls;
      dueEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>${dueInfo.label}`;
      content.appendChild(dueEl);
    }

    item.appendChild(check);
    item.appendChild(content);
    item.addEventListener('click', () => openTaskModal(task));
    list.appendChild(item);
  });
}

function getDueInfo(due, now) {
  if (!due) return { cls: '', label: '' };
  const d = new Date(due);
  const isToday    = d.toDateString() === now.toDateString();
  const isOverdue  = d < now && !isToday;
  const diff       = d - now;
  const diffDays   = Math.ceil(diff / 86400000);

  const loc = window.i18n.getCurrentLang() === 'en' ? 'en-US' : 'it-IT';
  if (isOverdue)  return { cls: 'due-overdue', label: window.i18n.t('due.overdue', { rel: formatRelDate(d, now) }) };
  if (isToday)    return { cls: 'due-today',   label: window.i18n.t('due.today', { time: d.toLocaleTimeString(loc, { hour:'2-digit', minute:'2-digit' }) }) };
  if (diffDays === 1) return { cls: 'due-normal', label: window.i18n.t('due.tomorrow') };
  if (diffDays < 7)   return { cls: 'due-normal', label: window.i18n.t('due.in_days', { n: diffDays }) };
  return { cls: 'due-normal', label: d.toLocaleDateString(loc, { day:'numeric', month:'short' }) };
}

function formatRelDate(d, now) {
  const loc = window.i18n.getCurrentLang() === 'en' ? 'en-US' : 'it-IT';
  const diffMs   = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs  = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHrs / 24);
  if (diffMins < 60)  return window.i18n.t('rel.mins_ago', { n: diffMins });
  if (diffHrs  < 24)  return window.i18n.t('rel.hours_ago', { n: diffHrs });
  if (diffDays < 7)   return window.i18n.t('rel.days_ago', { n: diffDays });
  return d.toLocaleDateString(loc, { day:'numeric', month:'short' });
}

function toLocalInputValue(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Notifications ───────────────────────────────────────────────────────────

function scheduleAllNotifications() {
  Object.values(notifTimers).forEach(clearTimeout);
  notifTimers = {};
  const now = Date.now();
  tasks.filter(t => !t.done && t.due && t.alert != null).forEach(t => {
    const fireAt = new Date(t.due).getTime() - t.alert * 60000;
    const delay  = fireAt - now;
    if (delay > 0 && delay < 7 * 24 * 3600000) { // max 7 days ahead
      notifTimers[t.id] = setTimeout(() => fireNotification(t), delay);
    }
  });
}

function fireNotification(task) {
  // Electron notification via browser Notification API (allowed in renderer)
  if (Notification.permission === 'granted') {
    const n = new Notification('Amelie — ' + task.name, {
      body: task.notes || window.i18n.t('todo.due') + ': ' + new Date(task.due).toLocaleString(window.i18n.getCurrentLang() === 'en' ? 'en-US' : 'it-IT'),
      icon: '../assets/icon.png',
    });
    n.onclick = () => { switchSidebarSection('todo'); renderTodoList(); };
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') fireNotification(task);
    });
  }
  // Also show in-app toast
  showToast(`⏰ ${task.name}`);
  renderTodoList();
}

// Request notification permission on startup
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  Notification.requestPermission();
}

// Boot
init();
