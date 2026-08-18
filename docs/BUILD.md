# Amelie — Build & Install Guide

> This guide covers everything: building the AppImage, installing it on
> Fedora/Ubuntu/Arch, and how to create the app's custom icon.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [First build (step by step)](#2-first-build-step-by-step)
3. [Installing on the system](#3-installing-on-the-system)
4. [Creating the app icon](#4-creating-the-app-icon)
5. [Updating the app](#5-updating-the-app)
6. [Uninstalling](#6-uninstalling)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Prerequisites

### Fedora (recommended)

```bash
# Node.js 20 + npm
sudo dnf install -y nodejs npm

# AppImage dependencies
sudo dnf install -y fuse fuse-libs

# ImageMagick (for automatic icon resizing — optional but recommended)
sudo dnf install -y ImageMagick

# Check
node --version   # must be ≥ 18
npm --version
```

### Ubuntu / Debian

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs libfuse2 fuse imagemagick
node --version
```

### Arch Linux

```bash
sudo pacman -Sy nodejs npm fuse2 imagemagick
```

---

## 2. First build (step by step)

```bash
# 1. Enter the source folder
cd amelie   # (or wherever you extracted the archive)

# 2. Install npm dependencies
npm install

# 3. Build the AppImage
npx electron-builder --linux AppImage --x64
```

When it finishes you'll find the file in the `dist/` folder:

```
dist/amelie-1.0.1.AppImage
```

---

## 3. Installing on the system

The `setup-system.sh` script does everything automatically:

- Copies the AppImage into `~/.local/bin/amelie.AppImage`
- Installs the icons into `~/.local/share/icons/hicolor/`
- Creates the `.desktop` file at `~/.local/share/applications/amelie.desktop`
- Refreshes the icon and application databases

```bash
bash scripts/setup-system.sh
```

After a few seconds Amelie will show up by searching "Amelie" in the GNOME
Activities launcher or the KDE menu.

### How the .desktop file works

The created file is `~/.local/share/applications/amelie.desktop`:

```ini
[Desktop Entry]
Version=1.0
Type=Application
Name=Amelie
GenericName=Note App
Comment=Markdown notes app with an encrypted vault
Exec=/home/yourname/.local/bin/amelie.AppImage --appimage-extract-and-run %U
Icon=amelie
Terminal=false
StartupNotify=true
Categories=Office;TextEditor;Utility;
Keywords=note;markdown;notes;vault;
StartupWMClass=amelie
MimeType=text/markdown;
```

You can edit it by hand to customize the name, category, or `.md` file
association.

---

## 4. Creating the app icon

The icon must be a **square** high-resolution PNG. The minimum acceptable size
is **256×256px**, but we recommend **1024×1024px** as the source to resize from.

### Option A — Draw the icon yourself (Inkscape — recommended)

Inkscape is the best way to create a vector icon that scales to any size.

```bash
# Install Inkscape
sudo dnf install -y inkscape   # Fedora
sudo apt install -y inkscape   # Ubuntu
```

1. Open Inkscape → **File → Document Properties** → set the size to
   **1024 × 1024 px**
2. Draw your icon (you can take inspiration from the notebook logo in the app)
3. **File → Export PNG** → select the whole document → export as
   `assets/icon.png` at **1024px**
4. Also save the `.svg` file as `assets/icon.svg` for future use

### Option B — Generate the icon with AI

Go to one of these tools and ask for a flat/minimal-style icon:

- **DALL-E** (ChatGPT): *"App icon, flat design, dark background #0d1117, green accent #3fb950, notebook with lock symbol, minimal, 1024x1024"*
- **Midjourney**: same prompt
- **Stable Diffusion** (local): same thing

Download it as a 1024×1024 PNG and save it to `assets/icon.png`.

### Option C — Use an icon from an icon pack

Sites with free icons (search "notebook" or "notes app"):
- [Flaticon](https://www.flaticon.com) — free high-resolution PNGs
- [Iconscout](https://iconscout.com) — many Material/Flat packs
- [Noun Project](https://thenounproject.com) — simple icons

Download the **512×512 PNG** version or larger and save it as `assets/icon.png`.

### Automatic resizing

Once you have a high-resolution `assets/icon.png`, the `setup-system.sh` script
uses ImageMagick to automatically create all sizes (256, 128, 64, 48px).

If you want to do it manually:

```bash
# Create all sizes
for SIZE in 256 128 64 48; do
  mkdir -p "$HOME/.local/share/icons/hicolor/${SIZE}x${SIZE}/apps"
  convert assets/icon.png -resize "${SIZE}x${SIZE}" \
    "$HOME/.local/share/icons/hicolor/${SIZE}x${SIZE}/apps/amelie.png"
done

# Refresh cache
gtk-update-icon-cache ~/.local/share/icons/hicolor
```

### Updating the icon in the AppImage

The icon is embedded in the AppImage at build time. To change it:

1. Replace `assets/icon.png` with your new icon
2. Also update `build/icons/` if present (electron-builder reads it from there):
   ```bash
   mkdir -p build/icons
   cp assets/icon.png build/icons/1024x1024.png
   # Create the smaller versions too
   for SIZE in 512 256 128 64 48 32 16; do
     convert assets/icon.png -resize "${SIZE}x${SIZE}" build/icons/${SIZE}x${SIZE}.png
   done
   ```
3. Rebuild the AppImage: `npx electron-builder --linux AppImage --x64`
4. Reinstall: `bash scripts/setup-system.sh`

---

## 5. Updating the app

When you want to update the source code and rebuild:

```bash
cd amelie

# Rebuild
npx electron-builder --linux AppImage --x64

# Reinstall on the system (overwrites the previous version)
bash scripts/setup-system.sh
```

---

## 6. Uninstalling

```bash
bash scripts/uninstall.sh
```

This removes:
- `~/.local/bin/amelie.AppImage`
- `~/.local/share/applications/amelie.desktop`
- The icons in `~/.local/share/icons/hicolor/*/apps/amelie.png`

**Your data (vault, notes, settings) in `~/.amelie/` is NOT touched.**

To delete the data as well:
```bash
rm -rf ~/.amelie
```

---

## 7. Troubleshooting

### "FUSE not available" when starting the AppImage

```bash
# Fedora
sudo dnf install -y fuse fuse-libs
sudo modprobe fuse

# If it still doesn't work, start with --no-sandbox
./amelie.AppImage --no-sandbox
```

### The app doesn't appear in the launcher after installing

```bash
# Refresh the database manually
update-desktop-database ~/.local/share/applications
gtk-update-icon-cache ~/.local/share/icons/hicolor

# On GNOME: press Alt+F2, type "r", press Enter (restarts the shell)
# On KDE: restart Plasma
kquitapp5 plasmashell && kstart5 plasmashell
```

### Node.js too old on Fedora

```bash
# Remove the old version
sudo dnf remove nodejs npm

# Install from NodeSource (v20)
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

### "electron-builder: command not found" error

```bash
npm install  # make sure you ran it from the project folder
npx electron-builder --version  # use npx, not a global install
```

### The AppImage isn't executable

```bash
chmod +x dist/amelie-*.AppImage
```

---

## Project file structure

```
amelie/
├── src/
│   ├── main/
│   │   ├── main.js          ← Electron main process
│   │   └── preload.js       ← secure IPC bridge
│   ├── renderer/
│   │   ├── index.html       ← main UI
│   │   ├── app.js           ← renderer logic
│   │   ├── style.css        ← styles
│   │   ├── i18n.js          ← translations
│   │   ├── canvas.html      ← tldraw canvas (iframe)
│   │   ├── tldraw-bundle.js ← tldraw bundle
│   │   └── vault-setup.html ← first-run wizard
│   └── sync/
│       ├── syncManager.js   ← WebDAV/SMB/local sync
│       └── vpnTester.js     ← VPN connection test
├── assets/
│   └── icon.png             ← replace with your own icon
├── scripts/
│   ├── setup-system.sh      ← install on the system + .desktop
│   ├── uninstall.sh         ← remove from the system
│   └── build-appimage.sh    ← helper build script
├── docs/
│   └── BUILD.md             ← this guide
└── package.json
```

---

*Amelie is an Electron app for Linux. AES-256-GCM encrypted vault, WebDAV/SMB
sync, Markdown notes, tldraw canvas, mindmaps.*
