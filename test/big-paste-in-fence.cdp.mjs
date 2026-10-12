// A LOT of text pasted inside a ``` block typed by hand — does any of it change?
//
// paste-fidelity already guards a real Ctrl+V of a ~7 KB script. This asks the next
// question, the one serekkr asked on 12/10/2026: what if the block is typed by hand,
// with three backticks, and what goes in is not a script but a wall of text — a log,
// a dump, a whole file — and what if "a lot" is not seven kilobytes but two hundred.
//
// The payload is built to be hostile in the ways markdown is hostile: tabs and
// trailing spaces (which a formatter would trim), blank lines (which a renderer
// collapses), single backticks, lines that look like wiki links, headings, lists and
// tables (which must NOT be rendered inside a fence), accents and emoji (bytes a
// naive length check gets wrong), and very long unbroken lines.
//
// Checked: the editor holds it, the FILE holds it byte for byte, reading mode shows
// it unchanged with no markdown of ours applied inside, closing and reopening the
// note gives it back, and none of it is slow enough to feel broken.
//
// One shape is recorded rather than demanded: typing the third backtick CLOSES the
// block at once ("```\n\n```", caret on the empty line), so the Enter a person
// presses next adds a blank line and the paste lands below it. The text is untouched
// — the block just opens with one empty line. Measured here (12/10/2026), and the
// comparisons allow exactly that one newline and nothing else.
//
//   run: npm run test:bigpaste     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-bigpaste'; const VAULT = `${HOME}/vault`; const PORT = 9409;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 180000);

// ── The payload ─────────────────────────────────────────────────────────────
// No ``` anywhere in it: three backticks inside a fence END the fence, which is
// markdown doing its job, not a fault — mixing that in would prove nothing.
const LINES = [];
for (let i = 1; i <= 3000; i++) {
  LINES.push(`${String(i).padStart(5, '0')}  ordinaria con àccenti, emoji 🛰 e virgolette "doppie"`);
  LINES.push('\tindentata con un TAB e con spazi in coda   ');
  LINES.push('    quattro spazi, poi `backtick singolo` e un [[finto wiki link]]');
  LINES.push('# non è un titolo, siamo dentro il blocco');
  LINES.push('- non è una lista   | né | una | tabella |');
  LINES.push('');
  LINES.push('x'.repeat(400) + ' riga lunghissima senza spazi prima');
}
const PAYLOAD = LINES.join('\n');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/incolla.md`, '---\ncreated: 2026-10-12 10:00\n---\n\nprima\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
console.log(`payload: ${LINES.length} righe, ${PAYLOAD.length} caratteri (${(Buffer.byteLength(PAYLOAD) / 1024).toFixed(0)} KB)`);

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p = {}) => new Promise(res => { const my = ++id; pending.set(my, r => res(r.result)); ws.send(JSON.stringify({ id: my, method: m, params: p })); setTimeout(() => { if (pending.delete(my)) res(null); }, 60000); });
const ev = (x, ms = 60000) => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res('<<TIMEOUT>>'); }, ms); });
await sleep(3000);
const results = []; const check = (n, p, d = '') => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

await ev(`(async () => { const n = findNote(state.notes, 'incolla.md'); await openNote(n); })()`);
await sleep(900);
await ev(`setViewMode('edit')`);
await sleep(700);

// ── The block, typed the way a person types it ──────────────────────────────
await ev(`(() => { editor.value = ''; _cmHandle.setSelection(0, 0); return 1; })()`);
await sleep(200);
await send('Page.bringToFront');
await ev(`(() => { document.querySelector('#cm-mount .cm-content').focus(); return 1; })()`);
for (const ch of '```') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: 'Backquote' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Backquote' });
}
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await sleep(400);
const opened = await ev(`editor.value`);
check('three backticks and Enter open a code block', opened.startsWith('```'), JSON.stringify(opened.slice(0, 30)));

// ── The paste ───────────────────────────────────────────────────────────────
// Through a real paste EVENT, with the payload as the clipboard data: it runs the
// same handlers a Ctrl+V runs (CodeMirror's and Amelie's), without depending on an
// X clipboard that an idle desktop may refuse to hand over.
const t0 = Date.now();
await ev(`(() => {
  const el = document.querySelector('#cm-mount .cm-content'); el.focus();
  const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(PAYLOAD)});
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return 1;
})()`);
let val = '';
for (let i = 0; i < 40; i++) { val = await ev(`editor.value`); if (val.length > PAYLOAD.length * 0.9) break; await sleep(250); }
const pasteMs = Date.now() - t0;
console.log(`      incollato in ${pasteMs} ms`);
check('the paste lands', val.length > PAYLOAD.length * 0.9, `${val.length} caratteri contro ${PAYLOAD.length}`);
check('and it does not take long enough to look broken (under 8 s)', pasteMs < 8000, `${pasteMs} ms`);

