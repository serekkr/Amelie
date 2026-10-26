// A note, folder or drawing you make, and a file you import, lands at the very
// BOTTOM of its level — never sorted up among the folders (serekkr, 26/10/2026).
//
// In a level that already has a saved manual order a fresh item falls to the end
// on its own (it is unsaved, so applyManualOrder gives it index Infinity). The
// trap is a level with NO saved order yet: there the default is folders-first, so
// a brand-new FOLDER used to sort alphabetically among the folders, above the
// notes, instead of at the bottom. markNewAtBottom() pins the just-made path, and
// applyManualOrder drops it to the end and writes that into the saved order.
//
// This drives the REAL applyManualOrder + markNewAtBottom out of src/renderer/app.js.
//
//   run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

const APP = fs.readFileSync(path.join(REPO, 'src/renderer/app.js'), 'utf8');
function extractFn(name) {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  const end = APP.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} never closed`);
  return APP.slice(start, end + 3);
}
const extractLine = (re) => { const m = APP.match(re); if (!m) throw new Error(`line not found: ${re}`); return m[0]; };

// The shipped functions, with the module-level values they read exposed so the
// test can seed and inspect them.
const src = `
let treeOrder = _treeOrder;
let _treeOrderGrew = false;
${extractLine(/^const isFileNode = .*$/m)}
${extractLine(/^const _newAtBottom = .*$/m)}
${extractFn('markNewAtBottom')}
${extractFn('applyManualOrder')}
return { applyManualOrder, markNewAtBottom, _newAtBottom, get order() { return treeOrder; } };
`;
const make = (seed = {}) => new Function('_treeOrder', src)(JSON.parse(JSON.stringify(seed)));

const show = (ns) => ns.map(n => n.path).join('  ');
const F = (name, path) => ({ type: 'folder', name, path });
const N = (name, path, created) => ({ type: 'note', name, path, created });
const D = (name, path, created) => ({ type: 'draw', name, path, created });
const P = (name, path, created) => ({ type: 'pdf', name, path, created });

// ── 1. new FOLDER, level with no saved order — the folders-first trap ────────
{
  const api = make();
  const nodes = [F('Alpha', 'Alpha'), F('Beta', 'Beta'), N('n1', 'n1.md', '2026-01-01'), F('ZZNew', 'ZZNew', '2026-10-26')];
  api.markNewAtBottom('ZZNew');
  const out = api.applyManualOrder(nodes, '');
  check('a new folder drops to the bottom, below the notes',
    out[out.length - 1].path === 'ZZNew', show(out));
  check('and the bottom position is written into the saved order',
    api.order[''][api.order[''].length - 1] === 'ZZNew', JSON.stringify(api.order['']));
}

// ── 2. new NOTE / DRAWING go to the bottom too ───────────────────────────────
{
  const api = make();
  const nodes = [F('A', 'A'), N('old', 'old.md', '2026-01-01'), N('new', 'new.md', '2026-10-26')];
  api.markNewAtBottom('new.md');
  check('a new note lands last', api.applyManualOrder(nodes, '').pop().path === 'new.md');
}
{
  const api = make();
  const nodes = [F('A', 'A'), N('old', 'old.md', '2026-01-01'), D('draw', 'draw.draw', '2026-10-26')];
  api.markNewAtBottom('draw.draw');
  check('a new drawing lands last', api.applyManualOrder(nodes, '').pop().path === 'draw.draw');
}

// ── 3. a new note goes BELOW an existing attachment (absolute bottom) ────────
{
  const api = make();
  const nodes = [N('a', 'a.md', '2026-01-01'), P('x', 'attachments/x.pdf', '2026-02-01'), N('new', 'new.md', '2026-10-26')];
  api.markNewAtBottom('new.md');
  check('a new note sits below an existing PDF, not just below the notes',
    api.applyManualOrder(nodes, '').pop().path === 'new.md', show(api.applyManualOrder(nodes, '')));
}

// ── 4. in a level WITH a saved order, a new item is last with no mark at all ─
{
  const api = make({ '': ['A', 'old.md'] });
  const nodes = [F('A', 'A'), N('old', 'old.md', '2026-01-01'), F('NewF', 'NewF', '2026-10-26')];
  check('an unmarked new folder still falls to the end on a saved level',
    api.applyManualOrder(nodes, '').pop().path === 'NewF', show(api.applyManualOrder(nodes, '')));
}

// ── 5. the mark is one-shot — it does not haunt the next item ────────────────
{
  const api = make();
  api.markNewAtBottom('ZZNew');
  api.applyManualOrder([F('Alpha', 'Alpha'), F('ZZNew', 'ZZNew'), N('n', 'n.md', '2026-01-01')], '');
  check('the mark is cleared once applied', api._newAtBottom.size === 0, [...api._newAtBottom].join(','));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
