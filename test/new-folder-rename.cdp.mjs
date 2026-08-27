// A new folder is created ready to be named, not already named for you.
//
// It used to be created as today's date — "27-08-2026" — which is a decision the
// app makes for you and then costs a second pass to undo. Every file manager and
// every editor with a tree (Finder, Explorer, VS Code, Obsidian) creates the
// folder and puts it straight into an inline rename with the name selected: you
// type and press Enter. A NOTE keeps the date, where the name is the point.
//
// The inline rename already existed (renameNote, Enter commits / Esc cancels);
// what this checks is that creating a folder now lands in it, that the default
// name is the localised "New folder", and that Esc still leaves something valid
// on disk rather than half a folder.
//
//   run: npm run test:newfolder    (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-newfolder'; const VAULT = `${HOME}/vault`; const PORT = 9367;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display (dnf install xorg-x11-server-Xvfb)');
    process.exit(0);
  }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 80000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', d => { err += d; });
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app\n' + err.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res('<<timeout>>'); }, 20000); });
await sleep(1500);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

const DEFAULT_NAME = await ev(`window.i18n.t('sidebar.new_folder')`);
const onDisk = () => fs.readdirSync(`${VAULT}/notes`, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

// ── 1. creating a folder lands in the rename, name selected ─────────────────
await ev(`createNewFolder(''), 1`);
await sleep(700);
const box = await ev(`(() => {
  const i = document.querySelector('.tree-rename-input');
  if (!i) return null;
  return { value: i.value, focused: document.activeElement === i, from: i.selectionStart, to: i.selectionEnd };
})()`);
check('a new folder opens its inline rename straight away', !!box, 'no .tree-rename-input in the tree');
check(`the name proposed is the localised "New folder" (${DEFAULT_NAME})`,
  box && box.value === DEFAULT_NAME, JSON.stringify(box));
check('the field has the focus and the whole name is selected, ready to overwrite',
  box && box.focused && box.from === 0 && box.to === String(box.value).length, JSON.stringify(box));
check('the folder is on disk under that name while it is being typed',
  onDisk().includes(DEFAULT_NAME), onDisk().join(', '));

// ── 2. typing a name and pressing Enter renames it ──────────────────────────
await ev(`(() => { const i = document.querySelector('.tree-rename-input');
  i.value = 'Progetti';
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1 })()`);
await sleep(900);
check('Enter names the folder what was typed', onDisk().includes('Progetti'), onDisk().join(', '));
check('and the placeholder name is gone from disk', !onDisk().includes(DEFAULT_NAME), onDisk().join(', '));
check('the rename field is closed afterwards',
  (await ev(`!document.querySelector('.tree-rename-input')`)) === true, 'still open');

// ── 3. Esc leaves a valid folder, not half of one ───────────────────────────
await ev(`createNewFolder(''), 1`);
await sleep(700);
await ev(`(() => { const i = document.querySelector('.tree-rename-input');
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`);
await sleep(600);
check('Escape keeps the folder under the default name', onDisk().includes(DEFAULT_NAME), onDisk().join(', '));

// ── 4. a second one does not collide with the first ─────────────────────────
await ev(`createNewFolder(''), 1`);
await sleep(700);
const second = await ev(`(document.querySelector('.tree-rename-input') || {}).value`);
check('a second new folder is suffixed rather than clashing',
  second === `${DEFAULT_NAME} (1)`, String(second));
await ev(`(() => { const i = document.querySelector('.tree-rename-input');
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1 })()`);
await sleep(500);

// ── 5. and a NOTE still gets the date — that part was left alone ────────────
await ev(`createNewNote(''), 1`);
await sleep(900);
const d = new Date();
const today = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}.md`;
check('a new NOTE is still named with today\'s date, as before',
  fs.existsSync(`${VAULT}/notes/${today}`), fs.readdirSync(`${VAULT}/notes`).join(', '));

console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
