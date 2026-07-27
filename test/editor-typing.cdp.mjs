// End-to-end test for the v1.0.10 fault, in a real browser.
//
// `npm test` covers the recovery logic but cannot reproduce the fault itself: the rendering
// collapse comes from the browser's own input handling, which jsdom does not have. This
// launches the actual app — isolated profile, throwaway vault of SYNTHETIC notes, inside a
// virtual X server so no window appears — and types with Input.dispatchKeyEvent, so the
// keystrokes travel the same path a person's do.
//
// It asserts BOTH directions, which is what makes it meaningful:
//   • a note with a long wrapped line still PROVOKES the collapse (if this stops being
//     true the test is no longer proving anything, and says so);
//   • the characters land and reach disk anyway, and every refused keystroke is re-applied;
//   • a note without a long wrapped line is untouched (the trigger, isolated).
//
//   run: npm run test:app     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-cdp-test';
const VAULT = `${HOME}/vault`;
const PORT = 9231;
const LOG = '/tmp/amelie-cm-debug.log';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.copyFileSync(`${REPO}/test/fixtures/wrapped-long-line.md`, `${VAULT}/notes/wrapped.md`);
fs.writeFileSync(`${VAULT}/notes/plain.md`, 'Short note.\nSecond line.\nThird line.\n');
// vaultPath lives in amelie.json (the GLOBAL config); settings.json is the per-vault one.
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 2, sync: { enabled: false } }));

// A screen close to a real desktop: the fault involves line wrapping, so width matters.
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
await sleep(3500);

const key = async (o, ms = 4000) => { await send('Input.dispatchKeyEvent', o, ms); };
const typeChar = async (ch) => {
  const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
  await key({ type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk });
  await key({ type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  await sleep(300);
};
// Any dialog left open silently blocks every await in the app. Clear it, always.
const clearModals = async () => {
  const open = await ev('[...document.querySelectorAll("[id$=-modal],[id$=-overlay]")].filter(e=>getComputedStyle(e).display!=="none").map(e=>e.id).join(",")');
  if (open && open !== 'none' && !String(open).startsWith('<<')) {
    // CLICK cancel — hiding the dialog leaves its promise pending forever, and every
    // app function that awaits it (switchTab -> saveNote) hangs behind it.
    await ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c) c.click(); })()');
    await sleep(200);
    return open;
  }
  return '';
};
// Wait until the vault listing is actually in memory: the first openNote otherwise races
// the initial tree load and silently does nothing (_cmLoadedPath stays null).
// ALSO wait for the CodeMirror engine to be live: `_cmLoadedPath` is only set while
// `_cmActive`, so an open that happens before the editor exists reports null even though
// the note loaded — which looked like a race and is really an ordering requirement.
const waitForTree = async () => {
  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = await ev('typeof state !== "undefined" && state.notes ? state.notes.length : 0');
    const cm = await ev('typeof _cmActive !== "undefined" && _cmActive && typeof _cmHandle !== "undefined" && !!_cmHandle');
    if (typeof n === 'number' && n > 0 && cm === true) return n;
    await sleep(400);
  }
  return n || 0;
};
// Open a note the way the app does: find its node in state.notes and hand THAT to openNote.
const openOnce = (file, mode) => ev(`(async () => {
  const walk = (a) => { for (const n of a || []) { if (n.path === ${JSON.stringify(file)}) return n; const r = n.children && walk(n.children); if (r) return r; } return null; };
  const node = walk(state.notes);
  if (!node) return 'NOT-FOUND';
  await openNote(node);
  setViewMode(${JSON.stringify(mode)});
  return { cmLoaded: _cmLoadedPath, current: state.currentPath, active: (typeof getActiveTab === 'function' && getActiveTab()) ? getActiveTab().path : null,
           len: (typeof _cmHandle !== 'undefined' && _cmHandle) ? _cmHandle.getValue().length : -1, cmActive: _cmActive, tabs: tabs.length };
})()`, 15000);
// One retry: the first attempt right after startup can land before the app is settled.
const openByPath = async (file, mode) => {
  let r = await openOnce(file, mode);
  if (!r || r.cmLoaded !== file) { await sleep(1200); await clearModals(); r = await openOnce(file, mode); }
  return r;
};
// The blank unnamed tab the app opens on a fresh profile is what triggers the "note name?"
// prompt as soon as autosave fires.
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
const dismissed = await clearModals();
const noteCount = await waitForTree();
console.log(`app up, ${noteCount} notes listed${dismissed ? `, dismissed: ${dismissed}` : ''}\n`);

const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };

