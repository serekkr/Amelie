// The real vault, on the real app: open, read, write, paste, tables, code, images.
//
// Every other cdp test runs on a handful of synthetic notes. This one runs on a COPY of
// the user's own vault (996 notes, 114 MB after the Obsidian import of 2026-09-22) —
// asked for on 2026-09-23 before they start using the app for real: "fai un test di
// caricamento scrittura inserimento tabelle codice immagini righe con spazi".
//
// The source is never opened by the app: it is copied with `cp -a` (so mtimes survive)
// into a throwaway HOME, and sync is OFF in that HOME's settings, so nothing it writes can
// reach the NAS or the real vault. What it checks:
//   1. load    — the whole vault is listed, and how long that takes
//   2. read    — EVERY note opens and the editor holds exactly the bytes on disk
//                (frontmatter aside); opening does not rewrite any file
//   3. render  — the reading view draws every table, every code block, and every image
//                that exists (an embed that was broken in Obsidian is counted, not failed)
//   4. write   — typed text with leading/trailing spaces, tabs, blank lines, accents and
//                emoji reaches disk byte for byte; so does the same text pasted
//   5. insert  — a table from the toolbar, a code block, a pasted photo: each lands in the
//                file, the photo in attachments/images/, and all three render
//   6. edit    — an imported note edited and saved keeps the rest of its text and its date
//   7. big     — typing in the largest note stays fast
//
//   run: npm run test:realvault      (needs xvfb-run; SOURCE=<vault> to test another)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.SOURCE || path.join(os.homedir(), 'Documents/amelie-vault');
const HOME = '/tmp/amelie-real-vault-soak';
const VAULT = `${HOME}/vault`;
const PORT = 9271;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { console.log('SKIP: xvfb-run not installed (dnf install xorg-x11-server-Xvfb)'); process.exit(0); }
if (!fs.existsSync(path.join(SOURCE, 'notes'))) { console.log(`SKIP: no vault at ${SOURCE}`); process.exit(0); }

const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };
const info = (s) => console.log(`      ${s}`);
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// The same rule as main.js stripNoteFrontmatter: only Amelie's own block is taken off.
const stripFm = (t) => {
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(\r?\n)?/);
  return m && /^\s*(created|modified)\s*:/m.test(m[1]) ? t.slice(m[0].length) : t;
};
const walkFiles = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const f = path.join(d, e.name);
  return e.isDirectory() ? walkFiles(f, base) : [path.relative(base, f)];
});

// ── Copy ────────────────────────────────────────────────────────────────────────────
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(VAULT, { recursive: true });
for (const d of ['notes', 'attachments', 'todo']) if (fs.existsSync(`${SOURCE}/${d}`)) execSync(`cp -a ${JSON.stringify(`${SOURCE}/${d}`)} ${JSON.stringify(VAULT)}/`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 2, sync: { enabled: false } }));
const mdOnDisk = walkFiles(`${VAULT}/notes`).filter((f) => f.endsWith('.md')).sort();
const mtimes0 = new Map(mdOnDisk.map((f) => [f, fs.statSync(`${VAULT}/notes/${f}`).mtimeMs]));
console.log(`copied ${SOURCE} → ${VAULT}: ${mdOnDisk.length} notes, ${execSync(`du -sh ${VAULT}`).toString().split('\t')[0]}\n`);

