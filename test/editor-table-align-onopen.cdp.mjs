// A note whose markdown table is RAGGED (uneven pipes — e.g. built by pasting into cells
// in reading mode) must show as real, aligned columns as soon as EDIT MODE opens, without
// the caret ever visiting the table; and a re-ragged table must re-align on the view→edit
// toggle. (serekkr, 22/11/2026, image #9: the source looked ragged / unevenly padded in
// edit mode.) NB: on 23/11/2026 the align-on-caret-entry was removed so columns can be
// deleted in edit mode; the triggers are now edit-open and the view→edit toggle.
//
//   run: npm run test:tablealignopen     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tblopen'; const VAULT = `${HOME}/vault`; const PORT = 9425;
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
// A deliberately ragged 3-column table, plus a second ragged one lower down, so we also
// prove BOTH tables in the note get aligned in one pass.
fs.writeFileSync(`${VAULT}/notes/t.md`,
  `---\ncreated: 2026-10-27 10:00\n---\n\n# T\n\n` +
  `|  | dd |  |\n| --- | --- | --- |\n|  |  | ccc |\n| CLICKHOUSE_DDL_PORT=8123 |  |  |\n\n` +
  `tra le due\n\n` +
  `| a | b |\n|---|---|\n| x | yyyyyyyyyyyyyyyy |\n\n` +
  `fine\n`);
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

// Open the note in READING mode first (caret never enters the table), THEN switch to edit.
await ev(`(() => { const n = state.notes.find(x => /t\\.md$/.test(x.path||'')); if (n) openTab(n); return 1 })()`);
await sleep(600);
await ev(`setViewMode('view')`);
await sleep(400);
await ev(`setViewMode('edit')`);          // <-- the trigger: alignTables() runs here
await sleep(700);

const doc1 = await ev(`_cmHandle.view.state.doc.toString()`);
const L1 = (doc1 || '').split('\n');
const col = (s, k) => { let i = -1; for (let j = 0; j <= k; j++) i = s.indexOf('|', i + 1); return i; };
// First table: the three body/header/sep lines must share identical pipe columns.
const t1 = L1.filter(l => /\|/.test(l)).slice(0, 4);
const pipesEqual = rows => rows.length >= 2 && [1, 2, 3].every(k => rows.every(r => col(r, k) === col(rows[0], k)));
check('APERTURA: la 1a tabella è allineata entrando in edit (senza cliccarci)', pipesEqual(t1), t1);
check('APERTURA: il valore lungo CLICKHOUSE_DDL_PORT=8123 è intatto', /CLICKHOUSE_DDL_PORT=8123/.test(doc1), null);
// Second table lower down also aligned in the same pass.
const t2 = L1.filter(l => /\|/.test(l)).slice(4, 8);
check('APERTURA: anche la 2a tabella più in basso è allineata', pipesEqual(t2), t2);
check('APERTURA: niente contenuto perso (yyyy… intatto)', /yyyyyyyyyyyyyyyy/.test(doc1), null);

console.log('--- doc dopo apertura ---');
L1.filter(l => /\|/.test(l)).forEach(l => console.log('   ' + l));

// Now prove it re-aligns on the view→edit toggle (serekkr's other stated trigger). It no
// longer aligns on a mere caret entry — that live behaviour was removed on 23/11/2026 so
// columns can be deleted. Re-ragged the first table via a raw dispatch (as a reading-mode
// cell-sync would leave it), toggle to reading and back to edit, and confirm it snaps
// aligned — without any caret visit or typing.
const entry = await ev(`(async()=>{
  try {
    const NL=String.fromCharCode(10);
    const cm=_cmHandle.view;
    const d0=cm.state.doc, h=d0.toString().indexOf('|'), top=d0.lineAt(h).number;
    const fromPos=d0.line(top).from, toPos=d0.line(top+3).to;
    const ragged=['| zzz | dd |   |','| --- | --- | --- |','|  |   | ccc |','| CLICKHOUSE_DDL_PORT=8123 |  |  |'].join(NL);
    cm.dispatch({ changes:{ from:fromPos, to:toPos, insert:ragged }, selection:{ anchor: 0 } });
    await new Promise(r=>setTimeout(r,250));
    setViewMode('view'); await new Promise(r=>setTimeout(r,250));
    setViewMode('edit'); await new Promise(r=>setTimeout(r,450));   // alignTables() fires on edit-open
    return _cmHandle.view.state.doc.toString();
  } catch(e) { return 'ERR:'+e.message; }
})()`);
if (typeof entry !== 'string' || entry.startsWith('ERR:') || entry.startsWith('EXC:')) console.log('   (view->edit eval returned:', JSON.stringify(entry), ')');
const Le = (typeof entry === 'string' ? entry : '').split('\n').filter(l => /\|/.test(l)).slice(0, 4);
check('VIEW→EDIT: la tabella si riallinea tornando in edit (senza scrivere)', pipesEqual(Le), Le);
check('VIEW→EDIT: contenuto intatto (zzz + host)', /zzz/.test(entry) && /CLICKHOUSE_DDL_PORT=8123/.test(entry), null);
console.log('--- doc dopo view->edit ---');
Le.forEach(l => console.log('   ' + l));

// COLONNA IN CODA SENZA CONTENUTO: una colonna di coda vuota ovunque (header + tutte le
// righe) viene BUTTATA all'allineamento; una che ha anche solo un residuo di testo RESTA.
// (serekkr, 24/11/2026: se non ci sono le righe principali non ricreare la colonna — ma
// solo se del tutto vuota, altrimenti non puoi mai cancellare colonne: ncol=max() la
// faceva rinascere su ogni riga.)
const trim = await ev(`(async()=>{
  try {
    const NL=String.fromCharCode(10);
    const cm=_cmHandle.view;
    // due tabelle: la 1a con una colonna di coda VUOTA, la 2a con un residuo 'zz' in coda
    const tbl=[
      '| h1 | h2 |   |', '| --- | --- | --- |', '| a | b |   |', '| c | d |   |', '',
      '| k1 | k2 |   |', '| --- | --- | --- |', '| e | f |   |', '| g | h | zz |'
    ].join(NL);
    cm.dispatch({ changes:{ from:0, to:cm.state.doc.length, insert: tbl }, selection:{ anchor: 0 } });
    await new Promise(r=>setTimeout(r,200));
    setViewMode('view'); await new Promise(r=>setTimeout(r,250));
    setViewMode('edit'); await new Promise(r=>setTimeout(r,450));
    return _cmHandle.view.state.doc.toString();
  } catch(e) { return 'ERR:'+e.message; }
})()`);
const TL = (typeof trim === 'string' ? trim : '').split('\n').filter(l => /\|/.test(l));
const pipesOf = s => (s.match(/\|/g) || []).length;
const tr1 = TL.slice(0, 4), tr2 = TL.slice(4, 7);
// 1a tabella: colonna di coda vuota buttata -> 2 colonne (3 pipe) su ogni riga
check('CODA VUOTA: la colonna di coda vuota viene rimossa (3 pipe = 2 colonne)',
  tr1.length === 4 && tr1.every(l => pipesOf(l) === 3), tr1);
// 2a tabella: la colonna di coda con 'zz' RESTA -> 3 colonne (4 pipe), zz intatto
check('CODA CON TESTO: la colonna con un residuo (zz) resta (4 pipe = 3 colonne)',
  tr2.length === 3 && tr2.every(l => pipesOf(l) === 4) && /zz/.test(trim), tr2);
console.log('--- doc dopo trim colonne ---');
TL.forEach(l => console.log('   ' + l));

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
