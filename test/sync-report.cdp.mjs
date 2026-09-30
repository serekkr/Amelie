// After a sync of thousands of files, the bell holds ONE line — and it opens the list.
//
// Asked 2026-09-30: "come possiamo far vedere l'elenco dopo sync se faccio sync di
// 2000 file". The row carries the totals (↓ ↑ ✕ ⚠) and opens a report: conflicts
// and deletions first and open, uploads and downloads folded by folder, a search
// over every name, and a click on a file opens it.
//
// Drives the real app: a report on disk where SyncManager keeps them, the status
// event the engine sends, the real bell and the real modal.
//
//   run: npm run test:syncreport     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-syncreport'; const VAULT = `${HOME}/vault`;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch {
  xvfb = false;
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no xvfb-run and no display'); process.exit(0); }
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`); };

fs.rmSync(HOME, { recursive: true, force: true });
const fm = '---\ncreated: 2026-09-01 10:00\n---\n\n';
fs.mkdirSync(`${VAULT}/notes/Lavoro`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes/Casa`, { recursive: true });
const files = [];
for (let i = 0; i < 1500; i++) { const f = `notes/Lavoro/n${i}.md`; if (i < 3) fs.writeFileSync(`${VAULT}/${f}`, fm + 'x\n'); files.push(['down', f]); }
for (let i = 0; i < 495; i++) files.push(['down', `notes/Casa/c${i}.md`]);
files.push(['up', 'notes/Casa/spesa.md']); fs.writeFileSync(`${VAULT}/notes/Casa/spesa.md`, fm + 'latte\n');
files.push(['del-remote', 'notes/vecchia.md'], ['del-local', 'notes/Casa/tolta.md']);
files.push(['conflict', 'notes/Lavoro/piano.md', 'notes/Lavoro/piano (conflitto 2026-09-30).md']);
const counts = { up: 1, down: 1995, delRemote: 1, delLocal: 1, conflict: 1, total: 1999 };
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.writeFileSync(`${HOME}/.local/share/amelie/sync-reports.json`, JSON.stringify([{ id: 'rtest', at: new Date().toISOString(), manual: false, counts, files }]));
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

async function session(port, body) {
  const eargs = ['.', `--remote-debugging-port=${port}`, '--no-sandbox', '--password-store=basic'];
  const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
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
        const cdp = (method, params) => new Promise((res) => { const my = ++id; pend.set(my, (m) => res(m.result)); ws.send(JSON.stringify({ id: my, method, params })); });
    await body(ev, cdp);
    ws.close();
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await sleep(500);
  }
}

await session(9521, async (ev, cdp) => {
  await ev(`(async () => { await loadTree(); return 1; })()`);
  // An automatic, "quiet" pass (every 30 s) that moved 1999 files: worth a line.
  await ev(`(logSyncEventNotif({ op: 'twoway', status: 'ok', manual: false, quiet: true, dests: ['samba'], report: { id: 'rtest', counts: ${JSON.stringify(counts)} } }), 1)`);
  await ev(`(document.getElementById('btn-notifications').click(), 1)`); await sleep(600);
  const row = await ev(`(() => { const r = document.querySelector('#notifications-list .notif-row.has-report'); return r ? r.textContent : null; })()`);
  check('the bell holds one line for the whole pass', !!row && (await ev(`document.querySelectorAll('#notifications-list .notif-row.has-report').length`)) === 1, String(row));
  check('with its totals', !!row && row.includes('↓ 1995') && row.includes('↑ 1') && row.includes('✕ 2') && row.includes('⚠ 1'), String(row));

  // A quiet pass that moved only a few files stays out of the bell.
  await ev(`(logSyncEventNotif({ op: 'twoway', status: 'ok', manual: false, quiet: true, report: { id: 'rsmall', counts: { up: 2, down: 1, delRemote: 0, delLocal: 0, conflict: 0, total: 3 } } }), renderNotificationsView(), 1)`);
  check('a quiet pass that moved three files adds no line', (await ev(`document.querySelectorAll('#notifications-list .notif-row.has-report').length`)) === 1);

  await ev(`(document.querySelector('#notifications-list .notif-row.has-report .simple-main').click(), 1)`); await sleep(800);
  const m = JSON.parse(await ev(`JSON.stringify((() => { const md = document.getElementById('syncreport-modal'); if (!md || md.style.display === 'none') return null;
    const secs = [...md.querySelectorAll('.sr-sec')].map((s) => ({ t: s.querySelector('summary').textContent.trim(), open: s.open }));
    return { secs, rows: md.querySelectorAll('.sr-file').length }; })())`));
  check('a click opens the report', !!m, 'no modal');
  check('conflicts and deletions first, open', !!m && /⚠/.test(m.secs[0].t) && m.secs[0].open && m.secs[1].open && m.secs[2].open, JSON.stringify(m && m.secs));
  check('downloads last, folded', !!m && /↓/.test(m.secs.at(-1).t) && m.secs.at(-1).t.includes('1995') && !m.secs.at(-1).open, JSON.stringify(m && m.secs));
  check('two thousand files are not two thousand rows on screen', !!m && m.rows < 20, String(m && m.rows));

  // Search: every name, folders opened to show the hits.
  await ev(`(() => { const s = document.querySelector('#syncreport-modal .sr-search'); s.value = 'n149'; s.dispatchEvent(new Event('input')); return 1; })()`); await sleep(400);
  const hits = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#syncreport-modal .sr-file')].map((r) => r.textContent))`));
  check('a search finds the files by name, among 1995', hits.length === 11 && hits.includes('n149.md') && hits.includes('n1499.md'), JSON.stringify(hits));

  // A downloaded note that exists opens.
  await ev(`(() => { const s = document.querySelector('#syncreport-modal .sr-search'); s.value = 'n1.md'; s.dispatchEvent(new Event('input')); return 1; })()`); await sleep(400);
  await ev(`(() => { const r = [...document.querySelectorAll('#syncreport-modal .sr-file')].find((x) => x.textContent === 'n1.md'); r.click(); return 1; })()`); await sleep(900);
  check('a click on a file opens that note and closes the report', (await ev('state.currentPath')) === 'Lavoro/n1.md'
    && (await ev(`document.getElementById('syncreport-modal').style.display`)) === 'none', await ev('state.currentPath'));
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
