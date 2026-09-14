// Reading mode must number the file's BLANK lines too.
//
// The reading-mode gutter measured the rendered rows and numbered those. Rendered
// HTML has no blank lines in it — two paragraphs are held apart by a collapsed CSS
// margin — so every gap got no number and the column came out full of holes: a
// number, a hole the same size as a row, a number. The editor's gutter, next door,
// numbers a blank line like any other row, so the two columns also disagreed about
// which number belongs to which paragraph, by one per blank line above it.
//
// The blank lines are read back from the source instead (marked keeps each run as a
// `space` token) and spread through the gap they went into, so the column runs
// unbroken and paragraph N in the file is number N on screen.
//
//   run: npm run test:linenums     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-linenums'; const VAULT = `${HOME}/vault`; const PORT = 9397;
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

// Short lines on purpose: nothing here may soft-wrap at 1400px, so one file line is
// one row on screen and "how many numbers" has a single right answer. The run of
// THREE blank lines is the case a geometric guess cannot get right — on screen it is
// the same collapsed margin as a run of one.
fs.writeFileSync(`${VAULT}/notes/righe.md`,
  `---\ncreated: 2026-09-14 11:00\n---\n\n` +
  `# Titolo\n\nalfa\n\nbeta\n\n\n\ngamma\n\n- uno\n- due\n\ndelta\n`);
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
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

await ev(`(() => { const n = state.notes.find(x => /righe/.test(x.path || x.name || '')); if (n) openTab(n); return 1 })()`);
await sleep(1500);
await ev(`setViewMode('view')`);
await sleep(800);
await ev(`(() => { document.getElementById('editor-pane')?.classList.add('line-numbers');
  document.documentElement.style.setProperty('--editor-font-size', '19px'); return 1 })()`);
await ev(`(() => { if (typeof renderPreview === 'function') renderPreview(); return 1 })()`);
await sleep(1500);
await ev(`(() => { if (typeof renderPreviewGutter === 'function') renderPreviewGutter(); return 1 })()`);
await sleep(500);

const MEASURE = `(() => {
  const pc = document.getElementById('preview-content');
  const pane = document.getElementById('preview-pane');
  const g = document.getElementById('preview-gutter');
  if (!pc || !pane || !g) return { err: 'no preview' };
  const originY = pane.getBoundingClientRect().top + pane.clientTop - pane.scrollTop;
  const nums = [...g.children].map(d => ({ n: parseInt(d.textContent, 10), top: parseFloat(d.style.top),
                                          h: parseFloat(d.style.height) }))
                              .sort((a, b) => a.top - b.top);
  // Measured here with the browser's own Range, not with the app's helper: the rows
  // are where the TEXT is, and a block's box is taller than its text (the line-height
  // leading sits inside it), so a block's rect is the wrong thing to compare against.
  const rowsOf = el => {
    const rg = document.createRange(); rg.selectNodeContents(el);
    return [...rg.getClientRects()].filter(r => r.width > 0 && r.height > 0)
             .map(r => ({ top: r.top - originY, bottom: r.bottom - originY }));
  };
  // The rows the file has: every line of the body the preview renders, blank ones
  // included. Nothing in this fixture soft-wraps, so one line is one row.
  const body = (typeof _previewBody === 'function' ? _previewBody(editor.value) : editor.value).split('\\n');
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();

  // How many numbers land in each gap BETWEEN two blocks — the space the file's blank
  // lines went into. Bounded by the text either side, so a block's own number (which
  // sits exactly on its first row) is never counted as being in the gap above it.
  const blocks = [...pc.children].map(rowsOf).filter(r => r.length);
  const inGaps = [];
  for (let i = 1; i < blocks.length; i++) {
    const lo = blocks[i - 1][blocks[i - 1].length - 1].bottom, hi = blocks[i][0].top;
    inGaps.push(nums.filter(x => x.top >= lo - 1 && x.top <= hi - 2).length);
  }
  const pitch = (() => {
    const el = pc.querySelector('p, li');
    return el ? parseFloat(getComputedStyle(el).lineHeight) : 0;
  })();
  // The tightest the column ever gets. A run of blank lines used to be squeezed into
  // the collapsed margin, which is the same ~12px whether the file has two blank
  // lines there or five, so the numbers landed on top of each other.
  let minStep = 1e9, minAt = null, maxStep = 0, maxAt = null;
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i].top - nums[i - 1].top;
    if (d < minStep) { minStep = d; minAt = nums[i - 1].n; }
    // Measured between rows that ARE a line of text: a heading is a taller row and
    // the step beside it is taller with it, which is the layout, not a fault.
    if (d > maxStep && nums[i - 1].h <= pitch * 1.1) { maxStep = d; maxAt = nums[i - 1].n; }
  }
  const probe = (sel, text) => {
    const el = [...pc.querySelectorAll(sel)].find(e => e.textContent.trim() === text);
    if (!el) return { text, n: null, top: null };
    const r = rowsOf(el)[0];
    const hit = r ? nums.find(x => Math.abs(x.top - r.top) <= 2) : null;
    return { text, top: r ? Math.round(r.top) : null, n: hit ? hit.n : null };
  };
  return {
    count: nums.length, lines: body.length, seq: nums.map(x => x.n), inGaps,
    minStep: Math.round(minStep * 10) / 10, minAt, pitch: Math.round(pitch * 10) / 10,
    maxStep: Math.round(maxStep * 10) / 10, maxAt,
    probes: ['alfa', 'beta', 'gamma', 'delta'].map(t => probe('p', t)).concat([probe('li', 'due')]),
    srcLine: { alfa: body.indexOf('alfa') + 1, beta: body.indexOf('beta') + 1, gamma: body.indexOf('gamma') + 1,
               due: body.indexOf('- due') + 1, delta: body.indexOf('delta') + 1 },
  };
})()`;

