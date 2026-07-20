#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  Amelie — Installa nel sistema + configura permessi sudo
#  Uso: bash setup-system.sh
#       bash setup-system.sh /percorso/amelie.AppImage
#
#  Richiede sudo UNA SOLA VOLTA per:
#    • installare dipendenze (wireguard-tools, cifs-utils, fuse, imagemagick, ghostscript)
#    • creare la regola /etc/sudoers.d/amelie  (così dopo non chiede più password)
#    • installare l'AppImage e le icone
# ─────────────────────────────────────────────────────────────────────────────

# ── Colori ────────────────────────────────────────────────────────────────────
R='\033[0;31m'   # rosso
G='\033[0;32m'   # verde
Y='\033[1;33m'   # giallo
B='\033[0;34m'   # blu
C='\033[0;36m'   # ciano
W='\033[1;37m'   # bianco grassetto
D='\033[2m'      # dimmed
N='\033[0m'      # reset

hr() { printf "${D}%s${N}\n" "$(printf '─%.0s' {1..60})"; }

banner() {
  echo ""
  hr
  echo -e "${W}  Amelie — Installazione sistema${N}"
  echo -e "${D}  Note app con vault cifrato + sync WireGuard/Samba${N}"
  hr
  echo ""
}

step() { echo -e "\n${B}[${1}/${TOTAL_STEPS}]${N} ${W}${2}${N}"; }
ok()   { echo -e "  ${G}✓${N}  ${1}"; }
warn() { echo -e "  ${Y}⚠${N}  ${1}"; }
fail() { echo -e "  ${R}✗${N}  ${1}"; }
run()  { echo -e "  ${D}\$ ${*}${N}"; "$@"; }
info() { echo -e "  ${D}${1}${N}"; }

TOTAL_STEPS=6
banner

# ── Trova AppImage ────────────────────────────────────────────────────────────
if [ -n "$1" ] && [ -f "$1" ]; then
  APPIMAGE=$(realpath "$1")
else
  APPIMAGE=$(ls dist/[Aa]melie-[0-9]*.AppImage 2>/dev/null | sort -V | tail -1)
  if [ -z "$APPIMAGE" ]; then
    fail "AppImage non trovata. Esegui prima: bash scripts/install.sh"
    exit 1
  fi
  APPIMAGE=$(realpath "$APPIMAGE")
fi

USER_NAME=$(whoami)
info "AppImage : $APPIMAGE"
info "Utente   : $USER_NAME"
info "Sistema  : $(grep ^NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')"
echo ""

# ── Verifica sudo ─────────────────────────────────────────────────────────────
echo -e "${Y}Questa installazione richiede sudo per:${N}"
echo -e "  • Installare wireguard-tools, cifs-utils, fuse"
echo -e "  • Creare /etc/sudoers.d/amelie (permessi wg-quick e mount)"
echo ""
echo -e "${D}Inserisci la password di sudo quando richiesto.${N}"
echo -e "${D}Dopo questo setup, Amelie non chiederà più la password.${N}"
echo ""
sudo -v || { fail "sudo non disponibile"; exit 1; }

# ── [1/6] Dipendenze sistema ──────────────────────────────────────────────────
step 1 "Dipendenze sistema"

