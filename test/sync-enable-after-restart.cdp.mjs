// A two-way sync connection that is ALREADY configured must still be switchable on.
//
// The VPN sync method's enable is gated on its own connection having been proven:
// syncSmbTested() asks for a saved share AND a VPN config on disk. The second half
// was read from `_twHasSavedConf`, a session flag set only while IMPORTING or
// TESTING a config — and in updateTwowayConnView it was set only in the wizard
// branch. A profile whose connection is already configured takes the OTHER branch
// (the collapsed "Modifica" summary) and returns early, so the flag stayed false
// for the whole session: flipping the Sync switch bounced back with "test the
// connection first", nothing was saved, and the toolbar Sync icon never appeared.
// Reported 2026-10-12: "ho attivato il sync ma non vedo la icona di manual sync".
//
// Checked here, against the running app, on a profile that already has both halves
// (a .conf on disk and a saved share) — the state you are in after a restart:
//   · the section really is in its "configured" shape (so the early return is hit),
//   · the gate the switch consults says the connection is proven,
//   · flipping the switch STICKS, with no "test first" error,
//   · and the toolbar Sync icon stops being display:none.
//
// saveSettings is stubbed for the click: enabling the VPN method makes the main
// process reconcile the real WireGuard tunnel through NetworkManager, and a test
// must not touch the machine's VPN. Everything the bug lives in — the gate, the
// toggle, the icon — is renderer-side and still runs.
//
//   run: npm run test:syncenable     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-syncenable'; const VAULT = `${HOME}/vault`; const PORT = 9399;
const SETTINGS = `${HOME}/.local/share/amelie/settings.json`;
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
fs.mkdirSync(`${HOME}/.local/share/amelie/vpn`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/nota.md`, '---\ncreated: 2026-09-01 10:00\n---\n\ntesto\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
// Both halves of a finished VPN setup, exactly as a restart finds them: the .conf
// on disk (no NetworkManager import — confExists only reads the file) and the
// share saved under sync.twoway.smb. The method itself is still OFF: switching it
// on is what this test is about.
fs.writeFileSync(`${HOME}/.local/share/amelie/vpn/amelie-wg.conf`,
  '[Interface]\nPrivateKey = 4F7mYQ1Z3nQb5oG2sT8xK0pL6wR9dH3vC1aU7eJ5nXg=\nAddress = 10.100.0.5/32\nDNS = 10.100.0.1\n\n' +
  '[Peer]\nPublicKey = 9hT2kP0sX4mB7cV1zL6yA3nQ8wE5rJ2uD0fG4iO7bK=\nAllowedIPs = 10.100.0.0/24, 192.168.30.0/24\nEndpoint = vpn.example.org:51820\n');
fs.writeFileSync(SETTINGS, JSON.stringify({ autoSaveSeconds: 30, sync: {
  enabled: false,
  twoway: {
    enabled: false, transport: 'vpn', transportView: 'vpn', useWireGuard: true,
    smb: { host: '192.168.30.30', ip: '192.168.30.30', share: 'mercury',
           remoteSubPath: 'amelie/sync', username: 'u', password: 'p' },
    subPath: '', conflictCopies: true, propagateDeletes: true, intervalMinutes: 15,
  },
} }));

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
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
await sleep(2500);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };
const onScreen = id => ev(`(() => { const e = document.getElementById('${id}');
  if (!e) return 'missing'; const r = e.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) ? 'shown' : 'hidden'; })()`);

// ── The state a restart leaves behind ───────────────────────────────────────
await ev('openSettings()'); await sleep(900);
await ev(`document.querySelector('.tab-btn[data-tab="twoway"]').click()`); await sleep(900);
await ev(`document.getElementById('twsh-vpn').click()`); await sleep(700);

check('the icon starts hidden (nothing is switched on yet)',
  await ev(`document.getElementById('btn-sync').style.display === 'none'`) === true,
  await ev(`document.getElementById('btn-sync').style.display`));
{
  const ok = await onScreen('twoway-conn-ok');
  check('the VPN method shows its saved connection, not the import wizard',
    ok === 'shown', `twoway-conn-ok = ${ok} (the test needs the configured shape to be the one under test)`);
}
check('the switch asks the gate, and the gate sees a proven connection',
  await ev('syncSmbTested() === true') === true,
  `syncSmbTested() = ${await ev('String(syncSmbTested())')}, _twHasSavedConf = ${await ev('String(_twHasSavedConf)')}`);

// ── Flipping the switch ─────────────────────────────────────────────────────
// Stub the save (see the header): the gate, the toggle and the icon are all
// renderer-side, and the real save would reconcile the machine's VPN.
await ev(`(() => { window.__saved = []; window.saveSettings = async () => { window.__saved.push(state.config?.sync?.twoway?.enabled === true); }; return true; })()`);
await ev(`document.getElementById('cfg-tw-samba-enabled').click()`); await sleep(900);

check('the switch stays on', await ev(`document.getElementById('cfg-tw-samba-enabled').checked === true`) === true);
{
  const e = await onScreen('tw-method-error');
  check('with no "test the connection first" refusal', e !== 'shown',
    `tw-method-error = ${e}: "${await ev(`document.getElementById('tw-method-error')?.textContent`)}"`);
}
check('two-way sync is now enabled, on the VPN transport',
  await ev(`(() => { const t = state.config?.sync?.twoway || {}; return t.enabled === true && t.transport === 'vpn'; })()`) === true,
  JSON.stringify(await ev(`(() => { const t = state.config?.sync?.twoway || {}; return { enabled: t.enabled, transport: t.transport, useWireGuard: t.useWireGuard }; })()`)));
check('and it was saved that way, not just shown that way',
  await ev('window.__saved.includes(true)') === true,
  `saves seen: ${JSON.stringify(await ev('window.__saved'))} (false = a save ran while the switch was still off)`);

// The point of all of it: the manual-sync icon in the toolbar.
check('the toolbar Sync icon is no longer hidden',
  await ev(`document.getElementById('btn-sync').style.display !== 'none'`) === true,
  `btn-sync display = "${await ev(`document.getElementById('btn-sync').style.display`)}"`);

// Switching it back off hides it again — the icon follows the switch, both ways.
await ev(`document.getElementById('cfg-tw-samba-enabled').click()`); await sleep(700);
check('switching it off hides the icon again',
  await ev(`document.getElementById('btn-sync').style.display === 'none'`) === true,
  `btn-sync display = "${await ev(`document.getElementById('btn-sync').style.display`)}"`);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
