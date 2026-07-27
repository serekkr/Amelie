// Regression test for the v1.0.10 fault: a note that refused every edit.
//
// The editor's rendered DOM collapsed to the note's first line the instant a key was
// pressed. CodeMirror reads that DOM to work out what the user typed, so it concluded the
// note had shrunk by hundreds of characters and emitted a transaction to match; the
// content-loss firewall rejected it — correctly — and rejected the keystroke with it, over
// and over, leaving the note untypable with the caret still blinking.
//
// This drives the REAL shipped bundle (src/renderer/vendor/cm.bundle.js) in jsdom, with no
// Electron and no window, and reproduces the collapse by removing the rendered lines by
// hand. jsdom performs no layout, so every rectangle is zero and the viewport comes out
// covering the whole document — which is exactly the non-virtualized case where the fault
// lives.
//
// WHAT THIS CANNOT DO: it cannot reproduce the collapse itself, only its consequences —
// the collapse comes from the browser's own input handling, which jsdom does not have. A
// change in that behaviour would not be caught here; that needs the app driven over the
// DevTools Protocol so real keystrokes go through real Chromium.
//
//   run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BUNDLE = path.join(REPO, 'src/renderer/vendor/cm.bundle.js');
// Same shape as the note that failed (one long wrapped line, then shorter ones), none of
// its content — the original was a private note.
const FIXTURE = path.join(HERE, 'fixtures/wrapped-long-line.md');

const dom = new JSDOM('<!doctype html><body><div id="mount"></div></body>', {
  pretendToBeVisual: true, runScripts: 'outside-only',
});
const { window } = dom;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
const logs = [];
window.inkwell = { debugLog: (s) => logs.push(String(s)) };
window.eval(fs.readFileSync(BUNDLE, 'utf8'));
if (!window.AmelieCM) throw new Error('the bundle did not expose AmelieCM — run `npm run build:cm`');

const h = window.AmelieCM.create(window.document.getElementById('mount'), fs.readFileSync(FIXTURE, 'utf8'), () => {});
const view = h.view;
const domLen = () => view.contentDOM.textContent.length;
// Line breaks are not part of textContent, so a healthy DOM is exactly this long.
const expected = () => view.state.doc.length - (view.state.doc.lines - 1);
// Reproduce the damage: keep the first paragraph, drop the rendering of the rest.
const collapse = () => {
  [...view.contentDOM.querySelectorAll('.cm-line')].slice(1).forEach((l) => l.remove());
  return domLen();
};
const typeKey = (ch) => view.contentDOM.dispatchEvent(
  new window.InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// ── 1. no false positives on a healthy view ─────────────────────────────────────────────
check('a healthy view is not flagged as desynced', h.checkSync('test') === false, `dom=${domLen()} expected=${expected()}`);

// ── 2. detection + repair ───────────────────────────────────────────────────────────────
const stale = collapse();
check('a collapsed rendering is detected', stale < expected() - 8, `dom=${stale} expected=${expected()}`);
check('checkSync rebuilds the DOM', h.checkSync('test') === true && domLen() === expected(), `dom=${domLen()} expected=${expected()}`);

// ── 3. the firewall still refuses a truncating keystroke ────────────────────────────────
const intact = view.state.doc.toString();
collapse();
logs.length = 0;
view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.contentDOM.textContent }, userEvent: 'input.type' });
check('a truncating keystroke is refused', view.state.doc.toString() === intact, `len=${view.state.doc.length} of ${intact.length}`);
check('the refusal is logged', logs.some((l) => l.startsWith('BLOCKED')), logs.find((l) => l.startsWith('BLOCKED')) || '(none)');
await new Promise((r) => setTimeout(r, 30));
check('the view is rebuilt afterwards', domLen() === expected(), `dom=${domLen()} expected=${expected()}`);
check('nothing was lost', view.state.doc.toString() === intact, `len=${view.state.doc.length}`);

