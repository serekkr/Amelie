// Amelie ↔ CodeMirror 6 bridge. Bundled to src/renderer/vendor/cm.bundle.js
// (see `npm run build:cm`). Exposes a small, textarea-like API on window.AmelieCM
// so app.js can drive CodeMirror without importing ESM modules directly.
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment, Transaction, RangeSetBuilder, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, deleteCharBackward, deleteCharForward } from '@codemirror/commands';
import { StringStream } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { python } from '@codemirror/legacy-modes/mode/python';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { sql } from '@codemirror/legacy-modes/mode/sql';

// NOTE: the markdown language / whole-doc syntax highlighting is deliberately NOT used
// — that Lezer parser was the sole O(doc)-per-keystroke cost, and outside code blocks
// the source stays PLAIN (formatting is seen only in view/preview mode). INSIDE fenced
// code blocks we DO colour the code, but with cheap per-LINE stream tokenizers
// (@codemirror/legacy-modes) driven manually over ONLY the visible code lines — so the
// cost is O(viewport), never O(doc). Language is chosen by the fence's tag (```bash …).

// ── Code-block grey masks (virtualized: only visible lines decorated) ──────────
const cbLine  = Decoration.line({ class: 'cm-codeblock' });
const cbFirst = Decoration.line({ class: 'cm-codeblock cm-cb-first' });
const cbLast  = Decoration.line({ class: 'cm-codeblock cm-cb-last' });

// Detect ``` / ~~~ fenced blocks by a simple LINE SCAN (same rule as Amelie's
// legacy editor) — NOT the markdown syntax tree, whose semantic parse greys the
// wrong regions when fences are indented inside lists. Whole-doc scan is O(lines)
// of cheap regex (no DOM/layout), recomputed only when the doc changes.
const FENCE_RE = /^\s*(```|~~~)/;
// Collect the line-START positions of every fence line whose line intersects
// [fromPos, toPos]. We track POSITIONS (not line numbers) so the list can be mapped
// through document changes incrementally — line numbers shift when lines are
// inserted/deleted above, positions map cleanly via ChangeSet.mapPos.
function scanFencePositions(doc, fromPos, toPos) {
  const first = doc.lineAt(fromPos).number, last = doc.lineAt(toPos).number, out = [];
  for (let ln = first; ln <= last; ln++) { const l = doc.line(ln); if (FENCE_RE.test(l.text)) out.push(l.from); }
  return out;
}
// Full-document fence scan — used ONLY for the initial build (O(lines), once).
function scanFences(view) { return scanFencePositions(view.state.doc, 0, view.state.doc.length); }
// Incrementally update the sorted fence-position list after a doc change: keep every
// fence OUTSIDE the edited ranges (shifted to new coords via mapPos), and re-scan only
// the lines the edit actually touched. This is O(fences + changed lines) per keystroke
// instead of O(whole doc) — the old whole-doc rescan made typing on multi-MB notes
// scale linearly with size (v1.0.986 QA: ~200ms/keystroke at 2MB). Correctness is
// identical: the mask decorations still derive from the exact same fence set.
function updateFencePositions(oldPos, changes, newDoc) {
  const changedOld = [], rescanned = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    changedOld.push([fromA, toA]);
    for (const p of scanFencePositions(newDoc, newDoc.lineAt(fromB).from, newDoc.lineAt(toB).to)) rescanned.push(p);
  });
  const out = [];
  for (const p of oldPos) {
    let touched = false;
    for (const r of changedOld) { if (p >= r[0] && p <= r[1]) { touched = true; break; } }
    if (!touched) out.push(changes.mapPos(p, -1));   // outside the edit → just shift
  }
  for (const p of rescanned) out.push(p);
  out.sort((a, b) => a - b);
  const dedup = [];                                   // a boundary fence can appear in both sets
  for (let i = 0; i < out.length; i++) { if (i === 0 || out[i] !== out[i - 1]) dedup.push(out[i]); }
  return dedup;
}
// Build the grey-mask decorations by pairing consecutive fences.
// KEY: an ODD number of fences means a block is being typed (one fence still
// open). Pairing greedily top-down would marry that new opening fence to the
// NEXT existing block's fence and grey the normal text between them ("mask
// appears while I type ```"). So when odd, we DROP the fence nearest the caret
// (the one being typed) and pair the rest — the half-typed block masks nothing
// until you close it.
function buildDeco(view, fencePositions) {
  const doc = view.state.doc;
  const builder = new RangeSetBuilder();
  // fencePositions is a sorted list of line-start positions → line numbers (cheap:
  // O(fences · log lines), fences are few even in code-heavy notes).
  let list = fencePositions.map((p) => doc.lineAt(p).number);
  if (list.length % 2 === 1) {
    const curLine = doc.lineAt(view.state.selection.main.head).number;
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = Math.abs(list[i] - curLine);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    list = list.slice(0, bestIdx).concat(list.slice(bestIdx + 1));
  }
  for (let i = 0; i + 1 < list.length; i += 2) {
    const s = list[i], e = list[i + 1];
    for (let k = s; k <= e; k++) {
      const l = doc.line(k);
      builder.add(l.from, l.from, k === s ? cbFirst : k === e ? cbLast : cbLine);
    }
  }
  return builder.finish();
}

// Dedent every fenced code block in a string to column 0 (removing the opening
// fence's indent from each line of the block, relative indent preserved). Pasted
// markdown often nests code under lists (4+ spaces), which pushed the code far
// right inside the grey mask — normalizing makes pasted blocks look like manual
// ones (which start at col 0 + the 2-char CSS padding).
function dedentCodeBlocks(text) {
  const lines = text.split('\n');
  const out = lines.slice();
  // Convert leading TABS to 2 spaces (pasted code often has "  \t```", which
  // rendered far right). Then dedent by the opening fence's leading-space count.
  const detab = (s) => s.replace(/^[ \t]+/, (w) => w.replace(/\t/g, '  '));
  let i = 0;
  while (i < lines.length) {
    if (/^[ \t]*(```|~~~)/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^[ \t]*(```|~~~)/.test(lines[j])) j++;
      if (j < lines.length) {
        const base = detab(lines[i]).match(/^ */)[0].length;
        const re = new RegExp('^ {0,' + base + '}');
        for (let k = i; k <= j; k++) out[k] = detab(lines[k]).replace(re, '');
        i = j + 1;
      } else i++;
    } else i++;
  }
  return out.join('\n');
}

