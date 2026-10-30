// A loose attachment dropped on a folder has EXACTLY ONE home — even if the same file
// is later dropped on a DIFFERENT folder, and even when it is byte-identical (dedup
// reuses the one physical copy).
//
// serekkr, 30/10/2026: dropping the same image on folder A then folder B left it homed
// in BOTH. In the live session it looked like one row, but the saved order listed the
// file under two folders, so after a reload _attachmentHomes surfaced TWO rows for ONE
// physical file — and deleting either row deleted the single file behind both. The home
// recorder now strips the path from every other order level, so it lives in one folder.
//
// Drives the real app: a real PNG File dropped on two folder rows in turn.
//
//   run: npm run test:redrop      (uses $DISPLAY; needs no ffmpeg — PNG is inline)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-redrop'; const VAULT = `${HOME}/vault`; const PORT = 9341;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); }
// 1x1 transparent PNG (passes main's PNG signature check).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
let child = null;
process.on('exit', () => { try { if (child) process.kill(-child.pid,'SIGKILL'); } catch(_){} });
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},80000);
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
fs.mkdirSync(`${VAULT}/notes/Progetti`,{recursive:true});
fs.mkdirSync(`${VAULT}/notes/Archivio`,{recursive:true});
fs.writeFileSync(`${VAULT}/notes/Progetti/piano.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nPlan.\n');
fs.writeFileSync(`${VAULT}/notes/Archivio/vecchio.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nOld.\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`,JSON.stringify({vaultPath:VAULT,encryption:{enabled:false}}));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`,JSON.stringify({autoSaveSeconds:30,sync:{enabled:false}}));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore','pipe','pipe'] });
let err=''; child.stderr.on('data',d=>{err+=d;});
let target=null;
for(let i=0;i<40&&!target;i++){await sleep(500);try{target=(await(await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t=>t.type==='page'&&/index\.html/.test(t.url));}catch(_){}}
if(!target){console.error('no app\n'+err.slice(-1200));process.exit(1);}
const ws=new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0;const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const ev=x=>new Promise(res=>{const my=++id;pending.set(my,m=>res(m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails?.exception?.description||m.result)));ws.send(JSON.stringify({id:my,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));setTimeout(()=>{if(pending.delete(my))res('<<timeout>>');},25000);});
await sleep(1500);
const results=[]; const check=(n,p,d)=>{results.push(p);console.log(`${p?'ok  ':'FAIL'}  ${n}${p?'':`\n        ${d}`}`);};

const dropOn = async (folder) => ev(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'photo.png', { type: 'image/png' });
  const row = document.querySelector('.tree-folder[data-folder="'+${JSON.stringify(folder)}+'"]');
  const mk = (t) => { const dt = new DataTransfer(); dt.items.add(file); return new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }); };
  row.dispatchEvent(mk('dragenter')); row.dispatchEvent(mk('dragover')); row.dispatchEvent(mk('drop'));
  await new Promise(r => setTimeout(r, 3000));
  return 'done';
})()`);

// Drop the SAME file on Progetti, then on Archivio.
await dropOn('Progetti'); await sleep(900);
await dropOn('Archivio'); await sleep(1200);

// Only ONE physical copy exists (dedup).
let disk=''; try { disk = fs.readdirSync(`${VAULT}/attachments/images`).join(' '); } catch { disk='(none)'; }
check('only one physical copy of the image exists (dedup)', disk === 'photo.png', 'images/: ' + disk);

// The saved order lists the image under EXACTLY ONE folder key (not two, not the root).
await sleep(600);
let order = {}; try { order = JSON.parse(fs.readFileSync(`${VAULT}/notes/.amelie-order.json`,'utf8')); } catch(_) {}
const homes = Object.entries(order).filter(([k,v]) => Array.isArray(v) && v.includes('attachments/images/photo.png')).map(([k]) => k || '(root)');
check('the image is homed in exactly one folder in the saved order', homes.length === 1, 'homes: ' + JSON.stringify(homes));
check('and that home is the last folder it was dropped on (Archivio)', homes[0] === 'Archivio', 'homes: ' + JSON.stringify(homes));

// In the live tree it is a single row.
const rows = await ev(`[...document.querySelectorAll('#file-tree .tree-name')].map(e=>e.textContent).filter(t=>t==='photo.png').length`);
check('the image shows as a single row in the tree', Number(rows) === 1, 'photo.png rows: ' + rows);

console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
