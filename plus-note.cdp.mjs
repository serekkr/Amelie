import fs from 'node:fs';
import { spawn } from 'node:child_process';
const REPO='/home/serekkr/Documents/4-hydra/amelie-notes/amelie-linux';
const HOME='/tmp/amelie-plus'; const VAULT=`${HOME}/vault`;
const ELECTRON=`${REPO}/node_modules/electron/dist/electron`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
setTimeout(()=>{console.error('TIMEOUT');process.exit(2);},90000);
const results=[]; const check=(n,p,d='')=>{results.push(p);console.log(`${p?'ok  ':'FAIL'}  ${n}${p?'':`\n        ${d}`}`);};
fs.rmSync(HOME,{recursive:true,force:true});
fs.mkdirSync(`${VAULT}/notes`,{recursive:true});   // EMPTY vault, no notes selected
fs.mkdirSync(`${HOME}/.local/share/amelie`,{recursive:true});
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`,JSON.stringify({vaultPath:VAULT,encryption:{enabled:false}}));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`,JSON.stringify({autoSaveSeconds:30,sync:{enabled:false}}));
const port=9491;
const eargs=['.',`--remote-debugging-port=${port}`,'--no-sandbox','--password-store=basic','--disable-gpu','--ozone-platform=x11'];
const env={...process.env,HOME,DISPLAY:':99',WAYLAND_DISPLAY:'',XDG_SESSION_TYPE:'x11',ELECTRON_RUN_AS_NODE:undefined};
const child=spawn(ELECTRON,eargs,{cwd:REPO,env,detached:true,stdio:'ignore'});
try{
 let t=null; for(let i=0;i<60&&!t;i++){await sleep(500);try{t=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x=>x.type==='page'&&/index\.html/.test(x.url));}catch{}}
 const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const pend=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data);pend.get(m.id)?.(m);};
 const ev=x=>new Promise(res=>{const my=++id;pend.set(my,m=>res(m.result?.result?.value));ws.send(JSON.stringify({id:my,method:'Runtime.evaluate',params:{expression:x,awaitPromise:true,returnByValue:true}}));});
 await sleep(3000);
 const notesBefore=fs.existsSync(`${VAULT}/notes`)?fs.readdirSync(`${VAULT}/notes`).filter(f=>f.endsWith('.md')):[];
 check('partenza: nessuna nota su disco', notesBefore.length===0, JSON.stringify(notesBefore));
 // Click the + (tab-new-btn) with nothing selected
 await ev(`document.getElementById('tab-new-btn').click(); 1`);
 for(let i=0;i<20 && fs.readdirSync(`${VAULT}/notes`).filter(f=>f.endsWith('.md')).length===0;i++) await sleep(150);
 const notesAfter=fs.readdirSync(`${VAULT}/notes`).filter(f=>f.endsWith('.md'));
 check('il + ha creato una NOTA VERA su disco', notesAfter.length===1, JSON.stringify(notesAfter));
 const activePath=await ev(`(()=>{ const t=tabs[activeTabIdx]; return t? String(t.path) : 'no-tab'; })()`);
 check('la tab attiva ha un path reale (non fantasma path:null)', typeof activePath==='string' && activePath!=='null' && activePath.endsWith('.md'), 'activePath='+activePath);
 const ghost=await ev(`tabs.some(t=>t && t.path===null && !t.type)`);
 check('nessuna tab fantasma (path:null) aperta', ghost===false, 'ghost='+ghost);
 const inTree=await ev(`(async()=>{ await loadTree(); return !!document.querySelector('#file-tree [data-path="'+(tabs[activeTabIdx].path)+'"]'); })()`);
 check('la nuova nota compare nell albero', inTree);
 ws.close();
}finally{ try{process.kill(-child.pid,'SIGKILL');}catch{} await sleep(400); fs.rmSync(HOME,{recursive:true,force:true}); }
const failed=results.filter(r=>!r).length;
console.log(failed?`\n${failed} of ${results.length} FAILED`:`\nall ${results.length} passed`);
process.exit(failed?1:0);
