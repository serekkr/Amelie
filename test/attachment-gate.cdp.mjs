// What may enter the vault as an attachment, checked on the real app.
//
// Two independent rules, and BOTH routes into the vault must apply them — attachment:save
// (bytes from the renderer: paste, drop, voice recorder) and attachment:importPath (a path
// main reads off disk). A rule enforced on one route only is not enforced: the renderer's
// own predicate is bypassable, so main has the final say.
//   1. the EXTENSION must be one Amelie supports (and the formats deliberately dropped —
//      ico, avif, ogg, oga, mka, mpg, flv — must stay out, `weba` must stay in: it is what
//      the built-in voice recorder writes)
//   2. the CONTENT must match it: an extension is a claim, and before the signature check
//      an executable renamed fake.png was stored as an image
// Also covers the renderer-side predicate, whose MIME fallback exists for name-less pasted
// screenshots and once accepted every dropped format back in (`audio/ogg` is "an audio").
//
//   run: npm run test:attach     (needs xvfb-run: dnf install xorg-x11-server-Xvfb)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';

for (const bin of ['xvfb-run']) {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); }
  catch { console.log(`SKIP: ${bin} not installed (dnf install xorg-x11-server-Xvfb)`); process.exit(0); }
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = '/tmp/amelie-attach-gate-test';
const VAULT = `${HOME}/vault`;
const SRC = `${HOME}/incoming`;
const PORT = 9262;

