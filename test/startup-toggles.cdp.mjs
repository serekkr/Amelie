// Neither startup switch has a toggle any more: GPU compositing lost its row on
// 2026-09-20 for reading as "GPU rendering" said twice, and low-memory lost its the
// same day, once measuring showed what it was worth on the machine in question
// (302 MB PSS of 31.6 GB, with the 512 MB V8 cap never binding).
//
// Both settings still WORK from settings.json — startup-flags.test.mjs owns that half
// and is unchanged. What is left to check here is the half a unit test cannot see: the
// rows really are gone from the running app, and the one remaining GPU control is not.
// Asserted rather than merely untested, because startupFlags.js still reads both keys,
// so nothing else would notice a row quietly coming back.
//
//   run: npm run test:gpuflags     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-toggles'; const VAULT = `${HOME}/vault`; const PORT = 9379;
const SET = `${HOME}/.local/share/amelie/settings.json`;
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
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(SET, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
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
await sleep(2500);
await ev('openSettings()'); await sleep(1200);
const ok = [];
const say = (n, p, d = '') => { ok.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : '  — ' + d}`); };
say('the low-memory row is gone',
  await ev(`!document.getElementById('cfg-low-memory')`) === true);
say('the GPU compositing row is gone',
  await ev(`!document.getElementById('cfg-gpu-compositing')`) === true);
say('the GPU rendering row is still there',
  await ev(`!!document.getElementById('cfg-disable-gpu')`) === true);
say('its label is translated, not the raw key',
  !/settings\.disable_gpu/.test(await ev(`document.getElementById('cfg-disable-gpu').closest('.field-group').textContent`) || 'x'));
// Neither key may be written behind the user's back now that nothing in the UI sets them.
await ev('closeSettings && closeSettings()'); await sleep(600);
const c1 = JSON.parse(fs.readFileSync(SET, 'utf8'));
say('closing Settings writes neither lowMemory nor softwareCompositing',
  c1.lowMemory === undefined && c1.softwareCompositing === undefined,
  JSON.stringify({ lowMemory: c1.lowMemory, softwareCompositing: c1.softwareCompositing }));

console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
