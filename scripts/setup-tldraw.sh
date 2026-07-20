#!/bin/bash
# Run this ONCE after npm install to build the tldraw bundle
set -e
echo "→ Installing tldraw..."
npm install @tldraw/tldraw

echo "→ Building bundle (~5-10s)..."
cat > tldraw-entry.mjs << 'ENTRY'
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Tldraw, createShapeId } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
window.__TldrawLib = { React, ReactDOM, Tldraw, createShapeId };
ENTRY

npx esbuild ./tldraw-entry.mjs \
  --bundle --format=iife \
  --outfile=src/renderer/tldraw-bundle.js \
  --platform=browser --minify \
  --define:process.env.NODE_ENV='"production"' \
  --loader:.woff2=dataurl \
  --loader:.woff=dataurl \
  --loader:.ttf=dataurl \
  --loader:.svg=dataurl \
  --loader:.png=dataurl \
  --loader:.jpg=dataurl \
  --loader:.gif=dataurl

rm -f tldraw-entry.mjs

echo "✓ tldraw ready:"
echo "   src/renderer/tldraw-bundle.js"
echo "   src/renderer/tldraw-bundle.css"
