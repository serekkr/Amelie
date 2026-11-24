// Reading-mode table context menu (serekkr, 24/11/2026):
//  - right-click tints the whole row AND column so the Insert/Delete target is clear;
//  - delete row/column is ONE undoable step (toolbar undo button + content revert),
//    and the preview does not jump to the top ("effetto finestra che si sposta veloce").
//
//   run: npm run test:tablectxedit     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tblctx'; const VAULT = `${HOME}/vault`; const PORT = 9437;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
// A table preceded by many lines so the preview is scrolled when we edit (to prove the
// reading position is kept across the re-render).
const pre = Array.from({ length: 60 }, (_, i) => `riga di riempimento numero ${i + 1}`).join('\n\n');
fs.writeFileSync(`${VAULT}/notes/t.md`,
  `---\ncreated: 2026-10-27 10:00\n---\n\n# T\n\n${pre}\n\n` +
  `| A | B | C |\n|---|---|---|\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |\n\ndopo la tabella\n`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, [...eargs, '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', d => { err += d; });
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app\n' + err.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value ?? (m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : null))); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 20000); });
await sleep(2000);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${JSON.stringify(d)}`}`); };

await ev(`(() => { const n = state.notes.find(x => /t\\.md$/.test(x.path||'')); if (n) openTab(n); return 1 })()`);
await sleep(600);
await ev(`setViewMode('view')`);
await sleep(500);
// scroll the preview down so a reset-to-top would be obvious
await ev(`(()=>{ const pv=document.getElementById('preview-pane'); pv.scrollTop = Math.round((pv.scrollHeight-pv.clientHeight)*0.7); return pv.scrollTop; })()`);
await sleep(200);

// 1) right-click the 'b2' cell → row (a2,b2,c2) + column (B,b1,b2,b3) tinted
const hl = await ev(`(()=>{
  const tds=[...document.querySelectorAll('#preview-content td')];
  const cell=tds.find(td=>td.textContent.trim()==='b2');
  showTableContextMenu({clientX:100,clientY:100}, cell);
  const marked=[...document.querySelectorAll('#preview-content .amelie-tbl-ctx-hl')].map(c=>c.textContent.trim()).sort();
  return JSON.stringify(marked);
})()`);
const marked = JSON.parse(hl || '[]');
// row a2,b2,c2 + column B,b1,b2,b3 → unique: a2,b1,b2,b3,c2,B
check('right-click tinge riga + colonna del cell (b2)',
  ['B','a2','b1','b2','b3','c2'].every(x=>marked.includes(x)) && marked.length === 6, marked);

// 1b) right-click near the BOTTOM edge → menu must stay fully inside the viewport
// (serekkr, 24/11/2026: "non si vede tutta la finestra" — era tagliato in basso).
const fit = await ev(`(()=>{
  const tds=[...document.querySelectorAll('#preview-content td')];
  const cell=tds.find(td=>td.textContent.trim()==='b2') || tds[0];
  showTableContextMenu({clientX: window.innerWidth-10, clientY: window.innerHeight-10}, cell);
  const m=document.getElementById('table-ctx-menu');
  const r=m.getBoundingClientRect();
  return JSON.stringify({ bottom:r.bottom, right:r.right, top:r.top, left:r.left, W:window.innerWidth, H:window.innerHeight });
})()`);
const F = JSON.parse(fit || '{}');
check('menu vicino al bordo basso resta dentro la finestra (non tagliato)',
  F.bottom <= F.H && F.right <= F.W && F.top >= 0 && F.left >= 0, F);

// 2) close menu (click away) clears the tint
const cleared = await ev(`(()=>{ document.body.click(); return document.querySelectorAll('#preview-content .amelie-tbl-ctx-hl').length; })()`);
check('chiudendo il menu il tint sparisce', cleared === 0, cleared);

