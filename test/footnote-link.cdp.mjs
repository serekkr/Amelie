// `[[3]](https://…)` is a LINK whose label is `[3]`, not a wiki-link.
//
// It is the footnote shape every web clipper writes, and serekkr's ReadItLater notes
// are full of it. Read as a wiki-link, the reading view turned it into a dead "3"
// pointing at a note that does not exist, with the real address printed beside it in
// brackets — the link was destroyed on the way to the screen. In the editor only the
// `[[3]]` half was painted blue, which is how he spotted it.
//
// Both views are checked here, because the two have their own parsers: the reading view
// rewrites wiki-links before marked sees them, the editor paints links with a regex
// over the visible range.
//
//   run: npm run test:footnote     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const PORT = 9391;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-footnote-'));
const HOME = `${ROOT}/home`, VAULT = `${HOME}/vault`;
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/fn.md`, '---\ncreated: 2026-10-13 09:00\n---\n\n'
  + 'Footnote NTLMv2 relay attacks.[[3]](https://esempio.it/pagina.html) and on.\n\n'
  + 'Plain [Filter Network Traffic](https://attack.mitre.org/x) and on.\n\n'
  + 'Wiki [[Altra nota]] and on.\n\n'
  + '```\nif [[ "$c" == */* ]]; then\n```\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));

const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
const env = { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined };
const child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
process.on('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} fs.rmSync(ROOT, { recursive: true, force: true }); });
let err = ''; child.stderr.on('data', d => { err += d; });
setTimeout(() => { console.error('TIMEOUT\n' + err.slice(-1000)); process.exit(2); }, 90000);

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('no app\n' + err.slice(-1000)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise(res => { const my = ++id; pend.set(my, res); ws.send(JSON.stringify({ id: my, method, params })); setTimeout(() => { if (pend.delete(my)) res(null); }, 20000); });
const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }))?.result?.result?.value;
await sleep(2000);

const ok = []; const say = (n, pass, d = '') => { ok.push(!!pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${d}`}`); };

await ev(`openNote((state.notes||[]).find(n => n.name === 'fn'))`);
await sleep(1200);
await ev(`setViewMode('view')`);
await sleep(1000);
const html = await ev(`JSON.stringify([...document.querySelectorAll('#preview-content p')].map(p => p.innerHTML))`);
const paras = JSON.parse(html);
say('the footnote is a real link to its address', /<a href="https:\/\/esempio\.it\/pagina\.html">\[3\]<\/a>/.test(paras[0] || ''), paras[0]);
say('and it is not a dead note-link to "3"', !/data-note="3"/.test(paras[0] || ''), paras[0]);
say('a plain markdown link is untouched', /<a href="https:\/\/attack\.mitre\.org\/x">Filter Network Traffic<\/a>/.test(paras[1] || ''), paras[1]);
say('a real wiki-link is still a note-link', /data-note="Altra nota"/.test(paras[2] || ''), paras[2]);

await ev(`setViewMode('edit')`);
await sleep(900);
const blue = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#cm-mount .cm-md-link')].map(e => e.textContent))`));
say('in the editor the WHOLE footnote link is blue, address included',
  blue.includes('[[3]](https://esempio.it/pagina.html)'), JSON.stringify(blue));
say('the plain link is still blue whole', blue.includes('[Filter Network Traffic](https://attack.mitre.org/x)'), JSON.stringify(blue));
say('the wiki-link is still blue', blue.includes('[[Altra nota]]'), JSON.stringify(blue));
say('and bash inside a fence is left alone', !blue.some(t => t.includes('$c')), JSON.stringify(blue));

console.log(`\n${ok.every(Boolean) ? `all ${ok.length}` : `${ok.filter(Boolean).length}/${ok.length}`} passed`);
process.exit(ok.every(Boolean) ? 0 : 1);
