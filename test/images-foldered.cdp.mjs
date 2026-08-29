// Images must be filed into attachments/images/ whatever route they take in —
// and the ones already at the root must move, with their links rewritten.
//
// Images were the ONE accepted type with no folder: a photo dropped on the
// sidebar went to images/, the same photo pasted into a note stayed at the
// attachments root. That root was doubling as a hiding place — _collectAttachmentNodes
// lists images only from images/ — so a note's own photo never appeared in the tree,
// while a PDF or a recording pasted into the same note did. One router now answers
// for every route in, and migrateImagesToImagesFolder moves what is already there.
//
// The collision case is the one worth keeping: a root photo and a sidebar-dropped
// one can share a name and be DIFFERENT files. The mover must rename, never
// overwrite, and the note's link must follow the RENAMED leaf.
//
// The encrypted-vault path is not exercised here (it needs a passphrase unlock);
// its file-moving and link-rewriting block is byte-identical to the shipped
// migrateAudioToAudioFolder.
//
//   run: npm run test:images
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-img-migration';
const VAULT = `${HOME}/vault`;
const PORT = 9291;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, pass, detail = '') => { results.push({ n, pass: !!pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : '   [' + detail + ']'}`); };

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

function makePng(w, h, tint) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) { raw[o++] = 0; for (let x = 0; x < w; x++) { raw[o++] = tint; raw[o++] = (y * 255 / h) | 0; raw[o++] = 90; } }
  let table = null;
  const crc32 = (buf) => {
    if (!table) { table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (const b of buf) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Diario`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/images`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/pdf`, { recursive: true });

const fm = '---\ncreated: 2026-08-29 10:00\nmodified: 2026-08-29 10:00\n---\n\n';
// Two root images, one of them colliding by NAME with a different file already in images/.
fs.writeFileSync(`${VAULT}/attachments/vecchia.png`, makePng(300, 200, 200));
fs.writeFileSync(`${VAULT}/attachments/scontro.png`, makePng(300, 200, 60));
fs.writeFileSync(`${VAULT}/attachments/images/scontro.png`, makePng(300, 200, 250));  // DIFFERENT bytes
// A legacy PDF at the root must NOT be touched (the tree still surfaces it from there).
fs.writeFileSync(`${VAULT}/attachments/manuale.pdf`, Buffer.from('%PDF-1.4\n%%EOF\n'));
// Notes linking the root images, in both markdown forms.
fs.writeFileSync(`${VAULT}/notes/Diario/giorno.md`, fm + 'Foto:\n\n![](attachments/vecchia.png)\n\nAltra: [scontro](attachments/scontro.png)\n');
fs.writeFileSync(`${VAULT}/notes/altra.md`, fm + 'Solo testo.\n');

fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1500)); process.exit(1); }
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
await sleep(4000);
for (let i = 0; i < 25; i++) {
  const n = await ev('typeof state !== "undefined" && state.notes ? state.notes.length : 0');
  if (typeof n === 'number' && n > 0) break;
  await sleep(400);
}
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');
await ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c) c.click(); })()');

const ls = (d) => { try { return fs.readdirSync(path.join(VAULT, 'attachments', d)).sort(); } catch (_) { return []; } };

// ── The migration ────────────────────────────────────────────────────────────
const root = ls('');
const imgs = ls('images');
check('no images left at the attachments root', !root.some(f => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f)), root.join(','));
check('the legacy PDF at the root is untouched', root.includes('manuale.pdf'), root.join(','));
check('the root image moved into images/', imgs.includes('vecchia.png'), imgs.join(','));
check('a name collision is renamed, not overwritten', imgs.includes('scontro.png') && imgs.includes('scontro-1.png'), imgs.join(','));
check('and the pre-existing file kept its own bytes',
  fs.readFileSync(`${VAULT}/attachments/images/scontro.png`).equals(makePng(300, 200, 250)), '');
check('while the moved one kept its own',
  fs.readFileSync(`${VAULT}/attachments/images/scontro-1.png`).equals(makePng(300, 200, 60)), '');

const note = fs.readFileSync(`${VAULT}/notes/Diario/giorno.md`, 'utf8');
check('the embed link was rewritten', note.includes('attachments/images/vecchia.png'), note);
check('the inline link was rewritten to the RENAMED leaf', note.includes('attachments/images/scontro-1.png'), note);
check('no stale root link is left behind', !/attachments\/(vecchia|scontro)\.png/.test(note), note);

// ── The router, for every route in ───────────────────────────────────────────
const targets = await ev(`({
  png:  _attachmentTarget('foto.png'),
  jpg:  _attachmentTarget('foto.JPG'),
  svg:  _attachmentTarget('logo.svg'),
  pdf:  _attachmentTarget('doc.pdf'),
  mp4:  _attachmentTarget('clip.mp4'),
  mp3:  _attachmentTarget('rec.mp3'),
  sidebarPng: _sidebarMediaTarget('foto.png'),
  same: _attachmentTarget === _sidebarMediaTarget,
})`);
check('an image pasted into a note goes to images/', targets.png === 'images/foto.png', JSON.stringify(targets));
check('extension case does not matter', targets.jpg === 'images/foto.JPG', JSON.stringify(targets));
check('svg counts as an image', targets.svg === 'images/logo.svg', JSON.stringify(targets));
check('pdf / video / audio keep their folders',
  targets.pdf === 'pdf/doc.pdf' && targets.mp4 === 'videos/clip.mp4' && targets.mp3 === 'audio/rec.mp3', JSON.stringify(targets));
check('the sidebar route gives the same answer', targets.sidebarPng === 'images/foto.png' && targets.same === true, JSON.stringify(targets));

// ── The tree ─────────────────────────────────────────────────────────────────
const tree = await ev(`(async () => {
  await loadTree();
  await new Promise(r => setTimeout(r, 500));
  const out = [];
  const walk = (a, d) => { for (const n of a || []) { out.push({ p: n.path, t: n.type, d }); if (n.children) walk(n.children, d + 1); } };
  walk(state.notes, 0);
  return out;
})()`);
const imgNodes = (tree || []).filter(n => n.t === 'image');
check('the migrated images now appear in the tree', imgNodes.length === 3, JSON.stringify(tree));
check('and one sits beside the note that uses it',
  imgNodes.some(n => n.p === 'attachments/images/vecchia.png' && n.d > 0), JSON.stringify(imgNodes));

const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
