// Restore handed an OBSIDIAN vault imports it the way dropping the folder does.
//
// Restore used to take only Amelie's own backups: a folder or .tar.gz with notes/ in it,
// swapped in as it is. An Obsidian vault was refused ("manca la cartella notes"), and
// even one that happened to hold a notes/ folder would have been swapped in with its
// `![[img.png]]` embeds untouched and its images wherever Obsidian kept them. Asked on
// 2026-09-23 that it follow the same logic as the drag-and-drop import — so this checks,
// on the real app, that through Restore:
//   1. an Obsidian folder (with .obsidian/, and with a folder of its own called notes/)
//      is IMPORTED: embeds rewritten, the image filed under attachments/images/
//   2. the notes already in the vault stay where they are — nothing is moved aside
//   3. a synced copy WITHOUT .obsidian/ is recognised as well
//   4. a .tar.gz of an Obsidian vault, wrapped in a folder, is imported under that
//      folder's name, and a note with no dates of its own keeps the archive's mtime
//   5. an Amelie backup is still restored as before (the current vault moved aside)
//
//   run: npm run test:restoreobs     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-restore-obsidian-test';
const VAULT = `${HOME}/vault`;
const DEST = `${HOME}/backups`;
const PORT = 9263;
const PASS = 'backup-test-passphrase-not-a-real-secret';

const NOTE_A = 'keeper.md';
const NOTE_B = 'victim.md';
const TEXT_A = 'First note.\nWith a second line and some content worth keeping.\n';
const TEXT_B = 'Second note, the one that gets deleted before the restore.\n';

const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = (d) => { try { return fs.readdirSync(d); } catch (_) { return []; } };
const archives = () => ls(DEST).filter((f) => f.endsWith('.tar.gz')).sort();

let child = null;
const cleanup = () => {
  try { if (child) { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);

async function launch({ encrypted }) {
  cleanup();
  await sleep(500);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
  fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
  fs.mkdirSync(DEST, { recursive: true });
  if (!encrypted) {
    // Plaintext vault: seed it directly and skip the wizard.
    fs.writeFileSync(`${VAULT}/notes/${NOTE_A}`, TEXT_A);
    fs.writeFileSync(`${VAULT}/notes/${NOTE_B}`, TEXT_B);
    fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
  }
  child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', `${REPO}/node_modules/.bin/electron`, '.',
    '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
    { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  const findTarget = async (re, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      await sleep(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        const t = list.find((x) => x.type === 'page' && re.test(x.url));
        if (t) return t;
      } catch (_) {}
    }
    return null;
  };
  const connect = async (target) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const send = (method, params = {}, ms = 30000) => new Promise((res) => {
      const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
      setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
    });
    const ev = async (expr, ms = 30000) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
      if (r.timeout) return '<<TIMEOUT>>';
      if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    return { ws, ev };
  };

  if (encrypted) {
    // Build the encrypted vault through the app's own setup, as a user would.
    const setupWin = await findTarget(/vault-setup\.html/);
    if (!setupWin) throw new Error('the setup window never appeared');
    const sx = await connect(setupWin);
    sx.ev(`window.inkwell.vault.setup({ vaultPath: ${JSON.stringify(VAULT)}, encryptionEnabled: true, passphrase: ${JSON.stringify(PASS)} })`, 120000);
    // The key derivation is slow enough to outlive its window: wait for the header on disk.
    for (let i = 0; i < 60 && !fs.existsSync(`${VAULT}/.amelie-vault.json`); i++) await sleep(1000);
    try { sx.ws.close(); } catch (_) {}
  }

  const appWin = await findTarget(/index\.html/);
  if (!appWin) throw new Error('the app window never appeared');
  const cx = await connect(appWin);
  for (let i = 0; i < 40; i++) {
    if (await cx.ev('typeof state !== "undefined" && !!window.inkwell') === true) break;
    await sleep(400);
  }
  if (encrypted) {
    await cx.ev(`window.inkwell.writeNote(${JSON.stringify(NOTE_A)}, ${JSON.stringify(TEXT_A)})`);
    await cx.ev(`window.inkwell.writeNote(${JSON.stringify(NOTE_B)}, ${JSON.stringify(TEXT_B)})`);
    await sleep(800);
  }
  // Point backups at a local folder, archive only, keeping three.
  await cx.ev(`(async () => {
    const c = await window.inkwell.readConfig() || {};
    c.sync = Object.assign({}, c.sync, { enabled: true, backupTransport: 'local',
      local: { enabled: true, path: ${JSON.stringify(DEST)}, folder: false, archive: true, archiveOnly: true, intervalMinutes: 1440, keepLast: 3 } });
    await window.inkwell.writeConfig(c);
    return (await window.inkwell.readConfig()).sync.local;
  })()`);
  return cx;
}


const SRC = `${HOME}/src`;
const MINE = 'mine.md', MINE_TEXT = 'A note of my own, already in Amelie.\n';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const vaultFiles = (d, base = d) => ls(d).flatMap((n) => { const f = path.join(d, n); return fs.statSync(f).isDirectory() ? vaultFiles(f, base) : [path.relative(base, f)]; });
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };

function obsidianVault(dir, { dotObsidian }) {
  fs.mkdirSync(`${dir}/Work/pics`, { recursive: true });
  fs.mkdirSync(`${dir}/notes`, { recursive: true });
  if (dotObsidian) { fs.mkdirSync(`${dir}/.obsidian`, { recursive: true }); fs.writeFileSync(`${dir}/.obsidian/app.json`, '{}'); }
  fs.writeFileSync(`${dir}/Work/pics/diagram.png`, PNG);
  fs.writeFileSync(`${dir}/Work/plan.md`, '---\ncreated: 2025-03-14T09:30\n---\nThe plan.\n\n![[diagram.png]]\n');
  fs.writeFileSync(`${dir}/notes/inside.md`, 'A folder of the vault that happens to be called notes.\n');
}

