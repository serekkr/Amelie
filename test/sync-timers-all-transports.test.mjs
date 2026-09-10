// The 30-second cadence must mean the same thing for EVERY method, not just for
// the Samba (LAN) share it was found broken on.
//
// v1.0.45 fixed a two-way sync that never got a timer because the condition
// deciding "does this deserve one" knew only `twoway.smb`. v1.0.46 then fixed a
// migration (`realtime: true` → 30 s) that lived only in the settings screen, so
// the engine kept reading the old 15 minutes. Both faults were found on ONE
// method. Nothing so far asserts that VPN, WebDAV, the legacy mounted folder and
// the BACKUP timer behave the same — which is what these checks are for.
//
// Driven against the real SyncManager with no Electron: the class requires
// electron lazily, inside the methods that talk to a window, and none of those
// are reached here. `setInterval` is captured, so no timer ever fires.
//
//   run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

// A manager with everything that would touch the outside world stubbed out.
// `_startAutoSync` and `_stopTimers` stay REAL — they are the subject here.
function mgr(cfg) {
  const m = new SyncManager('/nonexistent/notes', '/nonexistent/attachments', '/nonexistent/settings.json');
  m.config = cfg;
  m.ensureVpnTunnel = async () => {};
  m._setupWebDAV = () => {};
  m._loadSyncState = () => {};
  m._updateSyncState = () => {};
  m._recordTwowayState = () => {};
  return m;
}

