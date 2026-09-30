// "Use the VPN only for sync" against the REAL NetworkManager.
//
// A laptop that joins many networks cannot have the sync tunnel take routes from
// them (asked 2026-09-29). With the flag on, a connection's routes — a full-tunnel
// 0.0.0.0/0 included — live in a table of their own, and only the share's address
// is looked up there, and only when no other network already routes it.
//
// Throwaway connections only (amelie-test-*), documentation addresses only
// (192.0.2.0/24, which exist on no network). Everything is removed at the end,
// also on failure. Needs NetworkManager and a session allowed to manage it.
//
//   run: npm run test:vpnsynconly
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { WireGuardManager } = require(path.join(HERE, '../src/sync/wireguardManager.js'));
const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
const sh = (args, opts = {}) => execFileSync('nmcli', args, { encoding: 'utf8', timeout: 30000, ...opts }).trim();
const get = (con, f, secrets = false) => sh([...(secrets ? ['-s'] : []), '-g', f, 'connection', 'show', con]);
const dev = (ip) => { try { return (execFileSync('ip', ['route', 'get', ip], { encoding: 'utf8' }).match(/ dev (\S+)/) || [])[1]; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { sh(['--version']); } catch { console.log('SKIP: no nmcli'); process.exit(0); }

const WG = 'amelie-test-wg', OVPN = 'amelie-test-ovpn', WORK = 'amelie-test-work';
const SHARE = '192.0.2.55', OTHER = '192.0.2.56';
const cleanup = () => { for (const c of [WG, OVPN, WORK]) { try { sh(['connection', 'delete', c], { stdio: 'ignore' }); } catch {} } };
cleanup();
process.on('exit', cleanup);

const key = () => crypto.randomBytes(32).toString('base64');
const wg = new WireGuardManager();
const before = { internet: dev('1.1.1.1'), nas: dev('192.168.30.10'), share: dev(SHARE), other: dev(OTHER) };

try {
  // ── 1. The settings themselves (pure) ─────────────────────────────────────
  {
    const S = WireGuardManager.syncOnlySettings;
    check('no address, nothing to route', S([]) === null && S(['nas.local']) === null);
    const s = S([SHARE, SHARE, 'not-an-ip']);
    check('rules for the share only, once, main first then the tunnel table',
      s['ipv4.routing-rules'] === `priority 31590 to ${SHARE} suppress_prefixlength 0 table 254, priority 31591 to ${SHARE} table 51830`,
      s['ipv4.routing-rules']);
    check('own table, lowest metric, no DNS, no IPv6',
      s['ipv4.route-table'] === '51830' && s['ipv4.route-metric'] === '9999' && s['ipv4.ignore-auto-dns'] === 'yes'
      && s['ipv4.dns'] === '' && s['ipv6.method'] === 'disabled', JSON.stringify(s));
    const two = S([SHARE, '192.0.2.77']);
    check('two shares, four rules', two['ipv4.routing-rules'].split(', ').length === 4, two['ipv4.routing-rules']);
  }

  // ── 2. WireGuard, the worst case: a FULL tunnel ───────────────────────────
  sh(['connection', 'add', 'type', 'wireguard', 'con-name', WG, 'ifname', WG.slice(0, 15), 'connection.autoconnect', 'no',
      'ipv4.method', 'manual', 'ipv4.addresses', '192.0.2.200/32', 'ipv6.method', 'disabled',
      'wireguard.private-key', key()]);
  sh(['connection', 'modify', WG, 'wireguard.private-key', key(),
      'wireguard.peers', `${key()} allowed-ips=0.0.0.0/0 endpoint=192.0.2.1:51820 preshared-key=${key()} preshared-key-flags=0`]);
  const keyLen = () => get(WG, 'wireguard.private-key', true).length;
  const pskOk = () => /preshared-key=\S{44}/.test(get(WG, 'wireguard.peers', true));
  check('test tunnel created with both secrets', keyLen() === 44 && pskOk());

  WireGuardManager.syncOnly = { enabled: true, hosts: [SHARE] };
  check('flag on: applied', (await wg.applySyncOnlyRouting(WG)) === 'set');
  check('and the keys are still there', keyLen() === 44 && pskOk());
  check('applying again writes nothing', (await wg.applySyncOnlyRouting(WG)) === 'unchanged');

  sh(['connection', 'up', WG]);
  await sleep(1500);
  const up = { internet: dev('1.1.1.1'), nas: dev('192.168.30.10'), share: dev(SHARE), other: dev(OTHER) };
  check('a full tunnel with the flag does NOT take the internet', up.internet === before.internet, JSON.stringify({ before, up }));
  check('nor the NAS or the home network', up.nas === before.nas, JSON.stringify({ before, up }));
  check('nor a neighbour of the share', up.other === before.other, JSON.stringify({ before, up }));
  check('only the share goes into it', up.share === WG.slice(0, 15), JSON.stringify(up));
  const mainHasIt = execFileSync('ip', ['route', 'show', 'table', 'main'], { encoding: 'utf8' }).includes(WG.slice(0, 15));
  check('none of its routes is in the main table', !mainHasIt);
  check('it brings no DNS', !get(WG, 'IP4.DNS').trim(), get(WG, 'IP4.DNS'));

  // A work network that also has this address wins over the tunnel.
  sh(['connection', 'add', 'type', 'dummy', 'con-name', WORK, 'ifname', 'amtestwork0', 'connection.autoconnect', 'no',
      'ipv4.method', 'manual', 'ipv4.addresses', '192.0.2.250/32', 'ipv4.routes', '192.0.2.0/24', 'ipv6.method', 'disabled']);
  sh(['connection', 'up', WORK]);
  await sleep(800);
  check('a work network using the same subnet keeps the address', dev(SHARE) === 'amtestwork0', dev(SHARE));
  sh(['connection', 'delete', WORK]);
  await sleep(800);
  check('and once it is gone the share is back in the tunnel', dev(SHARE) === WG.slice(0, 15), dev(SHARE));

  sh(['connection', 'down', WG]);
  await sleep(800);
  check('tunnel down: everything back where it was',
    dev('1.1.1.1') === before.internet && dev(SHARE) === before.share, JSON.stringify({ i: dev('1.1.1.1'), s: dev(SHARE) }));

  // Flag off: only what the flag set is undone (never activated afterwards — a bare
  // full tunnel WOULD take the default route, which is exactly the point).
  WireGuardManager.syncOnly = { enabled: false, hosts: [] };
  check('flag off: restored', (await wg.applySyncOnlyRouting(WG)) === 'reset');
  check('back to the main table, no rules, default metric',
    get(WG, 'ipv4.route-table') === '0' && get(WG, 'ipv4.routing-rules') === '' && get(WG, 'ipv4.route-metric') === '-1',
    JSON.stringify({ t: get(WG, 'ipv4.route-table'), r: get(WG, 'ipv4.routing-rules'), m: get(WG, 'ipv4.route-metric') }));
  check('keys still there after the reset', keyLen() === 44 && pskOk());
  check('off again: nothing to undo', (await wg.applySyncOnlyRouting(WG)) === 'unchanged');
  sh(['connection', 'modify', WG, 'ipv4.route-table', '777']);
  check('a table set by hand is not the flag\'s to reset', (await wg.applySyncOnlyRouting(WG)) === 'unchanged'
    && get(WG, 'ipv4.route-table') === '777');

  WireGuardManager.syncOnly = { enabled: true, hosts: [] };
  check('flag on with no known share: routing left alone', (await wg.applySyncOnlyRouting(WG)) === 'skipped'
    && get(WG, 'ipv4.route-table') === '777');

  // ── 3. OpenVPN: the same flag ─────────────────────────────────────────────
  let ovpnOk = true;
  try {
    sh(['connection', 'add', 'type', 'vpn', 'con-name', OVPN, 'vpn-type', 'openvpn', 'connection.autoconnect', 'no',
        'vpn.data', 'remote=192.0.2.1, connection-type=password, username=test, password-flags=0']);
    sh(['connection', 'modify', OVPN, 'vpn.secrets', 'password=not-a-real-secret']);
  } catch (e) { ovpnOk = false; console.log('SKIP OpenVPN part: plugin missing —', String(e.message).split('\n')[0]); }
  if (ovpnOk) {
    const pw = () => /password\s*=\s*not-a-real-secret/.test(get(OVPN, 'vpn.secrets', true));
    check('OpenVPN test connection holds its password', pw(), get(OVPN, 'vpn.secrets', true));
    WireGuardManager.syncOnly = { enabled: true, hosts: [SHARE] };
    check('OpenVPN: the same flag applies', (await wg.applySyncOnlyRouting(OVPN)) === 'set');
    check('with the same settings',
      get(OVPN, 'ipv4.route-table') === '51830' && get(OVPN, 'ipv4.ignore-auto-dns') === 'yes'
      && get(OVPN, 'ipv6.method') === 'disabled' && get(OVPN, 'ipv4.routing-rules').includes(SHARE));
    check('and the password survives it', pw(), get(OVPN, 'vpn.secrets', true));
    WireGuardManager.syncOnly = { enabled: false, hosts: [] };
    check('OpenVPN: flag off restores it', (await wg.applySyncOnlyRouting(OVPN)) === 'reset' && get(OVPN, 'ipv4.route-table') === '0');
    check('password still there', pw());
  }

  // ── 4. Which addresses Amelie lets through ────────────────────────────────
  {
    const m = new SyncManager('/nonexistent/n', '/nonexistent/a', '/nonexistent/s.json');
    m.config = { sync: {
      vpn: { syncOnly: true, peerIp: '192.168.30.30', smb: { ip: '192.168.30.30' } },
      samba: { host: '192.168.30.30', useWireGuard: true },
      sambaLan: { host: '192.168.99.9' },
      twoway: { enabled: true, transport: 'vpn', useWireGuard: true, smb: { host: '192.168.30.31', share: 's', remoteSubPath: 'x' } } } };
    const hosts = m._vpnSyncOnlyHosts();
    check('the backup and the two-way VPN shares, each once', JSON.stringify(hosts) === '["192.168.30.30","192.168.30.31"]', JSON.stringify(hosts));
    check('never the LAN share, which does not use the tunnel', !hosts.includes('192.168.99.9'));
  }

  check('serekkr-wg untouched and still up',
    sh(['-t', '-f', 'NAME', 'connection', 'show', '--active']).split('\n').includes('serekkr-wg'));
} catch (e) {
  check('the run itself', false, e.stack || String(e));
} finally {
  cleanup();
}
const left = sh(['-t', '-f', 'NAME', 'connection', 'show']).split('\n').filter((n) => n.startsWith('amelie-test-'));
check('every test connection is gone', left.length === 0, JSON.stringify(left));
check('routes as they were before the test',
  dev('1.1.1.1') === before.internet && dev('192.168.30.10') === before.nas && dev(SHARE) === before.share,
  JSON.stringify({ before, now: { i: dev('1.1.1.1'), n: dev('192.168.30.10'), s: dev(SHARE) } }));

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
