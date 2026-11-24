// Note zoom from READING mode persists across a restart (serekkr, 24/11/2026: "se zoomo
// con ctrl + nel pannello destro e chiudo la app si deve ripristinare dopo riavvio").
// Ctrl+= in view mode must drive the per-note zoom (saved to localStorage, applied to the
// preview via --editor-font-size) rather than Chromium's non-persisted page zoom; a second
// launch sharing the same profile must come up already zoomed.
//
//   run: npm run test:notezoompersist     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-notezoom'; const VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/z.md`, `---\ncreated: 2026-10-27 10:00\n---\n\n# Z\n\ntesto nel pannello destro\n`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

async function launch(port) {
  const eargs = ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic'];
  const c = xvfb
    ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
        { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(ELECTRON, [...eargs, '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let target = null;
  for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
  if (!target) { try { process.kill(-c.pid, 'SIGKILL'); } catch (_) {} throw new Error('no app'); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 15000); });
  const key = (k, code, vk) => new Promise(res => { let n = 0; const one = (type) => { const my = ++id; pending.set(my, () => { if (++n >= 2) res(); }); ws.send(JSON.stringify({ id: my, method: 'Input.dispatchKeyEvent', params: { type, modifiers: 2, key: k, code, windowsVirtualKeyCode: vk } })); }; one('keyDown'); one('keyUp'); setTimeout(res, 2000); });
  // Graceful stop: SIGTERM lets the main process quit cleanly so Chromium flushes
  // localStorage to disk (a SIGKILL would drop the unsaved zoom and this test would be
  // meaningless). Hard-kill only as a backstop if it is still alive.
  const stop = async () => {
    try { process.kill(-c.pid, 'SIGTERM'); } catch (_) {}
    await sleep(2500);
    try { process.kill(-c.pid, 'SIGKILL'); } catch (_) {}
  };
  return { c, ev, key, stop };
}

const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${JSON.stringify(d)}`}`); };

// ── Launch 1: zoom in reading mode with Ctrl+= ──────────────────────────────
let a = await launch(9461);
await sleep(2200);
await a.ev(`(() => { const n = state.notes.find(x => /z\\.md$/.test(x.path||'')); if (n) openTab(n); return 1 })()`);
await sleep(500);
await a.ev(`setViewMode('view')`);
await sleep(400);
const base = await a.ev(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size'))`);
// focus nothing editable; press Ctrl+= three times (real keys → goes through the handler)
await a.ev(`document.body.focus && document.body.focus()`);
for (let i = 0; i < 3; i++) { await a.key('=', 'Equal', 187); await sleep(150); }
await sleep(300);
const after = await a.ev(`JSON.stringify({ noteZoom: localStorage.getItem('amelie.noteZoom'), edFont: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size')), mode: state.viewMode })`);
const A = JSON.parse(after || '{}');
check('view mode: Ctrl+= aumenta il note-zoom (localStorage)', parseInt(A.noteZoom, 10) >= 120, A);
check('view mode: Ctrl+= ingrandisce il font del preview (--editor-font-size)', A.edFont > base, { base, A });
await a.ev(`localStorage.setItem("amelie.noteZoom", localStorage.getItem("amelie.noteZoom"))`); await sleep(1500);
await a.stop();


// ── Launch 2: same profile → zoom restored at startup ───────────────────────
let b = await launch(9462);
await sleep(2200);
await b.ev(`(() => { const n = state.notes.find(x => /z\\.md$/.test(x.path||'')); if (n) openTab(n); return 1 })()`);
await sleep(500);
await b.ev(`setViewMode('view')`);
await sleep(400);
const restored = await b.ev(`JSON.stringify({ noteZoom: localStorage.getItem('amelie.noteZoom'), edFont: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--editor-font-size')) })`);
const R = JSON.parse(restored || '{}');
check('dopo RIAVVIO: il note-zoom è ripristinato da localStorage', R.noteZoom === A.noteZoom, { A, R });
check('dopo RIAVVIO: il font del preview è quello ingrandito (non torna a default)', R.edFont > base, { base, R });
await b.stop();

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
