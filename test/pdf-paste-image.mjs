// Ctrl+V of a photo onto a PDF page.
//
// Until v1.0.84 a photo could only reach a page through the toolbar's image
// button, which opens a NATIVE file dialog — modal on the main window, so the
// app is blocked while it is up and, when the desktop portal misbehaves, looks
// simply frozen. Reported on 2026-09-22 in the middle of signing a document:
// "non riesco a fare copia di una foto quando lo aggiungo con ctrl c e ctrl v".
//
// What is pinned here is the TRIAGE, which is where this can go wrong: a photo
// arrives as bytes (a screenshot, an image copied out of a browser) or as a bare
// path (copied in the file manager), and ordinary copied TEXT must fall straight
// through — reaching for the system clipboard on a plain Ctrl+V means a
// synchronous IPC that shells out to wl-paste with a 2s timeout, which would be
// the very freeze this feature exists to remove.
//
// No display needed, unlike the *.cdp.mjs tests: the real functions are sliced
// out of app.js by name and run in an offscreen window over the real style.css.
//
//   run: npm run test:pdfpaste
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = `${REPO}/node_modules/electron/dist/electron`;
// The page lives in src/renderer so style.css resolves by relative path — that
// is what makes this the app's real CSS rather than a mock.
const PAGE = `${REPO}/src/renderer/_pdfpaste-bench.html`;
const RUNNER = path.join(os.tmpdir(), `amelie-pdfpaste-${process.pid}.js`);
const cleanup = () => { for (const f of [PAGE, RUNNER]) { try { fs.rmSync(f, { force: true }); } catch (_) {} } };
process.on('exit', cleanup);

