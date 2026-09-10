// The two startup switches that stopped being defaults need a way back on, and
// this is it: the pair of toggles in Settings. startup-flags.test.mjs holds what
// each setting MEANS; this holds that the UI can actually set it — the half that
// is worth nothing on its own, since the user whose compositor needs software
// compositing has no other way to ask for it.
//
// Checked here: both toggles exist, they start the right way round (GPU
// compositing on, low-memory off), the label is translated rather than the raw
// i18n key, a click reaches settings.json under the right key, and reopening
// Settings reads it back the same — the round trip, not just the write.
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
say('both toggles exist in Settings',
  await ev(`!!document.getElementById('cfg-gpu-compositing') && !!document.getElementById('cfg-low-memory')`) === true);
say('GPU compositing starts ON (fast) and low-memory starts OFF',
  await ev(`document.getElementById('cfg-gpu-compositing').checked === true && document.getElementById('cfg-low-memory').checked === false`) === true,
  await ev(`document.getElementById('cfg-gpu-compositing').checked + '/' + document.getElementById('cfg-low-memory').checked`));
say('the labels are translated, not the raw key',
  !/settings\.(sw_compositing|low_memory)/.test(await ev(`document.getElementById('cfg-gpu-compositing').closest('.field-group').textContent + document.getElementById('cfg-low-memory').closest('.field-group').textContent`) || 'x'));
await ev(`document.getElementById('cfg-gpu-compositing').click()`); await sleep(600);
await ev(`document.getElementById('cfg-low-memory').click()`); await sleep(900);
const c1 = JSON.parse(fs.readFileSync(SET, 'utf8'));
say('turning GPU compositing OFF writes softwareCompositing: true', c1.softwareCompositing === true, JSON.stringify(c1.softwareCompositing));
say('turning low-memory ON writes lowMemory: true', c1.lowMemory === true, JSON.stringify(c1.lowMemory));
await ev('closeSettings && closeSettings()'); await sleep(400);
await ev('openSettings()'); await sleep(1200);
say('and both come back the same way round after reopening Settings',
  await ev(`document.getElementById('cfg-gpu-compositing').checked === false && document.getElementById('cfg-low-memory').checked === true`) === true,
  await ev(`document.getElementById('cfg-gpu-compositing').checked + '/' + document.getElementById('cfg-low-memory').checked`));
await ev(`document.getElementById('cfg-gpu-compositing').click()`); await sleep(800);
const c2 = JSON.parse(fs.readFileSync(SET, 'utf8'));
say('and back ON writes softwareCompositing: false', c2.softwareCompositing === false, JSON.stringify(c2.softwareCompositing));
console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