async function typingWorks(file, label, { viaViewMode = false } = {}) {
  console.log(`── ${file}${label ? ` (${label})` : ''}`);
  const before = logLines().length;
  await clearModals();
  let loaded;
  if (viaViewMode) {
    // The user's likely sequence: sticky mode was 'view', so content was pushed into the
    // editor while its pane was hidden, then Edit was clicked.
    loaded = await openByPath(file, 'view');
    await sleep(900);
    await ev(`setViewMode('edit', { preserveScroll: true })`);
  } else {
    loaded = await openByPath(file, 'edit');
  }
  await sleep(1200);
  await clearModals();
  // Assert the RIGHT note is open before typing a single character — otherwise the
  // keystrokes land in some other document and every later check is meaningless.
  // Checked against the app's own notion (state.currentPath + the loaded length), NOT
  // `_cmLoadedPath`: that one is only assigned in switchTab and lags on the FIRST note
  // opened in a session (the note is open and loaded correctly meanwhile — observed
  // {cmLoaded:null, current:'wrapped.md', active:'wrapped.md', len:440}).
  const ok = loaded && loaded.current === file && loaded.len > 0;
  check(`${file}${label ? ` (${label})` : ''}: note actually opened`, !!ok, `open state: ${JSON.stringify(loaded)}`);
  if (!ok) return 0;
  const st = await ev(`(() => { const len=_cmHandle.getValue().length; _cmHandle.setSelection(len,len); _cmHandle.focus();
    const vp=_cmHandle.view.viewport; return { len, dom:_cmHandle.view.contentDOM.textContent.length, lines:_cmHandle.view.state.doc.lines,
    vp:[vp.from,vp.to], focus:_cmHandle.hasFocus(), loaded:state.currentPath, cmLoaded:_cmLoadedPath, w:Math.round(_cmHandle.view.contentDOM.clientWidth),
    rows: (() => { try { const b=_cmHandle.view.viewportLineBlocks, lh=_cmHandle.view.defaultLineHeight;
      return Math.max(...b.map(x => Math.round(x.height / lh))); } catch (_) { return -1; } })() }; })()`);
  if (!st || typeof st !== 'object') { check(`${file}: editor reachable`, false, String(st)); return; }
  console.log(`   doc=${st.len} dom=${st.dom} lines=${st.lines} righeVisive(max)=${st.rows} vp=[${st.vp}] width=${st.w}px`);
  check(`${file}${label ? ` (${label})` : ''}: editor holds the note, focused`, st.loaded === file && st.focus, JSON.stringify(st));

  await typeChar('z'); await typeChar('z'); await typeChar('z');
  const after = await ev('(() => ({ len:_cmHandle.getValue().length, tail:_cmHandle.getValue().slice(-5) }))()');
  check(`${file}${label ? ` (${label})` : ''}: 3 keystrokes reached the document`, after?.len === st.len + 3, `${st.len} -> ${after?.len}, tail=${JSON.stringify(after?.tail)}`);
  await sleep(5000);
  const disk = fs.readFileSync(`${VAULT}/notes/${file}`, 'utf8');
  check(`${file}${label ? ` (${label})` : ''}: autosaved to disk`, /zzz/.test(disk), `ends: ${JSON.stringify(disk.slice(-30))}`);
  const fresh = logLines().slice(before);
  const b = fresh.filter((l) => l.startsWith('BLOCKED')).length, r = fresh.filter((l) => l.startsWith('REAPPLIED')).length;
  console.log(`   keystrokes refused: ${b}${b ? ` (re-applied ${r})` : ''}`);
  if (b) check(`${file}: every refused keystroke was re-applied`, b === r, `${b} vs ${r}`);
  console.log();
  return { blocked: b, rows: st.rows };
}

const wrapped = (await typingWorks('wrapped.md', 'long wrapped line')) || {};
const control = (await typingWorks('plain.md', 'control, no long line')) || {};
const wrappedView = (await typingWorks('wrapped.md', 'opened in view mode first', { viaViewMode: true })) || {};

// PRECONDITION — without a line that actually wraps, this test cannot exercise the fault at
// all and its green ticks would mean nothing.
check('the wrapped note really does wrap on screen', wrapped.rows > 1, `tallest line = ${wrapped.rows} visual rows`);
check('the control note does not wrap', control.rows === 1, `tallest line = ${control.rows} visual rows`);
// v1.0.12 — the browser's reflow is now PREVENTED on such a note, so no keystroke should
// ever reach the firewall. Before the fix this same note refused 3 of 3.
check('no keystroke is refused on the wrapped note', (wrapped.blocked || 0) + (wrappedView.blocked || 0) === 0,
  `${(wrapped.blocked || 0) + (wrappedView.blocked || 0)} refused — the prevention did not hold`);
check('nor on the control note', (control.blocked || 0) === 0, `${control.blocked} refused`);
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
ws.close();
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
console.log('isolated HOME removed');
process.exit(failed ? 1 : 0);