// ── Launch ──────────────────────────────────────────────────────────────────────────
const tLaunch = Date.now();
const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', ELECTRON, '.', '--ozone-platform=x11',
  `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = ''; child.stderr.on('data', (d) => { appErr += d; });
const cleanup = () => {
  try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);
setTimeout(() => { console.error('TIMEOUT: giving up after 15 minutes'); process.exit(2); }, 15 * 60000).unref();

let target = null;
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1500)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 30000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expression, ms = 30000) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');

// ── 1. Load ─────────────────────────────────────────────────────────────────────────
console.log('── 1. caricamento');
let listed = 0;
for (let i = 0; i < 240; i++) {
  listed = await ev(`typeof state !== 'undefined' && state.notes && typeof _cmActive !== 'undefined' && _cmActive && _cmHandle
    ? flattenTree(state.notes).filter(n => /\\.md$/i.test(n.path || '')).length : 0`);
  if (typeof listed === 'number' && listed >= mdOnDisk.length) break;
  await sleep(250);
}
const loadMs = Date.now() - tLaunch;
check(`all ${mdOnDisk.length} notes are listed`, listed === mdOnDisk.length, `the tree lists ${listed}`);
check('the vault is ready within 15 s of launch', loadMs < 15000, `${loadMs} ms`);
info(`from launch to a listed vault: ${(loadMs / 1000).toFixed(1)} s`);
// The blank unnamed tab of a fresh profile would ask for a name at the first autosave.
await ev(`(() => { try { for (let i = tabs.length - 1; i >= 0; i--) if (!tabs[i].path) closeTab(i); } catch (_) {} })()`);
await ev(`(() => { const c = document.getElementById('input-modal-cancel'); if (c && c.offsetParent) c.click(); })()`);

// In the page: open a note the app's way and hand back what the editor holds.
await ev(`window.__open = async (p, mode) => {
  const n = findNote(state.notes, p); if (!n) return { err: 'NOT-FOUND' };
  const t0 = performance.now();
  await openNote(n); setViewMode(mode || 'edit');
  const ms = performance.now() - t0;
  // Keep the tab bar short: a thousand open tabs is not how anyone reads.
  while (tabs.length > 3) { const i = tabs.findIndex((t, k) => k !== activeTabIdx); if (i < 0) break; await closeTab(i); }
  return { ms, cur: state.currentPath, val: editor.value };
}; window.__sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join(''); 'ok'`);

// ── 2. Read every note ──────────────────────────────────────────────────────────────
console.log('\n── 2. lettura di ogni nota');
const mismatch = [], notOpened = [], openTimes = [];
for (let i = 0; i < mdOnDisk.length; i += 40) {
  const batch = mdOnDisk.slice(i, i + 40);
  const got = await ev(`(async () => { const out = [];
    for (const p of ${JSON.stringify(batch)}) {
      const r = await window.__open(p, 'edit');
      out.push(r.err ? { p, err: r.err } : { p, cur: r.cur, ms: r.ms, len: r.val.length, h: await window.__sha(r.val) });
    } return out; })()`, 180000);
  if (!Array.isArray(got)) { check(`batch ${i}: the page answered`, false, String(got)); break; }
  for (const r of got) {
    if (r.err || r.cur !== r.p) { notOpened.push(`${r.p} (${r.err || 'current=' + r.cur})`); continue; }
    openTimes.push(r.ms);
    const want = stripFm(fs.readFileSync(`${VAULT}/notes/${r.p}`, 'utf8'));
    if (r.h !== sha(want)) mismatch.push({ p: r.p, len: r.len, want });
  }
}
// Show WHERE each differs: the first diverging character, with context on both sides.
const firstDiff = (a, b) => { let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++; return k; };
for (const m of mismatch.slice(0, 12)) {
  const ed = await ev(`window.__open(${JSON.stringify(m.p)}, 'edit').then(r => r.val)`);
  const k = firstDiff(ed, m.want);
  m.detail = `${m.p}: editor ${m.len} chars, disk ${m.want.length}; first difference at ${k}:\n          disk   ${JSON.stringify(m.want.slice(Math.max(0, k - 30), k + 50))}\n          editor ${JSON.stringify(String(ed).slice(Math.max(0, k - 30), k + 50))}`;
}
openTimes.sort((a, b) => a - b);
check('every note opens', notOpened.length === 0, notOpened.slice(0, 8).join('\n        '));
check('the editor holds every note exactly as it is on disk', mismatch.length === 0, `${mismatch.length} differ:\n        ${mismatch.slice(0, 12).map(m => m.detail || m.p).join('\n        ')}`);
info(`opening a note: median ${openTimes[openTimes.length >> 1]?.toFixed(0)} ms, slowest ${openTimes.at(-1)?.toFixed(0)} ms`);
await sleep(3000);   // past an autosave, so a rewrite on open would have happened
const touched = mdOnDisk.filter((f) => fs.statSync(`${VAULT}/notes/${f}`).mtimeMs !== mtimes0.get(f));
check('reading them rewrote none of them', touched.length === 0, `${touched.length} changed on disk: ${touched.slice(0, 6).join(', ')}`);

// ── 3. Render ───────────────────────────────────────────────────────────────────────
console.log('\n── 3. vista lettura: tabelle, codice, immagini');
// Count what the markdown holds OUTSIDE fences, the way a renderer sees it.
const mdShape = (body) => {
  let inFence = false, inPre = false, fences = 0, tables = 0; const lines = body.split('\n');
  for (let k = 0; k < lines.length; k++) {
    // A tab counts as four columns: "\t```" is indented code, not a fence.
    const l = lines[k].replace(/^[ \t]+/, (w) => w.replace(/\t/g, '    '));
    // A raw <pre> … </pre> is an HTML block: the fences inside it are its text.
    if (!inFence && /^\s*<pre[\s>]/i.test(l)) inPre = true;
    if (inPre) { if (/<\/pre>/i.test(l)) inPre = false; continue; }
    // CommonMark: a CLOSING fence carries no info string, so "```bash" inside an open
    // block is text, and a stray ``` in the source opens a block the rest runs into.
    if (inFence && /^\s{0,3}(```|~~~)\S/.test(l)) continue;
    // An opening ``` whose info string holds a backtick is inline code (CommonMark), e.g.
    // "```I lost my root.txt```" on one line — not a fence.
    if (/^\s{0,3}(```|~~~)/.test(l) && (inFence || !/^\s*```.*`/.test(l.replace(/^\s*```/, '```x')))) { inFence = !inFence; if (inFence) fences++; continue; }
    if (inFence) continue;
    // GFM: a delimiter row under a header row with the SAME number of cells.
    const cells = (x) => x.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').length;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(l) && k > 0 && lines[k - 1].includes('|')
        && cells(l) === cells(lines[k - 1])) tables++;
  }
  return { fences, tables };
};
const withShape = mdOnDisk.map((p) => ({ p, body: stripFm(fs.readFileSync(`${VAULT}/notes/${p}`, 'utf8')) }))
  .map((o) => ({ ...o, ...mdShape(o.body), imgs: (o.body.match(/!\[[^\]]*\]\((attachments\/[^)\s]+)/g) || []).length }));