// 1–2. An Obsidian folder with .obsidian/ AND a folder called notes/.
let cx = await launch({ encrypted: false });
fs.writeFileSync(`${VAULT}/notes/${MINE}`, MINE_TEXT);
obsidianVault(`${SRC}/my-obsidian`, { dotObsidian: true });
const r1 = await cx.ev(`window.inkwell.vault.restoreFolder(${JSON.stringify(`${SRC}/my-obsidian`)}, '')`, 60000);
await sleep(1500);
check('an Obsidian folder is imported, not swapped in', r1 && r1.ok && r1.obsidian === true && r1.notes === 2, JSON.stringify(r1));
const plan = read(`${VAULT}/notes/my-obsidian/Work/plan.md`);
check('the note lands under a folder named after the vault', plan !== null, JSON.stringify(vaultFiles(`${VAULT}/notes`)));
check('its embed is rewritten to where the image now is', !!plan && !plan.includes('![[') && plan.includes('attachments/images/diagram.png'), JSON.stringify(plan));
check('and the image is filed under attachments/images/', fs.existsSync(`${VAULT}/attachments/images/diagram.png`), JSON.stringify(vaultFiles(`${VAULT}/attachments`)));
check('its own created date survives', !!plan && /created:\s*2025-03-14 09:30/.test(plan), JSON.stringify((plan || '').slice(0, 80)));
check('the vault\'s "notes" folder came across as a folder of notes', read(`${VAULT}/notes/my-obsidian/notes/inside.md`) !== null, JSON.stringify(vaultFiles(`${VAULT}/notes`)));
check('the note already in the vault is untouched', read(`${VAULT}/notes/${MINE}`) === MINE_TEXT, JSON.stringify(read(`${VAULT}/notes/${MINE}`)));
check('and nothing was moved aside', !ls(VAULT).some((n) => n.includes('bak-restore')), JSON.stringify(ls(VAULT)));
check('the tree shows the imported folder', await cx.ev(`(state.notes || []).some(n => n.name === 'my-obsidian')`) === true,
  String(await cx.ev(`JSON.stringify((state.notes || []).map(n => n.name))`)));

// 3. A synced copy with no .obsidian/ (the shape of ~/Documents/obsidian-sync).
obsidianVault(`${SRC}/synced`, { dotObsidian: false });
fs.rmSync(`${SRC}/synced/notes`, { recursive: true });
const r3 = await cx.ev(`window.inkwell.vault.restoreFolder(${JSON.stringify(`${SRC}/synced`)}, '')`, 60000);
check('a copy without .obsidian/ is recognised too', r3 && r3.ok && r3.obsidian === true && read(`${VAULT}/notes/synced/Work/plan.md`) !== null, JSON.stringify(r3));

// 4. A .tar.gz of an Obsidian vault, wrapped in one folder.
obsidianVault(`${SRC}/packed/wrapped-vault`, { dotObsidian: true });
fs.writeFileSync(`${SRC}/packed/wrapped-vault/undated.md`, 'No frontmatter at all.\n');
const OLD = new Date('2024-06-01T10:00:00');
fs.utimesSync(`${SRC}/packed/wrapped-vault/undated.md`, OLD, OLD);
execSync(`tar czf ${JSON.stringify(`${SRC}/obsidian-backup.tar.gz`)} -C ${JSON.stringify(`${SRC}/packed`)} wrapped-vault`);
const r4 = await cx.ev(`window.inkwell.vault.restoreArchive(${JSON.stringify(`${SRC}/obsidian-backup.tar.gz`)}, '')`, 60000);
await sleep(1000);
const undated = read(`${VAULT}/notes/wrapped-vault/undated.md`);
check('an Obsidian archive is imported under its folder\'s name', r4 && r4.ok && r4.obsidian === true && read(`${VAULT}/notes/wrapped-vault/Work/plan.md`) !== null,
  `${JSON.stringify(r4)} ${JSON.stringify(ls(`${VAULT}/notes`))}`);
check('an undated note keeps the date it had in the archive, not the unpacking', !!undated && /created:\s*2024-06-01/.test(undated), JSON.stringify((undated || '').slice(0, 90)));
check('the unpacking leaves no staging folder behind', !ls(VAULT).some((n) => n.startsWith('.amelie-restore-')), JSON.stringify(ls(VAULT)));

// 5. An Amelie backup is still a real restore.
fs.mkdirSync(`${SRC}/amelie-backup/notes`, { recursive: true });
fs.writeFileSync(`${SRC}/amelie-backup/notes/from-backup.md`, 'Restored.\n');
const r5 = await cx.ev(`window.inkwell.vault.restoreFolder(${JSON.stringify(`${SRC}/amelie-backup`)}, '')`, 60000);
await sleep(2500);
check('an Amelie backup is still restored in place', r5 && r5.ok && !r5.obsidian && read(`${VAULT}/notes/from-backup.md`) === 'Restored.\n', JSON.stringify(r5));
check('with the vault it replaced kept aside', ls(VAULT).some((n) => n.startsWith('notes.bak-restore-')), JSON.stringify(ls(VAULT)));

// 6. Neither → still refused.
fs.mkdirSync(`${SRC}/empty`, { recursive: true });
const r6 = await cx.ev(`window.inkwell.vault.restoreFolder(${JSON.stringify(`${SRC}/empty`)}, '')`, 60000);
check('a folder that is neither is still refused', r6 && r6.ok === false && /notes/.test(r6.error || ''), JSON.stringify(r6));

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { cx.ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
