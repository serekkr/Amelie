// The localhost media server listens only when a note actually needs it.
//
// Audio/video playback needs real HTTP Range support, so media is served over
// 127.0.0.1 (see the media server in main.js). That socket used to open at boot,
// which meant a vault with no attachments — most vaults, most days — kept a port
// open to serve nothing. It is started on demand now, and this test pins that
// down: no socket while nothing has asked, one socket the moment something does,
// the same one for every caller after, and the token still gating every request.
//
//   run: npm run test:media-lazy      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-media-lazy-test';
const VAULT = `${HOME}/vault`;
const PORT = 9271;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;

let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log('SKIP: no xvfb-run and no display (dnf install xorg-x11-server-Xvfb)');
    process.exit(0);
  }
}

const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
const cleanup = () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} };
process.on('exit', cleanup);

// A vault with an attachment on disk but NO note that embeds it: nothing on screen
// asks for a media URL, so nothing may open a socket.
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(`${VAULT}/attachments/audio`, { recursive: true });
const fm = '---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\n';
fs.writeFileSync(`${VAULT}/notes/plain.md`, fm + 'No media in this note at all.\n');
fs.writeFileSync(`${VAULT}/attachments/audio/talk.mp3`, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(120, 7)]));
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const args = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...args, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, args,
      { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1500)); process.exit(1); }

// Every loopback listener owned by this app's process tree, minus the CDP port.
const loopbackPorts = () => {
  const tree = [String(child.pid), ...execSync(`pgrep -P ${child.pid} || true`).toString().split('\n').filter(Boolean)];
  return execSync('ss -tlnp 2>/dev/null || true').toString().split('\n')
    .filter((l) => l.includes('127.0.0.1') && tree.some((p) => l.includes(`pid=${p},`)) && !l.includes(`:${PORT} `))
    .map((l) => (l.match(/127\.0\.0\.1:(\d+)/) || [])[1]).filter(Boolean);
};

await sleep(1500);
const boot = loopbackPorts();
check('nothing listens while no note needs media', boot.length === 0, boot.join(','));

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const evalJs = (expression) => new Promise((res) => {
  const my = ++id; pending.set(my, (m) => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  setTimeout(() => { if (pending.delete(my)) res(undefined); }, 15000);
});

// Exactly what a player does when a note embeds an <audio>/<video>.
const base = await evalJs('window.inkwell.mediaBaseUrl()');
check('the URL is loopback plus a per-launch token', /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{24}\/$/.test(base || ''), String(base));

await sleep(500);
const asked = loopbackPorts();
check('one socket appears, and only then', asked.length === 1, `boot=[${boot}] asked=[${asked}]`);
check('on the port the URL hands out', asked[0] === (base || '').match(/:(\d+)\//)?.[1], `${asked[0]} vs ${base}`);

const again = await evalJs('window.inkwell.mediaBaseUrl()');
check('a second caller reuses that server', again === base, `${again} vs ${base}`);
check('and does not open another', loopbackPorts().length === 1, loopbackPorts().join(','));

// Probed from outside the renderer: its own origin is not allowed to fetch http://.
const curl = (u) => execSync(`curl -s -o /dev/null -w '%{http_code}' ${JSON.stringify(u)}`).toString();
check('the token URL serves the attachment', curl(`${base}audio/talk.mp3`) === '200', curl(`${base}audio/talk.mp3`));
check('a wrong token is refused', curl(`http://127.0.0.1:${asked[0]}/deadbeefdeadbeefdeadbeef/audio/talk.mp3`) === '403', 'not 403');
check('so is a request with no token', curl(`http://127.0.0.1:${asked[0]}/audio/talk.mp3`) === '403', 'not 403');

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
