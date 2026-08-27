// Syntax highlighting off the main thread.
//
// hljs.highlightElement() does two expensive things on one thread: it runs the
// grammar over the code, and then hands the DOM the resulting HTML to parse.
// Only the second half needs the main thread — the grammar is a pure
// string→string function, so it runs here instead. Measured on a 300-line
// block: grammar 15 ms (bash) / 29 ms (javascript), DOM 16–43 ms. A code-heavy
// note used to spend all of it in one go and the UI went rough.
//
// This is a plain same-directory worker on purpose: the renderer is a file://
// page and under its CSP (default-src 'self') a same-directory worker script
// starts fine, while a blob: worker is refused — "worker-src was not explicitly
// set, so script-src is used as a fallback".
importScripts('highlight.min.js');

// { id, code, lang } → { id, html }. html is null when the language is not one
// hljs knows: the caller then leaves the block exactly as it is, which is what
// highlightElement's own no-language fallback amounts to. The code string is
// never altered here — hljs only escapes it into markup.
self.onmessage = (e) => {
  const { id, code, lang } = e.data || {};
  let html = null;
  try {
    if (self.hljs && lang && hljs.getLanguage(lang)) {
      html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
  } catch (_) { html = null; }
  self.postMessage({ id, html });
};
