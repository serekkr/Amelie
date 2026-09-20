// The Backup tab lists its four destinations; a destination's settings appear when
// you switch it ON.
//
// It used to show ONE destination at a time, picked from a row of pills, with the
// other three hidden — which is why a recap line had to sit underneath saying which
// of the hidden ones were actually enabled. Listing all four removes the problem the
// recap reported, so both went (2026-09-20).
//
// Checked here, against the running app: the four sections are all on screen, every
// body starts closed on a fresh profile, the pills and the recap are really gone, a
// header still opens by hand (so a destination can be set up before being switched
// on — Samba's header never worked, it was the pills opening it), switching one ON
// opens it and OFF folds it, and the switch refuses to stay on until the connection
// has been tested.
//
// The Sync tab gets the same shape, with one difference that is not cosmetic: its
// three methods are MUTUALLY EXCLUSIVE (the engine syncs with a single transport), so
// all three are listed but exactly one body is open — the selected one.
//
//   run: npm run test:bkdest    (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-bkdest'; const VAULT = `${HOME}/vault`; const PORT = 9381;
const SET = `${HOME}/.local/share/amelie/settings.json`;
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
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(`${HOME}/dest`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(SET, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (m, p) => new Promise(res => { const my = ++id; pending.set(my, r => res(r.result)); ws.send(JSON.stringify({ id: my, method: m, params: p })); setTimeout(() => { if (pending.delete(my)) res(null); }, 15000); });
const ev = x => send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }).then(r => r?.result?.value);
await sleep(2500);
await ev('openSettings()'); await sleep(900);
await ev(`document.querySelector('.tab-btn[data-tab="sync"]').click()`); await sleep(900);