// ── Smart paste: convert clipboard HTML → Markdown ────────────────────────────
// Sources that render markdown (Obsidian reading mode, web pages, GitHub rendered)
// put FLATTENED text in text/plain (newlines lost) but structured HTML in text/html.
// When the plain text looks flattened, we rebuild real markdown from the HTML.
function inlineNode(c) {
  if (c.nodeType === 3) return c.textContent.replace(/\s+/g, ' ');
  if (c.nodeType !== 1) return '';
  const tag = c.tagName.toLowerCase();
  if (tag === 'br') return '\n';
  if (tag === 'strong' || tag === 'b') return '**' + mdInline(c).trim() + '**';
  if (tag === 'em' || tag === 'i') return '*' + mdInline(c).trim() + '*';
  if (tag === 'code') return '`' + c.textContent + '`';
  if (tag === 'a') { const h = c.getAttribute('href') || ''; const t = mdInline(c).trim(); return h ? '[' + t + '](' + h + ')' : t; }
  if (tag === 'del' || tag === 's') return '~~' + mdInline(c).trim() + '~~';
  return mdInline(c);
}
function mdInline(node) {
  let out = '';
  node.childNodes.forEach((c) => { out += inlineNode(c); });
  return out;
}
function mdBlocks(node, indent) {
  indent = indent || '';
  const parts = [];
  node.childNodes.forEach((c) => {
    if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, ' ').trim(); if (t) parts.push(indent + t); return; }
    if (c.nodeType !== 1) return;
    const tag = c.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) parts.push(indent + '#'.repeat(+tag[1]) + ' ' + mdInline(c).trim());
    else if (tag === 'p') parts.push(indent + mdInline(c).trim());
    else if (tag === 'br') { /* handled inline */ }
    else if (tag === 'hr') parts.push(indent + '---');
    else if (tag === 'blockquote') parts.push(mdBlocks(c, indent + '> '));
    else if (tag === 'pre') {
      const code = c.textContent.replace(/\n$/, '');
      parts.push(indent + '```\n' + code.split('\n').map((l) => indent + l).join('\n') + '\n' + indent + '```');
    }
    else if (tag === 'ul' || tag === 'ol') {
      const items = [];
      let n = 1;
      c.childNodes.forEach((li) => {
        if (li.nodeType === 1 && li.tagName.toLowerCase() === 'li') {
          const marker = tag === 'ol' ? (n++ + '. ') : '- ';
          // Split the li into its inline part (rendered as ONE inline run so bold/
          // links/code survive) and any nested lists (indented under it).
          const nested = [];
          let inline = '';
          li.childNodes.forEach((x) => {
            if (x.nodeType === 1 && /^(ul|ol)$/.test(x.tagName.toLowerCase())) nested.push(mdBlocks(x, indent + '  '));
            else inline += inlineNode(x);   // no cloneNode → no O(n²) on big lists
          });
          items.push(indent + marker + inline.trim());
          nested.forEach((nx) => items.push(nx));
        }
      });
      if (items.length) parts.push(items.join('\n'));   // list rows are consecutive, not double-spaced
    }
    else if (tag === 'table') {
      const rows = [];
      c.querySelectorAll('tr').forEach((tr) => {
        const cells = [];
        // Escape the escape char (\) BEFORE the pipe, so content like "a\|b"
        // can't leak an un-escaped pipe that breaks the table column.
        tr.querySelectorAll('th,td').forEach((td) => cells.push(mdInline(td).trim().replace(/\\/g, '\\\\').replace(/\|/g, '\\|')));
        rows.push('| ' + cells.join(' | ') + ' |');
      });
      if (rows.length) {
        const ncol = (rows[0].match(/\|/g) || []).length - 1;
        rows.splice(1, 0, '| ' + Array(ncol).fill('---').join(' | ') + ' |');
        parts.push(indent + rows.join('\n' + indent));
      }
    }
    else parts.push(mdBlocks(c, indent));
  });
  return parts.filter((p) => p !== '').join('\n\n');
}
function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return mdBlocks(doc.body, '').replace(/\n{3,}/g, '\n\n').trim();
}
// Heuristic: is the plain text "flattened" relative to the HTML's block structure?
function looksFlattened(text, html) {
  const nl = (text.match(/\n/g) || []).length;
  const blocks = (html.match(/<(p|li|tr|h[1-6]|pre|blockquote|div)[\s>]/gi) || []).length;
  return blocks >= 3 && nl < blocks * 0.5;
}

