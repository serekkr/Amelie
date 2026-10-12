// Shift+click in the tree picks several files — Obsidian's gesture, asked for on
// 12/10/2026 with Obsidian's two reasons: "per trascinarle in una cartella o
// cancellarle".
//
// The two things it must not break are the ones it sits on top of: a plain click
// still OPENS the note (and starts the selection over), and a drag of one unselected
// note still moves that one note. Everything here is checked against the real tree
// and the real disk — a selection that looks right and moves nothing is the failure
// this is written to catch.
//
//   · Shift+click takes the range between the anchor and the row clicked,
//   · Ctrl+click adds and removes one,
//   · a plain click clears it and opens the note, Escape clears it,
//   · dragging one of them onto a folder moves THEM ALL on disk, into that folder,
//   · and dropping them on a NOTE moves them all to that note's level — which is how
//     a handful comes back OUT of a folder (only the folder row knew about the
//     selection at first, so that way round moved one and left the rest, 12/10/2026),
//   · right-click → Delete takes the whole selection, after asking once,
//   · and a drag of a note that is not in the selection still moves just that one.
//
//   run: npm run test:multisel     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-multisel'; const VAULT = `${HOME}/vault`; const PORT = 9412;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 150000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Archivio`, { recursive: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
const NOTES = ['alfa', 'bravo', 'charlie', 'delta', 'echo'];
for (const n of NOTES) fs.writeFileSync(`${VAULT}/notes/${n}.md`, fm + n + '\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
// A known order, so "from alfa to charlie" means the same thing every run.
fs.writeFileSync(`${VAULT}/notes/.amelie-order.json`,
  JSON.stringify({ '': ['Archivio', 'alfa.md', 'bravo.md', 'charlie.md', 'delta.md', 'echo.md'] }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise(res => { const my = ++id; pending.set(my, r => res(r.result)); ws.send(JSON.stringify({ id: my, method: m, params: p })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
await sleep(2800);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// A click on the row of `path`, with modifiers, through the DOM — the same event the
// mouse makes, so it runs the real handler.
const clickRow = async (p, mods = {}) => {
  await ev(`(() => { const el = [...document.querySelectorAll('#file-tree .tree-note, #file-tree .tree-folder')]
      .find(x => (x.dataset.path || x.dataset.folder) === ${JSON.stringify(p)});
    if (!el) return 'missing';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: ${!!mods.shift}, ctrlKey: ${!!mods.ctrl} }));
    return 'ok'; })()`);
  await sleep(300);
};
const sel = () => ev(`[...state.multiSel].sort()`);
const painted = () => ev(`[...document.querySelectorAll('#file-tree .multi-selected')].map(e => e.dataset.path || e.dataset.folder).sort()`);
const onDisk = () => fs.readdirSync(`${VAULT}/notes`).filter(f => f.endsWith('.md')).sort();
const inFolder = () => (fs.existsSync(`${VAULT}/notes/Archivio`) ? fs.readdirSync(`${VAULT}/notes/Archivio`) : []).sort();

// ── Shift+click takes a range ───────────────────────────────────────────────
await clickRow('alfa.md');                       // plain click: opens it, sets the anchor
check('a plain click still opens the note', await ev(`state.currentPath`) === 'alfa.md', await ev(`state.currentPath`));
check('and selects nothing', (await sel()).length === 0, JSON.stringify(await sel()));
await clickRow('charlie.md', { shift: true });
check('Shift+click takes everything from the anchor to here',
  JSON.stringify(await sel()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md']), JSON.stringify(await sel()));
check('and the rows show it', JSON.stringify(await painted()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md']), JSON.stringify(await painted()));
check('without opening charlie on the way', await ev(`state.currentPath`) === 'alfa.md', await ev(`state.currentPath`));

await clickRow('echo.md', { ctrl: true });
check('Ctrl+click adds one more',
  JSON.stringify(await sel()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md', 'echo.md']), JSON.stringify(await sel()));
await clickRow('echo.md', { ctrl: true });
check('and takes it back out',
  JSON.stringify(await sel()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md']), JSON.stringify(await sel()));

await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
await sleep(250);
check('Escape drops the selection', (await sel()).length === 0, JSON.stringify(await sel()));

// ── Dragging them into a folder ─────────────────────────────────────────────
await clickRow('alfa.md');
await clickRow('charlie.md', { shift: true });
check('picked again for the drag', (await sel()).length === 3, JSON.stringify(await sel()));
// The drag itself: dragstart on one of them, drop on the folder row. Through the real
// handlers, which is where the selection has to be read instead of the one dragged row.
await ev(`(async () => {
  const row = [...document.querySelectorAll('#file-tree .tree-note')].find(x => x.dataset.path === 'bravo.md');
  const folder = [...document.querySelectorAll('#file-tree .tree-folder')].find(x => x.dataset.folder === 'Archivio');
  const dt = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = folder.getBoundingClientRect();
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: r.left + 20, clientY: r.top + r.height / 2 }));
  return 1;
})()`);
for (let i = 0; i < 30 && inFolder().length < 3; i++) await sleep(300);
check('all three moved into the folder on disk',
  JSON.stringify(inFolder()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md']), JSON.stringify(inFolder()));
check('and they are no longer at the root', JSON.stringify(onDisk()) === JSON.stringify(['delta.md', 'echo.md']), JSON.stringify(onDisk()));
check('the selection is let go after the move', (await sel()).length === 0, JSON.stringify(await sel()));
check('the open note followed its file', await ev(`state.currentPath`) === 'Archivio/alfa.md', await ev(`state.currentPath`));

// ── A single drag still works as it always did ──────────────────────────────
await ev(`(async () => {
  const row = [...document.querySelectorAll('#file-tree .tree-note')].find(x => x.dataset.path === 'delta.md');
  const folder = [...document.querySelectorAll('#file-tree .tree-folder')].find(x => x.dataset.folder === 'Archivio');
  const dt = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  dt.setData('text/plain', 'delta.md');
  const r = folder.getBoundingClientRect();
  folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: r.left + 20, clientY: r.top + r.height / 2 }));
  return 1;
})()`);
for (let i = 0; i < 30 && inFolder().length < 4; i++) await sleep(300);
check('one note dragged on its own still moves, alone',
  JSON.stringify(inFolder()) === JSON.stringify(['alfa.md', 'bravo.md', 'charlie.md', 'delta.md'])
  && JSON.stringify(onDisk()) === JSON.stringify(['echo.md']), JSON.stringify({ dentro: inFolder(), radice: onDisk() }));

// ── Deleting the selection ──────────────────────────────────────────────────
// The folder is already open — moving things into it opens it — so click it only if
// its rows are not on screen, or the click would CLOSE it.
await ev(`(() => {
  const rows = [...document.querySelectorAll('#file-tree .tree-note')].map(x => x.dataset.path);
  if (rows.some(p => p && p.startsWith('Archivio/'))) return 'already open';
  const f = [...document.querySelectorAll('#file-tree .tree-folder')].find(x => x.dataset.folder === 'Archivio');
  f.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'opened';
})()`);
await sleep(500);
await clickRow('Archivio/alfa.md');
await clickRow('Archivio/charlie.md', { shift: true });
check('three picked inside the folder', (await sel()).length === 3, JSON.stringify(await sel()));
// Right-click one of them, then Delete — and answer the one question it asks.
await ev(`(() => { const el = [...document.querySelectorAll('#file-tree .tree-note')].find(x => x.dataset.path === 'Archivio/bravo.md');
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 })); return 1; })()`);
await sleep(300);
const label = await ev(`document.getElementById('ctx-delete').textContent`);
check('the menu says how many it will take', /\(3\)/.test(label || ''), JSON.stringify(label));
await ev(`document.getElementById('ctx-delete').click()`);
await sleep(400);
const confirmed = await ev(`(() => { const b = document.getElementById('confirm-modal-ok'); if (b) b.click(); return !!b; })()`);
check('it asked once before deleting', confirmed === true, 'nessuna richiesta di conferma');
for (let i = 0; i < 30 && inFolder().length > 1; i++) await sleep(300);
check('the three picked are gone from disk, the fourth is not',
  JSON.stringify(inFolder()) === JSON.stringify(['delta.md']), JSON.stringify(inFolder()));
check('and nothing else in the vault went with them',
  JSON.stringify(onDisk()) === JSON.stringify(['echo.md']), JSON.stringify(onDisk()));

// ── Back out of the folder, by dropping on a note at the level above ────────
// 'delta.md' is in Archivio with the others; 'echo.md' is at the root. Pick two from
// inside the folder and drop them on the note at the root: both must land there.
await clickRow('Archivio/delta.md');
await clickRow('Archivio/delta.md', { ctrl: true });     // anchor + selected
check('one picked inside the folder', (await sel()).length === 1, JSON.stringify(await sel()));
// Put a second one back in the folder to have a pair to carry out.
fs.writeFileSync(`${VAULT}/notes/Archivio/foxtrot.md`, fm + 'foxtrot\n');
await ev(`loadTree()`); await sleep(900);
await clickRow('Archivio/delta.md');
await clickRow('Archivio/foxtrot.md', { shift: true });
check('two picked inside the folder', (await sel()).length === 2, JSON.stringify(await sel()));
await ev(`(async () => {
  const row = [...document.querySelectorAll('#file-tree .tree-note')].find(x => x.dataset.path === 'Archivio/delta.md');
  const onRoot = [...document.querySelectorAll('#file-tree .tree-note')].find(x => x.dataset.path === 'echo.md');
  const dt = new DataTransfer();
  row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = onRoot.getBoundingClientRect();
  onRoot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt,
    clientX: r.left + 20, clientY: r.top + r.height / 2 }));
  return 1;
})()`);
for (let i = 0; i < 30 && onDisk().length < 3; i++) await sleep(300);
check('dropped on a note at the root, BOTH come out of the folder',
  JSON.stringify(onDisk()) === JSON.stringify(['delta.md', 'echo.md', 'foxtrot.md']),
  JSON.stringify({ radice: onDisk(), dentro: inFolder() }));
check('and the folder is left empty', inFolder().length === 0, JSON.stringify(inFolder()));

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
