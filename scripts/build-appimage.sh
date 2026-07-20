#!/bin/bash
set -e

echo "=== Inkwell AppImage Builder ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js non trovato. Installa Node.js 18+:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "   sudo apt install nodejs"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# Check npm
echo "✓ npm $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installazione dipendenze..."
npm install

# Build AppImage
echo ""
echo "🔨 Build AppImage..."
npm run build

echo ""
echo "✅ Build completata!"
echo "   File: dist/Inkwell-1.0.0.AppImage"
echo "   Esegui con: chmod +x dist/Inkwell-*.AppImage && ./dist/Inkwell-*.AppImage"
