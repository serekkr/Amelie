// What a two-way pass changed ON THIS COMPUTER has to reach the renderer.
//
// serekkr, 13/10/2026: with a note open and a newer copy of it on the share, a manual
// sync pulled the new version onto disk and left the OLD text on screen — a tab keeps
// its own copy and only a fresh open re-reads the file, so the way to see what had
// arrived was to walk to another note and come back. The renderer can only reload what
// it is told about, and the pass was telling it nothing.
//
// So: the status event a finished pass sends now carries the notes it rewrote here,
// relative to notes/ (which is what a tab carries). Drives the real SyncManager with no
// Electron — the transport is stubbed, everything around it is the real code.
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
const check = (name, pass, detail = '') => { results.push(!!pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `   [${detail}]`}`); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-refresh-'));
const NOTES = path.join(ROOT, 'notes'), ATT = path.join(ROOT, 'attachments');
fs.mkdirSync(NOTES, { recursive: true }); fs.mkdirSync(ATT, { recursive: true });
fs.writeFileSync(path.join(NOTES, 'a.md'), 'a note, so the vault is not empty');

// A pass whose log we decide, and a status we can read back.
function mgr(log) {
  const m = new SyncManager(NOTES, ATT, path.join(ROOT, 'settings.json'));
  m.config = { sync: { enabled: true, twoway: { enabled: true, transport: 'webdav',
    webdav: { url: 'https://example.invalid/dav', remotePath: 'amelie/sync' } } } };
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {}; m._stopAutoSync = () => {}; m._stopTimers = () => {}; m._setupWebDAV = () => {};
  m._progress = () => {};
  m._recordTwowayState = () => {};
  m.sent = [];
  m._setStatus = (status, error, meta) => m.sent.push({ status, meta: meta || {} });
  m._syncTwoway = async () => {
    m._twowayLog = log;
    const n = (a) => log.filter(e => e[0] === a).length;
    return { uploaded: n('up'), downloaded: n('down'), deleted: 0, conflicts: n('conflict') };
  };
  return m;
}
const lastOk = (m) => [...m.sent].reverse().find(s => s.status === 'ok')?.meta || {};

// ── A note that came down, and one that went up ──────────────────────────────
{
  const m = mgr([['down', 'notes/02 - Work/report.md'], ['up', 'notes/mine.md'],
                 ['down', 'attachments/pdf/x.pdf'], ['del-local', 'notes/gone.md']]);
  await m.runTwoway({ manual: true });
  const meta = lastOk(m);
  check('a note pulled down is named, relative to notes/',
    JSON.stringify(meta.refreshed) === JSON.stringify(['02 - Work/report.md']), JSON.stringify(meta.refreshed));
  check('a note that went UP is not — nothing changed here', !(meta.refreshed || []).includes('mine.md'), JSON.stringify(meta.refreshed));
  check('nor is an attachment: the editor has no copy of one to refresh',
    !(meta.refreshed || []).some(p => /\.pdf$/.test(p)), JSON.stringify(meta.refreshed));
  check('and nothing says "check everything"', !meta.refreshAll, String(meta.refreshAll));
}

// ── A conflict the remote won also replaces the file under the open name ─────
{
  const m = mgr([['conflict', 'notes/shared.md', 'notes/shared (conflitto 2026-10-13).md']]);
  await m.runTwoway({ manual: true });
  check('a conflict names the canonical note, which may have been replaced',
    (lastOk(m).refreshed || []).includes('shared.md'), JSON.stringify(lastOk(m).refreshed));
}

// ── A first pass pulls hundreds: send the flag, not the list ─────────────────
{
  const many = Array.from({ length: 301 }, (_, i) => ['down', `notes/n${i}.md`]);
  const m = mgr(many);
  await m.runTwoway({ manual: true });
  const meta = lastOk(m);
  check('past 300 the list is dropped for a flag', meta.refreshAll === true && !meta.refreshed,
    `${meta.refreshAll} / ${(meta.refreshed || []).length}`);
}

// ── A pass that moved nothing says nothing ───────────────────────────────────
{
  const m = mgr([]);
  await m.runTwoway({ manual: true });
  const meta = lastOk(m);
  check('a pass that changed nothing here asks for no refresh', !meta.refreshed && !meta.refreshAll,
    JSON.stringify(meta));
}

// ── The report still gets the log (reading it must not consume it) ───────────
{
  const m = mgr([['down', 'notes/one.md']]);
  await m.runTwoway({ manual: true });
  const rep = m._readSyncReports()[0];
  check('and the pass report still holds the same entry', rep && rep.files && rep.files.length === 1,
    JSON.stringify(rep && rep.counts));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter(r => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
