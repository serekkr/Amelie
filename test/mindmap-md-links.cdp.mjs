// The mind map draws markdown links between notes, and the wheel zoom glides.
//
// Compared on 2026-09-29 with a screen recording of the same vault in Obsidian:
// there, an index note (HackTheBox-boxes/README.md) sits in a round cluster of the
// sixty pages it links as `[Legacy - Easy](Legacy.md)`; in Amelie it was an island,
// because only [[wiki links]] were counted — 271 lines on the map instead of 432.
// And each wheel notch jumped 10% at once, where Obsidian's zoom glides.
//
// Drives the real app: real notes on disk, the real graph, a real wheel event.
//
//   run: npm run test:mmlinks     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-mmlinks'; const VAULT = `${HOME}/vault`;
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
const w = (rel, body) => { fs.mkdirSync(`${VAULT}/notes/${rel}`.replace(/\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(`${VAULT}/notes/${rel}`, fm + body); };
const INDEX = ['1. [Legacy - Easy](Legacy.md)', '2. [Forest](Forest.md#enum "titolo")', '3. [Lame](<Lame box.md>)',
  '4. [Su](../Altro/Sopra.md)', '5. [Spazi](Heist%20Box.md)', '6. [sito](https://example.com/x.md)', '7. ![img](Legacy.md)',
  '8. [manca](Inesistente.md)'].join('\n') + '\n';
w('Boxes/README.md', INDEX);
for (const n of ['Legacy', 'Forest', 'Lame box', 'Heist Box']) w(`Boxes/${n}.md`, n + '\n');
w('Altro/Sopra.md', 'sopra\n');
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
        await body(ev);
    ws.close();
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

await session(9471, async (ev) => {
  await ev(`(async () => { await loadTree(); await openMindmap(); return 1; })()`);
  await sleep(3000);
  const links = JSON.parse(await ev(`JSON.stringify(mmRaw.wikiLinks.filter((l) => l.from === 'Boxes/README.md').map((l) => l.to).sort())`));
  check('a markdown link to a note in the same folder is a link on the map', links.includes('Boxes/Legacy.md'), JSON.stringify(links));
  check('…with a #heading and a "title" too', links.includes('Boxes/Forest.md'), JSON.stringify(links));
  check('…written <with spaces.md>, or with %20', links.includes('Boxes/Lame box.md') && links.includes('Boxes/Heist Box.md'), JSON.stringify(links));
  check('…and ../ reaches the folder above', links.includes('Altro/Sopra.md'), JSON.stringify(links));
  check('a web address, an image and a missing note are not', links.length === 5, JSON.stringify(links));
  const conns = await ev(`(mmNodes.find((n) => n.path === 'Boxes/README.md') || {})._conns`);
  check('the index note is drawn with its five links', conns === 5, String(conns));

  // Shift+drag between two notes linked only by markdown must not touch the text.
  const before = fs.readFileSync(`${VAULT}/notes/Boxes/README.md`, 'utf8');
  await ev(`(async () => { const a = mmNodes.find((n) => n.path === 'Boxes/README.md'), b = mmNodes.find((n) => n.path === 'Boxes/Legacy.md'); await toggleMindmapLink(a, b); return 1; })()`);
  await sleep(600);
  check('connecting two notes a markdown link already joins leaves the note as it was',
    fs.readFileSync(`${VAULT}/notes/Boxes/README.md`, 'utf8') === before && fs.readFileSync(`${VAULT}/notes/Boxes/Legacy.md`, 'utf8') === fm + 'Legacy\n');

  // One wheel notch: a glide, not a jump, around the point under the cursor.
  const r = JSON.parse(await ev(`(() => { fitMindmapView(); drawMindmap(); const c = document.getElementById('mindmap-canvas'), r = c.getBoundingClientRect();
    const sx = r.width * 0.3, sy = r.height * 0.4; window._w = { x: (sx - mmOffset.x) / mmScale, y: (sy - mmOffset.y) / mmScale, sx, sy, s0: mmScale };
    c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: r.left + sx, clientY: r.top + sy }));
    return JSON.stringify({ s0: window._w.s0, now: mmScale }); })()`));
  check('right after the notch the zoom has not jumped yet', r.now === r.s0, JSON.stringify(r));
  await sleep(120);
  const mid = await ev(`mmScale / window._w.s0`);
  check('a few frames later it is on its way', mid > 1.005 && mid < 1.10, String(mid));
  await sleep(900);
  const end = JSON.parse(await ev(`JSON.stringify({ k: mmScale / window._w.s0, dx: window._w.x * mmScale + mmOffset.x - window._w.sx, dy: window._w.y * mmScale + mmOffset.y - window._w.sy })`));
  check('and settles about 10% closer, as a notch did before', Math.abs(end.k - Math.exp(0.1)) < 0.002, JSON.stringify(end));
  check('with the point under the cursor still under it', Math.abs(end.dx) < 0.5 && Math.abs(end.dy) < 0.5, JSON.stringify(end));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
