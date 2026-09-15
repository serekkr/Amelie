// Reading mode must number the file's BLANK lines too.
//
// The reading-mode gutter measured the rendered rows and numbered those. Rendered
// HTML has no blank lines in it — two paragraphs are held apart by a collapsed CSS
// margin — so every gap got no number and the column came out full of holes: a
// number, a hole the same size as a row, a number. The editor's gutter, next door,
// numbers a blank line like any other row, so the two columns also disagreed about
// which number belongs to which paragraph, by one per blank line above it.
//
// The blank lines are read back from the source instead (marked keeps each run as a
// `space` token) and spread through the gap they went into, so the column runs
// unbroken and paragraph N in the file is number N on screen.
//
//   run: npm run test:linenums     (needs a display; uses xvfb-run when present)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-linenums'; const VAULT = `${HOME}/vault`; const PORT = 9397;
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
// A small solid PNG, written into the fixture vault: a picture's row is its BOX, and
// the gutter has to put its number at the top of it like any other row.
const PIC_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAABkUlEQVR42u3TAQkAAAjAMDWNmcxkaHMIW4TDs2cD+KkkAAMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGht8OqVYCdlxxVZEAAAAASUVORK5CYII=';
let child = null; process.on('exit', () => { try { if (child) process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120000);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });

// Short lines on purpose: nothing here may soft-wrap at 1400px, so one file line is
// one row on screen and "how many numbers" has a single right answer. The run of
// THREE blank lines is the case a geometric guess cannot get right — on screen it is
// the same collapsed margin as a run of one. The PICTURE is the case where the row is
// a box and not a line of text, which is where the column used to step unevenly and
// where the number used to float a half-box down inside the picture.
fs.mkdirSync(`${VAULT}/notes/attachments/images`, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/attachments/images/pic.png`, Buffer.from(PIC_B64, 'base64'));
fs.writeFileSync(`${VAULT}/notes/righe.md`,
  `---\ncreated: 2026-09-14 11:00\n---\n\n` +
  `# Titolo\n\nalfa\n\nbeta\n\n\n\ngamma\n\n- uno\n- due\n\n` +
  `![pic](attachments/images/pic.png)\n\n\ndelta\n\n` +
  // and a picture pasted INSIDE a paragraph, between two lines of text with no blank
  // line either side — the way a photo lands when you paste it while typing.
  `ok\n![pic](attachments/images/pic.png)\nfine\n`);
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

await ev(`(() => { const n = state.notes.find(x => /righe/.test(x.path || x.name || '')); if (n) openTab(n); return 1 })()`);
await sleep(1500);
await ev(`setViewMode('view')`);
await sleep(800);
await ev(`(() => { document.getElementById('editor-pane')?.classList.add('line-numbers');
  document.documentElement.style.setProperty('--editor-font-size', '19px'); return 1 })()`);
await ev(`(() => { if (typeof renderPreview === 'function') renderPreview(); return 1 })()`);
await sleep(1500);
// The picture has to be ON SCREEN before anything is measured: a row whose height is
// still 0 is not the row the user is looking at.
await ev(`(async () => { const i = [...document.querySelectorAll('#preview-content img')];
  await Promise.all(i.map(x => x.complete ? 1 : new Promise(r => { x.onload = x.onerror = r; })));
  return i.length })()`);
await sleep(600);
await ev(`(() => { if (typeof renderPreviewGutter === 'function') renderPreviewGutter(); return 1 })()`);
await sleep(500);

