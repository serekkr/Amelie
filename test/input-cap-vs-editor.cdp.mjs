// The 254-character input cap must never touch the NOTE BODY.
//
// enforceInputLimits() caps every contenteditable field at INPUT_MAX. CodeMirror's
// content DOM is a contenteditable, so the note you are writing was a "field" too —
// and `textContent` on it is every line CONCATENATED, with no newlines. The moment
// the visible text crossed 254 characters the cap rewrote the editor's DOM with one
// flat string; CodeMirror read that back as the user's own edit (the clamp removes
// exactly ONE character, the one just typed, which is indistinguishable from a real
// keystroke), the whole note became a single line, and autosave wrote it to disk.
//
// Reported 2026-09-21: `step 1` / `step 2` paragraphs came back as `…idracstep2…`.
//
// This types ACROSS the boundary with real key events, so it exercises the browser's
// own input handling — the only place the fault lives. It fails loudly against the
// old code (the note collapses to 1 line of exactly 254 chars).
//
//   run: npm run test:inputcap     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/.bin/electron`;
const HOME = '/tmp/amelie-inputcap-test';
const VAULT = `${HOME}/vault`;
const PORT = 9246;

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
// 5 lines x 48 characters = 240 visible characters — just under the cap, so a handful
// of keystrokes carries the note across it. Blank lines between the steps, like the
// note that was reported.
const STEP = (n) => `step ${n} - `.padEnd(48, 'x');
fs.writeFileSync(`${VAULT}/notes/steps.md`, [1, 2, 3, 4, 5].map(STEP).join('\n') + '\n');
// A short note, so a single paste carries it from well under the cap to well over.
fs.writeFileSync(`${VAULT}/notes/pasted.md`, 'start\n');
// A table, to prove the cap still does its job on the fields it IS for.
fs.writeFileSync(`${VAULT}/notes/table.md`, '| a | b |\n| --- | --- |\n| one | two |\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 2, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
const child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });
const cleanup = () => {
  try { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } catch (_) {}
  // By environment, never `pkill -f`: a pattern matching our own argv kills the caller.
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 8000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expr, ms = 8000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(4000);

const key = (o) => send('Input.dispatchKeyEvent', o, 4000);
const typeChar = async (ch) => {
  const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
  await key({ type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk });
  await key({ type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  await sleep(120);
};
const pressEnter = async () => {
  await key({ type: 'keyDown', text: '\r', unmodifiedText: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(160);
};
// Any dialog left open silently blocks every await in the app. Clear it, always.
const clearModals = () => ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c) c.click(); })()');

// Six lines, ~400 characters: enough on its own to cross the cap from a short note.
const PASTE = [1, 2, 3, 4, 5, 6].map((n) => `pasted line ${n} - ` + 'y'.repeat(50)).join('\n');
const writeClip = () => ev(`navigator.clipboard.writeText(${JSON.stringify(PASTE)}).then(() => 'ok', e => 'ERR ' + e.message)`);
// A real Ctrl+V only works while the window holds the compositor's focus; Chromium
// refuses it SILENTLY otherwise. Fall back to a paste EVENT, which runs the same
// handlers, and SAY which path was taken so a paste that inserted nothing is reported
// as that and not as a pass.
let pastePath = '';
const doPaste = async () => {
  await send('Page.bringToFront');
  await ev(`(() => { const cd = document.querySelector('#cm-mount .cm-content'); cd.focus(); })()`);
  await sleep(200);
  const before = await ev('editor.value');
  if (await ev('document.hasFocus()') && await writeClip() === 'ok') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 86, key: 'v', code: 'KeyV', modifiers: 2, commands: ['paste'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 86, key: 'v', code: 'KeyV', modifiers: 2 });
    await sleep(700);
    if (await ev('editor.value') !== before) { pastePath = 'real Ctrl+V'; return; }
  }
  await ev(`(() => {
    const el = document.querySelector('#cm-mount .cm-content'); el.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(PASTE)});
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(700);
  pastePath = 'paste event (the window could not take the focus a real Ctrl+V needs)';
};
const openNoteByPath = (file) => ev(`(async () => {
  const walk = (a) => { for (const n of a || []) { if (n.path === ${JSON.stringify(file)}) return n; const r = n.children && walk(n.children); if (r) return r; } return null; };
  const node = walk(state.notes); if (!node) return 'NOT-FOUND';
  await openNote(node); setViewMode('edit');
  return { current: state.currentPath, len: _cmHandle.getValue().length };
})()`, 15000);

const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };

// The blank unnamed tab a fresh profile opens would prompt for a name on autosave.
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
await clearModals();
for (let i = 0; i < 30; i++) {
  const ready = await ev('typeof _cmActive !== "undefined" && _cmActive && !!_cmHandle && state.notes && state.notes.length > 0');
  if (ready === true) break;
  await sleep(400);
}
console.log('\n── 1. typing across the cap ──');
const opened = await openNoteByPath('steps.md');
await sleep(1200);
await clearModals();
check('the note opened in the editor', !!opened && opened.current === 'steps.md' && opened.len > 200, JSON.stringify(opened));
if (!(opened && opened.current === 'steps.md')) process.exit(1);

const snap = () => ev(`(() => ({ doc: _cmHandle.getValue().length, lines: _cmHandle.view.state.doc.lines,
  visible: _cmHandle.view.contentDOM.textContent.length }))()`);

const before = await snap();
// The trigger only exists BELOW the cap: if the note already shows more than 254
// characters this test proves nothing, and says so instead of passing quietly.
check('the fixture starts under the 254-character cap', before.visible > 200 && before.visible <= 254,
  `visible=${before.visible} — the fixture no longer straddles the cap, so nothing is being tested`);

await ev('(() => { const l = _cmHandle.getValue().length; _cmHandle.setSelection(l, l); _cmHandle.focus(); })()');
await pressEnter();
const TYPED = 'abcdefghijklmnopqrstuvwxyz';
for (const ch of TYPED) await typeChar(ch);

const after = await snap();
console.log(`   before: doc=${before.doc} lines=${before.lines} visible=${before.visible}`);
console.log(`   after:  doc=${after.doc} lines=${after.lines} visible=${after.visible}  (typed ${TYPED.length} + one Enter)`);

check('the note keeps its lines — nothing collapsed into one', after.lines === before.lines + 1,
  `${before.lines} lines -> ${after.lines}; the cap flattened the document`);
check('every character typed past the cap is in the document', after.doc === before.doc + 1 + TYPED.length,
  `expected ${before.doc + 1 + TYPED.length}, got ${after.doc} — the cap swallowed ${before.doc + 1 + TYPED.length - after.doc} characters`);
const tail = await ev(`_cmHandle.getValue().slice(-${TYPED.length})`);
check('the typed line reads back whole', tail === TYPED, JSON.stringify(tail));

await sleep(4500);
const disk = fs.readFileSync(`${VAULT}/notes/steps.md`, 'utf8');
const body = disk.replace(/^---\n[\s\S]*?\n---\n\n/, '');
check('what reached disk still has its newlines', (body.match(/\n/g) || []).length >= before.lines,
  `${(body.match(/\n/g) || []).length} newlines on disk, expected >= ${before.lines}`);
check('the steps did not run together on disk', !/xstep /.test(body.replace(/\n/g, '\u0000')),
  `disk body: ${JSON.stringify(body.slice(0, 160))}`);
check('the typed text reached disk', body.includes(TYPED), `disk body tail: ${JSON.stringify(body.slice(-60))}`);

// ── 2. keep typing, well past the cap ────────────────────────────────────────
console.log('\n── 2. typing on past the cap ──');
const MORE = 'nopqrstuvwxyz0123456789abcdefghij';   // 33 more, no line ever ends
for (const ch of MORE) await typeChar(ch);
const after2 = await snap();
check('typing keeps working far past the cap', after2.doc === after.doc + MORE.length && after2.lines === after.lines,
  `doc ${after.doc} -> ${after2.doc} (expected +${MORE.length}), lines ${after.lines} -> ${after2.lines}`);

// ── 3. PASTE a multi-line block that carries a short note past the cap ───────
// Measured against the OLD code, these paste checks PASS: CodeMirror handles a paste
// itself (preventDefault + its own transaction), so no native DOM mutation happens and
// no `input` event is fired — the cap never got a chance to fire on a paste. They are
// here because the user asked for the paste path to be covered too, and because the
// guard in section 4 is what keeps BOTH paths safe: the cap can no longer reach the
// editor whatever event delivers the text. Do not read a passing section 3 as proof
// that the old fault is fixed — section 1 and section 4 are what prove that.
console.log('\n── 3. pasting a block across the cap ──');
const openedPaste = await openNoteByPath('pasted.md');
await sleep(1200); await clearModals();
check('the short note opened', !!openedPaste && openedPaste.current === 'pasted.md', JSON.stringify(openedPaste));
const beforeP = await snap();
check('the paste target starts under the cap', beforeP.visible <= 254, `visible=${beforeP.visible} — nothing would be tested`);
await ev('(() => { const l = _cmHandle.getValue().length; _cmHandle.setSelection(l, l); _cmHandle.focus(); })()');
await doPaste();
const afterP = await snap();
console.log(`   path: ${pastePath}`);
console.log(`   before: doc=${beforeP.doc} lines=${beforeP.lines} visible=${beforeP.visible}   after: doc=${afterP.doc} lines=${afterP.lines} visible=${afterP.visible}`);
check('the paste actually inserted something', afterP.doc > beforeP.doc + 300,
  `doc ${beforeP.doc} -> ${afterP.doc}; nothing was pasted, so this proves nothing`);
const pastedVal = await ev('editor.value');
check('the pasted block kept every one of its newlines', typeof pastedVal === 'string' && pastedVal.includes(PASTE),
  `the 6 pasted lines are not in the document as pasted; got ${JSON.stringify(String(pastedVal).slice(-120))}`);
check('the pasted note is not one flat line', afterP.lines >= 6, `lines=${afterP.lines}`);
await sleep(4500);
const diskP = fs.readFileSync(`${VAULT}/notes/pasted.md`, 'utf8');
check('the pasted block reached disk with its newlines', diskP.includes(PASTE),
  `disk: ${JSON.stringify(diskP.slice(-140))}`);

// ── 4. the guard itself, measured without CodeMirror's recovery in the way ───
// CodeMirror re-renders from its own state when it cannot make sense of a DOM it did
// not write, which can hide a clamp that fired. So this reads the editor's DOM
// SYNCHRONOUSLY, the instant the input event has been dispatched: if the cap still
// applied to the editor, the text is 254 characters here, whatever CM does next.
console.log('\n── 4. the cap does not touch the editor DOM at all ──');
const guard = await ev(`(() => {
  const cd = _cmHandle.view.contentDOM;
  const was = cd.textContent.length;
  cd.dispatchEvent(new Event('input', { bubbles: true }));
  return { was, now: cd.textContent.length };
})()`);
check('an input event on the editor leaves its DOM untouched', guard && guard.was === guard.now && guard.was > 254,
  `${JSON.stringify(guard)} — the cap rewrote the editor's content DOM`);

// ── 5. the cap still DOES its job on the fields it is for ───────────────────
console.log('\n── 5. the cap still works where it belongs ──');
const caps = await ev(`(() => { const f = document.getElementById('note-title');
  return { title: f ? f.maxLength : -1 }; })()`);
check('single-line inputs are still capped', caps && caps.title > 0 && caps.title <= 254, JSON.stringify(caps));
// A real table cell, made editable by the app's own makeCellEditable.
await openNoteByPath('table.md');
await sleep(900);
await ev(`setViewMode('view')`);
await sleep(1200);
const cellCap = await ev(`(() => {
  const cell = document.querySelector('#preview table td[contenteditable="true"], #preview table th[contenteditable="true"]')
            || document.querySelector('table td[contenteditable="true"]');
  if (!cell) return 'NO-CELL';
  cell.textContent = 'z'.repeat(300);
  cell.dispatchEvent(new Event('input', { bubbles: true }));
  return { len: cell.textContent.length, marked: cell.hasAttribute('data-input-cap') };
})()`);
check('a table cell is still truncated at the cap', cellCap && cellCap.len === 254,
  `${JSON.stringify(cellCap)} — the field the cap is FOR stopped being capped`);

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
