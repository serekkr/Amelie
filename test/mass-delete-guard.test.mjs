// The sync that would have emptied the NAS: on 2026-09-29 the user emptied the vault
// to start over while the two-way baselines still listed 1258 files on the share,
// with delete propagation on. The first new note would have made the vault non-empty
// again, and that pass would have deleted all 1258 from the share — "deleted here on
// purpose", as far as the baselines could tell — without a word.
//
// A pass that would delete more than half of one side (at least five files), or all
// of it, now stops BEFORE transferring anything and asks, like Nextcloud's "all files
// removed" prompt: delete, put them back, or do nothing.
//
// Real SyncManager and the real Samba two-way loop against an in-memory share; only
// the SMB helper binary and the window are replaced. HOME points at a temp folder,
// because the two-way baselines live in ~/.local/share/amelie.
//
//   run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-massdel-'));
process.env.HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(process.env.HOME, '.local', 'share', 'amelie'), { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

const VAULT = path.join(ROOT, 'vault');
const NOTES = path.join(VAULT, 'notes');
const ATT = path.join(VAULT, 'attachments');
const CONF = path.join(ROOT, 'conf', 'settings.json');
fs.mkdirSync(path.dirname(CONF), { recursive: true });
const STATE = path.join(process.env.HOME, '.local', 'share', 'amelie', 'twoway-state.json');
const SMB = { host: '192.168.30.10', ip: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' };
const KEY = '//192.168.30.10/saturn/amelie\\sync';
const T0 = Date.now() - 3600e3;   // everything last in sync an hour ago

// The share: rel → { mtime, body }. Replaces the amelie-smb helper.
let share = {};
let calls = [];
function mgr(answer) {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = { sync: { enabled: true, local: { enabled: false }, webdav: { enabled: false },
    twoway: { enabled: true, transport: 'samba', useWireGuard: false, propagateDeletes: true, conflictCopies: false,
              intervalMinutes: 0.5, smbLan: SMB } } };
  m.sent = [];
  m._setStatus = (status, error = null, meta = null) => { m.status = status; m.sent.push({ status, error, ...(meta || {}) }); };
  m._smbHasFile = async () => false;
  m._smbWriteFile = async () => {};
  m._smbListRecursive = async () => Object.fromEntries(Object.entries(share).map(([k, v]) => [k, v.mtime]));
  m._smb = async (_cfg, args) => {
    const [op, a, b] = args;
    calls.push(op);
    const rel = (p) => p.replace(/^amelie\/sync\//, '');
    if (op === 'put') share[rel(b)] = { mtime: Date.now(), body: fs.readFileSync(a, 'utf8') };
    else if (op === 'get') fs.writeFileSync(b, share[rel(a)].body);
    else if (op === 'del') delete share[rel(a)];
    return '';
  };
  m.asked = [];
  m.prog = [];
  m._progress = (p) => m.prog.push(p);
  if (answer !== undefined) m._askMassDelete = async (info) => { m.asked.push(info); return answer; };
  return m;
}

// N notes on both sides, in sync, with baselines — the state before the user emptied it.
function inSync(n) {
  fs.rmSync(VAULT, { recursive: true, force: true });
  fs.mkdirSync(NOTES, { recursive: true }); fs.mkdirSync(ATT, { recursive: true });
  share = {}; calls = [];
  const st = {};
  for (let i = 0; i < n; i++) {
    const rel = `notes/old/nota-${i}.md`;
    const abs = path.join(NOTES, 'old', `nota-${i}.md`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `# ${i}`);
    fs.utimesSync(abs, T0 / 1000, T0 / 1000);
    share[rel] = { mtime: T0, body: `# ${i}` };
    st[rel] = { r: T0, l: T0 };
  }
  fs.writeFileSync(STATE, JSON.stringify({ [KEY]: st }));
}
// The user's move: delete every folder, then write one new note.
function emptyThenOneNote() {
  fs.rmSync(path.join(NOTES, 'old'), { recursive: true, force: true });
  fs.writeFileSync(path.join(NOTES, 'nuova.md'), '# ripartenza');
}
const localNotes = () => fs.readdirSync(NOTES, { recursive: true }).filter((f) => f.endsWith('.md'));

// ── The threshold ────────────────────────────────────────────────────────────
{
  const M = SyncManager._isMassDelete;
  check('one note deleted is never a mass delete', !M(1, 1) && !M(1, 20));
  check('a folder of four out of twenty is not', !M(4, 20));
  check('half is not more than half', !M(10, 20));
  check('eleven out of twenty is', M(11, 20));
  check('1258 out of 1258 is', M(1258, 1258));
  check('all of a tiny vault is, from two files up', M(2, 2) && M(3, 3));
  check('but four of seven is not (under five)', !M(4, 7));
}

// ── The user's case, answered "do nothing" ──────────────────────────────────
{
  inSync(20);
  emptyThenOneNote();
  const m = mgr('cancel');
  const r = await m.runTwoway({ manual: false });
  check('the pass stops and asks', m.asked.length === 1 && m.asked[0].where === 'remote', JSON.stringify(m.asked));
  check('the status line says it is waiting for the answer', m.prog.some((p) => p.phase === 'waiting' && p.total === 20), JSON.stringify(m.prog));
  check('and a held pass ends it without claiming anything moved', m.prog.at(-1).final && m.prog.at(-1).error === true, JSON.stringify(m.prog.at(-1)));
  check('with the numbers and where', m.asked[0]?.count === 20 && m.asked[0]?.total === 20
    && m.asked[0]?.target === '192.168.30.10/saturn/amelie/sync', JSON.stringify(m.asked[0]));
  check('and a few names to recognise them by', m.asked[0]?.examples?.length === 5, JSON.stringify(m.asked[0]?.examples));
  check('"do nothing" deletes nothing on the share', Object.keys(share).length === 20 && !calls.includes('del'), JSON.stringify(calls));
  check('and transfers nothing either — not even the new note', !calls.includes('put') && !calls.includes('get'), JSON.stringify(calls));
  check('the pass reports it was held, not that it synced', r.success === false && m.sent.at(-1)?.heldDeletes?.count === 20,
    JSON.stringify({ r, last: m.sent.at(-1) }));
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'))[KEY];
  check('the baselines are untouched, so the next pass asks again', Object.keys(st).length === 20, String(Object.keys(st).length));
  const again = mgr('cancel');
  await again.runTwoway({ manual: true });
  check('and it does', again.asked.length === 1, JSON.stringify(again.asked));
}

// ── "Delete": the fresh start goes to the share too ─────────────────────────
{
  inSync(20);
  emptyThenOneNote();
  const m = mgr('delete');
  const r = await m.runTwoway({ manual: true });
  check('"delete" empties the old files from the share', r.success === true && !Object.keys(share).some((k) => k.startsWith('notes/old/')),
    JSON.stringify(Object.keys(share)));
  check('and uploads the new note', 'notes/nuova.md' in share, JSON.stringify(Object.keys(share)));
  check('the local vault keeps only the new note', JSON.stringify(localNotes()) === '["nuova.md"]', JSON.stringify(localNotes()));
  // The report of that pass: every file, and what happened to it.
  const ok = m.sent.filter((x) => x.status === 'ok').at(-1) || {};
  const rep = ok.report && m.getSyncReport(ok.report.id);
  check('the pass leaves a report the bell can open', !!rep && ok.report.counts.delRemote === 20 && ok.report.counts.up === 1,
    JSON.stringify(ok.report));
  check('holding every file it touched, by name', !!rep && rep.files.length === 21
    && rep.files.some(([a, f]) => a === 'del-remote' && f === 'notes/old/nota-7.md') && rep.files.some(([a, f]) => a === 'up' && f === 'notes/nuova.md'),
    JSON.stringify(rep && rep.files.slice(0, 3)));
  const before = m.listSyncReports().length;
  await m.runTwoway({ manual: true });
  check('a pass that moved nothing adds no report', m.listSyncReports().length === before && !m.sent.at(-1).report, String(m.listSyncReports().length));
  check('the list comes without the file lists', m.listSyncReports().every((r) => !('files' in r) && r.counts));
}

// ── "Put them back": the share keeps them and they come home ────────────────
{
  inSync(20);
  emptyThenOneNote();
  const m = mgr('restore');
  const r = await m.runTwoway({ manual: true });
  check('"put back" deletes nothing on the share', r.success === true && !calls.includes('del') && Object.keys(share).length === 21,
    JSON.stringify({ calls: calls.filter((c) => c !== 'mkdirp'), n: Object.keys(share).length }));
  check('and downloads all twenty again', localNotes().length === 21, String(localNotes().length));
  const ok = m.sent.filter((x) => x.status === 'ok').at(-1) || {};
  check('its report counts twenty down and one up', ok.report && ok.report.counts.down === 20 && ok.report.counts.up === 1 && ok.report.counts.total === 21,
    JSON.stringify(ok.report));
  // The sidebar's status line is fed from this pass: every transfer, in order.
  const tr = m.prog.filter((p) => p.phase === 'transfer');
  check('progress counts every transfer, 1 to 21', tr.length === 21 && tr[0].done === 1 && tr.at(-1).done === 21
    && tr.every((p) => p.total === 21), JSON.stringify(tr.map((p) => p.done)));
  check('and names the file and what happens to it', tr.some((p) => p.action === 'download' && p.file === 'notes/old/nota-0.md')
    && tr.some((p) => p.action === 'upload' && p.file === 'notes/nuova.md'), JSON.stringify(tr.slice(0, 2)));
  check('it opens with the listing and closes with the total moved',
    m.prog[0].phase === 'listing' && m.prog.at(-1).final === true && m.prog.at(-1).total === 21,
    JSON.stringify([m.prog[0], m.prog.at(-1)]));
}

// ── Ordinary deletes are not asked about ─────────────────────────────────────
{
  inSync(20);
  fs.rmSync(path.join(NOTES, 'old', 'nota-3.md'));
  for (let i = 10; i < 14; i++) fs.rmSync(path.join(NOTES, 'old', `nota-${i}.md`));
  const m = mgr('cancel');
  const r = await m.runTwoway({ manual: false });
  check('deleting five notes of twenty goes straight through', r.success === true && m.asked.length === 0, JSON.stringify(m.asked));
  check('and removes them from the share', Object.keys(share).length === 15, String(Object.keys(share).length));
}

// ── The other direction: the other PC emptied the share ─────────────────────
{
  inSync(20);
  for (let i = 1; i < 20; i++) delete share[`notes/old/nota-${i}.md`];   // one left, so the empty-listing guard is not what stops it
  const m = mgr('cancel');
  const r = await m.runTwoway({ manual: false });
  check('19 of 20 about to be deleted HERE is asked too', m.asked.length === 1 && m.asked[0].where === 'local' && m.asked[0].count === 19,
    JSON.stringify(m.asked));
  check('and "do nothing" keeps every local note', r.success === false && localNotes().length === 20, String(localNotes().length));
  const back = mgr('restore');
  await back.runTwoway({ manual: true });
  check('"put back" re-uploads them to the share', Object.keys(share).length === 20 && localNotes().length === 20,
    JSON.stringify({ share: Object.keys(share).length, local: localNotes().length }));
}

// ── Nobody to ask ────────────────────────────────────────────────────────────
{
  inSync(20);
  emptyThenOneNote();
  const m = mgr();                         // the real _askMassDelete, and there is no window here
  const r = await m.runTwoway({ manual: false });
  check('with no window to ask, nothing is deleted', r.success === false && Object.keys(share).length === 20 && !calls.includes('del'),
    JSON.stringify({ r, n: Object.keys(share).length }));
}

// ── While the question is open ──────────────────────────────────────────────
{
  inSync(20);
  emptyThenOneNote();
  const m = mgr();
  let sentInfo = null;
  const fakeWin = { isDestroyed: () => false, once() {}, removeListener() {},
                    webContents: { send: (_ch, info) => { sentInfo = info; } } };
  SyncManager.askWindow = () => fakeWin;
  const pass = m.runTwoway({ manual: false });
  await new Promise((r) => setTimeout(r, 50));
  check('the question reaches the window', !!sentInfo && sentInfo.count === 20, JSON.stringify(sentInfo));
  check('the engine counts as busy, so the timer cannot start another pass', m._busy() === true);
  const second = await m.runTwoway({ manual: false });
  check('and a second pass is turned away', second.success === false && second.error === 'Already syncing', JSON.stringify(second));
  if (sentInfo) m.answerMassDelete(sentInfo.id, 'something unexpected');
  const r = await pass;
  check('an answer it does not know counts as "do nothing"', r.success === false && Object.keys(share).length === 20, JSON.stringify(r));
  check('and afterwards the engine is free again', m._busy() === false);
  SyncManager.askWindow = null;
}

// ── Reports kept: the last twenty ───────────────────────────────────────────
{
  const m = mgr('cancel');
  for (let i = 0; i < 25; i++) { m._twowayLog = [['down', `notes/n${i}.md`]]; m._saveTwowayReport({}); }
  const all = m.listSyncReports();
  check('only the last twenty reports are kept, newest first', all.length === SyncManager.SYNC_REPORTS_KEEP
    && m.getSyncReport(all[0].id).files[0][1] === 'notes/n24.md', JSON.stringify(all.length));
}

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
