#!/bin/bash
# Amelie — Disinstalla dal sistema
set -e
G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; D='\033[2m'; N='\033[0m'

echo -e "\n${B}Amelie — Disinstallazione${N}\n"

echo -e "  ${D}Rimozione comando e AppImage...${N}"
# Il comando installato è il wrapper ~/.local/bin/amelie (più eventuali backup
# e la vecchia variante .AppImage). Tolgo tutto quanto inizia per "amelie".
rm -f "$HOME"/.local/bin/amelie "$HOME"/.local/bin/amelie.AppImage "$HOME"/.local/bin/amelie.bak-* 2>/dev/null || true

echo -e "  ${D}Rimozione shortcut .desktop...${N}"
rm -f "$HOME/.local/share/applications/amelie.desktop"

echo -e "  ${D}Rimozione icone...${N}"
# Qualunque dimensione (256/512/scalable/…): cerco e cancello tutte le amelie.* .
find "$HOME/.local/share/icons" -iname 'amelie.*' -delete 2>/dev/null || true

echo -e "  ${D}Rimozione cartelle amelie in .local...${N}"
rm -rf "$HOME/.local/share/amelie"

# Se l'app è ancora aperta, cancellare la config lascia file a metà → avviso.
if pgrep -f '\.local/share/amelie/Amelie\.AppImage|appimage_extracted_.*/amelie' >/dev/null 2>&1; then
  warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
  echo -e "  ${Y}! Amelie sembra ancora in esecuzione: chiudila prima di pulire la config.${N}"
fi

echo -e "  ${D}Rimozione stato app (recent, bookmarks, impostazioni)...${N}"
# userData Electron: recent files, segnalibri, impostazioni, cookie, cache, keyring-ref.
rm -rf "$HOME/.config/amelie"
rm -rf "$HOME/.cache/amelie" 2>/dev/null || true

echo -e "  ${D}Rimozione regola sudoers...${N}"
if [ -f /etc/sudoers.d/amelie ]; then
  sudo rm -f /etc/sudoers.d/amelie
  echo -e "  ${G}✓${N}  /etc/sudoers.d/amelie rimosso"
else
  echo -e "  ${D}(sudoers rule non presente)${N}"
fi

update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo ""
echo -e "${G}✓ Amelie rimossa dal sistema (app, shortcut, icone, recent, bookmarks, impostazioni).${N}"
echo -e "${D}  Le tue NOTE nel vault ~/.amelie NON sono state toccate.${N}"
echo -e "${D}  Per eliminare anche quelle: rm -rf ~/.amelie${N}"
echo ""
