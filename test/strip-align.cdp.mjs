// The sidebar's action strip ends exactly where the note's toolbar ends.
//
// They are two different stacks — search box + icon row on the left, title +
// dates + formatting tools on the right — so their bottom rules used to land at
// different heights and the top of the window read as crooked. Measured before:
// 20px apart at the default icon size, and the gap MOVED with that setting (16px
// at 70%, 28px at 130%), which is why it is computed at runtime rather than
// padded by a constant — a constant is right at exactly one zoom level.
//
// This drives the real app at three icon sizes and on a note whose header
// carries extra rows, since that moves the toolbar without resizing it.
//
//   run: npm run test:align     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-stripalign'; const VAULT = `${HOME}/vault`; const PORT = 9393;
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
fs.writeFileSync(`${VAULT}/notes/semplice.md`, '---\ncreated: 2026-08-27 10:00\n---\n\ntesto\n');
fs.writeFileSync(`${VAULT}/notes/con tag.md`,
  '---\ncreated: 2026-08-27 10:01\ntags: [lavoro, casa]\nsource: https://example.com/pagina\n---\n\ntesto #lavoro\n');
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
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 20000); });
await sleep(1800);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

const gap = () => ev(`(() => {
  const s = document.getElementById('sidebar-views'), t = document.getElementById('editor-toolbar');
  if (!s || !t) return null;
  const sr = s.getBoundingClientRect(), tb = t.getBoundingClientRect().bottom;
  const btn = s.querySelector('.sidebar-view-btn');
  const br = btn ? btn.getBoundingClientRect() : null;
  return {
    gap: Math.round(tb - sr.bottom), strip: Math.round(sr.bottom), toolbar: Math.round(tb),
    // The extra height has to be shared above and below the icons: dumping it
    // all underneath left them riding at the top of a tall empty strip.
    above: br ? Math.round(br.top - sr.top) : null,
    below: br ? Math.round(sr.bottom - br.bottom) : null,
  };
})()`);

for (const [label, name] of [['a plain note', 'semplice'], ['a note carrying tags and a source', 'con tag']]) {
  await ev(`(async () => { const n = (state.notes||[]).find(x => x.name === ${JSON.stringify(name)}); if (n) await openNote(n); })()`);
  await sleep(1300);
  const g = await gap();
  check(`the two rules meet at the same height on ${label} (gap ${g && g.gap}px, was 20px)`,
    !!g && Math.abs(g.gap) <= 1, JSON.stringify(g));
  check(`and the icons sit in the middle of the strip, not at its top (${g && g.above}px above / ${g && g.below}px below)`,
    !!g && Math.abs(g.above - g.below) <= 2, JSON.stringify(g));
}

// The gap used to move with the icon-size setting — 16px at 70%, 28px at 130% —
// which is exactly why a fixed padding was not enough.
for (const z of [70, 130, 100]) {
  await ev(`applyAppearance({ ...loadAppearance(), toolbarZoom: ${z} }), 1`);
  await sleep(900);
  const g = await gap();
  check(`still level at icon size ${z}% (gap ${g && g.gap}px), icons still centred (${g && g.above}/${g && g.below})`,
    !!g && Math.abs(g.gap) <= 1 && Math.abs(g.above - g.below) <= 2, JSON.stringify(g));
}

console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
