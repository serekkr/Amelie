// "Nothing changed" is said for the sync too, and both messages say WHY.
//
// Asked 2026-09-30: the bell read "Automatic backup skipped" — skipped why? — and a
// two-way pass that moved nothing said nothing of the kind. Both now end in
// "because nothing changed", in every language, and the sync says it the way the
// backup does: once per quiet stretch for the automatic passes, every time for a
// press of the button. A pass that moves a file, or makes a conflict copy, is not
// "unchanged".
//
// Real SyncManager; only the window and the two-way transport are stubbed.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-unchanged-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const DEST = path.join(ROOT, 'backup');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, DEST, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(NOTES, 'nota.md'), '# una nota');

// Every 2 h: passes up to an hour apart are "quiet" whatever they did (the bell is
// not told about a sync every 30 s at all), and this is about what an unchanged
// pass says when it IS worth a line.
const CFG = () => ({ sync: { enabled: true,
  local: { enabled: true, path: DEST, folder: false, archive: true, archiveOnly: true, intervalMinutes: 60, keepLast: 5 },
  webdav: { enabled: false, url: '' },
  twoway: { enabled: true, transport: 'samba', useWireGuard: false, propagateDeletes: true, intervalMinutes: 120,
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

const last = (m) => m.sent.filter((s) => s.status === 'ok').at(-1) || {};
const said = (m) => m.sent.filter((s) => s.status === 'ok' && s.unchanged && !s.quiet).length;
{
  const m = mgr();
  await m.runTwoway();
  check('an automatic pass that moved nothing is reported as unchanged', last(m).unchanged === true && !last(m).quiet, JSON.stringify(last(m)));
  await m.runTwoway(); await m.runTwoway();
  check('…once: the next quiet passes do not say it again', said(m) === 1, JSON.stringify(m.sent));
  await m.runTwoway({ manual: true });
  check('a press of Sync always says it', said(m) === 2 && last(m).manual === true, JSON.stringify(last(m)));

  m._syncTwoway = async () => ({ uploaded: 1, downloaded: 0 });
  await m.runTwoway();
  check('a pass that moved a file is not "unchanged"', !last(m).unchanged, JSON.stringify(last(m)));
  m._syncTwoway = async () => ({ uploaded: 0, downloaded: 0 });
  await m.runTwoway();
  check('after it, the next unchanged pass speaks again', said(m) === 3 && !last(m).quiet, JSON.stringify(last(m)));

  m._syncTwoway = async () => ({ uploaded: 0, downloaded: 0, conflicts: 1 });
  await m.runTwoway();
  check('nor is a pass that made a conflict copy', !last(m).unchanged, JSON.stringify(last(m)));
}

// ── The words ────────────────────────────────────────────────────────────────
{
  const I18N = fs.readFileSync(path.join(HERE, '../src/renderer/i18n.js'), 'utf8');
  const APP = fs.readFileSync(path.join(HERE, '../src/renderer/app.js'), 'utf8');
  const all = (k) => [...I18N.matchAll(new RegExp(`'${k}': '([^']*)'`, 'g'))].map((m) => m[1]);
  for (const k of ['notif.backup_unchanged', 'notif.backup_unchanged_manual', 'notif.twoway_unchanged', 'notif.twoway_unchanged_manual']) {
    const v = all(k);
    check(`${k} exists in all 7 languages`, v.length === 7, JSON.stringify(v));
  }
  check('Italian says why', all('notif.backup_unchanged')[0] === 'Backup automatico saltato perché non è cambiato niente'
    && all('notif.twoway_unchanged')[0] === 'Sincronizzazione automatica saltata perché non è cambiato niente', JSON.stringify(all('notif.twoway_unchanged')));
  check('English says why', all('notif.backup_unchanged')[1] === 'Automatic backup skipped because nothing changed'
    && all('notif.twoway_unchanged')[1] === 'Automatic sync skipped because nothing changed');
  check('the bell picks the sync wording for a sync', APP.includes("`notif.${data.op === 'twoway' ? 'twoway' : 'backup'}_unchanged${data.manual ? '_manual' : ''}`"));
  check('"Back up now" never calls itself automatic', !APP.includes("window.i18n.t('notif.backup_unchanged')"));
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n        ${r.detail}`}`);
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
