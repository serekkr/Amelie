#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Amelie — Build AppImage
#  Uso: cd inkwell && bash install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'

echo -e "${B}┌──────────────────────────────────────────┐${N}"
echo -e "${B}│          amelie — build AppImage         │${N}"
echo -e "${B}└──────────────────────────────────────────┘${N}"
echo ""

# ── Node.js ──────────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${Y}Node.js non trovato.${N}"
  # Detect distro
  if command -v dnf &>/dev/null; then
    echo -e "${B}→ Installo Node.js via dnf (Fedora/RHEL)...${N}"
    sudo dnf install -y nodejs npm
  elif command -v apt-get &>/dev/null; then
    echo -e "${B}→ Installo Node.js via apt...${N}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v pacman &>/dev/null; then
    echo -e "${B}→ Installo Node.js via pacman (Arch)...${N}"
    sudo pacman -Sy --noconfirm nodejs npm
  else
    echo -e "${R}Installa Node.js 18+ manualmente: https://nodejs.org${N}"; exit 1
  fi
fi

NODE_MAJOR=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo ok || echo fail)
if [ "$NODE_MAJOR" = "fail" ]; then
  echo -e "${R}Node.js troppo vecchio (serve ≥18). Aggiornalo prima.${N}"; exit 1
fi
echo -e "${G}✓ Node.js $(node --version)  npm $(npm --version)${N}"

# ── npm install ───────────────────────────────────────────────────────────────
echo -e "\n${B}→ npm install...${N}"
npm install
echo -e "${G}✓ Dipendenze installate${N}"

# ── Electron binary ───────────────────────────────────────────────────────────
if [ ! -f "node_modules/electron/dist/electron" ]; then
  echo -e "\n${B}→ Download Electron binary (~90MB)...${N}"
  cd node_modules/electron && node install.js && cd ../..
fi
echo -e "${G}✓ Electron ok${N}"

# ── Dipendenze sistema ────────────────────────────────────────────────────────
echo -e "\n${B}→ Dipendenze sistema per AppImage...${N}"
if command -v dnf &>/dev/null; then
  sudo dnf install -y fuse fuse-libs libappindicator-gtk3 2>/dev/null || true
elif command -v apt-get &>/dev/null; then
  for pkg in libfuse2 fuse; do
    dpkg -l "$pkg" &>/dev/null || sudo apt-get install -y "$pkg" 2>/dev/null || true
  done
fi
echo -e "${G}✓ Sistema ok${N}"

# ── Build AppImage ────────────────────────────────────────────────────────────
echo -e "\n${B}→ Build AppImage...${N}"
npx electron-builder --linux AppImage --x64 2>&1

AI=$(ls dist/[Aa]melie-[0-9]*.AppImage 2>/dev/null | sort -V | tail -1)
if [ -z "$AI" ]; then
  echo -e "${R}✗ Build fallita. Vedi output sopra.${N}"; exit 1
fi
chmod +x "$AI"

# ── Box Finale Allineato e Corretto ───────────────────────────────────────────
echo ""
echo -e "${G}╔══════════════════════════════════════════════════════════════════╗${N}"
echo -e "${G}║  ✓ AppImage pronta!                                              ║${N}"
echo -e "${G}║                                                                  ║${N}"
printf  "${G}║  File: %-58s ║${N}\n" "$AI"
echo -e "${G}║                                                                  ║${N}"
printf  "${G}║  Avvio rapido:  ./%-44s ║${N}\n" "$AI"
echo -e "${G}║  Installazione: bash scripts/setup-system.sh                     ║${N}"
echo -e "${G}╚══════════════════════════════════════════════════════════════════╝${N}"
echo ""

printf "Avvia Amelie adesso? [s/N] "
read -r ans
[[ "$ans" =~ ^[sS]$ ]] && "./$AI" &
