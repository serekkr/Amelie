// The .tar.gz and the dated folder are two halves of one backup, and they were named
// by two different conventions sitting in the same directory:
//
//   amelie-vault-2026-09-02_20-12-25          ← the folder
//   amelie-vault-20260917-175444.tar.gz       ← the archive
//
// createArchive carried its own copy of the date formatting, compressed. It now uses
// _dateStamp(), the one the folders use. Nothing on disk is renamed, so BOTH spellings
// have to stay recognisable to retention — and the retention that runs on a Samba share
// sorted by NAME, which gets the order exactly backwards once the two spellings mix:
// they agree up to "2026", then '-' (0x2D) sorts below '0' (0x30), so every NEW archive
// looks older than every old one and the newest copies are the first deleted.
//
// Drives the real SyncManager with no Electron, like backup-catchup.test.mjs.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-names-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const DEST = path.join(ROOT, 'dest');
fs.mkdirSync(NOTES, { recursive: true });
fs.mkdirSync(ATT, { recursive: true });
fs.mkdirSync(DEST, { recursive: true });
fs.writeFileSync(path.join(NOTES, 'a.md'), '# nota');

const mgr = () => {
  const m = new SyncManager(NOTES, ATT, path.join(ROOT, 'settings.json'));
  m.config = { sync: {} };
  return m;
};

// ── The archive is named like the folder ─────────────────────────────────────
{
  const m = mgr();
  const file = path.basename(await m.createArchive(DEST));
  const FOLDER_STYLE = /^amelie-vault-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;
  check('the archive is named YYYY-MM-DD_HH-MM-SS, like a dated folder', FOLDER_STYLE.test(file), file);
  check('and NOT the old compressed spelling', !/^amelie-vault-\d{8}-\d{6}\.tar\.gz$/.test(file), file);

  // The two halves of one backup, side by side.
  const folder = m._snapshotName();
  const stamp = (s) => s.replace(/^amelie-vault-/, '').replace(/\.tar\.gz$/, '');
  check('archive and folder share the prefix and the stamp shape',
    stamp(file).length === stamp(folder).length && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(stamp(folder)),
    `${file}  vs  ${folder}`);
  check('and the folder pattern still recognises the folder',
    SyncManager._SNAPSHOT_RE.test(folder), folder);
  check('the archive really is a readable gzip', fs.statSync(path.join(DEST, file)).size > 0, file);
}

// ── Both spellings are still ours ────────────────────────────────────────────
{
  check('the old spelling is still recognised',
    SyncManager._archiveStamp('amelie-vault-20260917-175444.tar.gz') === '20260917175444');
  check('the new spelling is recognised',
    SyncManager._archiveStamp('amelie-vault-2026-09-20_12-30-00.tar.gz') === '20260920123000');
  check('something else is not', SyncManager._archiveStamp('holiday-photos.tar.gz') === null);
  check('and neither is a folder of ours', SyncManager._archiveStamp('amelie-vault-2026-09-20_12-30-00') === null);
}

// ── Retention on the share, with the two spellings mixed ─────────────────────
// The order that matters: by DATE, not by name. Sorted by name the four new-spelling
// archives would be taken for the oldest and deleted, keeping four from September.
{
  const REMOTE = [
    'amelie-vault-20260901-101010.tar.gz',   // oldest
    'amelie-vault-20260905-101010.tar.gz',
    'amelie-vault-20260917-175444.tar.gz',
    'amelie-vault-2026-09-18_09-00-00.tar.gz',
    'amelie-vault-2026-09-19_09-00-00.tar.gz',
    'amelie-vault-2026-09-20_12-30-00.tar.gz',   // newest
  ];
  const m = mgr();
  const deleted = [];
  m._smbJson = async () => REMOTE.map(n => ({ name: n, dir: false })).concat([{ name: 'notes', dir: true }]);
  m._smb = async (_cfg, args) => { deleted.push(String(args[1]).split('/').pop()); };
  await m._smbPruneArchives({}, 'amelie/backup', 3);

  check('retention deletes exactly the surplus', deleted.length === 3, JSON.stringify(deleted));
  check('and it deletes the three OLDEST by date, whatever their spelling',
    deleted.includes('amelie-vault-20260901-101010.tar.gz') &&
    deleted.includes('amelie-vault-20260905-101010.tar.gz') &&
    deleted.includes('amelie-vault-20260917-175444.tar.gz'), JSON.stringify(deleted));
  check('the newest three survive, including the new spelling',
    !deleted.includes('amelie-vault-2026-09-18_09-00-00.tar.gz') &&
    !deleted.includes('amelie-vault-2026-09-19_09-00-00.tar.gz') &&
    !deleted.includes('amelie-vault-2026-09-20_12-30-00.tar.gz'), JSON.stringify(deleted));
  check('a folder on the share is never touched', !deleted.some(d => d === 'notes'), JSON.stringify(deleted));
}
{
  // Back-compat: a share holding only old-spelling archives still rotates.
  const OLD = ['amelie-vault-20260901-101010.tar.gz', 'amelie-vault-20260905-101010.tar.gz',
               'amelie-vault-20260917-175444.tar.gz'];
  const m = mgr();
  const deleted = [];
  m._smbJson = async () => OLD.map(n => ({ name: n, dir: false }));
  m._smb = async (_cfg, args) => { deleted.push(String(args[1]).split('/').pop()); };
  await m._smbPruneArchives({}, 'amelie/backup', 2);
  check('a share of only old-spelling archives still rotates',
    deleted.length === 1 && deleted[0] === 'amelie-vault-20260901-101010.tar.gz', JSON.stringify(deleted));
}
{
  // And one holding only the new spelling.
  const NEW = ['amelie-vault-2026-09-18_09-00-00.tar.gz', 'amelie-vault-2026-09-19_09-00-00.tar.gz',
               'amelie-vault-2026-09-20_12-30-00.tar.gz'];
  const m = mgr();
  const deleted = [];
  m._smbJson = async () => NEW.map(n => ({ name: n, dir: false }));
  m._smb = async (_cfg, args) => { deleted.push(String(args[1]).split('/').pop()); };
  await m._smbPruneArchives({}, 'amelie/backup', 2);
  check('and one of only new-spelling archives rotates too',
    deleted.length === 1 && deleted[0] === 'amelie-vault-2026-09-18_09-00-00.tar.gz', JSON.stringify(deleted));
}

// ── Local retention is by mtime, so it never had the ordering problem ────────
{
  const m = mgr();
  const dir = path.join(ROOT, 'local');
  fs.mkdirSync(dir, { recursive: true });
  const names = ['amelie-vault-20260901-101010.tar.gz', 'amelie-vault-2026-09-20_12-30-00.tar.gz'];
  names.forEach((n, i) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'x');
    const t = Date.now() / 1000 - (names.length - i) * 3600;   // first written = older
    fs.utimesSync(p, t, t);
  });
  m._pruneArchives(dir, 1);
  const left = fs.readdirSync(dir);
  check('local retention keeps the newest by mtime, across spellings',
    left.length === 1 && left[0] === 'amelie-vault-2026-09-20_12-30-00.tar.gz', JSON.stringify(left));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
