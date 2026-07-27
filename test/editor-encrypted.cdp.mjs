// Does the editor behave the same on an ENCRYPTED vault?
//
// Every other test here runs on a plaintext vault, which leaves the question open: the
// renderer sees decrypted text either way, but the save path does not — it encrypts, and
// that is the path where a fault costs data. So this builds a REAL encrypted vault through
// the app's own setup (passphrase → KDF → vault header), writes a note with a long wrapped
// line, types and deletes in it, and then checks both sides:
//   • the note round-trips through the app (what you typed is what you get back), and
//   • the bytes on disk are actually ciphertext, not the text.
//
//   run: npm run test:enc     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-enc-test';
const VAULT = `${HOME}/vault`;
const PORT = 9251;
const PASS = 'test-passphrase-9f3a-not-a-real-secret';
const NOTE = 'wrapped.md';
// On an encrypted vault the bytes live under a different name: notes/<name>.enc. The app is
// addressed with the logical .md path; only the disk checks below use this one.
const ON_DISK = 'wrapped.enc';
const BODY = fs.readFileSync(path.join(REPO, 'test/fixtures/wrapped-long-line.md'), 'utf8');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(VAULT, { recursive: true });
// No amelie.json on purpose: the app opens its setup window, and we drive the real
// vault:setup from there so the vault is encrypted the way a user's would be.

const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = () => {
  try { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── connect to whichever window is up (setup first, then the app) ────────────────────────
const findTarget = async (match, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page' && match.test(x.url));
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
  const send = (method, params = {}, ms = 20000) => new Promise((res) => {
    const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
    setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
  });
  const ev = async (expr, ms = 20000) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
    if (r.timeout) return '<<TIMEOUT>>';
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { ws, send, ev };
};

const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };

// ── 1. create the encrypted vault through the app's own setup ───────────────────────────
const setupWin = await findTarget(/vault-setup\.html/);
if (!setupWin) { console.error('the setup window never appeared'); process.exit(1); }
let cx = await connect(setupWin);
const setupRes = await cx.ev(`(async () => {
  const r = await window.inkwell.vault.setup({ vaultPath: ${JSON.stringify(VAULT)}, encryptionEnabled: true, passphrase: ${JSON.stringify(PASS)} });
  return r;
})()`, 90000);
console.log('vault:setup →', JSON.stringify(setupRes));
// The key derivation is intentionally expensive, so the call may outlive the window it was
// made from. The header on disk is the fact that matters.
for (let i = 0; i < 30 && !fs.existsSync(`${VAULT}/.amelie-vault.json`); i++) await sleep(1000);
check('the encrypted vault is created', fs.existsSync(`${VAULT}/.amelie-vault.json`), `no header; setup returned ${JSON.stringify(setupRes)}`);
try { cx.ws.close(); } catch (_) {}

// ── 2. the main window takes over; write a note through the app so it is encrypted ───────
const appWin = await findTarget(/index\.html/);
if (!appWin) { console.error('the app window never appeared after setup'); cleanup(); process.exit(1); }
cx = await connect(appWin);
const { ev, send } = cx;
for (let i = 0; i < 40; i++) {
  const ready = await ev('typeof _cmHandle !== "undefined" && !!_cmHandle && _cmActive && typeof state !== "undefined"');
  if (ready === true) break;
  await sleep(400);
}
const header = fs.existsSync(`${VAULT}/.amelie-vault.json`);
check('the vault carries an encryption header', header, `${VAULT}/.amelie-vault.json missing`);

const wrote = await ev(`window.inkwell.writeNote(${JSON.stringify(NOTE)}, ${JSON.stringify(BODY)})`, 30000);
console.log('writeNote →', JSON.stringify(wrote), '| notes dir:', fs.existsSync(`${VAULT}/notes`) ? fs.readdirSync(`${VAULT}/notes`).join(',') || '(empty)' : 'MISSING');
for (let i = 0; i < 20 && !fs.existsSync(`${VAULT}/notes/${ON_DISK}`); i++) await sleep(500);
check('the note is written to the vault (as .enc)', fs.existsSync(`${VAULT}/notes/${ON_DISK}`), `writeNote returned ${JSON.stringify(wrote)}`);
if (!fs.existsSync(`${VAULT}/notes/${ON_DISK}`)) { console.log('\ncannot continue without the note'); cleanup(); process.exit(1); }
await ev('loadTree()');
await sleep(1200);
const onDiskRaw = fs.readFileSync(`${VAULT}/notes/${ON_DISK}`);
check('the note on disk is ciphertext, not the text', !onDiskRaw.includes(Buffer.from('deliberatamente')),
  `first bytes: ${JSON.stringify(onDiskRaw.subarray(0, 24).toString('latin1'))}`);

// ── 3. open it, type, delete — exactly the scenario that used to fail ────────────────────
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
const opened = await ev(`(async () => {
  const walk = (a) => { for (const n of a || []) { if (n.path === ${JSON.stringify(NOTE)}) return n; const r = n.children && walk(n.children); if (r) return r; } return null; };
  const n = walk(state.notes); if (!n) return 'NOT-FOUND';
  await openNote(n); setViewMode('edit');
  return state.currentPath;
})()`);
await sleep(1200);
const st = await ev(`(() => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); _cmHandle.focus();
  return { len, rows: (() => { try { const b=_cmHandle.view.viewportLineBlocks, lh=_cmHandle.view.defaultLineHeight;
    return Math.max(...b.map(x => Math.round(x.height / lh))); } catch (_) { return -1; } })() }; })()`);
check('the note opens decrypted in the editor', opened === NOTE && st?.len === BODY.length, `opened=${opened} len=${st?.len} expected=${BODY.length}`);
check('and it really does wrap on screen', st?.rows > 1, `tallest line = ${st?.rows} rows`);

const LOG = '/tmp/amelie-cm-debug.log';
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const before = logLines().length;
const typeChar = async (ch) => {
  const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  await sleep(300);
};
await typeChar('z'); await typeChar('z'); await typeChar('z');
const afterType = await ev('(() => ({ len: _cmHandle.getValue().length, tail: _cmHandle.getValue().slice(-3) }))()');
check('three keystrokes reach the document', afterType?.len === st.len + 3 && afterType.tail === 'zzz', `${st.len} -> ${afterType?.len} tail=${JSON.stringify(afterType?.tail)}`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
await sleep(400);
const afterDel = await ev('_cmHandle.getValue().length');
check('Backspace removes exactly one character', afterDel === afterType.len - 1, `${afterType.len} -> ${afterDel}`);
const refused = logLines().slice(before).filter((l) => l.startsWith('BLOCKED')).length;
check('no keystroke is refused on an encrypted vault either', refused === 0, `${refused} refused`);

// ── 4. save, then read it back THROUGH the app — the round trip is what matters ──────────
await ev('saveNote()');
await sleep(2500);
const raw2 = fs.readFileSync(`${VAULT}/notes/${ON_DISK}`);
check('what was saved is still ciphertext', !raw2.includes(Buffer.from('deliberatamente')), `first bytes: ${JSON.stringify(raw2.subarray(0, 24).toString('latin1'))}`);
const readBack = await ev(`window.inkwell.readNote(${JSON.stringify(NOTE)})`);
check('the note decrypts back to exactly what is in the editor', typeof readBack === 'string' && readBack.includes('zz') && readBack.length >= afterDel,
  `read back ${typeof readBack === 'string' ? readBack.length : readBack} chars, editor has ${afterDel}`);

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { cx.ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
