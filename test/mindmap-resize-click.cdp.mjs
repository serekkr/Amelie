// A click on the mind map hits the note drawn under the pointer, after the map's box changed.
//
// Reported 2026-09-29: "clicco su una nota e si seleziona quella molto più a destra".
// The canvas's pixels were sized once, when the map opened; widening the window or
// folding the sidebar with the map open made the browser STRETCH the old drawing
// over the new box, while clicks were read unstretched — so each one landed on a
// note further right, the more so the further right it was. Now the canvas follows
// its box (ResizeObserver) and the pointer is read in the canvas's own pixels.
//
// Drives the real app: the sidebar folded with the map open, then real clicks
// (CDP Input.dispatchMouseEvent) on notes across the map.
//
//   run: npm run test:mmresize     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-mmresize'; const VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
for (let i = 0; i < 40; i++) fs.writeFileSync(`${VAULT}/notes/n${i}.md`, fm + (i % 4 ? `[[n${i - 1}]]` : '') + '\n');
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

async function session(port, body) {
  const eargs = ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic'];
  const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
  const child = xvfb
    ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: 'ignore' })
    : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
    if (!target) throw new Error('app did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
    const ev = (x) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); });
    await sleep(3000);
        const cdp = (method, params) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result)); ws.send(JSON.stringify({ id: my, method, params })); });
    await body(ev, cdp);
    ws.close();
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

// Where a note is DRAWN on screen — through any stretch the browser applies.
const drawnAt = (label) => `(() => { const c = document.getElementById('mindmap-canvas'), r = c.getBoundingClientRect(), d = c._dpr || 1;
  const n = mmNodes.find((n) => n.label === ${JSON.stringify(label)});
  return JSON.stringify({ x: r.left + (n.x * mmScale + mmOffset.x) * r.width / (c.width / d), y: r.top + (n.y * mmScale + mmOffset.y) * r.height / (c.height / d) }); })()`;

await session(9491, async (ev, cdp) => {
  await ev(`(async () => { await loadTree(); await openMindmap(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev('mmAlpha < 0.002')) break; }
  await ev(`stopMindmapPhysics(); 1`);
  const before = JSON.parse(await ev(`JSON.stringify((() => { const c = document.getElementById('mindmap-canvas'); return { box: Math.round(c.getBoundingClientRect().width), px: c.width / (c._dpr || 1) }; })())`));
  // Fold the sidebar with the map open: the map's box grows.
  await ev(`(() => { document.getElementById('sidebar').style.display = 'none'; return 1; })()`);
  await sleep(800);
  const after = JSON.parse(await ev(`JSON.stringify((() => { const c = document.getElementById('mindmap-canvas'); return { box: Math.round(c.getBoundingClientRect().width), px: c.width / (c._dpr || 1) }; })())`));
  check('folding the sidebar widens the map', after.box > before.box + 50, JSON.stringify({ before, after }));
  check('and the canvas is re-sized to its new box, not stretched', Math.abs(after.px - after.box) <= 1, JSON.stringify(after));

  // The rightmost, a middle and the leftmost note — a stretch shows most on the right.
  const order = JSON.parse(await ev(`JSON.stringify([...mmNodes].sort((a, b) => a.x - b.x).map((n) => n.label))`));
  for (const label of [order[order.length - 1], order[order.length >> 1], order[0]]) {
    await ev(`(async () => { if (!tabs.some((t) => t.type === 'mindmap')) { await openMindmap(); await new Promise((r) => setTimeout(r, 1500)); stopMindmapPhysics(); } return 1; })()`);
    const p = JSON.parse(await ev(drawnAt(label)));
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    const got = await ev('state.currentPath');
    check(`a click on "${label}" opens "${label}"`, got === `${label}.md`, `opened ${got}`);
  }
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