// 2c) a middle click must NOT auto-paste into a cell (Linux primary-selection paste):
// the guard drops a paste that fires right after a middle-down; a normal single-value
// paste is left to the browser (serekkr, 24/11/2026: "non deve fare paste da click").
const mid = await ev(`(()=>{
  const tds=[...document.querySelectorAll('#preview-content td')];
  const cell=tds.find(td=>td.textContent.trim()==='b2') || tds[0];
  const mk=(txt)=>{ const dt=new DataTransfer(); dt.setData('text/plain', txt); return new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}); };
  const pNorm = mk('x'); cell.dispatchEvent(pNorm);                 // no middle-down -> not blocked
  cell.dispatchEvent(new MouseEvent('mousedown',{button:1,bubbles:true,cancelable:true}));
  const pMid = mk('jumpbox'); cell.dispatchEvent(pMid);            // right after middle-down -> blocked
  return JSON.stringify({ normalPrevented: pNorm.defaultPrevented, midPrevented: pMid.defaultPrevented });
})()`);
const M = JSON.parse(mid || '{}');
check('click centrale: il paste automatico nella cella viene bloccato', M.midPrevented === true, M);
check('paste normale (valore singolo) NON viene bloccato', M.normalPrevented === false, M);

// 3) delete the row containing b2 → '| a2 | b2 | c2 |' gone, scroll kept, undoable
const before = await ev(`JSON.stringify({ scroll: document.getElementById('preview-pane').scrollTop, hasRow: /a2\\s*\\|\\s*b2\\s*\\|\\s*c2/.test(editor.value) })`);
const del = await ev(`(async()=>{
  const tds=[...document.querySelectorAll('#preview-content td')];
  const cell=tds.find(td=>td.textContent.trim()==='b2');
  showTableContextMenu({clientX:100,clientY:100}, cell);
  tableEditRow('delete');
  await new Promise(r=>setTimeout(r,250));
  const pv=document.getElementById('preview-pane');
  return JSON.stringify({ scroll: pv.scrollTop, hasRow: /a2\\s*\\|\\s*b2\\s*\\|\\s*c2/.test(editor.value), rowsInDom: document.querySelectorAll('#preview-content tbody tr, #preview-content table tr').length });
})()`);
const B = JSON.parse(before), D = JSON.parse(del);
check('delete row: la riga a2/b2/c2 sparisce dal testo', B.hasRow === true && D.hasRow === false, { B, D });
check('delete row: la posizione di lettura NON salta in cima (scroll ~mantenuto)',
  Math.abs(D.scroll - B.scroll) <= 40 && D.scroll > 50, { before: B.scroll, after: D.scroll });

// 4) undo via the toolbar button → row comes back
const undo = await ev(`(async()=>{
  document.getElementById('btn-undo').click();
  await new Promise(r=>setTimeout(r,300));
  return JSON.stringify({ hasRow: /a2\\s*\\|\\s*b2\\s*\\|\\s*c2/.test(editor.value), domHasB2: !![...document.querySelectorAll('#preview-content td')].find(td=>td.textContent.trim()==='b2') });
})()`);
const U = JSON.parse(undo);
check('undo (icona) ripristina la riga nel testo', U.hasRow === true, U);
check('undo (icona) aggiorna anche il preview in view mode', U.domHasB2 === true, U);

// 5) delete a COLUMN then undo
const col = await ev(`(async()=>{
  const tds=[...document.querySelectorAll('#preview-content td')];
  const cell=tds.find(td=>td.textContent.trim()==='b1');
  showTableContextMenu({clientX:100,clientY:100}, cell);
  tableEditCol('delete');
  await new Promise(r=>setTimeout(r,200));
  const afterDel = /\\|\\s*a1\\s*\\|\\s*c1\\s*\\|/.test(editor.value) && !/b1/.test(editor.value);
  document.getElementById('btn-undo').click();
  await new Promise(r=>setTimeout(r,250));
  const afterUndo = /\\|\\s*a1\\s*\\|\\s*b1\\s*\\|\\s*c1\\s*\\|/.test(editor.value);
  return JSON.stringify({ afterDel, afterUndo });
})()`);
const C = JSON.parse(col);
check('delete column: la colonna B sparisce', C.afterDel === true, C);
check('delete column: undo la ripristina', C.afterUndo === true, C);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
