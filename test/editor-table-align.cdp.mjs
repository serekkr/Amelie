// Edit-mode markdown tables: rendered in the monospace code font (.cm-mdtable) and
// AUTO-ALIGNED when the caret leaves the table, so the raw source reads like a real
// table instead of ragged pipes (serekkr, 22/11/2026: "come fosse una tabella vera").
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

const aligned = await ev(`(async()=>{
  const cm=_cmHandle.view; const s=cm.state.doc.toString();
  cm.dispatch({ selection: { anchor: s.indexOf('my test') } });   // caret INTO the table
  await new Promise(x=>setTimeout(x,120));
  cm.dispatch({ selection: { anchor: s.indexOf('dopo la tabella') } }); // caret OUT of it
  await new Promise(x=>setTimeout(x,300));                          // deferred reformat
  return cm.state.doc.toString();
})()`);
const lines = (aligned || '').split('\n');
const hdr = lines.find(l => /Chiave/.test(l)) || '';
const sep = lines.find(l => /^\|\s*-/.test(l)) || '';
const row = lines.find(l => /my test/.test(l)) || '';
const col2 = s => s.indexOf('|', s.indexOf('|') + 1);
check('allineamento: le pipe della 2a colonna sono incolonnate',
  hdr && sep && row && col2(hdr) === col2(row) && col2(hdr) === col2(sep), { hdr, sep, row });
check('allineamento: header, separatore e righe hanno la stessa lunghezza',
  hdr.length === sep.length && hdr.length === row.length, { h: hdr.length, s: sep.length, r: row.length });
// the long cell sets the column width, and nothing is truncated
check('allineamento: nessun contenuto perso (host + valore interi)',
  /CLICKHOUSE_DDL_HOST/.test(aligned) && /flowsignal-clickhouse/.test(aligned) && /8123/.test(aligned), null);

console.log('--- tabella allineata ---');
lines.filter(l => /\|/.test(l)).forEach(l => console.log('   ' + l));

// LIVE: typing a long value into a cell re-aligns the table WITHOUT leaving it, and the
// caret stays in that cell.
const live = await ev(`(async()=>{
  const cm=_cmHandle.view; const s=cm.state.doc.toString();
  const i = s.indexOf('8123');                        // the '8123' cell (already padded)
  cm.dispatch({ selection: { anchor: i, head: i+4 } });
  cm.dispatch(cm.state.replaceSelection('porta-molto-lunga-9999'));
  await new Promise(r=>setTimeout(r,600));            // past the ~380ms debounce
  const doc=cm.state.doc.toString();
  const head=cm.state.selection.main.head;
  const hl=cm.state.doc.lineAt(head);
  return { doc, headLine: hl.text, caretCol: head - hl.from };
})()`);
const L = (live.doc||'').split('\n');
const lh = L.find(x=>/Chiave/.test(x))||'', lr = L.find(x=>/porta-molto-lunga/.test(x))||'';
check('LIVE: si allinea mentre scrivo (senza uscire dalla tabella)',
  lh && lr && col2(lh) === col2(lr), { lh, lr });
check('LIVE: il cursore resta nella cella dove scrivo',
  /porta-molto-lunga/.test(live.headLine) && live.caretCol > lr.indexOf('porta-molto-lunga'), { headLine: live.headLine, caretCol: live.caretCol });

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
