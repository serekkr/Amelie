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

// ── Reset puts the view back at once ────────────────────────────────────────
// It re-ran the whole layout (~0.7 s frozen on 1272 notes, then seconds settling);
// a wheel glide still under way zoomed on after it. Now: the frame, instantly.
await session(9492, async (ev, cdp) => {
  await ev(`(async () => { await loadTree(); await openMindmap(); return 1; })()`);
  for (let i = 0; i < 30; i++) { await sleep(500); if (await ev('mmAlpha < 0.002')) break; }
  const home = JSON.parse(await ev(`JSON.stringify((stopMindmapPhysics(), fitMindmapView(), { s: mmScale, x: mmOffset.x, y: mmOffset.y, pos: mmNodes.map((n) => [n.x, n.y]) }))`));
  // Zoom in with the wheel, and press Reset while the glide is still going.
  const c = JSON.parse(await ev(`JSON.stringify((() => { const r = document.getElementById('mindmap-canvas').getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + r.height * 0.3 }; })())`));
  for (let i = 0; i < 6; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY: -100 });
  await sleep(60);
  const took = await ev(`(() => { const t = performance.now(); document.getElementById('btn-mm-zoom-reset').click(); return performance.now() - t; })()`);
  const now = JSON.parse(await ev(`JSON.stringify({ s: mmScale, x: mmOffset.x, y: mmOffset.y })`));
  check('Reset frames the whole map at once', Math.abs(now.s - home.s) < 1e-6 && Math.abs(now.x - home.x) < 0.5 && Math.abs(now.y - home.y) < 0.5,
    JSON.stringify({ home: [home.s, home.x, home.y], now }));
  check('in well under a frame, not a re-layout', took < 16, `${took.toFixed(1)} ms`);
  await sleep(800);
  const later = JSON.parse(await ev(`JSON.stringify({ s: mmScale, pos: mmNodes.map((n) => [n.x, n.y]) })`));
  check('and the wheel glide under way does not zoom on after it', Math.abs(later.s - home.s) < 1e-6, String(later.s));
  check('the notes stay where they were: the view moved, not the map',
    later.pos.every((p, i) => Math.hypot(p[0] - home.pos[i][0], p[1] - home.pos[i][1]) < 1), 'nodes moved');

  // "Restore defaults": the picture the map opens with, without freezing on the way.
  await ev(`(() => { mmSet.fDist = 200; mmSet.fRepel = 20; saveMmSettings(); return 1; })()`);
  // What opening shows: the same steps, run now in one block, remembered.
  const opening = JSON.parse(await ev(`JSON.stringify((() => { const keep = mmNodes.map((n) => [n.x, n.y]); const s0 = Object.assign({}, mmSet);
    mmSet = Object.assign({}, MM_DEFAULTS); rebuildMindmapGraph(); layoutMindmap(); fitMindmapView();
    const out = { pos: mmNodes.map((n) => [n.x, n.y]), s: mmScale, x: mmOffset.x, y: mmOffset.y };
    mmSet = s0; mmNodes.forEach((n, k) => { n.x = keep[k][0]; n.y = keep[k][1]; }); return out; })())`));
  await ev(`(stopMindmapPhysics(), window._longest = 0, window._last = performance.now(), (function tick() { const t = performance.now(); window._longest = Math.max(window._longest, t - window._last); window._last = t; if (!window._stopTick) requestAnimationFrame(tick); })(), 1)`);
  // Catch the moment it is done — before the live settling moves anything. Armed
  // BEFORE the click: when the opening layout is remembered it is all over within it.
  await ev(`(window._doneP = new Promise((res) => { const orig = kickMindmap; kickMindmap = (a) => { kickMindmap = orig; res(JSON.stringify({ pos: mmNodes.map((n) => [n.x, n.y]), s: mmScale, x: mmOffset.x, y: mmOffset.y })); orig(a); }; setTimeout(() => res('null'), 8000); }), 1)`);
  const blocked = await ev(`(() => { const t = performance.now(); document.getElementById('btn-mm-restore').click(); return performance.now() - t; })()`);
  const done = JSON.parse(await ev(`window._doneP`));
  const longest = await ev(`(window._stopTick = true, window._longest)`);
  check('Restore defaults does not freeze the window', blocked < 20 && longest < 60, `click ${blocked.toFixed(1)} ms, longest frame ${longest.toFixed(0)} ms`);
  check('and the defaults are back', (await ev(`JSON.stringify([mmSet.fDist, mmSet.fRepel])`)) === JSON.stringify([90, 10]), await ev(`JSON.stringify([mmSet.fDist, mmSet.fRepel])`));
  check('it shows the very picture the map opens with', !!done && done.pos.length === opening.pos.length
    && done.pos.every((p, k) => Math.hypot(p[0] - opening.pos[k][0], p[1] - opening.pos[k][1]) < 0.01)
    && Math.abs(done.s - opening.s) < 1e-9 && Math.abs(done.x - opening.x) < 0.01, JSON.stringify(done && [done.s, opening.s]));
  check('then breathes into shape, as on opening', (await ev(`mmPhysicsRunning`)) === true);
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