// Run _startAutoSync with setInterval captured, and report the periods it asked
// for. Milliseconds → minutes, so the expectations read like the dropdown.
function timersOf(cfg) {
  const m = mgr(cfg);
  const real = global.setInterval;
  const seen = [];
  global.setInterval = (fn, ms) => { seen.push(ms); return { _fake: seen.length }; };
  try { m._startAutoSync(); } finally { global.setInterval = real; }
  return {
    backup: m._backupTimer ? seen[0] / 60000 : null,
    twoway: m._twowayTimer ? seen[m._backupTimer ? 1 : 0] / 60000 : null,
  };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ── The five backup destinations ─────────────────────────────────────────────
// The backup frequency is stored under `sync.local` whatever the destination is
// (see _backupIntervalMinutes). So a share-only or WebDAV-only backup has to
// read its interval from there too — otherwise it silently falls back to the
// hourly default and the 30-second choice does nothing.
const BACKUP_DESTS = {
  local:    { enabled: true, path: '/tmp/x' },
  vpn:      { enabled: true, smb: { host: 'h', share: 's', remoteSubPath: 'p' } },
  samba:    { enabled: true, host: 'h', share: 's', remoteSubPath: 'p', useWireGuard: true },
  sambaLan: { enabled: true, host: 'h', ip: 'h', share: 's', remoteSubPath: 'p', useWireGuard: false },
  webdav:   { enabled: true, url: 'https://dav.example/remote.php' },
};
for (const [name, dest] of Object.entries(BACKUP_DESTS)) {
  for (const min of [0.5, 60, 1440]) {
    const cfg = { sync: { enabled: true, local: { enabled: false, intervalMinutes: min }, [name]: clone(dest) } };
    if (name === 'local') cfg.sync.local = { ...clone(dest), intervalMinutes: min };
    const t = timersOf(cfg);
    check(`backup destination "${name}" gets a timer at ${min} min`, t.backup === min,
      `timer=${t.backup} min`);
  }
  const cfg = { sync: { enabled: true, local: { enabled: false }, [name]: clone(dest) } };
  check(`backup destination "${name}" counts as a destination`, mgr(cfg)._anyBackupDestination(), '');
}
{
  // The two lists that decide "is there a backup at all" must not drift apart:
  // one arms the timer, the other decides whether a catch-up is even considered.
  const cfg = { sync: { enabled: true, local: { enabled: false }, sambaLan: clone(BACKUP_DESTS.sambaLan) } };
  check('the timer condition and _anyBackupDestination agree',
    !!timersOf(cfg).backup === mgr(cfg)._anyBackupDestination(), '');
}
{
  // parseInt('0.5') is 0, which is falsy, which is the hourly default. That is
  // exactly how the half-minute choice was lost once already.
  const m = mgr({ sync: { local: { intervalMinutes: 0.5 } } });
  check('a stored 0.5 reads back as half a minute, not the default',
    m._backupIntervalMinutes() === 0.5, `got ${m._backupIntervalMinutes()}`);
  const floored = mgr({ sync: { local: { intervalMinutes: 0.1 } } })._backupIntervalMinutes();
  check('and anything shorter is floored, never rounded down to zero',
    floored === SyncManager._MIN_INTERVAL, `got ${floored}`);
}

// ── The four two-way methods ─────────────────────────────────────────────────
// Each shape below is what saveSettings actually writes for that method.
const TWOWAY = {
  samba:  { transport: 'samba', useWireGuard: false,
            smbLan: { host: 'h', ip: 'h', share: 's', remoteSubPath: 'amelie/sync', username: 'u', password: 'p' } },
  vpn:    { transport: 'vpn', useWireGuard: true,
            smb: { host: 'h', share: 's', remoteSubPath: 'amelie/sync', username: 'u', password: 'p' } },
  webdav: { transport: 'webdav', useWireGuard: true,
            webdav: { url: 'https://dav.example/remote.php', username: 'u', password: 'p', remotePath: 'amelie/sync' } },
  // No transport recorded and no WireGuard flag: the oldest shape of all, the
  // mounted folder with bidirectional rsync. It keeps its own path everywhere.
  legacy: { subPath: '/mnt/share/amelie' },
};
const twCfg = (name, extra = {}) => ({
  sync: { enabled: true, local: { enabled: false },
          twoway: { enabled: true, ...clone(TWOWAY[name]), ...extra } },
});

for (const [name, shape] of Object.entries(TWOWAY)) {
  check(`"${name}" is recognised as the ${name} transport`,
    SyncManager._twowayTransport(shape) === name, `got ${SyncManager._twowayTransport(shape)}`);
  check(`"${name}" reports a remote folder`,
    !!mgr(twCfg(name))._twowayRemoteFolder(), `got ${JSON.stringify(mgr(twCfg(name))._twowayRemoteFolder())}`);
  check(`"${name}" counts as configured`, mgr(twCfg(name))._twowayConfigured(), '');

  for (const min of [0.5, 15, 60, 1440]) {
    const t = timersOf(twCfg(name, { intervalMinutes: min }));
    check(`two-way "${name}" gets a timer at ${min} min`, t.twoway === min, `timer=${t.twoway} min`);
  }

  // The migration that was written in the renderer and forgotten in the engine.
  // It is not a Samba thing: any profile saved with the old option carries it.
  const t = timersOf(twCfg(name, { realtime: true, intervalMinutes: 15 }));
  check(`two-way "${name}": a saved realtime:true means 30 s, not the stale 15`,
    t.twoway === 0.5, `timer=${t.twoway} min`);

  // Nothing to sync with → no timer at all, whatever the method.
  const empty = clone(TWOWAY[name]);
  delete empty.smbLan; delete empty.smb; delete empty.webdav; delete empty.subPath;
  check(`two-way "${name}" with no remote folder gets no timer`,
    timersOf({ sync: { enabled: true, local: { enabled: false }, twoway: { enabled: true, ...empty } } }).twoway === null, '');
}
{
  // Disabled means disabled, however complete the connection is.
  for (const name of Object.keys(TWOWAY)) {
    check(`two-way "${name}" switched off gets no timer`,
      timersOf(twCfg(name, { enabled: false })).twoway === null, '');
  }
}

// ── What a tick actually does, per method ────────────────────────────────────
// EVERY method asks the two cheap questions before doing any work. WebDAV and
// the mounted folder used to fall straight through to a full pass on every tick,
// which at 30 seconds is a deep PROPFIND and a whole diff every half minute for
// a vault nobody touched.
//
// The remote listing is stubbed at the transport's own boundary — the SMB
// listing, the WebDAV listing, a real directory on disk — so the dispatch in
// _twowayRemoteSignature is exercised for real rather than mocked away.
{
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-tick-legacy-'));
  fs.mkdirSync(path.join(legacyRoot, 'amelie', 'notes'), { recursive: true });
  const legacyFile = (name, mtime) => {
    const p = path.join(legacyRoot, 'amelie', 'notes', name);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(mtime), new Date(mtime));
  };
  legacyFile('a.md', 1000000);

  const tickMgr = (name) => {
    const cfg = twCfg(name, { intervalMinutes: 0.5 });
    if (name === 'legacy') cfg.sync.twoway.path = legacyRoot;
    const m = mgr(cfg);
    m.runs = 0;
    m.runTwoway = async () => { m.runs++; return { success: true }; };
    m._vaultSignature = () => 'V1';
    m._decSecret = (v) => v;
    m._smbListRecursive = async () => ({ 'notes/a.md': 1000 });
    m._webdavTwowayList = async () => ({ 'notes/a.md': 1000 });
    return m;
  };
  // How each method's remote is made to look different from one tick to the next.
  const touchRemote = {
    samba:  (m) => { m._smbListRecursive  = async () => ({ 'notes/a.md': 1000, 'notes/b.md': 2000 }); },
    vpn:    (m) => { m._smbListRecursive  = async () => ({ 'notes/a.md': 1000, 'notes/b.md': 2000 }); },
    webdav: (m) => { m._webdavTwowayList  = async () => ({ 'notes/a.md': 1000, 'notes/b.md': 2000 }); },
    legacy: (_m) => { legacyFile('b.md', 2000000); },
  };
  for (const name of Object.keys(TWOWAY)) {
    const m = tickMgr(name);
    await m._twowayTick();
    const first = m.runs;
    await m._twowayTick();
    check(`a "${name}" tick with both sides unchanged does no pass`, first === 1 && m.runs === 1,
      `passate=${m.runs}`);
    touchRemote[name](m);
    await m._twowayTick();
    check(`a "${name}" tick runs when the remote changed`, m.runs === 2, `passate=${m.runs}`);
    m._vaultSignature = () => 'V2';
    await m._twowayTick();
    check(`a "${name}" tick runs when the vault changed`, m.runs === 3, `passate=${m.runs}`);
  }
  {
    // An unreachable remote is NOT an empty one. Reading it as empty would look
    // exactly like every file having been deleted on the other machine.
    for (const [name, boom] of [
      ['samba',  (m) => { m._smbListRecursive = async () => { throw new Error('unreachable'); }; }],
      ['vpn',    (m) => { m._smbListRecursive = async () => { throw new Error('unreachable'); }; }],
      ['webdav', (m) => { m._webdavTwowayList = async () => { throw new Error('503'); }; }],
    ]) {
      const m = tickMgr(name); boom(m);
      await m._twowayTick();
      check(`a "${name}" tick with the remote unreachable does no pass`, m.runs === 0, `passate=${m.runs}`);
    }
    // ...and the same thing without the stub that was making it true.
    //
    // The three checks above mock _smbListRecursive itself, so they asserted a
    // rule the Samba path did not actually follow: the real method swallowed
    // every error into `{}`, which the tick reads as a share whose files all
    // vanished. It therefore started a FULL pass on EVERY tick, each one minutes
    // long against a remote that is timing out, and the engine never went idle
    // again — which is what stopped backups from running at all (2026-09-10).
    // Drive the real listing over a failing helper instead.
    for (const [why, smbJson] of [
      ['unreachable', async () => { throw new Error('dial tcp 192.168.30.10:445: i/o timeout'); }],
      ['unanswerable', async () => null],   // helper exited 0 having printed no JSON
    ]) {
      const m = tickMgr('samba');
      delete m._smbListRecursive;           // back to the real one
      m._smbJson = smbJson;
      for (let i = 0; i < 3; i++) await m._twowayTick();
      check(`three ticks against an ${why} share start no pass at all`, m.runs === 0, `passate=${m.runs}`);
    }
  }
  {
    // Every method must respect the two gates a tick has, or a 30-second timer
    // would stack passes on top of each other.
    for (const name of Object.keys(TWOWAY)) {
      const busy = tickMgr(name); busy._busy = () => true;
      await busy._twowayTick();
      check(`a "${name}" tick does nothing while a run is in flight`, busy.runs === 0, `passate=${busy.runs}`);
      const plain = tickMgr(name); plain._plaintextOpen = true;
      await plain._twowayTick();
      check(`a "${name}" tick does nothing while the vault is plaintext`, plain.runs === 0, `passate=${plain.runs}`);
    }
  }
  fs.rmSync(legacyRoot, { recursive: true, force: true });
}

