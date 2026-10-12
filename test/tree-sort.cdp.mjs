// The sort order of the note tree — Obsidian's file-explorer control, with the one
// choice Obsidian cannot have: Manual, Amelie's saved drag order.
//
// What makes this worth a test is not the sorting itself but what must survive it:
// the hand-made order. It is what every vault here was arranged in before the button
// existed, it lives in a file that travels with the vault (.amelie-order.json), and a
// sort is only a VIEW over it — pick a sort, go back to Manual, and the arrangement
// has to be exactly as it was left, to the item.
//
// Checked here, against the running app, on a vault whose names, modification times
// and creation dates all disagree on purpose (so a passing sort cannot be the file
// system's own order by luck):
//   · the default is Manual, and the saved drag order is what you see,
//   · each of the six sorts really reorders the tree, folders always first,
//   · sorting is a view: .amelie-order.json is not rewritten by it,
//   · the choice survives a reload, and is readable without guessing: the tooltip
//     names it and the menu ticks it — the icon itself never lights up (asked),
//   · and Manual gives the hand-made order back, unchanged.
//
//   run: npm run test:treesort     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-treesort'; const VAULT = `${HOME}/vault`; const PORT = 9404;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const ORDER = `${VAULT}/notes/.amelie-order.json`;
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
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 150000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Zeta`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Alfa`, { recursive: true });

// name, created (frontmatter), modified (mtime). The three orders are all different:
//   name:      bruno, carla, dino, anna
//   created:   anna(01) bruno(02) carla(03) dino(04)
//   modified:  dino(10) carla(11) bruno(12) anna(13)
const NOTES = [
  { f: 'bruno',  created: '2026-02-02 10:00', mtime: '2026-09-12T10:00:00Z' },
  { f: 'carla',  created: '2026-03-03 10:00', mtime: '2026-09-11T10:00:00Z' },
  { f: 'dino',   created: '2026-04-04 10:00', mtime: '2026-09-10T10:00:00Z' },
  { f: 'anna',   created: '2026-01-01 10:00', mtime: '2026-09-13T10:00:00Z' },
];
for (const n of NOTES) {
  const p = `${VAULT}/notes/${n.f}.md`;
  fs.writeFileSync(p, `---\ncreated: ${n.created}\n---\n\n${n.f}\n`);
  fs.utimesSync(p, new Date(n.mtime), new Date(n.mtime));
}
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
// The hand-made order: deliberately none of the sorts above.
// Paths in this file are relative to notes/ — the same strings the tree carries.
const HAND_ORDER = ['Zeta', 'Alfa', 'dino.md', 'anna.md', 'carla.md', 'bruno.md'];
fs.writeFileSync(ORDER, JSON.stringify({ '': HAND_ORDER }, null, 1));

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
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
await sleep(2600);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// The ROOT level as it is painted, top to bottom.
const rows = () => ev(`[...document.querySelectorAll('#file-tree > div')].map(d => {
  const f = d.querySelector(':scope > .tree-folder'); if (f) return f.dataset.folder.split('/').pop();
  const n = d.classList.contains('tree-note') || d.dataset.path ? d : d.querySelector('[data-path]');
  return n ? (n.dataset.path || '').split('/').pop().replace(/\\.md$/, '') : null;
}).filter(Boolean)`);
const pick = async (mode) => {
  await ev(`document.getElementById('btn-sort').click()`); await sleep(400);
  await ev(`document.querySelector('#sort-menu .sort-item[data-sort="${mode}"]').click()`); await sleep(1100);
};
const btnState = () => ev(`(() => { const b = document.getElementById('btn-sort');
  return { accent: b.classList.contains('sorted'), title: b.title,
           // Measured, not assumed: the same colour as the icon beside it means "not lit".
           colour: getComputedStyle(b).color,
           plainColour: getComputedStyle(document.getElementById('btn-collapse-all')).color,
           ticked: [...document.querySelectorAll('#sort-menu .sort-item.active')].map(i => i.dataset.sort) }; })()`);
const MANUAL = ['Zeta', 'Alfa', 'dino', 'anna', 'carla', 'bruno'];
const orderFile = () => { try { return JSON.parse(fs.readFileSync(ORDER, 'utf8'))['']; } catch (_) { return null; } };

check('the tree opens in the hand-made order', JSON.stringify(await rows()) === JSON.stringify(MANUAL),
  JSON.stringify(await rows()));
{
  const b = await btnState();
  check('and the tooltip says so', !!b && /manual/i.test(b.title), JSON.stringify(b));
}

await pick('name-asc');
check('Name (A → Z): folders first, then the notes by name',
  JSON.stringify(await rows()) === JSON.stringify(['Alfa', 'Zeta', 'anna', 'bruno', 'carla', 'dino']), JSON.stringify(await rows()));
{
  const b = await btnState();
  check('the tooltip names the sort now in force', !!b && /a → z/i.test(b.title), JSON.stringify(b));
  check('and the menu ticks exactly that one', !!b && JSON.stringify(b.ticked) === JSON.stringify(['name-asc']), JSON.stringify(b));
  // Asked 12/10/2026: choosing a sort must not leave the icon lit.
  check('and the icon stays a plain icon, not a lit one', !!b && b.accent === false && b.colour === b.plainColour,
    JSON.stringify(b));
}

await pick('name-desc');
check('Name (Z → A) reverses the notes, folders still first',
  JSON.stringify(await rows()) === JSON.stringify(['Zeta', 'Alfa', 'dino', 'carla', 'bruno', 'anna']), JSON.stringify(await rows()));

await pick('mod-desc');
check('Modified (newest first) follows the mtimes, not the names',
  JSON.stringify((await rows()).slice(2)) === JSON.stringify(['anna', 'bruno', 'carla', 'dino']), JSON.stringify(await rows()));
await pick('mod-asc');
check('Modified (oldest first) is its mirror',
  JSON.stringify((await rows()).slice(2)) === JSON.stringify(['dino', 'carla', 'bruno', 'anna']), JSON.stringify(await rows()));

await pick('cre-desc');
check('Created (newest first) follows the frontmatter dates, which disagree with both',
  JSON.stringify((await rows()).slice(2)) === JSON.stringify(['dino', 'carla', 'bruno', 'anna']), JSON.stringify(await rows()));
await pick('cre-asc');
check('Created (oldest first) is its mirror',
  JSON.stringify((await rows()).slice(2)) === JSON.stringify(['anna', 'bruno', 'carla', 'dino']), JSON.stringify(await rows()));

// The point of the whole thing: a sort must not rewrite what was arranged by hand.
check('sorting never rewrote the saved order file',
  JSON.stringify(orderFile()) === JSON.stringify(HAND_ORDER), JSON.stringify(orderFile()));

// It is a setting, so it lasts.
await pick('name-asc');
await ev(`location.reload()`); await sleep(3200);
check('the chosen sort survives a reload',
  JSON.stringify(await rows()) === JSON.stringify(['Alfa', 'Zeta', 'anna', 'bruno', 'carla', 'dino']), JSON.stringify(await rows()));
{
  const b = await btnState();
  check('and the tooltip still names it after the reload', !!b && /a → z/i.test(b.title), JSON.stringify(b));
  check('with the icon still unlit', !!b && b.colour === b.plainColour, JSON.stringify(b));
}

await pick('manual');
check('Manual gives the hand-made order back, to the item',
  JSON.stringify(await rows()) === JSON.stringify(MANUAL), JSON.stringify(await rows()));
{
  const b = await btnState();
  check('and the tooltip goes back to Manual', !!b && /manual/i.test(b.title), JSON.stringify(b));
}

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
