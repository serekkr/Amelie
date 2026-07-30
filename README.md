<div align="center">
  <img src="assets/amelie.png" alt="Amelie" width="128" height="128" />
</div>

<div align="center">
  <img src="assets/hello-friend.gif" alt="Amelie — Hello friend! Your data, private by default" width="620" />
</div>

<div align="center">

[![Version](https://img.shields.io/github/v/release/serekkr/Amelie?label=version&color=3fb950)](https://github.com/serekkr/Amelie/releases/latest)
![Platform](https://img.shields.io/badge/platform-Linux-333?logo=linux&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![Language](https://img.shields.io/badge/code-JavaScript-f7df1e?logo=javascript&logoColor=black)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

</div>

---

## What is Amelie?

Amelie is a desktop note-taking application built around a plain-text Markdown
vault that lives entirely **on your own machine**. There is no telemetry and no
lock-in: your notes are ordinary `.md` files in a folder you
choose. When you *do* want your notes on more than one device, Amelie syncs them
to infrastructure **you** control — a Nextcloud/WebDAV server, a Samba share, or
a private machine reachable through a WireGuard or OpenVPN tunnel — and can keep the whole
vault **encrypted at rest** with a password only you know.

Amelie is free and open source. If you find it useful, you can support its
development:

<div align="center">

<a href="https://www.buymeacoffee.com/serekkr" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50" width="210"></a>

</div>

---

## ✨ Features

### Writing
- **CodeMirror editor** with a fast, distraction-free writing experience and
  syntax highlighting inside fenced code blocks.
- **Markdown reading view** — a toggled, formatted view of the current note.
- **Readable line length** — optional centered 760px measure, works with line
  numbers on or off.
- **Managed frontmatter** — `created` / `modified` handled for you and hidden in
  the reading view.
- **Images**: drag & drop, paste from clipboard, or insert from file — stored as
  attachments alongside the vault.

### Beyond text
- **To-do lists** — built-in task lists / checklists.
- **Mind maps** with zoom and reset.
- **PDF** — built-in viewer, editor and export.
- **Audio & video player** — play media inline in a note or straight from the
  sidebar, with seeking.
- **Infinite canvas / whiteboard** powered by Excalidraw.

### Organization
- **Folder-based vault** with a navigable file tree.
- **Live vault watcher** — external changes (file manager, sync) refresh the
  tree automatically, no restart needed.
- **Session & tab restore** — reopen exactly where you left off.
- **Search** across your notes — full text, and by file extension
  (`.pdf`, `.mp3`, `.draw`) to list files of one kind.
- **10 built-in themes** (Cyberpunk/GitHub-dark, Dracula, Nord, Gruvbox,
  Solarized, One Dark, Amber, Navy, Rose, and a Light theme).
- **7 UI languages**: English, Italiano, Español, Français, Deutsch, Polski, Română.

### Privacy & sync
- **Encrypted vault** — AES-256-GCM with an Argon2id password-derived key;
  notes and attachments are encrypted on disk.
- **WebDAV sync** — Nextcloud, ownCloud, or any WebDAV server.
- **Samba / SMB sync** — local network shares, via a bundled static SMB2/3 helper
  (no system `smbclient` required).
- **VPN + Samba** — reach a Samba share on a remote machine over a private
  **WireGuard or OpenVPN** tunnel; either VPN works for both **backup** and **sync**.
- **Atomic writes** — files are written to a temp name and renamed, so a second
  PC syncing at the same instant never sees a half-written file.
- **Connection-tested destinations** — remote backup/sync targets only enable
  after their connection test succeeds.
- **Autosave** with a local backup safety net.

---

## 🧱 Tech stack

Amelie is written in **JavaScript** and runs as an **Electron** desktop app.

| Layer            | Technology |
|------------------|------------|
| Runtime          | [Electron](https://www.electronjs.org/) (Chromium + Node.js) |
| Language         | JavaScript — no renderer framework, vanilla JS |
| Editor           | [CodeMirror](https://codemirror.net/) |
| Markdown         | `marked` + `DOMPurify` + `highlight.js` |
| Canvas           | [Excalidraw](https://excalidraw.com/) |
| PDF              | `pdf-lib` |
| Sync             | `webdav` (npm), bundled Go static SMB helper (`amelie-smb`), WireGuard, `rsync` |
| Encryption       | Node.js `crypto` — AES-256-GCM; Argon2id (`hash-wasm`) key derivation |
| Bundling         | `esbuild` (CodeMirror bundle) |
| Packaging        | `electron-builder` (AppImage) + a custom `.run` self-installer |
| Platform         | Linux (x86-64) |

> Exact bundled versions are listed on each [release](https://github.com/serekkr/Amelie/releases).


---

## 🚀 Installation

Download the latest `amelie_<version>.run` from the [releases](https://github.com/serekkr/Amelie/releases), then:

```bash
chmod +x amelie_*.run
./amelie_*.run
```

The app installs to your home directory and adds a desktop entry. To remove it:

```bash
amelie --uninstall        # or: ./amelie_*.run --uninstall
```

> Your notes are safe — uninstalling never deletes your vault folder.


---

## 🛠️ Build from source

Requires **Node.js 18+**. Clone the repo, then:

```bash
npm install          # install dependencies (Electron is fetched for your OS)
npm start            # run the app in development
```

To produce a distributable package:

```bash
npm run build        # AppImage (Linux, x64) — the default target
npm run build:mac    # macOS build
npm run build:win    # Windows build
```

> Amelie is developed and shipped for **Linux**. It runs from source on macOS and
> Windows via `npm start`, but the sync helpers (`rsync`, the Go SMB binary) are
> Linux-only, so those features won't work off Linux.
>
> The CodeMirror editor bundle (`src/renderer/vendor/cm.bundle.js`) is committed,
> so you don't need to build it. If you change the editor, rebuild it with
> `npm run build:cm`.

---

## 📁 Where your notes live

You pick the vault folder in the setup wizard. Inside it:

```
<your-vault>/
├── notes...              # your Markdown notes (.md) and drawings (.draw), in any folder structure
├── attachments/
│   ├── images/           # photos dropped into the vault
│   ├── audio/            # voice notes and audio files
│   ├── videos/
│   ├── pdf/
│   └── ...               # images pasted into a note live here, next to their note's text
└── .amelie-backups/      # local autosave safety net
```

Everything is plain files on your disk. Point any other tool at the same folder,
or back it up however you like.

---

## 📎 Supported file types

Notes are Markdown (`.md`) and drawings are `.draw`. Everything else you bring in is
an attachment, sorted into its own folder:

| Kind | Extensions | Stored in |
|---|---|---|
| Images | `png` `jpg` `jpeg` `gif` `webp` `svg` `bmp` | `attachments/images/` |
| Audio | `mp3` `wav` `flac` `m4a` `aac` `opus` `wma` `weba` | `attachments/audio/` |
| Video | `mp4` `webm` `mkv` `mov` `m4v` `avi` `wmv` `mpeg` | `attachments/videos/` |
| Documents | `pdf` | `attachments/pdf/` |

PDFs, photos, audio and video in those folders appear in the sidebar as files of their
own: you open a PDF or play a recording straight from the tree, without a note having to
embed it. An image pasted into a note belongs to that note instead, and stays out of the
sidebar.

Anything else — archives, executables, office documents — is refused with a message and
never saved. The extension alone is not enough either: Amelie reads the head of every
incoming file and refuses it when the bytes are not what the name claims, so an
executable renamed `photo.png` does not get in. (That is a check against mislabelling,
not a virus scan — Amelie never runs an attachment.)

**Search by extension.** Type an extension in the sidebar search to list files of that
kind — `.pdf`, `.mp3`, `.mp4`, `.png`, `.draw`, `.md` — and combine it with words as
usual: `invoice .pdf` narrows to PDFs whose name contains "invoice".

---

## 🔒 A note on privacy

Amelie collects nothing. Sync is entirely optional and
always to a destination you own and configure. With vault encryption enabled,
your notes are unreadable on disk without your password — including on the remote
share they sync to.

Your data is never locked to the app: [`recovery/`](recovery/) ships a small,
dependency-light Python script that decrypts a vault offline from your passphrase
alone — so you can always read your notes without Amelie.

---

## 📄 License

Released under the [MIT License](LICENSE).
