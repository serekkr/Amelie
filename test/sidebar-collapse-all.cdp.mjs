// The sidebar's close/open-all button — the one Obsidian's file explorer has.
//
// One button doing two opposite things, which is where this kind of control usually
// goes wrong: the icon and the tooltip have to name what the NEXT click does, not
// what the tree looks like now. Checked here, against the running app, on a vault
// with a folder inside a folder:
//   · the button is in the sidebar strip, with the other five,
//   · on a fresh profile (nothing open) it offers to OPEN, and one click opens every
//     folder — the nested one included, with its note really in the DOM (folders
//     render their children lazily, so an "open" folder that was never clicked used
//     to be an empty box),
//   · the icon and the tooltip then flip to "close all", and a second click closes
//     everything,
//   · opening a single folder by hand flips them back on its own,
//   · and what the button did survives a reload, like any other open folder.
//
//   run: npm run test:collapseall     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-collapseall'; const VAULT = `${HOME}/vault`; const PORT = 9400;
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
// Three folders, one of them nested, plus a note at the root.
fs.mkdirSync(`${VAULT}/notes/Alpha/Beta`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Gamma`, { recursive: true });
const note = (p, t) => fs.writeFileSync(p, `---\ncreated: 2026-09-01 10:00\n---\n\n${t}\n`);
note(`${VAULT}/notes/radice.md`, 'radice');
note(`${VAULT}/notes/Alpha/uno.md`, 'uno');
note(`${VAULT}/notes/Alpha/Beta/due.md`, 'due');
note(`${VAULT}/notes/Gamma/tre.md`, 'tre');
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
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 30000); });
await sleep(2500);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

// What the tree and the button look like right now.
const look = () => ev(`(() => {
  const btn = document.getElementById('btn-collapse-all');
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const rows = [...document.querySelectorAll('#file-tree .tree-folder')].map(r => ({ name: r.dataset.folder, open: r.classList.contains('open') }));
  return {
    inStrip: btn ? btn.parentElement.id : null,
    siblings: document.querySelectorAll('#sidebar-views .sidebar-view-btn').length,
    title: btn ? btn.title : null,
    icon: btn ? (vis(btn.querySelector('.chev-expand-all')) ? 'expand' : vis(btn.querySelector('.chev-collapse-all')) ? 'collapse' : 'none') : null,
    folders: rows,
    open: rows.filter(r => r.open).length,
    // The nested note only exists in the DOM once its folder has really been built.
    nestedNote: !!document.querySelector('#file-tree .tree-item[data-path$="Alpha/Beta/due.md"], #file-tree [data-path$="Alpha/Beta/due.md"]'),
    saved: JSON.parse(localStorage.getItem('amelie.openFolders') || '[]').length,
  };
})()`);
const click = async () => { await ev(`document.getElementById('btn-collapse-all').click()`); await sleep(600); };

{
  const s = await look();
  check('the button is in the sidebar strip with the others',
    !!s && s.inStrip === 'sidebar-views' && s.siblings === 6, JSON.stringify(s));
  check('a fresh profile has nothing open, so the button offers to OPEN',
    !!s && s.open === 0 && s.icon === 'expand' && /open|apri|expand/i.test(s.title || ''),
    JSON.stringify(s));
  check('the tree really has the three folders', !!s && s.folders.length >= 2, JSON.stringify(s?.folders));
}

await click();
{
  const s = await look();
  check('one click opens every folder, nested one included',
    !!s && s.folders.length === 3 && s.folders.every(f => f.open), JSON.stringify(s?.folders));
  check('and the nested folder actually built its contents (lazy children)',
    !!s && s.nestedNote === true, JSON.stringify(s));
  check('now the button offers to CLOSE',
    !!s && s.icon === 'collapse' && /clos|chiud|collapse/i.test(s.title || ''), JSON.stringify(s));
  check('and the open state was saved', !!s && s.saved === 3, JSON.stringify(s));
}

await click();
{
  const s = await look();
  check('a second click closes everything', !!s && s.open === 0 && s.saved === 0, JSON.stringify(s));
  check('and the button goes back to offering OPEN', !!s && s.icon === 'expand', JSON.stringify(s));
}

// Opening ONE folder by hand has to flip the button too — it is not a mode of its own.
await ev(`document.querySelector('#file-tree .tree-folder').click()`); await sleep(500);
{
  const s = await look();
  check('opening a single folder by hand flips the button to CLOSE',
    !!s && s.open === 1 && s.icon === 'collapse', JSON.stringify(s));
}
await click();
{
  const s = await look();
  check('and from there the button still closes the tree', !!s && s.open === 0, JSON.stringify(s));
}

// Reload: what the button did is an open-folder state like any other, so it lasts.
await click(); await sleep(400);
await ev(`location.reload()`); await sleep(3000);
{
  const s = await look();
  check('after a reload the tree is still open, and the button still says CLOSE',
    !!s && s.folders.length === 3 && s.folders.every(f => f.open) && s.icon === 'collapse',
    JSON.stringify(s));
}

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
process.exit(failed ? 1 : 0);
