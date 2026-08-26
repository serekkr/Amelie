// A real Ctrl+V of a real script survives, byte for byte, all the way through.
//
// Two faults met in one paste. (1) Fenced code was re-indented to 2 spaces in the
// FILE, so the script that came back out had every line shifted: its heredoc
// terminator stopped matching and its embedded Python hit an IndentationError.
// (2) The reading view's markdown extras ran inside code fences, and bash's
// `[[ … ]]` looks exactly like a wiki link — `if [[ "$c" == */* ]]; then` rendered
// as a printed <a> tag with a literal &quot; where each " had been.
//
// This drives the real app over the DevTools Protocol: the script goes on the
// system clipboard, a real paste command puts it in a code block and then in plain
// prose, and every stage is compared against the clipboard — editor, file on disk,
// and what reading mode shows.
//
//   run: npm run test:paste      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-paste-fidelity';
const VAULT = `${HOME}/vault`;
const PORT = 9291;
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

const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };
let child = null;
setTimeout(() => { console.error('TIMEOUT: giving up'); process.exit(2); }, 95000).unref?.();
process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });

// Everything the user named, plus the entity spellings that must NOT be decoded
// and the non-ASCII the script actually contained.
// The real thing: the script the user actually pasted, plus one line of the
// entity spellings that must NOT be decoded on the way through.
const PAYLOAD = fs.readFileSync(`${REPO}/map-tiles-gen.sh`, 'utf8').replace(/\n$/, '')
  + '\n# literal entities stay literal: &quot; &amp; &lt; &gt; &#39;';

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
const fm = '---\ncreated: 2026-08-26 10:00\nmodified: 2026-08-26 10:00\n---\n\n';
fs.writeFileSync(`${VAULT}/notes/paste.md`, fm + 'start\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 1, sync: { enabled: false } }));

const args = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...args, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, args,
      { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = ''; child.stderr.on('data', d => { appErr += d; });
let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('no app\n' + appErr.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({}); }, 20000);
});
const ev = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

// The real system clipboard, then a real Ctrl+V into the editing surface.
// NOT wl-copy: it stays alive to serve the Wayland selection, so execSync waits
// for it forever. The renderer's own clipboard write reaches the same system
// clipboard and returns.
console.log('   .. clipboard:', await ev(`navigator.clipboard.writeText(${JSON.stringify(PAYLOAD)}).then(() => 'ok', e => 'ERR ' + e.message)`));
await sleep(400);
const paste = async () => {
  await ev(`(() => { const cd = document.querySelector('#cm-mount .cm-content'); cd.focus(); })()`);
  await sleep(200);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 86, key: 'v', code: 'KeyV', modifiers: 2, commands: ['paste'] });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 86, key: 'v', code: 'KeyV', modifiers: 2 });
  await sleep(700);
};

console.log('   .. app up');
await sleep(1000);
await ev(`(async () => { const n = findNote(state.notes, 'paste.md'); await openNote(n); })()`);
await sleep(900);
await ev(`setViewMode('edit')`);
await sleep(600);

// ── 1. paste as NORMAL TEXT ────────────────────────────────────────────────
await ev(`editor.value = ''; _cmHandle.setSelection(0, 0);`);
await sleep(300);
await paste();
console.log('   .. pasted plain');
const plainVal = await ev(`editor.value`);
check('normal text: the editor holds the clipboard verbatim',
  plainVal.trim() === PAYLOAD.trim(), JSON.stringify({ got: plainVal.slice(0, 200), want: PAYLOAD.slice(0, 200) }));

// ── 2. paste INSIDE a code fence, via the toolbar Code button ──────────────
await ev(`editor.value = ''; _cmHandle.setSelection(0, 0); handleToolbarCmd('code');`);
await sleep(400);
await paste();
console.log('   .. pasted in fence');
const fenceVal = await ev(`editor.value`);
const inner = fenceVal.split('\n').slice(1, -1).join('\n');
check('code block: the fences sit at column 0', /^```\n/.test(fenceVal) && /\n```$/.test(fenceVal.trim()), JSON.stringify(fenceVal.slice(0, 40)));
check('code block: the editor holds the clipboard verbatim',
  inner.trim() === PAYLOAD.trim(), JSON.stringify({ got: inner.slice(0, 200), want: PAYLOAD.slice(0, 200) }));

// ── 3. what lands on disk ──────────────────────────────────────────────────
console.log('   .. saving');
await ev(`(async () => { try { await saveCurrentNote(); } catch (e) { return 'no saveCurrentNote: ' + e.message; } })()`);
await sleep(1800);
const onDisk = fs.readFileSync(`${VAULT}/notes/paste.md`, 'utf8');
const body = onDisk.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
const diskInner = body.split('\n').slice(1).join('\n').replace(/\n```\s*$/, '');
check('on disk: the code block is byte-identical to the clipboard',
  diskInner.trim() === PAYLOAD.trim(), JSON.stringify({ got: diskInner.slice(0, 300), want: PAYLOAD.slice(0, 300) }));
// ── 4. what reading mode SHOWS, and what the copy button hands back ─────────
await ev(`setViewMode('view')`);
await sleep(1500);
const shown = await ev(`document.querySelector('#preview-content pre code')?.textContent || ''`);
check('reading mode shows the code verbatim', shown.trim() === PAYLOAD.trim(),
  (() => { const i = [...PAYLOAD.trim()].findIndex((c, k) => c !== shown.trim()[k]);
           return `first difference at char ${i}: want ${JSON.stringify(PAYLOAD.trim().slice(i, i+60))} got ${JSON.stringify(shown.trim().slice(i, i+60))}`; })());
const html = await ev(`document.querySelector('#preview-content pre code')?.innerHTML || ''`);
check('no <a> tag was printed into the code block',
  !html.includes('note-link'), (html.match(/[^\n]*note-link[^\n]*/) || [''])[0].slice(0, 160));

if (!results.every(Boolean)) {   // a picture only when something is wrong
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('/tmp/paste-fidelity.png', Buffer.from(shot.result.data, 'base64'));
  console.log('\nscreenshot of the failure -> /tmp/paste-fidelity.png');
}
console.log(`\n${results.every(Boolean) ? `all ${results.length}` : `${results.filter(Boolean).length}/${results.length}`} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