// ── 4a. PREVENTION: on a note with a wrapped line the keystroke never reaches the browser
// This is what v1.0.12 changed. Forensics in a real browser showed the collapse IS the
// browser's default action for the input event (between beforeinput and input Chromium
// replaced all five line elements with one). So when any rendered line wraps, the insert is
// done from the state and the default action is cancelled — the rendering is never
// collapsed, and there is nothing to detect or repair.
// jsdom has no layout, so every line looks tall and this path is always taken here.
{
  const before = view.state.doc.length;
  logs.length = 0;
  view.dispatch({ selection: { anchor: before } });
  const ev4 = new window.InputEvent('beforeinput', { inputType: 'insertText', data: 'W', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(ev4);
  check('the browser default action is cancelled', ev4.defaultPrevented, 'beforeinput was left to the browser');
  check('the character is inserted from the state', view.state.doc.length === before + 1 && view.state.doc.sliceString(before, before + 1) === 'W',
    `len=${view.state.doc.length} tail=${JSON.stringify(view.state.doc.sliceString(before - 2, before + 1))}`);
  check('nothing was refused (no mis-read to catch)', !logs.some((l) => l.startsWith('BLOCKED')), logs.join(' | '));
}

// ── 4a-bis. PREVENTION covers DELETIONS too ─────────────────────────────────────────────
// From a real session: a Backspace reached the browser, its default action reflowed the
// editor exactly as a keystroke did, and the firewall had to refuse a 786-character
// truncation — the note survived but that deletion was silently dropped.
{
  const before = view.state.doc.length;
  logs.length = 0;
  view.dispatch({ selection: { anchor: before } });
  const evDel = new window.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(evDel);
  check('a Backspace is not left to the browser', evDel.defaultPrevented, 'the default action was allowed to run');
  check('the deletion is applied from the state', view.state.doc.length === before - 1, `len=${view.state.doc.length} expected=${before - 1}`);
  check('nothing was refused for the deletion', !logs.some((l) => l.startsWith('BLOCKED')), logs.join(' | '));
}

// ── 4b. FALLBACK: if a keystroke does go to the browser and comes back mis-read, it must be
// refused AND re-applied. Reaching this needs the native path, which the prevention above
// now avoids — so force it by making every line look short (jsdom reports no geometry).
{
  const realBlocks = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(view), 'viewportLineBlocks');
  const realLH = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(view), 'defaultLineHeight');
  Object.defineProperty(view, 'viewportLineBlocks', { configurable: true, get: () => [{ height: 1 }] });
  Object.defineProperty(view, 'defaultLineHeight', { configurable: true, get: () => 100 });
  const before = view.state.doc.length;
  logs.length = 0;
  view.dispatch({ selection: { anchor: before } });
  const ev4 = new window.InputEvent('beforeinput', { inputType: 'insertText', data: 'X', bubbles: true, cancelable: true });
  view.contentDOM.dispatchEvent(ev4);
  check('with nothing wrapping, the keystroke is left to the browser', !ev4.defaultPrevented, 'it was intercepted anyway');
  collapse();                                    // the browser mangles the rendering
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.contentDOM.textContent }, userEvent: 'input.type' });
  check('the mis-read is refused', view.state.doc.length === before, `len=${view.state.doc.length} of ${before}`);
  await new Promise((r) => setTimeout(r, 30));
  const reapplied = logs.find((l) => l.startsWith('REAPPLIED')) || '';
  check('the character is re-applied from the state', view.state.doc.length === before + 1 && reapplied.includes('"X"'),
    `len=${view.state.doc.length} expected=${before + 1} log=${reapplied || '(none)'}`);
  check('re-applied exactly once', logs.filter((l) => l.startsWith('REAPPLIED')).length === 1, `${logs.filter((l) => l.startsWith('REAPPLIED')).length} lines`);
  delete view.viewportLineBlocks; delete view.defaultLineHeight;
  if (realBlocks) Object.defineProperty(view, 'viewportLineBlocks', realBlocks);
  if (realLH) Object.defineProperty(view, 'defaultLineHeight', realLH);
}

