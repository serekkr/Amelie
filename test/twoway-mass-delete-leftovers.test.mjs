// After "delete from server", what is left on the server must GO — and the empty
// folders with it.
//
// From serekkr's own share on 12/10/2026. He emptied the vault, the guard asked, he
// chose "delete from server", and two passes deleted 1233 files. What he then saw on
// the share was 162 folders and four files, and three of those files had also come
// BACK into the vault he had just emptied.
//
// Two faults, both fixed here:
//   1. a file that survived the deletion had no baseline left, so the next pass read
//      it as "new on the server" and DOWNLOADED it — a deletion undoing itself;
//   2. deleting files never removed the folders they were in, so the tree stayed
//      standing and the share looked untouched.
//
// What did NOT change, on purpose: the question. The leftovers are asked about again,
// like any other mass delete — "perché voglio che mi chieda, quando manca" (serekkr,
// 12/10/2026). Remembering the answer decides what to DO with what is left, not
// whether to ask.
//
// Driven against a fake share: the SMB helper calls are stubbed, so what is checked
// is the engine's decisions — which file it deletes, which it fetches, which folder
// it sweeps — not whether Samba works.
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

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-leftover-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });

const SMB = { host: '10.0.0.9', share: 'saturn', remoteSubPath: 'amelie/sync', username: 'u', password: 'p' };
const CFG = () => ({ sync: { enabled: true, twoway: {
  enabled: true, transport: 'samba', useWireGuard: false, propagateDeletes: true,
  conflictCopies: true, intervalMinutes: 15, smbLan: { ...SMB, ip: SMB.host } } } });

// The fake share: a map of path → mtime, plus the folders, and a log of what was asked.
function fakeShare(files, dirs) {
  return { files: { ...files }, dirs: [...dirs], deleted: [], downloaded: [] };
}

function mgr(share, { answer = 'delete' } = {}) {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = CFG();
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {}; m._stopAutoSync = () => {}; m._stopTimers = () => {}; m._setupWebDAV = () => {};
  m._setStatus = () => {};
  m._progress = () => {};
  // The share, as the engine sees it.
  m._smbListRecursive = async (_cfg, _base, { withDirs = false } = {}) => {
    const map = { ...share.files };
    return withDirs ? { map, dirs: [...share.dirs] } : map;
  };
  m._smb = async (_cfg, args) => {
    const [cmd, remote] = args;
    const rel = String(remote || '').replace(/^amelie\/sync\//, '');
    if (cmd === 'del') {
      if (rel in share.files) { delete share.files[rel]; share.deleted.push(rel); return ''; }
      const i = share.dirs.indexOf(rel);
      if (i >= 0) { share.dirs.splice(i, 1); share.deleted.push(rel + '/'); return ''; }
      throw new Error('NT_STATUS_NO_SUCH_FILE');
    }
    return '';
  };
  m._smbGet = async () => true;
  // Downloading is what must NOT happen to a leftover: record it and write the file.
  m._twowayDownload = async () => true;
  m.asked = [];
  m._askMassDelete = async (info) => { m.asked.push(info); return answer; };
  return m;
}

// The engine's private download/upload helpers live inside _twowaySamba; the simplest
// honest way to see what it decided is to watch the share and the vault after a pass.
async function runPass(m) {
  // The second argument is the remote subfolder — without it the engine works on a
  // folder called "undefined" and nothing matches the state key.
  try { return await m._twowaySamba(m.config.sync.twoway.smbLan, 'amelie/sync'); }
  catch (e) { return { error: e.message }; }
}

// ── The empty-folder sweep, on its own ──────────────────────────────────────
{
  const dirs = ['notes', 'notes/a', 'notes/a/b', 'attachments', 'attachments/images'];
  const left = ['notes/a/tenuta.md'];
  const empties = SyncManager._emptyDirsDeepestFirst(dirs, left);
  check('a folder with a file under it is kept', !empties.includes('notes/a') && !empties.includes('notes'),
    JSON.stringify(empties));
  check('the ones with nothing left are swept', empties.includes('notes/a/b') && empties.includes('attachments/images') && empties.includes('attachments'),
    JSON.stringify(empties));
  check('deepest first, so a parent goes after its children',
    empties.indexOf('notes/a/b') < empties.indexOf('attachments'), JSON.stringify(empties));
}

// ── A leftover is deleted next pass, not downloaded ─────────────────────────
{
  // The vault is empty; the share still holds one file and its folders. The baseline
  // is gone (that is what a mass delete leaves behind), and the pending list says the
  // user asked for that file to go.
  const share = fakeShare({ 'attachments/images/foto.png': Date.now() - 60000 },
                          ['notes', 'attachments', 'attachments/images']);
  const stateFile = path.join(os.homedir(), '.local', 'share', 'amelie', 'twoway-state.json');
  const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  const key = `//${SMB.host}/${SMB.share}/amelie\\sync`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    [key]: { 'notes/.amelie-order.json': { r: 1, l: 1 } },          // a baseline exists → not a first run
    [`__massdel__${key}`]: ['attachments/images/foto.png'],
  }));
  const m = mgr(share);
  const out = await runPass(m);
  if (out && out.error) console.log('      [passata] errore:', out.error);
  else console.log('      [passata]', JSON.stringify(out));
  check('the leftover of an approved mass delete is deleted, not fetched',
    !('attachments/images/foto.png' in share.files) && share.deleted.includes('attachments/images/foto.png'),
    JSON.stringify({ rimasti: Object.keys(share.files), cancellati: share.deleted }));
  check('and it did not come back into the vault',
    !fs.existsSync(path.join(ATT, 'images', 'foto.png')), 'il file è tornato in locale');
  check('the empty folders went too',
    share.dirs.length === 0, JSON.stringify(share.dirs));
  check('one file alone is not a mass delete, so nothing was asked',
    m.asked.length === 0, JSON.stringify(m.asked));
  const after = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('and the pending list is cleared once there is nothing left of it',
    !after[`__massdel__${key}`], JSON.stringify(after[`__massdel__${key}`]));
  if (before == null) fs.rmSync(stateFile, { force: true }); else fs.writeFileSync(stateFile, before);
}

// ── The question stays, every time ──────────────────────────────────────────
// Eight leftovers of an approved delete, with the vault still empty: that is a mass
// delete by any measure, and it must be ASKED about again — not remembered away.
{
  const files = {}; for (let i = 1; i <= 8; i++) files[`notes/vecchia-${i}.md`] = Date.now() - 60000;
  const share = fakeShare(files, ['notes']);
  const stateFile = path.join(os.homedir(), '.local', 'share', 'amelie', 'twoway-state.json');
  const before = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
  const key = `//${SMB.host}/${SMB.share}/amelie\\sync`;
  fs.writeFileSync(stateFile, JSON.stringify({
    [key]: { 'notes/.amelie-order.json': { r: 1, l: 1 } },
    [`__massdel__${key}`]: Object.keys(files),
  }));
  const m = mgr(share);
  await runPass(m);
  check('a pile of leftovers is asked about again, like any mass delete',
    m.asked.length >= 1 && m.asked[0].where === 'remote' && m.asked[0].count === 8,
    JSON.stringify(m.asked));
  check('and once the answer is given they go, all of them',
    Object.keys(share.files).length === 0, JSON.stringify(Object.keys(share.files)));
  if (before == null) fs.rmSync(stateFile, { force: true }); else fs.writeFileSync(stateFile, before);
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `\n        ${r.detail}`}`);
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
