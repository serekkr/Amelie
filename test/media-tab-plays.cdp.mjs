// A video opened from the SIDEBAR plays and can be seeked.
//
// The player in a media tab loaded over `inkwell://`, the custom protocol that answers
// a whole-file buffer and cannot serve real ranged requests — which is the very reason
// the localhost media server exists. So the same file played fine embedded in a note
// and sat there frozen when opened from the sidebar: MEDIA_ERR_NETWORK, and a seek that
// never completed. Measured on the old path: readyState 4, error 2, seek timed out.
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
check('the sidebar player loads over the media server, not inkwell://',
  /^http:\/\/127\.0\.0\.1:\d+\//.test(src), src);
const st = await ev(`(() => { const v = document.getElementById('video-view-content');
  return v ? JSON.stringify({ readyState: v.readyState, error: v.error && v.error.code, duration: Math.round(v.duration || 0) }) : 'none'; })()`);
console.log('  player state:', st);
check('it has metadata (not stuck at readyState 0)', /"readyState":[1-4]/.test(st), st);
check('no media error', /"error":null/.test(st), st);
// The thing inkwell:// could not do: seek.
const seek = await ev(`(async () => {
  const v = document.getElementById('video-view-content'); if (!v) return 'no player';
  return await new Promise(res => {
    const t = setTimeout(() => res('TIMEOUT — seek never completed (this is the frozen case)'), 8000);
    v.addEventListener('seeked', () => { clearTimeout(t); res('seeked to ' + Math.round(v.currentTime) + 's'); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(t); res('ERROR ' + (v.error && v.error.code)); }, { once: true });
    v.currentTime = 30;
  });
})()`);
check('and it can SEEK — a real ranged request', /^seeked to (29|30|31)s$/.test(seek), seek);
console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
