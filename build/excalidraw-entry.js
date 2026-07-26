// Bundle entry for the drawing canvas (src/renderer/canvas.html).
//
// canvas.html loads `excalidraw-bundle.js` as a plain <script> and reads
// everything off `window.__ExcalidrawLib`, so this file only pulls Excalidraw +
// React in and hangs that object on the window. Keep it in sync with the
// destructuring at the top of canvas.html.
//
// Fonts are SELF-HOSTED from src/renderer/excalidraw-assets/: Excalidraw
// otherwise fetches them from a CDN, which the app's CSP blocks and which would
// break the canvas offline. canvas.html sets window.EXCALIDRAW_ASSET_PATH
// BEFORE loading this bundle — Excalidraw reads it at module init, so setting it
// afterwards is too late.
//
// Build with: npm run build:excalidraw
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import {
  Excalidraw,
  serializeAsJSON,
  restore,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw';

window.__ExcalidrawLib = {
  React, ReactDOM,
  Excalidraw, serializeAsJSON, restore, convertToExcalidrawElements,
};
window.excalidrawReady = true;
