// Taglia / Copia / Incolla on a preview table cell.
//
// In reading mode a table cell is a contentEditable, so right-click used to offer
// only the structural ops (row/column) and swallow the native menu — no Copy on a
// selection. The menu now carries Cut/Copy/Paste at the top. Because clicking a menu
// item blurs the cell and collapses its selection, the selection is captured when the
// menu opens and restored before the clipboard op runs.
//
// Checked here, against the running app, on a real table in view mode:
//   · Copia  — the selected cell text lands on the clipboard,
//   · Incolla — clipboard text replaces the cell's selection, in the DOM AND in the
//               note's markdown (a cell is one line: pasted newlines fold to spaces),
//   · Taglia — the selection leaves the cell and the markdown, and is on the clipboard.
//
//   run: npm run test:tableclip     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tblclip'; const VAULT = `${HOME}/vault`; const PORT = 9398;
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
fs.writeFileSync(`${VAULT}/notes/tab.md`,
  `---\ncreated: 2026-10-27 10:00\n---\n\n# Tabella\n\n` +
  `| A | B | C |\n|---|---|---|\n| uno | due | tre |\n| quattro | cinque | sei |\n`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
await sleep(600);
await ev(`(() => { if (typeof renderPreview === 'function') renderPreview(); return 1 })()`);
await sleep(1200);
await ev(`window.focus()`);

const hasTable = await ev(`!!document.querySelector('#preview-content table tbody td')`);
if (hasTable !== true) { console.error('no table rendered:', hasTable, '\n' + err.slice(-800)); process.exit(1); }

const FAKE_EV = `{ clientX: 120, clientY: 120, preventDefault(){}, stopPropagation(){} }`;

// ── COPY ───────────────────────────────────────────────────────────────────────
const copy = await ev(`(async () => {
  const cell = document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[0]; // "uno"
  cell.focus();
  const sel = window.getSelection(); const r = document.createRange();
  r.selectNodeContents(cell); sel.removeAllRanges(); sel.addRange(r);
  showTableContextMenu(${FAKE_EV}, cell);
  document.getElementById('tctx-copy').click();
  await new Promise(x => setTimeout(x, 350));
  let clip = ''; try { clip = await navigator.clipboard.readText(); } catch (e) { clip = 'ERR:' + e.message; }
  return { clip };
})()`);
check('Copia: the selected cell text is on the clipboard', copy && copy.clip === 'uno', copy);

// ── PASTE ──────────────────────────────────────────────────────────────────────
const paste = await ev(`(async () => {
  try { await navigator.clipboard.writeText('XYZ'); } catch (e) { return { err: 'write:' + e.message }; }
  const cell = document.querySelectorAll('#preview-content table tbody tr')[0].querySelectorAll('td')[2]; // "tre"
  cell.focus();
  const sel = window.getSelection(); const r = document.createRange();
  r.selectNodeContents(cell); sel.removeAllRanges(); sel.addRange(r);   // select "tre" -> replace
  showTableContextMenu(${FAKE_EV}, cell);
  document.getElementById('tctx-paste').click();
  await new Promise(x => setTimeout(x, 450));
  cell.blur();
  await new Promise(x => setTimeout(x, 150));
  return { cellText: cell.textContent.replace(/\\u200b/g, ''), md: editor.value };
})()`);
check('Incolla: clipboard text replaced the cell in the DOM',
  paste && paste.cellText === 'XYZ', paste);
check('Incolla: the note markdown now holds the pasted text',
  paste && /\\|\s*XYZ\s*\\|/.test(paste.md) && !/\btre\b/.test(paste.md), paste && paste.md);

// ── CUT ────────────────────────────────────────────────────────────────────────
const cut = await ev(`(async () => {
  const cell = document.querySelectorAll('#preview-content table tbody tr')[1].querySelectorAll('td')[1]; // "cinque"
  cell.focus();
  const sel = window.getSelection(); const r = document.createRange();
  r.selectNodeContents(cell); sel.removeAllRanges(); sel.addRange(r);
  showTableContextMenu(${FAKE_EV}, cell);
  document.getElementById('tctx-cut').click();
  await new Promise(x => setTimeout(x, 450));
  cell.blur();
  await new Promise(x => setTimeout(x, 150));
  let clip = ''; try { clip = await navigator.clipboard.readText(); } catch (e) { clip = 'ERR:' + e.message; }
  return { cellText: cell.textContent.replace(/\\u200b/g, '').trim(), clip, md: editor.value };
})()`);
check('Taglia: the cut text is on the clipboard', cut && cut.clip === 'cinque', cut);
check('Taglia: the cell is now empty', cut && cut.cellText === '', cut);
check('Taglia: the text is gone from the note markdown', cut && !/\bcinque\b/.test(cut.md), cut && cut.md);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
