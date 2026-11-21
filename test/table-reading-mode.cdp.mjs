// Reading-mode table: the behaviours serekkr kept asking for (Oct–Nov 2026), checked
// against the running app on a real table in view mode.
//
//   · creation         — the markdown table renders as an editable preview table,
//   · no "amelie" text — a legacy `<!-- amelie:colw -->` width comment is stripped from
//                         the source (widths migrate to localStorage, per note),
//   · delete a cell    — the cell empties WITHOUT the row growing taller, and the caret
//                         stays inside the cell, at TEXT height, at the text start
//                         (cell border + padding-left), never at the right edge,
//   · typing           — lands in the right cell, not the next column,
//   · column resize    — saves the width to localStorage and does NOT write a comment
//                         back into the note,
//   · Enter            — drops the caret into the cell below (doesn't vanish),
//   · paste (foglio)   — multi-line clipboard spreads DOWN one row per line, TAB parts
//                         spread ACROSS columns, and it never grows the table.
//
//   run: npm run test:tablereading     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tblread'; const VAULT = `${HOME}/vault`; const PORT = 9416;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display (dnf install xorg-x11-server-Xvfb)');
    process.exit(0);
  }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
// A note WITH a legacy amelie:colw comment (to prove it gets cleaned) and a 3-row table.
fs.writeFileSync(`${VAULT}/notes/tab.md`,
  `---\ncreated: 2026-10-27 10:00\n---\n\n# Tabella\n\n` +
  `<!-- amelie:colw=120,140,160 -->\n` +
  `| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n`);
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

await ev(`(() => { const n = state.notes.find(x => /tab/.test(x.path || x.name || '')); if (n) openTab(n); return 1 })()`);
await sleep(1200);
await ev(`setViewMode('view')`);
await sleep(800);
await ev(`window.focus()`);
await sleep(400);

const hasTable = await ev(`!!document.querySelector('#preview-content table tbody td')`);
if (hasTable !== true) { console.error('no table rendered:', hasTable, '\n' + err.slice(-800)); process.exit(1); }
check('creazione: la tabella si rende in reading mode', hasTable === true, { hasTable });
check('niente "amelie" nel preview', await ev(`!/amelie:colw/.test(document.getElementById('preview-content').innerText)`) === true, {});
check('il commento legacy e tolto dal sorgente', await ev(`!/amelie:colw/.test(editor.value)`) === true, {});
check('le larghezze legacy sono migrate in localStorage',
  await ev(`(() => { const v=localStorage.getItem('amelie.colw:'+state.currentPath); return !!v && v.includes('120'); })()`) === true, {});

// delete a cell → empties, row keeps height, caret in-cell at text height & text start
const del = await ev(`(async () => {
  const cell = document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[0]; // "1"
  const row = cell.closest('tr'); const hBefore = row.getBoundingClientRect().height;
  cell.focus(); const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(cell); sel.removeAllRanges(); sel.addRange(r);
  document.execCommand('delete', false, null);
  cell.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
  await new Promise(x=>setTimeout(x,120));
  const hAfter = row.getBoundingClientRect().height;
  const s2=window.getSelection(); const a=s2.anchorNode; const cr=s2.rangeCount?s2.getRangeAt(0).getBoundingClientRect():null;
  const cellRect=cell.getBoundingClientRect(); const padL=Math.round(parseFloat(getComputedStyle(cell).paddingLeft));
  const sib=document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[1];
  return { txt: cell.textContent.replace(/\\u200b/g,''), hBefore:Math.round(hBefore), hAfter:Math.round(hAfter),
    anchorInCell: a && cell.contains(a), caretH: cr?Math.round(cr.height):-1,
    caretFromLeft: cr?Math.round(cr.left-cellRect.left):-1, padL, sibH: Math.round(sib.getBoundingClientRect().height) };
})()`);
check('cancellazione: la cella si svuota', del && del.txt === '', del);
check('cancellazione: la riga NON si allarga', del && Math.abs(del.hAfter - del.hBefore) <= 2, del);
check('cursore: resta dentro la cella', del && del.anchorInCell === true, del);
check("cursore: all'inizio del testo (bordo + padding)", del && Math.abs(del.caretFromLeft - del.padL) <= 3, del);
check('cursore: altezza del testo, non della cella', del && del.caretH > 0 && del.caretH <= del.sibH - 2, del);

