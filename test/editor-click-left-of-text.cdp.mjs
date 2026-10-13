// Clicking in the empty strip to the LEFT of the text puts the caret at the start of
// that line — instead of doing nothing at all.
//
// serekkr, 13/10/2026: clicking near the beginning of the lines under a `## heading`
// did not put the caret where he aimed. Measured: a click ON the text is exact (every
// line, heading or not, lands on its first character), but the strip to its left — the
// scroller's 48px padding, and the line-number gutter when it is on — swallowed the
// click: the caret stayed wherever it had been. That strip is wide and it is exactly
// where you land when you aim at the beginning of a line.
//
// Drives the real app with real mouse events through CDP, because this is about where
// a click lands: a synthetic event dispatched on an element would prove nothing.
//
//   run: npm run test:leftclick     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const PORT = 9371;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-leftclick-'));
const HOME = `${ROOT}/home`, VAULT = `${HOME}/vault`;
const BODY = '---\ncreated: 2026-10-13 09:00\nmodified: 2026-10-13 09:00\n---\n\n'
  + '## Prima sezione\nriga sotto la sezione\nancora una riga\n\n'
  + 'riga senza titolo sopra\n## Seconda sezione\nriga dopo la seconda\n';
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/prova.md`, BODY);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
const child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} fs.rmSync(ROOT, { recursive: true, force: true }); });
let err = ''; child.stderr.on('data', d => { err += d; });
setTimeout(() => { console.error('TIMEOUT\n' + err.slice(-1000)); process.exit(2); }, 90000);

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('no app\n' + err.slice(-1000)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise(res => { const my = ++id; pend.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); setTimeout(() => { if (pend.delete(my)) res(null); }, 20000); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))?.result?.result?.value;
await sleep(2000);

const ok = []; const say = (n, pass, d = '') => { ok.push(!!pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${d}`}`); };

await ev(`openNote((state.notes||[]).find(n => n.name === 'prova'))`);
await sleep(1200);
await ev(`setViewMode('edit')`);
await sleep(800);

const lines = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#cm-mount .cm-line')].map(l => { const r = l.getBoundingClientRect(); return { text: l.textContent, y: Math.round(r.y + r.height / 2) }; }))`));
const content = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('#cm-mount .cm-content').getBoundingClientRect(); return { x: Math.round(r.x) }; })())`));
say('the note is open in edit mode with its lines on screen', lines.length >= 7, JSON.stringify(lines.map(l => l.text)));

const clickAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(140);
  const sel = await ev(`editor.selectionStart`);
  const start = await ev('(() => { const v = editor.value, s = ' + sel + '; return v.lastIndexOf(String.fromCharCode(10), Math.max(0, s - 1)) + 1; })()');
  return { sel, start };
};

// 1. On the text: every line lands on its own first character, heading or not.
let offText = [];
for (const ln of lines) {
  const r = await clickAt(content.x + 1, ln.y);
  if (r.sel !== r.start) offText.push(`${ln.text.slice(0, 20)}: +${r.sel - r.start}`);
}
say('a click on the first character lands there, on every line', offText.length === 0, offText.join(' | '));

// 2. In the strip to its left: this is what did nothing.
//
// Checked against where the line ACTUALLY starts in the document, computed from the
// text — not against where the caret happened to land. Asking "is the caret at the
// start of whatever line it is on" is the one question a click that did nothing also
// answers yes to, and parking the caret at 0 beforehand made that the default.
const doc = await ev(`editor.value`);
const starts = [];
{ let at = 0; for (const t of doc.split('\n')) { starts.push(at); at += t.length + 1; } }
const park = doc.length;   // caret far from every line start we are about to click
let wrong = [];
for (let i = 0; i < lines.length; i++) {
  await ev(`editor.setSelectionRange(${park}, ${park})`);
  await sleep(60);
  const r = await clickAt(content.x - 20, lines[i].y);
  if (r.sel !== starts[i]) wrong.push(`"${lines[i].text.slice(0, 20)}": caret ${r.sel}, line starts ${starts[i]}`);
}
say('a click LEFT of the text puts the caret at the start of that line', wrong.length === 0, wrong.join(' | '));

// 3. The lines under a heading specifically — the case that was reported.
await ev(`editor.setSelectionRange(${park}, ${park})`);
await sleep(60);
const r3 = await clickAt(content.x - 20, lines[1].y);
say('including the line right under a "## heading"', r3.sel === starts[1] && starts[1] > 0,
  `caret ${r3.sel}, expected ${starts[1]}`);

console.log(`\n${ok.every(Boolean) ? `all ${ok.length}` : `${ok.filter(Boolean).length}/${ok.length}`} passed`);
process.exit(ok.every(Boolean) ? 0 : 1);