const renderSet = withShape.filter((o) => o.tables || o.fences || o.imgs);
info(`${renderSet.length} notes with a table, code or image: ${withShape.filter((o) => o.tables).length} / ${withShape.filter((o) => o.fences).length} / ${withShape.filter((o) => o.imgs).length}`);
const tableMiss = [], codeMiss = [], brokenImg = [], missingOnDisk = [];
let tablesSeen = 0, codeSeen = 0, imgsSeen = 0, webImgs = 0;
for (let i = 0; i < renderSet.length; i += 25) {
  const batch = renderSet.slice(i, i + 25).map((o) => o.p);
  const got = await ev(`(async () => { const out = [];
    for (const p of ${JSON.stringify(batch)}) {
      await window.__open(p, 'view');
      const pc = document.getElementById('preview-content');
      // Images load lazily and asynchronously: give each a moment, then look.
      const imgs = [...pc.querySelectorAll('img')];
      for (const im of imgs) { im.loading = 'eager'; }
      const until = performance.now() + 4000;
      while (imgs.some(im => !im.complete) && performance.now() < until) await new Promise(r => setTimeout(r, 50));
      out.push({ p, tables: pc.querySelectorAll('table').length, pres: pc.querySelectorAll('pre').length,
        imgs: imgs.filter(im => !/\.(mp3|wav|m4a|ogg|flac|aac|mp4|webm|mov|mkv|m4v)([?#]|$)/i.test(decodeURIComponent(im.getAttribute('src') || ''))).map(im => ({ src: decodeURIComponent(im.getAttribute('src') || ''), ok: im.complete && im.naturalWidth > 0 })) });
    } return out; })()`, 240000);
  if (!Array.isArray(got)) { check(`render batch ${i}: the page answered`, false, String(got)); break; }
  for (const r of got) {
    const o = renderSet.find((x) => x.p === r.p);
    tablesSeen += r.tables; codeSeen += r.pres;
    if (r.tables < o.tables) tableMiss.push(`${r.p}: ${o.tables} in the text, ${r.tables} drawn`);
    if (r.pres < o.fences) codeMiss.push(`${r.p}: ${o.fences} in the text, ${r.pres} drawn`);
    for (const im of r.imgs) {
      if (im.ok) { imgsSeen++; continue; }
      // A web image needs the network, and this test runs without one on purpose.
      if (/^https?:/i.test(im.src)) { webImgs++; continue; }
      // Is the file really there? An embed that was already broken is not the app's fault.
      const rel = (im.src.match(/attachments\/[^?#]+/) || [])[0];
      if (!rel || !fs.existsSync(`${VAULT}/${rel}`)) missingOnDisk.push(`${r.p} → ${rel || im.src}`);
      else brokenImg.push(`${r.p} → ${im.src.slice(0, 90)}`);
    }
  }
}
check(`every table is drawn (${tablesSeen})`, tableMiss.length === 0, `${tableMiss.length} notes:\n        ${tableMiss.slice(0, 8).join('\n        ')}`);
check(`every code block is drawn (${codeSeen})`, codeMiss.length === 0, `${codeMiss.length} notes:\n        ${codeMiss.slice(0, 8).join('\n        ')}`);
if (webImgs) info(`${webImgs} web image(s) not fetched (no network in the test)`);
check(`every image that exists in the vault loads (${imgsSeen})`, brokenImg.length === 0, `${brokenImg.length}:\n        ${brokenImg.slice(0, 8).join('\n        ')}`);
if (missingOnDisk.length) info(`${missingOnDisk.length} image link(s) point at a file that is not in the vault: ${missingOnDisk.slice(0, 4).join('; ')}`);

// ── 4. Write ────────────────────────────────────────────────────────────────────────
console.log('\n── 4. scrittura: spazi, tab, righe vuote, accenti');
const SAMPLE = [
  'Riga normale con àèéìòù e un emoji 🚀',
  '    quattro spazi davanti',
  '\tun tab davanti',
  'tre spazi in fondo   ',
  'spazi    in    mezzo',
  '',
  '',
  'dopo due righe vuote',
  '  - elenco rientrato',
  '      - sotto-elenco',
  '',
].join('\n');
await ev(`(async () => { await createNewNote(''); setViewMode('edit'); })()`, 30000);
await sleep(800);
const newPath = await ev('state.currentPath');
check('a new note is created and open', typeof newPath === 'string' && newPath.endsWith('.md'), String(newPath));
await ev(`(() => { _cmHandle.focus(); _cmHandle.setSelection(0, 0); })()`);
// Input.insertText goes through the same input path as a keyboard/IME.
await send('Input.insertText', { text: SAMPLE });
await sleep(300);
// And a line typed key by key, spaces included.
const TYPED = 'digitato  a  mano ';
for (const ch of TYPED) {
  const code = ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase();
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code, windowsVirtualKeyCode: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0) });
}
await sleep(300);
const typedVal = await ev('editor.value');
check('typed text is in the editor exactly', typedVal === SAMPLE + TYPED, JSON.stringify({ got: typedVal, want: SAMPLE + TYPED }));

