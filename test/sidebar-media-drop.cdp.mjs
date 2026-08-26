// Dropping a photo or a video on the SIDEBAR stores it and shows it in the tree.
//
// The window-level drop handler owned only folders and .md/.txt/.pdf/.draw: "images,
// audio, video, scripts and everything else are DISCARDED". A video dropped on the
// sidebar therefore fell through to the editor's handler — which is attached to the
// text, never fires for the sidebar — so nothing was stored, nothing appeared, and
// nothing was said. Dropping the same file twice was silent for a second reason: the
// importer reuses an identical copy, so the tree does not grow.
//
// Drives the real app: a real File in a real DragEvent, dispatched on #file-tree.
//
//   run: npm run test:drop      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-sbdrop'; const VAULT = `${HOME}/vault`; const PORT = 9331;
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
for (const bin of ['ffmpeg']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (needed to make the test video)`); process.exit(0); }
}
// A real, tiny mp4 — the importer runs ffmpeg faststart on it, so it must be genuine.
const CLIP = '/tmp/amelie-test-tiny.mp4';
execSync(`ffmpeg -y -v error -f lavfi -i color=c=black:s=64x64:d=1 -c:v libx264 -pix_fmt yuv420p ${CLIP}`);
let child = null;
process.on('exit', () => { try { if (child) process.kill(-child.pid,'SIGKILL'); } catch(_){} });
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},85000);
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
fs.mkdirSync(`${VAULT}/notes`,{recursive:true});
fs.writeFileSync(`${VAULT}/notes/plain.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nA note.\n');
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
const ev=x=>new Promise(res=>{const my=++id;pending.set(my,m=>res(m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails?.exception?.description||m.result)));ws.send(JSON.stringify({id:my,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));setTimeout(()=>{if(pending.delete(my))res('<<timeout>>');},25000);});
await sleep(1200);

const b64 = fs.readFileSync(CLIP).toString('base64');
const results=[]; const check=(n,p,d)=>{results.push(p);console.log(`${p?'ok  ':'FAIL'}  ${n}${p?'':`\n        ${d}`}`);};

// A real 'drop' event with a real File, dispatched on the SIDEBAR (never the editor).
const dropped = await ev(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'dropped-clip.mp4', { type: 'video/mp4' });
  const dt = new DataTransfer(); dt.items.add(file);
  const tree = document.getElementById('file-tree');
  const ev2 = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
  tree.dispatchEvent(ev2);
  await new Promise(r => setTimeout(r, 3000));
  return 'dispatched';
})()`);
console.log('  (drop', dropped + ')');
await sleep(1500);
let onDisk=''; try { onDisk = execSync(`find ${VAULT}/attachments -type f -printf '%p\\n'`).toString().trim(); } catch { onDisk='(none)'; }
check('the video is stored under attachments/videos/', /videos\/dropped-clip\.mp4$/m.test(onDisk), onDisk || '(nothing on disk)');
const tree = await ev(`JSON.stringify((state.notes||[]).map(n => n.type + ':' + n.name))`);
check('it is in the tree as a video node', /video:dropped-clip\.mp4/.test(tree), tree);
const dom = await ev(`[...document.querySelectorAll('#file-tree .tree-name')].map(e=>e.textContent).join(' | ')`);
check('and the sidebar renders it', /dropped-clip\.mp4/.test(dom), dom);
const toast = await ev(`(document.getElementById('amelie-toast')||{}).textContent || '(no toast)'`);
console.log('  toast seen:', toast);

// Dropping the SAME file again must say so instead of staying silent.
await ev(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bin], 'dropped-clip.mp4', { type: 'video/mp4' }));
  document.getElementById('file-tree').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise(r => setTimeout(r, 2500));
})()`);
const toast2 = await ev(`(document.getElementById('amelie-toast')||{}).textContent || '(none)'`);
check('a duplicate drop is reported, not silent', /already|già|deja|schon|ya |już/i.test(toast2), 'toast: ' + toast2);
console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
