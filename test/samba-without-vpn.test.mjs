// A Samba share on the network you are already on must not need a VPN.
//
// The backup engine used to know exactly ONE Samba destination, and it mapped it
// with `useWireGuard: true` hardcoded — the share was always "Samba over
// WireGuard", so every run went through the tunnel branch. At home that still
// worked by luck (ensureBestPath prefers the direct route when :445 answers),
// but the destination could not be set up or reasoned about without a VPN.
//
// `sync.sambaLan` is that destination without the tunnel. These checks drive the
// real SyncManager with no Electron: the class requires electron lazily, inside
// the methods that talk to a window, and none of those are reached here.
//
// Against the OLD code every check below fails: `_sambaConfig()` returned null
// for this config, so there was no destination at all.
//
//   run: npm test
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

function mgr(cfg) {
  const m = new SyncManager('/nonexistent/notes', '/nonexistent/attachments', '/nonexistent/settings.json');
  m.config = cfg;
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  return m;
}
const LAN_ONLY = () => ({ sync: { enabled: true,
  local:  { enabled: false, path: '' },
  webdav: { enabled: false, url: '' },
  sambaLan: { enabled: true, host: '192.168.30.10', ip: '192.168.30.10', share: 'saturn',
              remoteSubPath: 'amelie/backup', username: 'u', password: 'p',
              useWireGuard: false, folder: true, archive: false, archiveOnly: false, keepLast: 5 } } });
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── The destination exists at all ────────────────────────────────────────────
{
  const c = mgr(LAN_ONLY())._sambaConfig();
  check('a Samba destination with no VPN is a destination', !!c, `_sambaConfig()=${JSON.stringify(c)}`);
  check('it keeps the share it was given', !!c && c.host === '192.168.30.10' && c.share === 'saturn',
    `host=${c?.host} share=${c?.share}`);
}

// ── and it must never ask for a tunnel ───────────────────────────────────────
{
  const c = mgr(LAN_ONLY())._sambaConfig();
  check('it is not "Samba over WireGuard"', c && c.useWireGuard === false, `useWireGuard=${c?.useWireGuard}`);
}
{
  // Even if a stale config carries the old hardcoded flag, the destination is
  // what it is: no tunnel. (A config written by an older build could have it.)
  const cfg = clone(LAN_ONLY()); cfg.sync.sambaLan.useWireGuard = true;
  const c = mgr(cfg)._sambaConfig();
  check('a stale useWireGuard:true in the saved config is overruled', c && c.useWireGuard === false,
    `useWireGuard=${c?.useWireGuard}`);
}

// ── The backup writes through the plain Samba path ───────────────────────────
{
  // The tunnel branch would reach for NetworkManager and, finding no route to a
  // fake host, return { error: 'Share non raggiungibile…' }. Getting the stub's
  // own value back is what proves the direct branch ran.
  const m = mgr(LAN_ONLY());
  let sawCfg = null;
  m._syncSamba = async (cfg) => { sawCfg = cfg; return { ok: true, files: 3 }; };
  const out = await m._runBackupInner();
  check('the backup writes via plain Samba, no tunnel branch', out.samba?.ok === true,
    `results.samba=${JSON.stringify(out.samba)}`);
  check('and it is handed the LAN share', sawCfg?.share === 'saturn' && sawCfg?.useWireGuard === false,
    `share=${sawCfg?.share} useWireGuard=${sawCfg?.useWireGuard}`);
}

// ── Both formats off is still "nothing to write", not an error ───────────────
{
  const cfg = clone(LAN_ONLY());
  cfg.sync.sambaLan.folder = false; cfg.sync.sambaLan.archive = false; cfg.sync.sambaLan.archiveOnly = false;
  const m = mgr(cfg);
  m._syncSamba = async () => { throw new Error('must not run'); };
  const out = await m._runBackupInner();
  check('no backup format → skipped quietly', out.samba?.skipped === true,
    `results.samba=${JSON.stringify(out.samba)}`);
}

