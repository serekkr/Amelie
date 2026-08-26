// A video EMBEDDED IN A NOTE plays and seeks — including a note heavy with code.
//
// This is the case that broke twice while the transport was being changed, and neither
// break showed up in a simple note:
//   • our own protocol streaming the file seeks fine on its own, and fails here — the
//     renderer is busy colouring a 300-line code block and the load is aborted
//     (MEDIA_ERR_NETWORK, then the "not playable" card replaces the player);
//   • `net.fetch(file://)` relayed through protocol.handle loads and then cannot seek
//     at all, with currentTime stuck at 0.
// A plain `file://` URL — what Chromium can open by itself — does both, so this test
// pins the note case down next to the sidebar one, and asserts no port is opened.
//
//   run: npm run test:notemedia      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-notemedia'; const VAULT = `${HOME}/vault`; const PORT = 9361;
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
try { execSync('command -v ffmpeg', { stdio: 'ignore' }); }
catch { console.log('SKIP: ffmpeg not installed (needed to make the test video)'); process.exit(0); }

const results = [];
const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };
let child = null;
process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 110000);

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/videos`, { recursive: true });
// 40 s of video: long enough that a seek must fetch bytes it has not got yet.
execSync(`ffmpeg -y -v error -f lavfi -i color=c=black:s=320x240:d=40 -c:v libx264 -pix_fmt yuv420p -g 30 ${VAULT}/attachments/videos/clip.mp4`);
// An attachment that is ENCRYPTED at rest: same magic header the app writes, so the
// path handed to a player must be refused and playback must fall back to the server.
fs.writeFileSync(`${VAULT}/attachments/videos/secret.mp4.enc`,
  Buffer.concat([Buffer.from('AMELIEG1'), Buffer.alloc(256, 9)]));
const fm = '---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\n';
// The shape that broke it: a video embed followed by a long fenced code block.
const code = Array.from({ length: 300 }, (_, i) => `echo "line ${i + 1} of a long pasted script"`).join('\n');
fs.writeFileSync(`${VAULT}/notes/withcode.md`,
  fm + '# Heavy note\n\n![🎬](attachments/videos/clip.mp4)\n\n```bash\n' + code + '\n```\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore','pipe','pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore','pipe','pipe'] });
let appErr = ''; child.stderr.on('data', d => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1500)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => {
  const my = ++id; pending.set(my, m => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => { if (pending.delete(my)) res('<<timeout>>'); }, 25000);
});
await sleep(1200);

const r = await ev(`(async () => {
  const n = findNote(state.notes, 'withcode.md'); if (!n) return { err: 'note missing' };
  await openNote(n); await new Promise(r2 => setTimeout(r2, 600));
  setViewMode('view'); await new Promise(r2 => setTimeout(r2, 4500));
  const v = document.querySelector('#preview-content video');
  if (!v) return { err: 'no player', fallbackCard: !!document.querySelector('#preview-content .media-fallback') };
  const src = v.getAttribute('src') || '';
  // The position must LAND: a 'seeked' event can fire for the initial seek to 0 while
  // the real one never completes.
  v.currentTime = 30;
  let seek = null;
  for (let i = 0; i < 80; i++) {
    await new Promise(r2 => setTimeout(r2, 100));
    if (v.error) { seek = 'error ' + v.error.code; break; }
    if (v.currentTime > 25 && !v.seeking) { seek = 'landed@' + Math.round(v.currentTime); break; }
  }
  return { src, readyState: v.readyState, error: v.error && v.error.code, dur: Math.round(v.duration || 0), seek: seek || ('stuck@' + Math.round(v.currentTime)) };
})()`);
if (r?.err) { check('a player is built for the embed', false, JSON.stringify(r)); }
else {
  check('the embed is handed the file itself (file://)', /^file:\/\/\//.test(r.src), r.src);
  check('it has metadata', r.readyState >= 1 && r.dur === 40, JSON.stringify(r));
  check('no media error', r.error == null, JSON.stringify(r));
  check('and the seek LANDS, in a note heavy with code', /^landed@(29|30|31)$/.test(r.seek), JSON.stringify(r));
}

// Encrypted at rest → no path may be handed out, and the media server takes over.
check('an encrypted attachment is not handed out as a path',
  (await ev(`window.inkwell.attachmentLocalUrl('videos/secret.mp4').then(v => String(v))`)) === 'null',
  'attachmentLocalUrl did not return null for ciphertext');
check('a plaintext one is', /^file:\/\/\//.test(await ev(`window.inkwell.attachmentLocalUrl('videos/clip.mp4').then(v => String(v))`) || ''), 'no file:// url');

const ports = (() => {
  const tree = [String(child.pid), ...execSync(`pgrep -P ${child.pid} || true`).toString().split('\n').filter(Boolean)];
  return execSync('ss -tlnp 2>/dev/null || true').toString().split('\n')
    .filter(l => l.includes('127.0.0.1') && tree.some(p => l.includes(`pid=${p},`)) && !l.includes(`:${PORT} `))
    .map(l => (l.match(/127\.0\.0\.1:(\d+)/) || [])[1]).filter(Boolean);
})();
check('and no port was opened to play it', ports.length === 0, 'ports: ' + ports.join(', '));

console.log(`\n${results.every(Boolean) ? `all ${results.length}` : `${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