// ── An unreachable share is not an empty one ─────────────────────────────────
// _twowayRemoteSignature promises `null` for "nothing configured" and a THROW
// for "unreachable". _smbListRecursive is where the Samba transport keeps that
// promise, or fails to.
{
  const m = mgr({ sync: {} });
  const conn = { host: 'h', share: 's' };
  const throws = async () => {
    try { await m._smbListRecursive(conn, 'amelie/sync'); return false; } catch (_) { return true; }
  };

  m._smbJson = async () => { throw new Error('dial tcp: i/o timeout'); };
  check('an SMB listing that failed throws instead of answering "empty"', await throws(), '');

  m._smbJson = async () => null;   // the helper printed something that is not JSON
  check('an SMB listing the helper could not answer throws too', await throws(), '');

  m._smbJson = async () => [];
  const empty = await m._smbListRecursive(conn, 'amelie/sync');
  check('a folder that really IS empty answers {} and does not throw',
    empty && Object.keys(empty).length === 0, JSON.stringify(empty));

  m._smbJson = async () => ([{ path: 'notes', dir: true }, { path: 'notes/a.md', mtime: 1000 }]);
  check('a listing keeps the files and drops the directories',
    JSON.stringify(await m._smbListRecursive(conn, 'amelie/sync')) === '{"notes/a.md":1000}', '');

  // And the signature the tick compares carries the throw up, rather than
  // reporting a share that lost every file.
  const sig = mgr(twCfg('samba', { intervalMinutes: 0.5 }));
  sig._decSecret = (v) => v;
  sig._smbJson = async () => { throw new Error('i/o timeout'); };
  let sigThrew = false;
  try { await sig._twowayRemoteSignature(); } catch (_) { sigThrew = true; }
  check('_twowayRemoteSignature reports an unreachable Samba share as a throw', sigThrew, '');
}