// ── Switching it on has to invalidate the unchanged-vault shortcut ───────────
{
  const off = clone(LAN_ONLY()); off.sync.sambaLan.enabled = false;
  const m = mgr(off);
  m._lastBackupSig = '42:1024:1785845798000';
  m.reloadConfig(clone(LAN_ONLY()));
  check('enabling it drops the unchanged-vault shortcut', m._lastBackupSig === null,
    `_lastBackupSig=${m._lastBackupSig}`);
}
{
  const m = mgr(LAN_ONLY());
  m._lastBackupSig = '42:1024:1785845798000';
  const next = clone(LAN_ONLY()); next.sync.sambaLan.remoteSubPath = 'amelie/backup-2';
  m.reloadConfig(next);
  check('repointing it at another folder drops it too', m._lastBackupSig === null,
    `_lastBackupSig=${m._lastBackupSig}`);
}

// ── The VPN destination is untouched by all this ─────────────────────────────
{
  const cfg = { sync: { enabled: true,
    vpn: { enabled: true, smb: { ip: '10.8.0.2', share: 'saturn', path: 'amelie/backup' }, folder: true } } };
  const c = mgr(cfg)._sambaConfig();
  check('the VPN destination still maps as Samba over WireGuard',
    c && c.useWireGuard === true && c.host === '10.8.0.2', `${JSON.stringify(c)}`);
}
{
  // Only one remote runs at a time, and the LAN share is checked first: with
  // both somehow enabled the VPN one must not silently win.
  const cfg = clone(LAN_ONLY());
  cfg.sync.vpn = { enabled: true, smb: { ip: '10.8.0.2', share: 'other', path: 'x' }, folder: true };
  const c = mgr(cfg)._sambaConfig();
  check('with both set, the VPN-less share wins and stays tunnel-free',
    c && c.share === 'saturn' && c.useWireGuard === false, `${JSON.stringify(c)}`);
}

// ── Two-way sync: the same split, and it must not rewrite old setups ─────────
// The Sync tab had ONE Samba method too, stored as transport 'samba' with
// useWireGuard true. The LAN method now owns that name, so an existing VPN
// setup has to keep its tunnel: it is recognised by the flag it always carried.
const T = (tw) => SyncManager._twowayTransport(tw);
{
  check('an old WireGuard sync (transport "samba", flag on) is still the VPN one',
    T({ transport: 'samba', useWireGuard: true }) === 'vpn', T({ transport: 'samba', useWireGuard: true }));
  check('the new LAN method is told apart by the flag being off',
    T({ transport: 'samba', useWireGuard: false }) === 'samba', T({ transport: 'samba', useWireGuard: false }));
  check('an explicit vpn transport is the VPN one', T({ transport: 'vpn' }) === 'vpn', T({ transport: 'vpn' }));
  check('WebDAV is untouched', T({ transport: 'webdav' }) === 'webdav', T({ transport: 'webdav' }));
}
{
  // The oldest shape of all: bidirectional rsync against a mounted folder. It
  // records no transport and no flag, and must NOT be mistaken for a share —
  // reading it as one would send it down the smbclient path and fail.
  check('a legacy mounted-folder sync is neither', T({ path: '/mnt/share' }) === 'legacy', T({ path: '/mnt/share' }));
  check('and an early flag-only WireGuard sync still is the VPN one',
    T({ useWireGuard: true }) === 'vpn', T({ useWireGuard: true }));
}
{
  // The tunnel follows the method: only the VPN one may raise it.
  const conn = { smb: { ip: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' } };
  const lan = mgr({ sync: { twoway: { enabled: true, transport: 'samba', useWireGuard: false, ...conn } } });
  const vpn = mgr({ sync: { twoway: { enabled: true, transport: 'vpn', useWireGuard: true, ...conn } } });
  check('the LAN sync connection is tunnel-free', lan._twowaySambaConn()?.useWireGuard === false,
    `useWireGuard=${lan._twowaySambaConn()?.useWireGuard}`);
  check('the VPN sync connection still asks for the tunnel', vpn._twowaySambaConn()?.useWireGuard === true,
    `useWireGuard=${vpn._twowaySambaConn()?.useWireGuard}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : '  — ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
