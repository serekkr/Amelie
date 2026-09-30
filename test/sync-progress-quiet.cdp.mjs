// The sidebar's sync line stays quiet while an AUTOMATIC pass only reads the server.
//
// Reported 2026-09-29: "backup complete" and "sync" on the line far too often. The
// two-way pass runs every 30 s and reading ~1260 files on the share over the VPN
// takes ~15 s, so "Sync · reading the server" was up for half of every minute
// while nothing moved. Now it shows for a sync you asked for; an automatic one
// appears only when a file actually moves, and a "done" line still fades out.
//
// Feeds the real renderer the events SyncManager sends (sync:progress).
//
//   run: npm run test:syncquiet     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-syncquiet'; const VAULT = `${HOME}/vault`;
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
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/a.md`, 'a\n');
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

const send = (p) => `(renderSyncProgress(${JSON.stringify(p)}), 1)`;
const shown = `getComputedStyle(document.getElementById('sync-progress')).display !== 'none'`;
const text = `document.getElementById('sync-progress-text').textContent`;

await session(9451, async (ev) => {
  await ev(send({ op: 'twoway', phase: 'listing', manual: false }));
  await sleep(1500);
  check('an automatic pass reading the server shows nothing', (await ev(shown)) === false, await ev(text));
  await ev(send({ op: 'twoway', final: true, total: 0 }));
  await sleep(300);
  check('and ends as quietly, when it moved nothing', (await ev(shown)) === false, await ev(text));

  await ev(send({ op: 'twoway', phase: 'listing', manual: true }));
  await sleep(1500);
  check('a sync you asked for says it is reading the server', (await ev(shown)) === true, await ev(text));
  await ev(send({ op: 'twoway', final: true, total: 0 }));

  await ev(send({ op: 'twoway', phase: 'listing', manual: false }));
  await ev(send({ op: 'twoway', phase: 'transfer', done: 1, total: 2, action: 'download', file: 'notes/x.md' }));
  await sleep(200);
  check('an automatic pass that moves a file does show it', (await ev(shown)) === true && /1\/2/.test(await ev(text)), await ev(text));
  await ev(send({ op: 'twoway', final: true, total: 2 }));
  await sleep(200);
  check('…and says it is done', (await ev(shown)) === true, await ev(text));
  // The next automatic pass starts while "done" is still fading out.
  await ev(send({ op: 'twoway', phase: 'listing', manual: false }));
  await sleep(3200);
  check('a new automatic pass does not keep the "done" line up', (await ev(shown)) === false, await ev(text));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
