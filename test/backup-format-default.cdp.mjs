// On a fresh install the Backup tab shows no switch turned on.
//
// "Backup normale (cartella non compressa)" used to be `checked` in the markup AND
// re-checked on load (wantFolder fell back to true when nothing was configured), so
// an install where no destination existed opened the Backup tab on a green switch.
// Nothing was being written — the engine stops at "no destination" — but a green
// switch in a tab called Backup reads as a backup that is running.
//
// The preselection existed for a reason: a destination cannot write without a
// FORMAT, and switching one on with both formats off used to be refused with a
// toast. So the default did not simply go away — it moved: the first destination
// switched on arms the folder snapshot itself (ensureBackupFormat), which is the
// case the preselection served, without claiming anything before there is a
// destination at all.
//
// What must NOT happen is the format springing back on by itself. Turning it off by
// hand while a destination is on is a deliberate choice (archive-only, or a pause),
// it is saved as an explicit `folder: false`, and it has to survive a reopen.
//
// Checked here, against the running app, reading the live `checked` of the real
// switches rather than any saved config: both formats off on a fresh profile, the
// first destination arming the folder format, the archive left alone, a hand-turned
// -off format staying off across a save and a reopen, and a destination switched off
// and on again arming it once more.
//
//   run: npm run test:bkfmt    (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-bkfmt'; const VAULT = `${HOME}/vault`; const PORT = 9387;
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
fs.mkdirSync(`${HOME}/dest`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
// A FRESH profile: sync off, no destination, no format flag of any kind. This is
// exactly the state an install straight out of the .run is in.
// `intervalMinutes: 0.5` is the 30-second backup frequency, offered until 12/10/2026
// and taken out since: a config written before that must still open on something the
// list can say.
// Nothing switched on and no format chosen — this file is about a FRESH install — with
// one thing carried over: `intervalMinutes: 0.5`, the 30-second backup frequency that
// was offered until 12/10/2026, so the checks at the end see a config written before
// it was taken out.
fs.writeFileSync(SET, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false,
  local: { enabled: false, folder: false, archive: false, intervalMinutes: 0.5 } } }));
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

