// Dropping a media file ONTO a folder in the sidebar lands it INSIDE that folder —
// not at the vault root — and the whole folder is framed while you drag over it.
//
// serekkr, 30/10/2026: "se faccio drag di un file in amelie deve metterlo nella
// cartella dove lo trascino … adesso mette tutti i file in root". Media used to be
// filed only by TYPE (attachments/videos|images|pdf/…) and surfaced at the root, so
// a drop aimed at a folder ignored the folder. Now the dropped-on folder is recorded
// as the loose attachment's home (treeOrder → _attachmentHomes in main), and the drag
// highlights the folder's whole box (.ext-drop-into on the wrapper), Obsidian-style.
//
// Drives the real app: a real File in real DragEvents dispatched on the folder row.
//
//   run: npm run test:dropfolder      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-dropfolder'; const VAULT = `${HOME}/vault`; const PORT = 9337;
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
const CLIP = '/tmp/amelie-dropfolder-tiny.mp4';
execSync(`ffmpeg -y -v error -f lavfi -i color=c=black:s=64x64:d=1 -c:v libx264 -pix_fmt yuv420p ${CLIP}`);
let child = null;
process.on('exit', () => { try { if (child) process.kill(-child.pid,'SIGKILL'); } catch(_){} });
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},85000);
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
// Notes live under <vault>/notes. A folder "Progetti" with a note inside, so it
// renders as a real folder row, plus a note at the root.
fs.mkdirSync(`${VAULT}/notes/Progetti`,{recursive:true});
fs.writeFileSync(`${VAULT}/notes/Progetti/piano.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nPlan.\n');
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

// The folder row must be present before we can drag over it — wait for it to render.
let haveRow = false;
for (let i = 0; i < 24 && !haveRow; i++) {
  haveRow = (await ev(`!!document.querySelector('.tree-folder[data-folder="Progetti"]')`)) === true;
  if (!haveRow) await sleep(500);
}
if (!haveRow) {
  console.log('  DIAG state.notes:', await ev(`JSON.stringify((state.notes||[]).map(n=>n.type+':'+n.name))`));
  console.log('  DIAG tree names:', await ev(`[...document.querySelectorAll('#file-tree .tree-name')].map(e=>e.textContent).join(' | ')`));
  console.log('  DIAG overlays:', await ev(`[...document.querySelectorAll('body > *')].filter(e=>{const s=getComputedStyle(e);return s.position==='fixed'&&s.display!=='none'&&e.offsetHeight>200;}).map(e=>e.id||e.className).join(', ')`));
  console.log('  DIAG file-tree html len:', await ev(`(document.getElementById('file-tree')||{}).innerHTML?.length || 0`));
}
check('the Progetti folder row is rendered', haveRow === true, String(haveRow));

// Drag OVER the folder (dragenter + dragover) so the external-drop target is set and the
// folder gets framed, THEN drop — all on the folder row, never the editor.
const res = await ev(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'clip-in-folder.mp4', { type: 'video/mp4' });
  const row = document.querySelector('.tree-folder[data-folder="Progetti"]');
  const mk = (t) => { const dt = new DataTransfer(); dt.items.add(file); return new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }); };
  row.dispatchEvent(mk('dragenter'));
  row.dispatchEvent(mk('dragover'));
  const framed = !!document.querySelector('.ext-drop-into') && document.querySelector('.ext-drop-into').contains(row);
  row.dispatchEvent(mk('drop'));
  await new Promise(r => setTimeout(r, 3500));
  return JSON.stringify({ framed });
})()`);
let framed = false; try { framed = JSON.parse(res).framed; } catch(_) {}
console.log('  (drag/drop', res + ')');
await sleep(1200);

// Part 1 — the WHOLE folder was framed while dragging over it.
check('dragging over the folder frames it (.ext-drop-into wraps the folder row)', framed === true, res);

// Part 2 — the video is stored under attachments/videos/ (storage is still by type).
let onDisk=''; try { onDisk = execSync(`find ${VAULT}/attachments -type f -printf '%p\\n'`).toString().trim(); } catch { onDisk='(none)'; }
check('the video is stored under attachments/videos/', /videos\/clip-in-folder\.mp4$/m.test(onDisk), onDisk || '(nothing on disk)');

// …and it is listed INSIDE the Progetti folder, not at the root.
const inFolder = await ev(`JSON.stringify(((state.notes||[]).find(n => n.type==='folder' && n.name==='Progetti')||{}).children?.map(c => c.type+':'+c.name) || [])`);
const atRoot   = await ev(`JSON.stringify((state.notes||[]).map(n => n.type+':'+n.name))`);
check('the dropped video is listed INSIDE the folder', /video:clip-in-folder\.mp4/.test(inFolder), 'Progetti children: ' + inFolder);
check('and NOT at the vault root', !/video:clip-in-folder\.mp4/.test(atRoot), 'root: ' + atRoot);

// …and the folder home is persisted in the tree order (in the vault, so it syncs and
// survives a reload). The write is async/fire-and-forget, so give it a moment.
await sleep(800);
const orderFile = `${VAULT}/notes/.amelie-order.json`;
let order = '(no order file)'; try { order = fs.readFileSync(orderFile,'utf8'); } catch(_) {}
check('the folder home is saved in the tree order', /"Progetti"[\s\S]*attachments\/videos\/clip-in-folder\.mp4/.test(order), order);

console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