const ok = [];
const say = (n, p, d = '') => { ok.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : '  — ' + d}`); };
const vis = id => ev(`(() => { const e = document.getElementById('${id}'); if (!e) return 'missing';
  return getComputedStyle(e).display === 'none' ? 'hidden' : 'shown'; })()`);

const KEYS = ['local', 'samba', 'vpn', 'webdav'];
for (const k of KEYS) say(`the ${k} destination is listed`, await vis('bksec-' + k) === 'shown', await vis('bksec-' + k));
say('the list has a heading saying what the switches are',
  await ev(`(document.querySelector('.bk-group-title')?.textContent || '').trim().length > 0`) === true,
  await ev(`document.querySelector('.bk-group-title')?.textContent`));
say('and it is translated, not the raw i18n key',
  !/sync\.dests_label/.test(await ev(`document.querySelector('.bk-group-title')?.textContent`) || 'x'),
  await ev(`document.querySelector('.bk-group-title')?.textContent`));
say('it sits ABOVE the first destination',
  await ev(`!!(document.querySelector('.bk-group-title')?.compareDocumentPosition(document.getElementById('bksec-local')) & Node.DOCUMENT_POSITION_FOLLOWING)`) === true);
say('the pills are gone', await ev(`!document.getElementById('bk-transport-pills')`) === true);
say('and so is the recap that existed because of them',
  await ev(`!document.getElementById('bk-dest-summary')`) === true);
for (const k of KEYS) say(`${k} starts closed on a fresh profile`, await vis('ssb-' + k) === 'hidden', await vis('ssb-' + k));

// A header still opens by hand — Samba's never did before: the pills opened it.
await ev(`document.getElementById('ssh-samba').click()`); await sleep(300);
say('the Samba header opens by hand (it never did before)', await vis('ssb-samba') === 'shown', await vis('ssb-samba'));
await ev(`document.getElementById('ssh-samba').click()`); await sleep(300);
say('and closes again', await vis('ssb-samba') === 'hidden', await vis('ssb-samba'));

// The gate: switching Local on before the path is tested must not stick.
await ev(`document.getElementById('cfg-local-path').value = ${JSON.stringify(HOME + '/dest')};
          document.getElementById('cfg-local-path').dispatchEvent(new Event('input', { bubbles: true }))`);
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('an untested Local path cannot switch the destination on',
  await ev(`document.getElementById('cfg-local-enabled').checked === false`) === true);
say('and its settings stay closed', await vis('ssb-local') === 'hidden', await vis('ssb-local'));

// Test the path, then it may.
await ev(`document.getElementById('ssh-local').click()`); await sleep(300);
await ev(`document.getElementById('btn-test-local').click()`); await sleep(1200);
say('the path test passes', /✓/.test(await ev(`document.getElementById('local-test-result').textContent`) || ''),
  await ev(`document.getElementById('local-test-result').textContent`));
await ev(`document.getElementById('ssh-local').click()`); await sleep(300);   // fold it again
say('folded before the switch, to prove the switch is what opens it', await vis('ssb-local') === 'hidden');
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('after the test the switch sticks', await ev(`document.getElementById('cfg-local-enabled').checked === true`) === true);
say('and switching it ON opened its settings', await vis('ssb-local') === 'shown', await vis('ssb-local'));
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('switching it OFF folds them away', await vis('ssb-local') === 'hidden', await vis('ssb-local'));

// ── Arriving at the tab always lands on the list ─────────────────────────────
// Even with a destination switched ON. Opening Settings used to expand every enabled
// one, so a profile with a live backup arrived at a wall of forms instead of four
// names (screenshot, 2026-09-20 — an enabled Local sitting collapsed is the target).
await ev(`document.getElementById('cfg-local-enabled').click()`); await sleep(500);
say('Local is on and showing its settings', 
  await ev(`document.getElementById('cfg-local-enabled').checked === true`) === true && await vis('ssb-local') === 'shown',
  await vis('ssb-local'));

await ev('closeSettings && closeSettings()'); await sleep(500);
await ev('openSettings()'); await sleep(900);
await ev(`document.querySelector('.tab-btn[data-tab="sync"]').click()`); await sleep(700);
say('reopening Settings keeps Local ON', await ev(`document.getElementById('cfg-local-enabled').checked === true`) === true);
say('but lands on the list, folded', await vis('ssb-local') === 'hidden', await vis('ssb-local'));
for (const k of KEYS) say(`${k} is folded on arrival`, await vis('ssb-' + k) === 'hidden', await vis('ssb-' + k));

// Leaving the tab and coming back does the same.
await ev(`document.getElementById('ssh-local').click()`); await sleep(400);
say('opening one by hand still works', await vis('ssb-local') === 'shown', await vis('ssb-local'));
await ev(`document.querySelector('.tab-btn[data-tab="general"]').click()`); await sleep(500);
await ev(`document.querySelector('.tab-btn[data-tab="sync"]').click()`); await sleep(700);
say('switching away and back folds it again', await vis('ssb-local') === 'hidden', await vis('ssb-local'));
say('and Local is still enabled — folding is not switching off',
  await ev(`document.getElementById('cfg-local-enabled').checked === true`) === true);

// ── The Sync tab: same list, one open at a time ──────────────────────────────
await ev(`document.querySelector('.tab-btn[data-tab="twoway"]').click()`); await sleep(900);
const TW = ['webdav', 'samba', 'vpn'];
for (const k of TW) say(`sync lists the ${k} method`, await vis('twsec-' + k) === 'shown', await vis('twsec-' + k));
say('the sync pills are gone too', await ev(`!document.getElementById('tw-transport-pills')`) === true);
say('and the list has its heading',
  await ev(`(document.querySelectorAll('.bk-group-title').length >= 2)`) === true,
  await ev(`document.querySelectorAll('.bk-group-title').length`));
const openCount = async () => {
  let n = 0;
  for (const k of TW) if (await vis('twsb-' + k) === 'shown') n++;
  return n;
};
say('with no method on, the tab is just the three names', await openCount() === 0, String(await openCount()));
for (const k of TW) say(`the ${k} method has a chevron`, await ev(`!!document.getElementById('twchevron-${k}')`) === true);

// Clicking a header opens that method — and folds the others, since only one can run.
await ev(`document.getElementById('twsh-webdav').click()`); await sleep(500);
say('clicking a header opens that method', await vis('twsb-webdav') === 'shown', await vis('twsb-webdav'));
say('and at most one is open', await openCount() === 1, String(await openCount()));
say('its chevron turned', await ev(`document.getElementById('twchevron-webdav').classList.contains('open')`) === true);
say('selecting did NOT switch it on',
  await ev(`document.getElementById('cfg-tw-webdav-enabled').checked === false`) === true);

// Clicking the SAME header again folds it — the Backup behaviour, asked for 2026-09-20.
await ev(`document.getElementById('twsh-webdav').click()`); await sleep(500);
say('clicking it again folds it away', await vis('twsb-webdav') === 'hidden', await vis('twsb-webdav'));
say('and the chevron turned back', await ev(`document.getElementById('twchevron-webdav').classList.contains('open')`) === false);
say('leaving nothing open', await openCount() === 0, String(await openCount()));

await ev(`document.getElementById('twsh-webdav').click()`); await sleep(400);
await ev(`document.getElementById('twsh-samba').click()`); await sleep(500);
say('picking another moves the open one', await vis('twsb-samba') === 'shown' && await vis('twsb-webdav') === 'hidden',
  (await vis('twsb-samba')) + '/' + (await vis('twsb-webdav')));

// Arriving lands on the list here too — the Backup rule, applied to Sync.
await ev(`document.querySelector('.tab-btn[data-tab="general"]').click()`); await sleep(500);
await ev(`document.querySelector('.tab-btn[data-tab="twoway"]').click()`); await sleep(700);
say('leaving Sync and coming back folds everything', await openCount() === 0, String(await openCount()));
await ev(`document.getElementById('twsh-vpn').click()`); await sleep(400);
say('and a header still opens by hand afterwards', await vis('twsb-vpn') === 'shown', await vis('twsb-vpn'));
await ev('closeSettings && closeSettings()'); await sleep(500);
await ev('openSettings()'); await sleep(900);
await ev(`document.querySelector('.tab-btn[data-tab="twoway"]').click()`); await sleep(700);
say('reopening Settings lands on the list as well', await openCount() === 0, String(await openCount()));

// In the collapsed phase the three rows must be INTERCHANGEABLE — same height, same
// fill. A body left open around a hidden panel is invisible as a bug but not as a row:
// it carries padding, a top rule and --bg-2, so it grows and changes colour. Reported
// 2026-09-20 with a screenshot of exactly that on Samba.
const rowMetrics = await ev(`(() => ['webdav','samba','vpn'].map(k => {
  const sec = document.getElementById('twsec-' + k);
  const cs = getComputedStyle(sec);
  return { k, h: Math.round(sec.getBoundingClientRect().height), bg: cs.backgroundColor };
}))()`);
const heights = rowMetrics.map(r => r.h);
// The rows sit in a list of their own so the tab panel's 20px flex gap applies once to
// the list, not between every pair. As direct children they were 28px apart — the gap
// PLUS an 8px margin, which add up in flexbox — on rows 49px tall.
const pitch = await ev(`(() => {
  const r = ['webdav','samba','vpn'].map(k => document.getElementById('twsec-' + k).getBoundingClientRect());
  return { gaps: r.slice(1).map((x, i) => Math.round(x.top - r[i].bottom)),
           headToFirst: Math.round(r[0].top - document.querySelector('#tab-twoway .bk-group-title').getBoundingClientRect().bottom) };
})()`);
// 16px: the rhythm the rest of Settings uses (User Interface stacks at 16 and 20,
// General at 22). Not the 28 it started at — gap plus margin — and not the 6 it briefly
// became, which read as a different panel from the rest of the window.
say('the rows sit on the same rhythm as the rest of Settings',
  pitch.gaps.every(g => g >= 12 && g <= 20), JSON.stringify(pitch));
say('and the heading is closer to its rows than they are to each other',
  pitch.headToFirst < pitch.gaps[0], JSON.stringify(pitch));

say('the three collapsed rows are the same height',
  Math.max(...heights) - Math.min(...heights) <= 1, JSON.stringify(rowMetrics));
// Not the section's own background — that is identical whatever happens inside, so
// comparing it would assert nothing. What differs is whether a BODY is rendered: the
// body is what carries --bg-2 and the padding, and one showing is the whole defect.
say('no collapsed row is rendering a body at all',
  await ev(`['webdav','samba','vpn'].every(k => getComputedStyle(document.getElementById('twsb-' + k)).display === 'none')`) === true,
  await ev(`['webdav','samba','vpn'].map(k => k + '=' + getComputedStyle(document.getElementById('twsb-' + k)).display).join(' ')`));

// The invariant behind it: a section is never open around a hidden panel.
const consistent = await ev(`(() => {
  const panel = { webdav: 'tw-webdav-panel', samba: 'tw-samba-panel' };
  return Object.entries(panel).every(([k, id]) => {
    const body = document.getElementById('twsb-' + k), p = document.getElementById(id);
    const bodyOpen = getComputedStyle(body).display !== 'none';
    const panelOpen = getComputedStyle(p).display !== 'none';
    return bodyOpen === panelOpen;
  });
})()`);
say('an open section always has its panel inside it', consistent === true, String(consistent));

// And it still holds once one is opened.
await ev(`document.getElementById('twsh-samba').click()`); await sleep(500);
say('opening Samba really shows the Samba fields',
  await ev(`getComputedStyle(document.getElementById('tw-samba-panel')).display !== 'none'`) === true,
  await ev(`getComputedStyle(document.getElementById('tw-samba-panel')).display`));
say('and its row is now taller than the folded ones',
  await ev(`document.getElementById('twsec-samba').getBoundingClientRect().height > document.getElementById('twsec-vpn').getBoundingClientRect().height`) === true);

const shot = await send('Page.captureScreenshot', { format: 'png' });
// Into the throwaway HOME, never the repo: a test must not leave a file behind in
// the working tree for someone to commit by accident.
if (shot?.data) { const out = `${HOME}/bkdest-shot.png`; fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log('screenshot: ' + out); }
console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
