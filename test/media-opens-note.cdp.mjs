// Clicking a photo, recording or video in the sidebar opens THE FILE.
//
// It used to open the note that links it instead: the sidebar lists media as files of
// their own, and the reasoning was that finding one means "where do I use this?". In
// practice a video sitting in the root is a thing you want to watch — and when its note
// was already the active tab and the media already in view, the click did visibly
// nothing at all (measured: same tab, same mode, scrollTop 0 before and after).
//
// "Where do I use this?" moved to the right-click menu, which can also say when several
// notes link the same copy — something the click could not do, it just took the first
// owner in silence. The IPC behind it (attachment:usedBy) is still asserted here,
// because the menu entry is built on it.
//
//   run: npm run test:media     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

// xvfb-run when it is installed, the current display otherwise — the test needs a
// screen, not specifically a virtual one.
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display (dnf install xorg-x11-server-Xvfb)');
    process.exit(0);
  }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-media-note-test';
const VAULT = `${HOME}/vault`;
const PORT = 9263;

const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
const cleanup = () => {
  try { if (child) { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);

cleanup();
await sleep(300);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/diary`, { recursive: true });
for (const d of ['audio', 'images', 'videos']) fs.mkdirSync(`${VAULT}/attachments/${d}`, { recursive: true });
const fm = '---\ncreated: 2026-07-30 10:00\nmodified: 2026-07-30 10:00\n---\n\n';
fs.writeFileSync(`${VAULT}/notes/diary/interview.md`, fm + 'Before the link.\n\n[Recording](attachments/audio/talk.mp3)\n\nAfter.\n');
fs.writeFileSync(`${VAULT}/notes/album.md`, fm + 'The same photo:\n\n![](attachments/images/beach.png)\n');
fs.writeFileSync(`${VAULT}/notes/trip.md`, fm + 'Photo here:\n\n![](attachments/images/beach.png)\n');
fs.writeFileSync(`${VAULT}/notes/plain.md`, fm + 'No attachments at all.\n');
// trip.md is the most recently touched of the two that use the photo — it must win.
const now = Date.now();
fs.utimesSync(`${VAULT}/notes/album.md`, new Date(now - 3600e3), new Date(now - 3600e3));
fs.utimesSync(`${VAULT}/notes/trip.md`, new Date(now), new Date(now));
fs.writeFileSync(`${VAULT}/attachments/audio/talk.mp3`, Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0])]));
fs.writeFileSync(`${VAULT}/attachments/images/beach.png`, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
fs.writeFileSync(`${VAULT}/attachments/videos/orphan.mp4`, Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from('ftypisom')]));
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs,
      { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 25000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expr, ms = 25000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(3500);
for (let i = 0; i < 25; i++) {
  const n = await ev('typeof state !== "undefined" && state.notes ? state.notes.length : 0');
  if (typeof n === 'number' && n > 0) break;
  await sleep(400);
}
// The blank unnamed tab a fresh profile opens is what triggers the "note name?" prompt.
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
await ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c) c.click(); })()');

// 1) the lookup itself
const owners = await ev(`(async () => ({
  mp3:    await window.inkwell.attachmentUsedBy('audio/talk.mp3'),
  png:    await window.inkwell.attachmentUsedBy('images/beach.png'),
  orphan: await window.inkwell.attachmentUsedBy('videos/orphan.mp4'),
}))()`);
check('a linked recording reports the note that links it',
  JSON.stringify(owners.mp3) === JSON.stringify(['diary/interview.md']), JSON.stringify(owners));
check('a photo used twice reports both notes, most recent first',
  JSON.stringify(owners.png) === JSON.stringify(['trip.md', 'album.md']), JSON.stringify(owners));
check('a file no note links reports nothing', Array.isArray(owners.orphan) && owners.orphan.length === 0, JSON.stringify(owners));

// 2) what a click does
const click = (file, mode) => ev(`(async () => {
  setViewMode(${JSON.stringify(mode)});
  const walk = (a) => { for (const n of a || []) { if (n.path === ${JSON.stringify(file)}) return n; const c = n.children && walk(n.children); if (c) return c; } return null; };
  const node = walk(state.notes);
  if (!node) return 'NOT-FOUND';
  await openNote(node);
  await new Promise(r => setTimeout(r, 900));
  const t = tabs[activeTabIdx];
  const sel = (typeof _cmHandle !== 'undefined' && _cmHandle) ? _cmHandle.getSelection() : null;
  const caret = sel ? sel.from : null;
  return {
    tabType: t && t.type ? t.type : 'note', tabPath: t && t.path, caret,
    atCaret: (t && !t.type && caret != null) ? (editor.value || '').slice(caret, caret + 12) : '',
    player: getComputedStyle(document.getElementById('media-view-overlay')).display,
    viewer: getComputedStyle(document.getElementById('img-view-overlay')).display,
  };
})()`);

let r = await click('attachments/audio/talk.mp3', 'edit');
check('clicking a LINKED recording opens the player, not its note',
  r.tabType === 'audio' && r.tabPath === 'attachments/audio/talk.mp3' && r.player === 'flex', JSON.stringify(r));

r = await click('attachments/images/beach.png', 'edit');
check('clicking a photo used by two notes opens the photo',
  r.tabType === 'image' && r.tabPath === 'attachments/images/beach.png' && r.viewer === 'flex', JSON.stringify(r));

r = await click('attachments/videos/orphan.mp4', 'edit');
check('a video no note links opens in the player too — no special case left',
  r.tabType === 'video' && r.tabPath === 'attachments/videos/orphan.mp4' && r.player === 'flex', JSON.stringify(r));

r = await click('attachments/audio/talk.mp3', 'view');
check('and reading view makes no difference',
  r.tabType === 'audio' && r.player === 'flex', JSON.stringify(r));

// The menu entry that took over the old job.
const menu = await ev(`(async () => {
  const walk = (a) => { for (const n of a || []) { if (n.path === 'attachments/audio/talk.mp3') return n; const c = n.children && walk(n.children); if (c) return c; } return null; };
  const node = walk(state.notes);
  showContextMenu(new MouseEvent('contextmenu'), node);
  const shown = getComputedStyle(document.getElementById('ctx-used-by')).display !== 'none';
  document.getElementById('ctx-used-by').click();
  await new Promise(r2 => setTimeout(r2, 1200));
  const t = tabs[activeTabIdx];
  return { shown, tabPath: t && t.path, tabType: t && t.type ? t.type : 'note' };
})()`);
check('"go to the note that uses it" is offered for media', menu.shown === true, JSON.stringify(menu));
check('and it lands on the note', menu.tabType === 'note' && menu.tabPath === 'diary/interview.md', JSON.stringify(menu));

const pdfMenu = await ev(`(() => {
  const walk = (a) => { for (const n of a || []) { if (n.type === 'pdf') return n; const c = n.children && walk(n.children); if (c) return c; } return null; };
  const node = walk(state.notes);
  if (!node) return 'no pdf node';
  showContextMenu(new MouseEvent('contextmenu'), node);
  return getComputedStyle(document.getElementById('ctx-used-by')).display;
})()`);
check('but not for a PDF, which is a document of its own', pdfMenu === 'none' || pdfMenu === 'no pdf node', String(pdfMenu));

const failed = results.filter((x) => !x.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
