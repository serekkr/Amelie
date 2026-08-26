// A video opened from the SIDEBAR plays, SEEKS, and needs no socket to do it.
//
// Three transports were measured for this. `inkwell://` (a whole-file buffer from our
// own process) left the player frozen: MEDIA_ERR_NETWORK, seek never completed. The
// same protocol with real 206 streaming seeks in isolation but fails in a real note,
// where the renderer is busy colouring a long code block and the load is aborted. And
// `net.fetch(file://)` relayed through protocol.handle loads yet cannot seek at all —
// currentTime stays at 0. A plain `file://` URL, which is what Obsidian hands its
// player, does everything: it seeks even with the main thread deliberately blocked,
// and Chromium opens the file itself so nothing listens on a port.
//
// A vault encrypted at rest has no readable path, and only there does the localhost
// media server still come into play.
//
//   run: npm run test:mediatab      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO=path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); const HOME='/tmp/amelie-mediatab'; const VAULT=`${HOME}/vault`; const PORT=9351;
const ELECTRON=`${REPO}/node_modules/electron/dist/electron`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
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

let child=null; process.on('exit',()=>{try{if(child)process.kill(-child.pid,'SIGKILL');}catch(_){}});
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},85000);
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
fs.mkdirSync(`${VAULT}/notes`,{recursive:true});
fs.mkdirSync(`${VAULT}/attachments/videos`,{recursive:true});
// The user's real 25 MB video: a big file is what makes ranged requests matter.
// A file big enough that the media pipeline must issue ranged requests: 40 s of
// video is plenty, and generating it keeps the test self-contained.
execSync(`ffmpeg -y -v error -f lavfi -i color=c=black:s=320x240:d=40 -c:v libx264 -pix_fmt yuv420p -g 30 ${VAULT}/attachments/videos/clip.mp4`);
fs.writeFileSync(`${VAULT}/notes/n.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nA note.\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`,JSON.stringify({vaultPath:VAULT,encryption:{enabled:false}}));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`,JSON.stringify({autoSaveSeconds:30,sync:{enabled:false}}));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore','pipe','pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore','pipe','pipe'] });
let err=''; child.stderr.on('data',d=>{err+=d;});
let target=null;
for(let i=0;i<40&&!target;i++){await sleep(500);try{target=(await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t=>t.type==='page'&&/index\.html/.test(t.url));}catch(_){}}
if(!target){console.error('no app\n'+err.slice(-1200));process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const ev=x=>new Promise(res=>{const my=++id;pending.set(my,m=>res(m.result?.result?.value));ws.send(JSON.stringify({id:my,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));setTimeout(()=>{if(pending.delete(my))res('<<timeout>>');},25000);});
await sleep(1200);
const results=[]; const check=(n,p,d)=>{results.push(p);console.log(`${p?'ok  ':'FAIL'}  ${n}${p?'':`\n        ${d}`}`);};

// Click the video in the sidebar, the way a user does.
await ev(`(async () => { const n = (state.notes||[]).find(x => x.type === 'video'); await openNote(n); })()`);
await sleep(3000);
const src = await ev(`(document.getElementById('video-view-content')||{}).src || '(no player)'`);
check('the player is handed the file itself (file://), no server', /^file:\/\/\//.test(src), src);
const st = await ev(`(() => { const v = document.getElementById('video-view-content');
  return v ? JSON.stringify({ readyState: v.readyState, error: v.error && v.error.code, duration: Math.round(v.duration || 0) }) : 'none'; })()`);
console.log('  player state:', st);
check('it has metadata (not stuck at readyState 0)', /"readyState":[1-4]/.test(st), st);
check('no media error', /"error":null/.test(st), st);
// The thing inkwell:// could not do: seek.
// The position must LAND, not merely fire an event: a 'seeked' can arrive for the
// initial seek to 0 while the real one never completes.
const seek = await ev(`(async () => {
  const v = document.getElementById('video-view-content'); if (!v) return 'no player';
  v.currentTime = 30;
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (v.error) return 'ERROR ' + v.error.code;
    if (v.currentTime > 25 && !v.seeking) return 'seeked to ' + Math.round(v.currentTime) + 's';
  }
  return 'TIMEOUT — seek never landed (stuck at ' + Math.round(v.currentTime) + 's)';
})()`);
check('and it can SEEK — a real ranged request', /^seeked to (29|30|31)s$/.test(seek), seek);
// Nothing may listen — not before, not after a video has played and seeked.
const listeners = (() => {
  const tree = [String(child.pid), ...execSync(`pgrep -P ${child.pid} || true`).toString().split('\n').filter(Boolean)];
  return execSync('ss -tlnp 2>/dev/null || true').toString().split('\n')
    .filter(l => l.includes('127.0.0.1') && tree.some(p => l.includes(`pid=${p},`)) && !l.includes(`:${PORT} `))
    .map(l => (l.match(/127\.0\.0\.1:(\d+)/) || [])[1]).filter(Boolean);
})();
check('and no port was opened for any of it', listeners.length === 0, 'ports: ' + listeners.join(', '));

console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