// ── 5. a mis-read Backspace must not shorten the note ───────────────────────────────────
{
  const before = view.state.doc.length;
  logs.length = 0;
  view.dispatch({ selection: { anchor: before } });
  view.dispatch({ changes: { from: 200, to: before }, userEvent: 'delete.backward' });   // "Backspace ate 250 chars"
  check('a mis-read Backspace is refused', view.state.doc.length === before, `len=${view.state.doc.length} of ${before}`);
  await new Promise((r) => setTimeout(r, 30));
  check('Backspace is redone as one character', view.state.doc.length === before - 1,
    `len=${view.state.doc.length} expected=${before - 1} log=${logs.find((l) => l.startsWith('REDELETED')) || '(none)'}`);
}

// ── 6b. a mis-read PASTE must not truncate the note, and must still paste ───────────────
// Before v1.0.11 these four events were unscrutinised: on a collapsed rendering a paste,
// a drop, a cut or a delete-selection APPLIED the truncation and would then be autosaved.
{
  logs.length = 0;
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  // Hand the clipboard to the paste handler so the guard has something to put back.
  // CodeMirror's own handler then pastes it from the STATE (doPaste -> changeByRange), so
  // the baseline is taken after that, not before.
  const pasteEv = new window.Event('paste', { bubbles: true, cancelable: true });
  pasteEv.clipboardData = { getData: (t) => (t === 'text/plain' ? 'PASTED' : '') };
  view.contentDOM.dispatchEvent(pasteEv);
  await new Promise((r) => setTimeout(r, 20));
  const before = view.state.doc.length;
  view.dispatch({ selection: { anchor: before } });
  collapse();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.contentDOM.textContent }, userEvent: 'input.paste' });
  check('a mis-read paste is refused', view.state.doc.length === before, `len=${view.state.doc.length} of ${before}`);
  await new Promise((r) => setTimeout(r, 30));
  check('the paste is redone from the clipboard', view.state.doc.sliceString(before, before + 6) === 'PASTED',
    `tail=${JSON.stringify(view.state.doc.sliceString(before - 2, before + 8))} log=${logs.find((l) => l.startsWith('REDONE')) || '(none)'}`);
}

// ── 6c. a mis-read CUT must not truncate either — it must remove just the selection ─────
{
  const full = view.state.doc.length;
  const from = full - 10, to = full;                       // a small, deliberate selection
  view.dispatch({ selection: { anchor: from, head: to } });
  logs.length = 0;
  collapse();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: view.contentDOM.textContent }, userEvent: 'delete.cut' });
  check('a mis-read cut is refused', view.state.doc.length === full, `len=${view.state.doc.length} of ${full}`);
  await new Promise((r) => setTimeout(r, 30));
  check('the cut is redone as just the selection', view.state.doc.length === full - 10,
    `len=${view.state.doc.length} expected=${full - 10} log=${logs.find((l) => l.startsWith('REDONE')) || '(none)'}`);
}

// ── 6d. a LEGITIMATE paste over a large selection must pass untouched ───────────────────
// This is the case the new rule must not break: replacing a lot of text with a little.
{
  const full = view.state.doc.length;
  const from = 20, to = full;
  view.dispatch({ selection: { anchor: from, head: to } });
  view.dispatch({ changes: { from, to, insert: 'tiny' }, userEvent: 'input.paste' });
  check('a real paste over a big selection is not refused', view.state.doc.length === from + 4,
    `len=${view.state.doc.length} expected=${from + 4}`);
}

// ── 6. and a REAL bulk delete must pass untouched ───────────────────────────────────────
{
  const before = view.state.doc.length;
  const cut = Math.floor(before / 2);
  view.dispatch({ selection: { anchor: cut, head: before } });
  view.dispatch({ changes: { from: cut, to: before }, userEvent: 'delete.selection' });
  check('a real bulk delete is not refused', view.state.doc.length === cut, `len=${view.state.doc.length} expected=${cut}`);
}

// NOTE: there is no multi-cursor case to test. This editor never enables CodeMirror's
// `allowMultipleSelections` facet, so a selection always collapses to a single range —
// verified by probe: creating three ranges yields one. The guards' arithmetic therefore
// cannot produce a false positive on a legitimate paste, cut or delete-selection:
// each removes exactly the selection, so `deleted` can never exceed `selLen + 150`.

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
}
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
