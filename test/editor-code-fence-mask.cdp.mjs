// Edit-mode fenced-code grey mask (CodeMirror): the shaded region must be CARET-
// INDEPENDENT. An earlier heuristic dropped "the fence nearest the caret" when the
// fence count was odd (an unclosed ```), so the mask LEAPT between blocks on every
// click — it even landed on a heading sitting between two blocks (serekkr, 22/11/2026).
//
// Checked here against the running app, in edit mode:
//   · ODD fences (one block left open) — the mask covers the FIRST, closed block and
//     stays put no matter where the caret is; the heading between blocks is NOT shaded,
//     and the open block masks nothing.
//   · EVEN fences (two closed blocks) — both blocks are shaded and the heading between
//     them is not.
//
//   run: npm run test:fencemask     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-fencemask'; const VAULT = `${HOME}/vault`; const PORT = 9418;
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
const FENCE = '```';
// ODD: block1 closed (F1..F2), block2 OPEN (F3, never closed).
const odd = `---\ncreated: 2026-10-27 10:00\n---\n\n` +
  `### 1. Pulizia Totale\n\nBash\n\n` +
  `${FENCE}\n# rimuovi regole\nip rule del priority 5 2>/dev/null\nip route flush table 200\n${FENCE}\n` +
  `\n### 2. Reinserimento\n\n` +
  `${FENCE}\n# rotta di uscita\nip route add default via 192.168.4.1 table 200\n`;
// EVEN: two fully closed blocks with a heading between.
const even = `---\ncreated: 2026-10-27 10:00\n---\n\n` +
  `### A\n\n${FENCE}\nalpha-uno\nalpha-due\n${FENCE}\n\n### B\n\n${FENCE}\nbeta-uno\nbeta-due\n${FENCE}\n`;
fs.writeFileSync(`${VAULT}/notes/odd.md`, odd);
fs.writeFileSync(`${VAULT}/notes/even.md`, even);
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

const open = async name => { await ev(`(() => { const n = state.notes.find(x => new RegExp(${JSON.stringify(name)}).test(x.path||x.name||'')); if (n) openTab(n); return 1 })()`); await sleep(900); await ev(`setViewMode('edit')`); await sleep(700); };
// Put the caret on the line that holds `needle` (the editor strips frontmatter, so the
// offset is found in the LIVE CM document, not the raw file string), scroll to the top
// so the shaded lines are always in view, then read which lines carry the code mask.
const shadedAt = needle => ev(`(async () => {
  const cm = _cmHandle && _cmHandle.view; if (!cm) return 'NOCM';
  const at = cm.state.doc.toString().indexOf(${JSON.stringify(needle)});
  if (at >= 0) cm.dispatch({ selection: { anchor: at } });
  cm.scrollDOM.scrollTop = 0;
  await new Promise(x=>requestAnimationFrame(x)); await new Promise(x=>setTimeout(x,150));
  const a = [...document.querySelectorAll('.cm-content .cm-line')].filter(el => el.classList.contains('cm-codeblock')).map(el => el.textContent.replace(/\\u200b/g,'').trim());
  return a.join('\\u0001');   // a clean empty string survives CDP better than []
})()`).then(s => (typeof s === 'string' && s.length) ? s.split('\u0001') : []);

// ── ODD note ─────────────────────────────────────────────────────────────────
await open('odd');
const topO = await shadedAt('Bash');                 // caret early, above the first block
const midO = await shadedAt('### 2. Reinserimento');  // caret on the heading between blocks
check('odd: lo sfondo copre il blocco 1 (ip rules) col caret in alto',
  topO.some(l => /ip rule del priority 5/.test(l)), topO);
check('odd: lo stesso con il caret sulla riga "### 2" (nessun salto)',
  JSON.stringify(topO) === JSON.stringify(midO), { topO, midO });
check('odd: la riga "### 2" NON e ombreggiata',
  !topO.some(l => /Reinserimento/.test(l)), topO);
check('odd: il blocco aperto (rotta di uscita) non e ombreggiato',
  !topO.some(l => /rotta di uscita|ip route add default/.test(l)), topO);

// ── EVEN note ────────────────────────────────────────────────────────────────
await open('even');
const e1 = await shadedAt('### A');
const e2 = await shadedAt('### B');
check('even: lo sfondo e identico al variare del caret',
  JSON.stringify(e1) === JSON.stringify(e2), { e1, e2 });
check('even: entrambi i blocchi (alpha + beta) sono ombreggiati',
  e1.some(l => /alpha-uno/.test(l)) && e1.some(l => /beta-uno/.test(l)), e1);
check('even: la riga "### B" tra i blocchi NON e ombreggiata',
  !e1.some(l => /^### B$/.test(l)), e1);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
