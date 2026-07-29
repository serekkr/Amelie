#!/bin/bash
# Amelie — Uninstall from the system
set -e
G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; D='\033[2m'; N='\033[0m'

echo -e "\n${B}Amelie — Uninstall${N}\n"

echo -e "  ${D}Removing command and AppImage...${N}"
# The installed command is the ~/.local/bin/amelie wrapper (plus any backups
# and the old .AppImage variant). Remove everything starting with "amelie".
rm -f "$HOME"/.local/bin/amelie "$HOME"/.local/bin/amelie.AppImage "$HOME"/.local/bin/amelie.bak-* 2>/dev/null || true

echo -e "  ${D}Removing .desktop shortcut...${N}"
rm -f "$HOME/.local/share/applications/amelie.desktop"

echo -e "  ${D}Removing icons...${N}"
# Any size (256/512/scalable/…): find and delete all amelie.* files.
find "$HOME/.local/share/icons" -iname 'amelie.*' -delete 2>/dev/null || true

echo -e "  ${D}Removing amelie folders in .local...${N}"
rm -rf "$HOME/.local/share/amelie"

# If the app is still running, deleting the config leaves half-written files → warn.
if pgrep -f '\.local/share/amelie/Amelie\.AppImage|appimage_extracted_.*/amelie' >/dev/null 2>&1; then
  warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
  echo -e "  ${Y}! Amelie appears to be still running: close it before cleaning the config.${N}"
fi

echo -e "  ${D}Removing app state (recent, bookmarks, settings)...${N}"
# Electron userData: recent files, bookmarks, settings, cookies, cache, keyring-ref.
rm -rf "$HOME/.config/amelie"
rm -rf "$HOME/.cache/amelie" 2>/dev/null || true

# Legacy: old versions used to install a NOPASSWD rule for wg-quick/mount.cifs.
# Amelie no longer needs root at all, so clean the leftover rule up if it exists.
if [ -f /etc/sudoers.d/amelie ]; then
  echo -e "  ${D}Removing the legacy sudoers rule (no longer used)...${N}"
  sudo rm -f /etc/sudoers.d/amelie
  echo -e "  ${G}✓${N}  /etc/sudoers.d/amelie removed"
fi

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo ""
echo -e "${G}✓ Amelie removed from the system (app, shortcut, icons, recent, bookmarks, settings).${N}"
echo -e "${D}  Your NOTES were NOT touched — the vault folder you chose is left as is.${N}"
echo -e "${D}  To delete those too, remove that folder yourself.${N}"
echo ""
