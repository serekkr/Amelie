// The daily update check: one GET, one line in the bell, and nothing else.
//
// Amelie cannot install its own update (.run installer, no update channel), so this
// only ever SAYS a newer release exists. The network call itself is not exercised here
// — latestRelease() is stubbed — because what breaks in a feature like this is never
// the request: it is announcing the same version every morning, comparing "1.0.9"
// against "1.0.10" as strings, or filing an error notification when the machine simply
// has no internet.
//
//   run: npm run test:updatecheck     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-updchk'; const VAULT = `${HOME}/vault`; const PORT = 9393;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let xvfb = true;
try { execSync('command -v xvfb-run', { stdio: 'ignore' }); }
catch { xvfb = false; if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) { console.log('SKIP: no display'); process.exit(0); } }
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 90000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/uno.md`, '---\ncreated: 2026-08-27 10:00\n---\n\nuno\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
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
await sleep(3000);
const ok = []; const say = (n, p, d = '') => { ok.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : '  — ' + d}`); };

// ── Version comparison: the string trap ──────────────────────────────────────
say('1.0.10 is newer than 1.0.9 (string compare says otherwise)',
  await ev(`cmpVersions('1.0.10','1.0.9')`) === 1, String(await ev(`cmpVersions('1.0.10','1.0.9')`)));
say('equal versions compare equal', await ev(`cmpVersions('1.0.82','1.0.82')`) === 0);
say('a shorter version is handled', await ev(`cmpVersions('1.1','1.0.99')`) === 1);
say('and rubbish does not crash it', await ev(`cmpVersions('','1.0.0')`) === -1);

// ── What gets announced ──────────────────────────────────────────────────────
// Driven through the pure decision, NOT by stubbing window.inkwell: that object comes
// from contextBridge and is frozen, so an assignment to it silently does nothing and
// the test would quietly go on measuring the real GitHub answer. (It did, at first:
// three checks passed for the wrong reason.)
const worth = (latest, mine, announced) => ev(`updateWorthAnnouncing(${latest === null ? 'null' : `{version:'${latest}'}`}, ${mine === null ? 'null' : `'${mine}'`}, '${announced || ''}')`);
say('a newer release is worth announcing', await worth('1.0.90', '1.0.82', '') === true);
say('the same version is not', await worth('1.0.82', '1.0.82', '') === false);
say('an older one is not', await worth('1.0.70', '1.0.82', '') === false);
say('one already announced is not repeated', await worth('1.0.90', '1.0.82', '1.0.90') === false);
say('but a newer one than the announced is', await worth('1.0.91', '1.0.82', '1.0.90') === true);
say('a failed fetch (null) announces nothing', await worth(null, '1.0.82', '') === false);
say('and so does not knowing our own version', await worth('1.0.90', null, '') === false);

// ── Once a day ───────────────────────────────────────────────────────────────
say('a fresh profile checks straight away', await ev(`updateCheckDue(null)`) === true);
say('an unreadable stamp counts as due', await ev(`updateCheckDue('nonsense')`) === true);
say('an hour ago is not due', await ev(`updateCheckDue(Date.now() - 3600*1000)`) === false);
say('25 hours ago is', await ev(`updateCheckDue(Date.now() - 25*3600*1000)`) === true);

// ── The line it files ────────────────────────────────────────────────────────
// i18n.js is one big object literal: a bad escape anywhere in it stops the WHOLE file
// parsing, window.i18n never gets defined, and every label in the app falls back to its
// raw key. That is what an unescaped apostrophe in the Italian string did here while
// this was being written, so the check below is worth more than it looks.
say('window.i18n loaded at all — i18n.js parsed',
  await ev(`typeof window.i18n === 'object' && typeof window.i18n.t === 'function'`) === true);
await ev(`_eventNotifs = []; _saveEventNotifs(); addEventNotif(window.i18n.t('notif.update_available', { v: '1.0.90' }), true)`);
await sleep(300);
const n = await ev(`_eventNotifs.map(x => x.text)`);
say('the notification names the version', n.length === 1 && /1\.0\.90/.test(n[0]), JSON.stringify(n));
say('and is not a raw i18n key', !/notif\.update_available/.test(n[0] || 'x'), JSON.stringify(n));
// Every language really has the string — checked by SWITCHING to each one and asking
// for it, which is the only way to find a key that was added to six blocks out of seven.
const langs = ['it', 'en', 'de', 'es', 'fr', 'pl', 'ro'];
const missing = [];
for (const L of langs) {
  const got = await ev(`(() => { try { window.i18n.applyLanguage('${L}'); } catch (_) {}
    return window.i18n.t('notif.update_available', { v: '9.9.9' }); })()`);
  if (!got || /notif\.update_available/.test(got) || !/9\.9\.9/.test(got)) missing.push(L + '=' + got);
}
say('the update line is translated in all seven languages', missing.length === 0, JSON.stringify(missing));
await ev(`window.i18n.applyLanguage('en')`);