fs.writeFileSync(PAGE, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="style.css"></head><body style="margin:0">
<div id="pdf-overlay" style="display:flex">
  <div id="pdf-container" class="pdf-editing" style="height:600px;overflow:auto;position:relative">
    <div class="pdf-page-wrap" style="position:relative;width:600px;height:848px;margin:0 auto">
      <div class="pdf-obj-layer" data-page="1" data-hpt="848" data-wpt="600" style="position:absolute;inset:0"></div>
    </div>
  </div>
</div>
<div id="box" contenteditable="true">testo</div>
</body></html>`);

fs.writeFileSync(RUNNER, `
const { app, BrowserWindow } = require('electron');
// FIRST, before the slicing below: a slice that no longer matches app.js throws
// at load, and without this the process sits there with the window open until
// the spawn timeout instead of saying which name it could not find.
process.on('uncaughtException', (e) => { console.log('THREW: ' + ((e && e.message) || e)); process.exit(1); });
app.disableHardwareAcceleration();
const fs = require('fs');
const SRC = fs.readFileSync(${JSON.stringify(`${REPO}/src/renderer/app.js`)}, 'utf8');
// Slice real functions out of app.js by name (top level, closing brace at column 0).
const fn = (name) => {
  const m = new RegExp('^(?:async )?function ' + name + '\\\\(', 'm').exec(SRC);
  if (!m) throw new Error('not found in app.js: ' + name);
  const end = SRC.indexOf('\\n}\\n', m.index);
  if (end < 0) throw new Error('unterminated: ' + name);
  return SRC.slice(m.index, end + 3);
};
const cons = (decl) => {
  const m = new RegExp('^' + decl + '.*$', 'm').exec(SRC);
  if (!m) throw new Error('not found in app.js: ' + decl);
  return m[0];
};
const CODE = [
  cons('const PDF_IMAGE_MIME_RE'), cons('const PDF_IMAGE_PATH_RE'), cons('const PDF_IMAGE_MAX_BYTES'),
  fn('_u8ToB64'), fn('_currentPdfPage'), fn('_onPdfPaste'),
].join('\\n');

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1000, height: 800, show: false,
    webPreferences: { offscreen: true, contextIsolation: false } });
  await w.loadFile(${JSON.stringify(PAGE)});
  await new Promise(r => setTimeout(r, 600));
  const out = await w.webContents.executeJavaScript('(async () => {' + \`
    const log = [];
    const ok = (n, cond, extra) => log.push((cond ? 'ok  ' : 'FAIL') + '  ' + n + (cond ? '' : '\\\\n        ' + JSON.stringify(extra)));
    let _pdfAttName = 'doc.pdf';
    const _pdfContainer = document.getElementById('pdf-container');
    let placed = [], toasts = [], sysReads = 0, pathAsked = [], lastErr = null;
    const showToast = (m) => toasts.push(m);
    window.i18n = { t: (k) => k };
    window.inkwell = {
      readClipboardFilePaths: () => { sysReads++; return window.__sysPaths || []; },
      pdfImageFromPath: async (p) => { pathAsked.push(p); if (window.__pathTooBig) throw new Error('IMAGE_TOO_LARGE'); return { mime: 'image/jpeg', dataB64: 'RkFLRQ==' }; },
    };
    const _placePdfImage = async (res) => { placed.push(res); return true; };
    \` + CODE + \`
    const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const evt = (build) => { const dt = new DataTransfer(); build(dt); return new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); };
    const reset = () => { placed = []; toasts = []; sysReads = 0; pathAsked = []; window.__sysPaths = []; window.__pathTooBig = false; };
    // Call the handler with the target it would really see: dispatching alone
    // would swallow a throw, and an async listener's rejection is invisible.
    const fire = async (e, target) => {
      Object.defineProperty(e, 'target', { value: target || _pdfContainer, configurable: true });
      try { await _onPdfPaste(e); } catch (err) { lastErr = String((err && err.stack) || err); }
      await new Promise(r => setTimeout(r, 30));
    };

    reset();
    await fire(evt(dt => dt.items.add(new File([PNG], 'shot.png', { type: 'image/png' }))));
    ok('a pasted PNG lands on the page', placed.length === 1 && placed[0].mime === 'image/png' && placed[0].dataB64.startsWith('iVBOR'), { placed, toasts });

    reset();
    await fire(evt(dt => dt.items.add(new File([PNG], 'foto.jpg', { type: 'image/jpeg' }))));
    ok('a pasted JPEG keeps its own type (pdf-lib embeds png/jpg only)', placed.length === 1 && placed[0].mime === 'image/jpeg', { placed });

    reset();
    await fire(evt(dt => dt.setData('text/plain', 'una riga di testo')));
    ok('ordinary text falls through, and never reaches for the OS clipboard (2s wl-paste)', placed.length === 0 && sysReads === 0 && toasts.length === 0, { sysReads, toasts });

    reset();
    await fire(evt(dt => dt.setData('text/uri-list', 'file:///home/x/Pictures/firma%20mia.jpg')));
    ok('a photo copied in the file manager is read by path, unescaped', pathAsked.length === 1 && pathAsked[0] === '/home/x/Pictures/firma mia.jpg' && placed.length === 1, { pathAsked, placed });

    reset(); window.__sysPaths = ['/home/x/Pictures/scan.png'];
    await fire(evt(dt => dt.items.add(new File([], 'hollow', { type: '' }))));
    ok('a hollow stub from Chromium falls back to the real OS clipboard', sysReads === 1 && pathAsked[0] === '/home/x/Pictures/scan.png', { sysReads, pathAsked });

    reset();
    await fire(evt(dt => dt.setData('text/uri-list', 'file:///home/x/note.txt')));
    ok('a copied non-photo says so instead of doing nothing', placed.length === 0 && toasts[0] === 'pdf.paste_not_image', { toasts });

    reset();
    const big = new File([new Uint8Array(10)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 65 * 1024 * 1024 });
    await fire(evt(dt => dt.items.add(big)));
    ok('an oversized photo is refused with a message, not placed', placed.length === 0 && toasts[0] === 'pdf.image_too_large', { toasts, placed });

    reset(); window.__pathTooBig = true;
    await fire(evt(dt => dt.setData('text/uri-list', 'file:///home/x/Pictures/enorme.png')));
    ok('a path main refuses reports the size, not a generic failure', placed.length === 0 && toasts[0] === 'pdf.image_too_large', { toasts });

    reset();
    document.getElementById('pdf-overlay').style.display = 'none';
    await fire(evt(dt => dt.items.add(new File([PNG], 'shot.png', { type: 'image/png' }))));
    document.getElementById('pdf-overlay').style.display = 'flex';
    ok('with the PDF closed the paste is none of its business', placed.length === 0 && sysReads === 0, { placed });

    reset();
    await fire(evt(dt => dt.items.add(new File([PNG], 'shot.png', { type: 'image/png' }))), document.getElementById('box'));
    ok('a text box mid-edit keeps its own paste', placed.length === 0, { placed });

    // Wired the way app.js wires it: on the document, capture phase.
    reset();
    document.addEventListener('paste', _onPdfPaste, true);
    const e11 = evt(dt => dt.items.add(new File([PNG], 'shot.png', { type: 'image/png' })));
    _pdfContainer.dispatchEvent(e11);
    await new Promise(r => setTimeout(r, 80));
    ok('a real paste event on the document reaches it and is consumed', placed.length === 1 && e11.defaultPrevented, { placed, prevented: e11.defaultPrevented });

    return log.join('\\\\n') + (lastErr ? '\\\\nTHREW: ' + lastErr : '');
  })()\`);
  console.log(out);
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