const MEASURE = `(() => {
  const pc = document.getElementById('preview-content');
  const pane = document.getElementById('preview-pane');
  const g = document.getElementById('preview-gutter');
  if (!pc || !pane || !g) return { err: 'no preview' };
  const originY = pane.getBoundingClientRect().top + pane.clientTop - pane.scrollTop;
  const R = v => Math.round(v * 10) / 10;
  // What the EYE sees is the middle of the number, not the top of the box it is drawn
  // in: the boxes used to be as tall as the row beside them and the number centred in
  // them, so rows an exact row apart showed their numbers 31px then 24px apart. Every
  // step below is measured centre to centre, the way the column is read.
  const nums = [...g.children].map(d => {
    const top = parseFloat(d.style.top), h = parseFloat(d.style.height);
    return { n: parseInt(d.textContent, 10), top, h, c: top + h / 2 };
  }).sort((a, b) => a.top - b.top);
  const pitch = (() => {
    const el = pc.querySelector('p, li');
    return el ? parseFloat(getComputedStyle(el).lineHeight) : 0;
  })();
  const tm = typeof _previewTextMetrics === 'function' ? _previewTextMetrics(pitch) : { lead: 0, height: pitch };
  const lead = tm.lead, lineH = tm.height;
  // Measured here with the browser's own Range, not with the app's helper: the rows
  // are where the TEXT is, and a block's box is taller than its text (the line-height
  // leading sits inside it), so a block's rect is the wrong thing to compare against.
  const rowsOf = el => {
    const rg = document.createRange(); rg.selectNodeContents(el);
    return [...rg.getClientRects()].filter(r => r.width > 0 && r.height > 0)
             .map(r => ({ top: r.top - originY, bottom: r.bottom - originY }));
  };
  // The rows the file has: every line of the body the preview renders, blank ones
  // included. Nothing in this fixture soft-wraps, so one line is one row.
  const body = (typeof _previewBody === 'function' ? _previewBody(editor.value) : editor.value).split('\\n');
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();

  // One line of text, measured off a paragraph the same way the eye sees it: the
  // number beside a picture has to sit no lower than the number beside a line of text
  // sits inside ITS block, or it is floating inside the picture pointing at nothing.
  const pEl = [...pc.querySelectorAll('p')].find(e => e.textContent.trim());
  const tr0 = pEl ? rowsOf(pEl)[0] : null;
  const txtH = tr0 ? tr0.bottom - tr0.top : pitch;

  // The picture: its number belongs at the top edge, where the picture begins, not a
  // half-box down inside it. Measured to the MIDDLE of the number, which is where it
  // is drawn and what is read.
  // Where the digits of a number begin inside its box, from the font's own metrics —
  // the same question the app asks, asked independently here.
  const inkTop = (() => {
    const cs = getComputedStyle(g);
    const cx = document.createElement('canvas').getContext('2d');
    cx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const m = cx.measureText('0123456789');
    if (!m || !(m.actualBoundingBoxAscent > 0)) return 0;
    return txtH / 2 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2 - m.actualBoundingBoxAscent;
  })();
  // The rows the app itself measured, so "off-centre in its gap" is asked of the
  // placement and not of two different ways of measuring a list item: a Range over a
  // <ul> returns rects that include the markers' line boxes, a few px off the text.
  // What the numbers are worth against the real text is the probe check's job,
  // measured independently there.
  const blocks = (typeof _previewBlockGroups === 'function'
    ? _previewBlockGroups(pc, originY, lead, lineH).map(gr => gr.map(r => ({ top: r.top, bottom: r.top + r.height })))
    : [...pc.children].map(rowsOf)).filter(r => r.length);

  // How many numbers land in each gap BETWEEN two blocks — the space the file's blank
  // lines went into. Bounded by the text either side, so a block's own number (which
  // sits exactly on its first row) is never counted as being in the gap above it.
  const inGaps = [];
  for (let i = 1; i < blocks.length; i++) {
    const above = blocks[i - 1][blocks[i - 1].length - 1];
    const hi = blocks[i][0].top;
    // Counted where the DIGITS are: a picture's number is raised so they begin on its
    // top edge, which puts its box a few px above the row — it belongs to the block
    // below all the same, not to the gap above it.
    inGaps.push(nums.filter(x => x.top + inkTop >= above.bottom - 1 && x.top + inkTop < hi - 1).length);
  }

  // Which numbers stand beside a row that is one line of the note: a line of text in a
  // paragraph or a list item, or a blank line. Those are the rows the editor's gutter
  // steps through one row at a time, and the column here has to step the same way. A
  // heading is legitimately taller and a picture is 180px tall; the steps into and out
  // of THOSE follow the layout, and are checked separately.
  const kind = [];
  let gi = 0;
  for (const child of pc.children) {
    if (child.classList && child.classList.contains('md-blank-run')) {
      const n = parseInt(child.dataset.blankRows || '0', 10);
      for (let k = 0; k < n; k++) kind.push('blank');
      continue;
    }
    const rows = (typeof _previewBlockGroups === 'function'
      ? _previewBlockGroups(pc, originY, lead, lineH)[gi] : null) || [];
    gi++;
    const plain = /^(P|UL|OL)$/.test(child.tagName);
    for (const r of rows) kind.push(r.edge ? 'edge' : (plain && r.height <= pitch * 1.2 ? 'text' : 'other'));
  }
  // The step INTO a picture counts too: it is the distance between two adjacent
  // numbers with nothing between them — "i spazi tra riga 68 e 69 sono diversi". The
  // step OUT of one is the height of the picture and belongs to no grid.
  const grid = k => k === 'blank' || k === 'text';
  const gridSteps = [];
  for (let i = 1; i < nums.length && i < kind.length; i++) {
    if (grid(kind[i - 1]) && (grid(kind[i]) || kind[i] === 'edge')) gridSteps.push(R(nums[i].c - nums[i - 1].c));
  }

  const pics = [...pc.querySelectorAll('img')].map(img => {
    const ir = img.getBoundingClientRect();
    const top = ir.top - originY;
    let best = null;
    for (const x of nums) if (!best || Math.abs(x.top - top) < Math.abs(best.top - top)) best = x;
    return { top: R(top), height: R(ir.height), n: best ? best.n : null,
             numTop: best ? R(best.top) : null, below: best ? R(best.c - top) : null,
             // what the eye compares: the top of the digits against the top of the picture
             inkBelow: best ? R(best.top + inkTop - top) : null };
  });
  const pic = pics[0] || null;

  // The tightest the column ever gets. A run of blank lines used to be squeezed into
  // the collapsed margin, which is the same ~12px whether the file has two blank
  // lines there or five, so the numbers landed on top of each other.
  let minStep = 1e9, minAt = null;
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i].c - nums[i - 1].c;
    if (d < minStep) { minStep = d; minAt = nums[i - 1].n; }
  }
  const probe = (sel, text) => {
    const el = [...pc.querySelectorAll(sel)].find(e => e.textContent.trim() === text);
    if (!el) return { text, n: null, top: null };
    const r = rowsOf(el)[0];
    const hit = r ? nums.find(x => Math.abs(x.top - r.top) <= 2) : null;
    return { text, top: r ? Math.round(r.top) : null, n: hit ? hit.n : null };
  };
  return {
    count: nums.length, lines: body.length, seq: nums.map(x => x.n), inGaps, gridSteps, pic,
    kinds: kind.length, lead: R(lead), txtH: R(txtH), want: R(txtH / 2), inkTop: R(inkTop), pics,
    minStep: R(minStep), minAt, pitch: R(pitch),
    probes: ['alfa', 'beta', 'gamma', 'delta'].map(t => probe('p', t)).concat([probe('li', 'due')]),
    srcLine: { alfa: body.indexOf('alfa') + 1, beta: body.indexOf('beta') + 1, gamma: body.indexOf('gamma') + 1,
               due: body.indexOf('- due') + 1, delta: body.indexOf('delta') + 1,
               pic: body.findIndex(l => l.indexOf('![pic]') === 0) + 1,
               pic2: body.length - body.slice().reverse().findIndex(l => l.indexOf('![pic]') === 0) },
  };
})()`;

