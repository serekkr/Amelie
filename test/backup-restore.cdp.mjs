// Backup and restore, end to end, on the real app.
//
// A backup that cannot be restored is worse than no backup, and this is the other place in
// Amelie where a fault costs DATA rather than comfort — so the test is the round trip, not
// just "a file appeared":
//   1. a local archive backup runs and produces a .tar.gz
//   2. the vault is then damaged on purpose — a note edited beyond recognition, another
//      deleted outright
//   3. restoring the archive brings both back, byte for byte
//   4. keepLast really prunes, and keeps the NEWEST archives
//   5. the same round trip on an ENCRYPTED vault, where the archive must not contain the
//      text and the restored note must still decrypt to the original
//
// Only the LOCAL transport is exercised. WebDAV and Samba need a server, and the VPN path
// touches system-wide NetworkManager connections — none of that belongs in a test that has
// to be safe to run on the maintainer's machine.
//
//   run: npm run test:backup     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-backup-test';
const VAULT = `${HOME}/vault`;
const DEST = `${HOME}/backups`;
const PORT = 9261;
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

// ══ Round 1 — plaintext vault ═══════════════════════════════════════════════════════════
console.log('══ vault in chiaro ══\n');
let cx = await launch({ encrypted: false });

const b1 = await cx.ev('window.inkwell.triggerBackup()', 120000);
for (let i = 0; i < 40 && archives().length === 0; i++) await sleep(1000);
check('a local archive backup runs', archives().length === 1, `triggerBackup → ${JSON.stringify(b1)}; dest holds ${JSON.stringify(ls(DEST))}`);

const arch = `${DEST}/${archives()[0]}`;
const listing = (() => { try { return execSync(`tar tzf ${JSON.stringify(arch)}`).toString(); } catch (e) { return 'ERR ' + e.message; } })();
check('the archive contains both notes', listing.includes(NOTE_A) && listing.includes(NOTE_B), listing.split('\n').slice(0, 6).join(' | '));

// Damage the vault: rewrite one note, delete the other.
fs.writeFileSync(`${VAULT}/notes/${NOTE_A}`, 'DAMAGED — this must be replaced by the restore.\n');
fs.rmSync(`${VAULT}/notes/${NOTE_B}`);
check('the vault is damaged before restoring', fs.readFileSync(`${VAULT}/notes/${NOTE_A}`, 'utf8') !== TEXT_A && !fs.existsSync(`${VAULT}/notes/${NOTE_B}`), 'the damage did not take');

const r1 = await cx.ev(`window.inkwell.vault.restoreArchive(${JSON.stringify(arch)}, '')`, 120000);
await sleep(2500);
check('the edited note is restored byte for byte', fs.existsSync(`${VAULT}/notes/${NOTE_A}`) && fs.readFileSync(`${VAULT}/notes/${NOTE_A}`, 'utf8') === TEXT_A,
  `restoreArchive → ${JSON.stringify(r1)}; content now ${JSON.stringify((fs.existsSync(`${VAULT}/notes/${NOTE_A}`) ? fs.readFileSync(`${VAULT}/notes/${NOTE_A}`, 'utf8') : '(missing)').slice(0, 40))}`);
check('the deleted note comes back', fs.existsSync(`${VAULT}/notes/${NOTE_B}`) && fs.readFileSync(`${VAULT}/notes/${NOTE_B}`, 'utf8') === TEXT_B,
  fs.existsSync(`${VAULT}/notes/${NOTE_B}`) ? 'content differs' : 'still missing');

// keepLast: three kept, and the oldest dropped.
for (let i = 0; i < 3; i++) { await cx.ev('window.inkwell.triggerBackup()', 120000); await sleep(2500); }
const kept = archives();
check('keepLast prunes to the configured number', kept.length === 3, `${kept.length} archives: ${kept.join(', ')}`);
check('and it keeps the newest, not the oldest', !kept.includes(path.basename(arch)), `the first archive ${path.basename(arch)} is still there`);

// ══ Round 2 — encrypted vault ═══════════════════════════════════════════════════════════
console.log('\n══ vault cifrato ══\n');
try { cx.ws.close(); } catch (_) {}
cx = await launch({ encrypted: true });

const encNoteOnDisk = `${VAULT}/notes/${NOTE_A.replace(/\.md$/, '.enc')}`;
check('the encrypted vault holds the note as .enc', fs.existsSync(encNoteOnDisk), `notes dir: ${JSON.stringify(ls(`${VAULT}/notes`))}`);

const b2 = await cx.ev('window.inkwell.triggerBackup()', 180000);
for (let i = 0; i < 60 && archives().length === 0; i++) await sleep(1000);
check('a backup of an encrypted vault runs', archives().length >= 1, `triggerBackup → ${JSON.stringify(b2)}; dest holds ${JSON.stringify(ls(DEST))}`);

const arch2 = `${DEST}/${archives()[0]}`;
const raw = fs.readFileSync(arch2);
check('the archive does not carry the note text in the clear', !raw.includes(Buffer.from('worth keeping')),
  'the plaintext was found inside the archive');

fs.rmSync(encNoteOnDisk);
check('the encrypted note is deleted before restoring', !fs.existsSync(encNoteOnDisk), 'the deletion did not take');
const r2 = await cx.ev(`window.inkwell.vault.restoreArchive(${JSON.stringify(arch2)}, ${JSON.stringify(PASS)})`, 180000);
await sleep(3000);
check('the encrypted note is restored', fs.existsSync(encNoteOnDisk), `restoreArchive → ${JSON.stringify(r2)}; notes dir: ${JSON.stringify(ls(`${VAULT}/notes`))}`);
const readBack = await cx.ev(`window.inkwell.readNote(${JSON.stringify(NOTE_A)})`, 30000);
check('and it decrypts back to the original text', readBack === TEXT_A, `got ${JSON.stringify(String(readBack).slice(0, 60))}`);

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { cx.ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
