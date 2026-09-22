// The Recent view lists the VAULT's files, newest modified first.
//
// It used to be the history of what you had OPENED, kept in localStorage. Two
// faults, reported 2026-09-22 — "ho creato file nuovi ma nella tabella recent
// files non vedo i ultimi":
//   • ordered by when you last opened a file while every row PRINTED the
//     modification date, so the dates read out of order — one note from 29 August
//     sat above three written the same afternoon, and a note created minutes ago
//     was sixth,
//   • and a drawing, a PDF or a photo never entered it at all: openNote returns
//     for those before the line that recorded the open, and openDrawFile /
//     openPdfFile push their own tab without going through openTab either.
//
// The second fault had a twin: a drawing reached BY PATH — from Recent, a
// bookmark, a tag — went through openTab, which routed attachments but not
// drawings, and opened the raw Excalidraw JSON as note text. Pinned here too.
//
// No display needed, unlike the *.cdp.mjs tests: the real functions are sliced
// out of app.js by name and run in an offscreen window over the real style.css.
//
//   run: npm run test:recent
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
const PAGE = `${REPO}/src/renderer/_recent-bench.html`;
const RUNNER = path.join(os.tmpdir(), `amelie-recent-${process.pid}.js`);
const cleanup = () => { for (const f of [PAGE, RUNNER]) { try { fs.rmSync(f, { force: true }); } catch (_) {} } };
process.on('exit', cleanup);

fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css"></head><body style="margin:0">
<aside id="sidebar"><div id="recent-list" class="simple-list"></div></aside>
</body></html>`);

fs.writeFileSync(RUNNER, `
const { app, BrowserWindow } = require('electron');
// FIRST, before the slicing: a slice that no longer matches app.js throws at
// load, and without this the process sits there until the spawn timeout instead
// of saying which name it could not find.
process.on('uncaughtException', (e) => { console.log('THREW: ' + ((e && e.message) || e)); process.exit(1); });
app.disableHardwareAcceleration();
const fs = require('fs');
const SRC = fs.readFileSync(${JSON.stringify(`${REPO}/src/renderer/app.js`)}, 'utf8');
const fn = (n) => {
  const m = new RegExp('^(?:async )?function ' + n + '\\\\(', 'm').exec(SRC);
  if (!m) throw new Error('not found in app.js: ' + n);
  const end = SRC.indexOf('\\n}\\n', m.index);
  if (end < 0) throw new Error('unterminated: ' + n);
  return SRC.slice(m.index, end + 3);
};
const cons = (d) => {
  const m = new RegExp('^' + d + '.*$', 'm').exec(SRC);
  if (!m) throw new Error('not found in app.js: ' + d);
  return m[0];
};
const LIST = [cons('const RECENT_MAX'), fn('_recentFiles'), fn('renderRecentView'),
              fn('_fmtDateDMY'), fn('_findNode'), fn('_openByPath'), fn('_baseName')].join('\\n');
