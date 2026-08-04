// Regression test for the fault behind an empty share: a backup destination that was
// switched on stayed empty until the vault happened to change.
//
// A scheduled backup skips when the vault's fingerprint matches the last successful run
// (a sensible way to keep an idle vault from rewriting the same copy every hour). The
// fingerprint describes the VAULT only, so it kept matching after the user enabled a
// Samba share — and the run it matched had written to a local folder, not to the share.
// Every hourly pass skipped, silently (a skip reports no status, so not even a
// notification), and the share stayed empty for as long as no note was touched.
//
// reloadConfig() now drops the shortcut whenever the destination set changes. This drives
// the real SyncManager with no Electron: the class requires electron lazily, inside the
// methods that talk to a window, and none of those are reached here.
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

// A manager with a config and a remembered successful run. ensureVpnTunnel() would reach
// for NetworkManager, and the timers would fire later against a vault that isn't there, so
// both are stubbed out — reloadConfig's own bookkeeping is what's under test.
function mgr(cfg) {
  const m = new SyncManager('/nonexistent/notes', '/nonexistent/attachments', '/nonexistent/settings.json');
  m.config = cfg;
  m._lastBackupSig = '42:1024:1785845798000';   // as if a backup had just succeeded
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  return m;
}
const LOCAL_ONLY = () => ({ sync: { enabled: true,
  local: { enabled: true, path: '/home/u/Desktop', folder: true },
  vpn: { enabled: false, smb: { ip: '192.168.30.10', share: 'saturn', path: 'amelie/backup' }, folder: true },
  webdav: { enabled: false, url: '' } } });
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── The fault: enabling a destination must invalidate the shortcut ────────────
{
  const m = mgr(LOCAL_ONLY());
  const next = clone(LOCAL_ONLY()); next.sync.vpn.enabled = true;
  m.reloadConfig(next);
  check('enabling the Samba share drops the unchanged-vault shortcut', m._lastBackupSig === null,
    `_lastBackupSig=${m._lastBackupSig}`);
}
{
  const m = mgr(LOCAL_ONLY());
  const next = clone(LOCAL_ONLY()); next.sync.webdav.enabled = true; next.sync.webdav.url = 'https://dav.example/remote.php';
  m.reloadConfig(next);
  check('enabling WebDAV drops it too', m._lastBackupSig === null, `_lastBackupSig=${m._lastBackupSig}`);
}

// ── Repointing an already-enabled destination is also a new place to write ────
{
  const m = mgr(LOCAL_ONLY());
  const next = clone(LOCAL_ONLY()); next.sync.local.path = '/mnt/elsewhere';
  m.reloadConfig(next);
  check('moving the local folder drops it', m._lastBackupSig === null, `_lastBackupSig=${m._lastBackupSig}`);
}
{
  const cfg = clone(LOCAL_ONLY()); cfg.sync.vpn.enabled = true;
  const m = mgr(cfg);
  const next = clone(cfg); next.sync.vpn.smb.path = 'amelie/backup-2';
  m.reloadConfig(next);
  check('pointing the share at another folder drops it', m._lastBackupSig === null, `_lastBackupSig=${m._lastBackupSig}`);
}

// ── Asking for a format the last run never produced ───────────────────────────
{
  const m = mgr(LOCAL_ONLY());
  const next = clone(LOCAL_ONLY()); next.sync.local.archive = true;
  m.reloadConfig(next);
  check('adding the .tar.gz archive drops it', m._lastBackupSig === null, `_lastBackupSig=${m._lastBackupSig}`);
}

// ── What must NOT reset it: an idle vault has to keep being skipped ───────────
{
  const m = mgr(LOCAL_ONLY());
  const before = m._lastBackupSig;
  m.reloadConfig(clone(LOCAL_ONLY()));
  check('an unrelated save keeps the shortcut', m._lastBackupSig === before, `_lastBackupSig=${m._lastBackupSig}`);
}
{
  const m = mgr(LOCAL_ONLY());
  const before = m._lastBackupSig;
  const next = clone(LOCAL_ONLY());
  next.sync.local.intervalMinutes = 30;          // frequency
  next.sync.local.keepLast = 9;                  // how many copies to keep
  next.sync.twoway = { enabled: true, transport: 'samba' };   // two-way sync is not a backup
  m.reloadConfig(next);
  check('frequency, retention and two-way sync do not touch it', m._lastBackupSig === before,
    `_lastBackupSig=${m._lastBackupSig}`);
}
{
  // Turning a destination OFF also changes where the backup writes, so the shortcut goes.
  // Not strictly needed for correctness (less is written, not more), but the next run
  // then reports honestly instead of skipping on the strength of a wider previous run.
  const cfg = clone(LOCAL_ONLY()); cfg.sync.vpn.enabled = true;
  const m = mgr(cfg);
  const next = clone(cfg); next.sync.vpn.enabled = false;
  m.reloadConfig(next);
  check('switching a destination off drops it as well', m._lastBackupSig === null, `_lastBackupSig=${m._lastBackupSig}`);
}

// ── The destination list the notification is built from ───────────────────────
{
  const w = SyncManager._writtenDests;
  check('names only what was written',
    JSON.stringify(w({ local: { folder: {} }, samba: { method: 'smb' }, webdav: null })) === '["local","samba"]');
  check('a skipped destination is not named',
    JSON.stringify(w({ local: { folder: {} }, samba: { skipped: true, reason: 'no-backup-mode' } })) === '["local"]');
  check('a failed destination is not named',
    JSON.stringify(w({ local: { folder: {} }, samba: { error: 'share unreachable' } })) === '["local"]');
  check('an empty result is not named (both formats off)',
    JSON.stringify(w({ local: {}, samba: null, webdav: null })) === '[]');
  check('the WebDAV archive alone counts as WebDAV',
    JSON.stringify(w({ webdavArchive: { name: 'x.tar.gz' } })) === '["webdav"]');
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
}
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