// Intercept paste: prefer rebuilding markdown from HTML when the plain text is
// flattened; otherwise just normalize fenced-block indentation in the plain text.
const pasteNormalize = EditorView.domEventHandlers({
  paste(event, view) {
    const cd = event.clipboardData;
    if (!cd) return false;
    const text = cd.getData('text/plain') || '';
    const html = cd.getData('text/html') || '';
    // Keep the plain text even when this handler declines and lets the browser paste: if
    // that native paste comes back as a mis-read and the firewall refuses it, this is the
    // only copy left to put back. Capped so a giant clipboard is not held onto.
    _lastClipboardText = text.length <= 2000000 ? text : '';
    let insert = null;
    // Rebuild markdown from the structured HTML when the plain text is flattened.
    // Cap is generous (4 MB): the walk is O(n) since the cloneNode O(n²) was removed,
    // so even a big rendered doc converts in ~100-200ms. The OLD 80KB cap made any
    // note over a few hundred lines fall back to the FLATTENED text/plain (newlines
    // lost → the whole paste collapsed onto a few mega-long lines).
    if (html && html.length < 4000000 && looksFlattened(text, html)) {
      try { const md = htmlToMarkdown(html); if (md) insert = dedentCodeBlocks(md); } catch (_) {}
    }
    if (insert == null) {
      if (!text || !/(^|\n)[ \t]*(```|~~~)/.test(text)) return false;   // nothing special to do
      const fixed = dedentCodeBlocks(text);
      if (fixed === text) return false;
      insert = fixed;
    }
    event.preventDefault();
    const _t0 = performance.now();
    const spec = view.state.replaceSelection(insert);
    view.dispatch({ ...spec, annotations: Transaction.userEvent.of('input.paste'), scrollIntoView: true });
    try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('PASTE handler ' + Math.round(performance.now() - _t0) + 'ms insertLen=' + insert.length + ' htmlLen=' + html.length + ' path=' + (html && html.length < 4000000 && looksFlattened(text, html) ? 'html' : 'text')); } catch (_) {}
    return true;
  },
});

// Enter at the end of a lone OPENING fence (``` / ~~~) with no closer below
// auto-inserts the matching closing fence and drops the caret on the empty
// middle line — same as Amelie's legacy editor (handleFenceEnterIndent), so a
// code block forms "by itself" and its grey mask appears without typing 2 fences.
const fenceEnter = {
  key: 'Enter',
  run(view) {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty) return false;
    const line = state.doc.lineAt(sel.head);
    if (sel.head !== line.to) return false;               // caret must be at line end
    const m = line.text.match(/^(\s*)(```|~~~)/);
    if (!m) return false;                                 // not a fence line
    // Only an OPENING fence (even number of fences before it). Without this,
    // Enter at the end of a CLOSING fence looks like "opening with no closer" and
    // wrongly appends another block.
    let fencesBefore = 0;
    for (let ln = 1; ln < line.number; ln++) if (FENCE_RE.test(state.doc.line(ln).text)) fencesBefore++;
    if (fencesBefore % 2 !== 0) return false;             // this is a CLOSING fence
    const below = state.doc.sliceString(line.to);
    if (/\n[ \t]*(```|~~~)/.test(below)) return false;    // a closer already exists below
    const indent = m[1], fence = m[2];
    const insert = '\n' + indent + '\n' + indent + fence;
    const midPos = line.to + 1 + indent.length;           // end of the empty middle line
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: midPos },
      annotations: Transaction.userEvent.of('input'),
      scrollIntoView: true,
    });
    return true;
  },
};

// Auto-close a fence the moment you type the 3rd backtick (no Enter needed) —
// mirrors the legacy editor's `beforeinput` handler. Typing "`" right after "``"
// at the end of a line (and not already inside a block) replaces the "``" with a
// complete empty block and drops the caret on the middle line.
// Typing the 3rd backtick at the end of a lone "``" line auto-expands it to a full
// ```\n\n``` block with the caret on the empty middle line. Factored into a plain
// function so BOTH the normal inputHandler AND the big-doc beforeinput fix (which
// bypasses CM's input path) can trigger it. Returns true if it handled the fence.
function tryFenceAutoClose(view, from, to, text) {
  if (text !== '`') return false;
  const { state } = view;
  const line = state.doc.lineAt(from);
  if (to !== line.to) return false;                          // caret must be at line end
  const m = line.text.slice(0, from - line.from).match(/^(\s*)``$/);
  if (!m) return false;                                      // not exactly "<indent>``"
  let fencesBefore = 0;                                      // even ⇒ not inside a block
  for (let ln = 1; ln < line.number; ln++) if (FENCE_RE.test(state.doc.line(ln).text)) fencesBefore++;
  if (fencesBefore % 2 !== 0) return false;
  const indent = m[1];
  const fenceStart = line.from + indent.length;              // start of the "``"
  const block = indent + '```\n' + indent + '\n' + indent + '```';
  const midPos = fenceStart + 2 * indent.length + 4;         // end of the empty middle line
  view.dispatch({
    changes: { from: fenceStart, to: from, insert: block },
    selection: { anchor: midPos },
    annotations: Transaction.userEvent.of('input'),
    scrollIntoView: true,
  });
  return true;
}
const fenceAutoClose = EditorView.inputHandler.of((view, from, to, text) => tryFenceAutoClose(view, from, to, text));

// ── In-note search highlighting ───────────────────────────────────────────────
const setSearchQ = StateEffect.define();
const searchHit = Decoration.mark({ class: 'cm-search-hit' });
const searchCur = Decoration.mark({ class: 'cm-search-hit cm-search-current' });
function buildSearchDeco(state, q, current) {
  if (!q) return Decoration.none;
  const b = new RangeSetBuilder();
  const query = q.toLowerCase();
  const text = state.doc.toString().toLowerCase();
  let i = 0;
  while ((i = text.indexOf(query, i)) !== -1) {
    b.add(i, i + query.length, i === current ? searchCur : searchHit);
    i += query.length;
  }
  return b.finish();
}
const searchField = StateField.define({
  create() { return { q: '', current: -1, deco: Decoration.none }; },
  update(val, tr) {
    let q = val.q, current = val.current, set = false;
    for (const e of tr.effects) if (e.is(setSearchQ)) { q = e.value.q; current = e.value.current; set = true; }
    if (set || tr.docChanged) return { q, current, deco: buildSearchDeco(tr.state, q, current) };
    return val;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// Sorted fence line-start positions, maintained INCREMENTALLY in a StateField so both
// the grey-mask plugin and the code-syntax highlighter read the same set (computed
// once per change, not twice). O(fences + changed lines) per keystroke.
const fenceField = StateField.define({
  create: (state) => scanFencePositions(state.doc, 0, state.doc.length),
  update: (value, tr) => (tr.docChanged ? updateFencePositions(value, tr.changes, tr.newDoc) : value),
});

const codeBlockPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = buildDeco(view, view.state.field(fenceField)); }
  update(u) {
    if (u.docChanged) {
      this.decorations = buildDeco(u.view, u.state.field(fenceField));
    } else if (u.selectionSet && u.state.field(fenceField).length % 2 === 1) {
      // Only re-pair on caret move while a block is half-typed (odd fences):
      // the "nearest fence to caret" can change. Cheap (no re-scan).
      this.decorations = buildDeco(u.view, u.state.field(fenceField));
    }
  }
}, { decorations: (v) => v.decorations });

// ── Code-block SYNTAX HIGHLIGHTING (edit mode), viewport-scoped & cheap ─────────
// Per-line stream tokenizers (legacy CM5 modes) run manually over ONLY the visible
// code lines of each fenced block; language picked from the fence tag. Cost is
// O(visible code lines), never O(doc), so it adds no perceptible typing latency.
// `sql` is a FACTORY (needs a config) unlike the other modes which are ready
// StreamParsers — build a standard-SQL parser once (stateless, reused).
const sqlMode = sql({});
const HL_MODES = {
  bash: shell, sh: shell, shell: shell, zsh: shell, console: shell,
  python: python, py: python, python3: python,
  javascript: javascript, js: javascript, jsx: javascript, mjs: javascript, node: javascript,
  typescript: typescript, ts: typescript, tsx: typescript,
  json: json, jsonc: json,
  sql: sqlMode, mysql: sqlMode, postgres: sqlMode, postgresql: sqlMode, psql: sqlMode, sqlite: sqlMode,
};
// legacy-mode token style → CSS class (comments get their own muted grey; unknown
// styles map to null = left plain, so we only colour what we recognise).
const HL_CLASS = {
  comment: 'cm-hl-comment',
  keyword: 'cm-hl-keyword', tag: 'cm-hl-keyword',
  string: 'cm-hl-string', 'string-2': 'cm-hl-string',
  number: 'cm-hl-number',
  atom: 'cm-hl-atom', bool: 'cm-hl-atom',
  def: 'cm-hl-def', qualifier: 'cm-hl-def',
  builtin: 'cm-hl-builtin',
  meta: 'cm-hl-meta',
  property: 'cm-hl-property', attribute: 'cm-hl-property',
  type: 'cm-hl-type', 'variable-3': 'cm-hl-type',
  'variable-2': 'cm-hl-var2',
};
const _hlMarkCache = {};
const hlMark = (cls) => (_hlMarkCache[cls] || (_hlMarkCache[cls] = Decoration.mark({ class: cls })));
const langFromFence = (text) => { const m = /^\s*(?:```|~~~)\s*([A-Za-z0-9_+#-]+)/.exec(text); return m ? m[1].toLowerCase() : ''; };
const hlClassFor = (style) => { if (!style) return null; const s = style.indexOf(' ') === -1 ? style : style.slice(0, style.indexOf(' ')); return HL_CLASS[s] || null; };

const codeHighlightPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const doc = view.state.doc;
    const fences = view.state.field(fenceField);
    const builder = new RangeSetBuilder();
    const vis = view.visibleRanges;
    if (fences.length < 2 || !vis.length) return builder.finish();
    const vpFrom = vis[0].from, vpTo = vis[vis.length - 1].to;
    const MAXLOOK = 500; // cap tokenizer look-back into a huge block above the viewport
    for (let i = 0; i + 1 < fences.length; i += 2) {
      const openPos = fences[i], closePos = fences[i + 1];
      if (closePos < vpFrom) continue;   // block ends above viewport
      if (openPos > vpTo) break;         // fences sorted → all remaining blocks below
      const openLine = doc.lineAt(openPos), closeLine = doc.lineAt(closePos);
      const firstContent = openLine.number + 1, lastContent = closeLine.number - 1;
      if (firstContent > lastContent) continue;
      const mode = HL_MODES[langFromFence(openLine.text)];
      if (!mode) continue;               // unknown/absent language → leave code plain
      const vpTopLine = doc.lineAt(Math.max(vpFrom, openLine.to)).number;
      let startLn = firstContent;
      if (vpTopLine - startLn > MAXLOOK) startLn = vpTopLine - MAXLOOK;
      const st = mode.startState ? mode.startState() : {};
      for (let ln = startLn; ln <= lastContent; ln++) {
        const line = doc.line(ln);
        if (line.from > vpTo) break;
        this.tokLine(line, mode, st, builder, line.to >= vpFrom && line.from <= vpTo, vpFrom, vpTo);
      }
    }
    return builder.finish();
  }
  tokLine(line, mode, st, builder, emit, vpFrom, vpTo) {
    const text = line.text;
    if (!text) { if (mode.blankLine) { try { mode.blankLine(st); } catch (_) {} } return; }
    const stream = new StringStream(text, 4, 2);
    let guard = 0;
    while (!stream.eol() && guard++ < 5000) {
      stream.start = stream.pos;
      let style; try { style = mode.token(stream, st); } catch (_) { stream.pos = text.length; style = null; }
      if (stream.pos <= stream.start) stream.pos = stream.start + 1; // force progress
      if (emit) {
        const cls = hlClassFor(style);
        if (cls) {
          const from = line.from + stream.start, to = line.from + Math.min(stream.pos, text.length);
          if (to > from && from >= vpFrom && from <= vpTo) builder.add(from, to, hlMark(cls));
        }
      }
    }
  }
}, { decorations: (v) => v.decorations });

// ── Blue links (edit mode) ─────────────────────────────────────────────────────
// Colour every markdown link + wiki-link + attachment link blue, WITHOUT the markdown
// language parser (which was the O(doc) cost we removed). A cheap regex runs over ONLY
// the visible ranges → O(viewport), no perceptible latency and no effect on note
// opening. Matches: [text](url), ![alt](url) (images), [📎/🎵/🎬 name](attachments/…),
// and [[Note]] / [[Note|alias]].
const mdLinkMark = Decoration.mark({ class: 'cm-md-link' });
const LINK_RE = /!?\[[^\]\n]*\]\([^)\n]*\)|\[\[[^\]\n]*\]\]/g;
const linkColorPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const builder = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      LINK_RE.lastIndex = 0;
      let m;
      while ((m = LINK_RE.exec(text))) {
        const s = from + m.index;
        builder.add(s, s + m[0].length, mdLinkMark);
        if (LINK_RE.lastIndex === m.index) LINK_RE.lastIndex++;   // zero-length safety
      }
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

// ── Inline #tag colouring (edit mode) ───────────────────────────────────────
// Colour `#tag` blue so tags read as tags while writing. Viewport-scoped (cheap,
// like linkColorPlugin) and SKIPPED inside fenced code blocks (so `#include`,
// `#!/bin/sh`, etc. stay plain). Same match rule as the sidebar Tags parser:
// a `#` at line start or after whitespace, then a letter and word chars/hyphens.
const mdTagMark = Decoration.mark({ class: 'cm-md-tag' });
const TAG_RE = /(^|\s)(#[A-Za-z][\w-]*)/g;
function _tagInCode(pos, fences, doc) {
  if (!fences || fences.length < 2) return false;
  for (let i = 0; i + 1 < fences.length; i += 2) {
    if (pos >= fences[i] && pos <= doc.lineAt(fences[i + 1]).to) return true;
  }
  return false;
}
const tagColorPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(u) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
  build(view) {
    const builder = new RangeSetBuilder();
    const doc = view.state.doc;
    let fences = null; try { fences = view.state.field(fenceField); } catch (_) {}
    for (const { from, to } of view.visibleRanges) {
      const text = doc.sliceString(from, to);
      TAG_RE.lastIndex = 0;
      let m;
      while ((m = TAG_RE.exec(text))) {
        const s = from + m.index + m[1].length;   // start of '#'
        const e = s + m[2].length;
        if (!_tagInCode(s, fences, doc)) builder.add(s, e, mdTagMark);
        if (TAG_RE.lastIndex === m.index) TAG_RE.lastIndex++;   // zero-length safety
      }
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

// Total length selected across every range. The guards below compare a deletion against
// what the user had selected; measuring only `selection.main` would understate it if the
// selection ever had several ranges. It cannot today — this editor does not enable
// CodeMirror's `allowMultipleSelections`, so a selection always collapses to one range
// (checked by probe) — so this is correctness that does not depend on that setting, NOT a
// fix for anything users could hit.
function _selectedLength(state) {
  try { let n = 0; for (const r of state.selection.ranges) n += r.to - r.from; return n; } catch (_) { return 0; }
}

// ── View/DOM desync: detection + recovery ────────────────────────────────────
// DETECTION. CM renders the doc as one <div class="cm-line"> per line, and this editor
// uses ONLY line/mark decorations (no `replace`, no widgets — see cbLine/mdLinkMark/…),
// so the rendered text is always the doc text minus its line breaks. When those two
// lengths stop agreeing, the view is DESYNCED: CM re-reads that stale DOM on every
// keystroke, concludes the note is far shorter than it really is, and tries to delete
// the difference (which the content-loss firewall below then blocks, key after key,
// leaving the editor apparently frozen — caret blinking, nothing typing).
// The comparison is only meaningful when the WHOLE doc is rendered: on a virtualized
// doc the DOM is legitimately partial, so bail out on the same viewport test
// bigDocTypingFix uses. That test also keeps this cheap — big docs never read
// textContent at all.
function domOutOfSync(view) {
  try {
    const len = view.state.doc.length;
    const vp = view.viewport;
    if (vp.from > 0 || vp.to < len) return false;        // virtualized → partial DOM is correct
    const expected = len - (view.state.doc.lines - 1);   // line breaks are not in textContent
    const actual = view.contentDOM.textContent.length;
    return expected - actual > 8;                        // only a SHORTFALL matters; slack for placeholders
  } catch (_) { return false; }
}

// RECOVERY. Rebuild the document view from the CURRENT state so the DOM matches the doc
// again: `setState` reconstructs the DOM while keeping doc, selection and undo history
// (they all live IN the state). Scroll position does not, so carry it over by hand or
// the note jumps to the top.
// `requestMeasure()` is NOT sufficient — app.js has always called it from a
// ResizeObserver on the mount, and a desynced note stayed broken through it. Only a
// rebuild restores the DOM.
function resyncView(view, why) {
  if (!view) return false;
  try {
    const top = view.scrollDOM.scrollTop;
    view.setState(view.state);
    view.scrollDOM.scrollTop = top;
    try { view.requestMeasure(); } catch (_) {}
    // Did the rebuild actually put the whole note back in the DOM? Logged right away and
    // again after a frame, because the measure pass that finishes the render is async.
    const now = view.contentDOM.textContent.length;
    try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('RESYNC view rebuilt (' + why + ') len=' + view.state.doc.length + ' domAfter=' + now); } catch (_) {}
    try {
      requestAnimationFrame(() => {
        try {
          const later = view.contentDOM.textContent.length;
          if (later !== now) window.inkwell.debugLog('RESYNC settled domAfter=' + later);
        } catch (_) {}
      });
    } catch (_) {}
    return true;
  } catch (_) { return false; }
}

// Check + repair. Returns true if it had to rebuild. Safe to call often: on a synced
// view it costs one textContent length read, and nothing at all on a virtualized doc.
function resyncIfNeeded(view, why) {
  if (!view || !domOutOfSync(view)) return false;
  return resyncView(view, why);
}

// Deferred recovery for the firewall: that runs inside a transactionFilter, and the view
// must not be touched while a dispatch is in flight.
//
// It also RE-APPLIES the keystroke. Blocking alone loses it, and on a note where the DOM
// collapses on every native input that means the note cannot be typed in at all: the
// browser mangles the rendering, CM reads the mangled DOM, the resulting transaction is
// garbage and gets dropped — but the character the user actually pressed is known exactly
// (beforeinput carries it, see _pendingText). So: drop CM's misreading, rebuild the view,
// then insert the real text from the STATE, which never consults the DOM. Text typed while
// the rendering is broken still lands, in the right place, once.
let _resyncPending = false;
let _pendingText = '';        // characters whose transaction was blocked, awaiting re-apply
let _pendingCandidate = '';   // the text of the keystroke currently being handled natively
let _pendingDelete = '';      // 'backward' | 'forward': a single-char delete to redo
// A blocked paste / cut / delete-selection, to redo from the state: the range the user had
// selected BEFORE the mis-read (still valid — the transaction was dropped) and what should
// replace it (the pasted text, or nothing for a cut or a delete).
let _pendingRange = null;     // { from, to, insert, what }
let _lastClipboardText = '';  // plain text of the last paste, so a blocked one can be redone
function scheduleViewRecovery(view) {
  if (!view || _resyncPending) return;
  _resyncPending = true;
  setTimeout(() => {
    _resyncPending = false;
    resyncView(view, 'blocked-keystroke');
    // A blocked paste / cut / delete-selection: redo exactly what the user asked for,
    // computed from the state instead of from the rendering.
    const rng = _pendingRange;
    _pendingRange = null;
    if (rng) {
      try {
        const max = view.state.doc.length;
        const from = Math.min(rng.from, max), to = Math.min(Math.max(rng.to, from), max);
        const lenBefore = max;
        view.dispatch({
          changes: { from, to, insert: rng.insert || '' },
          selection: { anchor: from + (rng.insert || '').length },
          userEvent: rng.insert ? 'input.paste' : 'delete.selection',
          scrollIntoView: true,
        });
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('REDONE ' + rng.what + ' [' + from + ',' + to + '] insert=' + (rng.insert || '').length + ' ' + lenBefore + '->' + view.state.doc.length); } catch (_) {}
      } catch (_) {}
    }
    // A single-character delete that was blocked: redo it from the STATE, where CM's own
    // command handles grapheme clusters and selections correctly.
    const del = _pendingDelete;
    _pendingDelete = '';
    if (del) {
      try {
        const lenBefore = view.state.doc.length;
        (del === 'forward' ? deleteCharForward : deleteCharBackward)(view);
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('REDELETED ' + del + ' ' + lenBefore + '->' + view.state.doc.length); } catch (_) {}
      } catch (_) {}
    }
    const text = _pendingText;
    _pendingText = '';
    if (!text) return;
    try {
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        userEvent: 'input.type',
        scrollIntoView: true,
      });
      try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('REAPPLIED ' + JSON.stringify(text) + ' at ' + sel.from + ' len=' + view.state.doc.length); } catch (_) {}
    } catch (_) {}
  }, 0);
}

