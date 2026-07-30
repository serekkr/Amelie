// Clicking a photo, recording or video in the sidebar opens the NOTE that links it.
//
// The sidebar lists media as files of their own, which is what makes them searchable —
// but such a file almost always belongs to a note, so finding one means "where do I use
// this?". The answer must be that note, with the link on screen. Only a file no note
// links to opens on its own in the player/viewer. PDFs are excluded by design: a PDF is
// a document in its own right, not note media.
//
//   run: npm run test:media     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
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

child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
check('clicking a linked recording opens its note, not a player',
  r.tabType === 'note' && r.tabPath === 'diary/interview.md' && r.player === 'none', JSON.stringify(r));
check('and the caret lands on the link', r.atCaret === 'attachments/', JSON.stringify(r));

r = await click('attachments/images/beach.png', 'edit');
check('clicking a photo used twice opens the most recently edited note',
  r.tabType === 'note' && r.tabPath === 'trip.md' && r.viewer === 'none', JSON.stringify(r));

r = await click('attachments/videos/orphan.mp4', 'edit');
check('a video no note links still opens in the player',
  r.tabType === 'video' && r.tabPath === 'attachments/videos/orphan.mp4' && r.player === 'flex', JSON.stringify(r));

r = await click('attachments/audio/talk.mp3', 'view');
check('the same holds in reading view, where the note plays it inline',
  r.tabType === 'note' && r.tabPath === 'diary/interview.md' && r.player === 'none', JSON.stringify(r));

const failed = results.filter((x) => !x.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
