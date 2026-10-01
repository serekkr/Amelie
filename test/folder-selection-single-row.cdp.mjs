// Only ONE row in the tree is ever highlighted.
//
// Asked 2026-10-01, on a clean install: "la riga selezionata rimane sia su la
// cartella che ho sopra sia su la nota attuale". Clicking a folder marks it as the
// target for the next note (.tree-folder.selected); opening a note marks the note
// (.tree-note.active). Both paint the same accent fill, so a folder left selected
// while its new note is open reads as two selected rows.
//
// openNote() cleared the folder selection; the CREATE paths (＋ new note, new
// drawing) do not go through it — they call openTab()/openDrawFile() directly —
// so the folder stayed lit under the note that had just been made inside it.
//
// Drives the real app: the real folder row click, the real ＋, the real new drawing.
//
//   run: npm run test:treesel     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-treesel'; const VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${VAULT}/notes/Lavoro`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/inizio.md`, '---\ncreated: 2026-09-01 10:00\n---\n\nLa prima nota.\n');
fs.writeFileSync(`${VAULT}/notes/Lavoro/appunti.md`, '---\ncreated: 2026-09-01 10:00\n---\n\nAppunti.\n');
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

async function session(port, body) {
  const eargs = ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic'];
  const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
  const child = xvfb
    ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: 'ignore' })
    : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
    if (!target) throw new Error('app did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
    const ev = (x) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); });
    await sleep(3000);
    await body(ev);
    ws.close();
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

// What the eye sees. A row is "filled" when it actually paints a background — the
// test reads the COMPUTED style, so it fails if the two states are drawn alike no
// matter which class carries it. Mouse kept off the tree: hover is a fill too.
const lit = `JSON.stringify((() => {
  const filled = (r) => { const c = getComputedStyle(r).backgroundColor; return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'; };
  const bar = (r) => /inset/.test(getComputedStyle(r).boxShadow || '');
  const rows = [...document.querySelectorAll('.tree-folder, .tree-note')];
  return {
    filled: rows.filter(filled).map(r => r.textContent.trim()),
    barred: rows.filter(bar).map(r => r.textContent.trim()),
    folders: [...document.querySelectorAll('.tree-folder.selected')].map(r => r.textContent.trim()),
    notes: [...document.querySelectorAll('.tree-note.active')].map(r => r.textContent.trim()),
    selectedFolder: state.selectedFolder,
  };
})())`;
const L = async (ev) => JSON.parse(await ev(lit));
// The real click on the folder row (its own handler: expand + mark as target).
const clickFolder = (name) => `(() => { const r = [...document.querySelectorAll('.tree-folder')].find(x => x.textContent.trim() === ${JSON.stringify(name)}); if (!r) throw new Error('no folder ' + ${JSON.stringify(name)}); r.click(); return 1; })()`;
const clickNote = (name) => `(() => { const r = [...document.querySelectorAll('.tree-note')].find(x => x.textContent.trim() === ${JSON.stringify(name)}); if (!r) throw new Error('no note ' + ${JSON.stringify(name)}); r.click(); return 1; })()`;
// Make the folder the target AND leave it open. One click does both — but the click
// TOGGLES the folder, so a second one is needed when it was already expanded, or the
// rows under it leave the DOM and the next assertion reads an empty tree.
const folderState = (name) => `JSON.stringify((() => { const r = [...document.querySelectorAll('.tree-folder')].find(x => x.textContent.trim() === ${JSON.stringify(name)}); return { open: !!r && r.classList.contains('open'), sel: !!r && r.classList.contains('selected') }; })())`;
const selectFolder = async (ev, name) => {
  for (let i = 0; i < 3; i++) {
    const st = JSON.parse(await ev(folderState(name)));
    if (st.open && st.sel) return;
    await ev(clickFolder(name)); await sleep(400);
  }
  throw new Error(`could not open+select ${name}`);
};

await session(9471, async (ev) => {
  await ev(clickNote('inizio'));
  await sleep(700);
  const z = await L(ev);
  check('the open note is the filled row', z.filled.length === 1 && z.filled[0] === 'inizio', JSON.stringify(z));

  await selectFolder(ev, 'Lavoro');
  const a = await L(ev);
  check('clicking a folder marks it WITHOUT a second filled row',
    a.folders.length === 1 && a.filled.length === 1 && a.filled[0] === 'inizio', JSON.stringify(a));
  check('…the folder shows the bar instead', a.barred.length === 1 && a.barred[0] === 'Lavoro', JSON.stringify(a));

  // ＋ new note, exactly as the toolbar button calls it.
  await ev(`createNewNote(newNoteFolder()).then(() => new Promise(r => setTimeout(r, 900))).then(() => 1)`);
  const b = await L(ev);
  check('the new note made inside it is the only marked row at all',
    b.notes.length === 1 && b.folders.length === 0 && b.filled.length === 1 && b.barred.length === 0, JSON.stringify(b));
  check('…and the folder is no longer held as the target', b.selectedFolder === null, JSON.stringify(b));

  // The next ＋ must still land in the same folder: the open note supplies it now.
  check('a second new note still goes into that folder',
    (await ev(`newNoteFolder()`)) === 'Lavoro', await ev(`JSON.stringify([newNoteFolder(), state.currentPath])`));

  // A new DRAWING, created into a selected folder, must not leave it marked either.
  await ev(`(() => { const p = loadAppearance(); p.drawLocation = 'current'; applyAppearance(p); return 1; })()`);
  await selectFolder(ev, 'Lavoro');
  await ev(`newDraw().then(() => new Promise(r => setTimeout(r, 1200))).then(() => 1)`);
  const c = await L(ev);
  check('a new drawing leaves no folder marked behind it',
    c.folders.length === 0 && c.barred.length === 0 && c.selectedFolder === null, JSON.stringify(c));

  // And the plain case openNote() already covered stays covered.
  await selectFolder(ev, 'Lavoro');
  await ev(clickNote('appunti'));
  await sleep(800);
  const d = await L(ev);
  check('clicking a note in the tree clears the folder and fills only that note',
    d.notes.length === 1 && d.notes[0] === 'appunti' && d.folders.length === 0
    && d.filled.length === 1 && d.filled[0] === 'appunti', JSON.stringify(d));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
