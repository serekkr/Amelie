// Amelie ↔ CodeMirror 6 bridge. Bundled to src/renderer/vendor/cm.bundle.js
// (see `npm run build:cm`). Exposes a small, textarea-like API on window.AmelieCM
// so app.js can drive CodeMirror without importing ESM modules directly.
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine, Decoration, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment, Transaction, RangeSetBuilder, StateField, StateEffect } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
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

// CONTENT-LOSS FIREWALL. On a large virtualized doc, CM's applyDOMChange can misread
// the partial (viewport-only) DOM after a keystroke and emit an `input.type` (or
// input.*) transaction that REPLACES THE WHOLE DOCUMENT with just the visible lines
// — the user types one char and the whole note vanishes down to ~a few hundred chars.
// A single typing/IME/deleteContent step can never legitimately remove thousands of
// characters, so reject any such transaction. Dropping it (return []) makes CM
// re-render the DOM back to the real state, so the content is preserved (at worst one
// keystroke is dropped). Real large deletions (select-all+delete, cut, paste-replace)
// carry different userEvents (delete.selection / delete.cut / input.paste) and pass.
const contentLossGuard = EditorState.transactionFilter.of((tr) => {
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
      const selLen = sel.to - sel.from;
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
        try { window.inkwell && window.inkwell.debugLog && window.inkwell.debugLog('BLOCKED input truncation ' + before + '->' + after + ' deleted=' + deleted + ' selLen=' + selLen + ' ue=' + ue); } catch (_) {}
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
const bigDocTypingFix = EditorView.domEventHandlers({
  beforeinput(event, view) {
    try {
      if (event.inputType !== 'insertText' || event.data == null) return false;
      if (view.composing) return false;                 // let IME composition go through CM
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
      if (vp.from <= 0 && vp.to >= view.state.doc.length) return false;  // whole doc rendered → native is safe
      if (view.state.selection.ranges.length > 1) return false;
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
      if (!u.docChanged || !onChange) return;
      const userEdit = u.transactions.some((tr) => tr.annotation(Transaction.userEvent) != null);
      if (userEdit) onChange(u.state.doc.toString());
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          bigDocTypingFix,
          contentLossGuard,
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
