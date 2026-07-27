// DIAGNOSTIC TOOL — not part of `npm test`. Run it when the editor misbehaves.
//
//   node test/editor-wrap-sweep.mjs      (needs xvfb-run + a built cm.bundle.js)
//
// This is what found the v1.0.12 root cause and, along the way, a silent data loss the unit
// tests could not see. Two phases, on synthetic notes in a throwaway vault:
//
// Phase 1 — forensics. Install a MutationObserver on CodeMirror's contentDOM from the
// OUTSIDE (no app change) plus capture-phase listeners for keydown/beforeinput/input, then
// type one character and read back the exact order of events. That says WHO removes the
// lines and WHEN: between beforeinput and input is the browser's own default action; after
// input is CodeMirror's processing.
//
// Phase 2 — sweep. Notes whose only difference is the length of the first line, to find the
// threshold and check whether it coincides with the point where the line starts WRAPPING.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-wrap-sweep';
const VAULT = `${HOME}/vault`;
const PORT = 9241;

const LENGTHS = [40, 80, 120, 160, 200, 254, 400, 800];
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
const body = (n) => 'A'.repeat(n) + '\n\nsecond line, short\nthird line, short\n';
for (const n of LENGTHS) fs.writeFileSync(`${VAULT}/notes/len-${String(n).padStart(3, '0')}.md`, body(n));
fs.writeFileSync(`${VAULT}/notes/forensics.md`, body(254));
// same 254 chars, but as the LAST line instead of the first
fs.writeFileSync(`${VAULT}/notes/last-long.md`, 'short first line\n\nsecond line, short\n' + 'A'.repeat(254) + '\n');
// one single long line, nothing else
fs.writeFileSync(`${VAULT}/notes/only-long.md`, 'A'.repeat(254) + '\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const cleanup = () => {
  try { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('app did not start'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 8000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expr, ms = 10000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(3500);
for (let i = 0; i < 30; i++) {
  const ready = await ev('typeof state !== "undefined" && state.notes && state.notes.length > 0 && typeof _cmHandle !== "undefined" && !!_cmHandle && _cmActive');
  if (ready === true) break;
  await sleep(400);
}
await ev('(() => { const c = document.getElementById("input-modal-cancel"); if (c && getComputedStyle(document.getElementById("input-modal")).display !== "none") c.click(); })()');
await ev('(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()');

const open = async (file) => {
  const r = await ev(`(async () => {
    const walk = (a) => { for (const n of a || []) { if (n.path === ${JSON.stringify(file)}) return n; const r = n.children && walk(n.children); if (r) return r; } return null; };
    const n = walk(state.notes); if (!n) return 'NOT-FOUND';
    await openNote(n); setViewMode('edit');
    return state.currentPath;
  })()`, 15000);
  await sleep(900);
  return r;
};
const pressKey = async (key, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  await sleep(400);
};
const typeChar = async (ch) => {
  const code = 'Key' + ch.toUpperCase(), vk = ch.toUpperCase().charCodeAt(0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
  await sleep(400);
};

// ── Phase 1: who removes the lines, and when ────────────────────────────────────────────
console.log('══ Phase 1 — forensics on a 254-char first line ══\n');
await open('forensics.md');
await ev(`(() => {
  const cd = _cmHandle.view.contentDOM;
  window.__log = [];
  const t0 = performance.now();
  const stamp = (what, extra) => window.__log.push({ t: +(performance.now() - t0).toFixed(2), what, ...extra });
  window.__stamp = stamp;
  for (const type of ['keydown', 'beforeinput', 'input', 'keyup'])
    cd.addEventListener(type, (e) => stamp(type + (e.inputType ? ':' + e.inputType : ''), { domLen: cd.textContent.length, lines: cd.querySelectorAll('.cm-line').length }), true);
  const mo = new MutationObserver((recs) => {
    for (const r of recs) stamp('mutation', {
      removed: r.removedNodes.length, added: r.addedNodes.length,
      target: r.target.nodeType === 1 ? (r.target.className || r.target.tagName) : 'text',
      kind: r.type, domLen: cd.textContent.length, lines: cd.querySelectorAll('.cm-line').length });
  });
  mo.observe(cd, { childList: true, subtree: true, characterData: true });
  window.__mo = mo;
  const len = _cmHandle.getValue().length;
  _cmHandle.setSelection(len, len); _cmHandle.focus();
  return { docLen: len, domLen: cd.textContent.length, lines: cd.querySelectorAll('.cm-line').length };
})()`).then((r) => console.log('   stato iniziale:', JSON.stringify(r)));
await typeChar('q');
const log = await ev('(() => { window.__mo.disconnect(); return window.__log.slice(0, 40); })()');
if (Array.isArray(log)) {
  console.log('   sequenza (t in ms dal montaggio dell\'osservatore):');
  for (const e of log) {
    const bits = [`${String(e.t).padStart(8)}ms`, e.what.padEnd(24)];
    if (e.removed != null) bits.push(`-${e.removed} +${e.added} su ${e.target} (${e.kind})`);
    bits.push(`→ dom=${e.domLen} righeDom=${e.lines}`);
    console.log('   ' + bits.join('  '));
  }
} else console.log('   log non leggibile:', log);

// ── Phase 2: where is the threshold, and does it match the wrap point? ───────────────────
console.log('\n══ Phase 2 — sweep sulla lunghezza della prima riga ══\n');
console.log('   nota         avvolta  doc  domPre  domIn  coll  BLK  q  esito');
const LOG = '/tmp/amelie-cm-debug.log';
const logLines = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch (_) { return []; } };
const notes = [...LENGTHS.map((n) => `len-${String(n).padStart(3, '0')}.md`), 'last-long.md', 'only-long.md'];
for (const file of notes) {
  const opened = await open(file);
  if (opened !== file) { console.log(`   ${file}: non aperta (${opened})`); continue; }
  const before = logLines().length;
  const pre = await ev(`(() => {
    const v = _cmHandle.view, cd = v.contentDOM, len = _cmHandle.getValue().length;
    _cmHandle.setSelection(len, len); _cmHandle.focus();
    window.__probe = {};
    const rec = (k) => window.__probe[k] = { dom: cd.textContent.length, lines: cd.querySelectorAll('.cm-line').length };
    cd.addEventListener('beforeinput', () => rec('beforeinput'), { capture: true, once: true });
    cd.addEventListener('input', () => rec('input'), { capture: true, once: true });
    const first = cd.querySelector('.cm-line');
    const lh = parseFloat(getComputedStyle(cd).lineHeight) || 20;
    return { doc: len, dom: cd.textContent.length, lines: cd.querySelectorAll('.cm-line').length,
             rows: first ? Math.round(first.getBoundingClientRect().height / lh) : 0 };
  })()`);
  await typeChar('q');
  const docAfterType = await ev('_cmHandle.getValue().length');
  await pressKey('Backspace', 'Backspace', 8);   // the case reported from the real session
  const docAfterDel = await ev('_cmHandle.getValue().length');
  const probe = await ev('window.__probe');
  const post = await ev('(() => ({ doc: _cmHandle.getValue().length, tail: _cmHandle.getValue().slice(-3) }))()');
  const blocked = logLines().slice(before).filter((l) => l.startsWith('BLOCKED')).length;
  const dBefore = probe?.beforeinput?.dom ?? -1, dAfter = probe?.input?.dom ?? -1;
  const collapsed = dBefore > 0 && dAfter > 0 && dAfter < dBefore - 8;
  const docBefore = pre?.doc ?? -1, docAfter = post?.doc ?? -1;
  // type then Backspace: the document must go +1 and then back to where it started.
  const typeOk = docAfterType === docBefore + 1;
  const delOk = docAfterDel === docAfterType - 1;
  const verdict = typeOk && delOk ? 'ok (scrittura + cancellazione)'
    : !typeOk && docAfterType < docBefore ? `PERSI ${docBefore - docAfterType} caratteri scrivendo`
    : !typeOk ? `battuta non applicata (${docBefore}->${docAfterType})`
    : docAfterDel < docAfterType - 1 ? `PERSI ${docAfterType - docAfterDel - 1} caratteri cancellando`
    : `cancellazione non applicata (${docAfterType}->${docAfterDel})`;
  console.log(`   ${file.replace('.md','').padEnd(12)} ${String(pre?.rows).padStart(2)} righe  ${String(docBefore).padStart(4)}  ${String(dBefore).padStart(6)}  ${String(dAfter).padStart(6)}  ${(collapsed ? 'SÌ' : 'no').padStart(4)}  ${String(blocked).padStart(3)}  ${typeOk ? 'q' : '-'}  ${verdict}`);
}
console.log(`\n   (larghezza area di testo: ${(await ev('Math.round(_cmHandle.view.contentDOM.clientWidth)'))}px)`);

ws.close(); cleanup(); await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(0);