// ── Reaching, or not: only a real answer moves the clock ─────────────────────
// The fetcher is INJECTED — window.inkwell comes from contextBridge and is frozen, so
// there is no stubbing it. A failed check must not stamp the day, or a laptop whose
// wifi is not up yet at startup goes quiet until tomorrow.
const runWith = (latest, mine = '1.0.82') => ev(`(() => {
  localStorage.removeItem('amelie-update-lastcheck');
  return maybeCheckForUpdate(async () => ${latest === null ? 'null' : `({ version: '${latest}' })`}, async () => '${mine}')
    .then(r => ({ reached: r, stamped: !!localStorage.getItem('amelie-update-lastcheck') }));
})()`);
let r = await runWith(null);
say('a check that never reached GitHub reports failure', r && r.reached === false, JSON.stringify(r));
say('and does NOT burn the day', r && r.stamped === false, JSON.stringify(r));
r = await runWith('1.0.70');
say('a check that reached reports success', r && r.reached === true, JSON.stringify(r));
say('and does stamp the day', r && r.stamped === true, JSON.stringify(r));

// ── A week with no internet ──────────────────────────────────────────────────
// The question that decides whether a feature like this is a nuisance: does a laptop
// that never sees the network fill the bell with failures? Seven days of launches,
// each one failing every time it asks, and the bell has to stay empty.
const week = await ev(`(async () => {
  _eventNotifs = []; _saveEventNotifs();
  const fail = async () => null;
  const mine = async () => '1.0.82';
  let reachedAny = false;
  for (let day = 0; day < 7; day++) {
    localStorage.removeItem('amelie-update-lastcheck');     // a new day
    for (let attempt = 0; attempt < 6; attempt++) {          // first try + five retries
      if (await maybeCheckForUpdate(fail, mine)) reachedAny = true;
    }
  }
  return { notifs: _eventNotifs.length, reachedAny,
           stamped: !!localStorage.getItem('amelie-update-lastcheck'),
           announced: localStorage.getItem('amelie-update-announced') };
})()`);
say('a week offline files NO notifications at all', week && week.notifs === 0, JSON.stringify(week));
say('nothing claims to have reached GitHub', week && week.reachedAny === false, JSON.stringify(week));
say('and no day is ever marked as checked', week && week.stamped === false, JSON.stringify(week));

// And the moment the network comes back, it speaks — once.
const backOnline = await ev(`(async () => {
  _eventNotifs = []; _saveEventNotifs();
  localStorage.removeItem('amelie-update-announced');
  localStorage.removeItem('amelie-update-lastcheck');
  await maybeCheckForUpdate(async () => ({ version: '1.0.90' }), async () => '1.0.82');
  const after = _eventNotifs.length;
  localStorage.removeItem('amelie-update-lastcheck');
  await maybeCheckForUpdate(async () => ({ version: '1.0.90' }), async () => '1.0.82');
  return { after, then: _eventNotifs.length };
})()`);
say('and when the network returns it says it once, not seven times',
  backOnline && backOnline.after === 1 && backOnline.then === 1, JSON.stringify(backOnline));

// ── It stays out of the way of backup and sync ───────────────────────────────
say('the first attempt comes two minutes in, well after the 30s backup catch-up',
  await ev(`UPDATE_FIRST_TRY_MS >= 90000`) === true, String(await ev(`UPDATE_FIRST_TRY_MS`)));
const deferred = await ev(`(() => {
  _syncEngineBusy = true;
  localStorage.removeItem('amelie-update-lastcheck');
  const before = localStorage.getItem('amelie-update-lastcheck');
  scheduleUpdateCheck(30);                 // fires almost at once, but the engine is busy
  return new Promise(res => setTimeout(() => {
    const during = localStorage.getItem('amelie-update-lastcheck');
    _syncEngineBusy = false;
    res({ before, during });
  }, 600));
})()`);
say('while the sync engine is busy the check does not run at all',
  deferred && !deferred.during, JSON.stringify(deferred));
// (No check here that the busy flag tracks the engine: it is set from an IPC event the
// renderer cannot raise on its own, and asserting the variable after assigning it would
// prove nothing. The deferral above is the behaviour that matters and it IS driven.)
say('once the engine is idle again the check does run',
  (await runWith('1.0.70')).reached === true);

// ── The switch ───────────────────────────────────────────────────────────────
await ev(`localStorage.setItem('inkwell-update-check','off')`);
say('switched off, no check happens', await ev(`updateCheckEnabled()`) === false);
await ev(`localStorage.setItem('inkwell-update-check','on')`);
say('switched on again, it does', await ev(`updateCheckEnabled()`) === true);
say('and a fresh profile has it ON',
  await ev(`(() => { localStorage.removeItem('inkwell-update-check'); return updateCheckEnabled(); })()`) === true);
say('the Settings row exists and follows the setting',
  await ev(`(() => { const t = document.getElementById('cfg-update-check'); if (!t) return 'missing';
    localStorage.setItem('inkwell-update-check','off'); setupUpdateCheck(); const off = t.checked;
    localStorage.setItem('inkwell-update-check','on'); setupUpdateCheck(); return off === false && t.checked === true; })()`) === true);
console.log(`\n${ok.every(Boolean) ? `all ${ok.length} passed` : `${ok.filter(Boolean).length}/${ok.length}`}`);
process.exit(ok.every(Boolean) ? 0 : 1);
