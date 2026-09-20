// Draw, Graph and ToDo: one gesture, and a double click that lands on the notes.
//
// The three icons toggle — click to open, click again to go back. A double click flipped
// that twice, so double-clicking while inside a drawing closed it and opened a NEW one:
// you asked to leave and arrived somewhere you had never been (reported 2026-09-20).
//
// The half that is easy to miss is that a double click must not OPEN anything either:
// newDraw() writes its .draw to disk the moment it runs, so a stray flip leaves a file
// behind. The vault is counted here, not just the screen.
//
//   run: npm run test:viewicons     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-viewicons'; const VAULT = `${HOME}/vault`; const PORT = 9391;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p) => new Promise(res => { const my = ++id; pending.set(my, r => res(r.result)); ws.send(JSON.stringify({ id: my, method: m, params: p })); setTimeout(() => { if (pending.delete(my)) res(null); }, 15000); });
const ev = x => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then(r => r?.result?.value);
await sleep(2800);
const ok = []; const say = (n, p, d = '') => { ok.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : '  — ' + d}`); };

// A real double click is two click events whose `detail` counts up — which is exactly
// what the handler reads to tell the second one apart.
const single = id => ev(`document.getElementById('${id}').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
const dbl = async (id) => {
  await ev(`document.getElementById('${id}').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await sleep(120);
  await ev(`document.getElementById('${id}').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))`);
};
const onNotes = () => ev(`getComputedStyle(document.getElementById('editor-container')).display !== 'none'`);
const drawFiles = () => fs.readdirSync(`${VAULT}/notes`).filter(f => f.endsWith('.draw')).length;

// ── Draw ─────────────────────────────────────────────────────────────────────
await single('btn-canvas'); await sleep(2500);
say('a single click opens the drawing',
  await ev(`getComputedStyle(document.getElementById('canvas-overlay')).display !== 'none'`) === true);
const afterFirst = drawFiles();
say('and it wrote exactly one .draw', afterFirst === 1, String(afterFirst));

await dbl('btn-canvas'); await sleep(2200);
say('double-clicking from inside the drawing lands on the notes', await onNotes() === true);
say('the drawing really is closed',
  await ev(`getComputedStyle(document.getElementById('canvas-overlay')).display === 'none'`) === true);
say('and no second .draw was created on the way out', drawFiles() === afterFirst, `${afterFirst} -> ${drawFiles()}`);

// ── Graph ────────────────────────────────────────────────────────────────────
await single('btn-mindmap'); await sleep(1500);
say('a single click opens the graph',
  await ev(`getComputedStyle(document.getElementById('mindmap-overlay')).display !== 'none'`) === true);
await dbl('btn-mindmap'); await sleep(1500);
say('double-clicking from inside the graph lands on the notes', await onNotes() === true);
say('the graph really is closed',
  await ev(`getComputedStyle(document.getElementById('mindmap-overlay')).display === 'none'`) === true);

// ── ToDo ─────────────────────────────────────────────────────────────────────
await single('btn-new-todo'); await sleep(1600);
say('a single click opens the ToDo board', await ev(`!!_kanbanOpen`) === true);
await dbl('btn-new-todo'); await sleep(1600);
say('double-clicking from inside ToDo lands on the notes', await ev(`!!_kanbanOpen`) === false, String(await ev(`!!_kanbanOpen`)));
say('and the notes are showing again', await onNotes() === true);

// ── The tab strip is out of the way on the board ─────────────────────────────
const tabsShown = () => ev(`getComputedStyle(document.getElementById('tab-list')).display !== 'none'`);
say('the tabs are showing on a note', await tabsShown() === true);
await single('btn-new-todo'); await sleep(1600);
say('and hidden on the ToDo board', await tabsShown() === false, String(await tabsShown()));
say('the new-tab + goes with them',
  await ev(`getComputedStyle(document.getElementById('tab-new-btn')).display === 'none'`) === true,
  await ev(`getComputedStyle(document.getElementById('tab-new-btn')).display`));
say('and its divider too',
  await ev(`[...document.querySelectorAll('#tab-bar .titlebar-sep')].every(e => getComputedStyle(e).display === 'none')`) === true);
say('but the bar still exists, so the window can still be dragged',
  await ev(`getComputedStyle(document.getElementById('tab-bar')).display !== 'none'
            && getComputedStyle(document.getElementById('btn-focus-mode')).display !== 'none'`) === true);
await dbl('btn-new-todo'); await sleep(1600);
say('leaving the board brings the tabs back', await tabsShown() === true, String(await tabsShown()));
say('and the + comes back with them',
  await ev(`getComputedStyle(document.getElementById('tab-new-btn')).display !== 'none'`) === true);

// ── The single click is untouched ────────────────────────────────────────────
await single('btn-mindmap'); await sleep(1200);
await single('btn-mindmap'); await sleep(1200);
say('two SEPARATE single clicks still toggle open then shut', await onNotes() === true);
console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