const m = await ev(MEASURE);
if (!m || m.err) { console.error('measure failed:', JSON.stringify(m), '\n' + err.slice(-800)); process.exit(1); }
const spread = m.gridSteps.length ? Math.round((Math.max(...m.gridSteps) - Math.min(...m.gridSteps)) * 10) / 10 : -1;
console.log('   numbers    ' + JSON.stringify(m.seq) + '   file lines ' + m.lines);
console.log('   per gap    ' + JSON.stringify(m.inGaps) + '   (blank lines in the file: [1,1,3,1,1,2,1])');
console.log('   probes     ' + JSON.stringify(m.probes));
console.log('   steps      ' + JSON.stringify(m.gridSteps) + '  a row is ' + m.pitch + 'px, the leading is ' + m.lead + 'px');
console.log('   pictures   ' + JSON.stringify(m.pics) + '   (the digits start ' + m.inkTop + 'px into a number\'s box)');

// 1. A number for every line the file has, blank ones included.
check(`the reading view numbers all ${m.lines} lines of the file (got ${m.count})`,
  m.count === m.lines,
  `${m.count} numbers for ${m.lines} lines — the blank lines are the difference`);

// 2. Sequential from 1, so a number means the row it is beside.
check('the numbers run 1..N with none missing',
  m.seq.length > 0 && m.seq.every((n, i) => n === i + 1),
  `got ${JSON.stringify(m.seq)}`);

