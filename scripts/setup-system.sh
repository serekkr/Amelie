#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Amelie — Install into the system (AppImage, icons, launcher entry)
#  Usage: bash setup-system.sh
#         bash setup-system.sh /path/to/amelie.AppImage
#
#  Requires sudo ONCE, only to install the runtime dependencies
#  (fuse, imagemagick, ghostscript). Everything else is installed under $HOME.
# ─────────────────────────────────────────────────────────────────────────────

# ── Colors ────────────────────────────────────────────────────────────────────
R='\033[0;31m'   # red
G='\033[0;32m'   # green
Y='\033[1;33m'   # yellow
B='\033[0;34m'   # blue
C='\033[0;36m'   # cyan
W='\033[1;37m'   # bold white
D='\033[2m'      # dimmed
N='\033[0m'      # reset

hr() { printf "${D}%s${N}\n" "$(printf '─%.0s' {1..60})"; }

banner() {
  echo ""
  hr
  echo -e "${W}  Amelie — System install${N}"
  echo -e "${D}  Note app with encrypted vault + WireGuard/Samba sync${N}"
  hr
  echo ""
}

step() { echo -e "\n${B}[${1}/${TOTAL_STEPS}]${N} ${W}${2}${N}"; }
ok()   { echo -e "  ${G}✓${N}  ${1}"; }
warn() { echo -e "  ${Y}⚠${N}  ${1}"; }
fail() { echo -e "  ${R}✗${N}  ${1}"; }
run()  { echo -e "  ${D}\$ ${*}${N}"; "$@"; }
info() { echo -e "  ${D}${1}${N}"; }

TOTAL_STEPS=5
banner

# ── Find AppImage ─────────────────────────────────────────────────────────────
if [ -n "$1" ] && [ -f "$1" ]; then
  APPIMAGE=$(realpath "$1")
else
  APPIMAGE=$(ls dist/[Aa]melie-[0-9]*.AppImage 2>/dev/null | sort -V | tail -1)
  if [ -z "$APPIMAGE" ]; then
    fail "AppImage not found. Run first: bash scripts/install.sh"
    exit 1
  fi
  APPIMAGE=$(realpath "$APPIMAGE")
fi

USER_NAME=$(whoami)
info "AppImage : $APPIMAGE"
info "User     : $USER_NAME"
info "System   : $(grep ^NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')"
echo ""

# ── Check sudo ────────────────────────────────────────────────────────────────
echo -e "${Y}This installation requires sudo only to:${N}"
echo -e "  • Install the runtime dependencies (fuse, imagemagick, ghostscript)"
echo ""
echo -e "${D}Enter your sudo password when prompted.${N}"
echo ""
sudo -v || { fail "sudo not available"; exit 1; }

# ── [1/5] System dependencies ─────────────────────────────────────────────────
# fuse   → required to run the AppImage
# convert (ImageMagick) → resizes the launcher icons in step 4
# gs (ghostscript)      → PDF compression inside the app
# The VPN uses NetworkManager and Samba uses the bundled `amelie-smb` helper,
# so neither needs a package here. The NetworkManager-openvpn plugin (only for
# .ovpn configs) is offered by the app itself.
step 1 "System dependencies"