// CONTENT-LOSS FIREWALL. On a large virtualized doc, CM's applyDOMChange can misread
// the partial (viewport-only) DOM after a keystroke and emit an `input.type` (or
// input.*) transaction that REPLACES THE WHOLE DOCUMENT with just the visible lines
// — the user types one char and the whole note vanishes down to ~a few hundred chars.
// A single typing/IME/deleteContent step can never legitimately remove thousands of
// characters, so reject any such transaction. Real large deletions (select-all+delete,
// cut, paste-replace) carry different userEvents (delete.selection / delete.cut /
// input.paste) and pass.
//
// v1.0.9: blocking ALONE was not enough, and the old comment here was wrong. It claimed
// dropping the transaction makes CM "re-render the DOM back to the real state, at worst
// one keystroke is dropped". It does not: when the view's DOM is PERSISTENTLY out of
// sync with the doc, CM keeps re-reading the same stale DOM and every single keystroke
// is blocked — the editor looks frozen (caret blinks, nothing types, nothing deletes)
// and the only way out was closing the note. Seen on a 708-char note whose DOM held only
// its first 254 chars: `BLOCKED input truncation 708->254 deleted=454 selLen=0` repeated
// identically for every key, and even a transaction that DID pass never repainted.
// So: block the destructive change (data safety first) AND resync the view, which
// restores the "one dropped keystroke" behaviour the guard was always meant to have.
const contentLossGuard = (getView) => EditorState.transactionFilter.of((tr) => {
  try {
    if (!tr.docChanged) return tr;
    const ue = tr.annotation(Transaction.userEvent);
    // Only scrutinise typing / IME steps (input.type…, bare input). Real bulk edits
    // — paste (input.paste), cut/delete (delete.*), undo — are left alone.
    if (ue && /^(input\.type|input$)/.test(ue)) {
      const before = tr.startState.doc.length;
      const after = tr.newDoc.length;
      const deleted = before - after;
      const sel = tr.startState.selection.main;
      const selLen = _selectedLength(tr.startState);
      // Bug signature: a keystroke removes FAR more than the user had selected. A
      // legit "select-all then type" deletes ≈ selLen, so deleted won't exceed it by
      // much. The applyDOMChange mis-read deletes thousands of chars with only a caret
      // selected. Block that (drop the transaction → CM re-renders the real content).
      // v1.0.984: thresholds LOWERED. They were before>4000 / deleted>2000, which left
      // a hole: a ~2700-char note truncated to ~2 lines slipped THROUGH (before<4000)
      // and got autosaved over the good content — real data loss (the OpenSSL note).
      // The genuine discriminator is `deleted > selLen + margin`: no legit keystroke
      // ever removes hundreds of chars MORE than what was selected (typing over a
      // selection deletes ≈ selLen). So the before/deleted floors only exist to skip
      // scrutinising trivially small edits — they can be small without risking false
      // positives, because the selLen margin is what actually gates the block.
      if (before > 300 && deleted > 150 && deleted > selLen + 150) {
        // Log the view's actual state alongside the block. A block means our model of
        // what CM is doing is wrong somewhere, and these five fields say where: whether
        // the viewport claims to cover the doc, how much text is really rendered, and
        // which branch the keystroke took through bigDocTypingFix. Costs nothing until
        // something is already broken.
        let diag = '';
        try {
          const v = getView && getView();
          if (v) {
            const vp = v.viewport;
            diag = ' vp=[' + vp.from + ',' + vp.to + ']'
              + ' dom=' + v.contentDOM.textContent.length
              + ' lines=' + v.state.doc.lines
              + ' composing=' + !!v.composing
              + ' ranges=' + v.state.selection.ranges.length
              + ' path=' + _lastInputPath
              + ' domAtInput=' + _domAtInput;
          }
        } catch (_) {}
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('BLOCKED input truncation ' + before + '->' + after + ' deleted=' + deleted + ' selLen=' + selLen + ' ue=' + ue + diag); } catch (_) {}
        // CM read a DOM that does not match the doc. Rebuild it, and re-apply the
        // keystroke this transaction was supposed to carry (its text is known from
        // beforeinput) so the character is not simply swallowed.
        try {
          if (_pendingCandidate) { _pendingText += _pendingCandidate; _pendingCandidate = ''; }
          scheduleViewRecovery(getView && getView());
        } catch (_) {}
        return [];
      }
    }
    // DELETIONS. Same mis-read, different event: on a collapsed DOM a plain Backspace can
    // come back as "remove hundreds of characters", and unlike typing it was never
    // scrutinised — it would apply AND be autosaved, which is the one way this bug can
    // actually lose text rather than just block you.
    // Deliberately narrow: ONLY the single-character gestures (delete.backward /
    // delete.forward), which can never legitimately remove more than a grapheme cluster
    // beyond the selection. Word deletes, line kills, cut and delete-selection carry other
    // userEvents and are left completely alone — no risk of blocking a real bulk delete.
    if (ue && /^delete\.(backward|forward)$/.test(ue)) {
      const before = tr.startState.doc.length;
      const deleted = before - tr.newDoc.length;
      const sel = tr.startState.selection.main;
      const selLen = _selectedLength(tr.startState);
      if (before > 300 && deleted > selLen + 8) {
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('BLOCKED delete truncation ' + before + '->' + tr.newDoc.length + ' deleted=' + deleted + ' selLen=' + selLen + ' ue=' + ue); } catch (_) {}
        try {
          _pendingDelete = ue === 'delete.forward' ? 'forward' : 'backward';
          scheduleViewRecovery(getView && getView());
        } catch (_) {}
        return [];
      }
    }
    // PASTE / DROP / CUT / DELETE-SELECTION. These were left unscrutinised, and a probe
    // showed what that costs: on a collapsed rendering each one APPLIED a truncation
    // (440 -> 254 chars) and would then have been autosaved. The exclusion was
    // over-cautious — the invariant that catches a mis-read holds for all of them:
    //   • a paste replaces the selection      → it removes ≈ selLen
    //   • a cut removes the selection         → it removes ≈ selLen
    //   • delete-selection removes it too     → it removes ≈ selLen
    // Only a mis-read removes hundreds MORE than was selected. Pasting a short text over a
    // huge selection is therefore safe (deleted ≈ selLen - insertLen, well under the bar),
    // and word/line kills carry other userEvents and never reach here.
    if (ue && /^(input\.paste|input\.drop|delete\.cut|delete\.selection)$/.test(ue)) {
      const before = tr.startState.doc.length;
      const deleted = before - tr.newDoc.length;
      const sel = tr.startState.selection.main;
      const selLen = _selectedLength(tr.startState);
      if (before > 300 && deleted > selLen + 150) {
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('BLOCKED ' + ue + ' truncation ' + before + '->' + tr.newDoc.length + ' deleted=' + deleted + ' selLen=' + selLen); } catch (_) {}
        try {
          // Redo it from the state. A paste puts the clipboard text back in; a cut or a
          // delete just removes what was selected. A text DROP is only refused — its text
          // is not recoverable here — so the note survives and nothing lands.
          _pendingRange = ue === 'input.drop'
            ? { from: sel.from, to: sel.from, insert: '', what: 'drop-refused' }
            : { from: sel.from, to: sel.to, insert: ue === 'input.paste' ? _lastClipboardText : '', what: ue };
          scheduleViewRecovery(getView && getView());
        } catch (_) {}
        return [];
      }
    }
  } catch (_) {}
  return tr;
});

