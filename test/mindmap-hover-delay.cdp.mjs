// On the mind map the note under the pointer lights up at once; its TITLE waits.
//
// Asked 2026-09-29: passing the mouse over the map flashed every title on the way,
// so titles came to wait MM_HOVER_DELAY (1 s) on the same note. That version held
// back the colour too — nothing lit up any more, and the note dragged last stayed
// lit, so pointing at one note looked like selecting another far away ("clicco su
// una nota e seleziona quella più lontano", "non si attivano colorati come prima").
// Now the note and its links light at once and take over from the dragged one;
// the title follows after 1 s; leaving puts both out; a real click opens it.
//
// Drives the real app: real mouse events on the real canvas, and real input
// (CDP Input.dispatchMouseEvent) for the click.
//
//   run: npm run test:mmhover     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-mmhover'; const VAULT = `${HOME}/vault`;
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
fs.writeFileSync(`${VAULT}/notes/centro.md`, fm + '[[uno]] [[due]]\n');
fs.writeFileSync(`${VAULT}/notes/uno.md`, fm + 'uno\n');
fs.writeFileSync(`${VAULT}/notes/due.md`, fm + 'due\n');
fs.writeFileSync(`${VAULT}/notes/sola.md`, fm + 'sola\n');
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

// Move the pointer onto a note (by label) or to an empty corner.
const move = (label) => `(() => {
  const c = document.getElementById('mindmap-canvas'), r = c.getBoundingClientRect();
  let x = r.left + 3, y = r.top + 3;
  if (${JSON.stringify(label)}) {
    const n = mmNodes.find((n) => (n.displayLabel || n.label) === ${JSON.stringify(label)});
    if (!n) return 'no node';
    x = r.left + n.x * mmScale + mmOffset.x; y = r.top + n.y * mmScale + mmOffset.y;
  }
  c.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  return 'ok';
})()`;
const lit = `mmFocusState().title`;
const colour = `mmFocusState().lit`;
const cursor = `document.getElementById('mindmap-canvas').style.cursor`;

await session(9431, async (ev, cdp) => {
  await ev(`(async () => { await loadTree(); await openMindmap(); return 1; })()`);
  await sleep(4000);                    // let the layout settle
  await ev(`stopMindmapPhysics(); 1`);  // nodes stay put while we point at them
  const labels = await ev(`JSON.stringify(mmNodes.map((n) => n.displayLabel || n.label))`);
  check('the map shows the notes', /centro/.test(labels || ''), labels);

  const r = await ev(move('centro'));
  check('pointing at a note', r === 'ok', r);
  check('the pointer changes at once', (await ev(cursor)) === 'pointer', await ev(cursor));
  check('and the note lights up at once, with its links', (await ev(colour)) === 'centro', await ev(colour));
  await sleep(300);
  check('but after 0.3 s its title is not up yet', (await ev(lit)) === null, await ev(lit));
  await sleep(1000);
  check('after resting 1 s its title comes up', (await ev(lit)) === 'centro', await ev(lit));

  await ev(move(null));
  check('leaving it puts it out at once', (await ev(lit)) === null, await ev(lit));

  // A sweep: over "sola" for 0.4 s, then on to empty space.
  await ev(move('sola')); await sleep(400); await ev(move(null)); await sleep(1000);
  check('a note only swept across never shows its title', (await ev(lit)) === null, await ev(lit));

  await ev(move('uno')); await sleep(1200);
  await ev(`document.getElementById('mindmap-canvas').dispatchEvent(new MouseEvent('mouseleave')); 1`);
  check('leaving the map puts it out too', (await ev(lit)) === null && (await ev(colour)) === null, await ev(colour));

  // The note dragged last stays lit — until the pointer is on another one.
  await ev(`(() => { mmFocusNode = mmNodes.find((n) => (n.displayLabel || n.label) === 'uno'); drawMindmap(); return 1; })()`);
  check('with nothing pointed at, the note dragged last is the lit one', (await ev(colour)) === 'uno', await ev(colour));
  await ev(move('due'));
  check('pointing at another note lights that one instead, at once', (await ev(colour)) === 'due', await ev(colour));
  await ev(move(null));

  // A real click (through the browser's own hit-testing) opens the note under it.
  const p = JSON.parse(await ev(`(() => { const c = document.getElementById('mindmap-canvas'), r = c.getBoundingClientRect();
    const n = mmNodes.find((n) => (n.displayLabel || n.label) === 'sola');
    return JSON.stringify({ x: r.left + n.x * mmScale + mmOffset.x, y: r.top + n.y * mmScale + mmOffset.y }); })()`));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  check('a click on a note opens that note', (await ev('state.currentPath')) === 'sola.md', await ev('state.currentPath'));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
