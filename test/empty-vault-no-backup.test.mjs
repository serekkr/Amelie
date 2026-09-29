// The backup of nothing: on 2026-09-29 the user deleted every folder in the vault to
// start fresh, with backup and sync still on, and the next backup wrote a .tar.gz
// holding one file — the app's own notes/.amelie-order.json. With keepLast that copy
// takes the place of a real one. The two-way pass was worse off: its baselines still
// listed 1258 files, and with delete propagation on an empty vault reads as "all of
// them deleted here on purpose", i.e. delete the whole remote folder.
//
// An empty vault (dotfiles don't count) is now neither backed up nor synced, and the
// bell says "nothing to back up" / "nothing to sync" instead.
//
// Real SyncManager, real folders, a real local backup; only the window and the
// two-way transport are stubbed.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-empty-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const DEST = path.join(ROOT, 'backup');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, DEST, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });
// What the vault looked like after the user emptied it.
fs.writeFileSync(path.join(NOTES, '.amelie-order.json'), '{"order":[]}');

const CFG = () => ({ sync: { enabled: true,
  local: { enabled: true, path: DEST, folder: false, archive: true, archiveOnly: true, intervalMinutes: 60, keepLast: 5 },
  webdav: { enabled: false, url: '' },
  twoway: { enabled: true, transport: 'samba', useWireGuard: false, propagateDeletes: true, intervalMinutes: 0.5,
            smbLan: { host: '192.168.30.10', ip: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' } } } });

function mgr() {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = CFG();
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  m.sent = [];
  // _setStatus talks to the window; keep what it would have sent.
  m._setStatus = (status, error = null, meta = null) => { m.status = status; m.sent.push({ status, ...(meta || {}) }); };
  m.twowayRuns = 0;
  m._syncTwoway = async () => { m.twowayRuns++; return { uploaded: 0, downloaded: 0 }; };
  return m;
}
const archives = () => fs.readdirSync(DEST).filter((f) => f.endsWith('.tar.gz'));

// ── What counts as empty ─────────────────────────────────────────────────────
{
  const m = mgr();
  check('a vault holding only .amelie-order.json is empty', m._vaultIsEmpty() === true);
  fs.mkdirSync(path.join(NOTES, 'vuota'));
  check('so is one with an empty folder in it', m._vaultIsEmpty() === true);
  fs.mkdirSync(path.join(NOTES, 'vuota', '.obsidian'));
  fs.writeFileSync(path.join(NOTES, 'vuota', '.obsidian', 'app.json'), '{}');
  check('and one whose only files sit in a hidden folder', m._vaultIsEmpty() === true);
  fs.writeFileSync(path.join(ATT, 'photo.png'), 'x');
  check('one attachment is enough to not be empty', m._vaultIsEmpty() === false);
  fs.unlinkSync(path.join(ATT, 'photo.png'));
  fs.writeFileSync(path.join(NOTES, 'vuota', 'nota.md'), '# ciao');
  check('and so is one note, however deep', m._vaultIsEmpty() === false);
  fs.unlinkSync(path.join(NOTES, 'vuota', 'nota.md'));
}

// ── Backup ───────────────────────────────────────────────────────────────────
{
  const m = mgr();
  const pressed = await m.runBackup({ force: true, manual: true });
  check('"Back up now" on an empty vault writes nothing', archives().length === 0, JSON.stringify(archives()));
  check('and answers "empty", not a failure', pressed.success === true && pressed.empty === true, JSON.stringify(pressed));
  check('the bell is told it was empty', m.sent.at(-1)?.empty === true && m.sent.at(-1)?.op === 'backup', JSON.stringify(m.sent));
  const again = await m.runBackup({ force: true, manual: true });
  check('pressed again, it answers again', again.empty === true && m.sent.length === 2, JSON.stringify(m.sent));

  // The first backup of a freshly enabled destination is forced but not manual.
  const first = await m.runBackup({ force: true, manual: false });
  check('a forced first backup refuses too', first.empty === true && archives().length === 0, JSON.stringify(first));
  await m.runBackup();
  await m.runBackup();
  check('the scheduled passes say it once, not every hour', m.sent.length === 3, JSON.stringify(m.sent));
  const st = JSON.parse(fs.readFileSync(path.join(path.dirname(CONF), 'sync-state.json'), 'utf8'));
  check('the skip moves the clock, so a restart does not ask again', typeof st.lastBackupAt === 'string', JSON.stringify(st));

  fs.writeFileSync(path.join(NOTES, 'prima.md'), '# la prima nota');
  const real = await m.runBackup({ force: true, manual: true });
  check('the first note is backed up', real.success === true && !real.empty && archives().length === 1,
    JSON.stringify({ real, a: archives() }));
  fs.unlinkSync(path.join(NOTES, 'prima.md'));
  await m.runBackup();
  check('emptied again, the next scheduled pass speaks up again', m.sent.at(-1)?.empty === true, JSON.stringify(m.sent.at(-1)));
  check('and still writes nothing', archives().length === 1, JSON.stringify(archives()));
}

// ── Two-way sync ─────────────────────────────────────────────────────────────
{
  const m = mgr();
  const pressed = await m.runTwoway({ manual: true });
  check('Sync on an empty vault never reaches the remote', m.twowayRuns === 0, String(m.twowayRuns));
  check('and answers "empty"', pressed.success === true && pressed.empty === true, JSON.stringify(pressed));
  check('the bell is told it was empty, as a sync', m.sent.at(-1)?.empty === true && m.sent.at(-1)?.op === 'twoway', JSON.stringify(m.sent));
  await m.runTwoway({ manual: false });
  await m.runTwoway({ manual: false });
  check('the 30-second passes say it once', m.sent.length === 2, JSON.stringify(m.sent));
  check('and the one they say is not muted as a frequent pass', m.sent.at(-1)?.quiet !== true, JSON.stringify(m.sent.at(-1)));

  fs.writeFileSync(path.join(NOTES, 'prima.md'), '# la prima nota');
  const real = await m.runTwoway({ manual: true });
  check('with a note in it, the sync runs', m.twowayRuns === 1 && real.success === true && !real.empty, JSON.stringify(real));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
