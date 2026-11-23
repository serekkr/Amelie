// Edit-mode markdown tables: rendered in the monospace code font (.cm-mdtable) and
// AUTO-ALIGNED once, when edit mode opens (serekkr, 22/11/2026: "come fosse una tabella
// vera"). NOT re-aligned live while you type, nor when the caret leaves the table —
// serekkr, 23/11/2026: that live re-pad fought edits, you could not delete a column
// (the padding snapped back ~380ms after each keystroke). This test proves both: aligned
// at open, and an edit inside the table is left alone.
//
//   run: npm run test:tablealign     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tblalign'; const VAULT = `${HOME}/vault`; const PORT = 9423;
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
fs.writeFileSync(`${VAULT}/notes/t.md`,
  `---\ncreated: 2026-10-27 10:00\n---\n\n# T\n\n` +
  `| Chiave | Valore |\n|---|---|\n| my test | 8123 |\n| CLICKHOUSE_DDL_HOST | flowsignal-clickhouse |\n\ndopo la tabella\n`);
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
await ev(`(() => { const n = state.notes.find(x => /t\\.md$/.test(x.path||'')); if (n) openTab(n); return 1 })()`);
await sleep(1000);
await ev(`setViewMode('edit')`);
await sleep(800);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${JSON.stringify(d)}`}`); };

const mono = await ev(`(async()=>{ await new Promise(x=>setTimeout(x,200));
  return [...document.querySelectorAll('.cm-content .cm-line')].filter(el=>el.classList.contains('cm-mdtable')).map(el=>el.textContent.trim());
})()`);
check('monospace: le righe tabella hanno la classe .cm-mdtable',
  Array.isArray(mono) && mono.length >= 4 && mono.some(l => /Chiave/.test(l)), mono);

// Opening in edit mode already aligned the table (alignTables runs on edit-open). Moving
// the caret in and then out must NOT be required for that, and must not disturb it.
const aligned = await ev(`(async()=>{
  const cm=_cmHandle.view; const s=cm.state.doc.toString();
  cm.dispatch({ selection: { anchor: s.indexOf('my test') } });   // caret INTO the table
  await new Promise(x=>setTimeout(x,120));
  cm.dispatch({ selection: { anchor: s.indexOf('dopo la tabella') } }); // caret OUT of it
  await new Promise(x=>setTimeout(x,300));
  return cm.state.doc.toString();
})()`);
const lines = (aligned || '').split('\n');
const hdr = lines.find(l => /Chiave/.test(l)) || '';
const sep = lines.find(l => /^\|\s*-/.test(l)) || '';
const row = lines.find(l => /my test/.test(l)) || '';
const col2 = s => s.indexOf('|', s.indexOf('|') + 1);
check('apertura: le pipe della 2a colonna sono incolonnate',
  hdr && sep && row && col2(hdr) === col2(row) && col2(hdr) === col2(sep), { hdr, sep, row });
check('apertura: header, separatore e righe hanno la stessa lunghezza',
  hdr.length === sep.length && hdr.length === row.length, { h: hdr.length, s: sep.length, r: row.length });
// the long cell sets the column width, and nothing is truncated
check('apertura: nessun contenuto perso (host + valore interi)',
  /CLICKHOUSE_DDL_HOST/.test(aligned) && /flowsignal-clickhouse/.test(aligned) && /8123/.test(aligned), null);

console.log('--- tabella allineata (apertura) ---');
lines.filter(l => /\|/.test(l)).forEach(l => console.log('   ' + l));

// NUOVA REGOLA (serekkr, 23/11/2026): dentro edit mode la tabella NON si ri-allinea da
// sola. Scrivere un valore lungo in una cella deve restare com'è — niente ri-pad
// automatico delle altre righe dopo l'ex-debounce di ~380ms — così puoi modificare e
// cancellare colonne senza che il padding torni.
const live = await ev(`(async()=>{
  const cm=_cmHandle.view; const s=cm.state.doc.toString();
  const i = s.indexOf('8123');                        // the '8123' cell (already padded)
  cm.dispatch({ selection: { anchor: i, head: i+4 } });
  cm.dispatch(cm.state.replaceSelection('porta-molto-lunga-9999'));
  const headAfter = cm.state.selection.main.head;     // dove resta il cursore subito dopo
  await new Promise(r=>setTimeout(r,700));            // ben oltre l'ex-debounce (~380ms)
  const doc=cm.state.doc.toString();
  return { doc, moved: cm.state.selection.main.head !== headAfter };
})()`);
const L = (live.doc||'').split('\n');
const lh = L.find(x=>/Chiave/.test(x))||'', lr = L.find(x=>/porta-molto-lunga/.test(x))||'';
// The long value makes that row longer than the header: if a live re-pad had fired, every
// row would be padded back to the same width. It must NOT.
check('edit: il valore lungo resta come scritto (niente ri-pad automatico)',
  /porta-molto-lunga-9999/.test(live.doc) && lr.length > lh.length, { lh, lr });
check('edit: nessun reflow sposta il cursore mentre scrivi',
  live.moved === false, { moved: live.moved });

// Cancellare una pipe (togliere una colonna) resta cancellato, non torna da solo.
const pipesBefore = (live.doc.match(/\|/g) || []).length;
const del = await ev(`(async()=>{
  const cm=_cmHandle.view; const s=cm.state.doc.toString();
  const rs = s.indexOf('| my test');
  const rl = cm.state.doc.lineAt(rs);
  const lastPipe = rl.from + rl.text.lastIndexOf('|');
  cm.dispatch({ changes: { from: lastPipe, to: lastPipe + 1, insert: '' } });  // togli una pipe
  await new Promise(r=>setTimeout(r,700));
  return cm.state.doc.toString();
})()`);
check('edit: cancellare una pipe resta cancellato (non torna da solo)',
  (del.match(/\|/g) || []).length === pipesBefore - 1, { before: pipesBefore, after: (del.match(/\|/g) || []).length });

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