// ── The remote folder must name what actually runs ───────────────────────────
// A flat chain of fallbacks answered for a method other than the chosen one, in
// both directions: it invented a destination the pass could not use, and it
// missed one the pass could.
{
  const conn = { host: 'h', ip: 'h', share: 's', remoteSubPath: 'amelie/sync', username: 'u', password: 'p' };
  {
    // VPN chosen, but only a LEFTOVER LAN share is filled in. _twowaySambaConn
    // refuses smbLan for VPN, so the pass has nothing — and neither must the
    // timer, or the Sync tab says "configured" over a timer that does nothing.
    const m = mgr({ sync: { enabled: true, local: { enabled: false },
      twoway: { enabled: true, transport: 'vpn', useWireGuard: true, smbLan: { ...conn } } } });
    check('VPN with only a leftover LAN share is NOT configured',
      m._twowayConfigured() === false, `folder=${JSON.stringify(m._twowayRemoteFolder())}`);
    check('and it gets no timer', timersOf(m.config).twoway === null, '');
    check('the folder test agrees with the connection the pass would use',
      !m._twowayRemoteFolder() === !m._twowaySambaConn(), '');
  }
  {
    // VPN whose share comes from the BACKUP connection — the fallback
    // _twowaySambaConn has always had for setups that never filled the Sync tab.
    // The pass works; the flat chain never looked there, so there was no timer.
    const m = mgr({ sync: { enabled: true, local: { enabled: false },
      samba: { ...conn, enabled: true, useWireGuard: true },
      twoway: { enabled: true, transport: 'vpn', useWireGuard: true } } });
    m._decSecret = (v) => v;
    check('VPN served by the backup connection IS configured',
      m._twowayConfigured() === true, `folder=${JSON.stringify(m._twowayRemoteFolder())}`);
    check('and it gets a timer', timersOf(m.config).twoway === 15, '');
    check('the folder test agrees with the connection the pass would use',
      !m._twowayRemoteFolder() === !m._twowaySambaConn(), '');
  }
  {
    // A connection with a folder but no server is not a destination either.
    const m = mgr({ sync: { enabled: true, local: { enabled: false },
      twoway: { enabled: true, transport: 'vpn', useWireGuard: true, smb: { remoteSubPath: 'amelie/sync' } } } });
    check('a share with a folder but no host is NOT configured', m._twowayConfigured() === false,
      `folder=${JSON.stringify(m._twowayRemoteFolder())}`);
  }
}

