// The tab you imported the VPN config in says "config loaded". The OTHER one says
// "already loaded — it will be reused".
//
// The row is shared: Backup and Sync both show one, because it carries Show config /
// Modify / Remove and both tabs need those as soon as a config exists. What must
// differ is the WORDING, and it went wrong twice. First the importing tab's row was
// hidden altogether — which took its Remove and Reconfigure buttons with it. Then
// the row was shown everywhere, but always with the reuse sentence, so importing a
// .conf in Sync answered "already loaded — it will be reused" the instant you
// dropped it (reported 2026-10-08).
//
// `state._wgOrigin` is runtime-only: it is set at import and never persisted, so
// after a restart it is undefined and BOTH tabs say "already loaded" — true of both
// at that point, since neither of them is the one that just did it.
//
// Checked here against the running app, with a .conf planted in the profile so the
// views believe a config exists (nothing is imported into NetworkManager and no
// tunnel is touched): the wording in each tab for an import from Sync, the mirror
// image for an import from Backup, the neutral case after a restart, that the row
// stays VISIBLE in both tabs throughout (the buttons are the reason it exists), and
// that a language change afterwards brings back the right one of the two sentences
// — which it only can if the data-i18n attribute was swapped along with the text.
//
//   run: npm run test:vpnwording    (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-vpnwording'; const VAULT = `${HOME}/vault`; const PORT = 9389;
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
fs.mkdirSync(`${HOME}/.local/share/amelie/vpn`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
// A .conf where the app keeps its own (wireguardManager.js: <profile>/vpn/amelie-wg.conf),
// so wg.getConf() reports one exists. Throwaway keys and documentation addresses
// (RFC 5737 / RFC 3849): nothing here is imported into NetworkManager — the test
// never calls the import, it only drives the views that READ the file.
fs.writeFileSync(`${HOME}/.local/share/amelie/vpn/amelie-wg.conf`, [
  '[Interface]',
  'PrivateKey = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  'Address = 192.0.2.3/32',
  '', '[Peer]',
  'PublicKey = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
  'Endpoint = 198.51.100.1:51821',
  'AllowedIPs = 198.51.100.30/32', '',
].join('\n'), { mode: 0o600 });
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
// The SPAN inside the row — not the buttons, which carry data-i18n of their own.
const span = row => `document.getElementById('${row}')?.querySelector('span[data-i18n]')`;
const key  = row => ev(`${span(row)}?.getAttribute('data-i18n')`);
const text = row => ev(`(${span(row)}?.textContent || '').trim()`);
const shown = row => ev(`(() => { const e = document.getElementById('${row}');
  return !!e && getComputedStyle(e).display !== 'none'; })()`);
// What the two sentences read as IN THE ACTIVE LANGUAGE — no English hardcoded here.
const says = async (row, k) => {
  const want = (await ev(`window.i18n.t('${k}')`) || '').trim();
  const other = (await ev(`window.i18n.t('${k === 'sync.wg_loaded' ? 'sync.tw_wg_already' : 'sync.wg_loaded'}')`) || '').trim();
  const got = await text(row);
  return { pass: !!want && got === want && got !== other, got, want };
};
const r = async (row, k) => { const x = await says(row, k); return [x.pass, `says "${x.got}", expected "${x.want}"`]; };

await sleep(2500);
await ev('openSettings()'); await sleep(900);

// ── Imported in Sync ─────────────────────────────────────────────────────────
await ev(`state._wgOrigin = 'sync'; showWgAlreadyRows('sync')`); await sleep(400);
say('imported in Sync, the Sync row says "config loaded"', ...await r('tw-wg-already', 'sync.wg_loaded'));
say('and does NOT carry the reuse key',
  await key('tw-wg-already') === 'sync.wg_loaded', await key('tw-wg-already'));
say('while Backup says "already loaded — it will be reused"', ...await r('wg-already', 'sync.tw_wg_already'));
say('the Sync row is visible (it holds Show config / Modify / Remove)',
  await shown('tw-wg-already') === true);
say('and so is the Backup one', await shown('wg-already') === true);

// ── Imported in Backup: the mirror image ─────────────────────────────────────
await ev(`state._wgOrigin = 'backup'; showWgAlreadyRows('backup')`); await sleep(400);
say('imported in Backup, the Backup row says "config loaded"', ...await r('wg-already', 'sync.wg_loaded'));
say('and Sync is the one that says it will be reused', ...await r('tw-wg-already', 'sync.tw_wg_already'));
say('both rows still visible', await shown('wg-already') === true && await shown('tw-wg-already') === true);

// ── A language change must not put the wrong sentence back ───────────────────
// It can only get this right if the data-i18n attribute was swapped with the text:
// re-translating the key the markup shipped with would restore the reuse wording.
const lang0 = await ev(`window.i18n.getCurrentLang()`);
const other = lang0 === 'en' ? 'de' : 'en';
const primaBk = await text('wg-already'), primaTw = await text('tw-wg-already');
await ev(`window.i18n.applyLanguage('${other}')`); await sleep(600);
say(`after switching to ${other}, Backup still says "config loaded" — translated`,
  ...await r('wg-already', 'sync.wg_loaded'));
say('and Sync still says it will be reused', ...await r('tw-wg-already', 'sync.tw_wg_already'));
say('the language change really happened (both sentences are new text)',
  await text('wg-already') !== primaBk && await text('tw-wg-already') !== primaTw,
  `backup "${primaBk}" -> "${await text('wg-already')}"`);
await ev(`window.i18n.applyLanguage('${lang0}')`); await sleep(600);
say('and switching back restores the original wording',
  await text('wg-already') === primaBk && await text('tw-wg-already') === primaTw);

// ── After a restart nobody is "the importing tab" ────────────────────────────
// _wgOrigin is not persisted: with no origin, both rows say "already loaded",
// which is what both tabs are looking at.
await ev(`state._wgOrigin = undefined; showWgAlreadyRows()`); await sleep(400);
say('with no origin, Backup says it will be reused', ...await r('wg-already', 'sync.tw_wg_already'));
say('and so does Sync', ...await r('tw-wg-already', 'sync.tw_wg_already'));

// ── The views that redraw on reopen agree with all of the above ──────────────
// updateWgConfiguredView / updateTwowayConnView read the .conf from disk rather
// than being told, and they used to disagree with showWgAlreadyRows.
await ev(`state._wgOrigin = 'sync';
          typeof updateWgConfiguredView === 'function' ? updateWgConfiguredView(true) : null`); await sleep(900);
say('redrawing the Backup view keeps the reuse wording there', ...await r('wg-already', 'sync.tw_wg_already'));
say('and keeps the row visible', await shown('wg-already') === true);
await ev(`typeof updateTwowayConnView === 'function' ? updateTwowayConnView() : null`); await sleep(900);
say('redrawing the Sync view keeps "config loaded" there', ...await r('tw-wg-already', 'sync.wg_loaded'));
say('and keeps its row visible too', await shown('tw-wg-already') === true);

const bad = ok.filter(x => !x).length;
console.log(`\n${ok.length - bad}/${ok.length} ok`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(bad ? 1 : 0);