const ROUTE = fn('openTab');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 420, height: 700, show: false,
    webPreferences: { offscreen: true, contextIsolation: false } });
  await w.loadFile(${JSON.stringify(PAGE)});
  await new Promise(r => setTimeout(r, 500));
  const out = await w.webContents.executeJavaScript('(() => {' + \`
    const log = [];
    const ok = (n, cond, extra) => log.push((cond ? 'ok  ' : 'FAIL') + '  ' + n + (cond ? '' : '\\\\n        ' + JSON.stringify(extra)));
    window.i18n = { t: (k) => ({ 'recent.modified': 'Modificato', 'section.recent_empty': 'vuoto' })[k] || k };
    const $ = (id) => document.getElementById(id);
    let opened = null;
    const openTab = (n) => { opened = n; };
    // A vault with a folder to walk into, an August note, and three files from
    // the same afternoon — the shape the report came from.
    const state = { notes: [
      { type:'folder', name:'DPI', children: [
        { type:'note', name:'dpi-07', path:'DPI/dpi-07.md', modified:'2026-09-16T21:00:00Z' },
        { type:'folder', name:'New folder', children: [
          { type:'note', name:'tiles', path:'DPI/New folder/tiles.md', modified:'2026-08-29T14:32:00Z' },
        ] },
      ] },
      { type:'note',  name:'hello', path:'hello.md', modified:'2026-09-20T12:59:00Z' },
      { type:'note',  name:'fsinstall', path:'fsinstall.md', modified:'2026-09-22T15:28:00Z' },
      { type:'note',  name:'20-09-2026', path:'20-09-2026.md', modified:'2026-09-22T15:30:00Z' },
      { type:'note',  name:'22-09-2026', path:'22-09-2026.md', modified:'2026-09-22T15:29:00Z' },
      { type:'draw',  name:'schizzo', path:'schizzo.draw', modified:'2026-09-22T15:30:30Z' },
      { type:'pdf',   name:'doc.pdf', path:'attachments/pdf/doc.pdf', attachmentName:'pdf/doc.pdf', modified:'2026-09-22T09:33:00Z' },
      { type:'image', name:'foto.png', path:'attachments/images/foto.png', attachmentName:'images/foto.png', modified:'2026-09-15T11:39:00Z' },
      { type:'note',  name:'senza data', path:'senza-data.md' },
    ] };
    \` + LIST + \`
    renderRecentView();
    const rows = [...document.querySelectorAll('#recent-list .simple-row')]
      .map(r => r.querySelector('.simple-main').title);

    ok('newest modified first, oldest last', rows[0] === 'schizzo.draw' && rows[1] === '20-09-2026.md'
       && rows[2] === '22-09-2026.md' && rows[rows.length - 1] === 'senza-data.md', rows);
    ok('a file created minutes ago is at the TOP, not sixth', rows.indexOf('22-09-2026.md') <= 2, rows);
    ok('drawings, PDFs and photos are in the list at all',
       rows.includes('schizzo.draw') && rows.includes('attachments/pdf/doc.pdf') && rows.includes('attachments/images/foto.png'), rows);
    ok('notes inside folders are walked into, folders themselves are not listed',
       rows.includes('DPI/New folder/tiles.md') && !rows.some(p => p === 'DPI'), rows);
    ok('an August note sits below every file from today',
       rows.indexOf('DPI/New folder/tiles.md') > rows.indexOf('fsinstall.md'), rows);
    ok('a file with no date sorts last instead of breaking the order',
       rows[rows.length - 1] === 'senza-data.md', rows);
    ok('every row still prints its modification date',
       [...document.querySelectorAll('#recent-list .simple-row')].slice(0, -1)
         .every(r => /^Modificato \\\\d\\\\d\\\\//.test((r.querySelector('.simple-sub') || {}).textContent || '')), rows);

    // Clicking a drawing must hand openTab a node that still says what it is.
    [...document.querySelectorAll('#recent-list .simple-main')].find(m => /\\\\.draw$/.test(m.title)).click();
    ok('clicking a drawing passes its type through', opened && opened.type === 'draw', opened);
    return log.join('\\\\n');
  })()\`);
  console.log(out);

  // …and openTab itself must route a drawing to the canvas, not to a note tab.
  const routed = await w.webContents.executeJavaScript('(() => {' + \`
    const log = [];
    const ok = (n, cond, extra) => log.push((cond ? 'ok  ' : 'FAIL') + '  ' + n + (cond ? '' : '\\\\n        ' + JSON.stringify(extra)));
    const seen = [];
    const _returnToFilesView = () => {};
    const isAttachNode = (n) => ['pdf','image','audio','video'].includes(n && n.type);
    const openPdfFile = (n) => seen.push('pdf:' + n.path);
    const openAttachmentNode = (n) => seen.push('attach:' + n.path);
    const openDrawFile = (n) => seen.push('draw:' + n.path);
    let _splitPath = null, _focusedPane = null, _splitOrient = null;
    const openSplitView = () => seen.push('split');
    const tabs = [], switchTab = () => seen.push('note-tab');
    const renderTabBar = () => {}, renderTree = () => {}, saveSession = () => {};
    \` + ROUTE + \`
    openTab({ type: 'draw', name: 'schizzo', path: 'schizzo.draw' });
    openTab({ name: 'vecchio', path: 'vecchio.draw' });     // node with no type at all
    openTab({ type: 'note', name: 'nota', path: 'nota.md' });
    openTab({ type: 'pdf', name: 'doc', path: 'attachments/pdf/doc.pdf' });
    ok('a drawing opened by path goes to the canvas, not into the editor as JSON',
       seen[0] === 'draw:schizzo.draw' && seen[1] === 'draw:vecchio.draw', seen);
    ok('notes and PDFs are routed exactly as before',
       seen[2] === 'note-tab' && seen[3] === 'pdf:attachments/pdf/doc.pdf', seen);
    return log.join('\\\\n');
  })()\`);
  console.log(routed);
  app.quit();
}).catch((e) => { console.log('THREW: ' + ((e && e.message) || e)); process.exit(1); });
`);

const r = spawnSync(ELECTRON, [RUNNER], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
const lines = (r.stdout || '').split('\n').filter(l => /^(ok  |FAIL|THREW)/.test(l.trim()) || /^        /.test(l));
if (!lines.length) {
  console.error('the bench produced nothing — electron failed to start?\n' + (r.stderr || '').slice(-1200));
  process.exit(1);
}
console.log(lines.join('\n'));
const bad = lines.filter(l => /^(FAIL|THREW)/.test(l.trim())).length;
const good = lines.filter(l => l.startsWith('ok  ')).length;
console.log(`\n${bad ? `${good}/${good + bad} —` : `all ${good} passed`}`);
process.exit(bad ? 1 : 0);
