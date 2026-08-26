// A media file being imported must not appear in the sidebar as a file of its own.
//
// An import lands on a temp first — `.amelie-import-<pid>-<ts>.mp4` — so faststart can
// rewrite the bytes and the dedup can compare what would actually be stored. The temp
// carries a REAL extension, and the tree surfaces attachments by extension, so a tree
// refresh landing mid-import listed `.amelie-import-…mp4` in the sidebar next to the
// note. Adding a video twice was enough to see it.
//
// Asserts against the tree the sidebar itself renders (window.inkwell.listNotes()).
//
//   run: npm run test:temps      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-temps-test';
const VAULT = `${HOME}/vault`;
const PORT = 9301;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display (dnf install xorg-x11-server-Xvfb)');
    process.exit(0);
  }
}

const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

let child = null;
process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
const fm = '---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\n';
fs.writeFileSync(`${VAULT}/notes/plain.md`, fm + 'A note.\n');

// One real file per kind, and one of our own temps beside it — same extension.
const kinds = [
  ['videos', 'clip.mp4',  '.amelie-import-4242-1756000000000.mp4'],
  ['audio',  'talk.mp3',  '.amelie-import-4242-1756000000001.mp3'],
  ['images', 'photo.png', '.amelie-import-4242-1756000000002.png'],
  ['pdf',    'doc.pdf',   '.amelie-import-4242-1756000000003.pdf'],
];
for (const [dir, real, temp] of kinds) {
  fs.mkdirSync(`${VAULT}/attachments/${dir}`, { recursive: true });
  fs.writeFileSync(`${VAULT}/attachments/${dir}/${real}`, Buffer.alloc(64, 1));
  fs.writeFileSync(`${VAULT}/attachments/${dir}/${temp}`, Buffer.alloc(64, 2));
}
// And an .amelie-enc-tmp at the attachments root, the other temp we make.
fs.writeFileSync(`${VAULT}/attachments/clip.mp4.amelie-enc-tmp`, Buffer.alloc(64, 3));

fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const args = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...args, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, args,
      { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1500)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const evalJs = (expression) => new Promise((res) => {
  const my = ++id; pending.set(my, (m) => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => { if (pending.delete(my)) res(undefined); }, 15000);
});

await sleep(1000);
// The tree exactly as the sidebar receives it.
const flat = await evalJs(`window.inkwell.listNotes().then(t => {
  const out = []; (function w(ns){ for (const n of ns) { out.push(n.type + '|' + n.name); if (n.children) w(n.children); } })(t);
  return out;
})`);
if (!Array.isArray(flat)) { console.error('could not read the tree:', flat, '\n' + appErr.slice(-800)); process.exit(1); }

for (const [dir, real] of kinds) {
  check(`${dir}/${real} is listed`, flat.some((e) => e.endsWith('|' + real)), flat.join(', '));
}
const temps = flat.filter((e) => e.includes('.amelie-import-') || e.includes('.amelie-enc-tmp'));
check('no .amelie-import- temp is listed', temps.length === 0, temps.join(', '));
check('no .amelie-enc-tmp is listed', !flat.some((e) => e.includes('.amelie-enc-tmp')), flat.join(', '));
check('nothing dot-prefixed reached the tree at all',
  !flat.some((e) => e.split('|')[1]?.startsWith('.')), flat.filter((e) => e.split('|')[1]?.startsWith('.')).join(', '));

console.log(`\n${results.every(Boolean) ? `all ${results.length}` : `${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