// The same block, pasted.
await ev(`(() => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); _cmHandle.focus();
  const el = document.querySelector('#cm-mount .cm-content'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify('\n' + SAMPLE)});
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await sleep(500);
const pastedVal = await ev('editor.value');
check('pasted text is in the editor exactly', pastedVal === SAMPLE + TYPED + '\n' + SAMPLE, JSON.stringify(pastedVal.slice(-160)));

// ── 5. Insert: table, code, photo ───────────────────────────────────────────────────
console.log('\n── 5. inserimento: tabella, codice, foto');
await ev(`(() => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); insertTable(3, 3); })()`);
await sleep(300);
const afterTable = await ev('editor.value');
check('the toolbar table is inserted as its own block', (pastedVal + afterTable.slice(pastedVal.length)).endsWith('\n\n|     |     |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |\n'),
  JSON.stringify(afterTable.slice(pastedVal.length)));
const CODE = 'def f(x):\n    if x:\n\treturn "tab"\n    return  None  \n\n# fine';
await ev(`(() => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); _cmHandle.focus(); handleToolbarCmd('code'); })()`);
await sleep(300);
await ev(`(() => { const el = document.querySelector('#cm-mount .cm-content'); const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(CODE)});
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await sleep(400);
const afterCode = await ev('editor.value');
check('code pasted into a code block keeps its spaces and tabs', afterCode.includes('```\n' + CODE + '\n```') || afterCode.includes('```' + '\n' + CODE), JSON.stringify(afterCode.slice(afterTable.length)));

