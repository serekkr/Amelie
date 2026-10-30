// Dropping a media file INTO the open note (the editor, not the sidebar) files it in the
// TREE under the folder of the note you're viewing — not the vault root.
//
// serekkr, 30/10/2026: "se faccio il drag di una foto pdf o media dentro una nota … devi
// caricare il file nella vista di note della cartella dove e' la nota che sto visualizzando
// non la root". Media is still stored by TYPE under attachments/, but the editor drop now
// records the current note's folder as the loose attachment's home (treeOrder →
// _attachmentHomes in main), exactly like a drop on that folder's row.
//
// Drives the real app: opens notes/Progetti/piano.md, then dispatches a real DragEvent with
// a real PNG File on the editor surface.
//
//   run: npm run test:dropnote      (uses $DISPLAY; no ffmpeg — PNG is inline)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-dropnote'; const VAULT = `${HOME}/vault`; const PORT = 9342;
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
fs.writeFileSync(`${VAULT}/notes/Progetti/piano.md`,'---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\nPlan.\n');
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

// Open the note that lives inside Progetti.
let opened = false;
for (let i = 0; i < 24 && !opened; i++) {
  opened = (await ev(`(async()=>{const fl=(ns)=>{let o=[];for(const n of ns||[]){if(n.type==='folder')o=o.concat(fl(n.children));else o.push(n);}return o;};const node=fl(state.notes).find(n=>n.path==='Progetti/piano.md');if(!node)return false;await openNote(node);await new Promise(r=>setTimeout(r,500));return state.currentPath==='Progetti/piano.md';})()`)) === true;
  if (!opened) await sleep(500);
}
check('opened notes/Progetti/piano.md', opened === true, 'currentPath: ' + await ev(`String(state.currentPath)`));

// Invoke the editor's REAL drop handler (_editorDropHandler) with a real PNG File. We call
// it directly rather than dispatch a DragEvent: Chromium won't deliver a synthetic DragEvent
// to the capture-phase listener CM's contentDOM carries, but the handler itself — the exact
// function wired to that drop event — is what this change lives in.
const res = await ev(`(async () => {
  const bin = Uint8Array.from(atob(${JSON.stringify(PNG_B64)}), c => c.charCodeAt(0));
  const file = new File([bin], 'shot.png', { type: 'image/png' });
  const e = {
    dataTransfer: { files: [file], items: [], getData: () => '' },
    clientX: 200, clientY: 200,
    preventDefault(){}, stopImmediatePropagation(){}, stopPropagation(){},
  };
  await _editorDropHandler(e);
  await new Promise(r => setTimeout(r, 3500));
  return 'handled';
})()`);
console.log('  (drop ' + res + ')');
await sleep(1200);

// Stored by type under attachments/images/ (storage unchanged).
let onDisk=''; try { onDisk = fs.readdirSync(`${VAULT}/attachments/images`).join(' '); } catch { onDisk='(none)'; }
check('the image is stored under attachments/images/', /shot\.png/.test(onDisk), 'images/: ' + onDisk);

// Listed INSIDE Progetti, not at the vault root.
const inFolder = await ev(`JSON.stringify(((state.notes||[]).find(n=>n.type==='folder'&&n.name==='Progetti')||{}).children?.map(c=>c.type+':'+c.name)||[])`);
const atRoot   = await ev(`JSON.stringify((state.notes||[]).map(n=>n.type+':'+n.name))`);
check('the dropped image is listed INSIDE Progetti', /image:shot\.png/.test(inFolder), 'Progetti children: ' + inFolder);
check('and NOT at the vault root', !/image:shot\.png/.test(atRoot), 'root: ' + atRoot);

// The folder home is persisted in the tree order (in the vault, so it survives a reload).
await sleep(800);
let order = {}; try { order = JSON.parse(fs.readFileSync(`${VAULT}/notes/.amelie-order.json`,'utf8')); } catch(_) {}
const homes = Object.entries(order).filter(([k,v]) => Array.isArray(v) && v.includes('attachments/images/shot.png')).map(([k]) => k || '(root)');
check('the image is homed in exactly one folder in the saved order', homes.length === 1, 'homes: ' + JSON.stringify(homes));
check('and that home is Progetti (the open note folder)', homes[0] === 'Progetti', 'homes: ' + JSON.stringify(homes));

console.log(`\n${results.every(Boolean)?`all ${results.length}`:`${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean)?0:1);