const inner = val.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
check('the block opens with at most the one blank line the extra Enter makes',
  inner.length - PAYLOAD.length <= 1 && /^\n?[^\n]/.test(inner.slice(0, 2) + 'x'),
  `${inner.length - PAYLOAD.length} caratteri in più all'inizio`);
check('the editor holds every byte of it',
  inner.replace(/^\n/, '') === PAYLOAD,
  (() => { let k = 0; while (k < inner.length && k < PAYLOAD.length && inner[k] === PAYLOAD[k]) k++;
           return `lunghezze ${inner.length} vs ${PAYLOAD.length}, prima differenza al carattere ${k}: ${JSON.stringify(inner.slice(k - 40, k + 40))} contro ${JSON.stringify(PAYLOAD.slice(k - 40, k + 40))}`; })());

// ── What lands on disk ──────────────────────────────────────────────────────
await ev(`(async () => { await saveCurrentNote(); })()`);
await sleep(2500);
const onDisk = fs.readFileSync(`${VAULT}/notes/incolla.md`, 'utf8');
const body = onDisk.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
const diskInner = body.replace(/^```[^\n]*\n/, '').replace(/\n```\s*\n?$/, '');
check('the FILE holds every byte of it', diskInner.replace(/^\n/, '') === PAYLOAD,
  (() => { let k = 0; while (k < diskInner.length && k < PAYLOAD.length && diskInner[k] === PAYLOAD[k]) k++;
           return `lunghezze ${diskInner.length} vs ${PAYLOAD.length}, prima differenza al carattere ${k}: ${JSON.stringify(diskInner.slice(k - 40, k + 40))} contro ${JSON.stringify(PAYLOAD.slice(k - 40, k + 40))}`; })());
check('…including the tabs and the trailing spaces',
  diskInner.includes('\tindentata con un TAB e con spazi in coda   \n'), 'tab o spazi in coda persi');

// ── What reading mode shows ─────────────────────────────────────────────────
const t1 = Date.now();
await ev(`setViewMode('view')`);
for (let i = 0; i < 40; i++) { if (await ev(`!!document.querySelector('#preview-content pre code')`)) break; await sleep(250); }
const renderMs = Date.now() - t1;
console.log(`      reso in lettura in ${renderMs} ms`);
const shown = await ev(`document.querySelector('#preview-content pre code')?.textContent || ''`);
check('reading mode shows it unchanged', shown.replace(/\n$/, '').replace(/^\n/, '') === PAYLOAD,
  (() => { const s = shown.replace(/\n$/, ''); let k = 0; while (k < s.length && k < PAYLOAD.length && s[k] === PAYLOAD[k]) k++;
           return `lunghezze ${s.length} vs ${PAYLOAD.length}, prima differenza al carattere ${k}: ${JSON.stringify(s.slice(k - 40, k + 40))}`; })());
const html = await ev(`document.querySelector('#preview-content pre code')?.innerHTML || ''`);
check('nothing inside the block was turned into markdown',
  !/note-link|<h1|<table|<li>/.test(html), (html.match(/[^\n]*(note-link|<h1|<table|<li>)[^\n]*/) || [''])[0].slice(0, 160));
check('and reading mode is not slow enough to look stuck (under 10 s)', renderMs < 10000, `${renderMs} ms`);

// ── Closed and reopened ─────────────────────────────────────────────────────
await ev(`(async () => { const i = tabs.findIndex(t => t.path === 'incolla.md'); if (i >= 0) await closeTab(i); })()`);
await sleep(600);
await ev(`(async () => { const n = findNote(state.notes, 'incolla.md'); await openNote(n); })()`);
await sleep(1500);
await ev(`setViewMode('edit')`);
await sleep(900);
const again = await ev(`editor.value`);
const againInner = again.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
check('closed and reopened, it is still every byte', againInner.replace(/^\n/, '') === PAYLOAD,
  `lunghezze ${againInner.length} vs ${PAYLOAD.length}`);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
