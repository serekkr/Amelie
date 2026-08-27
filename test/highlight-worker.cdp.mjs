// A code-heavy note colours its blocks WITHOUT holding the main thread.
//
// hljs.highlightElement() does two expensive things on one thread: it runs the
// grammar over the code, then hands the DOM the HTML that comes out. Measured
// on a 300-line block: grammar 15 ms (bash) / 29 ms (javascript), DOM parse +
// layout 16–43 ms. The old path did twelve blocks in one synchronous loop, so
// a note like this one took the main thread away for a quarter of a second.
//
// Now the grammar runs in highlight-worker.js and only the DOM half is left
// here, one block per turn against a real deadline. This test drives the REAL
// app: it opens a note holding the user's own 303-line shell script twelve
// times over, watches the frame clock while the preview renders, and then
// checks the colours actually arrived and the code came back byte-identical.
//
// The worker is a plain same-directory script on purpose: under the page CSP
// (default-src 'self') a file:// page CAN start one — a blob: worker is
// refused. If that ever regresses, the first check below fails.
//
//   run: npm run test:hl        (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-hlworker'; const VAULT = `${HOME}/vault`; const PORT = 9357;
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
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });

// The script the user actually keeps in this repo — a real 303-line file beats
// a generated one, and it is the same script preview-code-untouched.test.mjs uses.
const SCRIPT = fs.readFileSync(`${REPO}/map-tiles-gen.sh`, 'utf8').replace(/\n$/, '');
const BLOCKS = 12;   // exactly one old batch: the worst case the old code had
// Block 1 is the script alone, so the byte-identity check below reads back
// something known. The rest are three times as long, which is what makes the
// note heavy enough to tell the two paths apart (see the frame-gap check).
const body = Array.from({ length: BLOCKS }, (_, i) =>
  `## block ${i + 1}\n\n\`\`\`bash\n${i === 0 ? SCRIPT : [SCRIPT, SCRIPT, SCRIPT].join('\n')}\n\`\`\`\n`).join('\n');
fs.writeFileSync(`${VAULT}/notes/code.md`,
  `---\ncreated: 2026-08-27 10:00\nmodified: 2026-08-27 10:00\n---\n\n${body}`);
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
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res('<<timeout>>'); }, 30000); });
await sleep(1500);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// ── Open the note in reading mode while a frame clock runs ──────────────────
// The clock is started BEFORE the render and sampled on every animation frame:
// the biggest gap between two frames is how long the main thread was gone.
await ev(`
  window.__gaps = { max: 0, last: performance.now(), n: 0 };
  (function tick(){ const t = performance.now();
    __gaps.max = Math.max(__gaps.max, t - __gaps.last); __gaps.last = t; __gaps.n++;
    requestAnimationFrame(tick); })();
  true`);
await sleep(400);
await ev(`(async () => {
  const n = (state.notes || []).find(x => x.name === 'code');
  await openNote(n);
  setViewMode('view');
})()`);
await sleep(6000);
// Opening a note does plenty besides colouring (read, frontmatter, editor).
// Measure a SECOND render of the same preview: identical work on both paths
// except the one thing this change moved off the thread.
// Three renders, and the BEST of the three worst-gaps is what counts: one
// worst-gap is at the mercy of a stray scheduler stall on a busy machine (a
// run under load put an otherwise-53 ms render at 165), while a regression
// puts every render over the line.
let bestGap = Infinity, frames = 0;
for (let round = 0; round < 3; round++) {
  await ev(`(() => { __gaps.max = 0; __gaps.last = performance.now(); updatePreview(); true })()`);
  await sleep(6000);
  const g = await ev(`(() => ({ max: Math.round(__gaps.max), frames: __gaps.n }))()`);
  if (g && g.max < bestGap) { bestGap = g.max; frames = g.frames; }
}

const worker = await ev(`(() => ({ alive: !!_hlWorker, dead: !!_hlWorkerDead }))()`);
check('the renderer really started the worker (CSP lets a file:// page do it)',
  worker && worker.alive && !worker.dead, JSON.stringify(worker));

// Measured on this note: the old on-thread batch of twelve loses the main
// thread for 243/244/258 ms in one go, every render; the worker path, 166.
//
// Most of that 166 is NOT this: with highlighting disabled outright the same
// render still costs 127 ms, and the markdown parse is only 14 of it (454 KB of
// HTML comes out of it) — the rest is sanitising and inserting that HTML, which
// was there before and is there now. So colouring is worth ~39 ms of the gap,
// down from ~120. Anyone trying to make this number smaller should go after the
// sanitise-and-insert half, not the grammar.
//
// 205 sits between the two, ~39 ms clear either way — tighter would fail on a
// loaded machine (with a VM eating a core next door this read 153 where a quiet
// run reads 166, so the noise is real and not one-directional).
check(`the main thread never goes away for long (best-of-three worst gap ${bestGap} ms)`,
  bestGap > 0 && bestGap < 205, `best worst-gap over three renders was ${bestGap} ms (${frames} frames)`);

const state2 = await ev(`(() => {
  const els = [...document.querySelectorAll('#preview-content pre code')];
  return {
    blocks: els.length,
    coloured: els.filter(e => e.classList.contains('hljs') && e.querySelector('span')).length,
    pending: _hlJobs.size + _hlReady.length,
  };
})()`);
check(`every code block ends up coloured (${state2.coloured}/${state2.blocks})`,
  state2.blocks === BLOCKS && state2.coloured === state2.blocks, JSON.stringify(state2));
check('nothing is left queued once the render has settled', state2.pending === 0, JSON.stringify(state2));

// Colour must never cost a byte of the code: the block hands back the script.
const shown = await ev(`document.querySelector('#preview-content pre code').textContent.replace(/\\n$/, '')`);
check('the coloured block still hands back exactly the script that went in',
  shown === SCRIPT,
  (() => { const i = [...SCRIPT].findIndex((c, k) => c !== shown[k]);
           return `first difference at char ${i}: want ${JSON.stringify(SCRIPT.slice(i, i + 40))} got ${JSON.stringify(String(shown).slice(i, i + 40))}`; })());

// bash extras (commands/flags) are a main-thread pass that runs AFTER the worker's
// HTML lands — it must still find its text nodes in there.
const shell = await ev(`document.querySelectorAll('#preview-content .sh-cmd, #preview-content .sh-flag').length`);
check(`shell commands and flags are still coloured on top (${shell} spans)`, shell > 0, String(shell));

console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
