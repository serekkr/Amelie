// A photo, a recording or a video is listed in the FOLDER whose notes use it.
//
// Attachments all live in one flat place on disk (attachments/{videos,images,
// audio,pdf}/) and the sidebar used to list them only at the vault ROOT — so a
// vault with folders piled every video, recording and PDF at the bottom of the
// tree, nowhere near the notes they belong to. Nothing moves on disk: the tree
// now shows each attachment inside the folder that links it, in every one of
// them when several do, and keeps the unlinked ones at the root.
//
// The rule for "linked" is shared with attachment:usedBy and the unused-media
// sweep (attachmentRefsIn) — if those three ever disagreed, the sweep could
// delete a file the sidebar was showing inside a folder.
//
// This drives the REAL functions out of src/main/main.js against a REAL vault
// on disk, rather than a copy of them.
//
//   run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

const MAIN = fs.readFileSync(path.join(REPO, 'src/main/main.js'), 'utf8');
// Cut at the first closing brace in column 0 — brace COUNTING trips over the
// braces inside these functions' own regexes (/\{[^}]*\}$/ closes one it never
// opened). Every top-level function in main.js ends that way.
function extractFn(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in main.js`);
  const end = MAIN.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} never closed`);
  return MAIN.slice(start, end + 3);
}
const extractLine = (name) => {
  const m = MAIN.match(new RegExp(`^const ${name} = .*$`, 'm'));
  if (!m) throw new Error(`const ${name} not found in main.js`);
  return m[0];
};

// A vault laid out the way a user's is: two folders, notes at the root, and
// media that only exists in the flat attachments/ tree.
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-folders-'));
const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(VAULT, rel)), { recursive: true }); fs.writeFileSync(path.join(VAULT, rel), body); };
w('notes/diario.md',            '---\ncreated: 2026-08-01 09:00\n---\n\nUn appunto. [doc](attachments/pdf/manuale.pdf)\n');
w('notes/Progetti/piano.md',    '---\ncreated: 2026-08-02 09:00\n---\n\n![](attachments/videos/clip.mp4{width=400})\n');
w('notes/Progetti/2026/q3.md',  '---\ncreated: 2026-08-03 09:00\n---\n\nNiente media qui.\n');
w('notes/Riunioni/lunedi.md',   '---\ncreated: 2026-08-04 09:00\n---\n\n[audio](inkwell://attachments/audio/nota%20vocale.m4a) e il [video](attachments/videos/clip.mp4)\n');
w('notes/Archivio/vecchio.md',  '---\ncreated: 2026-08-05 09:00\n---\n\nSolo testo.\n');
w('attachments/videos/clip.mp4',        'v');
w('attachments/audio/nota vocale.m4a',  'a');
w('attachments/images/orfana.png',      'i');
w('attachments/pdf/manuale.pdf',        'p');

// The shipped functions, with only the module-level values they read stubbed.
const src = `
const fs = _fs, path = _path;
const ENC_EXT = '.enc', LEGACY_ENC_EXT = '.amd';
let ENCRYPTION_KEY = null;
const NOTES_DIR = _NOTES_DIR, ATTACHMENTS_DIR = _ATTACHMENTS_DIR;
const decryptContent = () => { throw new Error('not encrypted in this test'); };
const _noteCreatedISO = (p, stat) => stat.mtime.toISOString();
${extractLine('isOwnTempOrHidden')}
${extractLine('VIDEO_EXT_RE')}
${extractLine('AUDIO_EXT_RE')}
${extractLine('ATT_REF_RE')}
${extractFn('stripEnc')}
${extractFn('attachmentRefsIn')}
${extractLine('_noteLinkCache')}
${extractFn('_noteAttachmentLinks')}
${extractFn('_attachmentUsage')}
${extractFn('_attachmentPlacement')}
${extractFn('_collectAttachmentNodes')}
${extractFn('listNotesRecursive')}
return { listNotesRecursive, attachmentRefsIn, _noteLinkCache, _attachmentUsage };
`;
const api = new Function('_fs', '_path', '_NOTES_DIR', '_ATTACHMENTS_DIR', src)(
  fs, path, path.join(VAULT, 'notes'), path.join(VAULT, 'attachments'));

