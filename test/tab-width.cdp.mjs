// Tabs share the strip: wide while there are few, narrower as they multiply.
//
// They used not to. Each tab came out the width of its own title and the bar sat
// half empty beside it — measured before the change: one tab 128 px with 769 px
// of empty strip next to it, two at 135 px each, and no narrowing at all until
// the eighth tab. The strip itself was `flex: 0 1 auto`, so it was only ever as
// wide as its tabs asked to be, and the tabs had nothing to grow into.
//
// Now the strip claims the width available to it and each tab is `flex: 1 1 0`
// between 58 px and 200 px: full width while they fit, then narrowing.
// #tab-drag-space no longer competes for that width either — splitting the bar
// with it squeezed three tabs to 206 px while 280 px sat empty beside them. The
// window still drags by the empty stretch after the last tab, which belongs to
// #tab-list and is a drag region. The 58 px floor is what keeps the close ✕
// reachable when the strip is crammed.
//
//   run: npm run test:tabs      (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tabwidth'; const VAULT = `${HOME}/vault`; const PORT = 9383;
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
const NAMES = ['Progetti 2026', 'Riunione lunedi', 'Spesa', 'Appunti vari', 'Backup NAS',
               'Ricette', 'Viaggio Lisbona', 'Contratti', 'Idee', 'Fatture'];
NAMES.forEach((n, i) => fs.writeFileSync(`${VAULT}/notes/${n}.md`,
  `---\ncreated: 2026-08-27 10:${String(i).padStart(2, '0')}\n---\n\n${n}\n`));
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

const sample = [];
for (let n = 1; n <= 10; n++) {
  await ev(`(() => { const t = state.notes.filter(x => x.type === 'note')[${n - 1}]; if (t) openTab(t); return 1 })()`);
  await sleep(400);
  const r = await ev(`(() => {
    const tabs = [...document.querySelectorAll('#tab-list .note-tab')];
    if (!tabs.length) return null;
    const last = tabs[tabs.length - 1];
    const close = last.querySelector('.tab-close');
    const strip = document.getElementById('tab-list').getBoundingClientRect();
    const cb = close ? close.getBoundingClientRect() : null;
    return {
      n: tabs.length,
      w: Math.round(tabs[0].getBoundingClientRect().width),
      font: getComputedStyle(tabs[0]).fontSize,
      closeVisible: !!cb && cb.width > 0 && cb.right <= strip.right + 1,
    };
  })()`);
  if (r) sample.push(r);
}
console.log('   ' + sample.map(s => `${s.n}:${s.w}px`).join('  '));

check('every tab count was measured', sample.length === 10, `${sample.length} samples`);
const w = Object.fromEntries(sample.map(s => [s.n, s.w]));

// Few tabs: a tab is a proper label, not the width of its own title. Before the
// change one tab measured 128 px with the rest of the bar empty.
check(`one tab is wide (${w[1]}px — it was 128px with 769px of empty strip beside it)`,
  w[1] >= 180, `${w[1]}px`);
check(`two tabs are still wide (${w[2]}px, was 135px)`, w[2] >= 180, `${w[2]}px`);

// Up to four they all fit at full width; after that every new tab
// makes them all narrower — the half the old strip never did.
check(`four tabs still fit at full width (${w[4]}px)`, w[4] >= 180, `${w[4]}px`);
const shrinks = [5, 6, 7, 8, 9, 10].every(n => w[n] < w[n - 1]);
check('once they no longer fit, each further tab makes them all narrower', shrinks,
  sample.map(s => `${s.n}:${s.w}`).join(' '));
check(`ten tabs are much narrower than two (${w[10]}px vs ${w[2]}px)`,
  w[10] < w[2] * 0.5, `${w[10]} vs ${w[2]}`);

// The floor exists so the ✕ survives a crammed strip.
check(`the close ✕ is still reachable on the last tab at ten tabs`,
  sample[9].closeVisible, JSON.stringify(sample[9]));

// The empty stretch beside a lone tab has to stay a window-drag handle: that is
// what #tab-drag-space was for, and it no longer takes any width of its own.
const drag = await ev(`(() => {
  const list = document.getElementById('tab-list');
  return { region: getComputedStyle(list).webkitAppRegion || getComputedStyle(list).getPropertyValue('-webkit-app-region'),
           actions: !!document.getElementById('titlebar-actions') };
})()`);
check('the empty part of the strip still drags the window',
  drag && (drag.region === 'drag' || drag.actions), JSON.stringify(drag));
check(`the label is 13px, like the sidebar tree (${sample[0].font})`,
  sample[0].font === '13px', sample[0].font);

console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
