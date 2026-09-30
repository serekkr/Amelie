// The sidebar keeps every item where it was after the vault comes back from a sync.
//
// Reported 2026-09-29: the vault was emptied, restored from the share, and 31
// attachments came back in a different order. Items with no saved place are
// ordered by creation date, and a file's creation date is the moment THIS disk
// wrote it — a download, a copy or a restore makes up a new one, and it cannot be
// set back. Two photos imported in the same second were even ordered by chance.
//
// Now the sidebar writes every place it shows into the order file (which syncs
// with the notes), so the order no longer depends on dates at all. This builds a
// vault, opens it, then RECREATES every file in reverse order — the dates scrambled
// on purpose, as a download does — and requires the same tree, item by item.
//
//   run: npm run test:treeorder      (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const ROOT = '/tmp/amelie-treeorder';
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 150000);

const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

// A 1×1 PNG, varied by one byte so every file differs.
const png = (i) => { const b = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c63f8cfc0f01f0005000201' + 'e5270de20000000049454e44ae426082', 'hex'); b[b.length - 5] = i & 0xff; return b; };

function buildVault(v) {
  fs.mkdirSync(`${v}/notes/Work/Clients`, { recursive: true });
  fs.mkdirSync(`${v}/notes/Home`, { recursive: true });
  fs.mkdirSync(`${v}/attachments/images`, { recursive: true });
  fs.mkdirSync(`${v}/todo`, { recursive: true });
  const fm = (d) => `---\ncreated: 2026-09-${d} 10:00\nmodified: 2026-09-${d} 10:00\n---\n\n`;
  // Photos created in one order, used from notes in several folders; two share a
  // second, like an import does.
  const imgs = [];
  for (let i = 0; i < 12; i++) { const n = `shot-${String.fromCharCode(109 - i)}.png`; fs.writeFileSync(`${v}/attachments/images/${n}`, png(i)); imgs.push(n); }
  fs.writeFileSync(`${v}/notes/Work/Clients/acme.md`, fm(10) + imgs.slice(0, 5).map((n) => `![](attachments/images/${n})`).join('\n') + '\n');
  fs.writeFileSync(`${v}/notes/Work/plan.md`, fm(11) + imgs.slice(5, 8).map((n) => `![](attachments/images/${n})`).join('\n') + '\n');
  fs.writeFileSync(`${v}/notes/Home/list.md`, fm(12) + `![](attachments/images/${imgs[8]})\n`);
  for (const n of ['zeta.md', 'alpha.md', 'mid.md']) fs.writeFileSync(`${v}/notes/${n}`, fm(13) + n + '\n');
  // imgs 9..11 are used by nothing → listed at the root.
}

// Same content, every file written again in REVERSE order: new creation dates, new
// directory order — what a download or a restore leaves behind.
function recreateReversed(src, dst) {
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { fs.mkdirSync(path.join(dst, path.relative(src, p)), { recursive: true }); walk(p); } else files.push(p); } })(src);
  for (const f of files.sort().reverse()) { fs.writeFileSync(path.join(dst, path.relative(src, f)), fs.readFileSync(f)); execSync('sleep 0.01'); }
}

async function openAndList(home, port) {
  fs.mkdirSync(`${home}/.local/share/amelie`, { recursive: true });
  fs.writeFileSync(`${home}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: `${home}/vault`, encryption: { enabled: false } }));
  fs.writeFileSync(`${home}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
  const eargs = ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic'];
  const env = { ...process.env, HOME: home, ELECTRON_RUN_AS_NODE: undefined };
  const child = xvfb
    ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'], { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: 'ignore' })
    : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: 'ignore' });
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {} }
    if (!target) throw new Error('app did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); pend.get(m.id)?.(m); };
    const ev = (x) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result?.result?.value)); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); });
    await sleep(3000);
    await ev(`(async () => { await loadTree(); ['Work', 'Work/Clients', 'Home'].forEach((d) => state.openFolders.add(d)); renderTree(); return 1; })()`);
    await sleep(1500);
    const list = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#file-tree [data-path]')].map((e) => e.dataset.path))`));
    ws.close();
    return list;
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

fs.rmSync(ROOT, { recursive: true, force: true });
const A = `${ROOT}/a`, B = `${ROOT}/b`;
buildVault(`${A}/vault`);
const first = await openAndList(A, 9411);
const order = JSON.parse(fs.readFileSync(`${A}/vault/notes/.amelie-order.json`, 'utf8'));
const placed = new Set(Object.values(order).flat());
check('the tree shows the vault: 6 notes, 12 photos', first.length === 18, JSON.stringify(first));
check('every item shown now has a saved place', first.every((p) => placed.has(p)), JSON.stringify(first.filter((p) => !placed.has(p))));

recreateReversed(`${A}/vault`, `${B}/vault`);
const bImgs = fs.readdirSync(`${B}/vault/attachments/images`).map((n) => [n, fs.statSync(`${B}/vault/attachments/images/${n}`).birthtimeMs]);
const aImgs = fs.readdirSync(`${A}/vault/attachments/images`).map((n) => [n, fs.statSync(`${A}/vault/attachments/images/${n}`).birthtimeMs]);
const rank = (xs) => xs.sort((x, y) => x[1] - y[1]).map((x) => x[0]).join();
check('the copy really has its dates scrambled', rank(aImgs) !== rank(bImgs));
const second = await openAndList(B, 9412);
check('after the files came back with new dates, the tree is identical item by item',
  JSON.stringify(first) === JSON.stringify(second),
  `first:  ${JSON.stringify(first)}\n        second: ${JSON.stringify(second)}`);

// The same copy WITHOUT the saved places must come out different, or this test
// could not tell the fix from luck.
fs.unlinkSync(`${B}/vault/notes/.amelie-order.json`);
const bare = await openAndList(B, 9413);
check('and without the saved places the dates would have reordered it', JSON.stringify(first) !== JSON.stringify(bare), JSON.stringify(bare));

fs.rmSync(ROOT, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