// A photo, pasted as bytes the way a screenshot arrives.
const PNG = fs.readFileSync(`${REPO}/src/renderer/${fs.readdirSync(`${REPO}/src/renderer`).find((f) => f.endsWith('.png')) || ''}`, { flag: 'r' });
const imgsBefore = new Set(fs.existsSync(`${VAULT}/attachments/images`) ? fs.readdirSync(`${VAULT}/attachments/images`) : []);
await ev(`(async () => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); _cmHandle.focus();
  const bytes = Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}), c => c.charCodeAt(0));
  const dt = new DataTransfer(); dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  document.querySelector('#cm-mount .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await sleep(2000);
const newImgs = fs.readdirSync(`${VAULT}/attachments/images`).filter((f) => !imgsBefore.has(f));
const afterImg = await ev('editor.value');
check('the pasted photo is stored in attachments/images/', newImgs.length === 1 && fs.readFileSync(`${VAULT}/attachments/images/${newImgs[0]}`).equals(PNG), JSON.stringify(newImgs));
check('and linked in the note', newImgs.length === 1 && afterImg.includes(`attachments/images/${newImgs[0]}`), JSON.stringify(afterImg.slice(-120)));

// Save, then the file must be the editor, byte for byte.
await ev('saveCurrentNote()', 30000);
await sleep(1200);
const diskNew = fs.readFileSync(`${VAULT}/notes/${newPath}`, 'utf8');
const finalVal = await ev('editor.value');
check('saved: the file holds exactly what the editor holds', stripFm(diskNew) === finalVal, JSON.stringify({ disk: stripFm(diskNew).slice(0, 120), ed: finalVal.slice(0, 120) }));
check('and it has Amelie\'s dates on top', /^---\ncreated: \d{4}-\d\d-\d\d \d\d:\d\d\nmodified: /.test(diskNew), JSON.stringify(diskNew.slice(0, 70)));

// Render it.
await ev(`setViewMode('view')`); await sleep(1500);
const newView = await ev(`(async () => { const pc = document.getElementById('preview-content'); const im = [...pc.querySelectorAll('img')];
  for (let i = 0; i < 60 && im.some(x => !x.complete); i++) await new Promise(r => setTimeout(r, 50));
  return { tables: pc.querySelectorAll('table').length, rows: pc.querySelector('table') ? pc.querySelector('table').rows.length : 0,
    code: [...pc.querySelectorAll('pre code')].map(c => c.textContent), img: im.map(x => x.naturalWidth),
    spaces: pc.textContent.includes('spazi    in    mezzo') || pc.innerHTML.includes('spazi    in    mezzo') }; })()`);
check('the reading view draws the table (3 rows)', newView.tables === 1 && newView.rows === 3, JSON.stringify(newView));
check('the code block, with its indentation', newView.code.some((c) => c.replace(/\n$/, '') === CODE), JSON.stringify(newView.code));
check('and the photo', newView.img.length === 1 && newView.img[0] > 0, JSON.stringify(newView.img));

// Close, reopen: the same text comes back.
await ev(`(async () => { const i = tabs.findIndex(t => t.path === ${JSON.stringify(newPath)}); await closeTab(i); })()`);
await sleep(500);
const reopened = await ev(`window.__open(${JSON.stringify(newPath)}, 'edit').then(r => r.val)`);
{ const a = String(reopened), b = finalVal; let k = 0; while (k < a.length && k < b.length && a[k] === b[k]) k++;
  check('closed and reopened, the note is unchanged', a === b,
    `reopened ${a.length} chars, before ${b.length}; first difference at ${k}: ${JSON.stringify({ reopened: a.slice(Math.max(0, k - 20), k + 40), before: b.slice(Math.max(0, k - 20), k + 40) })}`); }

// ── 6. Edit an imported note ────────────────────────────────────────────────────────
console.log('\n── 6. modifica di una nota importata');
const victim = withShape.find((o) => o.p.startsWith('obsidian-sync/') && o.tables && o.fences && o.imgs) || withShape.find((o) => o.p.startsWith('obsidian-sync/'));
const vDisk0 = fs.readFileSync(`${VAULT}/notes/${victim.p}`, 'utf8');
const vCreated = (vDisk0.match(/^created: (.+)$/m) || [])[1];
await ev(`window.__open(${JSON.stringify(victim.p)}, 'edit')`);
// Opening puts the caret back at the top a moment AFTER openNote resolves — a person
// clicks once the note is up, so wait for that, then check the caret really is at the end.
await sleep(1000);
const caret = await ev(`(() => { const len = _cmHandle.getValue().length; _cmHandle.setSelection(len, len); _cmHandle.focus();
  return _cmHandle.view.state.selection.main.head === len; })()`);
check('the caret can be put at the end of the imported note', caret === true, String(caret));
await send('Input.insertText', { text: '\nriga aggiunta dal test  ' });
await ev('saveCurrentNote()', 30000);
await sleep(1200);
const vDisk1 = fs.readFileSync(`${VAULT}/notes/${victim.p}`, 'utf8');
info(`note: ${victim.p} (${victim.tables} tables, ${victim.fences} code, ${victim.imgs} images)`);
check('the added line is saved and nothing else in the note moved', stripFm(vDisk1) === stripFm(vDisk0) + '\nriga aggiunta dal test  ', (() => { const x = stripFm(vDisk1), y = stripFm(vDisk0) + '\nriga aggiunta dal test  '; let k = 0; while (k < x.length && x[k] === y[k]) k++;
    return `lengths ${stripFm(vDisk0).length} → ${x.length}; first difference at ${k}: ${JSON.stringify({ saved: x.slice(Math.max(0, k - 40), k + 60), expected: y.slice(Math.max(0, k - 40), k + 60) })}`; })());
check('its created date is kept', vCreated && (vDisk1.match(/^created: (.+)$/m) || [])[1] === vCreated, `${vCreated} → ${(vDisk1.match(/^created: (.+)$/m) || [])[1]}`);

// ── 7. The largest note ─────────────────────────────────────────────────────────────
console.log('\n── 7. la nota più grande');
const biggest = [...withShape].sort((a, b) => b.body.length - a.body.length)[0];
const bo = await ev(`window.__open(${JSON.stringify(biggest.p)}, 'edit').then(r => ({ ms: r.ms, len: r.val.length }))`);
info(`${biggest.p}: ${biggest.body.length} chars, opened in ${bo.ms?.toFixed(0)} ms`);
await ev(`(() => { _cmHandle.setSelection(0, 0); _cmHandle.focus(); })()`);
const t0 = Date.now();
for (const ch of 'velocita') {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Key' + ch.toUpperCase(), windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
}
const perKey = (Date.now() - t0) / 8;
const bigVal = await ev('editor.value.slice(0, 8)');
check('typing in it lands', bigVal === 'velocita', JSON.stringify(bigVal));
check('at under 50 ms a keystroke', perKey < 50, `${perKey.toFixed(1)} ms`);
info(`${perKey.toFixed(1)} ms per keystroke, round trip included`);

// ── The source was never touched ────────────────────────────────────────────────────
const srcTouched = mdOnDisk.filter((f) => { try { return fs.statSync(`${SOURCE}/notes/${f}`).mtimeMs !== mtimes0.get(f); } catch (_) { return true; } });
check('the real vault was not touched', srcTouched.length === 0, srcTouched.slice(0, 5).join(', '));

const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { ws.close(); } catch (_) {}
cleanup();
await sleep(400);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
