// Code pasted into a note comes back out of the reading view exactly as it went in.
//
// Amelie's markdown extras ([[wiki links]], ==highlight==, :emoji:, {width=N}) are
// string rewrites that run BEFORE marked parses. They used to run over the whole
// note, code fences included — and bash's `[[ … ]]` is indistinguishable from a
// wiki link that way. A real script pasted into a note rendered like this:
//
//   was:  if [[ "$c" == */* ]]; then
//   saw:  if <a class="note-link" data-note="&quot;$c&quot; == */*" href="#">…
//
// printed literally into the middle of the code block, `&quot;` and all. That is
// the "quote" the user reported. This drives the REAL shipped functions out of
// src/renderer/app.js against the REAL script, plus the shipped marked bundle.
//
//   run: npm test
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const results = [];
const check = (n, pass, detail) => { results.push(pass); console.log(`${pass ? 'ok  ' : 'FAIL'}  ${n}${pass ? '' : `\n        ${detail}`}`); };

// Pull the two shipped functions out of app.js by brace matching, so the test runs
// the code that ships rather than a copy of it.
const APP = fs.readFileSync(path.join(REPO, 'src/renderer/app.js'), 'utf8');
function extract(name) {
  const start = APP.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0, i = APP.indexOf('{', start);
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
  }
  throw new Error(`${name} never closed`);
}

const pre = new Function(`var EMOJI_MAP = { smile: '\u{1F642}' };
${extract('_rewriteOutsideCode')}
${extract('_preprocessMarkdown')}
return _preprocessMarkdown;`)();
// jsdom only to read text back out of the rendered HTML, the way the app does.
const { window } = new JSDOM('<!doctype html><body></body>');

// The shipped markdown parser, so the assertions are about what really renders.
const markedSrc = fs.readFileSync(path.join(REPO, 'src/renderer/marked.min.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', 'window', 'self', 'globalThis', markedSrc)(mod, mod.exports, globalThis, globalThis, globalThis);
const marked = globalThis.marked || mod.exports.marked || mod.exports;
marked.setOptions({ breaks: true, gfm: true });

// ── 1. the real script, in a fence, is not touched at all ───────────────────
const script = fs.readFileSync(path.join(REPO, 'map-tiles-gen.sh'), 'utf8').replace(/\n$/, '');
const fenced = '```bash\n' + script + '\n```\n';
check('a real 303-line shell script in a fence is left byte-identical',
  pre(fenced) === fenced,
  (() => { const a = fenced.split('\n'), b = pre(fenced).split('\n');
           const i = a.findIndex((l, k) => l !== b[k]);
           return `first change at line ${i}:\n        was: ${a[i]}\n        now: ${b[i]}`; })());

// ── 2. and nothing shows an entity or a link on screen ──────────────────────
const html = marked.parse(pre(fenced));
check('the rendered code block shows no literal &quot;', !html.includes('&amp;quot;'),
  (html.match(/[^\n]*&amp;quot;[^\n]*/) || [''])[0].slice(0, 160));
check('and no <a> tag was printed into the code', !html.includes('note-link'),
  (html.match(/[^\n]*note-link[^\n]*/) || [''])[0].slice(0, 160));

// The code that comes back out of the block is the code that went in.
window.document.body.innerHTML = html;
const shown = window.document.querySelector('pre code').textContent.replace(/\n$/, '');
check('the code block hands back exactly what was pasted', shown === script,
  (() => { const i = [...script].findIndex((c, k) => c !== shown[k]);
           return `first difference at char ${i}: want ${JSON.stringify(script.slice(i, i + 40))} got ${JSON.stringify(shown.slice(i, i + 40))}`; })());

// ── 3. inside code: untouched. outside code: still rewritten ───────────────
const cases = [
  ['bash [[ ]] in a fence', '```\nif [[ "$c" == */* ]]; then\n```', s => s === '```\nif [[ "$c" == */* ]]; then\n```'],
  ['a tilde fence too', '~~~\nif [[ "$x" == y ]]; then\n~~~', s => s === '~~~\nif [[ "$x" == y ]]; then\n~~~'],
  ['an inline code span', 'prose `[[ "$c" == */* ]]` prose', s => s === 'prose `[[ "$c" == */* ]]` prose'],
  ['==text== in a fence', '```\na == b == c\n```', s => !s.includes('<mark')],
  [':emoji: in a fence', '```\nkey:smile:value\n```', s => s === '```\nkey:smile:value\n```'],
  ['a wiki link in prose IS a link', 'see [[My Note]] there', s => s.includes('class="note-link"') && s.includes('My Note')],
  ['==text== in prose IS highlighted', 'this is ==important== ok', s => s.includes('<mark class="md-highlight">important</mark>')],
  [':emoji: in prose IS an emoji', 'nice :smile: day', s => s.includes('\u{1F642}')],
  ['a heading link in prose stays plain text', 'see [[#Setup]] there', s => s === 'see Setup there'],
  ['an unclosed fence protects what follows', '```\nif [[ "$c" == y ]]; then', s => s.includes('[[ "$c" == y ]]')],
];
for (const [name, input, ok] of cases) {
  const got = pre(input);
  check(name, ok(got), JSON.stringify(got));
}

console.log(`\nall ${results.filter(Boolean).length} passed` .replace('all', results.every(Boolean) ? 'all' : `${results.filter(Boolean).length}/${results.length} —`));
process.exit(results.every(Boolean) ? 0 : 1);
