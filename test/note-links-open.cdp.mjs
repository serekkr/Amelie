// A link to another note opens it from the reading view — markdown links included.
//
// Checked 2026-09-30 against the user's vault: 161 links between notes are written
// the markdown way, `[Legacy - Easy](Legacy.md)` (an Obsidian import writes them so).
// The reading view only opened [[links]] and web addresses: a click on one of these
// did NOTHING. Now they open the note — relative to the note's folder, from the
// vault root, or by name — and "back" returns, as for a [[link]]. A [[link]] whose
// folders no longer exist finds the note by its name.
//
// Drives the real app: the real reading view, real clicks on the rendered links.
//
//   run: npm run test:notelinks     (uses xvfb-run when installed, else $DISPLAY)
import fs from 'node:fs';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const HOME = '/tmp/amelie-notelinks'; const VAULT = `${HOME}/vault`;
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
const w = (rel, body) => { fs.mkdirSync(`${VAULT}/notes/${rel}`.replace(/\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(`${VAULT}/notes/${rel}`, fm + body); };
w('Boxes/README.md', ['- [Legacy - Easy](Legacy.md)', '- [Heist](Heist%20Box.md#enum)', '- [Lame](<Lame box.md>)', '- [Su](../Altro/Sopra.md)',
  '- [Vecchio percorso](3%20-%20Courses/Box/Forest🛰.md)', '- [[old-folder/Sopra]]', '- [sito](https://example.com/a.md)', '- [manca](Inesistente.md)'].join('\n') + '\n');
for (const n of ['Legacy', 'Heist Box', 'Lame box', 'Forest']) w(`Boxes/${n}.md`, n + '\n');
w('Altro/Sopra.md', 'sopra\n');
w('Boxes/Lunga.md', ['- [Vai al banner](#grab-the-damn-banner)\n- [Anche così](Lunga🛰.md#grab-the-damn-banner)', ...Array.from({ length: 80 }, (_, i) => `Paragrafo ${i}.`), '## Grab the damn banner 🛰', ...Array.from({ length: 80 }, (_, i) => `Dopo ${i}.`)].join('\n\n') + '\n');
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
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

const openReadme = `(async () => { await loadTree(); await openNote(flattenTree(state.notes).find((n) => n.path === 'Boxes/README.md')); setViewMode('view'); await new Promise((r) => setTimeout(r, 700)); return 1; })()`;
const clickLink = (text) => `(async () => { const a = [...document.querySelectorAll('#preview-content a')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!a) return 'no link'; a.click(); await new Promise((r) => setTimeout(r, 700)); return state.currentPath; })()`;

await session(9581, async (ev) => {
  for (const [text, want, what] of [
    ['Legacy - Easy', 'Boxes/Legacy.md', 'a markdown link in the same folder'],
    ['Heist', 'Boxes/Heist Box.md', 'one with %20 and a #heading'],
    ['Lame', 'Boxes/Lame box.md', 'one written <with spaces.md>'],
    ['Su', 'Altro/Sopra.md', 'one going ../ to the folder above'],
    ['Vecchio percorso', 'Boxes/Forest.md', 'one whose old folders are gone, by the note’s name'],
    ['old-folder/Sopra', 'Altro/Sopra.md', 'a [[folder/note]] whose folder is gone, by the note’s name'],
  ]) {
    await ev(openReadme);
    const got = await ev(clickLink(text));
    check(`${what} opens the note`, got === want, `${text} → ${got}`);
  }
  await ev(openReadme);
  await ev(clickLink('Legacy - Easy'));
  const back = await ev(`(async () => { const p = _noteBackStack.pop(); if (p) await openNote(flattenTree(state.notes).find((n) => n.path === p)); await new Promise((r) => setTimeout(r, 500)); return state.currentPath; })()`);
  check('and "back" returns to the note it was followed from', back === 'Boxes/README.md', String(back));
  await ev(openReadme);
  check('a link to a note that does not exist leaves you where you are', (await ev(clickLink('manca'))) === 'Boxes/README.md');
  const web = await ev(`(() => { const a = [...document.querySelectorAll('#preview-content a')].find((x) => x.textContent.trim() === 'sito'); return a && !a.classList.contains('md-note-link'); })()`);
  check('a web address ending in .md is still a web link', web === true);
  // Links to a heading of the same note scroll to it.
  for (const text of ['Vai al banner', 'Anche così']) {
    await ev(`(async () => { await openNote(flattenTree(state.notes).find((n) => n.path === 'Boxes/Lunga.md')); setViewMode('view'); await new Promise((r) => setTimeout(r, 700)); document.getElementById('preview-pane').scrollTop = 0; (document.querySelector('#preview-content')?.closest('[style*=overflow], #preview-pane') || document.getElementById('preview-pane')).scrollTop = 0; return 1; })()`);
    await ev(clickLink(text)); await sleep(700);
    const pos = await ev(`(() => { const h = [...document.querySelectorAll('#preview-content h2')].find((x) => /banner/i.test(x.textContent)); const r = h.getBoundingClientRect(); return JSON.stringify({ top: Math.round(r.top), vh: innerHeight, path: state.currentPath }); })()`);
    const p = JSON.parse(pos);
    check(`"${text}" scrolls to the heading, staying in the note`, p.path === 'Boxes/Lunga.md' && p.top >= 0 && p.top < p.vh * 0.6, pos);
  }
});

fs.rmSync(HOME, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