// typing lands in the right cell
const typ = await ev(`(async () => {
  const cell = document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[0];
  cell.focus(); const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(cell); r.collapse(true); sel.removeAllRanges(); sel.addRange(r);
  document.execCommand('insertText', false, 'Z');
  cell.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'Z'}));
  await new Promise(x=>setTimeout(x,120));
  const next = cell.closest('tr').querySelectorAll('td')[1];
  return { cell: cell.textContent.replace(/\\u200b/g,''), next: next.textContent.replace(/\\u200b/g,'') };
})()`);
check('scrittura: il testo entra nella cella giusta', typ && typ.cell.includes('Z') && typ.next === '2', typ);

// column resize → localStorage, no amelie comment
const rz = await ev(`(async () => {
  const table=document.querySelector('#preview-content table'); const ti=parseInt(table.dataset.tableIdx,10);
  persistTableColumnWidths(ti, [200,150,150]); await new Promise(x=>setTimeout(x,120));
  return { amelie:/amelie:colw/.test(editor.value), local: localStorage.getItem('amelie.colw:'+state.currentPath) };
})()`);
check('resize: non riscrive amelie:colw nella nota', rz && rz.amelie === false, rz);
check('resize: larghezza salvata in localStorage', rz && /200/.test(rz.local || ''), rz);

// Enter → caret into the cell below
const en = await ev(`(async () => {
  const cell=document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[1];
  cell.focus(); const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(cell); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  cell.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); await new Promise(x=>setTimeout(x,120));
  const below=document.querySelectorAll('#preview-content table tbody tr')[1].querySelectorAll('td')[1];
  const a=window.getSelection().anchorNode; return { below: a && below.contains(a) };
})()`);
check('Invio: il cursore scende nella cella sotto', en && en.below === true, en);

// spreadsheet paste: multi-line down, tab across, no table growth
const mkPaste = `(cell,text)=>{const dt=new DataTransfer();dt.setData('text/plain',text);cell.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}`;
const pa = await ev(`(async () => {
  const rows=document.querySelectorAll('#preview-content table tbody tr');
  const c0=rows[0].querySelectorAll('td')[0]; c0.focus(); (${mkPaste})(c0,'X\\nY\\nZ'); await new Promise(x=>setTimeout(x,150));
  const col0=[...rows].map(r=>r.querySelectorAll('td')[0].textContent.replace(/\\u200b/g,''));
  const c1=rows[1].querySelectorAll('td')[0]; c1.focus(); (${mkPaste})(c1,'P\\tQ\\tR'); await new Promise(x=>setTimeout(x,150));
  const row1=[...rows[1].querySelectorAll('td')].map(td=>td.textContent.replace(/\\u200b/g,''));
  const before=rows.length; const cl=rows[2].querySelectorAll('td')[0]; cl.focus(); (${mkPaste})(cl,'uno\\ndue\\ntre\\nquattro'); await new Promise(x=>setTimeout(x,150));
  const after=document.querySelectorAll('#preview-content table tbody tr').length;
  return { col0, row1, grew: before!==after, md: editor.value };
})()`);
check('paste: multi-riga scende per colonna (X,Y,Z)', pa && JSON.stringify(pa.col0)===JSON.stringify(['X','Y','Z']), pa && pa.col0);
check('paste: TAB si spande sulle colonne (P,Q,R)', pa && JSON.stringify(pa.row1)===JSON.stringify(['P','Q','R']), pa && pa.row1);
check('paste: la tabella NON cresce in overflow', pa && pa.grew === false, pa);
check('paste: il markdown riflette i valori incollati', pa && /\\|\\s*X\\s*\\|/.test(pa.md) && /\\|\\s*P\\s*\\|/.test(pa.md), pa && pa.md);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
