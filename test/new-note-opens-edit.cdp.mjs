// A new note, created from the reading view, opens for WRITING.
//
// Asked 2026-09-29: in view mode, "new note" showed a blank page to read, with no
// caret — a second click on the toggle before a word could be typed. An empty
// note has nothing to read, so it opens in edit mode; the remembered choice stays
// "view", and the next note opened is read as before.
//
// Drives the real app: the real toggle, the real "new note", the real tabs.
//
//   run: npm run test:newnoteedit     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-newnoteedit'; const VAULT = `${HOME}/vault`;
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
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/piena.md`, '---\ncreated: 2026-09-01 10:00\n---\n\nCi sono parole qui.\n');
fs.writeFileSync(`${VAULT}/notes/solo-intestazione.md`, '---\ncreated: 2026-09-01 10:00\nmodified: 2026-09-01 10:00\n---\n\n');
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

const open = (p) => `(async () => { await loadTree(); const n = flattenTree(state.notes).find((n) => n.path === ${JSON.stringify(p)}); await openNote(n); await new Promise((r) => setTimeout(r, 600)); return 1; })()`;
const mode = `JSON.stringify({ mode: state.viewMode, sticky: localStorage.getItem('amelie.viewMode'), path: state.currentPath,
  editorShown: getComputedStyle(document.getElementById('editor-pane')).display !== 'none' })`;
const M = async (ev) => JSON.parse(await ev(mode));

await session(9441, async (ev) => {
  await ev(open('piena.md'));
  if ((await M(ev)).mode !== 'view') await ev(`toggleViewMode(); 1`);
  await sleep(400);
  const a = await M(ev);
  check('reading a note, the chosen mode is "view"', a.mode === 'view' && a.sticky === 'view' && !a.editorShown, JSON.stringify(a));

  await ev(`createNewNote('').then(() => new Promise((r) => setTimeout(r, 900))).then(() => 1)`);
  const b = await M(ev);
  check('a new note opens in edit mode, the editor on screen', b.mode === 'edit' && b.editorShown && b.path !== 'piena.md', JSON.stringify(b));
  check('…with the caret in it, ready to type', await ev(`!!document.activeElement && !!document.activeElement.closest('#editor-pane')`));
  check('and the remembered choice is still "view"', b.sticky === 'view', JSON.stringify(b));

  await ev(open('piena.md'));
  const c = await M(ev);
  check('the next note with words in it is read, as before', c.mode === 'view' && !c.editorShown, JSON.stringify(c));

  await ev(open('solo-intestazione.md'));
  const d = await M(ev);
  check('a note with only its header and no text opens for writing too', d.mode === 'edit' && d.editorShown, JSON.stringify(d));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
