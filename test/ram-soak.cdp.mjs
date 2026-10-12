// Does Amelie keep the memory it takes? A long session, in fast forward.
//
// An hour of real use is a few hundred of these: open a note, open another, close a
// tab, go to Recent and back, fold the tree, change its sort, open the PDF and leave
// it, open Settings and leave it. Each one builds DOM and hangs listeners on it, and
// anything that is rebuilt rather than torn down shows up as a heap that only ever
// goes one way.
//
// Measured, not eyeballed: the JS heap is read AFTER a forced garbage collection
// (HeapProfiler.collectGarbage, so what is read is what could not be freed), together
// with the live DOM node count and the resident memory of the whole process group.
// The first rounds are the warm-up — lazily loaded code, caches, the PDF engine — so
// the question is whether the LAST rounds still climb on top of a settled app.
//
// Thresholds are deliberately loose (a leak here is linear in the number of rounds,
// not a few hundred KB): the heap may not grow by more than half again over the
// settled baseline, and the DOM must not grow at all beyond a small margin.
//
//   run: npm run test:ramsoak     (needs xvfb-run; ~2 minutes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PDFDocument, StandardFonts } = createRequire(import.meta.url)(REPO + '/node_modules/pdf-lib');
const HOME = '/tmp/amelie-ramsoak'; const VAULT = `${HOME}/vault`; const PORT = 9407;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300000);

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Lavoro`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/pdf`, { recursive: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
for (const [p, body] of [['notes/uno.md', 'uno\n\n## sezione\n\ntesto'], ['notes/due.md', 'due'],
                         ['notes/Lavoro/tre.md', 'tre'], ['notes/Lavoro/quattro.md', 'quattro']])
  fs.writeFileSync(`${VAULT}/${p}`, fm + body + '\n');
{
  const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) d.addPage([595, 842]).drawText('Pagina ' + i, { x: 60, y: 760, size: 32, font: f });
  fs.writeFileSync(`${VAULT}/attachments/pdf/doc.pdf`, await d.save());
}
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise(res => { const my = ++id; pending.set(my, r => res(r.result)); ws.send(JSON.stringify({ id: my, method: m, params: p })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
const ev = x => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then(r => r?.result?.value);
await send('HeapProfiler.enable');
await sleep(3000);

const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// Resident memory of every process of THIS app (main + renderer + helpers), in MB.
const rssMB = () => {
  try {
    const out = execSync(`ps -o rss= -p $(pgrep -f 'remote-debugging-port=${PORT}' | tr '\\n' ',' | sed 's/,$//') 2>/dev/null || true`, { encoding: 'utf8' });
    return Math.round(out.split('\n').filter(Boolean).reduce((a, b) => a + parseInt(b.trim() || '0', 10), 0) / 1024);
  } catch (_) { return null; }
};
const sample = async () => {
  await send('HeapProfiler.collectGarbage');
  await sleep(600);
  const h = await send('Runtime.getHeapUsage');
  const dom = await ev(`document.getElementsByTagName('*').length`);
  const tabs = await ev(`tabs.length`);
  return { heap: Math.round((h?.usedSize || 0) / 1048576), dom, tabs, rss: rssMB() };
};

// One round of ordinary use.
const round = async () => {
  await ev(`(async () => { const n = flattenTree(state.notes).find(x => x.path === 'uno.md'); if (n) await openNote(n); })()`);
  await sleep(220);
  await ev(`(async () => { const n = flattenTree(state.notes).find(x => x.path === 'Lavoro/tre.md'); if (n) await openNote(n); })()`);
  await sleep(220);
  await ev(`(async () => { const n = flattenTree(state.notes).find(x => x.path === 'due.md'); if (n) await openTab(n, true); })()`);
  await sleep(300);
  await ev(`(() => { if (tabs.length > 2) closeTab(tabs.length - 1); return 1; })()`);
  await ev(`document.getElementById('view-recent').click()`); await sleep(150);
  await ev(`document.getElementById('view-tags').click()`); await sleep(150);
  await ev(`document.getElementById('view-files').click()`); await sleep(150);
  await ev(`document.getElementById('btn-collapse-all').click()`); await sleep(200);
  await ev(`document.getElementById('btn-collapse-all').click()`); await sleep(200);
  await ev(`setTreeSort('name-asc')`); await sleep(250);
  await ev(`setTreeSort('manual')`); await sleep(250);
  // The PDF: opened and left again, which is where a viewer usually keeps its pages.
  await ev(`(async () => { const p = flattenTree(state.notes).find(x => x.type === 'pdf'); if (p) await openNote(p); })()`);
  await sleep(900);
  await ev(`(() => { const i = tabs.findIndex(t => t.type === 'pdf'); if (i >= 0) closeTab(i); return 1; })()`);
  await sleep(300);
  await ev(`openSettings()`); await sleep(350);
  await ev(`closeSettings && closeSettings()`); await sleep(200);
  await ev(`showToast('giro')`);
  await ev(`renderSyncProgress({ op: 'twoway', phase: 'transfer', done: 1, total: 4, action: 'upload', file: 'notes/uno.md', manual: true })`);
  await sleep(150);
  await ev(`renderSyncProgress({ op: 'twoway', final: true, total: 4 })`);
  await sleep(150);
};

const ROUNDS = 14, WARMUP = 4;
const marks = [];
for (let i = 1; i <= ROUNDS; i++) {
  await round();
  if (i === WARMUP || i === ROUNDS || i % 5 === 0) {
    const s = await sample();
    marks.push({ i, ...s });
    console.log(`  giro ${String(i).padStart(2)}  heap ${String(s.heap).padStart(3)} MB  dom ${String(s.dom).padStart(5)}  tab ${s.tabs}  rss ${s.rss} MB`);
  }
}

const base = marks.find(m => m.i === WARMUP);
const last = marks[marks.length - 1];
check('the app survived the whole soak', !!base && !!last && last.dom > 0, JSON.stringify(marks));
check('tabs do not pile up round after round', last.tabs <= 3, `${last.tabs} tabs at the end`);
check(`the DOM does not grow (${base.dom} → ${last.dom} nodes)`,
  last.dom <= base.dom + 150, JSON.stringify(marks.map(m => [m.i, m.dom])));
// A leak is a heap that goes up at EVERY look, which is what this asks — a single
// threshold either has to be loose enough to let a slow leak through or tight enough
// to trip on ordinary drift. The absolute guard stays for a fast one.
const heaps = marks.map(m => m.heap);
const everClimbing = heaps.every((h, i) => i === 0 || h > heaps[i - 1]);
check(`the heap settles instead of climbing (${heaps.join(' → ')} MB over ${ROUNDS - WARMUP} rounds)`,
  !everClimbing && last.heap <= Math.max(base.heap * 1.5, base.heap + 12), JSON.stringify(marks.map(m => [m.i, m.heap])));
check(`resident memory settles too (${base.rss} → ${last.rss} MB)`,
  last.rss == null || base.rss == null || last.rss <= Math.max(base.rss * 1.5, base.rss + 150),
  JSON.stringify(marks.map(m => [m.i, m.rss])));

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