if command -v dnf &>/dev/null; then
  DISTRO="fedora"
  echo -e "  ${D}Detected: Fedora / RHEL${N}"

  PKGS_NEEDED=()
  for pkg in fuse fuse-libs ImageMagick ghostscript; do
    if ! rpm -q "$pkg" &>/dev/null; then
      PKGS_NEEDED+=("$pkg")
    else
      ok "$pkg (already installed)"
    fi
  done

  if [ ${#PKGS_NEEDED[@]} -gt 0 ]; then
    echo -e "  ${Y}Installing: ${PKGS_NEEDED[*]}${N}"
    run sudo dnf install -y "${PKGS_NEEDED[@]}"
  fi

elif command -v apt-get &>/dev/null; then
  DISTRO="debian"
  echo -e "  ${D}Detected: Ubuntu / Debian${N}"

  PKGS_NEEDED=()
  for pkg in libfuse2 fuse imagemagick ghostscript; do
    if ! dpkg -l "$pkg" &>/dev/null; then
      PKGS_NEEDED+=("$pkg")
    else
      ok "$pkg (already installed)"
    fi
  done

  if [ ${#PKGS_NEEDED[@]} -gt 0 ]; then
    echo -e "  ${Y}Installing: ${PKGS_NEEDED[*]}${N}"
    run sudo apt-get install -y "${PKGS_NEEDED[@]}"
  fi

elif command -v pacman &>/dev/null; then
  DISTRO="arch"
  echo -e "  ${D}Detected: Arch Linux${N}"
  run sudo pacman -Sy --noconfirm fuse2 imagemagick ghostscript
fi

ok "Dependencies installed"

# ── [2/5] Create Amelie folders ───────────────────────────────────────────────
step 2 "Amelie data folders"

for dir in \
  "$HOME/.local/bin" \
  "$HOME/.local/share/amelie" \
  "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/256x256/apps" \
  "$HOME/.local/share/icons/hicolor/128x128/apps" \
  "$HOME/.local/share/icons/hicolor/64x64/apps" \
  "$HOME/.local/share/icons/hicolor/48x48/apps"; do
  mkdir -p "$dir"
  ok "$dir"
done

# ── [3/5] Install AppImage ────────────────────────────────────────────────────
step 3 "Install AppImage"

DEST="$HOME/.local/bin/amelie.AppImage"
run cp "$APPIMAGE" "$DEST"
run chmod +x "$DEST"
ok "Installed to $DEST"

# ── [4/5] Icons ───────────────────────────────────────────────────────────────
step 4 "Icons"

ICON_SRC="$(dirname "$0")/../assets/icon.png"
ICON_DIR="$HOME/.local/share/icons/hicolor"

if [ -f "$ICON_SRC" ]; then
  if command -v convert &>/dev/null; then
    for SIZE in 256 128 64 48; do
      TARGET="$ICON_DIR/${SIZE}x${SIZE}/apps/amelie.png"
      run convert "$ICON_SRC" -resize "${SIZE}x${SIZE}" "$TARGET" 2>/dev/null
      ok "Icon ${SIZE}×${SIZE}px"
    done
  else
    for SIZE in 256 128 64 48; do
      cp "$ICON_SRC" "$ICON_DIR/${SIZE}x${SIZE}/apps/amelie.png"
    done
    warn "ImageMagick not found — icons copied without resizing"
  fi
  mkdir -p "$ICON_DIR/scalable/apps"
  cp "$ICON_SRC" "$ICON_DIR/scalable/apps/amelie.png"
  gtk-update-icon-cache "$ICON_DIR" 2>/dev/null || true
  ok "Icon cache updated"
else
  warn "assets/icon.png not found — add your icon and re-run"
fi

# ── [5/5] .desktop file ───────────────────────────────────────────────────────
step 5 "Application shortcut (.desktop)"

DESKTOP_FILE="$HOME/.local/share/applications/amelie.desktop"

cat > "$DESKTOP_FILE" << DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=Amelie
Exec=$DEST --appimage-extract-and-run %U
Icon=amelie
Terminal=false
StartupNotify=true
Categories=Office;TextEditor;Utility;
Keywords=note;markdown;notes;vault;wireguard;
StartupWMClass=amelie
MimeType=text/markdown;
DESKTOP

chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database &>/dev/null; then
  run update-desktop-database "$HOME/.local/share/applications" 2>/dev/null
  ok "Application database updated"
fi

ok "Shortcut created: search for 'Amelie' in the launcher"

# ── PATH check ────────────────────────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo ""
  warn "~/.local/bin is not in your PATH. Add to ~/.bashrc or ~/.zshrc:"
  echo -e "  ${C}export PATH=\"\$HOME/.local/bin:\$PATH\"${N}"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
hr
echo -e "${G}  ✓  Amelie installed successfully!${N}"
hr
echo ""
echo -e "${W}  Launch:${N}"
echo -e "  ${C}amelie.AppImage${N}           — from the terminal"
echo -e "  ${C}search 'Amelie' in the launcher${N} — GNOME / KDE"
echo ""
echo -e "${W}  Data:${N}"
echo -e "  ${D}~/.local/share/amelie/${N}     — config, salt, VPN configs (vpn/)"
echo -e "  ${D}Your vault${N}                 — chosen on first launch"
echo ""
echo -e "${W}  Uninstall:${N}"
echo -e "  ${D}bash scripts/uninstall.sh${N}"
hr
echo ""

printf "Launch Amelie now? [y/N] "
read -r ans
[[ "$ans" =~ ^[yY]$ ]] && "$DEST" &
