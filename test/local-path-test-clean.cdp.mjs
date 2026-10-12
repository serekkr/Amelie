// "Test connection" on the Local backup destination must leave the disk as it found it.
//
// Reported on 2026-10-12 from a fresh install: typing a path and pressing test
// answered "okay, folder created" — and kept the folder. A test proves a backup COULD
// be written there; it is not a reason to start making folders on someone's disk.
// Now it makes what it needs to try, and removes exactly that again.
//
// Driven through the real IPC handler in the main process (window.inkwell.testLocalPath),
// with the disk checked from outside the app — the answer the handler returns is not
// the thing under test, what is left behind is.
//
//   run: npm run test:pathtest     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-pathclean'; const VAULT = `${HOME}/vault`; const PORT = 9413;
const SCRATCH = `${HOME}/prove`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-09-01 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 20000); });
await sleep(2600);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };
const test = (p) => ev(`window.inkwell.testLocalPath(${JSON.stringify(p)})`);

// 1. A path that does not exist, three levels deep.
{
  const deep = `${SCRATCH}/a/b/c`;
  const r = await test(deep);
  check('a path that is not there yet passes the test', r && r.ok === true, JSON.stringify(r));
  check('and the test says it will have to be created', r && r.created === true, JSON.stringify(r));
  check('and not one of its three levels is left on disk',
    !fs.existsSync(`${SCRATCH}/a`), fs.readdirSync(SCRATCH).join());
}

// 2. A folder that is already there keeps everything it holds.
{
  const live = `${SCRATCH}/esistente`;
  fs.mkdirSync(live); fs.writeFileSync(`${live}/mio.txt`, 'x');
  const r = await test(live);
  check('an existing folder passes too', r && r.ok === true && r.created === false, JSON.stringify(r));
  check('it is still there, with what was in it',
    fs.existsSync(live) && fs.readdirSync(live).join() === 'mio.txt', fs.readdirSync(live).join());
}

// 3. A new folder under a parent that exists: only the new one goes.
{
  const parent = `${SCRATCH}/padre`;
  fs.mkdirSync(parent); fs.writeFileSync(`${parent}/altro.txt`, 'y');
  const r = await test(`${parent}/nuovo`);
  check('a new folder under an existing parent passes', r && r.ok === true && r.created === true, JSON.stringify(r));
  check('the new one is gone, the parent and its file untouched',
    !fs.existsSync(`${parent}/nuovo`) && fs.readdirSync(parent).join() === 'altro.txt', fs.readdirSync(parent).join());
}

// 4. The probe file it writes to prove it can write never survives either.
{
  const live = `${SCRATCH}/esistente`;
  await test(live);
  check('no probe file is left behind', fs.readdirSync(live).join() === 'mio.txt', fs.readdirSync(live).join());
}

// (A path that cannot be written — /proc/… — is NOT checked here: this machine runs
//  the suite in a sandbox that intercepts the write and never answers, so the case
//  would be measuring the sandbox. The refusal path itself is the try/catch that was
//  already there and is untouched by this change.)

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
