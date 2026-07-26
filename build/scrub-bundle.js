#!/usr/bin/env node
// Post-build pass over src/renderer/excalidraw-bundle.js.
//
// Excalidraw ships its own excalidraw.com service configuration inside the npm
// package — Firebase credentials, collaboration/library/AI backend URLs. None of
// it is ours and none of it is reachable from Amelie: the canvas has no
// collaboration, and the app's CSP blocks external hosts anyway. Bundled as-is
// it just means a Google API key string sits in a public repository, which
// GitHub's secret scanning (rightly) flags.
//
// So blank the credentials and point the service URLs at nothing. Purely
// subtractive: it removes the ability to reach servers we never call.
//
// Run automatically by `npm run build:excalidraw`.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'src', 'renderer', 'excalidraw-bundle.js');
let src = fs.readFileSync(FILE, 'utf8');
const before = src.length;

const edits = [
  // Google/Firebase API key → empty string
  [/"apiKey":"AIza[A-Za-z0-9_-]{30,}"/g, '"apiKey":""'],
  // excalidraw.com service endpoints → empty string
  [/"https:\/\/[a-z0-9.-]*excalidraw\.com[^"]*"/g, '""'],
  [/"https:\/\/[a-z0-9.-]*\.cloudfunctions\.net[^"]*"/g, '""'],
];

let total = 0;
for (const [re, to] of edits) {
  const n = (src.match(re) || []).length;
  if (n) { src = src.replace(re, to); total += n; }
}

fs.writeFileSync(FILE, src);

const leftover = /AIza[A-Za-z0-9_-]{30,}/.exec(src);
if (leftover) {
  console.error('[scrub-bundle] an API key is still present — refusing to pass silently');
  process.exit(1);
}
console.log(`[scrub-bundle] neutralised ${total} entries (${before - src.length} bytes removed)`);
