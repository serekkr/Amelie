// The backup that was never made: the interval timer counts app UPTIME and dies with the
// app, so a run of sessions shorter than the interval never reached it. Half an hour of
// work, closed, reopened five hours later — with an hourly backup and a share configured,
// nothing was ever copied, silently. Startup now records and reads when the last backup
// actually succeeded, and makes up an overdue one.
//
// Also here: the fingerprint that decides whether a scheduled backup has anything to do
// used to describe the notes alone, while the backup copies attachments too — so photos
// and recordings added without touching a note never left the machine.
//
// Drives the real SyncManager with no Electron, like backup-destinations.test.mjs: the
// class requires electron lazily, and nothing reached here touches a window.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-catchup-'));
const NOTES = path.join(ROOT, 'notes');
const ATT = path.join(ROOT, 'attachments');
const CONF = path.join(ROOT, 'settings.json');
fs.mkdirSync(NOTES, { recursive: true });
fs.mkdirSync(ATT, { recursive: true });

const SHARE = () => ({ sync: { enabled: true,
  local: { enabled: false, path: '/home/u/Desktop', folder: true, intervalMinutes: 60 },
  vpn: { enabled: true, smb: { ip: '192.168.30.10', share: 'saturn', path: 'amelie/backup' }, folder: true },
  webdav: { enabled: false, url: '' } } });
const clone = (o) => JSON.parse(JSON.stringify(o));

function mgr(cfg = SHARE()) {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = cfg;
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  m._CATCH_UP_DELAY_MS = 5;                 // no waiting 30s in a test
  m._runs = [];
  m.runBackup = (opts) => { m._runs.push({ what: 'backup', ...(opts || {}) }); return { success: true }; };
  m.runTwoway = (opts) => { m._runs.push({ what: 'twoway', ...(opts || {}) }); return { success: true }; };
  return m;
}
const statePath = () => path.join(ROOT, 'sync-state.json');
const dropState = () => { try { fs.unlinkSync(statePath()); } catch (_) {} };
const writeState = (agoMin, cfg = SHARE(), vaultSig = 'sig-1') => {
  const m = new SyncManager(NOTES, ATT, CONF); m.config = cfg;
  fs.writeFileSync(statePath(), JSON.stringify({
    lastBackupAt: new Date(Date.now() - agoMin * 60000).toISOString(),
    vaultSig,
    dests: m._backupDestSignature(cfg),
  }));
};