if command -v dnf &>/dev/null; then
  DISTRO="fedora"
  echo -e "  ${D}Rilevato: Fedora / RHEL${N}"

  PKGS_NEEDED=()
  for pkg in wireguard-tools cifs-utils fuse fuse-libs imagemagick ghostscript; do
    if ! rpm -q "$pkg" &>/dev/null; then
      PKGS_NEEDED+=("$pkg")
    else
      ok "$pkg (già installato)"
    fi
  done

  if [ ${#PKGS_NEEDED[@]} -gt 0 ]; then
    echo -e "  ${Y}Installo: ${PKGS_NEEDED[*]}${N}"
    run sudo dnf install -y "${PKGS_NEEDED[@]}"
  fi

elif command -v apt-get &>/dev/null; then
  DISTRO="debian"
  echo -e "  ${D}Rilevato: Ubuntu / Debian${N}"

  PKGS_NEEDED=()
  for pkg in wireguard wireguard-tools cifs-utils libfuse2 fuse imagemagick ghostscript; do
    if ! dpkg -l "$pkg" &>/dev/null; then
      PKGS_NEEDED+=("$pkg")
    else
      ok "$pkg (già installato)"
    fi
  done

  if [ ${#PKGS_NEEDED[@]} -gt 0 ]; then
    echo -e "  ${Y}Installo: ${PKGS_NEEDED[*]}${N}"
    run sudo apt-get install -y "${PKGS_NEEDED[@]}"
  fi

elif command -v pacman &>/dev/null; then
  DISTRO="arch"
  echo -e "  ${D}Rilevato: Arch Linux${N}"
  run sudo pacman -Sy --noconfirm wireguard-tools cifs-utils fuse2 imagemagick ghostscript
fi

ok "Dipendenze installate"

# ── [2/6] Regola sudoers per Amelie ───────────────────────────────────────────
step 2 "Configurazione permessi sudo"

echo -e "  ${D}Amelie usa sudo per:${N}"

WG_QUICK=$(which wg-quick 2>/dev/null || echo "/usr/bin/wg-quick")
MOUNT_BIN=$(which mount 2>/dev/null || echo "/usr/bin/mount")
UMOUNT_BIN=$(which umount 2>/dev/null || echo "/usr/bin/umount")
MOUNT_DIR="$HOME/.local/share/amelie/mounts"

echo ""
echo -e "  ${C}wg-quick${N}     — attiva/disattiva il tunnel WireGuard"
echo -e "  ${D}  \$ sudo wg-quick up ~/.amelie/wg-tunnel.conf${N}"
echo -e "  ${D}  \$ sudo wg-quick down ~/.amelie/wg-tunnel.conf${N}"
echo ""
echo -e "  ${C}mount.cifs${N}   — monta la share Samba remota"
echo -e "  ${D}  \$ sudo mount -t cifs //10.8.0.1/vault ~/.local/share/amelie/mounts/xxx${N}"
echo -e "  ${D}    -o username=user,password=•••,uid=$(id -u),vers=3.0${N}"
echo ""
echo -e "  ${C}umount${N}       — smonta dopo il sync"
echo -e "  ${D}  \$ sudo umount ~/.local/share/amelie/mounts/xxx${N}"
echo ""

SUDOERS_FILE="/etc/sudoers.d/amelie"
SUDOERS_CONTENT="# Amelie — permessi per WireGuard e Samba mount
# Generato da setup-system.sh il $(date '+%Y-%m-%d %H:%M')
$USER_NAME ALL=(ALL) NOPASSWD: $WG_QUICK
$USER_NAME ALL=(ALL) NOPASSWD: $MOUNT_BIN -t cifs *
$USER_NAME ALL=(ALL) NOPASSWD: $UMOUNT_BIN $MOUNT_DIR/*"

echo -e "  ${D}Scrivo $SUDOERS_FILE :${N}"
echo ""
echo -e "${D}┌─────────────────────────────────────────────────────────────┐${N}"
while IFS= read -r line; do
  printf "${D}│${N} %-61s ${D}│${N}\n" "$line"
done <<< "$SUDOERS_CONTENT"
echo -e "${D}└─────────────────────────────────────────────────────────────┘${N}"
echo ""

echo "$SUDOERS_CONTENT" | run sudo tee "$SUDOERS_FILE" > /dev/null
run sudo chmod 440 "$SUDOERS_FILE"

# Validate
if sudo visudo -c -f "$SUDOERS_FILE" &>/dev/null; then
  ok "Regola sudoers valida → $SUDOERS_FILE"
else
  fail "Errore nella regola sudoers — la rimuovo per sicurezza"
  sudo rm -f "$SUDOERS_FILE"
  exit 1
fi

# ── [3/6] Crea cartelle Amelie ────────────────────────────────────────────────
step 3 "Cartelle dati Amelie"

for dir in \
  "$HOME/.amelie" \
  "$HOME/.local/bin" \
  "$HOME/.local/share/amelie/mounts" \
  "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/256x256/apps" \
  "$HOME/.local/share/icons/hicolor/128x128/apps" \
  "$HOME/.local/share/icons/hicolor/64x64/apps" \
  "$HOME/.local/share/icons/hicolor/48x48/apps"; do
  mkdir -p "$dir"
  ok "$dir"
done

# ── [4/6] Installa AppImage ───────────────────────────────────────────────────
step 4 "Installa AppImage"

DEST="$HOME/.local/bin/amelie.AppImage"
run cp "$APPIMAGE" "$DEST"
run chmod +x "$DEST"
ok "Installata in $DEST"

# ── [5/6] Icone ───────────────────────────────────────────────────────────────
step 5 "Icone"

ICON_SRC="$(dirname "$0")/../assets/icon.png"
ICON_DIR="$HOME/.local/share/icons/hicolor"

if [ -f "$ICON_SRC" ]; then
  if command -v convert &>/dev/null; then
    for SIZE in 256 128 64 48; do
      TARGET="$ICON_DIR/${SIZE}x${SIZE}/apps/amelie.png"
      run convert "$ICON_SRC" -resize "${SIZE}x${SIZE}" "$TARGET" 2>/dev/null
      ok "Icona ${SIZE}×${SIZE}px"
    done
  else
    for SIZE in 256 128 64 48; do
      cp "$ICON_SRC" "$ICON_DIR/${SIZE}x${SIZE}/apps/amelie.png"
    done
    warn "ImageMagick non trovato — icone copiate senza ridimensionamento"
  fi
  mkdir -p "$ICON_DIR/scalable/apps"
  cp "$ICON_SRC" "$ICON_DIR/scalable/apps/amelie.png"
  gtk-update-icon-cache "$ICON_DIR" 2>/dev/null || true
  ok "Cache icone aggiornata"
else
  warn "assets/icon.png non trovata — aggiungi la tua icona e riesegui"
fi

# ── [6/6] File .desktop ───────────────────────────────────────────────────────
step 6 "Shortcut applicazione (.desktop)"

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
Keywords=note;markdown;appunti;vault;wireguard;
StartupWMClass=amelie
MimeType=text/markdown;
DESKTOP

chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database &>/dev/null; then
  run update-desktop-database "$HOME/.local/share/applications" 2>/dev/null
  ok "Database applicazioni aggiornato"
fi

ok "Shortcut creato: cerca 'Amelie' nel launcher"

# ── PATH check ────────────────────────────────────────────────────────────────
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo ""
  warn "~/.local/bin non è nel PATH. Aggiungi a ~/.bashrc o ~/.zshrc:"
  echo -e "  ${C}export PATH=\"\$HOME/.local/bin:\$PATH\"${N}"
fi

# ── Riepilogo ─────────────────────────────────────────────────────────────────
echo ""
hr
echo -e "${G}  ✓  Amelie installata con successo!${N}"
hr
echo ""
echo -e "${W}  Avvio:${N}"
echo -e "  ${C}amelie.AppImage${N}           — da terminale"
echo -e "  ${C}cerca 'Amelie' nel launcher${N} — GNOME / KDE"
echo ""
echo -e "${W}  Permessi configurati:${N}"
echo -e "  ${D}sudo wg-quick up/down${N}      — senza password"
echo -e "  ${D}sudo mount -t cifs${N}         — senza password"
echo -e "  ${D}sudo umount${N}                — senza password"
echo ""
echo -e "${W}  Dati:${N}"
echo -e "  ${D}~/.amelie/${N}                 — config, salt, wg-tunnel.conf"
echo -e "  ${D}~/.local/share/amelie/${N}     — mount temporanei sync"
echo -e "  ${D}Il tuo vault${N}               — scelto al primo avvio"
echo ""
echo -e "${W}  Disinstalla:${N}"
echo -e "  ${D}bash scripts/uninstall.sh${N}"
hr
echo ""

printf "Avvia Amelie adesso? [s/N] "
read -r ans
[[ "$ans" =~ ^[sS]$ ]] && "$DEST" &
