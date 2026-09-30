// Ctrl+V of a file copied in the file manager attaches it — through the REAL clipboard.
//
// Electron 44 replaced the clipboard API: availableFormats() and readBuffer() are
// gone and every read is a Promise, so the synchronous IPC that read copied files
// (`clipboard:file-paths`) could no longer work, and a photo copied in Dolphin and
// pasted into a note did nothing. It is asynchronous now, and the paste handler
// takes what the event holds before its first await (the browser empties
// clipboardData afterwards) and holds the native paste back meanwhile — so it must
// paste ordinary text itself when no file turns up.
//
// A real X server and a real clipboard: xclip serves text/uri-list the way a file
// manager does, and Ctrl+V is a real key press (CDP Input.dispatchKeyEvent).
//
//   run: npm run test:pastefile     (needs Xvfb and xclip on PATH)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-pastefile', VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const bin of ['Xvfb', 'xclip']) { try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); } catch { console.log(`SKIP: no ${bin}`); process.exit(0); } }
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/nota.md`, '---\ncreated: 2026-09-30 10:00\n---\n\n');
const PNG = `${HOME}/copiata.png`;
fs.writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const DISPLAY = ':' + (90 + (process.pid % 9));
const xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1400x900x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true });
await sleep(800);
const env = { ...process.env, HOME, DISPLAY, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined };
const port = 9561;
const app = spawn(ELECTRON, ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic', '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env, stdio: 'ignore', detached: true });
let clip = null;
const done = () => {
  for (const c of [app, clip, xvfb]) { try { if (c) process.kill(-c.pid, 'SIGKILL'); } catch {} }
  fs.rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
  process.exit(failed ? 1 : 0);
};
setTimeout(() => { console.log('TIMEOUT'); done(); }, 120000);
// Put something on the X clipboard as a desktop app does; xclip keeps serving it.
const copy = async (type, text) => {
  if (clip) { try { process.kill(-clip.pid, 'SIGKILL'); } catch {} }
  clip = spawn('xclip', ['-selection', 'clipboard', '-t', type, '-i', '-loops', '0'], { env, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  clip.stdin.end(text);
  await sleep(400);
};

let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
if (!target) { console.log('app did not start'); done(); }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result || m.error)); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const text = () => ev(`(typeof _cmHandle !== 'undefined' && _cmActive && _cmHandle) ? _cmHandle.view.state.doc.toString() : document.getElementById('markdown-editor').value`);
const ctrlV = async () => {
  await ev(`(() => { if (state.viewMode !== 'edit') setViewMode('edit'); (_cmActive && _cmHandle) ? _cmHandle.focus() : document.getElementById('markdown-editor').focus(); return 1; })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
  await sleep(1500);
};
await sleep(2500);
await ev(`(async () => { await loadTree(); await openNote(flattenTree(state.notes).find((n) => n.path === 'nota.md')); return 1; })()`);
await sleep(1200);

// 1. A photo copied as a FILE (text/uri-list), as Dolphin or Nautilus copy it.
await copy('text/uri-list', `file://${PNG}\n`);
const direct = await ev(`window.inkwell.readClipboardFilePaths().then((p) => JSON.stringify(p))`);
check('the main process reads the copied file off the clipboard', direct === JSON.stringify([PNG]), direct);
await ctrlV();
const t1 = await text();
const att = fs.existsSync(`${VAULT}/attachments/images`) ? fs.readdirSync(`${VAULT}/attachments/images`) : [];
check('Ctrl+V of a copied photo stores it in the vault', att.length === 1, JSON.stringify(att));
check('and links it in the note', /!\[[^\]]*\]\(attachments\/images\/[^)]+\.png/.test(t1), JSON.stringify(t1));
check('not as a raw path', !t1.includes(PNG), JSON.stringify(t1));

// 2. Ordinary text still pastes, untouched.
await copy('UTF8_STRING', 'testo normale incollato');
await ctrlV();
check('ordinary text pastes as it is', (await text()).includes('testo normale incollato'), JSON.stringify(await text()));

// 3. Text that LOOKS like a path but is no attachment: held back, then pasted by hand.
await copy('UTF8_STRING', '/usr/bin/env');
const before = (await text()).length;
await ctrlV();
const t3 = await text();
check('a path that is not an attachment is pasted as text, once', t3.split('/usr/bin/env').length === 2 && t3.length === before + '/usr/bin/env'.length, JSON.stringify(t3.slice(-40)));
done();