// ── The fingerprint must notice attachments ──────────────────────────────────
{
  const m = mgr();
  fs.writeFileSync(path.join(NOTES, 'a.md'), 'hello');
  const before = m._vaultSignature();
  fs.writeFileSync(path.join(ATT, 'photo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  const after = m._vaultSignature();
  check('adding an attachment changes the vault fingerprint', before !== after, `${before} vs ${after}`);
  const again = m._vaultSignature();
  check('and it is stable when nothing changes', after === again, `${after} vs ${again}`);
}

// ── The interval, read from one place ────────────────────────────────────────
{
  const m = mgr();
  check('the frequency comes from the settings', m._backupIntervalMinutes() === 60, String(m._backupIntervalMinutes()));
  const c = clone(SHARE()); c.sync.local.intervalMinutes = 15;
  m.config = c;
  check('a different frequency is honoured', m._backupIntervalMinutes() === 15, String(m._backupIntervalMinutes()));
  for (const bad of [0, -5, 'abc', null, undefined]) {
    const cc = clone(SHARE()); cc.sync.local.intervalMinutes = bad; m.config = cc;
    if (m._backupIntervalMinutes() !== 60) { check(`a nonsense frequency (${bad}) falls back to hourly`, false, String(m._backupIntervalMinutes())); break; }
  }
  check('a nonsense frequency falls back to hourly', true);
}

// ── Recording, and reading back ──────────────────────────────────────────────
{
  dropState();
  const m = mgr();
  m._recordBackupState('sig-abc');
  const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  check('a successful backup records when it ran', typeof raw.lastBackupAt === 'string' && !Number.isNaN(Date.parse(raw.lastBackupAt)), JSON.stringify(raw));
  check('together with the vault fingerprint and the destinations', raw.vaultSig === 'sig-abc' && typeof raw.dests === 'string', JSON.stringify(raw));

  const m2 = mgr();
  m2._loadSyncState();
  check('the next start carries the fingerprint over', m2._lastBackupSig === 'sig-abc', String(m2._lastBackupSig));

  // A destination changed while the app was closed: the fingerprint describes a run
  // that wrote somewhere else, so it must NOT be trusted.
  const other = clone(SHARE()); other.sync.vpn.smb.share = 'jupiter';
  const m3 = mgr(other);
  m3._loadSyncState();
  check('but not when the destination changed meanwhile', !m3._lastBackupSig, String(m3._lastBackupSig));
}

// ── The catch-up itself ──────────────────────────────────────────────────────
{
  writeState(300);                                   // five hours ago, hourly backup
  const m = mgr();
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('closed for five hours with an hourly backup: it runs at startup', m._runs.length === 1, JSON.stringify(m._runs));
  check('and it is not forced, so an untouched vault still skips',
    m._runs[0] && m._runs[0].force === undefined && m._runs[0].manual === false, JSON.stringify(m._runs));
}
{
  writeState(10);                                    // ten minutes ago
  const m = mgr();
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('reopened ten minutes later: nothing to catch up', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  writeState(59);                                    // just inside the hour
  const m = mgr();
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('a minute short of the interval still counts as punctual', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  dropState();                                       // never backed up under this version
  const m = mgr();
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('no record of a previous backup counts as overdue', m._runs.length === 1, JSON.stringify(m._runs));
}
{
  writeState(300);
  const off = clone(SHARE()); off.sync.vpn.enabled = false;   // no destination at all
  const m = mgr(off);
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('with every destination switched off it stays quiet', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  writeState(300);
  const m = mgr();
  m._loadSyncState();
  m._scheduleCatchUp();
  const next = clone(SHARE()); next.sync.vpn.enabled = false;
  m.reloadConfig(next);                              // switched off during the wait
  await sleep(40);
  check('switching the destination off before it fires cancels it', m._runs.length === 0, JSON.stringify(m._runs));
}

// ── Round trip: the shortcut survives a restart, so an idle vault is not recopied ──
{
  dropState();
  fs.writeFileSync(path.join(NOTES, 'b.md'), 'more');
  const m = mgr();
  const sig = m._vaultSignature();
  m._recordBackupState(sig);                         // as if a backup had just succeeded
  const m2 = mgr();                                  // restart, five hours later
  writeState(300, SHARE(), sig);
  m2._loadSyncState();
  check('after a restart the fingerprint still matches an untouched vault',
    m2._lastBackupSig === m2._vaultSignature(), `${m2._lastBackupSig} vs ${m2._vaultSignature()}`);
}

// ── The same logic for the two-way sync ──────────────────────────────────────
// It has no unchanged-vault shortcut — it has to reach the remote to find out
// whether anything came in — so an overdue one always runs.
const TWOWAY = (extra = {}) => {
  const c = clone(SHARE());
  c.sync.twoway = Object.assign({ enabled: true, transport: 'samba', subPath: 'amelie/sync', intervalMinutes: 15 }, extra);
  return c;
};
const stampTwoway = (agoMin) => {
  const st = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  st.lastTwowayAt = new Date(Date.now() - agoMin * 60000).toISOString();
  fs.writeFileSync(statePath(), JSON.stringify(st));
};
{
  writeState(5, TWOWAY());        // backup punctual, so only the sync can fire
  stampTwoway(300);
  const m = mgr(TWOWAY());
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('a two-way sync overdue by five hours also runs at startup',
    m._runs.length === 1 && m._runs[0].what === 'twoway', JSON.stringify(m._runs));
}
{
  writeState(5, TWOWAY());
  stampTwoway(3);                 // three minutes ago, interval is fifteen
  const m = mgr(TWOWAY());
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('a recent two-way sync is left alone', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  writeState(5, TWOWAY());
  stampTwoway(300);
  const m = mgr(TWOWAY({ enabled: false }));
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('with two-way switched off it stays quiet', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  writeState(5, TWOWAY());
  stampTwoway(300);
  // Enabled, but pointing at nothing — the same condition that denies it a timer.
  const m = mgr(TWOWAY({ subPath: '', path: '', smb: {}, transport: 'samba' }));
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(40);
  check('enabled but with no remote folder, it does not run', m._runs.length === 0, JSON.stringify(m._runs));
}
{
  // Both overdue: they must not collide, because _busy() would reject the second
  // one as "Already syncing" and file it in the bell as a failure.
  writeState(300, TWOWAY());
  stampTwoway(300);
  const m = mgr(TWOWAY());
  const order = [];
  m.runBackup = async () => { order.push('backup:start'); await sleep(25); order.push('backup:end'); return { success: true }; };
  m.runTwoway = async () => { order.push('twoway:start'); await sleep(5); order.push('twoway:end'); return { success: true }; };
  m._loadSyncState();
  m._scheduleCatchUp();
  await sleep(90);
  check('both overdue: both run', order.includes('backup:end') && order.includes('twoway:end'), order.join(' → '));
  check('and the sync waits for the backup instead of colliding with it',
    order.join(',') === 'backup:start,backup:end,twoway:start,twoway:end', order.join(' → '));
}
{
  // Two records in one file: neither may erase the other.
  dropState();
  const m = mgr(TWOWAY());
  m._recordBackupState('sig-xyz');
  m._recordTwowayState();
  const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  check('the sync stamps its own time without erasing the backup\'s',
    !!raw.lastTwowayAt && !!raw.lastBackupAt && raw.vaultSig === 'sig-xyz', JSON.stringify(raw));
  const m2 = mgr(TWOWAY());
  m2._recordBackupState('sig-2');
  const raw2 = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  check('and the backup does not erase the sync\'s either', !!raw2.lastTwowayAt, JSON.stringify(raw2));
}

// ── The claim marker is written once, not over itself every backup ───────────
// Rewriting it left a `.amelie-backup.amelie-tmp-<pid>-<nanos>` on the share on every
// run: `put` renames onto the target, which first needs the old file deleted, and a
// share that refuses that delete refuses the temp's cleanup too.
{
  const m = mgr();
  const calls = [];
  m._smb = async (cfg, args) => { calls.push(args[0]); return ''; };

  m._smbHasFile = async () => true;                  // already claimed
  await m._smbWriteFile({}, 'amelie/backup', '.amelie-backup');
  check('a marker that is already on the share is left alone', calls.length === 0, JSON.stringify(calls));

  m._smbHasFile = async () => false;                 // a fresh destination
  await m._smbWriteFile({}, 'amelie/backup', '.amelie-backup');
  check('a destination without one still gets it', calls.join(',') === 'put', JSON.stringify(calls));

  calls.length = 0;
  m._smbHasFile = async () => { throw new Error('share unreachable'); };
  await m._smbWriteFile({}, 'amelie/backup', '.amelie-backup');
  check('if we cannot tell, it writes rather than skip', calls.join(',') === 'put', JSON.stringify(calls));

  m._smbHasFile = async () => false;
  m._smb = async () => { throw new Error('rename: ACCESS_DENIED'); };
  let threw = false;
  try { await m._smbWriteFile({}, 'amelie/backup', '.amelie-backup'); } catch (_) { threw = true; }
  check('a marker that cannot be written never fails the backup', !threw);
}

// ── Saying that nothing was copied, without saying it every hour ─────────────
{
  // A manager that runs the REAL runBackup, with only the parts that reach the
  // network and the window stubbed out.
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = SHARE();
  m._status = [];
  m._setStatus = (status, error, meta) => m._status.push({ status, error, ...(meta || {}) });
  m._runBackupInner = async () => ({ samba: { ok: true } });
  m._syncPausedPlaintext = () => false;
  m._busy = () => false;

  fs.writeFileSync(path.join(NOTES, 'c.md'), 'fresh');
  await m.runBackup();                                   // vault changed → a real copy
  const first = m._status.filter((s) => s.status === 'ok');
  check('a backup that copies something reports itself as usual',
    first.length === 1 && !first[0].unchanged, JSON.stringify(m._status));

  m._status.length = 0;
  const skipped = await m.runBackup();                   // nothing touched since
  check('an untouched vault is still skipped', skipped.skipped === true, JSON.stringify(skipped));
  check('and now says so instead of staying silent',
    m._status.length === 1 && m._status[0].status === 'ok' && m._status[0].unchanged === true,
    JSON.stringify(m._status));

  m._status.length = 0;
  await m.runBackup();
  await m.runBackup();
  check('but it does not repeat it every pass', m._status.length === 0, JSON.stringify(m._status));

  m._status.length = 0;
  fs.writeFileSync(path.join(NOTES, 'd.md'), 'edited');   // work happens again
  await m.runBackup();
  check('a real backup in between is reported normally',
    m._status.some((s) => s.status === 'ok' && !s.unchanged), JSON.stringify(m._status));

  m._status.length = 0;
  await m.runBackup();
  check('and the next idle stretch is announced once more',
    m._status.length === 1 && m._status[0].unchanged === true, JSON.stringify(m._status));

  check('the manual "Back up now" is never skipped',
    (await m.runBackup({ force: true })).skipped !== true);
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