const m = await ev(MEASURE);
if (!m || m.err) { console.error('measure failed:', JSON.stringify(m), '\n' + err.slice(-800)); process.exit(1); }
console.log('   numbers    ' + JSON.stringify(m.seq) + '   file lines ' + m.lines);
console.log('   per gap    ' + JSON.stringify(m.inGaps) + '   (blank lines in the file: [1,1,3,1,1])');
console.log('   probes     ' + JSON.stringify(m.probes));
console.log('   steps      ' + m.minStep + 'px to ' + m.maxStep + 'px (after ' + m.minAt + ' / ' + m.maxAt + '), a row is ' + m.pitch + 'px');

// 1. A number for every line the file has, blank ones included.
check(`the reading view numbers all ${m.lines} lines of the file (got ${m.count})`,
  m.count === m.lines,
  `${m.count} numbers for ${m.lines} lines — the blank lines are the difference`);

// 2. Sequential from 1, so a number means the row it is beside.
check('the numbers run 1..N with none missing',
  m.seq.length > 0 && m.seq.every((n, i) => n === i + 1),
  `got ${JSON.stringify(m.seq)}`);

// 3. The symptom itself: every gap between two blocks used to hold no number at all,
//    leaving a hole in the column the height of a row. The run of THREE blank lines
//    is why the count is read from the source — on screen that gap is the same
//    collapsed margin as a run of one, so nothing about it can be measured.
const WANT_GAPS = [1, 1, 3, 1, 1];
check(`each gap carries the blank lines the file has there (${JSON.stringify(m.inGaps)})`,
  m.inGaps.length === WANT_GAPS.length && m.inGaps.every((n, i) => n === WANT_GAPS[i]),
  `got ${JSON.stringify(m.inGaps)}, file has ${JSON.stringify(WANT_GAPS)}`);

// 4. Readable: no two numbers sit on top of each other. The file's run of three
//    blank lines has to be given room in the reading view, or the numbers for it are
//    right and unreadable — the same fault as the holes, from the other side.
check(`no two numbers crowd each other (tightest ${m.minStep}px against a ${m.pitch}px row)`,
  m.pitch > 0 && m.minStep >= m.pitch * 0.5,
  `${m.minStep}px between number ${m.minAt} and the next — a run of blank lines was squeezed into a margin`);

// 5. Evenly, which is the whole point: one row between any two numbers, whether the
//    line between them holds text or nothing. Measured between rows that are a line
//    of text — the heading is a taller row, and the step beside it is taller with it.
check(`the column steps one row at a time (${m.minStep}-${m.maxStep}px against a ${m.pitch}px row)`,
  m.pitch > 0 && m.minStep >= m.pitch * 0.9 && m.maxStep <= m.pitch * 1.15,
  `steps run ${m.minStep}px to ${m.maxStep}px — the column is uneven`);

// 6. And so the number beside a line is that line's number in the file — which is
//    what the editor's gutter says about the same note, and what it did not say here.
for (const p of m.probes) {
  const want = m.srcLine[p.text];
  check(`"${p.text}" is number ${want} in the reading view, as it is in the file`,
    p.n === want, `got ${p.n} beside its row at y=${p.top}`);
}

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
