// A saved column width must be one the renderer can actually produce, and a table
// row must get ONE line number.
//
// Both symptoms came from `_columnContentMin`, the floor the column drag clamps to.
// It measured the widest word of each cell on a canvas using the CELL's font — but a
// cell is rarely just cell-font text: an inline `code` chip has its own monospace
// family plus 5px of padding and a 1px border each side, and `strong` is heavier
// than the td around it. On the six-column table this fixture copies, that floor came
// out 32-48px under the truth (it claimed 140,135,140,175,174,84 for columns the
// browser needs 135,167,156,221,222,90 at a 19px note font).
//
// So a column could be dragged narrower than its own content and `amelie:colw` kept
// the number. Nothing rendered it back: under table-layout:auto the browser reclaimed
// the width and squeezed the NEIGHBOURS to their 90px min-width — those cells wrapped
// to two lines, which made the row taller, which made the preview gutter number every
// line inside it — and in the fixed layout a drag leaves behind, the chip overflowed
// into the next column and painted over its text.
//
// The floor is now the browser's own per-column min-content, measured on one
// off-screen clone; saved widths are floored at it on render (old notes heal without
// being rewritten); and the gutter counts a <tr> as one row.
//
//   run: npm run test:tablecols      (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-tablecols'; const VAULT = `${HOME}/vault`; const PORT = 9396;
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
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
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });

// The shape that found it: chip-only and bold-only cells, with a colw marker whose
// numbers are all below what the columns need — exactly what the old drag floor wrote.
const ROWS = [
  ['mellanox1',   '0000:05:00.0', 'eth0',        '58:a2:e1:11:d2:28', 'slot PCIe **x16** Gen5', 'x16 piena'],
  ['mellanox2',   '0000:85:00.0', 'ens1f0np0',   'b8:3f:d2:13:05:2a', 'slot PCIe **x8** Gen4',  'x8 (metà)'],
  ['mellanox4',   '0000:c4:00.0', 'eno3np0',     '58:a2:e1:11:e0:c0', '**OCP** mezzanine',      'x16 piena'],
  ['broadcom25g', '0000:c5:00.0', 'eno12399np0', '14:23:f3:22:dc:c0', 'integrata',              'x8 Gen3'],
];
const body = ROWS.map(r =>
  `| **${r[0]}** | \`${r[1]}\` | \`${r[2]}\` | \`${r[3]}\` | ${r[4]} | ${r[5]} |`).join('\n');
