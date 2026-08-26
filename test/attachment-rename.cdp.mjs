// Renaming an attachment keeps its extension and follows every note that links it.
//
// Two faults met here. The sanitiser ran over the WHOLE new name, so the dot became an
// underscore and the extension was then appended again: the rename box is pre-filled
// with the full name, so editing `clip.mp4` into `gain-summit.mp4` stored
// `gain-summit_mp4.mp4`. Every rename made through the UI mangled the name that way.
// And the point of renaming at all is that one stored copy serves many notes, so the
// link rewrite must reach all of them — including notes in other folders and the legacy
// `inkwell://` URL form.
//
//   run: npm run test:rename      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = process.cwd(); const HOME='/tmp/amelie-rename'; const VAULT=`${HOME}/vault`; const PORT=9341;
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
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},80000);
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
fs.mkdirSync(`${VAULT}/notes/sub`,{recursive:true});
fs.mkdirSync(`${VAULT}/attachments/videos`,{recursive:true});
execSync(`ffmpeg -y -v error -f lavfi -i color=c=black:s=32x32:d=1 -c:v libx264 -pix_fmt yuv420p ${VAULT}/attachments/videos/clip.mp4`);
const fm='---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\n';
// THE SAME file referenced from TWO notes, in two different folders and two link forms
fs.writeFileSync(`${VAULT}/notes/one.md`, fm+'First note.\n\n![🎬](attachments/videos/clip.mp4)\n\nEnd.\n');
fs.writeFileSync(`${VAULT}/notes/sub/two.md`, fm+'Second note, legacy URL form.\n\n![🎬](inkwell://attachments/videos/clip.mp4)\n');
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
const ev=x=>new Promise(res=>{const my=++id;pending.set(my,m=>res(m.result?.result?.value));ws.send(JSON.stringify({id:my,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));setTimeout(()=>{if(pending.delete(my))res('<<timeout>>');},20000);});
await sleep(1200);
const results=[]; const check=(n,p,d)=>{results.push(p);console.log(`${p?'ok  ':'FAIL'}  ${n}${p?'':`\n        ${d}`}`);};

console.log('rename ->', await ev(`window.inkwell.renameAttachment('videos/clip.mp4', 'gain-summit.mp4').then(r=>r, e=>'ERR '+e.message)`));
await sleep(1200);
const disk = execSync(`find ${VAULT}/attachments -type f -printf '%f\\n'`).toString().trim();
check('the file on disk is renamed, still in videos/', disk === 'gain-summit.mp4', disk);
const one = fs.readFileSync(`${VAULT}/notes/one.md`,'utf8');
const two = fs.readFileSync(`${VAULT}/notes/sub/two.md`,'utf8');
check('note one now points at the new name', one.includes('attachments/videos/gain-summit.mp4') && !one.includes('clip.mp4'), one.split('\n').filter(l=>l.includes('attachments')).join(' | '));
check('note two (other folder, inkwell:// form) too', two.includes('attachments/videos/gain-summit.mp4') && !two.includes('clip.mp4'), two.split('\n').filter(l=>l.includes('attachments')).join(' | '));
check('one copy on disk serves both notes', execSync(`find ${VAULT}/attachments -type f | wc -l`).toString().trim() === '1', 'files: '+disk);
console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