// TYPING FIX for big docs. On a large virtualized document, CM's applyDOMChange can
// mis-localize a keystroke (reading the partial DOM) and try to replace the whole doc
// with the visible lines — so the text vanishes and you can't type. To sidestep that
// path entirely, we handle plain text insertion OURSELVES from the `beforeinput`
// event (which carries the exact typed text and fires BEFORE the DOM is mutated):
// insert it at the real caret via a clean transaction and preventDefault so the
// browser never mutates the contentEditable (hence CM never mis-reads it). Only for
// simple `insertText` (not IME composition, not delete/paste) and only on big docs,
// so normal editing is completely unaffected.
// Which branch the last insertText took through the handler below. Recorded so a block
// can say WHY the keystroke was left to CM's native path instead of the protected one —
// a bare assignment per keystroke, no measuring, no cost.
let _lastInputPath = 'none';
// Rendered text length at the instant the last keystroke arrived, i.e. BEFORE the browser
// could mutate the contentEditable. Compared against the length seen when a block happens,
// it separates "the DOM was already wrong" from "this keystroke broke it".
let _domAtInput = -1;
const bigDocTypingFix = EditorView.domEventHandlers({
  beforeinput(event, view) {
    try {
      if (event.inputType !== 'insertText' || event.data == null) { _lastInputPath = 'not-insertText:' + event.inputType; return false; }
      if (view.composing) { _lastInputPath = 'composing'; return false; }   // let IME composition go through CM
      // v1.0.986: gate on ACTUAL virtualization, not a char count. The applyDOMChange
      // mis-read that vanishes text can only happen when part of the doc is NOT in the
      // DOM (virtualized away) — CM reads the partial contentDOM and mistakes it for the
      // whole doc. When the ENTIRE doc is rendered (viewport covers [0, docLen]) CM has
      // the full DOM and cannot mis-read, so native handling is safe and correct.
      // The old `< 1500` char threshold was wrong in BOTH directions: too low (a fully
      // rendered 3000-char note is safe yet we bypassed CM's native input path on every
      // keystroke → laggy/glitchy typing, dropped chars — the v985 regression) and it
      // said nothing about whether the doc is actually virtualized. Detect it directly:
      // only intercept when the viewport does NOT cover the whole document.
      const vp = view.viewport;
      // How much text is really rendered when this keystroke arrives — the one fact that
      // says whether the DOM was already broken BEFORE the key or got broken BY it.
      _domAtInput = view.contentDOM.textContent.length;
      // v1.0.10: "the whole doc is rendered" is only a reason to trust CM's native input
      // path if the DOM it will read actually MATCHES the document. A note was found
      // where the viewport claimed [0,708] while the DOM held 254 chars: CM read that,
      // concluded the note had shrunk, and every keystroke was rejected by the firewall
      // below — the editor could not be typed in at all. When the DOM disagrees, take the
      // protected path instead: inserting from the state never consults the DOM, so the
      // keystroke lands correctly no matter how mangled the rendering is.
      const wholeDocRendered = vp.from <= 0 && vp.to >= view.state.doc.length;
      const desynced = wholeDocRendered && domOutOfSync(view);
      // Handing this keystroke to CM's native path: remember its text, so that if the
      // resulting transaction turns out to be a mis-read and gets blocked, the character
      // can still be applied instead of vanishing.
      if (wholeDocRendered && !desynced) { _lastInputPath = 'whole-doc-rendered'; _pendingCandidate = event.data; return false; }  // DOM matches → native is safe
      if (view.state.selection.ranges.length > 1) { _lastInputPath = 'multi-range'; _pendingCandidate = event.data; return false; }
      _pendingCandidate = '';   // we handle it ourselves below; nothing to recover
      _lastInputPath = desynced ? 'desynced-dom' : 'intercepted';
      const sel = view.state.selection.main;
      // We bypass CM's input path, so replicate the features that live in its
      // inputHandlers — here the ``` fence auto-close (3rd backtick → full block).
      if (tryFenceAutoClose(view, sel.from, sel.to, event.data)) { event.preventDefault(); return true; }
      view.dispatch(view.state.update({
        changes: { from: sel.from, to: sel.to, insert: event.data },
        selection: { anchor: sel.from + event.data.length },
        userEvent: 'input.type',
        scrollIntoView: true,
      }));
      event.preventDefault();
      // The text is in now, but the rendering that lied is still on screen: rebuild it so
      // what the user sees matches what the note contains.
      if (desynced) {
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('PROTECTED insert on desynced dom: dom=' + _domAtInput + ' docLen=' + view.state.doc.length + ' vp=[' + vp.from + ',' + vp.to + ']'); } catch (_) {}
        scheduleViewRecovery(view);
      }
      return true;
    } catch (_) { return false; }
  },
});

