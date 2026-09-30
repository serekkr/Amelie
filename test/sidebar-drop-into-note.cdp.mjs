// An item dragged from the sidebar into the note being written becomes a LINK.
//
// Reported 2026-09-30: dropping a note, folder or attachment from the sidebar onto
// the editor pasted its tree path as text ("obsidian-sync/02 - Work/nota.md") —
// the drag carries the path, and the editor inserts dropped text. Now, as in
// Obsidian: a note → [[note]] (with its path when the name is not unique), a photo
// → its embed, a PDF → its 📎 link, a folder → nothing; always where it is let go,
// and nothing moves on disk.
//
// Real HTML5 drags through the browser (CDP Input.setInterceptDrags +
// dispatchDragEvent), from real sidebar rows onto the real editor.
//
//   run: npm run test:sidebardrop     (uses xvfb-run when installed)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-sidebardrop', VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); } catch { console.log('SKIP: no xvfb-run'); process.exit(0); }
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
const w = (rel, body) => { fs.mkdirSync(`${VAULT}/${rel}`.replace(/\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(`${VAULT}/${rel}`, body); };
w('notes/scrivo.md', fm + 'PRIMA\n\nDOPO\n');
w('notes/Lavoro/Legacy.md', fm + 'legacy\n');
w('notes/A/README.md', fm + 'a\n');
w('notes/B/README.md', fm + 'b\n');
w('attachments/images/foto.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
w('attachments/pdf/doc.pdf', '%PDF-1.4\n%%EOF\n');
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const port = 9591;
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, '.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic', '--ozone-platform=x11', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: 'ignore' });
const done = () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  fs.rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter((r) => !r).length;
  console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
  process.exit(failed ? 1 : 0);
};
setTimeout(() => { console.log('TIMEOUT'); done(); }, 120000);
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
if (!target) { console.log('app did not start'); done(); }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m); };
const cdp = (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result || m.error)); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const text = () => ev(`(_cmActive && _cmHandle) ? _cmHandle.view.state.doc.toString() : document.getElementById('markdown-editor').value`);
await sleep(3000);
await ev(`(async () => { await loadTree(); ['Lavoro', 'A', 'B'].forEach((d) => state.openFolders.add(d)); renderTree(); await openNote(flattenTree(state.notes).find((n) => n.path === 'scrivo.md')); setViewMode('edit'); return 1; })()`);
await sleep(1200);
await cdp('Input.setInterceptDrags', { enabled: true });
const center = (sel) => ev(`JSON.stringify((() => { const e = ${sel}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 }; })())`).then(JSON.parse);
// Where the text "DOPO" starts on screen: the drop point, so position is checked too.
const dropAt = () => ev(`JSON.stringify((() => { const v = _cmHandle.view; const i = v.state.doc.toString().indexOf('DOPO'); const c = v.coordsAtPos(i); return { x: c.left + 1, y: (c.top + c.bottom) / 2 }; })())`).then(JSON.parse);
async function dragToEditor(fromSel) {
  const a = await center(fromSel), b = await dropAt();
  if (!a || !b) return 'missing';
  events.length = 0;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 8; k++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * k / 8, y: a.y + (b.y - a.y) * k / 8, button: 'left', buttons: 1 }); await sleep(25); }
  await sleep(150);
  const di = events.find((m) => m.method === 'Input.dragIntercepted');
  if (di) for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data: di.params.data });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await sleep(800);
  return di ? 'ok' : 'no drag';
}
const row = (path) => `document.querySelector('#file-tree .tree-note[data-path="${path}"]')`;
const reset = () => ev(`(() => { _cmHandle.view.dispatch({ changes: { from: 0, to: _cmHandle.view.state.doc.length, insert: 'PRIMA\\n\\nDOPO\\n' } }); return 1; })()`);

await reset();
check('a note dragged in', (await dragToEditor(row('Lavoro/Legacy.md'))) === 'ok');
let t = await text();
check('becomes a [[link]] where it is let go', t === 'PRIMA\n\n[[Legacy]]DOPO\n', JSON.stringify(t));
check('not its path', !t.includes('Lavoro/Legacy'), JSON.stringify(t));

await reset(); await dragToEditor(row('A/README.md'));
t = await text();
check('a note whose name is not unique is linked with its path', t.includes('[[A/README|README]]'), JSON.stringify(t));

await reset(); await dragToEditor(row('attachments/images/foto.png'));
t = await text();
check('a photo becomes its embed', /!\[📷\]\(attachments\/images\/foto\.png\)/.test(t) && !t.includes('attachments/images/foto.pngDOPO'), JSON.stringify(t));

await reset(); await dragToEditor(row('attachments/pdf/doc.pdf'));
t = await text();
check('a PDF becomes its 📎 link', /\[📎\]\(attachments\/pdf\/doc\.pdf\)/.test(t), JSON.stringify(t));

await reset(); await dragToEditor(`[...document.querySelectorAll('#file-tree .tree-folder')].find((e) => e.textContent.trim() === 'Lavoro')`);
t = await text();
check('a folder inserts nothing', t === 'PRIMA\n\nDOPO\n', JSON.stringify(t));

check('and nothing moved on disk', fs.existsSync(`${VAULT}/notes/Lavoro/Legacy.md`) && fs.existsSync(`${VAULT}/notes/A/README.md`) && fs.existsSync(`${VAULT}/notes/Lavoro`) && fs.existsSync(`${VAULT}/attachments/pdf/doc.pdf`));
done();
