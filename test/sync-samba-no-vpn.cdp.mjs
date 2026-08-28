// Setting up the Sync tab's Samba method must not need a VPN, and saving its
// share must not turn it back into one.
//
// Two faults, both found by hand and neither reachable from the unit suite —
// one lived in the renderer, the other in the MAIN process:
//
//   1. The Samba method had no panel of its own: it shared the VPN wizard, and
//      the share fields were hidden behind the "already configured" summary —
//      so its screen showed nothing to fill in, and the VPN screen had lost its
//      import options. Each method now owns its panel.
//   2. `wg:saveSyncConnection` in main.js hardcoded `useWireGuard = true`. It
//      saves a CONNECTION, not a method — so the moment the share fields were
//      saved, a Samba (LAN) setup silently became a VPN one again. That one is
//      invisible in the UI: it only shows up later, as a tunnel being raised.
//
// Against the old code the first checks find the Samba screen empty and the
// VPN screen without its import options, and the last two find useWireGuard
// flipped back to true.
//
//   run: npm run test:syncsamba     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-syncsamba'; const VAULT = `${HOME}/vault`; const PORT = 9397;
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
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/nota.md`, '---\ncreated: 2026-08-28 10:00\n---\n\ntesto\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
// A share left over from an earlier setup, and NO VPN imported: the VPN section
// must still offer the import wizard rather than a collapsed "Modifica" summary.
fs.writeFileSync(SETTINGS, JSON.stringify({ autoSaveSeconds: 30, sync: {
  enabled: false,
  twoway: { enabled: false, transport: 'samba', transportView: 'samba', useWireGuard: false,
            smb: { host: '192.168.30.9', ip: '192.168.30.9', share: 'vecchia', remoteSubPath: 'amelie/sync' } },
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
await sleep(2000);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };
const readCfg = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return { _readError: e.message }; } };

// ── 1. Each method's screen shows ITS OWN panel ─────────────────────────────
// This is what broke in review: with the methods sharing one wizard, picking
// Samba showed neither the share fields nor anything else, and the VPN screen
// lost its import options. Selecting a method must bring up that method's panel.
await ev(`(() => { const b = document.getElementById('btn-settings') || document.querySelector('[data-action="settings"]'); if (b) b.click(); return !!b; })()`);
await sleep(700);
await ev(`document.querySelector('.tab-btn[data-tab="twoway"]').click()`);
await sleep(700);
const pick = async (id) => {
  await ev(`(() => { const c = document.getElementById('${id}'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(800);
  return ev(`(() => {
    const vis = (i) => { const e = document.getElementById(i); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return { sambaPanel: vis('tw-samba-panel'), sambaIp: (document.querySelector('.ip-group[data-ip="tw-sb-ip"]')?.getBoundingClientRect().height || 0) > 0,
             sambaTest: vis('tw-sb-test'), wgImport: vis('tw-wstep-1'), vpnShare: vis('tw-smb-panel'), webdav: vis('tw-webdav-panel') };
  })()`);
};
{
  const s = await pick('cfg-tw-lan-enabled');
  check('the Samba screen shows the Samba panel, with its IP field and test',
    !!s && s.sambaPanel && s.sambaIp && s.sambaTest, JSON.stringify(s));
  check('and no VPN import panel on that screen', !!s && !s.wgImport, JSON.stringify(s));
}
{
  const v = await pick('cfg-tw-samba-enabled');
  check('the VPN screen shows the import options and its share fields',
    !!v && v.wgImport && v.vpnShare, JSON.stringify(v));
  check('and not the Samba panel', !!v && !v.sambaPanel, JSON.stringify(v));
  // With a leftover share but no VPN on disk the section is NOT "configured":
  // showing the collapsed summary there hid the only way to import one.
  const summary = await ev(`(() => { const e = document.getElementById('twoway-conn-ok'); if (!e) return 'MANCANTE'; const r = e.getBoundingClientRect(); return (r.width > 0 && r.height > 0) ? 'visibile' : 'nascosto'; })()`);
  check('a saved share with no VPN imported does not collapse it to "Modifica"',
    summary === 'nascosto', `twoway-conn-ok = ${summary}`);
}

// ── 2. Saving the share writes it ───────────────────────────────────────────
const saved = await ev(`window.inkwell.wg.saveSyncConnection(
  { ip: '192.168.30.11', share: 'saturn', path: 'amelie/sync', username: 'u', password: 'p' })
  .then(r => r && r.ok === true).catch(e => 'threw: ' + e.message)`);
check('saveSyncConnection accepts the LAN share', saved === true, `returned ${JSON.stringify(saved)}`);
await sleep(700);
{
  const smb = readCfg().sync?.twoway?.smb || {};
  check('the share is on disk', smb.host === '192.168.30.11' && smb.share === 'saturn' && smb.remoteSubPath === 'amelie/sync',
    JSON.stringify(smb));
}

// ── 3. …and does NOT convert the method back to VPN ─────────────────────────
{
  const tw = readCfg().sync?.twoway || {};
  check('saving the share leaves useWireGuard false', tw.useWireGuard === false,
    `useWireGuard = ${tw.useWireGuard} (true = the main process overwrote the chosen method)`);
  check('and leaves the transport on samba', tw.transport === 'samba', `transport = ${tw.transport}`);
}

// ── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
