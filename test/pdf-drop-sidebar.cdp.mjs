// A PDF dragged onto the SIDEBAR: it comes in, and when it cannot, it says so.
//
// serekkr, 13/10/2026: "ho fatto drag di un pdf nella root ma non la caricato". The
// import itself works — the half that did not was the answer. The loose-PDF branch of
// the window drop handler ended in `catch (err) { console.error(...) }` and nothing
// else: a file main refuses (content that does not match the extension, over 512 MB,
// a type that is not allowed) left a console line nobody sees, no toast, nothing in
// the tree. Indistinguishable from a drop that never arrived.
//
// Drives the real app with CDP's Input.dispatchDragEvent and a real FILE PATH — not a
// synthetic DragEvent — because that is the branch an actual drag from the file manager
// takes (dataTransfer.files carrying a path that getPathForFile can resolve).
//
//   run: npm run test:pdfdrop     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const PORT = 9341;
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-pdfdrop-'));
const HOME = `${ROOT}/home`, VAULT = `${HOME}/vault`;
// A minimal but GENUINE pdf: the content check looks for %PDF- in the first 4096 bytes.
const GOOD = `${ROOT}/dropme.pdf`;
const BAD  = `${ROOT}/notreally.pdf`;
fs.writeFileSync(GOOD, Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
+ '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1'));
fs.writeFileSync(BAD, 'this is not a pdf at all, just text\n');
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/plain.md`, '---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nA note.\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
const child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} fs.rmSync(ROOT, { recursive: true, force: true }); };
process.on('exit', cleanup);
let err = ''; child.stderr.on('data', d => { err += d; });
setTimeout(() => { console.error('TIMEOUT\n' + err.slice(-1200)); process.exit(2); }, 90000);

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('no app\n' + err.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => {
  const my = ++id; pending.set(my, res);
  ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, 25000);
});
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))?.result?.result?.value;
await sleep(1500);

const results = [];
const check = (n, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

// Drop onto the file tree — the left panel, never the editor.
const dropOn = async (file) => {
  const box = JSON.parse(await ev(`(() => { const r = document.getElementById('file-tree').getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height - 40) }); })()`));
  const data = { items: [{ mimeType: 'application/pdf', data: '' }], files: [file], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) { await send('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data }); await sleep(250); }
  await sleep(3500);
};

await dropOn(GOOD);
const onDisk = fs.existsSync(`${VAULT}/attachments/pdf`) ? fs.readdirSync(`${VAULT}/attachments/pdf`).join(' ') : '(no pdf folder)';
check('a PDF dropped on the sidebar is stored under attachments/pdf/', /dropme\.pdf/.test(onDisk), onDisk);
check('it shows up in the tree', /pdf:dropme\.pdf/.test(await ev(`JSON.stringify((state.notes||[]).map(n => n.type + ':' + n.name))`)),
  await ev(`JSON.stringify((state.notes||[]).map(n => n.type + ':' + n.name))`));
check('and it opens in a tab, which is the only feedback a good drop gives',
  /pdf:dropme\.pdf/.test(await ev(`JSON.stringify(tabs.map(t => t.type + ':' + (t.name||'')))`)),
  await ev(`JSON.stringify(tabs.map(t => t.type + ':' + (t.name||'')))`));

// Now one main will refuse. The import failing is correct; being silent about it is not.
await ev(`(document.getElementById('amelie-toast')||{}).textContent = ''`);
await dropOn(BAD);
const toast = await ev(`(document.getElementById('amelie-toast')||{}).textContent || '(no toast)'`);
check('a file that is not really a PDF is not stored', !fs.readdirSync(`${VAULT}/attachments/pdf`).some(f => /notreally/.test(f)),
  fs.readdirSync(`${VAULT}/attachments/pdf`).join(' '));
check('and the refusal is on the screen, not only in the console', /match|corrispond|passt|coincide|correspond|pasuje|potriv/i.test(toast), 'toast: ' + toast);

console.log(`\n${results.every(Boolean) ? `all ${results.length}` : `${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
