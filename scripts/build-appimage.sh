#!/bin/bash
set -e

echo "=== Amelie AppImage Builder ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install Node.js 18+:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "   sudo apt install nodejs"
  exit 1
fi
echo "✓ Node.js $(node --version)"

# Check npm
echo "✓ npm $(npm --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Build AppImage
echo ""
echo "🔨 Building AppImage..."
npm run build

echo ""
echo "✅ Build complete!"
echo "   File: dist/Amelie-1.0.0.AppImage"
echo "   Run with: chmod +x dist/Amelie-*.AppImage && ./dist/Amelie-*.AppImage"
