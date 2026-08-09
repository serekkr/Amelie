// The prev/next arrows page through the notes WITHOUT leaving the tab you are reading in.
//
// They used to hand the reader off to another tab: openNote's "already open in a tab"
// exit switched to whichever tab held the note, so a run of next/next/next wandered off
// as soon as it reached one that happened to be open elsewhere. Paging now loads the
// note in place, twin tab and all — and seeds from the twin, because that copy may hold
// unsaved edits and switchTab pushes the active tab's text into every tab on the same
// path when you switch away.
//
// A plain open (tree click, link, Recent) must STILL switch to the existing tab: that is
// the last check here, and it is what tells the two behaviours apart.
//
//   run: npm run test:nav     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-note-nav-test';
const VAULT = `${HOME}/vault`;
const PORT = 9264;

const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
const cleanup = () => {
  try { if (child) { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);

cleanup();
await sleep(300);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/archive`, { recursive: true });
const fm = '---\ncreated: 2026-08-09 10:00\nmodified: 2026-08-09 10:00\n---\n\n';
for (const n of ['alpha', 'bravo', 'charlie', 'delta', 'echo'])
  fs.writeFileSync(`${VAULT}/notes/${n}.md`, fm + `On disk: ${n}.\n`);
// A second folder, so the run of notes crosses a folder boundary somewhere: that is
// where the jump was noticed, and _navigableNotes flattens folders away entirely.
for (const n of ['foxtrot', 'golf'])
  fs.writeFileSync(`${VAULT}/notes/archive/${n}.md`, fm + `On disk: archive/${n}.\n`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
// autosave far away: a twin tab must be able to sit dirty for the length of the test.
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 3600, sync: { enabled: false } }));

child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 25000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expr, ms = 25000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(3500);
for (let i = 0; i < 25; i++) {
  const n = await ev('typeof state !== "undefined" && state.notes ? state.notes.length : 0');
  if (typeof n === 'number' && n > 0) break;
  await sleep(400);
}
// The blank unnamed tab a fresh profile opens is what triggers the "note name?" prompt.
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
await ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c) c.click(); })()');

// Helpers injected once: page order straight from the app, and a clean slate per phase.
await ev(`(() => {
  window.__nav = () => _navigableNotes().map(n => n.path);
  window.__node = (p) => { const walk = (a) => { for (const n of a || []) { if (n.path === p) return n; const c = n.children && walk(n.children); if (c) return c; } return null; }; return walk(state.notes); };
  window.__reset = async (p) => {
    for (let i = tabs.length - 1; i >= 0; i--) { tabs[i].isDirty = false; closeTab(i); }
    await openNote(window.__node(p));
    await new Promise(r => setTimeout(r, 700));
  };
  window.__snap = () => ({ len: tabs.length, active: activeTabIdx, path: tabs[activeTabIdx] && tabs[activeTabIdx].path,
                           content: (tabs[activeTabIdx] || {}).content, dirty: !!(tabs[activeTabIdx] || {}).isDirty,
                           shown: (editor.value || '') });
})()`);

const nav = await ev('window.__nav()');
check('the vault pages through all seven notes, folders flattened away',
  Array.isArray(nav) && nav.length === 7, JSON.stringify(nav));
if (!Array.isArray(nav) || nav.length < 7) { console.error('cannot run without the note list'); process.exit(1); }
// Wherever the run steps from one folder into another — derived, not assumed: the order
// comes from the tree, which is not alphabetical by path.
const dir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const cross = nav.findIndex((p, i) => i + 1 < nav.length && dir(p) !== dir(nav[i + 1]));
check('the note list does cross a folder boundary', cross !== -1, JSON.stringify(nav));

const page = (dir) => ev(`(async () => { await navigateNote(${JSON.stringify(dir)}); await new Promise(r => setTimeout(r, 700)); return window.__snap(); })()`);

// 1) Paging with nothing else open: the one tab walks the list.
await ev(`window.__reset(${JSON.stringify(nav[0])})`);
let r = await page('next');
check('next moves the tab you are in, without opening another',
  r.active === 0 && r.path === nav[1] && r.len === 1, JSON.stringify(r));
r = await page('prev');
check('prev walks back the same way', r.active === 0 && r.path === nav[0] && r.len === 1, JSON.stringify(r));

// 2) The bug: paging onto a note that is already open in a SECOND tab.
const twinSetup = (start, twinPath) => ev(`(async () => {
  await window.__reset(${JSON.stringify(start)});
  openTab(window.__node(${JSON.stringify(twinPath)}));          // second tab, becomes active
  await new Promise(r => setTimeout(r, 700));
  await switchTab(0);                                            // back to the tab we read in
  await new Promise(r => setTimeout(r, 500));
  tabs[1].content = 'UNSAVED IN THE TWIN';                       // edits that never reached disk
  tabs[1].isDirty = true;
  return window.__snap();
})()`);

await twinSetup(nav[0], nav[1]);
r = await page('next');
check('next onto a note open in another tab stays in the tab being read',
  r.active === 0 && r.path === nav[1] && r.len === 2, JSON.stringify(r));
check('and it picks up the twin\'s unsaved text, not the copy on disk',
  r.content === 'UNSAVED IN THE TWIN' && r.dirty === true && r.shown === 'UNSAVED IN THE TWIN', JSON.stringify(r));

await twinSetup(nav[2], nav[1]);
r = await page('prev');
check('prev does the same, in the other direction',
  r.active === 0 && r.path === nav[1] && r.len === 2, JSON.stringify(r));

// 3) Paging past it keeps going from the tab you are in, rather than from the twin.
r = await page('prev');
check('and paging on from there continues down the list, still in place',
  r.active === 0 && r.path === nav[0] && r.len === 2, JSON.stringify(r));

// 4) Stepping from one folder into the next, onto a note open in another tab — this is
//    the run where the jump was actually noticed.
await twinSetup(nav[cross], nav[cross + 1]);
r = await page('next');
check('crossing into another folder onto an open note stays put too',
  r.active === 0 && r.path === nav[cross + 1] && r.len === 2, JSON.stringify({ from: nav[cross], ...r }));

// 5) The behaviour this must NOT change: a plain open still goes to the existing tab.
r = await ev(`(async () => {
  await window.__reset(${JSON.stringify(nav[0])});
  openTab(window.__node(${JSON.stringify(nav[3])}));
  await new Promise(r => setTimeout(r, 700));
  await switchTab(0);
  await new Promise(r => setTimeout(r, 500));
  await openNote(window.__node(${JSON.stringify(nav[3])}));      // a tree click, not an arrow
  await new Promise(r => setTimeout(r, 700));
  return window.__snap();
})()`);
check('clicking a note open elsewhere still switches to that tab',
  r.active === 1 && r.path === nav[3] && r.len === 2, JSON.stringify(r));

const failed = results.filter((x) => !x.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
