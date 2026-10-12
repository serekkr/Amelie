// A brand-new install does not back itself up before there is anything to back up.
//
// Reported on 2026-10-12, minutes after a from-scratch install: the Local destination
// was switched on and a notification said "automatic backup completed" — on a vault
// the user had not written a line in. Nothing was broken: the app writes `Welcome.md`
// itself (main.js), so the vault was not EMPTY, and switching a destination on fires
// one forced first copy on purpose (otherwise the "nothing changed" shortcut would
// leave a brand-new destination empty until the first edit). The copy was real, it
// just held the app's own welcome note. His answer: "non vedo il senso di creare un
// backup automatico con solo la nota welcome".
//
// So every AUTOMATIC run is skipped in exactly that state — and in no other. The first
// try guarded only the timer that fires after switching a destination on, and he saw
// the notice again: the CATCH-UP ("no record of a previous backup") runs one too, at
// the next start. The rule now sits at the one door every backup goes through, which
// is also where the empty-vault rule lives.
//
// What this pins down is the "and in no other", because the dangerous mistake here is
// a guard that grows: a SECOND note, an attachment, a folder, or the welcome note
// edited by the user all make it a normal vault again, and nothing of theirs ever goes
// uncopied. And pressing "Back up now" copies even then — that one was asked for.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-welcome-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const DEST = path.join(ROOT, 'backup');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, DEST, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });

// Byte for byte what main.js writes into a fresh vault.
const WELCOME = '# October 12, 2026\n\nStart writing your thoughts…\n';
const writeWelcome = (body = WELCOME) => fs.writeFileSync(path.join(NOTES, 'Welcome.md'), body);

const CFG = () => ({ sync: { enabled: true,
  local: { enabled: true, path: DEST, folder: false, archive: true, archiveOnly: true, intervalMinutes: 60, keepLast: 5 },
  webdav: { enabled: false, url: '' } } });

function mgr() {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = CFG();
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  m.sent = [];
  m._setStatus = (status, error = null, meta = null) => { m.status = status; m.sent.push({ status, ...(meta || {}) }); };
  return m;
}
const archives = () => fs.readdirSync(DEST).filter((f) => f.endsWith('.tar.gz'));

// ── What counts as "nothing of mine yet" ────────────────────────────────────
{
  const m = mgr();
  writeWelcome();
  check('the welcome note alone is "nothing of mine yet"', m._vaultIsOnlyWelcome() === true);

  fs.writeFileSync(path.join(NOTES, 'mia.md'), '# mia\n');
  check('a second note makes it an ordinary vault', m._vaultIsOnlyWelcome() === false);
  fs.unlinkSync(path.join(NOTES, 'mia.md'));

  fs.writeFileSync(path.join(ATT, 'foto.png'), 'x');
  check('so does one attachment', m._vaultIsOnlyWelcome() === false);
  fs.unlinkSync(path.join(ATT, 'foto.png'));

  fs.mkdirSync(path.join(NOTES, 'Lavoro'));
  fs.writeFileSync(path.join(NOTES, 'Lavoro', 'nota.md'), '# nota\n');
  check('and a note inside a folder', m._vaultIsOnlyWelcome() === false);
  fs.rmSync(path.join(NOTES, 'Lavoro'), { recursive: true, force: true });

  writeWelcome(WELCOME.replace('…', '…\n\nla mia prima riga'));
  check('the welcome note WRITTEN IN is the user\'s own note', m._vaultIsOnlyWelcome() === false);
  writeWelcome();
  check('and untouched again it is back to "nothing of mine"', m._vaultIsOnlyWelcome() === true);

  fs.writeFileSync(path.join(NOTES, '.amelie-order.json'), '{"":[]}');
  check('the app\'s own dotfile does not count', m._vaultIsOnlyWelcome() === true);

  fs.renameSync(path.join(NOTES, 'Welcome.md'), path.join(NOTES, 'Benvenuto.md'));
  check('a note named something else is not the welcome note', m._vaultIsOnlyWelcome() === false);
  fs.renameSync(path.join(NOTES, 'Benvenuto.md'), path.join(NOTES, 'Welcome.md'));
}

// ── What happens when a destination is switched on ──────────────────────────
{
  const m = mgr();
  // Switching Local on: reloadConfig sees a destination it was not writing before and
  // schedules the one forced copy. Nothing else in this test touches that timer.
  m._FIRST_BACKUP_DELAY_MS = 20;
  m.config = { sync: {} };
  m.reloadConfig(CFG());
  await new Promise((r) => setTimeout(r, 300));
  // "Nothing said" means nothing the bell would print: logSyncEventNotif only ever
  // speaks for 'ok' and 'error', so an 'idle' is the skip passing through quietly.
  const speaks = (sent) => sent.filter(x => x.status === 'ok' || x.status === 'error');
  check('no first copy, and nothing the bell would say, on a vault holding only the welcome note',
    archives().length === 0 && speaks(m.sent).length === 0, JSON.stringify({ archives: archives(), sent: m.sent }));

  // The catch-up, which is what he saw the second time: at the next start there is
  // "no record of a previous backup", so one is queued — and it must skip too.
  {
    const m3 = mgr();
    const caught = await m3.runBackup({ manual: false });
    check('the catch-up run skips it as well, silently',
      caught.onlyWelcome === true && archives().length === 0 && speaks(m3.sent).length === 0,
      JSON.stringify({ caught, archives: archives(), sent: m3.sent }));
  }
  // Pressing the button is a different matter: it was asked for.
  {
    const m4 = mgr();
    const pressed = await m4.runBackup({ force: true, manual: true });
    check('"Back up now" still copies, even with only the welcome note',
      pressed.success === true && !pressed.onlyWelcome && archives().length === 1,
      JSON.stringify({ pressed, archives: archives() }));
    fs.rmSync(path.join(DEST, archives()[0]));
  }

  // The user writes something: from here on it is an ordinary vault.
  fs.writeFileSync(path.join(NOTES, 'prima.md'), '# la mia prima nota\n');
  const run = await m.runBackup();
  check('as soon as there is a note of theirs, the scheduled pass copies it',
    run.success === true && archives().length === 1, JSON.stringify({ run, archives: archives() }));

  // And switching another destination on NOW does get its first copy. Counted on the
  // call, not on the file: two archives made inside the same second carry the same
  // timestamped name, so counting files would say one and mean nothing.
  const m2 = mgr();
  m2._FIRST_BACKUP_DELAY_MS = 20;
  const calls = [];
  const realRun = m2.runBackup.bind(m2);
  m2.runBackup = (opts = {}) => { calls.push(opts); return realRun(opts); };
  m2.config = { sync: {} };
  m2.reloadConfig(CFG());
  await new Promise((r) => setTimeout(r, 400));
  check('a destination switched on over a real vault still gets its first copy at once',
    calls.length === 1 && calls[0].force === true && calls[0].manual === false, JSON.stringify(calls));
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n        ${r.detail}`}`);
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