const tree = api.listNotesRecursive(path.join(VAULT, 'notes'));
const folder = (t, name) => (t.find(n => n.type === 'folder' && n.name === name) || {}).children || [];
const names = (nodes) => nodes.map(n => n.name).join(', ');
const mediaIn = (nodes) => nodes.filter(n => ['pdf', 'image', 'audio', 'video'].includes(n.type)).map(n => n.name);

// ── 1. media lands in the folder that uses it ───────────────────────────────
check('the video is listed inside the folder whose note embeds it',
  mediaIn(folder(tree, 'Progetti')).includes('clip.mp4'), names(folder(tree, 'Progetti')));
check('a percent-encoded link with a space in the name still resolves',
  mediaIn(folder(tree, 'Riunioni')).includes('nota vocale.m4a'), names(folder(tree, 'Riunioni')));
check('the same video used from a second folder shows in that one too',
  mediaIn(folder(tree, 'Riunioni')).includes('clip.mp4'), names(folder(tree, 'Riunioni')));
check('a folder whose notes use no media gets none',
  mediaIn(folder(tree, 'Archivio')).length === 0, names(folder(tree, 'Archivio')));
check('and neither does a nested folder that links nothing',
  mediaIn(folder(folder(tree, 'Progetti'), '2026')).length === 0,
  names(folder(folder(tree, 'Progetti'), '2026')));

// ── 2. the root keeps what belongs to it — and nothing else ─────────────────
check('a PDF linked from a root note stays at the root',
  mediaIn(tree).includes('manuale.pdf'), names(tree));
check('media nobody links stays at the root, where it can still be found',
  mediaIn(tree).includes('orfana.png'), names(tree));
check('the video is NOT left at the root as well',
  !mediaIn(tree).includes('clip.mp4'), names(tree));

// ── 3. every kind of node is still ordered the way it was ───────────────────
const kinds = folder(tree, 'Progetti').map(n => n.type);
check('folders first, then notes, then media — inside a subfolder too',
  kinds.join(',') === 'folder,note,video', kinds.join(','));

// ── 4. the same rule everywhere ─────────────────────────────────────────────
const refs = [...api.attachmentRefsIn('![](attachments/videos/clip.mp4{width=400}) [x](attachments/pdf/a.pdf#page=2) <img src="inkwell://attachments/images/b%20c.png">')];
check('attachmentRefsIn drops {width=…} and #fragments and decodes segments',
  refs.join('|') === 'videos/clip.mp4|pdf/a.pdf|images/b c.png', refs.join('|'));

// ── 5. a refresh must not re-read the whole vault ───────────────────────────
// The links of a note are cached against its size+mtime, so the second walk
// reads notes only if one of them changed.
const reads = [];
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('.md')) reads.push(String(p)); return realRead(p, ...rest); };
api.listNotesRecursive(path.join(VAULT, 'notes'));
const afterCache = reads.length;
// Touch one note: only that one is read again, and its media follows it.
w('notes/Archivio/vecchio.md', '---\ncreated: 2026-08-05 09:00\n---\n\nOra uso ![](attachments/images/orfana.png)\n');
fs.utimesSync(path.join(VAULT, 'notes/Archivio/vecchio.md'), new Date(), new Date(Date.now() + 2000));
reads.length = 0;
const tree2 = api.listNotesRecursive(path.join(VAULT, 'notes'));
const afterEdit = reads.slice();
fs.readFileSync = realRead;

check('a refresh with nothing changed re-reads no note at all',
  afterCache === 0, `${afterCache} notes re-read`);
check('after one note changes, exactly that note is read again',
  afterEdit.length === 1 && afterEdit[0].endsWith('vecchio.md'), afterEdit.join(', '));
check('and the photo it now links moves out of the root into that folder',
  mediaIn(folder(tree2, 'Archivio')).includes('orfana.png') && !mediaIn(tree2).includes('orfana.png'),
  `Archivio: ${names(folder(tree2, 'Archivio'))} | root: ${names(tree2)}`);

fs.rmSync(VAULT, { recursive: true, force: true });
console.log(`\n${results.every(Boolean) ? `all ${results.length} passed` : `${results.filter(Boolean).length}/${results.length} —`}`);
process.exit(results.every(Boolean) ? 0 : 1);
