// A photo or text box dragged onto another page of a PDF moves to that page.
//
// Reported 2026-09-30: "ho aggiunto un'immagine e ho provato a trascinarla sulla
// seconda pagina del pdf e si è bloccata". An object belongs to the layer of the
// page it was drawn on, and the NEXT page is drawn after it — so the photo slid
// under page 2 and seemed stuck, and on release it stayed on page 1 with its
// coordinates below the bottom edge, to be baked off the sheet. Now the page being
// dragged from is raised while dragging, and the page under the pointer takes the
// object on release, kept inside its edges.
//
// Drives the real app with real input (CDP Input.dispatchMouseEvent) on a real
// three-page PDF made with pdf-lib.
//
//   run: npm run test:pdfdragpages     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
const REPO = process.cwd();
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)(REPO + '/node_modules/pdf-lib');
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); } catch { console.log('SKIP: no xvfb-run'); process.exit(0); }
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };
const HOME = '/tmp/amelie-pdfdragpages', VAULT = HOME + '/vault';
const ELECTRON = REPO + '/node_modules/electron/dist/electron';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(HOME, { recursive: true, force: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
fs.mkdirSync(VAULT + '/notes/Lavoro', { recursive: true }); fs.mkdirSync(VAULT + '/attachments/pdf', { recursive: true });
fs.writeFileSync(VAULT + '/notes/Lavoro/piano.md', fm + 'piano\n'); fs.writeFileSync(VAULT + '/notes/radice.md', fm + 'testo della nota\n');
{ const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) d.addPage([595, 842]).drawText('Pagina ' + i, { x: 60, y: 760, size: 32, font: f });
  fs.writeFileSync(VAULT + '/attachments/pdf/doc.pdf', await d.save()); }
fs.mkdirSync(HOME + '/.local/share/amelie', { recursive: true });
fs.writeFileSync(HOME + '/.local/share/amelie/amelie.json', JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(HOME + '/.local/share/amelie/settings.json', JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const port = 9531;
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, '.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic', '--ozone-platform=x11', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: 'ignore' });
const bye = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} fs.rmSync(HOME, { recursive: true, force: true }); const failed = results.filter((r) => !r).length; console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`); process.exit(failed ? 1 : 0); };
setTimeout(() => { console.log('TIMEOUT'); bye(2); }, 120000);
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method) events.push(m); };
const cdp = (method, params = {}) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result || m.error)); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
await sleep(3000);
await ev(`(async () => { await loadTree(); const n = flattenTree(state.notes).find(n => n.path === 'attachments/pdf/doc.pdf'); await openNote(n); return 1; })()`);
await sleep(3000);
const png = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQ0lEQVR4nO3PQQ0AIBDAsIF/zYcKHpBWwZa1HQP2d8BaP3cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwNMAQHfbmhNAAAAAElFTkSuQmCC';
check('the PDF opens with its three pages', (await ev(`document.querySelectorAll('.pdf-page-wrap').length`)) === 3);
check('a photo is placed on page 1', (await ev(`_placePdfImage({ mime: 'image/png', dataB64: '${png}' })`)) === true);
await sleep(600);
// Put the photo near the bottom of page 1, and scroll so page 1's bottom and page 2's top are both on screen.
await ev(`(() => { const a = _pdfAnnots[0]; a.y = a.h + 30; _redrawPage(1); const w = document.querySelectorAll('.pdf-page-wrap')[0]; _pdfContainer.scrollTop = w.offsetTop + w.offsetHeight - 450; return 1; })()`);
await sleep(700);
const box = JSON.parse(await ev(`JSON.stringify((() => { const b = document.querySelector('.pdf-obj-layer[data-page="1"] .pdf-obj-img'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
const p2 = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelectorAll('.pdf-page-wrap')[1].getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })())`));
const endY = p2.top + 180;
await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 });
for (let k = 1; k <= 16; k++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y + (endY - box.y) * k / 16, button: 'left', buttons: 1 }); await sleep(30); }
const midTop = await ev(`(() => { const e = document.elementFromPoint(${box.x}, ${endY}); return e ? (e.closest('.pdf-obj-img') ? 'photo' : (e.className || e.tagName)) : null; })()`);
check('while dragged over page 2 the photo stays in sight, above it', midTop === 'photo', String(midTop));
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: endY, button: 'left', clickCount: 1 });
await sleep(600);
const an = JSON.parse(await ev(`JSON.stringify(_pdfAnnots.map(a => ({ page: a.page, x: a.x, y: a.y, w: a.w, h: a.h })))`));
check('dropped there, it belongs to page 2', an.length === 1 && an[0].page === 2, JSON.stringify(an));
check('and is drawn on page 2, no longer on page 1', (await ev(`!!document.querySelector('.pdf-obj-layer[data-page="2"] .pdf-obj-img') && !document.querySelector('.pdf-obj-layer[data-page="1"] .pdf-obj-img')`)) === true);
const now = JSON.parse(await ev(`JSON.stringify((() => { const b = document.querySelector('.pdf-obj-layer[data-page="2"] .pdf-obj-img'); const r = b ? b.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
check('exactly where it was let go', Math.abs(now.x - box.x) < 1.5 && Math.abs(now.y - endY) < 1.5, JSON.stringify({ now, pointer: { x: box.x, y: endY } }));
check('inside the edges of page 2', !!an[0] && an[0].x >= 0 && an[0].x + an[0].w <= 595 + 0.01 && an[0].y - an[0].h >= -0.01 && an[0].y <= 842 + 0.01, JSON.stringify(an[0]));
// Let go off the right edge of the page: it is kept on the sheet.
{
  const b = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector('.pdf-obj-layer[data-page="2"] .pdf-obj-img').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
  const edge = JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelectorAll('.pdf-page-wrap')[1].getBoundingClientRect(); return { right: r.right }; })())`));
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let k = 1; k <= 8; k++) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x + (edge.right + 60 - b.x) * k / 8, y: b.y, button: 'left', buttons: 1 }); await sleep(30); }
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: edge.right + 60, y: b.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const a2 = JSON.parse(await ev(`JSON.stringify(_pdfAnnots[0])`));
  check('let go past the right edge, it is kept on the page', a2.page === 2 && Math.abs(a2.x + a2.w - 595) < 0.5, JSON.stringify({ page: a2.page, x: a2.x, w: a2.w }));
}
check('no error in the page', (await ev('JSON.stringify(window._errs || [])')) === '[]', await ev('JSON.stringify(window._errs || [])'));
bye();