// The edit-mode editor deliberately runs with NO markdown language / syntax
// highlighting: the source text is shown PLAIN (uncolored) — markdown formatting and
// colours are seen only in view/preview mode (rendered separately, outside CM). This
// is also why typing is fast at any note size: the `markdown()` Lezer parser was the
// sole O(doc)-per-keystroke cost (QA v987: ~40ms/keystroke at 500KB, ~180ms at 2MB;
// with it gone, typing is sub-millisecond even at 2MB). `markdown()` was used ONLY
// for highlighting — nothing else (fence auto-close, TOC, `[[` autocomplete) needs
// the syntax tree. The grey code-block background masks are KEPT: codeBlockPlugin
// scans ``` fences itself, independent of any language, so blocks stay visually
// distinct while editing without colouring the text.

window.AmelieCM = {
  create(parent, doc, onChange) {
    const lineNumbersComp = new Compartment();
    const initialDoc = dedentCodeBlocks(doc || '');
    const updateListener = EditorView.updateListener.of((u) => {
      if (!u.docChanged) return;
      const userEdit = u.transactions.some((tr) => tr.annotation(Transaction.userEvent) != null);
      // An edit landed, so the last keystroke needs no recovery — drop it, or a later
      // block from an unrelated cause could re-apply a character typed long ago.
      if (userEdit) _pendingCandidate = '';
      if (userEdit && onChange) onChange(u.state.doc.toString());
    });
    // Repair a desynced DOM the moment the editor is focused — i.e. BEFORE the user can
    // type into it and lose a keystroke to the firewall. Deferred so CM finishes its own
    // focus handling first; never consumes the event.
    const desyncWatch = EditorView.domEventHandlers({
      focus() { setTimeout(() => resyncIfNeeded(view, 'focus'), 0); return false; },
    });
    // `let`, and the guard takes a getter rather than the view itself: the firewall is
    // built as part of this very expression, so it can only reach the view lazily (by
    // the time it calls back, the assignment has long since happened).
    let view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          bigDocTypingFix,
          desyncWatch,
          contentLossGuard(() => view),
          lineNumbersComp.of([]),
          history(), drawSelection(), highlightActiveLine(),
          EditorView.lineWrapping,
          fenceAutoClose,
          pasteNormalize,
          keymap.of([fenceEnter, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          fenceField,
          codeBlockPlugin,
          codeHighlightPlugin,
          linkColorPlugin,
          tagColorPlugin,
          searchField,
          updateListener,
        ],
      }),
      parent,
    });
    const scroller = view.scrollDOM;
    return {
      view,
      getValue: () => view.state.doc.toString(),
      setValue: (s) => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: dedentCodeBlocks(s || '') } }); try { view.requestMeasure(); } catch (_) {} },
      focus: () => view.focus(),
      // Check the rendered DOM still matches the document, and rebuild the view if it
      // does not. Call it whenever the editor BECOMES VISIBLE again (leaving preview,
      // switching to a note tab, closing the split): CM cannot render or measure while
      // its container is display:none, which is how the DOM ends up stale. Returns true
      // if a rebuild was needed.
      checkSync: (why) => resyncIfNeeded(view, why || 'visible'),
      getSelection: () => ({ from: view.state.selection.main.from, to: view.state.selection.main.to }),
      // Move the caret AND scroll it into view, so cursor + viewport stay
      // consistent (the app restores caret and scroll separately; without this the
      // caret could sit off-screen and the first keystroke would jump the view).
      setSelection: (from, to) => view.dispatch({ selection: { anchor: from, head: to == null ? from : to }, scrollIntoView: true }),
      // Annotate as a user 'input' so the updateListener above treats it as a real
      // edit and fires onChange — otherwise programmatic inserts (toolbar buttons,
      // attachment/image paste via insertAttachmentRef) wouldn't mark the note dirty
      // or schedule autosave, and a pasted image could be lost on reload.
      insertAtCursor: (text) => view.dispatch({ ...view.state.replaceSelection(text || ''), annotations: Transaction.userEvent.of('input') }),
      // Viewport coords of the caret (for anchoring popups like the [[ ]] link menu).
      caretCoords: () => { try { const r = view.coordsAtPos(view.state.selection.main.head); return r ? { left: r.left, top: r.top, bottom: r.bottom } : null; } catch (_) { return null; } },
      // In-note search: highlight all matches of `q` (the one at `current` distinct),
      // scroll `current` into view, and return the match count.
      setSearchHighlight: (q, current) => {
        const cur = current == null ? -1 : current;
        view.dispatch({ effects: setSearchQ.of({ q: q || '', current: cur }) });
        if (cur >= 0) { try { view.dispatch({ effects: EditorView.scrollIntoView(cur, { y: 'center' }) }); } catch (_) {} }
        if (!q) return 0;
        const text = view.state.doc.toString().toLowerCase();
        const query = q.toLowerCase();
        let n = 0, i = 0; while ((i = text.indexOf(query, i)) !== -1) { n++; i += query.length; }
        return n;
      },
      hasFocus: () => view.hasFocus,
      // Scroll a document position into view (default: near the top) — for TOC jumps.
      scrollToPos: (pos, where) => { try { view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: where || 'start', yMargin: 60 }) }); } catch (_) {} },
      getScrollTop: () => scroller.scrollTop,
      setScrollTop: (n) => { scroller.scrollTop = n; },
      setLineNumbers: (on) => view.dispatch({ effects: lineNumbersComp.reconfigure(on ? lineNumbers() : []) }),
      destroy: () => view.destroy(),
    };
  },
};