const results = [];
const check = (n, pass, detail) => { results.push({ n, pass }); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `   [${detail}]`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hex = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const wavBytes = () => {
  const rate = 8000, n = 400, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

// [name, bytes, expected, why]
const CASES = [
  // Supported extension, honest content → in.
  ['ok.png',   hex('89504e470d0a1a0a0000000d49484452'),                       'accept', 'a real PNG'],
  ['ok.jpg',   hex('ffd8ffe000104a464946'),                                   'accept', 'a real JPEG'],
  ['ok.gif',   Buffer.from('GIF89a\x01\x00\x01\x00'),                         'accept', 'a real GIF'],
  ['ok.webp',  Buffer.concat([Buffer.from('RIFF'), hex('24000000'), Buffer.from('WEBPVP8 ')]), 'accept', 'a real WebP'],
  ['ok.bmp',   Buffer.concat([Buffer.from('BM'), hex('36000000')]),           'accept', 'a real BMP'],
  ['ok.svg',   Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), 'accept', 'an SVG behind an XML declaration'],
  ['ok.pdf',   Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'),              'accept', 'a real PDF'],
  ['junk.pdf', Buffer.concat([Buffer.from('\n\n   '), Buffer.from('%PDF-1.4\n')]), 'accept', 'a PDF with junk before the header (readers tolerate it)'],
  ['ok.mp3',   Buffer.concat([Buffer.from('ID3'), hex('0300000000')]),         'accept', 'an MP3 with an ID3 tag'],
  ['bare.mp3', hex('fffb90c40000'),                                           'accept', 'an MP3 with no tag, bare frame sync'],
  ['ok.wav',   wavBytes(),                                                    'accept', 'a real WAV'],
  ['ok.flac',  Buffer.from('fLaC\x00\x00\x00"'),                              'accept', 'a real FLAC'],
  ['ok.opus',  Buffer.from('OggS\x00\x02'),                                   'accept', 'Opus, which ships in an Ogg container'],
  ['ok.weba',  hex('1a45dfa39f428680'),                                       'accept', 'what the voice recorder writes'],
  ['ok.mp4',   Buffer.concat([hex('0000001c'), Buffer.from('ftypisom')]),      'accept', 'a real MP4'],
  ['old.mov',  Buffer.concat([hex('00000010'), Buffer.from('moov')]),          'accept', 'QuickTime opening on moov, not ftyp'],
  // Supported extension, lying content → out.
  ['fake.png', Buffer.concat([hex('7f454c46'), Buffer.from('ELF executable')]), 'refuse', 'a Linux executable renamed .png'],
  ['fake.pdf', Buffer.concat([hex('4d5a9000'), Buffer.from('windows exe')]),   'refuse', 'a Windows executable renamed .pdf'],
  ['shell.pdf', Buffer.from('#!/bin/sh\nrm -rf ~\n'),                         'refuse', 'a shell script renamed .pdf'],
  ['fake.jpg', Buffer.from('PK\x03\x04 zip inside'),                          'refuse', 'a zip renamed .jpg'],
  ['fake.svg', Buffer.from('<html><script>alert(1)</script></html>'),         'refuse', 'HTML with a script, named .svg'],
  ['fake.mp3', Buffer.from('just text, not audio'),                           'refuse', 'plain text named .mp3'],
  ['fake.wav', Buffer.concat([Buffer.from('RIFF'), hex('24000000'), Buffer.from('AVI ')]), 'refuse', 'an AVI named .wav — right container, wrong form'],
  ['empty.png', Buffer.alloc(0),                                              'refuse', 'an empty file'],
  // Dropped extensions: refused whatever the bytes say.
  ['a.ogg',    Buffer.from('OggS\x00\x02'),                                   'refuse', 'ogg is no longer accepted'],
  ['a.oga',    Buffer.from('OggS\x00\x02'),                                   'refuse', 'oga is no longer accepted'],
  ['a.mka',    hex('1a45dfa39f428680'),                                       'refuse', 'mka is no longer accepted'],
  ['a.ico',    hex('00000100'),                                               'refuse', 'ico is no longer accepted'],
  ['a.avif',   Buffer.concat([hex('0000001c'), Buffer.from('ftypavif')]),      'refuse', 'avif is no longer accepted'],
  ['a.mpg',    hex('000001ba'),                                               'refuse', 'mpg is no longer accepted (mpeg still is)'],
  ['a.flv',    Buffer.from('FLV\x01'),                                        'refuse', 'flv is no longer accepted'],
  ['a.zip',    Buffer.from('PK\x03\x04'),                                     'refuse', 'never an attachment'],
  ['a.sh',     Buffer.from('#!/bin/sh\n'),                                    'refuse', 'never an attachment'],
];

let child = null;
const cleanup = () => {
  try { if (child) { const pgid = execSync(`ps -o pgid= -p ${child.pid}`).toString().trim(); if (pgid) process.kill(-Number(pgid), 'SIGKILL'); } } catch (_) {}
  try {
    for (const pid of execSync('pgrep -x electron || true').toString().split('\n').filter(Boolean)) {
      try { if (fs.readFileSync(`/proc/${pid}/environ`).includes(`HOME=${HOME}`)) process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
    }
  } catch (_) {}
};
process.on('exit', cleanup);

cleanup();
await sleep(300);
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(`${HOME}/.local/share/amelie`, { recursive: true });
fs.mkdirSync(`${VAULT}/notes`, { recursive: true });
fs.mkdirSync(SRC, { recursive: true });
fs.writeFileSync(`${VAULT}/notes/note.md`, 'A note, so the vault is not empty.\n');
fs.writeFileSync(`${HOME}/.local/share/amelie/amelie.json`, JSON.stringify({ vaultPath: VAULT, encryption: { enabled: false } }));
fs.writeFileSync(`${HOME}/.local/share/amelie/settings.json`, JSON.stringify({ autoSaveSeconds: 30, sync: { enabled: false } }));
for (const [name, buf] of CASES) fs.writeFileSync(`${SRC}/${name}`, buf);

child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', `${REPO}/node_modules/.bin/electron`, '.',
  '--ozone-platform=x11', `--remote-debugging-port=${PORT}`, '--no-sandbox', '--password-store=basic', '--disable-gpu'],
  { cwd: REPO, env: { ...process.env, HOME, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appErr = '';
child.stderr.on('data', (d) => { appErr += d; });

let target = null;
for (let i = 0; i < 40 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch (_) {}
}
if (!target) { console.error('the app never came up\n' + appErr.slice(-1200)); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, ms = 30000) => new Promise((res) => {
  const my = ++id; pending.set(my, res); ws.send(JSON.stringify({ id: my, method, params }));
  setTimeout(() => { if (pending.delete(my)) res({ timeout: true }); }, ms);
});
const ev = async (expr, ms = 30000) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ms);
  if (r.timeout) return '<<TIMEOUT>>';
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0];
  return r.result?.result?.value;
};
await send('Runtime.enable');
await sleep(3500);
for (let i = 0; i < 25; i++) {
  const n = await ev('typeof state !== "undefined" && state.notes ? state.notes.length : 0');
  if (typeof n === 'number' && n > 0) break;
  await sleep(400);
}

for (const [name, buf, expected, why] of CASES) {
  const bytes = JSON.stringify([...buf.subarray(0, 64)]);
  const r = await ev(`(async () => {
    const out = {};
    try { await window.inkwell.saveAttachment('bytes/' + ${JSON.stringify(name)}, new Uint8Array(${bytes})); out.save = 'accepted'; }
    catch (e) { out.save = 'refused: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+':\\s*/, '').slice(0, 40); }
    try { await window.inkwell.importAttachmentPath(${JSON.stringify(SRC)} + '/' + ${JSON.stringify(name)}, 'paths/' + ${JSON.stringify(name)}); out.imp = 'accepted'; }
    catch (e) { out.imp = 'refused: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+':\\s*/, '').slice(0, 40); }
    return out;
  })()`);
  const bytesOk = expected === 'accept' ? r.save === 'accepted' : String(r.save).startsWith('refused');
  const pathOk  = expected === 'accept' ? r.imp  === 'accepted' : String(r.imp).startsWith('refused');
  check(`${expected === 'accept' ? 'takes' : 'refuses'} ${name} on both routes — ${why}`,
    bytesOk && pathOk, `bytes: ${r.save} | path: ${r.imp}`);
}

// Nothing refused may have reached the disk, under any name.
const stored = [];
const walk = (d, rel) => { for (const it of fs.readdirSync(d, { withFileTypes: true })) {
  if (it.isDirectory()) walk(`${d}/${it.name}`, rel ? `${rel}/${it.name}` : it.name);
  else stored.push(rel ? `${rel}/${it.name}` : it.name); } };
if (fs.existsSync(`${VAULT}/attachments`)) walk(`${VAULT}/attachments`, '');
const refusedNames = CASES.filter(([, , e]) => e === 'refuse').map(([n]) => n);
const leaked = stored.filter((s) => refusedNames.some((n) => s.endsWith('/' + n) || s === n));
check('no refused file is on disk', leaked.length === 0, `found ${JSON.stringify(leaked)}`);
const acceptedNames = CASES.filter(([, , e]) => e === 'accept').map(([n]) => n);
const missing = acceptedNames.filter((n) => !stored.some((s) => s.endsWith('/' + n)));
check('every accepted file is on disk, on both routes',
  missing.length === 0 && stored.length === acceptedNames.length * 2,
  `missing ${JSON.stringify(missing)}; stored ${stored.length} of ${acceptedNames.length * 2}: ${JSON.stringify(stored)}`);

// The renderer-side predicate: its MIME fallback must not readmit a dropped format.
const mime = await ev(`(() => {
  const t = (name, type) => isSupportedAttachmentFile(new File([new Uint8Array([0, 1, 2, 3])], name, { type }));
  return {
    namelessPng: t('', 'image/png'),          // a pasted screenshot: the reason the fallback exists
    oggByMime:   t('song.ogg', 'audio/ogg'),
    avifByMime:  t('pic.avif', 'image/avif'),
    icoByMime:   t('icon.ico', 'image/x-icon'),
    tiffByMime:  t('scan.tiff', 'image/tiff'),
    zipByMime:   t('x.zip', 'application/zip'),
    png:         t('photo.png', 'image/png'),
  };
})()`);
check('a name-less pasted image is still accepted by its type', mime.namelessPng === true, JSON.stringify(mime));
check('the MIME fallback does not readmit ogg / avif / ico / tiff / zip',
  mime.oggByMime === false && mime.avifByMime === false && mime.icoByMime === false
  && mime.tiffByMime === false && mime.zipByMime === false, JSON.stringify(mime));
check('a plain PNG still passes', mime.png === true, JSON.stringify(mime));

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nall ${results.length} checks passed`);
try { ws.close(); } catch (_) {}
cleanup();
await sleep(500);
fs.rmSync(HOME, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