fs.writeFileSync(`${VAULT}/notes/porte.md`,
  `---\ncreated: 2026-09-09 10:00\n---\n\n# Inventario porte\n\n` +
  `<!-- amelie:colw=112,139,169,144,242,118 -->\n` +
  `| Scheda | PCI | Interfaccia | MAC | Alloggiamento | Banda |\n|---|---|---|---|---|---|\n${body}\n`);
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
const eargs = ['.', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic'];
child = xvfb
  ? spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', ELECTRON, ...eargs, '--ozone-platform=x11', '--disable-gpu'],
      { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  : spawn(ELECTRON, eargs, { cwd: REPO, env: { ...process.env, HOME, ELECTRON_RUN_AS_NODE: undefined }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let err = ''; child.stderr.on('data', d => { err += d; });
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {} }
if (!target) { console.error('no app\n' + err.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const ev = x => new Promise(res => { const my = ++id; pending.set(my, m => res(m.result?.result?.value ?? (m.result?.exceptionDetails ? 'EXC: ' + (m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text) : null))); ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression: x, awaitPromise: true, returnByValue: true } })); setTimeout(() => { if (pending.delete(my)) res(null); }, 20000); });
await sleep(2000);
const results = []; const check = (n, p, d) => { results.push(p); console.log(`${p ? 'ok  ' : 'FAIL'}  ${n}${p ? '' : `\n        ${d}`}`); };

await ev(`(() => { const n = state.notes.find(x => /porte/.test(x.path || x.name || '')); if (n) openTab(n); return 1 })()`);
await sleep(1500);
await ev(`setViewMode('view')`);
await sleep(800);
// Line numbers on, and the 19px note font the fault was measured at.
await ev(`(() => { document.getElementById('editor-pane')?.classList.add('line-numbers');
  document.documentElement.style.setProperty('--editor-font-size', '19px'); return 1 })()`);
await ev(`(() => { if (typeof renderPreview === 'function') renderPreview(); return 1 })()`);
await sleep(1500);
await ev(`(() => { if (typeof renderPreviewGutter === 'function') renderPreviewGutter(); return 1 })()`);
await sleep(500);

// ── The measurement helper, inside the page ────────────────────────────────────
const MEASURE = `(() => {
  const pc = document.getElementById('preview-content');
  const pane = document.getElementById('preview-pane');
  const t = pc.querySelector('table');
  if (!t) return { err: 'no table rendered' };
  const cells = [...t.querySelector('tr').querySelectorAll('th,td')];
  const rendered = cells.map(c => Math.round(c.getBoundingClientRect().width));

  // The browser's own per-column min-content, measured independently of the app.
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;visibility:hidden';
  const clone = t.cloneNode(true);
  clone.style.width = 'min-content'; clone.style.maxWidth = 'none'; clone.style.tableLayout = 'auto';
  clone.querySelectorAll('colgroup col').forEach(c => { c.style.width = ''; });
  clone.querySelectorAll('.col-resize-handle').forEach(h => h.remove());
  box.appendChild(clone); pc.appendChild(box);
  const trueMin = [...clone.querySelector('tr').querySelectorAll('th,td')]
    .map(c => Math.round(c.getBoundingClientRect().width));
  box.remove();

  // Worst overflow of any cell's content past its own content box.
  let worst = { over: -1e9 };
  for (const row of t.querySelectorAll('tr')) [...row.querySelectorAll('th,td')].forEach((cell, ci) => {
    const cr = cell.getBoundingClientRect(), cs = getComputedStyle(cell);
    const inner = cr.right - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    for (const ch of cell.children) {
      if (ch.classList.contains('col-resize-handle')) continue;
      const r = ch.getBoundingClientRect();
      if (r.width <= 0) continue;
      const over = r.right - inner;
      if (over > worst.over) worst = { over: Math.round(over), col: ci, text: ch.textContent.slice(0, 20) };
    }
  });

  // How many gutter numbers land inside each body row.
  const g = document.getElementById('preview-gutter');
  const originY = pane.getBoundingClientRect().top + pane.clientTop - pane.scrollTop;
  const nums = g ? [...g.children].map(d => ({ n: d.textContent, top: parseFloat(d.style.top) })) : [];
  const perRow = [...t.querySelectorAll('tbody tr')].map(tr => {
    const r = tr.getBoundingClientRect();
    const top = r.top - originY;
    return nums.filter(x => x.top >= top - 1 && x.top < top + r.height - 1).map(x => x.n);
  });
  const rowHeights = [...t.querySelectorAll('tbody tr')].map(tr => Math.round(tr.getBoundingClientRect().height));

  return {
    rendered, trueMin, worst, perRow, rowHeights,
    floor: (typeof _columnContentMins === 'function') ? _columnContentMins(t)
         : (typeof _columnContentMin === 'function'
              ? [...t.querySelectorAll('colgroup col')].map((_, i) => _columnContentMin(t, [...t.querySelectorAll('colgroup col')], i))
              : null),
    pinned: parseFloat(t.style.width) || 0,
    tableW: Math.round(t.getBoundingClientRect().width),
    paneW: pc.clientWidth,
    layout: getComputedStyle(t).tableLayout,
  };
})()`;

const m = await ev(MEASURE);
if (!m || m.err || !m.rendered) { console.error('measure failed:', JSON.stringify(m), '\n' + err.slice(-800)); process.exit(1); }
console.log('   rendered  ' + JSON.stringify(m.rendered));
console.log('   trueMin   ' + JSON.stringify(m.trueMin));
console.log('   drag floor' + JSON.stringify(m.floor));
console.log('   row heights ' + JSON.stringify(m.rowHeights) + '   pane ' + m.paneW + '  table ' + m.tableW + ' (pinned ' + m.pinned + ')');

// 1. The drag floor must never promise a column narrower than the browser will render.
//    This is the fault itself: the canvas floor was 32-48px low on the chip/bold columns.
m.trueMin.forEach((tm, i) => {
  const f = m.floor ? m.floor[i] : null;
  check(`drag floor for column ${i} is not below its content (floor ${f}, needs ${tm})`,
    f !== null && f >= tm, `floor ${f} < ${tm} — a drag can shrink this column past its own text`);
});

// 2. Nothing a cell holds may spill out of the cell and over its neighbour.
check(`no cell content overflows its cell (worst ${m.worst.over}px, col ${m.worst.col} "${m.worst.text}")`,
  m.worst.over <= 1, `${m.worst.over}px of "${m.worst.text}" sticks out of column ${m.worst.col}`);

// 3. What is rendered is what was asked for: no column is squeezed under its content.
const squeezed = m.rendered.map((w, i) => w - m.trueMin[i]).filter(d => d < -1).length;
check('no column is rendered narrower than its content', squeezed === 0,
  `rendered ${JSON.stringify(m.rendered)} vs needed ${JSON.stringify(m.trueMin)}`);

// 4. The pinned total is a total the layout can actually produce, so the table does
//    not silently swell past it and reshuffle the columns.
check(`the table renders at the width it is pinned to (${m.tableW} vs ${m.pinned})`,
  m.pinned > 0 && Math.abs(m.tableW - m.pinned) <= 2,
  `pinned ${m.pinned}px, rendered ${m.tableW}px — the browser overrode the saved widths`);

// 5. One number per table row. Cells inside a row do not line up (a chip is taller
//    than the text beside it; a wrapped cell starts higher), so each row used to
//    collect two or three.
const bad = m.perRow.filter(ns => ns.length !== 1).length;
check(`each table row gets exactly one line number (${JSON.stringify(m.perRow)})`,
  bad === 0, `${bad} of ${m.perRow.length} rows carry a number count other than 1`);

// 6. Drag the MAC column (index 3) far to the left: it must stop at its content, not
//    hand the overflow to the column beside it, and what gets persisted must be a
//    width the renderer can honour.
const drag = await ev(`(async () => {
  const t = document.querySelector('#preview-content table');
  const row = t.querySelector('tbody tr');
  const cell = row.querySelectorAll('td')[3];
  const h = cell.querySelector('.col-resize-handle');
  if (!h) return { err: 'no handle' };
  const r = h.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const fire = (type, cx) => document.dispatchEvent(new MouseEvent(type, { clientX: cx, clientY: y, bubbles: true }));
  h.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
  fire('mousemove', x - 20);      // past the 8px engage threshold
  fire('mousemove', x - 250);     // then far past the column's content
  const cols = [...t.querySelectorAll('colgroup col')].map(c => Math.round(parseFloat(c.style.width) || 0));
  fire('mouseup', x - 250);
  await new Promise(r2 => setTimeout(r2, 200));
  // worst overflow in the dragged (fixed-layout) state
  let over = -1e9;
  for (const rw of t.querySelectorAll('tr')) for (const c of rw.querySelectorAll('th,td')) {
    const cr = c.getBoundingClientRect(), cs = getComputedStyle(c);
    const inner = cr.right - (parseFloat(cs.paddingRight) || 0) - (parseFloat(cs.borderRightWidth) || 0);
    for (const ch of c.children) {
      if (ch.classList.contains('col-resize-handle')) continue;
      const b = ch.getBoundingClientRect();
      if (b.width > 0) over = Math.max(over, b.right - inner);
    }
  }
  const marker = (editor.value.match(/<!--\\s*amelie:colw=([\\d,]+)\\s*-->/) || [])[1] || '';
  return { cols, over: Math.round(over), marker, layout: getComputedStyle(t).tableLayout };
})()`);
console.log('   after drag: cols ' + JSON.stringify(drag && drag.cols) + '  marker ' + (drag && drag.marker) + '  layout ' + (drag && drag.layout));

check('the drag stops at the column\'s content instead of shrinking past it',
  !!drag && !drag.err && drag.cols[3] >= m.trueMin[3],
  `column 3 went to ${drag && drag.cols && drag.cols[3]}px, its content needs ${m.trueMin[3]}px`);
check(`the dragged table does not spill a cell over its neighbour (worst ${drag && drag.over}px)`,
  !!drag && drag.over <= 1, `${drag && drag.over}px sticks out while the table is in ${drag && drag.layout} layout`);
const saved = (drag && drag.marker ? drag.marker.split(',').map(Number) : []);
check(`the width written to the note is one the renderer can honour (${drag && drag.marker})`,
  saved.length === m.trueMin.length && saved.every((w, i) => w >= m.trueMin[i]),
  `saved ${JSON.stringify(saved)} against needed ${JSON.stringify(m.trueMin)}`);

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