const ok = [];
const say = (n, p, d = '') => { ok.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : '  — ' + d}`); };
// The LIVE state of the switch, not the config: what the user is actually looking at.
const on = id => ev(`document.getElementById('${id}')?.checked === true`);
const vis = id => ev(`(() => { const e = document.getElementById('${id}'); if (!e) return 'missing';
  return getComputedStyle(e).display === 'none' ? 'hidden' : 'shown'; })()`);
const openBackupTab = async () => {
  await ev('openSettings()'); await sleep(900);
  await ev(`document.querySelector('.tab-btn[data-tab="sync"]').click()`); await sleep(900);
};

await sleep(2500);
await openBackupTab();

// ── A fresh install claims nothing ───────────────────────────────────────────
say('the folder-backup switch is OFF on a fresh install', await on('cfg-backup-normal') === false,
  'cfg-backup-normal is checked with no destination configured');
say('and so is the .tar.gz one', await on('cfg-backup-archived') === false);
say('the markup itself does not ship it checked',
  await ev(`document.getElementById('cfg-backup-normal')?.defaultChecked === false`) === true,
  'the <input> still carries the `checked` attribute');
say('no destination is enabled either',
  await ev(`['local','samba','vpn','webdav'].every(k => document.getElementById('cfg-' + k + '-enabled')?.checked === false)`) === true);
say('and the manual-backup block stays hidden', await vis('manual-backup-block') === 'hidden',
  await vis('manual-backup-block'));

// ── The first destination arms the format ────────────────────────────────────
await ev(`document.getElementById('cfg-local-path').value = ${JSON.stringify(HOME + '/dest')};
          document.getElementById('cfg-local-path').dispatchEvent(new Event('input', { bubbles: true }))`);
await ev(`document.getElementById('ssh-local').click()`); await sleep(300);
await ev(`document.getElementById('btn-test-local').click()`); await sleep(1200);
say('the local path test passes', /✓/.test(await ev(`document.getElementById('local-test-result').textContent`) || ''),
  await ev(`document.getElementById('local-test-result').textContent`));
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(600);
say('the destination sticks (it was tested)', await on('cfg-local-enabled') === true);
say('switching it on armed the folder format by itself', await on('cfg-backup-normal') === true,
  'the destination is on with NO format: nothing would be written');
say('and left the archive format alone', await on('cfg-backup-archived') === false);
say('now the manual-backup block is there', await vis('manual-backup-block') === 'shown',
  await vis('manual-backup-block'));

// ── Turning it off by hand is a decision, not a glitch ───────────────────────
await ev(`document.getElementById('cfg-backup-normal').click()`); await sleep(400);
say('the format can be turned off by hand', await on('cfg-backup-normal') === false);
say('the destination is still on', await on('cfg-local-enabled') === true);
await ev(`typeof saveSettings === 'function' ? saveSettings() : null`); await sleep(900);
await ev('closeSettings && closeSettings()'); await sleep(500);
await openBackupTab();
say('and it is still off after a save and a reopen — it must not spring back',
  await on('cfg-backup-normal') === false,
  'a deliberate "no folder snapshot" was overwritten on load');
say('the destination survived the reopen too', await on('cfg-local-enabled') === true);

// ── Switching the destination off and on again arms it once more ─────────────
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('the destination goes off', await on('cfg-local-enabled') === false);
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(600);
say('switching it back on arms the folder format again', await on('cfg-backup-normal') === true);

// ── A VPN import must not disarm a destination it has nothing to do with ─────
// The two format switches are GLOBAL — one pair in the UI, saved into local,
// webdav AND vpn on every save — and a fresh VPN import clears them so the new
// connection cannot inherit backup modes from the old one. Scoped wrong, that
// reset reaches across and leaves a Local backup armed with NO format, which
// writes nothing while still looking configured. That is what serekkr found on
// 2026-10-09, a day after an import: Local enabled, both formats off, and
// ~/Documents/amelie-backups unchanged.
say('before the import: Local on, folder format armed',
  await on('cfg-local-enabled') === true && await on('cfg-backup-normal') === true);
const threw = await ev(`(() => { try { window._resetVpnBackupModeFlags(); return ''; }
                                 catch (e) { return String(e && e.message || e); } })()`);
await sleep(400);
say('the reset runs', threw === '', threw);
say('a VPN import leaves the format of the OTHER destination alone',
  await on('cfg-backup-normal') === true,
  'the Local backup lost its format to a VPN import it had nothing to do with');
say('and leaves that destination enabled', await on('cfg-local-enabled') === true);

// ...while still doing its job when the VPN is the only thing in play.
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('the destination goes off again', await on('cfg-local-enabled') === false);
await ev(`document.getElementById('cfg-backup-normal').checked ||
          document.getElementById('cfg-backup-normal').click()`); await sleep(300);
await ev(`window._resetVpnBackupModeFlags()`); await sleep(400);
say('with no other destination on, the import still clears the format',
  await on('cfg-backup-normal') === false,
  'the reset stopped working for the case it exists for');

// ── The backup frequency has no 30 seconds any more ─────────────────────────
// A backup writes a whole snapshot of the vault; twice a minute is a frequency for
// the two-way sync, which moves what changed. Taken out of the Backup tab on
// 12/10/2026 — and the Sync tab keeps its own.
{
  const opts = await ev(`[...document.querySelectorAll('#cfg-local-interval option')].map(o => o.value)`);
  say('the backup frequency offers no 30 seconds', !opts.includes('0.5'), JSON.stringify(opts));
  say('and offers hourly, daily, weekly and a custom count of days',
    opts.join(',') === '60,1440,10080,custom', JSON.stringify(opts));
  const twOpts = await ev(`[...document.querySelectorAll('#cfg-twoway-interval option')].map(o => o.value)`);
  say('the SYNC frequency keeps its 30 seconds — it is a different job', twOpts.includes('0.5'), JSON.stringify(twOpts));
  // The seeded config says 0.5. It must not come up as "Custom: 0 days".
  const shown = await ev(`({ value: document.getElementById('cfg-local-interval').value,
                             custom: getComputedStyle(document.getElementById('local-interval-custom-wrap')).display })`);
  say('a config still saying 30 seconds opens on Hourly, not on Custom',
    shown && shown.value === '60' && shown.custom === 'none', JSON.stringify(shown));
  // Weekly is a preset, so a config saying 10080 must come up as Weekly — not as
  // "Custom: 7 days", which is the same length of time said in the one place where it
  // would be rewritten into something else on the next save.
  const weekly = await ev(`(() => { const s = document.getElementById('cfg-local-interval');
    s.value = '10080'; s.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: s.value, custom: getComputedStyle(document.getElementById('local-interval-custom-wrap')).display,
             label: s.options[s.selectedIndex].textContent.trim() }; })()`);
  say('weekly can be chosen, and does not open the days field',
    weekly && weekly.value === '10080' && weekly.custom === 'none' && weekly.label.length > 0, JSON.stringify(weekly));
  say('and its label is translated, not the raw key', !/settings\.freq_weekly/.test(weekly?.label || 'x'), JSON.stringify(weekly));
}

const bad = ok.filter(x => !x).length;
console.log(`\n${ok.length - bad}/${ok.length} ok`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(bad ? 1 : 0);
