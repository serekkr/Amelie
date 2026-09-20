// Dragging a zoomed image to move around it.
//
// The viewer grew the picture inside a scrolling box and left the scrollbars as the
// only way to reach the middle of it — and those live on the frame's right and bottom
// edges, so getting to the centre of a tall photo meant going to a corner first
// (reported 2026-09-20). Press and drag now pans, with the hand cursor that says so.
//
// The trap this guards: an <img> starts the browser's OWN drag-and-drop on press, which
// swallows the gesture before any pan begins. That is a one-line failure (-webkit-user-drag
// / preventDefault) and invisible to every unit test, so it is checked here on the real app.
//
// Also here: the zoom itself. It stopped having any visible effect after one click —
// an <img> is a flex item, a flex item will not shrink below its INTRINSIC width, so
// `width: 6240px` on a 2400px photo rendered 2400px and every further click grew a
// number nobody could see. Rendered width is what these check, never the CSS value.
//
//   run: npm run test:imgpan     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-imgpan'; const VAULT = `${HOME}/vault`; const PORT = 9383;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display'); process.exit(0);
  }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
// A picture comfortably larger than the pane, in both directions.
execSync(`python3 -c "
from PIL import Image
Image.new('RGB',(2400,1800),(30,90,140)).save('${VAULT}/attachments/big.png')
"`);
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

// The vault files images under attachments/images/ (the attachment-location tidy-up
// moves anything dropped at the root), so that — not the bare name — is what the
// inkwell:// handler resolves.
await ev(`openImageFile({ name: 'big.png', attachmentName: 'images/big.png', path: 'attachments/images/big.png' })`);
await sleep(1500);
say('the image viewer opened', await ev(`getComputedStyle(document.getElementById('img-view-overlay')).display !== 'none'`) === true);
say('and the picture loaded', await ev(`document.getElementById('img-view-content').naturalWidth`) === 2400,
  String(await ev(`document.getElementById('img-view-content').naturalWidth`)));

// The native image drag must be off, or the press is stolen before a pan starts.
say('the image cannot start a native drag',
  await ev(`getComputedStyle(document.getElementById('img-view-content')).webkitUserDrag === 'none'`) === true,
  await ev(`getComputedStyle(document.getElementById('img-view-content')).webkitUserDrag`));

await ev(`setImgZoom(3)`); await sleep(500);
say('zooming makes the frame pannable',
  await ev(`document.getElementById('img-view-embed').classList.contains('pannable')`) === true);
say('the hand cursor is showing',
  await ev(`getComputedStyle(document.getElementById('img-view-embed')).cursor`) === 'grab',
  await ev(`getComputedStyle(document.getElementById('img-view-embed')).cursor`));

// Drag from the MIDDLE of the frame — the whole point is not having to reach an edge.
const drag = `(() => {
  const box = document.getElementById('img-view-embed');
  const r = box.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  box.scrollLeft = 300; box.scrollTop = 300;
  const before = { l: box.scrollLeft, t: box.scrollTop };
  const opts = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
  const down = new PointerEvent('pointerdown', opts(cx, cy));
  box.dispatchEvent(down);
  const grabbing = getComputedStyle(box).cursor;
  box.dispatchEvent(new PointerEvent('pointermove', opts(cx - 120, cy - 90)));
  const after = { l: box.scrollLeft, t: box.scrollTop };
  box.dispatchEvent(new PointerEvent('pointerup', opts(cx - 120, cy - 90)));
  return { before, after, grabbing, defaultPrevented: down.defaultPrevented, released: getComputedStyle(box).cursor };
})()`;
const d = await ev(drag);
// Within a pixel and a half: a scroll offset is not an integer — the browser reports it
// in layout units that fall between device pixels, and the vertical one duly came back
// as 390.43 for a 90px drag. Asserting equality here would fail on arithmetic that is
// actually correct.
const near = (a, b) => Math.abs(a - b) < 1.5;
say('dragging from the middle moves the view horizontally', d && near(d.after.l, d.before.l + 120), JSON.stringify(d));
say('and vertically', d && near(d.after.t, d.before.t + 90), JSON.stringify(d));
say('the press is taken by the pan, not by the browser', d && d.defaultPrevented === true, JSON.stringify(d));
say('the cursor closes to a fist while dragging', d && d.grabbing === 'grabbing', JSON.stringify(d && d.grabbing));
say('and opens again when released', d && d.released === 'grab', JSON.stringify(d && d.released));

// ── Zoom: every click has to move the PICTURE, not just the number ───────────
const shownW = () => ev(`Math.round(document.getElementById('img-view-content').getBoundingClientRect().width)`);
await ev(`setImgZoom(1)`); await sleep(400);
const at100 = await shownW();
say('at 100% the picture is fitted to the frame', at100 > 0 && at100 <= 1200, String(at100));

const widths = [at100];
for (let i = 0; i < 6; i++) { await ev(`document.getElementById('img-zoom-in').click()`); await sleep(220); widths.push(await shownW()); }
say('six clicks of zoom-in grow it every single time',
  widths.every((w, i) => i === 0 || w > widths[i - 1]), JSON.stringify(widths));
say('and it goes well past the old ceiling of one step',
  widths[widths.length - 1] > at100 * 2, JSON.stringify(widths));

// The label has to mean what it says: 200% is twice the 100% width.
await ev(`setImgZoom(2)`); await sleep(400);
const at200 = await shownW();
say('200% really is twice the size shown at 100%', Math.abs(at200 - at100 * 2) <= 3, `${at100} -> ${at200}`);
say('and the label agrees', await ev(`document.getElementById('img-zoom-label').textContent`) === '200%',
  await ev(`document.getElementById('img-zoom-label').textContent`));

// Back to a size that fits: no hand, nothing to promise.
await ev(`setImgZoom(0.2)`); await sleep(400);
say('an image that fits offers no hand',
  await ev(`document.getElementById('img-view-embed').classList.contains('pannable')`) === false,
  await ev(`getComputedStyle(document.getElementById('img-view-embed')).cursor`));
console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
