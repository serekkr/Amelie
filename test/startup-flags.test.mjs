// A Chromium switch set before app 'ready' applies to every install, on every
// machine, forever — and three of them were workarounds for the one box Amelie
// was written on. They cost that: measured on a drawing with 12 shapes under a
// 5-second freehand stroke, on the real display,
//
//     software compositing + low-memory    34 fps    119% of a core   ← shipped
//     GPU compositing + low-memory         60 fps    106%
//     GPU compositing, no low-memory       60 fps     60%
//
// i.e. half the frame rate for twice the CPU, which is what "the draw goes in
// slow motion" turned out to be on a colleague's Ubuntu 26 LTS — a machine that
// never had the ghosting bug those switches were added for.
//
// So the rule these checks hold is not "these particular flags": it is that a
// workaround is opt-in and only what is right everywhere is unconditional.
//
//   run: npm test
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { startupFlags } = require(path.join(HERE, '../src/main/startupFlags.js'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push(!!pass);
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
};

// The switches a config asks for, as "name" or "name=value" — the shape you
// would read in `ps aux`.
const flagsOf = (cfg) => {
  const f = startupFlags(cfg);
  return f.switches.map(([n, v]) => (v === undefined ? n : `${n}=${v}`));
};
const has = (cfg, flag) => flagsOf(cfg).includes(flag);

// ── A fresh install pays for nothing it did not ask for ──────────────────────
// This is the check that would have caught it. Every flag below was on for
// everyone, and each one is a workaround for one machine's compositor, driver
// or memory budget.
for (const [why, flag] of [
  ['software compositing (halves the drawing frame rate)', 'disable-gpu-compositing'],
  ['low-end device mode (about a core of extra CPU while drawing)', 'enable-low-end-device-mode'],
  ['the 512 MB renderer heap', 'js-flags=--max-old-space-size=512'],
  ['software rendering', 'disable-gpu'],
]) {
  check(`a default install does NOT get ${why}`, !has({}, flag), `got: ${flagsOf({}).join(' ')}`);
}
check('a default install does not turn off hardware acceleration either',
  startupFlags({}).disableHardwareAcceleration === false, '');
// Reading no settings file at all must answer the same as reading an empty one.
check('no settings file yet answers exactly like an empty one',
  JSON.stringify(flagsOf(undefined)) === JSON.stringify(flagsOf({})),
  `${flagsOf(undefined).join(' ')}  vs  ${flagsOf({}).join(' ')}`);

// ── What IS right everywhere stays unconditional ─────────────────────────────
// Dropping these would be the opposite mistake: the keyring pair is what keeps
// KDE from popping a KWallet dialog at startup, on any distro.
for (const cfg of [{}, { softwareCompositing: true, lowMemory: true, disableGpu: true }]) {
  const label = Object.keys(cfg).length ? 'with every workaround on' : 'by default';
  check(`one in-process GPU ${label}`, has(cfg, 'in-process-gpu'), flagsOf(cfg).join(' '));
  check(`no OS keyring ${label}`, has(cfg, 'password-store=basic'), flagsOf(cfg).join(' '));
  check(`no portal secret request ${label}`,
    has(cfg, 'disable-features=SecretPortalKeyProvider'), flagsOf(cfg).join(' '));
}

// ── Each switch answers to its own setting, and only its own ─────────────────
check('softwareCompositing brings back software compositing',
  has({ softwareCompositing: true }, 'disable-gpu-compositing'), '');
check('...and nothing else with it',
  !has({ softwareCompositing: true }, 'enable-low-end-device-mode')
  && !has({ softwareCompositing: true }, 'disable-gpu'),
  flagsOf({ softwareCompositing: true }).join(' '));

check('lowMemory asks for low-end device mode',
  has({ lowMemory: true }, 'enable-low-end-device-mode'), '');
check('lowMemory caps the renderer heap in the same breath',
  has({ lowMemory: true }, 'js-flags=--max-old-space-size=512'), '');
check('...and does not touch compositing',
  !has({ lowMemory: true }, 'disable-gpu-compositing'), flagsOf({ lowMemory: true }).join(' '));

check('disableGpu asks for software rendering', has({ disableGpu: true }, 'disable-gpu'), '');
check('disableGpu is the one that also turns hardware acceleration off',
  startupFlags({ disableGpu: true }).disableHardwareAcceleration === true, '');
check('...while softwareCompositing leaves acceleration alone — raster stays on the GPU',
  startupFlags({ softwareCompositing: true }).disableHardwareAcceleration === false, '');

// All three together is a legitimate combination (the slowest possible one), and
// must not lose any of them.
{
  const all = { softwareCompositing: true, lowMemory: true, disableGpu: true };
  check('all three together keep all three',
    ['disable-gpu-compositing', 'enable-low-end-device-mode', 'js-flags=--max-old-space-size=512', 'disable-gpu']
      .every(f => has(all, f)), flagsOf(all).join(' '));
}

// A falsy value is not an opt-in. `false`, absent and 0 all mean the same thing.
for (const v of [false, 0, null, undefined, '']) {
  check(`softwareCompositing: ${JSON.stringify(v)} is not an opt-in`,
    !has({ softwareCompositing: v }, 'disable-gpu-compositing'), '');
}

// ── Report ───────────────────────────────────────────────────────────────────
const failed = results.filter(r => !r).length;
console.log(`\n${failed ? `${results.length - failed}/${results.length} —` : `all ${results.length} passed`}`);
process.exit(failed ? 1 : 0);
