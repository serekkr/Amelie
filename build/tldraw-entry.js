// Bundle entry for the drawing canvas (src/renderer/canvas.html).
//
// canvas.html loads `tldraw-bundle.js` as a plain <script> and reads everything
// off `window.__TldrawLib`, so this file's only job is to pull tldraw + React in
// and hang that one object on the window. Keep the shape in sync with the
// destructuring at the top of canvas.html.
//
// Assets (fonts/icons/translations/embed-icons) are SELF-HOSTED from
// src/renderer/tldraw-assets/ so the canvas works with no network: that's what
// `getAssetUrls({ baseUrl })` from @tldraw/assets/selfHosted resolves against.
// If you bump tldraw, re-copy those folders from @tldraw/assets — they're
// version-specific.
//
// Build with: npm run build:tldraw
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import { Tldraw, createShapeId } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';

window.__TldrawLib = { React, ReactDOM, Tldraw, createShapeId, getAssetUrls };
window.tldrawReady = true;
