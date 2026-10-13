// The note you are LOOKING AT shows what the sync just pulled.
//
// serekkr, 13/10/2026: "se sono su una nota in vista e sul share c'è la stessa nota
// aggiornata … adesso devo andare su un'altra nota e andare su quella sincronizzata
// per vedere la versione nuova". A tab keeps its own copy of the text and only a fresh
// open re-reads the file, so a pass that pulled a newer version left the old one up.
//
// Drives the real app: the file is replaced ON DISK behind its back (which is all a
// download is), then the renderer is told what the pass wrote — the same call the
// sync:statusUpdate listener makes.
//
//   run: npm run test:noterefresh     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const PORT = 9353;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-noterefresh-'));
const HOME = `${ROOT}/home`, VAULT = `${HOME}/vault`;
const NOTE = `${VAULT}/notes/shared.md`;
const head = '---\ncreated: 2026-10-13 09:00\nmodified: 2026-10-13 09:00\n---\n\n';
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(NOTE, head + '# Shared\n\nthe version this computer had\n');
fs.writeFileSync(`${VAULT}/notes/other.md`, head + '# Other\n\nsomething else\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
const child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} fs.rmSync(ROOT, { recursive: true, force: true }); });
let err = ''; child.stderr.on('data', d => { err += d; });
setTimeout(() => { console.error('TIMEOUT\n' + err.slice(-1200)); process.exit(2); }, 90000);

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('no app\n' + err.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => {
  const my = ++id;
  pending.set(my, m => res(m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails?.exception?.description || m.result)));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => { if (pending.delete(my)) res('<<timeout>>'); }, 25000);
});
await sleep(1800);

const results = [];
const check = (n, pass, detail = '') => { results.push(!!pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

// Open the note, the way clicking it in the tree does.
await ev(`openNote((state.notes||[]).find(n => n.name === 'shared'))`);
await sleep(900);
check('the note is open and shows what this computer had',
  /the version this computer had/.test(await ev(`editor.value`)), await ev(`editor.value`));

// A download: the file is replaced underneath, nobody tells the editor.
fs.writeFileSync(NOTE, head + '# Shared\n\nthe version that came from the share\n');
check('the editor still shows the old text until it is told (this is the bug)',
  /the version this computer had/.test(await ev(`editor.value`)));

// …and this is the telling — the same call the sync status listener makes.
await ev(`refreshOpenNotesFromDisk(['shared.md'])`);
await sleep(700);
const shown = await ev(`editor.value`);
check('after the sync says what it wrote, the open note shows the new version',
  /the version that came from the share/.test(shown), shown);
check('and the tab is not left looking unsaved', (await ev(`String(!!getActiveTab().isDirty)`)) === 'false');
check('what the tab holds matches the screen',
  (await ev(`String(getActiveTab().content === editor.value)`)) === 'true');

// A note you have UNSAVED edits in is never overwritten.
await ev(`(() => { const t = getActiveTab(); editor.value = 'MY OWN UNSAVED WORDS'; t.content = editor.value; t.isDirty = true; })()`);
fs.writeFileSync(NOTE, head + '# Shared\n\na third version, from the share again\n');
await ev(`refreshOpenNotesFromDisk(['shared.md'])`);
await sleep(700);
check('unsaved edits are kept, not overwritten by the share',
  (await ev(`editor.value`)) === 'MY OWN UNSAVED WORDS', await ev(`editor.value`));
check('and you are told the share had something else',
  /non salvate|unsaved|ungespeicherte|sin guardar|non enregistr|niezapisane|nesalvate/i.test(
    await ev(`(document.getElementById('amelie-toast')||{}).textContent || ''`)),
  await ev(`(document.getElementById('amelie-toast')||{}).textContent || '(no toast)'`));

// A note the pass did NOT touch is left alone.
await ev(`(() => { const t = getActiveTab(); t.isDirty = false; t.content = editor.value = 'untouched'; })()`);
await ev(`refreshOpenNotesFromDisk(['somewhere/else.md'])`);
await sleep(400);
check('a pass that wrote other notes does not disturb this one',
  (await ev(`editor.value`)) === 'untouched', await ev(`editor.value`));

console.log(`\n${results.every(Boolean) ? `all ${results.length}` : `${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
