// A backup destination switched on with NO format selected must not report success.
//
// On 2026-10-09 the user asked why the Backup tab showed "Local" enabled with
// neither "Normal backup (folder)" nor "Archived backup (.tar.gz)" ticked. The
// answer was worse than the question: in that state every backup ran, wrote
// nothing, and reported ok. `~/Documents/amelie-backups` had not gained a file
// for a day and the toolbar "Back up now" button was still there — it depends on
// local.enabled alone — so pressing it answered "backup complete" over an empty
// folder.
//
// How anyone lands there without choosing it: the two format toggles are GLOBAL
// (one pair in the UI, written into local, webdav AND vpn on every save), and
// importing a VPN config clears them — a reset meant for the VPN destination.
// That scoping is fixed in app.js; this covers the engine side, which has to
// refuse to call a run that writes nothing a success.
//
// The Samba branch of _runBackupInner skips this state QUIETLY on purpose — there
// it means "no backup content over this link" while another destination still
// writes. So the guard must fire only when NOTHING in the whole run would write.
//
// Real SyncManager, real local destination, a real vault on disk.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-noformat-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const DEST = path.join(ROOT, 'backup');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, DEST, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(NOTES, 'nota.md'), '# una nota vera\n\ncon del contenuto\n');

const CFG = (local) => ({ sync: {
  enabled: true,
  local: { enabled: true, path: DEST, intervalMinutes: 1440, keepLast: 5, ...local },
  webdav: { enabled: false, url: '' },
  twoway: { enabled: false },
} });

function mgr(local) {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = CFG(local);
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = m._stopAutoSync = m._stopTimers = m._setupWebDAV = () => {};
  m.sent = [];
  m._setStatus = (status, error = null, meta = null) => { m.status = status; m.sent.push(status); };
  return m;
}
const wipe = () => { fs.rmSync(DEST, { recursive: true, force: true }); fs.mkdirSync(DEST, { recursive: true }); };
const produced = () => fs.readdirSync(DEST);

// ── The state the user was in: destination on, both formats off ──────────────
{
  wipe();
  const m = mgr({ folder: false, archive: false, archiveOnly: false });
  const r = await m.runBackup({ manual: true });
  check('it is not reported as a success', r.success === false, JSON.stringify(r.success));
  check('it says WHY: no format selected', r.noFormat === true);
  check('the error names both formats', /cartella/.test(r.error || '') && /tar\.gz/.test(r.error || ''), r.error);
  check('nothing is written', produced().length === 0, produced().join(', '));
  check('the status never goes to ok', !m.sent.includes('ok'), m.sent.join(','));
}

// ── With a format, the same destination backs up normally ────────────────────
{
  wipe();
  const m = mgr({ folder: true, archive: false });
  const r = await m.runBackup({ manual: true });
  check('folder format: the backup succeeds', r.success === true, JSON.stringify(r.error || ''));
  check('folder format: a dated snapshot appears', produced().some((f) => f.startsWith('amelie-vault-')), produced().join(', '));
}
{
  wipe();
  const m = mgr({ folder: false, archive: true, archiveOnly: true });
  const r = await m.runBackup({ manual: true });
  check('archive only: the backup succeeds', r.success === true, JSON.stringify(r.error || ''));
  check('archive only: a .tar.gz appears', produced().some((f) => f.endsWith('.tar.gz')), produced().join(', '));
}

// ── The guard must not steal the deliberate "both off" of ONE destination ────
{
  wipe();
  const m = mgr({ folder: true, archive: false });
  // A second destination that deliberately writes no content, alongside one that does.
  m.config.sync.webdav = { enabled: true, url: 'https://example.invalid/dav', folder: false, archive: false };
  const r = await m.runBackup({ manual: true });
  check('one destination with a format is enough to run', r.noFormat !== true, JSON.stringify(r));
  check('and it still writes its snapshot', produced().some((f) => f.startsWith('amelie-vault-')), produced().join(', '));
}

// ── The message exists everywhere the app is translated ──────────────────────
{
  const src = fs.readFileSync(path.join(HERE, '../src/renderer/i18n.js'), 'utf8');
  const n = (src.match(/'toast\.no_backup_format'/g) || []).length;
  const ref = (src.match(/'toast\.no_backup_dest'/g) || []).length;
  check(`notif exists in all ${ref} languages`, n === ref, `${n} of ${ref}`);
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const r of results) console.log(`${r.pass ? 'ok   ' : 'FAIL '} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(bad ? `\n${bad} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(bad ? 1 : 0);