// 3. The first symptom: every gap between two blocks used to hold no number at all,
//    leaving a hole in the column the height of a row. The run of THREE blank lines
//    is why the count is read from the source — on screen that gap is the same
//    collapsed margin as a run of one, so nothing about it can be measured.
const WANT_GAPS = [1, 1, 3, 1, 1, 2, 1];
check(`each gap carries the blank lines the file has there (${JSON.stringify(m.inGaps)})`,
  m.inGaps.length === WANT_GAPS.length && m.inGaps.every((n, i) => n === WANT_GAPS[i]),
  `got ${JSON.stringify(m.inGaps)}, file has ${JSON.stringify(WANT_GAPS)}`);

// 4. Readable: no two numbers sit on top of each other. The file's run of three
//    blank lines has to be given room in the reading view, or the numbers for it are
//    right and unreadable — the same fault as the holes, from the other side.
check(`no two numbers crowd each other (tightest ${m.minStep}px against a ${m.pitch}px row)`,
  m.pitch > 0 && m.minStep >= m.pitch * 0.5,
  `${m.minStep}px between number ${m.minAt} and the next — a run of blank lines was squeezed into a margin`);

// 5. The complaint itself, stated the way it was reported: "i spazi dei numeri non
//    sono uguali". From one line of the note to the next — text or blank, and a list
//    item is a line of the note like any other — the column steps exactly one row,
//    everywhere. It used to alternate 31px and 24px down every note: the rows were in
//    the right places, but each number was centred in a box as tall as its own row,
//    and those heights differ (a line of text, a blank line, a picture).
check(`the column steps one row between consecutive lines of the note (${JSON.stringify(m.gridSteps)})`,
  m.gridSteps.length >= m.lines - 6 && m.gridSteps.every(d => Math.abs(d - m.pitch) <= 1.5),
  `steps ${JSON.stringify(m.gridSteps)} against a ${m.pitch}px row (spread ${spread}px)`);

// 6. The rows the app numbers and the rows it lays out are the same rows: one kind
//    per number, or the column is being drawn against a layout it does not describe.
check(`every number stands for a row of the layout (${m.kinds} for ${m.count})`,
  m.kinds === m.count, `${m.kinds} rows described, ${m.count} numbers drawn`);

// 7. A picture is a row whose box is the picture: its number belongs at the top edge,
//    where the picture starts — "il numero deve essere allo primo livello quando
//    inizia la foto". It used to be centred in a box two lines tall, i.e. ~24px down
//    inside the picture, pointing at nothing.
// A picture's top edge is a line you can see, and the DIGITS of its number begin on
// it. Not the number's box — the box has white above the digits, which is right
// against a line of text and reads as the picture starting above its own number when
// there is nothing beside it to average with. Reported three times: 24px in (v1.0.55,
// centred in a box two lines tall), 18px in (v1.0.56, carrying the text leading), and
// 2.3px in (v1.0.57, the white above the digits).
check(`the digits of each picture's number start on its top edge (${JSON.stringify(m.pics.map(p => p.inkBelow))}px off)`,
  m.pics.length >= 2 && m.pics.every(p => Math.abs(p.inkBelow) <= 1),
  `${JSON.stringify(m.pics)} — the digits do not begin where the picture does`);

// 8. And it is the picture's own line in the file.
check(`the picture is number ${m.srcLine.pic} in the reading view, as it is in the file`,
  !!m.pic && m.pic.n === m.srcLine.pic, `got ${m.pic && m.pic.n}`);

// The pasted-in-a-paragraph case: the picture sits between two lines of text with no
// blank line either side, so its row is one line of a paragraph and not a block.
check(`the picture pasted inside a paragraph is number ${m.srcLine.pic2} (got ${m.pics[1] && m.pics[1].n})`,
  !!m.pics[1] && m.pics[1].n === m.srcLine.pic2, `got ${m.pics[1] && m.pics[1].n}`);

// 9. And so the number beside a line is that line's number in the file — which is
//    what the editor's gutter says about the same note, and what it did not say here.
for (const p of m.probes) {
  const want = m.srcLine[p.text];
  check(`"${p.text}" is number ${want} in the reading view, as it is in the file`,
    p.n === want, `got ${p.n} beside its row at y=${p.top}`);
}

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