// ── Backup AND sync, both switched on ───────────────────────────────────────
// Every case above tests one half with the other half off: the sync-method cases
// all say `local: { enabled: false }`, and the backup cases never enable twoway.
// So nothing asserted the shape the user actually runs — a local backup every
// hour AND a Samba (LAN) sync every 30 seconds, at the same time. Two timers on
// two different periods, from one _startAutoSync.
{
  const both = { sync: { enabled: true,
    backupTransport: 'local',
    local: { enabled: true, path: '/home/u/Documents/amelie-backup/', intervalMinutes: 60 },
    twoway: { enabled: true, transport: 'samba', useWireGuard: false, intervalMinutes: 0.5,
              smbLan: { host: '10.0.0.2', ip: '10.0.0.2', share: 'saturn',
                        remoteSubPath: 'amelie/sync', username: 'u', password: 'p' } } } };
  const t = timersOf(both);
  check('both on: the backup timer is created, on the backup frequency', t.backup === 60, `backup=${t.backup}`);
  check('both on: the two-way timer is created, on its own 30 s', t.twoway === 0.5, `twoway=${t.twoway}`);
  check('both on: neither timer displaces the other', t.backup !== null && t.twoway !== null,
    `backup=${t.backup} twoway=${t.twoway}`);

  // They write to different places, and nothing checks that for you: the backup
  // goes to a local folder, the sync to a folder on the share. A setup pointing
  // both at one folder is what the "already configured for the other" warning in
  // the settings screen is for.
  const m = mgr(both);
  m._decSecret = (v) => v;
  check('both on: the sync folder is not the backup folder',
    m._twowayRemoteFolder() !== both.sync.local.path,
    `sync=${JSON.stringify(m._twowayRemoteFolder())} backup=${both.sync.local.path}`);

  // A run in flight blocks the other one rather than racing it. The two-way tick
  // costs a 30-second delay, which the next tick covers. The BACKUP loses its
  // whole hour — it returns "Already syncing" and, because that path never calls
  // _setStatus, it does so silently: no bell, no error, just no backup until the
  // next hour. Worth knowing, not worth a race.
  const busy = mgr(both);
  busy._decSecret = (v) => v;
  busy.status = 'syncing';
  busy._syncStartedAt = Date.now();
  let passes = 0;
  busy.runTwoway = async () => { passes++; return { success: true }; };
  await busy._twowayTick();
  check('both on: a two-way tick during a run does not race it', passes === 0, `${passes} passes started`);
  const r = await busy.runBackup();
  check('both on: a backup during a run is refused, not raced',
    r && r.success === false && r.error === 'Already syncing', JSON.stringify(r));
  check('both on: that refusal leaves the status alone (no bell for it)',
    busy.status === 'syncing', `status=${busy.status}`);
}

// ── The bell, on the backup side ─────────────────────────────────────────────
// The two-way half of this rule is covered in samba-without-vpn.test.mjs. The
// backup half runs off a DIFFERENT interval (sync.local) and was never asserted.
{
  const backupMeta = (min, manual) => {
    const m = mgr({ sync: { enabled: true, local: { enabled: true, path: '/tmp/x', intervalMinutes: min } } });
    const seen = [];
    m._setStatus = (status, error, meta) => { seen.push(meta); };
    m._runBackupInner = async () => { throw new Error('stop here'); };
    return m._doBackup('sig', { manual }).then(() => seen[0]);
  };
  check('a 30-second backup is marked quiet', (await backupMeta(0.5, false))?.quiet === true, '');
  check('an hourly backup is quiet: exactly an hour is not MORE than an hour',
    (await backupMeta(60, false))?.quiet === true, '');
  check('a daily backup announces success', (await backupMeta(1440, false))?.quiet === false, '');
  const pressed = await backupMeta(0.5, true);
  check('a backup the user pressed always speaks', pressed?.quiet === false && pressed?.manual === true, '');
}

// ── Catch-up after a restart, for every method ───────────────────────────────
// The timer counts uptime, so a machine that was off past its interval catches
// up at startup. That has to use the same interval the timer does.
{
  for (const name of Object.keys(TWOWAY)) {
    const m = mgr(twCfg(name, { realtime: true, intervalMinutes: 15 }));
    check(`catch-up reads "${name}" at the migrated 30 s, like the timer`,
      m._twowayIntervalMinutes() === 0.5, `got ${m._twowayIntervalMinutes()}`);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : '  — ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
