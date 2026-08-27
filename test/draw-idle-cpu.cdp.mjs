// A drawing sitting open must not cost a CPU core — and must still repaint.
//
// canvas.html keeps the iframe's compositor layer dirty so the software
// compositor re-reads the canvas instead of showing a stale frame. That tick
// used to run every frame forever, and with GPU compositing off (main.js) every
// one of those frames is a full software recomposite of the drawing. Measured:
// 108% of a core with a drawing merely OPEN and untouched, 4% with the tick
// detached — the entire cost was the workaround, not Excalidraw.
//
// The tick now runs only while something can have changed (pointer, key, scene
// change, load, resize) and stops shortly after. This test holds both ends of
// that: the idle cost, and that a stroke still reaches the screen — the second
// half is what a naive "just delete the tick" fix would break, and it is checked
// on the composited pixels, not on the scene data.
//
//   run: npm run test:drawcpu     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-drawcpu-test'; const VAULT = `${HOME}/vault`; const PORT = 9375;
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
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
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
const send = (method, params) => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result)); ws.send(JSON.stringify({ id: my, method, params })); setTimeout(() => { if (pending.delete(my)) res(null); }, 20000); });
const ev = x => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then(r => r?.result?.value);
await sleep(1800);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// CPU of the WHOLE process tree — the compositing happens outside the renderer.
const tree = () => execSync(`pgrep -g ${child.pid} 2>/dev/null || true`).toString().trim().split('\n').filter(Boolean);
const cpuTicks = () => { let t = 0; for (const pid of tree()) { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const p = f.slice(f.lastIndexOf(')') + 2).split(' '); t += Number(p[11]) + Number(p[12]); } catch (_) {} } return t; };
const measure = async (ms) => { const a = cpuTicks(), t0 = Date.now(); await sleep(ms); return 100 * ((cpuTicks() - a) / 100) / ((Date.now() - t0) / 1000); };

const idleNotes = await measure(4000);
await ev(`newDraw()`);
await sleep(5000);
check('the drawing opened', (await ev(`!!document.getElementById('canvas-iframe')`)) === true, 'no canvas iframe');

const idleDraw = await measure(7000);
check(`a drawing left open costs almost nothing (${idleDraw.toFixed(0)}% of a core, notes view ${idleNotes.toFixed(0)}%)`,
  idleDraw < 35, `${idleDraw.toFixed(0)}% — the shipped every-frame tick measured 108%`);

// Draw a real stroke through the debugger and compare the COMPOSITED pixels:
// the scene data changing proves nothing about what reached the screen.
const box = await ev(`(() => { const r = document.getElementById('canvas-iframe').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
const shot = async () => (await send('Page.captureScreenshot', { format: 'png' }))?.data || '';
// Did the SCENE change, as opposed to the screen? The canvas reports every
// mutation to the parent as CANVAS_CHANGE, so listening for that says whether
// the stroke was drawn at all — which separates "the fix broke painting" from
// "the synthetic mouse drew nothing", two failures that look identical here.
await ev(`(() => { window.__lastElems = -1;
  window.addEventListener('message', e => {
    if (e.data && e.data.type === 'CANVAS_CHANGE') {
      try { window.__lastElems = (JSON.parse(e.data.json).elements || []).length; } catch (_) {}
    }
  });
  return 1 })()`);
const x0 = box.x + box.w * 0.35, y0 = box.y + box.h * 0.45;
// Excalidraw starts on the SELECTION tool, where dragging only draws a marquee
// and creates nothing. Click into the canvas to give it the keyboard, then pick
// the rectangle tool ("2") — a deterministic shape, unlike a freehand stroke.
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', clickCount: 1 });
await sleep(300);
for (const type of ['keyDown', 'char', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, text: '2', key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 });
}
await sleep(300);
const before = await shot();
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
for (let i = 1; i <= 30; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + i * 8, y: y0 + i * 4, button: 'left' });
  await sleep(16);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + 240, y: y0 + 120, button: 'left', clickCount: 1 });
await sleep(1200);
const after = await shot();
const elems = await ev(`window.__lastElems`);
check(`the stroke was actually drawn into the scene (${elems} element(s))`,
  elems > 0, `no CANVAS_CHANGE carrying an element — the synthetic pointer drew nothing, so the screen check below would be meaningless`);
check('and it reached the screen (the frame is not stale)',
  !!before && !!after && before !== after, 'the composited frame did not change after drawing');

// Once the hand stops, the cost must go back down — that is the whole point.
await sleep(1500);
const idleAfter = await measure(7000);
check(`the cost drops again once drawing stops (${idleAfter.toFixed(0)}% of a core)`,
  idleAfter < 35, `${idleAfter.toFixed(0)}%`);

console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
