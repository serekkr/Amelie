// A PDF, photo or recording that no note uses stays where it is put in the sidebar.
//
// Reported 2026-09-29: "VoIP", "sara", "FlowSignal" PDFs listed at the vault root,
// where in Obsidian they sat in their folders. Attachments are stored flat in
// attachments/ and the tree listed any file no note links at the root — whatever
// the sidebar had been told. Dropping one on a note in a folder did record it in
// that folder's order, but the next refresh put it back at the root; dropping it
// on the folder itself was not accepted at all; and the level it left was saved
// under "attachments/pdf", a folder that does not exist.
//
// Drives the real app: real drag events on the real rows, then a NEW launch, so
// the place is read back from the vault and not from memory.
//
//   run: npm run test:attachplace     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-attachplace'; const VAULT = `${HOME}/vault`;
const ORDER = `${VAULT}/notes/.amelie-order.json`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 150000);
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
fs.mkdirSync(`${VAULT}/notes/Lavoro`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/pdf`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/Lavoro/piano.md`, fm + 'piano\n');
fs.writeFileSync(`${VAULT}/notes/radice.md`, fm + 'radice\n');
fs.writeFileSync(`${VAULT}/attachments/pdf/sciolto.pdf`, '%PDF-1.4\n%%EOF\n');
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
    await ev(`(async () => { await loadTree(); state.openFolders.add('Lavoro'); renderTree(); return 1; })()`);
    await sleep(1000);
    await body(ev);
    ws.close();
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

// Where the PDF is listed: '' for the root, else the folder around its row.
const WHERE = `JSON.stringify([...document.querySelectorAll('#file-tree .tree-note[data-path="attachments/pdf/sciolto.pdf"]')].map((el) => {
  const kids = el.closest('.tree-folder-children');
  const wrap = kids && kids.parentElement;
  const row = wrap && wrap.querySelector(':scope > .tree-folder');
  return row ? row.textContent.trim() : '';
}))`;
// A drag from the PDF row to `dropSel`, at `frac` of its height (0.5 = into a folder).
const drag = (dropSel, frac) => `(async () => {
  const src = document.querySelector('#file-tree .tree-note[data-path="attachments/pdf/sciolto.pdf"]');
  const dst = ${dropSel};
  if (!src || !dst) return 'missing ' + (!src ? 'pdf row' : 'drop row');
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = dst.getBoundingClientRect(), y = r.top + r.height * ${frac};
  dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  await new Promise((r) => setTimeout(r, 800));
  return 'ok';
})()`;
const FOLDER_ROW = `[...document.querySelectorAll('#file-tree .tree-folder')].find((e) => e.textContent.trim().includes('Lavoro'))`;
const ROOT_NOTE = `document.querySelector('#file-tree .tree-note[data-path="radice.md"]')`;
const readOrder = () => { try { return JSON.parse(fs.readFileSync(ORDER, 'utf8')); } catch { return {}; } };

await session(9421, async (ev) => {
  const before = JSON.parse(await ev(WHERE));
  check('no note uses the PDF: it starts at the root', JSON.stringify(before) === '[""]', JSON.stringify(before));
  const r = await ev(drag(FOLDER_ROW, 0.5));
  check('it can be dropped on a folder', r === 'ok', r);
  const now = JSON.parse(await ev(WHERE));
  check('and is listed inside it at once', JSON.stringify(now) === '["Lavoro"]', JSON.stringify(now));
  await ev(`loadTree().then(() => 1)`); await sleep(800);
  const refreshed = JSON.parse(await ev(WHERE));
  check('a refresh leaves it in the folder', JSON.stringify(refreshed) === '["Lavoro"]', JSON.stringify(refreshed));
});
{
  const o = readOrder();
  check('its place is saved in the vault, under that folder only',
    (o['Lavoro'] || []).includes('attachments/pdf/sciolto.pdf') && !(o[''] || []).includes('attachments/pdf/sciolto.pdf'), JSON.stringify(o));
  check('and nothing is saved under the attachments folder', !('attachments/pdf' in o), JSON.stringify(Object.keys(o)));
  check('the file itself did not move', fs.existsSync(`${VAULT}/attachments/pdf/sciolto.pdf`) && !fs.existsSync(`${VAULT}/notes/Lavoro/sciolto.pdf`));
}
await session(9422, async (ev) => {
  const again = JSON.parse(await ev(WHERE));
  check('a new launch shows it in the folder', JSON.stringify(again) === '["Lavoro"]', JSON.stringify(again));
  const r = await ev(drag(ROOT_NOTE, 0.9));
  check('dropped next to a root note it goes back to the root', r === 'ok' && JSON.stringify(JSON.parse(await ev(WHERE))) === '[""]', r + ' ' + (await ev(WHERE)));
});
{
  const o = readOrder();
  check('and the folder no longer keeps it',
    !(o['Lavoro'] || []).includes('attachments/pdf/sciolto.pdf') && (o[''] || []).includes('attachments/pdf/sciolto.pdf'), JSON.stringify(o));
}

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
