// Starting Amelie while Amelie is already open must not crash it.
//
// On 2026-10-09 11:31 the user launched Amelie twice about a second apart. The
// first instance was fine; the second dumped core two seconds later and KDE put
// a crash dialog on screen (coredumpctl: pid 969799, SIGSEGV):
//
//   #0 gbm_device_get_fd (libgbm.so.1)   rdi = 0xefefefefefefefef
//   #1 dri2_initialize_drm (libEGL_mesa.so.0)
//   #2 eglInitialize
//
// 0xEF is PartitionAlloc's freed-memory poison: the gbm device had already been
// freed when the GL thread read it. The loser of the single-instance lock used
// to call app.quit(), which pre-'ready' does not stop the startup already in
// flight — and `in-process-gpu` (startupFlags.js, unconditional) puts that GL
// thread inside this very process, so the teardown and eglInitialize race.
// It reproduced 9 times in 30 on the installed v1.0.130 build, 10 in 30 here.
// app.exit(0) ends the process at once instead; 0 in 60 after the change.
//
// Needs a display (the crash is in real GL init, so there is nothing to stub) —
// hence opt-in, not part of `npm test`. Under Xvfb it works too; see
// test/README or the cdp tests for the xvfb-run setup.
//
//   run: npm run test:secondinstance        (optionally: ... -- 40)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const ROUNDS = Number(process.argv[2]) || 20;

// At ~1 crash in 3, 20 rounds miss a live bug about 3 times in 10000.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-2nd-'));
fs.mkdirSync(path.join(HOME_DIR, '.local', 'share', 'amelie'), { recursive: true });
for (const d of ['notes', 'attachments', 'todo']) {
  fs.mkdirSync(path.join(HOME_DIR, 'vault', d), { recursive: true });
}
fs.writeFileSync(
  path.join(HOME_DIR, '.local', 'share', 'amelie', 'amelie.json'),
  JSON.stringify({ vaultPath: path.join(HOME_DIR, 'vault'), encryption: { enabled: false } }),
);

const env = { ...process.env, HOME: HOME_DIR };
const launch = (opts) => spawn(ELECTRON, [ROOT, '--class=amelie'], { env, stdio: 'ignore', ...opts });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let first;
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

try {
  first = launch({ detached: true });
  await sleep(6000);                      // let it take the lock and finish starting
  check('the first instance stays up', first.exitCode === null,
        first.exitCode === null ? '' : `exited with ${first.exitCode}`);

  const codes = [];
  for (let i = 0; i < ROUNDS; i++) {
    const r = spawnSync(ELECTRON, [ROOT, '--class=amelie'], { env, stdio: 'ignore', timeout: 20000 });
    codes.push(r.signal || r.status);
  }
  const segv = codes.filter((c) => c === 'SIGSEGV').length;
  const clean = codes.filter((c) => c === 0).length;
  check(`no second instance segfaults (${ROUNDS} launches)`, segv === 0, `${segv} SIGSEGV`);
  check('every second instance exits cleanly', clean === ROUNDS,
        `${clean}/${ROUNDS} exited 0 — got ${JSON.stringify([...new Set(codes)])}`);
  check('the first instance survived them all', first.exitCode === null,
        first.exitCode === null ? '' : `exited with ${first.exitCode}`);
} finally {
  try { process.kill(-first.pid, 'SIGKILL'); } catch (_) {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch (_) {}
}

for (const r of results) console.log(`${r.pass ? 'ok   ' : 'FAIL '} ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(bad ? `\n${bad} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(bad ? 1 : 0);
