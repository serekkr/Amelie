const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, clipboard, net } = require('electron');
const { pathToFileURL } = require('url');

// The inkwell:// scheme streams attachments (audio seeking needs working
// Range requests) — must be declared BEFORE app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'inkwell', privileges: { supportFetchAPI: true, stream: true } },
]);
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { argon2id } = require('hash-wasm');   // memory-hard KDF for new vaults (WASM, no native build)
const { WireGuardManager } = require('../sync/wireguardManager');

// Last-resort safety net: without these, an unhandled promise rejection in the
// main process can destabilize/terminate the app with no trace. Log it (don't
// blanket-swallow — a genuinely fatal state still shows up in the logs).
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});

// GPU acceleration re-enabled: the NVIDIA+Wayland crash workaround below was a
// leftover from the old Dell (NVIDIA dGPU). This machine is Intel Arc (xe driver),
// where hardware acceleration works fine and software rendering only adds CPU load
// + heavy framebuffer copies to the compositor. Keep in-process-gpu (it also
// prevents an extra taskbar window). To restore the old behavior on an NVIDIA box,
// uncomment the two lines below.
// app.disableHardwareAcceleration();
// app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('in-process-gpu');
// GPU RASTERIZATION stays on, but COMPOSITING is done in software. On this
// compositor (Wayland + in-process GPU) hardware compositing leaves stale tiles —
// "ghost" rectangles in the editor where code-block boxes were once drawn — that
// no repaint (reflow, invalidate, opacity nudge, even a full DOM rebuild) can
// clear. Software compositing avoids the leak with a negligible cost for a text
// app (raster is still GPU-accelerated). Full software rendering (disableGpu)
// is no longer needed for this glitch.
app.commandLine.appendSwitch('disable-gpu-compositing');
// ── No OS keyring / wallet on startup ────────────────────────────────────────
// On KDE (this user) two separate mechanisms would pop a KWallet password dialog:
//   1) the legacy os_crypt password store → force 'basic' (plaintext key, no kwallet)
//   2) Chromium's os_crypt_async SecretPortalKeyProvider (default-ON since ~Cr130)
//      which asks xdg-desktop-portal for a secret → xdg-desktop-portal-kde opens
//      the wallet ("The application 'xdg-desktop-portal' has requested to open the
//      wallet"). Disable that feature so no portal-secret request is ever made.
// Baked in code (not just the launcher) so it holds no matter how the app is
// started (wrapper, .desktop, a KDE-cached exec line) — and ONLY here: the
// launcher used to repeat it on the command line, which changed nothing except
// putting "--password-store=basic" in `ps aux`/htop, where it reads as "the app
// keeps a password in the clear". Measured with it removed from the launcher:
// the selected backend is still basic_text and the switch still reads as set.
// Cost: the "remember
// password" passkey is protected by a weak key — acceptable; the wallet is
// unusable/annoying on this box anyway. See notes on the kwallet startup hang.
// No OS keyring, on any distro. 'basic' = plaintext os_crypt key (no kwallet/
// gnome-keyring access) → never hangs/prompts, portable everywhere. Amelie no
// longer stores the vault passphrase (the "remember password" feature was
// removed), so safeStorage isn't used for secrets anyway; 'basic' only covers
// the SMB/WebDAV credential blob in settings.json, which is fine.
app.commandLine.appendSwitch('password-store', 'basic');
// Also block Chromium's os_crypt_async SecretPortalKeyProvider (a separate path
// that pops a KWallet/portal dialog on KDE).
app.commandLine.appendSwitch('disable-features', 'SecretPortalKeyProvider');
// User-controllable startup flags, read from settings.json synchronously BEFORE
// app 'ready' (only pre-ready switches + disableHardwareAcceleration() work here):
//   disableGpu → software rendering. NOTE: does NOT save system RAM — with
//                in-process-gpu there's no separate GPU process to drop.
//   lowMemory  → Chromium low-end-device-mode; now ALWAYS on (toggle removed v643).
try {
  const _cfgP = path.join(os.homedir(), '.local', 'share', 'amelie', 'settings.json');
  const _cfg = fs.existsSync(_cfgP) ? JSON.parse(fs.readFileSync(_cfgP, 'utf8')) : {};
  app.commandLine.appendSwitch('enable-low-end-device-mode');
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
  if (_cfg && _cfg.disableGpu) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
  }
} catch (_) {}
// Chromium sandbox left ENABLED: on this distro unprivileged user namespaces work,
// so the renderer is sandboxed without the SUID helper. (The main process — where
// VPN/Samba/polkit commands are spawned — is never sandboxed, so that's unaffected.)

// Single instance: if Amelie is already open, a second invocation brings the
// existing window to the foreground instead of opening a duplicate (which could
// be a different version, causing confusion).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Vault & Config ───────────────────────────────────────────────────────────
// Global app config lives in ~/.local/share/amelie/amelie.json (vault path +
// encryption settings) — the same folder that holds the installed app, so the
// home directory stays clean. The vault itself can be anywhere the user chose.

const APP_HOME  = path.join(os.homedir(), '.local', 'share', 'amelie');
const APP_CFG   = path.join(APP_HOME, 'amelie.json');   // global app config
if (!fs.existsSync(APP_HOME)) fs.mkdirSync(APP_HOME, { recursive: true });

// Window chrome is OS-specific. Linux/Windows: a frameless window with our own
// titlebar buttons (minimize/maximize/close, drawn top-right in index.html).
// macOS: keep the native inset traffic-lights instead — drawing our own buttons
// on top of them would show TWO sets of controls; the renderer hides the custom
// ones on mac (html.is-mac .tb-btn). Setting frame:false AND titleBarStyle on mac
// was the bug that produced the doubled controls.
const WINDOW_CHROME = process.platform === 'darwin'
  ? { titleBarStyle: 'hiddenInset' }
  : { frame: false };

// One-shot migration: the config used to live in ~/.amelie. Move everything
// into APP_HOME (merging directories, never overwriting), then drop the old
// folder. Runs before anything reads APP_HOME.
(function migrateOldAppHome() {
  const oldHome = path.join(os.homedir(), '.amelie');
  if (oldHome === APP_HOME || !fs.existsSync(oldHome)) return;
  const move = (from, to) => {
    if (!fs.existsSync(to)) { fs.renameSync(from, to); return; }
    if (fs.statSync(from).isDirectory() && fs.statSync(to).isDirectory()) {
      for (const f of fs.readdirSync(from)) move(path.join(from, f), path.join(to, f));
      try { fs.rmdirSync(from); } catch (_) {}
    }
  };
  try {
    for (const f of fs.readdirSync(oldHome)) move(path.join(oldHome, f), path.join(APP_HOME, f));
    if (!fs.readdirSync(oldHome).length) fs.rmdirSync(oldHome);
    console.log('[Config] migrated ~/.amelie →', APP_HOME);
  } catch (e) { console.error('[Config] migration from ~/.amelie failed:', e.message); }
})();

function readAppConfig() {
  try { return JSON.parse(fs.readFileSync(APP_CFG, 'utf8')); } catch(_) { return {}; }
}
function writeAppConfig(cfg) {
  fs.writeFileSync(APP_CFG, JSON.stringify(cfg, null, 2), 'utf8');
}

// Resolved at startup from app config
let VAULT_DIR       = null;
let NOTES_DIR       = null;
let ATTACHMENTS_DIR = null;
let CONFIG_FILE     = null;  // per-vault sync/settings config
let VAULT_HEADER_FILE = null; // <vault>/.amelie-vault.json — envelope key header (in the vault, syncs)
let ENCRYPTION_KEY  = null;  // Buffer(32) or null — the DATA key (DEK) once unlocked
let ENCRYPTION_ALGO = 'aes'; // AES-256-GCM only. (ChaCha20 was removed — absent from Electron's BoringSSL. The
                             // decrypt paths below still RECOGNISE a 'chacha' header defensively so no vault can
                             // ever become unreadable, but the app never CREATES chacha content anymore.)
let KDF = 'pbkdf2';          // key-derivation: 'argon2id' (new vaults) | 'scrypt' (older vaults) | 'pbkdf2' (legacy). Set on unlock/enable from config.
// scrypt cost params — memory-hard, resists GPU/ASIC brute-force far better than
// PBKDF2. N*r*128 ≈ 32 MiB. These are part of the vault format: changing them
// breaks decryption, so they're fixed (and mirrored in recovery/amelie-recovery.py).
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 };
// Argon2id — OWASP's first-choice KDF, used for NEW vaults (kdf: 'argon2id').
// Profile: 19 MiB memory, 2 passes, 1 lane (OWASP minimum m=19456 KiB, t=2, p=1).
// Like SCRYPT_PARAMS these are part of the vault format — changing them breaks
// decryption of vaults created with the old values, so they're fixed.
const ARGON2_PARAMS = { memorySize: 19456, iterations: 2, parallelism: 1 };
// Normalise a header/config kdf string to one of the three we support; anything
// unknown (or a pre-envelope legacy vault) falls back to pbkdf2.
function normKdf(v) { return (v === 'scrypt' || v === 'argon2id') ? v : 'pbkdf2'; }

function resolveVaultPaths(vaultDir) {
  VAULT_DIR       = vaultDir;
  NOTES_DIR       = path.join(vaultDir, 'notes');
  // Attachments live at the VAULT ROOT (<vault>/attachments/{media,pdf,…}),
  // siblings of notes/ — same layout the sync already uses remotely.
  ATTACHMENTS_DIR = path.join(vaultDir, 'attachments');
  // One-shot migration: attachments used to live under notes/attachments.
  // Merge-move them to the vault root. On a name collision the copy under
  // notes/ wins (it's what the app was actually serving); a different stray
  // file at the root is kept as *.bak-premigration, never deleted.
  (function migrateNestedAttachments() {
    const old = path.join(NOTES_DIR, 'attachments');
    if (!fs.existsSync(old) || old === ATTACHMENTS_DIR) return;
    const moveMerge = (from, to) => {
      if (!fs.existsSync(to)) { fs.renameSync(from, to); return; }
      const fromDir = fs.statSync(from).isDirectory(), toDir = fs.statSync(to).isDirectory();
      if (fromDir && toDir) {
        for (const f of fs.readdirSync(from)) moveMerge(path.join(from, f), path.join(to, f));
        try { fs.rmdirSync(from); } catch (_) {}
      } else if (!fromDir && !toDir) {
        try {
          if (fs.readFileSync(from).equals(fs.readFileSync(to))) { fs.rmSync(from, { force: true }); return; }
          fs.renameSync(to, to + '.bak-premigration');
        } catch (_) {}
        fs.renameSync(from, to);
      }
    };
    try {
      moveMerge(old, ATTACHMENTS_DIR);
      console.log('[Vault] migrated notes/attachments →', ATTACHMENTS_DIR);
    } catch (e) { console.error('[Vault] attachments migration failed:', e.message); }
  })();
  // One-shot: the custom folder-icon feature was removed; drop its storage
  // (attachments/icons) from the vault. Media folders are untouched.
  try { fs.rmSync(path.join(ATTACHMENTS_DIR, 'icons'), { recursive: true, force: true }); } catch (_) {}
  CONFIG_FILE     = path.join(APP_HOME, 'settings.json');  // in the app-data folder, not in vault
  VAULT_HEADER_FILE = path.join(vaultDir, '.amelie-vault.json');  // envelope header — lives IN the vault so it syncs across PCs
  [vaultDir, NOTES_DIR, ATTACHMENTS_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  startVaultWatcher();   // (re)watch the new notes/ so external file-manager changes refresh the tree
}

// Watch NOTES_DIR and ATTACHMENTS_DIR (recursively — supported on Linux since Node
// 20.13) so that adding, deleting or renaming notes, folders OR attachments (PDFs,
// images, …) from OUTSIDE the app (e.g. the file manager) refreshes Amelie's tree
// without a restart — otherwise a PDF renamed on disk kept showing its old name,
// since PDFs live under attachments/, which used to be unwatched. Only structural
// changes ('rename' events) trigger a refresh; content edits ('change') and
// hidden/temp files are ignored. The notification is debounced so a bulk rename
// fires a single reload.
let _vaultWatchers = [], _vaultWatchTimer = null, _internalWriteUntil = 0;
function startVaultWatcher() {
  for (const w of _vaultWatchers) { try { w.close(); } catch (_) {} }
  _vaultWatchers = [];
  const scheduleRefresh = () => {
    if (_vaultWatchTimer) clearTimeout(_vaultWatchTimer);
    _vaultWatchTimer = setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault:treeChanged'); } catch (_) {}
    }, 350);
  };
  for (const dir of [NOTES_DIR, ATTACHMENTS_DIR]) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      const w = fs.watch(dir, { recursive: true }, (event, filename) => {
        if (event !== 'rename') return;                       // create/delete/rename only
        if (filename && /(^|[\\/])\.|\.tmp$|\.amelie-/.test(filename)) return;  // skip hidden / atomic-write temp
        if (Date.now() < _internalWriteUntil) return;         // our own save — the UI already refreshes itself
        scheduleRefresh();
      });
      w.on('error', () => {});                                // a transient watch error must not crash main
      _vaultWatchers.push(w);
    } catch (_) {}
  }
}

// ── Credential encryption at rest (SMB / WebDAV passwords) ──────────────────
// Beyond the 0600 file perms, the SMB/WebDAV passwords in settings.json are
// encrypted at rest and stored as an object ({ __sec } via the OS keyring, or
// { __enc } via an app-level key when the keyring is unavailable) — so a
// plaintext password is NEVER written to disk. They're decrypted only in-memory:
// at the point of use (sync) and when handing the config to the renderer UI.
// OpenVPN needs none of this (its password lives only in NetworkManager).
// See credCrypto.js for the encryption details.
const { encSecret, decSecret } = require('./credCrypto');
const _SEC_PATHS = [
  ['sync', 'vpn', 'smb', 'password'],
  ['sync', 'twoway', 'smb', 'password'],
  ['sync', 'twoway', 'smbLan', 'password'],
  ['sync', 'twoway', 'webdav', 'password'],
  ['sync', 'webdav', 'password'],
  ['sync', 'samba', 'password'],
  ['sync', 'sambaLan', 'password'],
];
// Return a deep clone of `cfg` with every known secret path mapped through `fn`.
function mapConfigSecrets(cfg, fn) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = JSON.parse(JSON.stringify(cfg));
  for (const p of _SEC_PATHS) {
    let o = out;
    for (let i = 0; i < p.length - 1; i++) {
      if (o[p[i]] == null || typeof o[p[i]] !== 'object') { o = null; break; }
      o = o[p[i]];
    }
    if (o && Object.prototype.hasOwnProperty.call(o, p[p.length - 1])) {
      o[p[p.length - 1]] = fn(o[p[p.length - 1]]);
    }
  }
  return out;
}
// One-time: encrypt any pre-existing PLAINTEXT secret in settings.json (e.g. a
// password saved before this feature). No-op if all secrets are already {__sec}
// or empty. Run at startup once CONFIG_FILE is known.
function migrateConfigSecrets() {
  try {
    if (!CONFIG_FILE || !fs.existsSync(CONFIG_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const enc = mapConfigSecrets(raw, encSecret);
    if (JSON.stringify(raw) !== JSON.stringify(enc)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(enc, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
      console.log('[sec] migrated plaintext SMB/WebDAV password(s) → encrypted at rest');
    }
  } catch (e) { console.error('[sec] config-secret migration failed:', e.message); }
}

// settings.json can hold a credential (the SMB share password), so keep it
// owner-only 0600. writeFileSync's `mode` only applies on CREATE, so also chmod
// to fix a pre-existing 0644 file. SMB/WebDAV passwords are encrypted at rest
// (mapConfigSecrets/encSecret) — idempotent (already-encrypted {__sec} kept as-is).
function writeConfig(obj) {
  const onDisk = mapConfigSecrets(obj, encSecret);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

// ─── Privacy: keep vault files out of the OS "Recent Files" list ─────────────
// GTK's GtkRecentManager (~/.local/share/recently-used.xbel) auto-records files
// opened/saved through system dialogs or shell.openPath. For a privacy-focused
// vault that leaks note & attachment paths into the desktop taskbar's "Recent
// Files" menu (e.g. right-clicking the Amelie icon on Fedora/GNOME/KDE). We
// scrub — on startup, periodically while running, and on quit — every entry
// that points inside the vault OR was registered by Amelie itself. Operating on
// individual <bookmark> blocks via regex preserves the <xbel> wrapper intact.
function scrubRecentDocuments() {
  try {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const xbel = path.join(dataHome, 'recently-used.xbel');
    if (!fs.existsSync(xbel)) return;
    const src = fs.readFileSync(xbel, 'utf8');
    const vaultUrl = VAULT_DIR ? 'file://' + VAULT_DIR + '/' : null;
    let removed = 0;
    const out = src.replace(/<bookmark\b[\s\S]*?<\/bookmark>/g, (block) => {
      const m = block.match(/href="([^"]*)"/);
      let decoded = m ? m[1] : '';
      try { decoded = decodeURIComponent(decoded); } catch (_) {}
      const inVault  = vaultUrl && decoded.startsWith(vaultUrl);
      const byAmelie = /<bookmark:application\b[^>]*\bname="amelie"/i.test(block);
      if (inVault || byAmelie) { removed++; return ''; }
      return block;
    });
    if (!removed) return;
    const tmp = xbel + '.amelie-tmp';
    fs.writeFileSync(tmp, out);
    fs.renameSync(tmp, xbel);   // atomic replace
    console.log(`[Privacy] scrubbed ${removed} vault/Amelie entr${removed === 1 ? 'y' : 'ies'} from recent files`);
  } catch (e) {
    console.error('[Privacy] scrubRecentDocuments failed:', e.message);
  }
}

// ─── Encryption ───────────────────────────────────────────────────────────────
// AES-256-GCM. Encrypted notes get the extension .enc on disk (the logical
// name stays <stem>.md inside the app). Format: base64 [12 IV][ct][16 GCM tag].

const ENC_EXT = '.enc';        // encrypted note marker (was .amd before v1.0.402)
const LEGACY_ENC_EXT = '.amd'; // pre-v1.0.402 marker — migrated to .enc on unlock
const SALT_FILE = path.join(APP_HOME, '.salt');
const PASSKEY_FILE = path.join(APP_HOME, '.passkey');  // OS-keyring-encrypted passphrase (remember-password)
const VERIFY_FILE = path.join(APP_HOME, '.verify');    // key-verification token (works even when the vault is decrypted on disk)
const VERIFY_PLAINTEXT = 'AMELIE_VERIFY_V1';
// "Plaintext while open" mode: the vault is decrypted on disk while Amelie runs
// and re-encrypted on quit. _REENCRYPT_KEY holds the key for that re-encryption.
let _REENCRYPT_KEY = null;
let _reencryptDone = false;

// Inspect the OS secret backend safeStorage will use. On Linux a 'basic_text'
// backend means there is NO keyring (KWallet/libsecret) → encryptString only
// obfuscates, so we must warn the user before storing the passphrase there.
function storageBackendInfo() {
  try {
    const { safeStorage } = require('electron');
    const available = !!safeStorage.isEncryptionAvailable();
    let backend = 'unknown';
    try { backend = safeStorage.getSelectedStorageBackend?.() || 'unknown'; } catch (_) {}
    const secure = available && backend !== 'basic_text';
    return { available, backend, secure };
  } catch (_) { return { available: false, backend: 'unknown', secure: false }; }
}

function getOrCreateSalt() {
  if (fs.existsSync(SALT_FILE)) return fs.readFileSync(SALT_FILE);
  // Cross-device: a synced encrypted vault carries its salt in the header. Adopt
  // it so the same password derives the same KEK here as on the origin PC.
  try {
    const h = readVaultHeader();
    if (h && h.salt) { const s = Buffer.from(h.salt, 'hex'); fs.writeFileSync(SALT_FILE, s); return s; }
  } catch (_) {}
  const salt = crypto.randomBytes(32);
  fs.writeFileSync(SALT_FILE, salt);
  return salt;
}

async function deriveKey(passphrase, kdf, salt) {
  salt = salt || getOrCreateSalt();
  const k = kdf || KDF;
  if (k === 'argon2id') {
    // Memory-hard, OWASP's preferred KDF. Output depends only on
    // (passphrase, salt, m, t, p, 32) so it's reproducible offline.
    const out = await argon2id({
      password: passphrase, salt,
      memorySize:  ARGON2_PARAMS.memorySize,
      iterations:  ARGON2_PARAMS.iterations,
      parallelism: ARGON2_PARAMS.parallelism,
      hashLength: 32, outputType: 'binary',
    });
    return Buffer.from(out);
  }
  if (k === 'scrypt') {
    // maxmem must exceed 128*N*r (~32 MiB) or scryptSync throws; output depends
    // only on (passphrase, salt, N, r, p, 32), so the recovery tool reproduces it.
    return crypto.scryptSync(passphrase, salt, 32,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: 256 * 1024 * 1024 });
  }
  return crypto.pbkdf2Sync(passphrase, salt, 310000, 32, 'sha512');   // legacy vaults
}

// Notes use an AEAD (authenticated) cipher, base64-stored as [12 nonce][ct][16 tag].
// Both AES-256-GCM and ChaCha20-Poly1305 share that exact layout, so the only
// difference is the OpenSSL cipher name — picked by the vault's chosen algorithm
// (ENCRYPTION_ALGO), set from config on unlock/enable. The whole vault uses one
// algo (switching = disable→re-enable, which re-encrypts everything), so reading
// back with the configured algo is unambiguous.
function aeadName(algo) {
  return (algo || ENCRYPTION_ALGO) === 'chacha' ? 'chacha20-poly1305' : 'aes-256-gcm';
}

// Whether this runtime can actually use a cipher. Electron's BoringSSL builds
// (e.g. Electron 42) ship NO ChaCha20 in node:crypto — createCipheriv throws
// 'Unknown cipher'. Probe once so the UI can hide it and enable can fail cleanly
// instead of throwing mid-encryption.
const _cipherOk = {};
function cipherAvailable(algo) {
  const a = algo === 'chacha' ? 'chacha' : 'aes';
  if (a in _cipherOk) return _cipherOk[a];
  try {
    crypto.createCipheriv(aeadName(a), crypto.randomBytes(32), crypto.randomBytes(12), { authTagLength: 16 });
    _cipherOk[a] = true;
  } catch (_) { _cipherOk[a] = false; }
  return _cipherOk[a];
}

function encryptContent(plaintext, key, algo) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(aeadName(algo), key, iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString('base64');
}

function decryptContent(b64, key, algo) {
  const buf = Buffer.from(b64, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const enc = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv(aeadName(algo), key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

// ─── At-rest encryption for ATTACHMENTS (images / pdf / audio / video) ───────
// Notes use AES-256-GCM (read whole, small). Attachments can be large and the
// media server serves them with HTTP Range requests (audio/video seeking), so
// GCM (all-or-nothing, authenticated) can't be byte-seeked. Attachments use
// AES-256-CTR instead — seekable: any plaintext byte range decrypts by setting
// the counter to its block offset. On-disk layout, original filename kept:
//   [8-byte magic 'AMELIEC1'][16-byte IV/initial-counter][CTR ciphertext]
// Two self-describing magic headers so an attachment decrypts correctly from its
// own bytes regardless of the current config. Both followed by a 16-byte IV.
//   AES   → AES-256-CTR  (16-byte big-endian counter block, block size 16)
//   ChaCha→ ChaCha20 raw (OpenSSL IV = [4-byte LE counter][12-byte nonce], block 64)
// Both are seekable stream ciphers (the media server needs Range/seek).
const ATT_MAGIC_AES = Buffer.from('AMELIEC1');  // 8 bytes — legacy AES-256-CTR (unauthenticated)
const ATT_MAGIC_CHA = Buffer.from('AMELIEH1');  // 8 bytes — legacy ChaCha20 (unauthenticated, dead)
const ATT_MAGIC_LEN = 8;
const ATT_HEADER = ATT_MAGIC_LEN + 16;          // magic + IV (legacy CTR/ChaCha layout)
// Authenticated attachment format (current, for all NEW writes): AES-256-GCM,
// CHUNKED so Range/seek still works (media server) while every chunk is
// tamper-evident. The legacy CTR/ChaCha formats above are seekable but NOT
// authenticated — on a synced vault (SMB/WebDAV) an attacker with write access
// could flip/truncate/splice an attachment undetected. Layout:
//   [8 magic 'AMELIEG1'][12 base nonce][4 chunkSize BE]
//   then repeated: [chunk ciphertext][16-byte GCM tag]   (last chunk shorter)
// Per-chunk nonce = baseNonce + chunkIndex (96-bit add) → unique within a file;
// baseNonce is random so cross-file nonce reuse is negligible. Legacy files stay
// readable (dispatch in decrypt/stream/size) and upgrade to GCM on migrate/rekey.
const ATT_MAGIC_GCM = Buffer.from('AMELIEG1');  // 8 bytes
const ATT_GCM_HEADER = ATT_MAGIC_LEN + 12 + 4;  // magic + 12B base nonce + 4B chunkSize
const ATT_GCM_CHUNK = 65536;

// AES-CTR counter: whole 16-byte IV as a big-endian int, + N blocks (mod 2^128).
function aesIvAdd(iv, blocks) {
  let n = 0n;
  for (const byte of iv) n = (n << 8n) | BigInt(byte);
  n = (n + BigInt(blocks)) & ((1n << 128n) - 1n);
  const out = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
// ChaCha20 counter: first 4 bytes little-endian, + N blocks (32-bit wrap).
function chachaIvAdd(iv, blocks) {
  const out = Buffer.from(iv);
  out.writeUInt32LE(((out.readUInt32LE(0) + blocks) >>> 0), 0);
  return out;
}
const ATT_SPEC = {
  aes:    { magic: ATT_MAGIC_AES, name: 'aes-256-ctr', blockSize: 16, ivAdd: aesIvAdd },
  chacha: { magic: ATT_MAGIC_CHA, name: 'chacha20',    blockSize: 64, ivAdd: chachaIvAdd },
};
function attSpec(algo) { return ATT_SPEC[(algo || ENCRYPTION_ALGO) === 'chacha' ? 'chacha' : 'aes']; }
// Read the magic and return which algo encrypts this file, or null if plaintext.
function attachmentAlgo(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(ATT_MAGIC_LEN);
    const n = fs.readSync(fd, b, 0, ATT_MAGIC_LEN, 0);
    fs.closeSync(fd);
    if (n !== ATT_MAGIC_LEN) return null;
    if (b.equals(ATT_MAGIC_GCM)) return 'gcm';
    if (b.equals(ATT_MAGIC_AES)) return 'aes';
    if (b.equals(ATT_MAGIC_CHA)) return 'chacha';
    return null;
  } catch (_) { return null; }
}
function isEncryptedAttachment(filePath) { return attachmentAlgo(filePath) !== null; }
// Same check against an in-memory buffer (whole-file reads).
function bufIsEncryptedAttachment(buf) {
  if (!buf || buf.length < ATT_MAGIC_LEN) return false;
  const h = buf.subarray(0, ATT_MAGIC_LEN);
  return h.equals(ATT_MAGIC_GCM) || h.equals(ATT_MAGIC_AES) || h.equals(ATT_MAGIC_CHA);
}
function bufAttachmentAlgo(buf) {
  if (!buf || buf.length < ATT_MAGIC_LEN) return null;
  const h = buf.subarray(0, ATT_MAGIC_LEN);
  if (h.equals(ATT_MAGIC_GCM)) return 'gcm';
  if (h.equals(ATT_MAGIC_CHA)) return 'chacha';
  if (h.equals(ATT_MAGIC_AES)) return 'aes';
  return null;
}

// ── GCM (authenticated, chunked) primitives ──────────────────────────────────
function _u32be(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
function _attNonce(base, i) {   // 96-bit: baseNonce + chunkIndex
  let n = 0n;
  for (const b of base) n = (n << 8n) | BigInt(b);
  n = (n + BigInt(i)) & ((1n << 96n) - 1n);
  const out = Buffer.alloc(12);
  for (let p = 11; p >= 0; p--) { out[p] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function encryptAttachmentGcm(buf, key, chunk = ATT_GCM_CHUNK) {
  const base = crypto.randomBytes(12);
  const parts = [Buffer.concat([ATT_MAGIC_GCM, base, _u32be(chunk)])];
  for (let off = 0, i = 0; off < buf.length; off += chunk, i++) {
    const slice = buf.subarray(off, Math.min(off + chunk, buf.length));
    const c = crypto.createCipheriv('aes-256-gcm', key, _attNonce(base, i));
    parts.push(c.update(slice), c.final(), c.getAuthTag());
  }
  return Buffer.concat(parts);
}
function decryptAttachmentGcm(buf, key) {
  const base = buf.subarray(ATT_MAGIC_LEN, ATT_MAGIC_LEN + 12);
  const chunk = buf.readUInt32BE(ATT_MAGIC_LEN + 12);
  const out = [];
  let pos = ATT_GCM_HEADER, i = 0;
  while (pos < buf.length) {
    const encLen = Math.min(chunk + 16, buf.length - pos);
    if (encLen < 16) throw new Error('corrupt attachment (short GCM chunk)');
    const ct = buf.subarray(pos, pos + encLen - 16);
    const tag = buf.subarray(pos + encLen - 16, pos + encLen);
    const d = crypto.createDecipheriv('aes-256-gcm', key, _attNonce(base, i));
    d.setAuthTag(tag);
    out.push(d.update(ct), d.final());   // final() throws on tag mismatch (tamper)
    pos += encLen; i++;
  }
  return Buffer.concat(out);
}
// Plaintext length of a GCM attachment from its on-disk size (no full read).
function gcmPlainSize(fileSize, chunk) {
  const body = fileSize - ATT_GCM_HEADER;
  if (body <= 0) return 0;
  const enc = chunk + 16;
  const full = Math.floor(body / enc);
  const rem = body - full * enc;
  return full * chunk + (rem > 0 ? Math.max(0, rem - 16) : 0);
}

function encryptAttachmentBuffer(buf, key) {
  // All NEW writes use the authenticated (GCM, chunked) format.
  return encryptAttachmentGcm(buf, key);
}

function decryptAttachmentBuffer(buf, key) {
  // Dispatch by magic so legacy CTR/ChaCha attachments stay readable.
  if (bufAttachmentAlgo(buf) === 'gcm') return decryptAttachmentGcm(buf, key);
  const algo = buf.subarray(0, ATT_MAGIC_LEN).equals(ATT_MAGIC_CHA) ? 'chacha' : 'aes';
  const spec = attSpec(algo);
  const iv   = buf.subarray(ATT_MAGIC_LEN, ATT_HEADER);
  const dec  = crypto.createDecipheriv(spec.name, key, iv);
  return Buffer.concat([dec.update(buf.subarray(ATT_HEADER)), dec.final()]);
}

// Streaming Range reader for a GCM attachment: yields plaintext [start,end]
// (inclusive) chunk by chunk, verifying each chunk's tag; never buffers the
// whole range. Errors the stream on tamper.
function attachmentGcmStream(full, start, end, key) {
  const { Readable } = require('stream');
  const fd = fs.openSync(full, 'r');
  const hdr = Buffer.alloc(ATT_GCM_HEADER);
  fs.readSync(fd, hdr, 0, ATT_GCM_HEADER, 0);
  const base = hdr.subarray(ATT_MAGIC_LEN, ATT_MAGIC_LEN + 12);
  const chunk = hdr.readUInt32BE(ATT_MAGIC_LEN + 12);
  const enc = chunk + 16;
  const size = fs.fstatSync(fd).size;
  let idx = Math.floor(start / chunk);
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { fs.closeSync(fd); } catch (_) {} } };
  return new Readable({
    read() {
      try {
        for (;;) {
          if (idx * chunk > end) { close(); this.push(null); return; }
          const encPos = ATT_GCM_HEADER + idx * enc;
          const encAvail = size - encPos;
          if (encAvail <= 0) { close(); this.push(null); return; }
          const encLen = Math.min(enc, encAvail);
          const encBuf = Buffer.alloc(encLen);
          fs.readSync(fd, encBuf, 0, encLen, encPos);
          const ct = encBuf.subarray(0, encLen - 16);
          const tag = encBuf.subarray(encLen - 16);
          const d = crypto.createDecipheriv('aes-256-gcm', key, _attNonce(base, idx));
          d.setAuthTag(tag);
          const plain = Buffer.concat([d.update(ct), d.final()]);
          const chunkStart = idx * chunk;
          const from = Math.max(0, start - chunkStart);
          const to = Math.min(plain.length, end - chunkStart + 1);
          idx++;
          if (to > from) { this.push(plain.subarray(from, to)); return; }
        }
      } catch (e) { close(); this.destroy(e); }
    },
    destroy(err, cb) { close(); cb(err); },
  });
}
// True plaintext size of ANY encrypted attachment (GCM computed from its header;
// legacy CTR/ChaCha = filesize - header). Used for Content-Length / Range math.
function attachmentPlainSize(onDisk) {
  const size = fs.statSync(onDisk).size;
  if (attachmentAlgo(onDisk) === 'gcm') {
    const fd = fs.openSync(onDisk, 'r');
    const b = Buffer.alloc(4);
    try { fs.readSync(fd, b, 0, 4, ATT_MAGIC_LEN + 12); } finally { fs.closeSync(fd); }
    return gcmPlainSize(size, b.readUInt32BE(0));
  }
  return Math.max(0, size - ATT_HEADER);
}

// A Readable that yields decrypted PLAINTEXT bytes [start, end] (inclusive) of an
// encrypted attachment, streaming (used by the media server for Range seeking).
function attachmentPlainStream(full, start, end, key) {
  if (attachmentAlgo(full) === 'gcm') return attachmentGcmStream(full, start, end, key);
  const spec = attSpec(attachmentAlgo(full));
  const ivBuf = Buffer.alloc(16);
  const fd = fs.openSync(full, 'r');
  fs.readSync(fd, ivBuf, 0, 16, ATT_MAGIC_LEN);
  fs.closeSync(fd);
  const BS = spec.blockSize;
  const alignedStart = Math.floor(start / BS) * BS;
  let toSkip = start - alignedStart;
  const counterIV = spec.ivAdd(ivBuf, alignedStart / BS);
  const decipher = crypto.createDecipheriv(spec.name, key, counterIV);
  const src = fs.createReadStream(full, { start: ATT_HEADER + alignedStart, end: ATT_HEADER + end });
  const { Transform } = require('stream');
  const trimmer = new Transform({
    transform(chunk, _enc, cb) {
      if (toSkip > 0) {
        if (chunk.length <= toSkip) { toSkip -= chunk.length; return cb(); }
        chunk = chunk.subarray(toSkip); toSkip = 0;
      }
      cb(null, chunk);
    },
  });
  src.on('error', e => trimmer.destroy(e));
  decipher.on('error', e => trimmer.destroy(e));
  return src.pipe(decipher).pipe(trimmer);
}

// One-shot / idempotent: encrypt every plaintext file under ATTACHMENTS_DIR.
// Safe to call repeatedly — files already carrying the magic header are skipped.
function migrateAttachmentsEncrypt(key) {
  if (!key || !ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return;
  let enc = 0, ren = 0;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (item.name.endsWith('.amelie-enc-tmp') || item.name.startsWith('.amelie-import-')) continue;   // temps
      const hasEncName = item.name.endsWith(ENC_EXT);
      const algo = attachmentAlgo(full);
      if (algo === 'gcm') {
        // Already in the authenticated format — just ensure the .enc marker.
        if (!hasEncName) {
          try { if (!fs.existsSync(full + ENC_EXT)) { fs.renameSync(full, full + ENC_EXT); ren++; } }
          catch (e) { console.error('[enc] attachment rename failed:', full, e.message); }
        }
        continue;
      }
      if (algo) {
        // Legacy UNauthenticated (CTR/ChaCha) attachment → upgrade to the
        // authenticated GCM format in place (atomic tmp+rename), so old media
        // gains tamper-evidence too. ChaCha files (dead cipher) will fail to
        // decrypt and are left untouched.
        try {
          const plain = decryptAttachmentBuffer(fs.readFileSync(full), key);
          const dest = hasEncName ? full : full + ENC_EXT;
          const tmp = dest + '.amelie-enc-tmp';
          fs.writeFileSync(tmp, encryptAttachmentGcm(plain, key));
          fs.renameSync(tmp, dest);
          if (!hasEncName && dest !== full) fs.unlinkSync(full);
          enc++;
        } catch (e) { console.error('[enc] attachment GCM upgrade failed:', full, e.message); }
        continue;
      }
      // Plaintext file → encrypt at rest, naming it <name>.enc (or keep an
      // existing .enc name if it somehow held plaintext).
      try {
        const out = encryptAttachmentBuffer(fs.readFileSync(full), key);
        const dest = hasEncName ? full : full + ENC_EXT;
        const tmp = dest + '.amelie-enc-tmp';
        fs.writeFileSync(tmp, out);
        fs.renameSync(tmp, dest);
        if (!hasEncName) fs.unlinkSync(full);   // drop the plaintext original
        enc++;
      } catch (e) { console.error('[enc] attachment encrypt failed:', full, e.message); }
    }
  };
  try { walk(ATTACHMENTS_DIR); } catch (e) { console.error('[enc] attachment walk failed:', e.message); }
  if (enc || ren) console.log(`[enc] attachments: encrypted ${enc}, marked .enc ${ren}`);
}

// One-time migration: rename legacy encrypted notes (.amd) to the current
// marker (.enc). RENAME ONLY — the ciphertext is byte-identical, so this is
// safe and crash-safe (per-file rename, idempotent: nothing left to do once all
// are .enc). Runs on unlock/enable, before any note is listed or read.
function migrateNoteExt() {
  if (LEGACY_ENC_EXT === ENC_EXT || !NOTES_DIR || !fs.existsSync(NOTES_DIR)) return;
  let done = 0;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.name.endsWith(LEGACY_ENC_EXT)) continue;
      const dst = full.slice(0, -LEGACY_ENC_EXT.length) + ENC_EXT;
      try {
        if (fs.existsSync(dst)) continue;   // never clobber an existing .enc
        fs.renameSync(full, dst);
        done++;
      } catch (e) { console.error('[enc] note ext migrate failed:', full, e.message); }
    }
  };
  try { walk(NOTES_DIR); } catch (e) { console.error('[enc] note ext walk failed:', e.message); }
  if (done) console.log(`[enc] migrated ${done} note(s) ${LEGACY_ENC_EXT} -> ${ENC_EXT}`);
}

// One-shot / idempotent: give encrypted drawings the .enc marker. Legacy vaults
// stored draws as <stem>.draw with encrypted content; rename them to
// <stem>.draw.enc (pure rename when already encrypted; encrypt-then-rename for
// any stray plaintext .draw). Runs on unlock at rest, before any draw is read.
function migrateDrawsEnc(key) {
  if (!key || !NOTES_DIR || !fs.existsSync(NOTES_DIR)) return;
  let ren = 0, enc = 0;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!item.name.endsWith('.draw')) continue;        // bare .draw only (.draw.enc already done)
      const dst = full + ENC_EXT;
      if (fs.existsSync(dst)) {
        // A .draw.enc already exists (e.g. a prior partial migration). NEVER
        // blind-delete: drop the bare file only if it decrypts to the SAME
        // content; otherwise preserve it aside as .preenc-bak (no data loss).
        try {
          const a = decryptContent(fs.readFileSync(full, 'utf8'), key);
          const b = decryptContent(fs.readFileSync(dst, 'utf8'), key);
          if (a === b) { fs.unlinkSync(full); }
          else { fs.renameSync(full, full + '.preenc-bak'); console.warn('[enc] draw conflict kept as .preenc-bak:', full); }
        } catch (_) { try { fs.renameSync(full, full + '.preenc-bak'); } catch (_) {} }
        continue;
      }
      try {
        const raw = fs.readFileSync(full, 'utf8');
        try { decryptContent(raw, key); fs.renameSync(full, dst); ren++; }   // already encrypted → rename
        catch (_) { fs.writeFileSync(dst, encryptContent(raw, key), 'utf8'); fs.unlinkSync(full); enc++; }  // plaintext → encrypt
      } catch (e) { console.error('[enc] draw enc-mark failed:', full, e.message); }
    }
  };
  try { walk(NOTES_DIR); } catch (e) { console.error('[enc] draw walk failed:', e.message); }
  if (ren || enc) console.log(`[enc] draws: marked .enc ${ren}, encrypted ${enc}`);
}

// Passphrase verification token — a known string encrypted with the key, stored
// outside the vault. It lets us verify the passphrase EVEN when the vault is
// decrypted on disk ("plaintext while open" mode), so a wrong passphrase can
// never be accepted and then used to re-encrypt the vault with the wrong key.
function writeVerifyToken(key) {
  try { fs.writeFileSync(VERIFY_FILE, encryptContent(VERIFY_PLAINTEXT, key), { mode: 0o600 }); } catch (_) {}
}
// true = correct, false = wrong, null = no token (caller falls back to note-decrypt).
function verifyKey(key) {
  if (!fs.existsSync(VERIFY_FILE)) return null;
  try { return decryptContent(fs.readFileSync(VERIFY_FILE, 'utf8'), key) === VERIFY_PLAINTEXT; }
  catch (_) { return false; }
}

// ─── Envelope encryption ─────────────────────────────────────────────────────
// The vault's DATA key (DEK) is random and encrypts notes/attachments. It is
// stored WRAPPED by a password-derived key (KEK) in a plaintext header INSIDE
// the vault (.amelie-vault.json). The header holds nothing secret: salt, KDF
// params, cipher algo, and the AEAD-wrapped DEK. So ANY machine that has the
// vault folder + the password can derive the KEK (with the header's salt),
// unwrap the DEK and decrypt — no per-machine state, so an encrypted vault syncs
// across PCs. A wrong password fails the AEAD tag on unwrap → the wrapped key
// IS the password verifier. Changing the password only re-wraps the DEK (no
// re-encryption of notes).
function wrapDEK(dek, kek, algo) { return encryptContent(Buffer.from(dek).toString('hex'), kek, algo); }
function unwrapDEK(wrapped, kek, algo) { return Buffer.from(decryptContent(wrapped, kek, algo), 'hex'); }

function readVaultHeader() {
  try {
    if (!VAULT_HEADER_FILE || !fs.existsSync(VAULT_HEADER_FILE)) return null;
    const h = JSON.parse(fs.readFileSync(VAULT_HEADER_FILE, 'utf8'));
    return (h && h.amelie === 'vault' && h.salt && h.wrappedKey) ? h : null;
  } catch (_) { return null; }
}

// Write/refresh the vault header. `dek` = data key, `kek` = password key that
// wraps it, `salt` = the KDF salt used for `kek`. Plaintext (no secret inside).
function writeVaultHeader(dek, kek, salt) {
  if (!VAULT_HEADER_FILE) return;
  const header = {
    amelie: 'vault', version: 1,
    kdf: KDF,
    kdfParams: KDF === 'argon2id' ? ARGON2_PARAMS
             : KDF === 'scrypt'   ? SCRYPT_PARAMS
             : { iterations: 310000, hash: 'sha512' },
    salt: Buffer.from(salt).toString('hex'),
    algo: ENCRYPTION_ALGO,
    wrappedKey: wrapDEK(dek, kek, ENCRYPTION_ALGO),
  };
  // ATOMIC (tmp+fsync+rename): a crash/full-disk mid-write must NOT corrupt the
  // header — a corrupt header reads as null and unlock would fall back to the
  // LEGACY direct-key path (≠ the random DEK), making the WHOLE vault permanently
  // undecryptable. tmp+rename keeps the previous good header until the swap.
  try { atomicConvertWrite(VAULT_HEADER_FILE, null, JSON.stringify(header, null, 2)); }
  catch (e) { console.error('[enc] vault header write failed:', e.message); }
}

// Make the local config reflect an encrypted vault it may not know about yet —
// e.g. a vault synced/opened on a SECOND PC: if the folder carries an envelope
// header but the local config says "not encrypted", adopt the header's settings
// so the unlock prompt appears (and getInfo reports encryptionEnabled). The
// header is the recognition marker, like .amelie-sync / .amelie-backup.
// True if the vault holds ANY encrypted file (a note/attachment ending in .enc).
function vaultHasEncryptedFiles() {
  const walk = (dir) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    for (const it of items) {
      if (it.isDirectory()) { if (walk(path.join(dir, it.name))) return true; }
      else if (it.name.endsWith(ENC_EXT)) return true;
    }
    return false;
  };
  return [NOTES_DIR, ATTACHMENTS_DIR].filter(Boolean).some(walk);
}

function reconcileEncryptionFromHeader() {
  try {
    const h = readVaultHeader();
    if (!h) {
      // Config claims "encrypted" but the key header (.amelie-vault.json) is GONE.
      // The wrapped DEK lived in that header, so NO password can unlock anymore.
      // If there are also no encrypted files (empty/plaintext vault), self-heal by
      // turning encryption OFF — otherwise the app is stuck on an unlock screen no
      // password can satisfy. (If .enc files exist we leave it: nothing to do, and
      // we must not silently flip a genuinely-encrypted vault to plaintext.)
      const cfg = readAppConfig();
      if (cfg.encryption?.enabled && !vaultHasEncryptedFiles()) {
        cfg.encryption.enabled = false;
        cfg.encryption.openPlaintext = true;
        writeAppConfig(cfg);
      }
      return false;
    }
    const cfg = readAppConfig();
    if (cfg.encryption?.enabled) return true;
    cfg.encryption = {
      enabled: true,
      algo: h.algo === 'chacha' ? 'chacha' : 'aes',
      kdf:  normKdf(h.kdf),
      openPlaintext: cfg.encryption?.openPlaintext === true,
    };
    writeAppConfig(cfg);
    return true;
  } catch (_) { return false; }
}

// Atomic per-file converter write: write `data` to `<dest>.amelie-tmp`, fsync,
// rename onto `dest` (the rename is atomic — `dest` is never observed half-written,
// which for an encrypted blob would mean an undecryptable, i.e. LOST, file), then
// remove `src` if it differs from `dest`. A crash before the rename leaves only a
// stray *.amelie-tmp (swept by sweepConvertTmp); the source stays intact. Mirrors
// writeNoteContent's atomic path. Throws on any fs error so the caller can record
// the file as failed and CONTINUE the walk.
function atomicConvertWrite(dest, src, data) {
  const tmp = dest + '.amelie-tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  if (src && src !== dest) { try { fs.unlinkSync(src); } catch (_) {} }
}

// Sweep stray *.amelie-tmp files left by a crash mid-conversion: the rename never
// happened, so each is a partial write whose real file is still intact. Run at the
// start of every (de)cryption so the job is idempotent/resumable — just re-run.
function sweepConvertTmp(root) {
  if (!root || !fs.existsSync(root)) return;
  const walk = (dir) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue; }
      if (it.name.endsWith('.amelie-tmp')) { try { fs.unlinkSync(full); } catch (_) {} }
    }
  };
  walk(root);
}

// Encrypt the WHOLE vault on disk with `key`: notes .md→.enc (renamed), draws
// (.draw) + todos encrypted in place, attachments encrypted. Reused by
// enableEncryption and the "plaintext-while-open" re-encrypt-on-quit path.
// Crash-safe + resumable: every file is converted atomically (atomicConvertWrite),
// Sweep the shrink-safety backups (<vault>/.amelie-backups/*.bak) alongside
// notes/, so they track the vault's at-rest state in "plaintext while open" mode:
// decrypted on open, re-encrypted on quit — never a plaintext .bak once closed.
// Each .bak holds note text and is converted IN PLACE. State is detected by
// trying to decrypt: content that's already in the target state is skipped, so
// this is idempotent and crash-safe (a re-run won't double-convert). Failures on
// a single backup are swallowed — backups are a best-effort net, never blocking.
function _convertBackups(key, encrypt) {
  try {
    const dir = path.join(VAULT_DIR || path.dirname(NOTES_DIR), '.amelie-backups');
    if (!key || !fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.bak')) continue;
      const full = path.join(dir, name);
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      let plain = null;
      try { plain = decryptContent(raw, key); } catch (_) {}   // decrypts cleanly ⇒ currently encrypted
      const isEncrypted = plain !== null;
      try {
        if (encrypt && !isEncrypted) {
          const tmp = full + '.amelie-convert-tmp';
          fs.writeFileSync(tmp, encryptContent(raw, key, ENCRYPTION_ALGO), 'utf8');
          fs.renameSync(tmp, full);
        } else if (!encrypt && isEncrypted) {
          const tmp = full + '.amelie-convert-tmp';
          fs.writeFileSync(tmp, plain, 'utf8');
          fs.renameSync(tmp, full);
        }
      } catch (_) {}
    }
  } catch (_) {}
}

// a failure on one file is RECORDED and the walk CONTINUES (no more aborting the
// whole tree → no half-converted vault), and stray tmp files are swept first.
// Returns { ok, converted, failed:[{file,error}] }.
function encryptVaultToDisk(key) {
  try { migrateNoteExt(); } catch (_) {}
  sweepConvertTmp(NOTES_DIR);
  let converted = 0; const failed = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      try {
        if (item.name.endsWith('.md')) {
          atomicConvertWrite(full.replace(/\.md$/, ENC_EXT), full, encryptContent(fs.readFileSync(full, 'utf8'), key));
          converted++;
        } else if (item.name.endsWith('.draw')) {
          // Draws APPEND .enc (foo.draw → foo.draw.enc) so they carry the marker too.
          atomicConvertWrite(full + ENC_EXT, full, encryptContent(fs.readFileSync(full, 'utf8'), key));
          converted++;
        }
      } catch (e) {
        failed.push({ file: full, error: e.message });
        console.error('[enc] encrypt failed (kept original):', full, e.message);
      }
    }
  };
  try { walk(NOTES_DIR); } catch (e) { failed.push({ file: NOTES_DIR, error: e.message }); }
  try { migrateAttachmentsEncrypt(key); } catch (_) {}
  try { migrateTodos('encrypt', null, key); } catch (_) {}
  try { migrateNotesFrontmatter(key); } catch (_) {}   // ensure date frontmatter on .md notes
  try { _convertBackups(key, true); } catch (_) {}     // re-encrypt shrink-safety backups too
  writeVerifyToken(key);
  return { ok: failed.length === 0, converted, failed };
}

// Inverse: decrypt the WHOLE vault on disk with `key` (notes .enc/.amd→.md,
// draws + todos in place, attachments). Used by disableEncryption and by the
// "plaintext-while-open" decrypt-on-unlock path. Same crash-safe + resumable
// contract as encryptVaultToDisk. Returns { ok, converted, failed:[{file,error}] }.
function decryptVaultToDisk(key) {
  sweepConvertTmp(NOTES_DIR);
  let converted = 0; const failed = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      // Encrypted DRAW first (foo.draw.enc → foo.draw): it also ends with .enc,
      // so it MUST be checked before the note branch or it'd become foo.draw.md.
      if (item.name.endsWith('.draw' + ENC_EXT) || item.name.endsWith('.draw' + LEGACY_ENC_EXT)) {
        const dx = item.name.endsWith(ENC_EXT) ? ENC_EXT : LEGACY_ENC_EXT;
        try {
          atomicConvertWrite(full.slice(0, -dx.length), full, decryptContent(fs.readFileSync(full, 'utf8'), key));
          converted++;
        } catch (e) {
          failed.push({ file: full, error: e.message });
          console.error('[enc] draw decrypt failed (kept original):', full, e.message);
        }
        continue;
      }
      const encExt = item.name.endsWith(ENC_EXT) ? ENC_EXT
                   : item.name.endsWith(LEGACY_ENC_EXT) ? LEGACY_ENC_EXT : null;
      try {
        if (encExt) {
          atomicConvertWrite(full.slice(0, -encExt.length) + '.md', full, decryptContent(fs.readFileSync(full, 'utf8'), key));
          converted++;
        } else if (item.name.endsWith('.draw')) {
          // Legacy: a draw encrypted in place without the .enc marker → decrypt in
          // place. If it's already plaintext, decryptContent throws → leave as is
          // (NOT a failure — it just doesn't need converting).
          let plain;
          try { plain = decryptContent(fs.readFileSync(full, 'utf8'), key); } catch (_) { continue; }
          atomicConvertWrite(full, full, plain);
          converted++;
        }
      } catch (e) {
        failed.push({ file: full, error: e.message });
        console.error('[enc] decrypt failed (kept original):', full, e.message);
      }
    }
  };
  try { walk(NOTES_DIR); } catch (e) { failed.push({ file: NOTES_DIR, error: e.message }); }
  try { migrateAttachmentsDecrypt(key); } catch (_) {}
  try { migrateTodos('decrypt', key, null); } catch (_) {}
  try { _convertBackups(key, false); } catch (_) {}    // decrypt shrink-safety backups too
  return { ok: failed.length === 0, converted, failed };
}

// Inverse of the above: decrypt every encrypted attachment back to plaintext
// (used when encryption is disabled, or to re-key on passphrase change).
function migrateAttachmentsDecrypt(key) {
  if (!key || !ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!isEncryptedAttachment(full)) continue;
      try {
        const plain = decryptAttachmentBuffer(fs.readFileSync(full), key);
        const dest = stripEnc(full);                 // drop the .enc marker
        const tmp = dest + '.amelie-dec-tmp';
        fs.writeFileSync(tmp, plain);
        fs.renameSync(tmp, dest);
        if (dest !== full) { try { fs.unlinkSync(full); } catch (_) {} }
      } catch (e) { console.error('[enc] attachment decrypt failed:', full, e.message); }
    }
  };
  try { walk(ATTACHMENTS_DIR); } catch (e) { console.error('[enc] attachment walk failed:', e.message); }
}

// External-open of an encrypted attachment needs a plaintext copy on disk for
// the system app (okular, video player, codecs Chromium can't decode…). We
// decrypt to a private temp dir (mode 700, NOT in the vault, outside "recent
// files"), open it, and wipe the whole dir on quit. Plaintext lives on disk
// only while you're viewing it externally.
const _openTempDir = path.join(os.tmpdir(), `amelie-open-${process.pid}`);
function openAttachmentExternally(absPath) {
  // Outside the try: a symlink-escape must NOT fall through to the catch's
  // shell.openPath(absPath) fallback (which would open the escaping target).
  _assertRealInside(ATTACHMENTS_DIR, absPath);
  try {
    if (ENCRYPTION_KEY && isEncryptedAttachment(absPath)) {
      if (!fs.existsSync(_openTempDir)) fs.mkdirSync(_openTempDir, { recursive: true, mode: 0o700 });
      const plain = decryptAttachmentBuffer(fs.readFileSync(absPath), ENCRYPTION_KEY);
      // Name the temp with the LOGICAL name (strip .enc) so the system app sees
      // the real extension (.pdf, .mp4…), not the .enc marker.
      const tmp = path.join(_openTempDir, stripEnc(path.basename(absPath)));
      fs.writeFileSync(tmp, plain, { mode: 0o600 });
      return shell.openPath(tmp);
    }
    return shell.openPath(absPath);
  } catch (e) { console.error('[enc] external open failed:', e.message); return shell.openPath(absPath); }
}
function cleanupOpenTemp() {
  try { fs.rmSync(_openTempDir, { recursive: true, force: true }); } catch (_) {}
}

// ── At-rest ".enc" filename marker for NON-note files ────────────────────────
// Notes carry .enc by SWAPPING their .md (foo.md ↔ foo.enc). Attachments, draws
// and todos instead APPEND .enc (foo.pdf → foo.pdf.enc, foo.draw → foo.draw.enc)
// so every encrypted-at-rest file is visibly marked in a file manager while
// keeping its real extension for type detection. The LOGICAL name used by the
// renderer / note links / tree / media URLs NEVER carries .enc — only the
// on-disk path does. encDisk()/stripEnc() are the single mapping point.
function stripEnc(name) {
  return name.endsWith(ENC_EXT) ? name.slice(0, -ENC_EXT.length) : name;
}
// Given an already path-safe LOGICAL absolute path, return the real on-disk
// path: the .enc form when it exists, else the path unchanged (plaintext or
// not-yet-created). Used by every attachment READ/open/delete site.
function encDisk(logicalFullPath) {
  const e = logicalFullPath + ENC_EXT;
  try { if (fs.existsSync(e)) return e; } catch (_) {}
  return logicalFullPath;
}
// Is a logical attachment name already taken on disk (either the plain or the
// .enc form)? Used so uniqueness checks never collide across the two names.
function attachmentTaken(logicalFullPath) {
  try { return fs.existsSync(logicalFullPath) || fs.existsSync(logicalFullPath + ENC_EXT); }
  catch (_) { return false; }
}
// Persist attachment bytes at the LOGICAL path, encrypting at rest (the on-disk
// name then gets .enc). Removes a stale sibling in the other form. Atomic.
function writeAttachmentFile(logicalFullPath, buf) {
  _internalWriteUntil = Date.now() + 1500;   // suppress the vault watcher for our own attachment writes
  if (ENCRYPTION_KEY) {
    const dest = logicalFullPath + ENC_EXT;
    const tmp = dest + '.amelie-enc-tmp';
    fs.writeFileSync(tmp, encryptAttachmentBuffer(buf, ENCRYPTION_KEY));
    fs.renameSync(tmp, dest);
    try { if (fs.existsSync(logicalFullPath)) fs.unlinkSync(logicalFullPath); } catch (_) {}
  } else {
    fs.writeFileSync(logicalFullPath, buf);
    try { if (fs.existsSync(logicalFullPath + ENC_EXT)) fs.unlinkSync(logicalFullPath + ENC_EXT); } catch (_) {}
  }
}

function noteFilePath(relPath) {
  // Encrypted notes are renamed .md → .enc on disk (swap); drawings APPEND .enc
  // (foo.draw → foo.draw.enc). Both content-encrypted. Any other file keeps its
  // name. Only remap when the vault is unlocked at rest (ENCRYPTION_KEY set).
  if (ENCRYPTION_KEY) {
    if (relPath.endsWith('.md'))   return path.join(NOTES_DIR, relPath.replace(/\.md$/, ENC_EXT));
    if (relPath.endsWith('.draw')) return path.join(NOTES_DIR, relPath + ENC_EXT);
  }
  return path.join(NOTES_DIR, relPath);
}

// ─── Note date frontmatter (created/modified) ────────────────────────────────
// .md notes carry a hidden YAML frontmatter block at the top of the on-disk file
//   ---
//   created: 2026-06-14 20:36
//   modified: 2026-06-19 21:10
//   ---
// so the dates are visible when the file is opened with another app. Amelie
// itself NEVER shows it: readNoteContent strips it before the editor sees the
// note, writeNoteContent regenerates it (created preserved, modified bumped).
// Only .md notes get it — .draw files (JSON) and todos are left untouched.
function fmtLocalDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Strip ONLY our managed frontmatter: a leading `---` block (incl. the blank
// line after it) that contains a created:/modified: key. A note whose body just
// happens to start with a `---` horizontal rule (no such keys) is left intact.
function stripNoteFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n(\r?\n)?/);
  if (!m) return text;
  if (!/^\s*(created|modified)\s*:/m.test(m[1])) return text;
  return text.slice(m[0].length);
}
function parseNoteCreated(textWithFm) {
  const m = textWithFm.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const c = m[1].match(/^\s*created\s*:\s*(.+?)\s*$/m);
  return c ? c[1] : null;
}
// The note's own `modified`, for a save that must NOT count as an edit — resizing a
// photo or a video in the reading view rewrites `{width=N}` in the markdown, and the
// user does not consider that editing the note.
function parseNoteModified(textWithFm) {
  const m = textWithFm.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const c = m[1].match(/^\s*modified\s*:\s*(.+?)\s*$/m);
  return c ? c[1] : null;
}
function _readModifiedHead(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      return parseNoteModified(buf.toString('utf8', 0, n));
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}
function buildNoteWithFrontmatter(body, created, modified) {
  return `---\ncreated: ${created}\nmodified: ${modified}\n---\n\n${body}`;
}
// Read just the frontmatter HEAD (first bytes) of a PLAINTEXT note to recover its
// `created` date, without loading the whole file. The frontmatter block sits at the
// very start (buildNoteWithFrontmatter prepends it), so 512 bytes always covers it.
function _readCreatedHead(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      return parseNoteCreated(buf.toString('utf8', 0, n));
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// A note's "created" for the sidebar/meta: prefer the MANAGED frontmatter
// `created` (stable), because the atomic tmp+rename write gives the file a new
// inode on EVERY save — resetting the filesystem birthtime/ctime to "now", which
// made the displayed creation date jump forward each time the note was edited.
// Falls back to the fs timestamp for notes with no frontmatter yet, draws, and
// (cheaply) encrypted vaults where the head can't be plain-read.
function _noteCreatedISO(filePath, stat) {
  try {
    if (!ENCRYPTION_KEY) {
      const c = _readCreatedHead(filePath);            // "YYYY-MM-DD HH:MM" (local)
      if (c) { const d = new Date(c.replace(' ', 'T')); if (!isNaN(d.getTime())) return d.toISOString(); }
    }
  } catch (_) {}
  return (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString();
}

function readNoteContent(relPath) {
  const filePath = noteFilePath(relPath);
  _assertRealInside(NOTES_DIR, filePath);   // reject a note that symlinks outside the vault
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = ENCRYPTION_KEY ? decryptContent(raw, ENCRYPTION_KEY) : raw;
  // The note reaches the editor as the bytes on disk (frontmatter aside). Fenced
  // code used to be re-indented to a 2-space inner margin here and on save; that
  // margin is CSS now (#cm-mount .cm-codeblock), so nothing rewrites the text.
  return relPath.endsWith('.md') ? stripNoteFrontmatter(text) : text;
}

// Fenced code is NOT re-indented on read or write. It used to be normalized to a
// 2-space inner margin (fences included) so the editor's grey box hugged it —
// but those were real spaces in the file, so code pasted into a note came back
// out shifted: a heredoc terminator (`  PY`) stopped matching, embedded Python
// hit an IndentationError, a Makefile tab got spaces in front of it. The margin
// is drawn in CSS instead (#cm-mount .cm-codeblock), and what you paste is what
// the file holds. A fence indented on purpose (inside a list item) keeps its own
// indent for the same reason: the text is nobody else's to rewrite.

// SAFETY NET (v1.0.984). Last line of defence against ANY editor-side truncation:
// before a save SLASHES a note's body, stash the current on-disk version under
// <vault>/.amelie-backups/ so the good content is always recoverable. This exists
// because a CodeMirror virtualization mis-read once autosaved a ~2700-char note down
// to 2 lines and the original was gone (the OpenSSL cheatsheet). A dramatic shrink is
// occasionally legitimate (the user clears a note or deletes a big section), and a
// stray backup file is cheap — data safety wins over tidiness. Backups keep the exact
// on-disk bytes (so an encrypted vault stays encrypted at rest), live OUTSIDE notes/
// (a dotfolder → never shown in the tree, never synced), and are pruned to a cap.
function _pruneShrinkBackups(dir, keep = 200) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.bak'))
      .map(f => { try { return { f, t: fs.statSync(path.join(dir, f)).mtimeMs }; } catch (_) { return { f, t: 0 }; } })
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} }
  } catch (_) {}
}
function _backupBeforeShrink(filePath, relPath, oldBody, newBody) {
  try {
    const oldLen = String(oldBody || '').trim().length;
    const newLen = String(newBody || '').trim().length;
    // Fire on a dramatic shrink. Thresholds LOWERED (v1.0.6) so SHORT notes also
    // get a safety net — a bug/race that wipes a 60-char note was previously
    // unrecoverable (old floor was 200). Still won't fire on normal editing:
    // needs to lose >half AND at least ~40 chars of a ≥40-char note.
    if (oldLen < 40) return;                        // truly trivial note — nothing worth saving
    if (newLen >= Math.floor(oldLen * 0.5)) return; // lost less than half → normal editing
    if (oldLen - newLen < 40) return;               // absolute loss too small to bother
    const root = VAULT_DIR || path.dirname(NOTES_DIR);
    const dir = path.join(root, '.amelie-backups');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds() % 1000).padStart(3, '0')}`;
    const safe = String(relPath).replace(/[\/\\]/g, '__');
    const dest = path.join(dir, `${safe}.${stamp}.bak`);
    // Copy the EXACT on-disk bytes: in at-rest mode that's already-encrypted
    // content; in "plaintext while open" mode it's cleartext, matching the rest
    // of the vault on disk. The backups folder is swept alongside notes/ by
    // decryptVaultToDisk/encryptVaultToDisk (see _convertBackups), so it tracks
    // the vault's at-rest state and never leaves a plaintext .bak once closed.
    fs.copyFileSync(filePath, dest);               // exact on-disk bytes (keeps at-rest encryption)
    _pruneShrinkBackups(dir);
    try { console.warn(`[amelie-safety] "${relPath}" body shrank ${oldLen}->${newLen} chars — backed up to ${dest}`); } catch (_) {}
  } catch (_) {}
}

function writeNoteContent(relPath, content, keepModified) {
  _internalWriteUntil = Date.now() + 1500;   // suppress the vault watcher for our own saves
  const filePath = noteFilePath(relPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Written exactly as the editor holds it: nothing re-indents fenced code (the
  // note under readNoteContent says why).
  const body = content;
  let toWrite = body;
  if (relPath.endsWith('.md')) {
    // Preserve `created` from the existing file's frontmatter; always bump `modified`.
    let created = null;
    try {
      if (fs.existsSync(filePath)) {
        // The shrink-backup safety net only fires on a DRASTIC shrink (new body < ~50%
        // of old). A save that grows or stays ~the same size CANNOT trigger it, so we
        // avoid loading the whole old note (O(size) on every keystroke-driven autosave)
        // and read only its frontmatter head for `created`. We STILL do the full read +
        // shrink-backup whenever a shrink is possible, or when encrypted (an .enc file
        // can't be partial-read). Data-loss protection is unchanged — only faster.
        const encrypted = !!ENCRYPTION_KEY;
        let oldBytes = 0; try { oldBytes = fs.statSync(filePath).size; } catch (_) {}
        // Any shrink to <60% takes the full read + backup path (the old `>= 200`
        // floor left short notes with no safety net). A GROWING/steady note still
        // skips the full read (cheap head only) — so autosave stays fast.
        const maybeShrink = oldBytes > 0 && Buffer.byteLength(body, 'utf8') < oldBytes * 0.6;
        if (maybeShrink || encrypted) {
          const prevRaw = fs.readFileSync(filePath, 'utf8');
          const prevText = encrypted ? decryptContent(prevRaw, ENCRYPTION_KEY) : prevRaw;
          created = parseNoteCreated(prevText);
          // SAFETY NET: back up the current version if this save would slash the body.
          _backupBeforeShrink(filePath, relPath, stripNoteFrontmatter(prevText), stripNoteFrontmatter(body));
        } else {
          created = _readCreatedHead(filePath);   // cheap: only the frontmatter head
        }
      }
    } catch (_) {}
    const now = fmtLocalDate(new Date());
    // `keepModified`: carry the note's existing `modified` over instead of stamping now.
    // Used by the media-resize save, which changes the markdown without being an edit the
    // user made to the text. Falls back to now when the note has no frontmatter yet.
    let modified = now;
    if (keepModified) {
      try {
        const prev = ENCRYPTION_KEY
          ? parseNoteModified(decryptContent(fs.readFileSync(filePath, 'utf8'), ENCRYPTION_KEY))
          : _readModifiedHead(filePath);
        if (prev) modified = prev;
      } catch (_) {}
    }
    // content is the clean body (frontmatter stripped on read); strip again
    // defensively so we never nest two frontmatter blocks.
    toWrite = buildNoteWithFrontmatter(stripNoteFrontmatter(body), created || now, modified);
  }
  // Atomic write (tmp + fsync + rename): a crash or full disk mid-write must NOT
  // truncate the existing note — a half-written encrypted blob is undecryptable,
  // i.e. a lost note. The original stays intact until the atomic rename. Matches
  // the attachment/frontmatter write paths.
  const out = ENCRYPTION_KEY ? encryptContent(toWrite, ENCRYPTION_KEY) : toWrite;
  const tmp = filePath + '.amelie-tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, out, 'utf8');
    try { fs.fsyncSync(fd); } catch (_) {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// One-shot / idempotent: add the date frontmatter to every existing .md note.
// `created`/`modified` are seeded from the file's birthtime/mtime (best source
// for pre-existing notes); the original mtime is RESTORED after the rewrite so
// the in-app date column (which reads fs mtime) doesn't jump to "now". Runs on
// unlock/enable. Skips notes that already have the frontmatter. key = the at-rest
// key, or null in plaintext-while-open mode (files are .md on disk).
function migrateNotesFrontmatter(key) {
  if (!NOTES_DIR || !fs.existsSync(NOTES_DIR)) return;
  let done = 0;
  const isNote = (name) => {
    if (name.endsWith('.draw') || name.endsWith('.draw' + ENC_EXT) || name.endsWith('.draw' + LEGACY_ENC_EXT)) return false;
    return name.endsWith('.md') || name.endsWith(ENC_EXT) || name.endsWith(LEGACY_ENC_EXT);
  };
  const isEnc = (name) => name.endsWith(ENC_EXT) || name.endsWith(LEGACY_ENC_EXT);
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!isNote(item.name)) continue;
      const enc = isEnc(item.name);
      if (enc && !key) continue;   // encrypted note but no key (shouldn't happen) → skip
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const text = enc ? decryptContent(raw, key) : raw;
        if (parseNoteCreated(text) !== null) continue;   // already has frontmatter
        const st = fs.statSync(full);
        const createdD = (st.birthtime && st.birthtime.getTime() > 0) ? st.birthtime : st.mtime;
        const out = buildNoteWithFrontmatter(text, fmtLocalDate(createdD), fmtLocalDate(st.mtime));
        const tmp = full + '.amelie-fm-tmp';
        fs.writeFileSync(tmp, enc ? encryptContent(out, key) : out, 'utf8');
        fs.renameSync(tmp, full);
        try { fs.utimesSync(full, st.atime, st.mtime); } catch (_) {}   // keep the real edit date
        done++;
      } catch (e) { console.error('[fm] note frontmatter migrate failed:', full, e.message); }
    }
  };
  try { walk(NOTES_DIR); } catch (e) { console.error('[fm] note frontmatter walk failed:', e.message); }
  if (done) console.log(`[fm] added date frontmatter to ${done} note(s)`);
}

// ─── Windows ──────────────────────────────────────────────────────────────────
let mainWindow;
let vaultWindow;
let syncManager;
let wgManager = new WireGuardManager();

// Tell the sync engine to PAUSE while the vault is decrypted on disk ("plaintext
// while open" = encryption-at-rest OFF): in that state the on-disk files are
// plaintext, so syncing would leak them to the share. Pausing keeps the share
// encrypted; sync resumes once encryption-at-rest is turned back on. Live signal:
// _REENCRYPT_KEY held (can re-encrypt) AND ENCRYPTION_KEY null (not at-rest).
function refreshSyncPlaintextFlag() {
  if (syncManager) syncManager._plaintextOpen = !!(_REENCRYPT_KEY && !ENCRYPTION_KEY);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 600,
    backgroundColor: '#0d0d0f', ...WINDOW_CHROME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      // Enable Chromium's built-in PDF viewer so <embed type="application/pdf">
      // can render inkwell:// PDFs in-place.
      plugins: true,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });
  // Set icon from outside ASAR so KDE/Wayland picks it up correctly
  const { nativeImage } = require('electron');
  const iconPath = path.join(process.resourcesPath, 'icon.png');
  if (require('fs').existsSync(iconPath)) {
    mainWindow.setIcon(nativeImage.createFromPath(iconPath));
  }
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (process.env.NODE_ENV === 'development') mainWindow.webContents.openDevTools({ mode: 'detach' });
  Menu.setApplicationMenu(null);

  // Hard navigation lock: the main window must ONLY ever display its own
  // renderer page. Block EVERY top-frame navigation that leaves the app's
  // renderer directory. This stops two things: (1) a dropped .pdf/.md loading
  // as a page before the renderer's drop handler can intercept it (file://),
  // and (2) — security-critical — a note-embedded `data:`/`blob:`/`http:` link
  // navigating THIS webContents to an attacker-controlled document, which would
  // then be injected with the `window.inkwell` preload (full vault read/write +
  // openExternal exfil). Note content is untrusted (it syncs over SMB/WebDAV and
  // imports from Obsidian). Subresources (<img>/<audio>/<embed> via inkwell:// or
  // http://127.0.0.1 media) do NOT fire will-navigate, so media is unaffected;
  // real external links open in the system browser via the openExternal IPC.
  const _rendererBase = pathToFileURL(path.join(__dirname, '../renderer/')).href;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try { if (url.startsWith(_rendererBase)) return; } catch (_) {}
    e.preventDefault();
  });

  // Block any window.open / target=_blank / popup from inside an embed
  // (e.g. YouTube's "Watch on YouTube" button). The user does NOT want the
  // browser to open and definitely not a second Electron window — silently
  // dismiss the popup attempt.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const TEXT_COLORS = [
    '#e0758a','#c9a96e','#6ab0d4','#a78bda','#7ec97a','#d4916a',
    '#e05c6a','#3d9970','#9aacbe','#dde6f0','#e0a84a','#c4a7e7',
  ];
  // Build a small solid-colour BGRA bitmap → NativeImage, used as the icon
  // for each menu entry so the user sees the colour, not its hex code.
  function colorSwatchIcon(hex) {
    const size = 16;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4 + 0] = b;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = r;
      buf[i * 4 + 3] = 255;
    }
    return nativeImage.createFromBitmap(buf, { width: size, height: size });
  }
  const COLOR_NAMES = [
    'Rosa', 'Sabbia', 'Azzurro', 'Lavanda', 'Verde', 'Arancio',
    'Rosso', 'Verde scuro', 'Grigio', 'Bianco', 'Ambra', 'Viola',
  ];

  mainWindow.webContents.on('context-menu', (_, params) => {
    const items = [];
    // Text formatting (bold/italic/…) belongs ONLY to the note editor. Other
    // editable fields (settings inputs, search, IP boxes…) get just Copy/Paste.
    const inNoteEditor = !!(_ctxNoteTarget && _ctxNoteTarget.isEditor);
    if (params.isEditable && inNoteEditor) {
      if (params.selectionText) {
        items.push({ role: 'cut', label: 'Taglia' });
        items.push({ role: 'copy', label: 'Copia' });
      }
      items.push({ role: 'paste', label: 'Incolla' });
      if (params.selectionText) {
        items.push({ type: 'separator' });
        items.push({ label: 'Grassetto', click: () => mainWindow.webContents.send('editor:cmd', 'bold') });
        items.push({ label: 'Corsivo',   click: () => mainWindow.webContents.send('editor:cmd', 'italic') });
        items.push({
          label: 'Evidenzia',
          click: () => mainWindow.webContents.send('editor:cmd', 'highlight'),
        });
        items.push({
          label: 'Aggiungi colore',
          submenu: TEXT_COLORS.map((hex, i) => ({
            label: COLOR_NAMES[i] || hex,
            icon: colorSwatchIcon(hex),
            click: () => mainWindow.webContents.send('editor:cmd', `color:${hex}`),
          })),
        });
        items.push({
          label: 'Rimuovi colore',
          click: () => mainWindow.webContents.send('editor:cmd', 'color-remove'),
        });
      }
      items.push({ type: 'separator' });
      items.push({ role: 'selectAll', label: 'Seleziona tutto' });
    } else if (params.isEditable) {
      // Settings / search / other text fields: only Copy + Paste.
      if (params.selectionText) items.push({ role: 'copy', label: 'Copia' });
      items.push({ role: 'paste', label: 'Incolla' });
    } else if (params.selectionText) {
      items.push({ role: 'copy', label: 'Copia' });
    }
    // Right-click over a note pane (main or split): offer to detach THAT note
    // into its own window. The renderer set _ctxNoteTarget synchronously just
    // before this event fired (null when not over a pane).
    if (_ctxNoteTarget && _ctxNoteTarget.path) {
      const tgt = _ctxNoteTarget;
      if (items.length) items.push({ type: 'separator' });
      // Attachment (player, 📎/🎵/🎬 link — media, scripts, any file) under
      // the cursor → file actions.
      if (tgt.media && tgt.media.rel) {
        const attPath = path.resolve(ATTACHMENTS_DIR, tgt.media.rel);
        const safe = attPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep);
        items.push({
          label: 'Apri file',
          click: () => { if (safe) openAttachmentExternally(encDisk(attPath)); },
        });
        items.push({
          label: 'Apri percorso del file',
          click: () => { if (safe) shell.showItemInFolder(encDisk(attPath)); },
        });
        items.push({
          label: 'Rinomina file',
          click: () => mainWindow.webContents.send('editor:cmd', 'media:' + JSON.stringify({ action: 'rename', rel: tgt.media.rel, href: tgt.media.href })),
        });
        items.push({
          label: 'Elimina file',
          click: () => mainWindow.webContents.send('editor:cmd', 'media:' + JSON.stringify({ action: 'delete', rel: tgt.media.rel, href: tgt.media.href })),
        });
        items.push({ type: 'separator' });
      }
      if (tgt.canGoBack) {
        items.push({
          label: 'Torna alla nota precedente',
          click: () => mainWindow.webContents.send('editor:cmd', 'nav-back'),
        });
      }
      items.push({
        label: 'Apri in nuova finestra',
        click: () => openDetachedNoteWindow({ path: tgt.path, name: tgt.name, theme: tgt.theme }),
      });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });
}

// ─── Vault setup window ───────────────────────────────────────────────────────
function createVaultWindow() {
  vaultWindow = new BrowserWindow({
    width: 880, height: 600, resizable: false,
    backgroundColor: '#0a0e17', ...WINDOW_CHROME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
    },
  });
  vaultWindow.loadFile(path.join(__dirname, '../renderer/vault-setup.html'));
  Menu.setApplicationMenu(null);
}

// ─── App startup ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Attachments are served with REAL Range support (206 Partial Content):
  // audio playback issues ranged requests on play/seek, and the legacy
  // registerFileProtocol broke them (MEDIA_ERR_NETWORK mid-playback).
  // Deliberately still maps formats Amelie no longer IMPORTS (ogg, oga, mka, mpg,
  // flv): a vault that already holds one keeps serving it with the right type
  // instead of a download, so nothing that used to play stops playing.
  const MIME_BY_EXT = {
    weba: 'audio/webm', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
    m4a: 'audio/mp4', aac: 'audio/aac', mka: 'audio/x-matroska', wma: 'audio/x-ms-wma',
    mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime',
    avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', flv: 'video/x-flv',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
  };
  const { Readable } = require('stream');
  protocol.handle('inkwell', (request) => {
    try {
    const fileName = decodeURIComponent(request.url.replace('inkwell://attachments/', ''));
    const full = path.resolve(ATTACHMENTS_DIR, fileName);
    if (!full.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) {
      return new Response('forbidden', { status: 403 });
    }
    const onDisk = encDisk(full);                 // <name> or <name>.enc, whichever exists
    let stat;
    try { stat = fs.statSync(onDisk); } catch (_) { return new Response('not found', { status: 404 }); }
    try { _assertRealInside(ATTACHMENTS_DIR, onDisk); } catch (_) { return new Response('forbidden', { status: 403 }); }
    // mime from the LOGICAL name (full), never the on-disk .enc suffix.
    const type = MIME_BY_EXT[path.extname(full).slice(1).toLowerCase()] || 'application/octet-stream';
    // Whole-file buffer responses: the inkwell protocol now serves only
    // images/PDFs/small assets (media playback goes through the localhost
    // HTTP media server below — Chromium's media stack over custom protocols
    // proved unreliable with ranged requests).
    // Decrypt encrypted attachments on the fly (detected by magic header).
    let body = fs.readFileSync(onDisk);
    if (ENCRYPTION_KEY && bufIsEncryptedAttachment(body)) {
      body = decryptAttachmentBuffer(body, ENCRYPTION_KEY);
    }
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(body.length) },
    });
    } catch (e) { console.error('[inkwell-proto]', request.url, e && e.message); return new Response('err', { status: 500 }); }
  });

  // ── Localhost HTTP media server ──────────────────────────────────────────
  // Audio/video playback needs rock-solid Range support: Chromium's media
  // pipeline over custom protocols kept failing follow-up ranged requests
  // (MEDIA_ERR_NETWORK on play/seek), so media is served over plain HTTP on
  // 127.0.0.1 — the battle-tested path. Hardened: loopback bind only, secret
  // token in the URL, path-traversal guard.
  const http = require('http');
  const MEDIA_TOKEN = crypto.randomBytes(12).toString('hex');
  const mediaServer = http.createServer((req, res) => {
    try {
      let u = req.url || '';
      try { u = decodeURIComponent(u); } catch (_) {}
      const prefix = `/${MEDIA_TOKEN}/`;
      if (!u.startsWith(prefix)) { res.writeHead(403); return res.end(); }
      const rel = u.slice(prefix.length);
      const full = path.resolve(ATTACHMENTS_DIR, rel);
      if (!full.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) { res.writeHead(403); return res.end(); }
      const onDisk = encDisk(full);                 // <name> or <name>.enc, whichever exists
      let stat;
      try { stat = fs.statSync(onDisk); } catch (_) { res.writeHead(404); return res.end(); }
      try { _assertRealInside(ATTACHMENTS_DIR, onDisk); } catch (_) { res.writeHead(403); return res.end(); }
      const type = MIME_BY_EXT[path.extname(full).slice(1).toLowerCase()] || 'application/octet-stream';
      // Encrypted attachment? Serve the PLAINTEXT view: total = file size minus
      // the header, and ranges stream through the seekable CTR decryptor.
      const enc = ENCRYPTION_KEY && isEncryptedAttachment(onDisk);
      const total = enc ? attachmentPlainSize(onDisk) : stat.size;
      const mkStream = (s, e) => enc
        ? attachmentPlainStream(onDisk, s, e, ENCRYPTION_KEY)
        : fs.createReadStream(onDisk, { start: s, end: e });
      const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
      if (m && (m[1] !== '' || m[2] !== '')) {
        const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
        const end = (m[2] === '' || m[1] === '') ? total - 1 : Math.min(Number(m[2]), total - 1);
        if (start >= total || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
        });
        mkStream(start, end).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': total });
        mkStream(0, total - 1).pipe(res);
      }
    } catch (_) {
      try { res.writeHead(500); res.end(); } catch (_) {}
    }
  });
  // STARTED ON DEMAND, not at boot: the socket exists only once a note actually
  // embeds an audio/video file. A vault with no media never opens a port at all —
  // there is nothing to serve, so there is nothing to listen on. The first caller
  // waits for 'listening' (the reason this IPC is async, not sendSync); every
  // caller after it gets the cached URL. A bind failure resolves to '' and lets a
  // later attempt try again, rather than wedging playback for the whole session.
  let _mediaBase = null;      // cached base URL, once listening
  let _mediaStarting = null;  // the in-flight start, shared by concurrent callers
  const mediaBaseUrl = () => {
    if (_mediaBase) return Promise.resolve(_mediaBase);
    if (!_mediaStarting) {
      _mediaStarting = new Promise((resolve) => {
        const onErr = (err) => {
          console.error('[media-server] listen failed:', err && err.message);
          _mediaStarting = null;
          resolve('');
        };
        mediaServer.once('error', onErr);
        mediaServer.listen(0, '127.0.0.1', () => {
          mediaServer.removeListener('error', onErr);
          const addr = mediaServer.address();
          _mediaBase = addr ? `http://127.0.0.1:${addr.port}/${MEDIA_TOKEN}/` : '';
          resolve(_mediaBase);
        });
      });
    }
    return _mediaStarting;
  };
  ipcMain.handle('media:base-url', () => mediaBaseUrl());

  const appCfg = readAppConfig();

  if (!appCfg.vaultPath || !fs.existsSync(appCfg.vaultPath)) {
    // First run or vault missing — show setup wizard
    createVaultWindow();
  } else {
    // Normal startup
    resolveVaultPaths(appCfg.vaultPath);
    // A vault synced from another PC may be encrypted while this machine's config
    // doesn't know yet — adopt its header so the unlock prompt appears.
    reconcileEncryptionFromHeader();
    await startMainApp();
  }
});

async function startMainApp() {
  const { SyncManager } = require('../sync/syncManager');
  // Safety net: remove a leftover Amelie WG interface from a crash/kill that
  // skipped teardown. IMPORTANT: if the WireGuard option is enabled, keep our
  // own `amelie-wg` — syncManager.init() will (re)establish it as a clean
  // keep-alive tunnel, and tearing it down here would kill it right after.
  let vpnEnabled = false;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      vpnEnabled = !!c?.sync?.vpn?.enabled;
    }
  } catch (_) {}
  // AMELIE_TEST=1: test instance (diag harness with fake HOME) — must NEVER
  // touch the tunnel: its empty config knows nothing about the real instance's
  // tunnel and would mistake it for a leftover to remove (→ polkit prompt).
  if (process.env.AMELIE_TEST !== '1') {
    await wgManager.cleanupStaleTunnels({ keepOwn: vpnEnabled }).catch(() => {});
  }

  migrateConfigSecrets();   // encrypt any pre-existing plaintext SMB/WebDAV password at rest
  syncManager = new SyncManager(NOTES_DIR, ATTACHMENTS_DIR, CONFIG_FILE);
  syncManager.init();
  refreshSyncPlaintextFlag();
  createMainWindow();

  // Privacy: purge any vault paths the desktop recorded as "recent", and keep
  // purging them while the app runs (the taskbar menu reads the file live).
  scrubRecentDocuments();
  if (process.env.AMELIE_TEST !== '1' && !_recentScrubTimer) {
    _recentScrubTimer = setInterval(scrubRecentDocuments, 10000);
    if (_recentScrubTimer.unref) _recentScrubTimer.unref();
  }
}
let _recentScrubTimer = null;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Guaranteed teardown: when Amelie closes we unmount the share and bring down the
// WireGuard tunnel. Without this, a tunnel with broad AllowedIPs stays active and
// can "block" the whole PC's network even after the app is closed.
// before-quit doesn't await Promises, so we block the exit once
// (preventDefault), run the async teardown, then call quit() again.
let _amelieShuttingDown = false;
app.on('before-quit', (event) => {
  if (_amelieShuttingDown) return;        // second call: let it exit
  if (process.env.AMELIE_TEST === '1') return;  // test instance: never touch the tunnel
  _amelieShuttingDown = true;
  event.preventDefault();
  try { scrubRecentDocuments(); } catch (_) {}   // leave no vault trace in "recent files"
  try { cleanupOpenTemp(); } catch (_) {}        // wipe any decrypted attachments opened externally
  // "Plaintext while open" mode: re-encrypt the WHOLE vault on disk before exit
  // (synchronous so it completes before quit). On a crash this won't run — the
  // vault then stays decrypted until the next launch re-encrypts on quit.
  if (_REENCRYPT_KEY && !_reencryptDone) {
    try {
      const r = encryptVaultToDisk(_REENCRYPT_KEY); _reencryptDone = true;
      if (r && !r.ok) console.error('[enc] re-encrypt on quit: ' + r.failed.length + ' file(s) failed, kept plaintext:', r.failed.map(f => f.file).join(', '));
    } catch (e) { console.error('[enc] re-encrypt on quit failed:', e.message); }
  }
  (async () => {
    try { await wgManager.shutdown(); } catch(_) {}
    app.quit();
  })();
});


ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.on('window:startMove', () => { try { if (mainWindow && !mainWindow.isMaximized()) mainWindow.startMoving(); } catch(_) {} });

// ─── IPC: Vault Setup ────────────────────────────────────────────────────────

ipcMain.handle('vault:setup', async (_, opts) => {
  const { vaultPath: rawVaultPath, encryptionEnabled, passphrase } = opts;
  // Expand ~ and $HOME to the user's home directory.
  const vaultPath = rawVaultPath
    .replace(/^~(?=$|[/\\])/, os.homedir())
    .replace(/^\$HOME(?=$|[/\\])/, os.homedir());

  // Validate path
  try {
    if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
    // Test write
    const testFile = path.join(vaultPath, '.amelie-test');
    fs.writeFileSync(testFile, 'ok'); fs.unlinkSync(testFile);
  } catch (e) {
    return { ok: false, error: `Impossibile accedere a "${vaultPath}": ${e.message}` };
  }

  resolveVaultPaths(vaultPath);

  // Inspect the target BEFORE committing config or keys: an existing vault must
  // never be re-keyed or have its KDF rewritten — that would orphan its notes.
  const existingHeader = readVaultHeader();
  // Encrypted notes but no header = a legacy (pre-envelope) direct-key vault.
  const hasEnc = (function any(dir){ try { for (const it of fs.readdirSync(dir,{withFileTypes:true})) { if (it.isDirectory()) { if (any(path.join(dir,it.name))) return true; } else if (it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT)) return true; } } catch(_){} return false; })(NOTES_DIR);

  // Only a genuinely FRESH encrypted vault gets the modern Argon2id envelope.
  // For a legacy vault we must NOT force argon2id: deriveKey() reads the global
  // KDF, so forcing it here derived the WRONG key even for the CORRECT passphrase
  // (and writing kdf:argon2id to config would keep unlock deriving wrong keys,
  // permanently locking the vault). Leave KDF at its legacy default (pbkdf2).
  const freshEncrypted = encryptionEnabled && !existingHeader && !hasEnc;
  if (freshEncrypted) KDF = 'argon2id';
  const cfgKdf = existingHeader ? normKdf(existingHeader.kdf)
               : (encryptionEnabled && hasEnc) ? undefined   // legacy → unlock derives with the default (pbkdf2)
               : KDF;
  const encCfg = encryptionEnabled ? { enabled: true, algo: 'aes' } : { enabled: false };
  if (encCfg.enabled && cfgKdf) encCfg.kdf = cfgKdf;
  writeAppConfig({ vaultPath, encryption: encCfg });

  if (existingHeader) {
    // Picking an EXISTING encrypted vault (e.g. one synced from another PC):
    // never touch its keys — just make config know it's encrypted so the unlock
    // prompt appears. The user enters the password to open it.
    reconcileEncryptionFromHeader();
  } else if (encryptionEnabled && passphrase) {
    if (hasEnc) {
      // Legacy encrypted vault: VERIFY the passphrase against a real note before
      // adopting the key. A wrong (or wrongly-derived) key must never be adopted —
      // it would orphan the notes and corrupt them on the next save. If it checks
      // out we adopt it (app opens unlocked); otherwise leave the vault locked so
      // the main window's unlock prompt can retry + migrate to the envelope.
      try {
        const key = await deriveKey(passphrase);
        const testNotes = [];
        (function findFirst(dir){ for (const it of fs.readdirSync(dir,{withFileTypes:true})){ if (testNotes.length) return; if (it.isDirectory()){ findFirst(path.join(dir,it.name)); continue; } if (it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT)) testNotes.push(path.join(dir,it.name)); } })(NOTES_DIR);
        if (testNotes.length) decryptContent(fs.readFileSync(testNotes[0], 'utf8'), key);  // throws on a wrong key
        ENCRYPTION_KEY = key;
      } catch (_) {
        ENCRYPTION_KEY = null;   // stays locked → unlock prompt verifies + migrates
      }
    } else {
      // Fresh encrypted vault → ENVELOPE: random DEK wrapped by the password key.
      ENCRYPTION_ALGO = 'aes';
      const salt = getOrCreateSalt();
      const kek = await deriveKey(passphrase, KDF, salt);
      const dek = crypto.randomBytes(32);
      writeVaultHeader(dek, kek, salt);
      ENCRYPTION_KEY = dek;
    }
  }

  // First-run starter note: on a BRAND-NEW (empty) vault, drop a friendly note
  // so the user doesn't land in a blank app. Skipped if the vault already holds
  // any note (picking an existing/synced vault). writeNoteContent handles both
  // encryption and the managed frontmatter.
  try {
    const hasNote = (function any(dir){ try { for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      if (it.isDirectory()) { if (any(path.join(dir, it.name))) return true; }
      else if (it.name.endsWith('.md') || it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT)) return true;
    } } catch (_) {} return false; })(NOTES_DIR);
    if (!hasNote) {
      const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      writeNoteContent('Welcome.md', `# ${date}\n\nStart writing your thoughts…\n`);
    }
  } catch (_) { /* starter note is optional */ }

  // Open the MAIN window first, THEN close the wizard: closing the last
  // window fires window-all-closed → app.quit(), killing the app before the
  // main window ever appeared (first-run "Open Amelie" did nothing).
  await startMainApp();
  if (vaultWindow) { vaultWindow.close(); vaultWindow = null; }
  return { ok: true };
});

// Change the active vault at runtime (preserves the encryption settings).
// Updates the config, re-resolves the paths, re-initializes sync and reloads the
// renderer so it re-reads the note tree from the new vault.
ipcMain.handle('vault:changePath', async (_, rawPath) => {
  if (!rawPath) return { ok: false, error: 'Percorso vuoto' };
  const vaultPath = rawPath.replace(/^~(?=$|[/\\])/, os.homedir());
  try {
    if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
    const testFile = path.join(vaultPath, '.amelie-test');
    fs.writeFileSync(testFile, 'ok'); fs.unlinkSync(testFile);
  } catch (e) {
    return { ok: false, error: `Impossibile accedere a "${vaultPath}": ${e.message}` };
  }
  const appCfg = readAppConfig();
  appCfg.vaultPath = vaultPath;          // preserva appCfg.encryption
  writeAppConfig(appCfg);
  resolveVaultPaths(vaultPath);
  // Switching to a vault that's encrypted (its own header) but whose encryption
  // this machine's config doesn't yet know about → adopt it (prompts on reload).
  reconcileEncryptionFromHeader();
  try {
    const { SyncManager } = require('../sync/syncManager');
    syncManager = new SyncManager(NOTES_DIR, ATTACHMENTS_DIR, CONFIG_FILE);
    syncManager.init();
  refreshSyncPlaintextFlag();
  } catch (_) {}
  if (mainWindow) mainWindow.webContents.reload();
  return { ok: true, vaultPath };
});

// Restore the vault from a .tar.gz backup produced by Amelie (the archive holds
// `notes/`, `attachments/` and optionally the envelope header `.amelie-vault.json`).
// SAFE: the current notes/ and attachments/ are MOVED ASIDE to *.bak-restore-<ts>
// (never deleted), then the archive's versions take their place. Mirrors
// changePath's reload path so the UI refreshes with the restored vault.
// Shared restore finalizer. `srcDir` holds notes/ (+ optional attachments/ and
// .amelie-vault.json). Validates the decrypt password FIRST if the backup is
// encrypted (returns needsPassword/wrongPass without touching the vault), then
// swaps the current vault for the restored content. `move:true` renames from a
// temp staging dir; `move:false` COPIES (a folder backup must survive). The
// current notes/attachments are moved aside (never deleted). Returns the same
// shapes vault:restoreArchive always returned.
async function _finalizeRestore(srcDir, passphrase, { move = false, cleanup = null, restoredFrom = '' } = {}) {
  const clean = () => { if (cleanup) { try { fs.rmSync(cleanup, { recursive: true, force: true }); } catch (_) {} } };
  if (!NOTES_DIR) { clean(); return { ok: false, error: 'Nessun vault aperto' }; }
  const vaultDir = path.dirname(NOTES_DIR);
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const srcNotes = path.join(srcDir, 'notes');
  if (!fs.existsSync(srcNotes) || !fs.statSync(srcNotes).isDirectory()) {
    clean();
    return { ok: false, error: 'Backup non valido: manca la cartella "notes". Seleziona un backup creato da Amelie.' };
  }
  // Encrypted backup? Validate the DECRYPT PASSWORD before touching the vault.
  const srcHeader = path.join(srcDir, '.amelie-vault.json');
  let restoredDEK = null, restoredHdr = null;
  if (fs.existsSync(srcHeader)) {
    try { restoredHdr = JSON.parse(fs.readFileSync(srcHeader, 'utf8')); } catch (_) {}
    if (restoredHdr && restoredHdr.wrappedKey && restoredHdr.salt) {
      if (!passphrase) { clean(); return { ok: false, needsPassword: true }; }
      try {
        const algo = restoredHdr.algo === 'chacha' ? 'chacha' : 'aes';
        const kdf  = normKdf(restoredHdr.kdf);
        const kek  = await deriveKey(passphrase, kdf, Buffer.from(restoredHdr.salt, 'hex'));
        restoredDEK = unwrapDEK(restoredHdr.wrappedKey, kek, algo);   // throws on a wrong password
      } catch (_) { clean(); return { ok: false, needsPassword: true, wrongPass: true }; }
    }
  }
  try {
    const put = (src, dest) => { if (move) fs.renameSync(src, dest); else fs.cpSync(src, dest, { recursive: true }); };
    const kept = [];
    // notes/ — current aside, restored in place.
    if (fs.existsSync(NOTES_DIR)) { const b = path.join(vaultDir, `notes.bak-restore-${stamp}`); fs.renameSync(NOTES_DIR, b); kept.push(path.basename(b)); }
    put(srcNotes, NOTES_DIR);
    // attachments/ — only if the backup carried it.
    const srcAtt = path.join(srcDir, 'attachments');
    if (fs.existsSync(srcAtt)) {
      if (fs.existsSync(ATTACHMENTS_DIR)) { const b = path.join(vaultDir, `attachments.bak-restore-${stamp}`); fs.renameSync(ATTACHMENTS_DIR, b); kept.push(path.basename(b)); }
      put(srcAtt, ATTACHMENTS_DIR);
    }
    // Envelope header (.amelie-vault.json).
    if (fs.existsSync(srcHeader)) {
      const destHeader = path.join(vaultDir, '.amelie-vault.json');
      try { if (fs.existsSync(destHeader)) fs.copyFileSync(destHeader, path.join(vaultDir, `.amelie-vault.bak-restore-${stamp}.json`)); } catch (_) {}
      if (move) fs.renameSync(srcHeader, destHeader); else fs.copyFileSync(srcHeader, destHeader);
    }
    clean();
    reconcileEncryptionFromHeader();
    // Encrypted backup whose password we validated → set the DEK so the reloaded
    // app is UNLOCKED. Forget the previous vault's remembered passkey.
    if (restoredDEK) {
      ENCRYPTION_KEY  = restoredDEK;
      ENCRYPTION_ALGO = restoredHdr.algo === 'chacha' ? 'chacha' : 'aes';
      KDF             = normKdf(restoredHdr.kdf);
      try { if (fs.existsSync(PASSKEY_FILE)) fs.unlinkSync(PASSKEY_FILE); } catch (_) {}
    }
    try {
      const { SyncManager } = require('../sync/syncManager');
      syncManager = new SyncManager(NOTES_DIR, ATTACHMENTS_DIR, CONFIG_FILE);
      syncManager.init();
      refreshSyncPlaintextFlag();
    } catch (_) {}
    if (mainWindow) mainWindow.webContents.reload();
    return { ok: true, restoredFrom, kept };
  } catch (e) { clean(); return { ok: false, error: e.message }; }
}

ipcMain.handle('vault:restoreArchive', async (_, rawFile, passphrase) => {
  const file = (rawFile || '').replace(/^~(?=$|[/\\])/, os.homedir());
  if (!file) return { ok: false, error: 'Nessun file selezionato' };
  if (!fs.existsSync(file)) return { ok: false, error: 'File non trovato' };
  if (!/\.(tar\.gz|tgz|gz)$/i.test(file)) return { ok: false, error: 'Il file deve essere un archivio .tar.gz' };
  if (!NOTES_DIR) return { ok: false, error: 'Nessun vault aperto' };
  const vaultDir = path.dirname(NOTES_DIR);
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const staging = path.join(vaultDir, `.amelie-restore-${stamp}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    await require('tar').x({ file, cwd: staging });
    return await _finalizeRestore(staging, passphrase, { move: true, cleanup: staging, restoredFrom: path.basename(file) });
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: e.message };
  }
});

// Restore from a FOLDER backup (a dated snapshot with notes/ + attachments/ +
// optional .amelie-vault.json) — copies it in (the folder is kept). Encrypted
// folders ask for the decrypt password just like a .tar.gz.
ipcMain.handle('vault:restoreFolder', async (_, rawDir, passphrase) => {
  const dir = (rawDir || '').replace(/^~(?=$|[/\\])/, os.homedir());
  if (!dir) return { ok: false, error: 'Nessuna cartella selezionata' };
  try { if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: 'Cartella non trovata' }; }
  catch (e) { return { ok: false, error: e.message }; }
  // Allow picking either the snapshot root (has notes/) or a wrapper that contains
  // a single vault folder — but keep it simple: require notes/ directly inside.
  return await _finalizeRestore(dir, passphrase, { move: false, restoredFrom: path.basename(dir) });
});

// ONE picker for the single "Restore" button: pick a .tar.gz FILE *or* a backup
// FOLDER. Reports which one so the renderer routes to the right restore. (On
// Linux a dialog can't offer both file + dir at once, so if the picked path is a
// directory we treat it as a folder backup, else as a .tar.gz.)
ipcMain.handle('vault:pickRestore', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Seleziona un backup: file .tar.gz o cartella',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'Backup Amelie', extensions: ['tar.gz', 'tgz', 'gz'] }, { name: 'Tutti i file', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths?.length) return { canceled: true };
  const pth = result.filePaths[0];
  let isDir = false;
  try { isDir = fs.statSync(pth).isDirectory(); } catch (_) {}
  return { canceled: false, path: pth, isDir };
});

// Import an external folder into the current vault, keeping its structure:
//  • .md/.markdown/.txt  → notes in NOTES_DIR (folder structure preserved,
//    encrypted if the vault has encryption enabled)
//  • images and .pdf     → attachments folder (ATTACHMENTS_DIR)
ipcMain.handle('vault:importFolder', async (_, rawSrc) => {
  if (!rawSrc) return { ok: false, error: 'Nessuna cartella selezionata' };
  const src = rawSrc.replace(/^~(?=$|[/\\])/, os.homedir());
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory())
      return { ok: false, error: 'Cartella non valida' };
  } catch (e) { return { ok: false, error: e.message }; }

  const NOTE_EXT = new Set(['.md', '.markdown', '.txt']);
  const ATT_EXT  = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.pdf']);
  let notes = 0, attachments = 0, skipped = 0;
  const errors = [];

  const uniqueAttachmentName = (name) => {
    const ext = path.extname(name) || '';
    const base = path.basename(name, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').slice(0, 60) || 'file';
    let finalName = base + ext, c = 1;
    while (attachmentTaken(path.join(ATTACHMENTS_DIR, finalName))) finalName = `${base}-${c++}${ext}`;
    return finalName;
  };

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { errors.push(`${rel || '.'}: ${e.message}`); return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;          // skip hidden files/folders (.git etc.)
      const full = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(full, relPath); continue; }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (NOTE_EXT.has(ext)) {
        const noteRel = relPath.replace(/\.(markdown|txt)$/i, '.md');
        if (fs.existsSync(noteFilePath(noteRel))) { skipped++; continue; }
        try { writeNoteContent(noteRel, fs.readFileSync(full, 'utf8')); notes++; }
        catch (e) { errors.push(`${relPath}: ${e.message}`); }
      } else if (ATT_EXT.has(ext)) {
        // Encrypt at rest (name gets .enc) when the vault is unlocked, matching
        // how pasted attachments are stored; plaintext otherwise.
        try { writeAttachmentFile(path.join(ATTACHMENTS_DIR, uniqueAttachmentName(ent.name)), fs.readFileSync(full)); attachments++; }
        catch (e) { errors.push(`${relPath}: ${e.message}`); }
      } else { skipped++; }
    }
  };
  walk(src, '');
  if (syncManager) syncManager.scheduleSync();
  return { ok: true, notes, attachments, skipped, errors: errors.slice(0, 5) };
});

// Return which of the given paths are directories (used by the drag-drop handler to
// detect a dropped FOLDER reliably — webkitGetAsEntry is flaky for dirs on Linux).
ipcMain.handle('vault:filterDirs', async (_, paths) => {
  const out = [];
  for (const p of (Array.isArray(paths) ? paths : [])) {
    try { if (p && fs.statSync(p).isDirectory()) out.push(p); } catch (_) {}
  }
  return out;
});

// Import an OBSIDIAN vault folder (read from disk in main — reliable + fast). Copies
// notes (structure preserved) + attachments (images→attachments/, pdf→attachments/pdf/,
// audio/video→attachments/media/), all encrypted at rest via the normal write paths,
// and rewrites Obsidian embeds ![[file]] into Amelie's format (images inline, other
// types as 📎/🎵/🎬 links). `destFolder` ('' = root) nests the import under a tree folder.
ipcMain.handle('vault:importObsidian', async (_, rawSrc, destFolder) => {
  if (!rawSrc) return { ok: false, error: 'Nessuna cartella' };
  const src = rawSrc.replace(/^~(?=$|[/\\])/, os.homedir());
  try { if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return { ok: false, notDir: true }; }
  catch (e) { return { ok: false, error: e.message }; }
  const dest = (destFolder || '').replace(/^\/+|\/+$/g, '');

  const SKIP_DIRS  = new Set(['.obsidian', '.trash', '.stversions', '.stfolder', '.git']);
  const NOTE_EXT   = new Set(['.md', '.markdown', '.txt']);
  const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
  const AV_EXT_RE  = /\.(mp4|mov|webm|mp3|wav|m4a)$/i;
  const ATT_ANY_RE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|mp4|mov|webm|mp3|wav|m4a)$/i;

  const noteFiles = [], attFiles = [];
  const walk = (dir, rel) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of ents) {
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) { walk(full, r); continue; }
      if (!ent.isFile()) continue;
      if (ATT_ANY_RE.test(ent.name)) attFiles.push({ full, r });
      else if (NOTE_EXT.has(path.extname(ent.name).toLowerCase())) noteFiles.push({ full, r });
    }
  };
  walk(src, '');

  // Phase A: copy attachments, build original-name → stored-name maps.
  const byBase = new Map(), byRel = new Map();
  let images = 0, pdfs = 0, media = 0;
  for (const a of attFiles) {
    try {
      const sub = /\.pdf$/i.test(a.r) ? 'pdf/'
                : /\.(mp4|mov|webm)$/i.test(a.r) ? 'videos/'
                : /\.(mp3|wav|m4a)$/i.test(a.r) ? 'audio/'
                : '';
      const leaf = await saveAttachmentBuffer(sub + path.basename(a.r), fs.readFileSync(a.full));
      byBase.set(path.basename(a.r).toLowerCase(), leaf);
      byRel.set(a.r.toLowerCase(), leaf);
      if (/\.pdf$/i.test(leaf)) pdfs++; else if (AV_EXT_RE.test(leaf)) media++; else images++;
    } catch (_) {}
  }
  const lookup = (t) => { t = t.replace(/^\.\//, ''); return byRel.get(t.toLowerCase()) || byBase.get(path.basename(t).toLowerCase()) || null; };
  const attUrl = (leaf) => 'attachments/' + leaf.split('/').map(encodeURIComponent).join('/');
  const attMarkup = (leaf, label, alias) => {
    if (IMG_EXT_RE.test(leaf)) { const w = /^\d+$/.test(alias) ? `{width=${alias}}` : ''; return `![📷](${attUrl(leaf)})${w}`; }   // 📷 marker (filename already in the URL; icon makes the image locatable in edit view)
    const isAudio = /\.(mp3|wav|m4a)$/i.test(leaf), isVideo = /\.(mp4|mov|webm)$/i.test(leaf);
    const icon = isAudio ? '🎵' : isVideo ? '🎬' : '📎';
    // a/v use the embed form ![…] (uniform with images; the preview turns them into
    // players). Non-media (pdf/…) stays a plain link — ![](non-image) would be broken.
    return (isAudio || isVideo) ? `![${icon}](${attUrl(leaf)})` : `[${icon}](${attUrl(leaf)})`;
  };
  const rewrite = (md) => {
    md = md.replace(/!\[\[([^\]]+)\]\]/g, (m, inner) => {
      const parts = inner.split('|'); const target = parts[0].split('#')[0].trim(); const alias = parts[1] ? parts[1].trim() : '';
      if (ATT_ANY_RE.test(target)) { const leaf = lookup(target); return leaf ? attMarkup(leaf, path.basename(target), alias) : m; }
      return `[[${inner}]]`;
    });
    md = md.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, alt, url, title) => {
      if (/^(https?:|data:|inkwell:|attachments\/)/i.test(url)) return m;
      let dec; try { dec = decodeURIComponent(url); } catch (_) { dec = url; }
      const leaf = lookup(dec); if (!leaf) return m;
      return IMG_EXT_RE.test(leaf) ? `![${alt}](${attUrl(leaf)}${title || ''})` : attMarkup(leaf, path.basename(dec), '');
    });
    return md;
  };

  // Phase B: rewrite + write notes (encrypted via writeNoteContent), skipping existing.
  // Nest everything under a container folder named after the dropped folder, so the
  // import appears as ONE folder with its subfolders inside (preserving the Obsidian
  // hierarchy) rather than scattering the top-level subfolders at the vault root.
  const rootName = path.basename(src.replace(/[\\/]+$/, '')) || 'import';
  let notes = 0, skipped = 0;
  for (const n of noteFiles) {
    try {
      const noteRel = [dest, rootName, n.r.replace(/\.(markdown|txt)$/i, '.md')].filter(Boolean).join('/');
      if (fs.existsSync(noteFilePath(noteRel))) { skipped++; continue; }
      writeNoteContent(noteRel, rewrite(fs.readFileSync(n.full, 'utf8')));
      notes++;
    } catch (_) {}
  }
  if (syncManager) syncManager.scheduleSync();
  return { ok: true, notes, images, pdfs, media, skipped };
});

// ─── ToDo (.md files in the vault: todo/{today,upcoming,done}) ─────────────────
const TODO_BUCKETS = ['today', 'tomorrow', 'upcoming', 'done'];
function todoRoot() { return path.join(path.dirname(NOTES_DIR), 'todo'); }
function ensureTodoDirs() {
  TODO_BUCKETS.forEach(b => { const d = path.join(todoRoot(), b); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

function buildTodoContent(text, due, alert, completed, created) {
  const fm = [];
  if (created) fm.push('created: ' + created);   // when the task was created (human-readable)
  if (due) fm.push('due: ' + due);
  if (alert !== '' && alert != null) fm.push('alert: ' + alert);
  if (completed) fm.push('completed: ' + completed);
  const head = fm.length ? '---\n' + fm.join('\n') + '\n---\n' : '';
  return head + (text || '');
}
function parseTodoFile(raw, fallbackName) {
  let due = '', alert = '', completed = '', created = '', text = raw || '';
  const m = (raw || '').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    for (const l of m[1].split('\n')) {
      const dm = l.match(/^due:\s*(.*)$/);        if (dm) due = dm[1].trim();
      const am = l.match(/^alert:\s*(.*)$/);       if (am) alert = am[1].trim();
      const cm = l.match(/^completed:\s*(.*)$/);   if (cm) completed = cm[1].trim();
      const crm = l.match(/^created:\s*(.*)$/);    if (crm) created = crm[1].trim();
    }
    text = m[2];
  }
  const title = (text.split('\n')[0] || fallbackName).replace(/^#\s*/, '').trim();
  return { due, alert, completed, created, text, title };
}

// To-do files are markdown like notes, but live under <vault>/todo/<bucket>/ and
// keep their .md name even when encrypted (content cifrato in place). Read/write
// through these so todos honour ENCRYPTION_KEY exactly like notes.
function readTodoRaw(full) {
  const raw = fs.readFileSync(full, 'utf8');
  if (ENCRYPTION_KEY) { try { return decryptContent(raw, ENCRYPTION_KEY); } catch (_) { return raw; } }
  return raw;
}
function writeTodoRaw(full, content) {
  fs.writeFileSync(full, ENCRYPTION_KEY ? encryptContent(content, ENCRYPTION_KEY) : content, 'utf8');
}
// Bulk migrate todo files. Encrypted todos carry the .enc marker on disk
// (123-x.md → 123-x.md.enc). mode:
//   'encrypt' — ensure encrypted + .enc name (idempotent: skips/renames files
//               whose content is already encrypted; runs on enable AND unlock).
//   'decrypt' — back to plaintext .md (drops .enc).
//   'rekey'   — re-encrypt with newKey, name unchanged.
function migrateTodos(mode, oldKey, newKey) {
  const root = todoRoot();
  if (!root || !fs.existsSync(root)) return;
  let ren = 0, enc = 0;
  for (const b of TODO_BUCKETS) {
    const d = path.join(root, b);
    let files = [];
    try { files = fs.readdirSync(d).filter(f => stripEnc(f).endsWith('.md')); } catch (_) { continue; }
    for (const f of files) {
      const full = path.join(d, f);
      const hasEncName = f.endsWith(ENC_EXT);
      try {
        const raw = fs.readFileSync(full, 'utf8');
        if (mode === 'encrypt') {
          const dst = hasEncName ? full : full + ENC_EXT;
          if (dst !== full && fs.existsSync(dst)) {
            // .md.enc already there (prior partial migration). Never blind-delete:
            // drop the bare .md only if it decrypts equal; else keep as .preenc-bak.
            try {
              if (decryptContent(raw, newKey) === decryptContent(fs.readFileSync(dst, 'utf8'), newKey)) fs.unlinkSync(full);
              else fs.renameSync(full, full + '.preenc-bak');
            } catch (_) { try { fs.renameSync(full, full + '.preenc-bak'); } catch (_) {} }
            continue;
          }
          let cipher;
          try { decryptContent(raw, newKey); cipher = raw; }   // already encrypted → keep bytes
          catch (_) { cipher = encryptContent(raw, newKey); enc++; }
          atomicConvertWrite(dst, hasEncName ? null : full, cipher);
          if (!hasEncName) ren++;
        } else if (mode === 'decrypt') {
          const plain = decryptContent(raw, oldKey);
          const dst = hasEncName ? stripEnc(full) : full;
          atomicConvertWrite(dst, dst !== full ? full : null, plain);
        } else if (mode === 'rekey') {
          atomicConvertWrite(full, null, encryptContent(decryptContent(raw, oldKey), newKey));
        }
      } catch (e) { console.error('[enc] todo migrate failed:', full, e.message); }
    }
  }
  if ((ren || enc) && mode === 'encrypt') console.log(`[enc] todos: marked .enc ${ren}, encrypted ${enc}`);
}

ipcMain.handle('todo:list', async () => {
  ensureTodoDirs();
  const out = {};
  for (const b of TODO_BUCKETS) {
    const d = path.join(todoRoot(), b);
    let files = [];
    try { files = fs.readdirSync(d).filter(f => stripEnc(f).endsWith('.md')); } catch (_) {}
    out[b] = files.map(f => {
      const full = path.join(d, f);
      let raw = ''; let mtime = 0;
      try { raw = readTodoRaw(full); mtime = fs.statSync(full).mtimeMs; } catch (_) {}
      const p = parseTodoFile(raw, stripEnc(f).replace(/\.md$/, ''));
      // created: prefer the in-file `created:` date; else the legacy filename
      // timestamp prefix (old todos); else the file mtime.
      const cm = f.match(/^(\d{10,})-/);
      const fromContent = p.created ? Date.parse(p.created.replace(' ', 'T')) : NaN;
      const created = !isNaN(fromContent) ? fromContent : (cm ? parseInt(cm[1], 10) : mtime);
      return { file: f, bucket: b, text: p.text, title: p.title, due: p.due, alert: p.alert, completed: p.completed, created, mtime };
    }).sort((a, b) => b.mtime - a.mtime);
  }
  return out;
});

ipcMain.handle('todo:create', async (_, bucket, text, due, alert) => {
  ensureTodoDirs();
  if (!TODO_BUCKETS.includes(bucket)) bucket = 'today';
  const body = (text || '').trim();
  const slug = (body.split('\n')[0] || 'task').replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '-').slice(0, 40) || 'task';
  // Clean, human-friendly filename (no timestamp prefix). Add a numeric suffix
  // only if a same-named task already exists, to avoid clobbering.
  const bdir = path.join(todoRoot(), bucket);
  let file = `${slug}.md`, n = 1;
  while (fs.existsSync(path.join(bdir, file)) || fs.existsSync(path.join(bdir, file + ENC_EXT))) {
    n++; file = `${slug}-${n}.md`;
  }
  const created = fmtLocalDate(new Date());   // creation date, stored in the file
  const diskFile = ENCRYPTION_KEY ? file + ENC_EXT : file;   // encrypted todos carry the .enc marker
  try { writeTodoRaw(path.join(todoRoot(), bucket, diskFile), buildTodoContent(body, due, alert, '', created)); }
  catch (e) { return { ok: false, error: e.message }; }
  if (syncManager) syncManager.scheduleSync();
  return { ok: true, file, bucket };
});

ipcMain.handle('todo:update', async (_, bucket, file, text, due, alert) => {
  try {
    const full = path.join(todoRoot(), bucket, file);
    let completed = '', created = '';
    try { const prev = parseTodoFile(readTodoRaw(full), ''); completed = prev.completed; created = prev.created; } catch (_) {}
    writeTodoRaw(full, buildTodoContent((text || '').trim(), due, alert, completed, created));
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

ipcMain.handle('todo:move', async (_, file, from, to) => {
  if (!TODO_BUCKETS.includes(from) || !TODO_BUCKETS.includes(to)) return { ok: false };
  ensureTodoDirs();
  try {
    const src = path.join(todoRoot(), from, file);
    const dst = path.join(todoRoot(), to, file);
    const p = parseTodoFile(readTodoRaw(src), stripEnc(file).replace(/\.md$/, ''));
    let completed = p.completed;
    if (to === 'done' && !completed) completed = new Date().toISOString();
    if (to !== 'done') completed = '';
    writeTodoRaw(dst, buildTodoContent(p.text.trim(), p.due, p.alert, completed, p.created));
    if (dst !== src) fs.unlinkSync(src);
  } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

ipcMain.handle('todo:delete', async (_, bucket, file) => {
  try { fs.unlinkSync(path.join(todoRoot(), bucket, file)); }
  catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
});

ipcMain.handle('vault:browseFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Scegli la cartella vault',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Generic folder picker (e.g. local backup folder for Sync)
ipcMain.handle('dialog:pickFolder', async (_, title) => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    properties: ['openDirectory', 'createDirectory'],
    title: title || 'Scegli una cartella',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('vault:changePassphrase', async (_, oldPass, newPass) => {
  // Works whether unlocked at-rest (ENCRYPTION_KEY) or plaintext-while-open (_REENCRYPT_KEY).
  const dek = ENCRYPTION_KEY || _REENCRYPT_KEY;
  if (!dek) return { ok: false, error: 'Encryption non attiva', code: 'ENC_INACTIVE' };
  const header = readVaultHeader();
  if (header) {
    // ENVELOPE: changing the password only RE-WRAPS the data key — the DEK and
    // every encrypted note/attachment stay byte-for-byte the same (instant).
    try {
      const oldKek = await deriveKey(oldPass, normKdf(header.kdf), Buffer.from(header.salt, 'hex'));
      if (!unwrapDEK(header.wrappedKey, oldKek, header.algo).equals(dek)) return { ok: false, error: 'Passphrase corrente errata', code: 'WRONG_CURRENT_PASS' };
    } catch (_) { return { ok: false, error: 'Passphrase corrente errata', code: 'WRONG_CURRENT_PASS' }; }
    // Re-wrap with the new password (keep the same salt + algo).
    const salt = Buffer.from(header.salt, 'hex');
    const newKek = await deriveKey(newPass, KDF, salt);
    writeVaultHeader(dek, newKek, salt);
  } else {
    // LEGACY vault without a header (shouldn't normally happen post-unlock since
    // unlock migrates) → re-encrypt everything with the new key, the old way.
    const oldKey = await deriveKey(oldPass);
    try {
      const testNotes = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith(ENC_EXT));
      if (testNotes.length > 0) decryptContent(fs.readFileSync(path.join(NOTES_DIR, testNotes[0]), 'utf8'), oldKey);
    } catch(_) { return { ok: false, error: 'Passphrase corrente errata', code: 'WRONG_CURRENT_PASS' }; }
    const newKey = await deriveKey(newPass);
    const reencryptDir = (dir) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) { reencryptDir(full); continue; }
        if (!item.name.endsWith(ENC_EXT) && !item.name.endsWith('.draw')) continue;
        const plain = decryptContent(fs.readFileSync(full, 'utf8'), oldKey);
        fs.writeFileSync(full, encryptContent(plain, newKey), 'utf8');
      }
    };
    reencryptDir(NOTES_DIR);
    try { migrateTodos('rekey', oldKey, newKey); } catch (_) {}
    try {
      const rekeyDir = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) { rekeyDir(full); continue; }
          if (!isEncryptedAttachment(full)) continue;
          const plain = decryptAttachmentBuffer(fs.readFileSync(full), oldKey);
          const tmp = full + '.amelie-rekey-tmp';
          fs.writeFileSync(tmp, encryptAttachmentBuffer(plain, newKey));
          fs.renameSync(tmp, full);
        }
      };
      if (ATTACHMENTS_DIR && fs.existsSync(ATTACHMENTS_DIR)) rekeyDir(ATTACHMENTS_DIR);
    } catch (e) { console.error('[enc] attachment rekey failed:', e.message); }
    if (ENCRYPTION_KEY) ENCRYPTION_KEY = newKey; else _REENCRYPT_KEY = newKey;
    writeVerifyToken(newKey);
  }
  // Keep a remembered passphrase in sync with the new one (else auto-unlock
  // would fail next launch and silently drop the stored key).
  try {
    if (fs.existsSync(PASSKEY_FILE) && storageBackendInfo().available) {
      const { safeStorage } = require('electron');
      fs.writeFileSync(PASSKEY_FILE, safeStorage.encryptString(String(newPass || '')), { mode: 0o600 });
    }
  } catch (_) {}
  return { ok: true };
});

ipcMain.handle('vault:enableEncryption', async (_, passphrase, algo, openPlaintext) => {
  if (!passphrase) return { ok: false, error: 'Passphrase richiesta', code: 'PASS_REQUIRED' };
  ENCRYPTION_ALGO = 'aes';   // AES-256-GCM only (ChaCha20 removed — not in Electron's BoringSSL)
  // Fail FAST & clean if the runtime can't use AES (shouldn't happen) so the IPC
  // returns an error instead of leaving the UI stuck on "encrypting…".
  if (!cipherAvailable('aes')) {
    return { ok: false, error: 'AES-256 non disponibile in questa versione', code: 'AES_UNAVAILABLE' };
  }
  KDF = 'argon2id';   // new vaults use Argon2id (OWASP's first-choice, memory-hard) KDF
  const openPlain = !!openPlaintext;
  // Envelope: a RANDOM data key (DEK) encrypts the vault; the password-derived
  // key (KEK) only WRAPS it in the header. Changing the password later just
  // re-wraps — the DEK (and the encrypted notes) never change.
  const salt = getOrCreateSalt();
  const kek = await deriveKey(passphrase, KDF, salt);
  const key = crypto.randomBytes(32);   // the DEK
  const cfg = readAppConfig();
  cfg.encryption = { enabled: true, algo: ENCRYPTION_ALGO, kdf: KDF, openPlaintext: openPlain };
  writeAppConfig(cfg);
  writeVaultHeader(key, kek, salt);     // wrap the DEK with the KEK
  if (openPlain) {
    // "Plaintext while open": leave files in clear on disk now, just record the
    // key + verify token; the whole vault is encrypted on quit with the DEK.
    writeVerifyToken(key);
    _REENCRYPT_KEY = key; _reencryptDone = false;
    ENCRYPTION_KEY = null;
  } else {
    var encReport = encryptVaultToDisk(key);   // encrypt everything at rest + write verify token
    ENCRYPTION_KEY = key;
  }
  return { ok: true, converted: encReport?.converted ?? 0, failed: encReport?.failed?.length ?? 0 };
});

ipcMain.handle('vault:disableEncryption', async (_, passphrase) => {
  // In "plaintext while open" mode ENCRYPTION_KEY is null but _REENCRYPT_KEY holds it.
  const dek = ENCRYPTION_KEY || _REENCRYPT_KEY;   // the live DATA key
  if (!dek) return { ok: false, error: 'Encryption non attiva', code: 'ENC_INACTIVE' };
  if (!passphrase) return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
  // VERIFY the passphrase. Envelope: derive the KEK and check it unwraps to the
  // live DEK. Legacy (no header): fall back to the verify token / note-decrypt.
  const header = readVaultHeader();
  if (header) {
    try {
      const kek = await deriveKey(passphrase, normKdf(header.kdf), Buffer.from(header.salt, 'hex'));
      if (!unwrapDEK(header.wrappedKey, kek, header.algo).equals(dek)) return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
    } catch (_) { return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' }; }
  } else {
    const key = await deriveKey(passphrase);
    const vt = verifyKey(key);
    if (vt === false) return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
    if (vt === null) {
      try {
        const testNotes = [];
        const findFirst = (dir) => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (testNotes.length) return;
            if (item.isDirectory()) { findFirst(path.join(dir, item.name)); continue; }
            if (item.name.endsWith(ENC_EXT) || item.name.endsWith(LEGACY_ENC_EXT)) testNotes.push(path.join(dir, item.name));
          }
        };
        findFirst(NOTES_DIR);
        if (testNotes.length > 0) decryptContent(fs.readFileSync(testNotes[0], 'utf8'), key); // throws if wrong
      } catch(_) {
        return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
      }
    }
  }
  // Decrypt everything back to plaintext (a no-op if already plaintext-on-disk).
  let decReport;
  try { decReport = decryptVaultToDisk(dek); } catch (_) { return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' }; }
  ENCRYPTION_KEY = null;
  _REENCRYPT_KEY = null;   // stop the re-encrypt-on-quit
  // No more vault to unlock → remembered passphrase, verify token + envelope header are moot.
  try { if (fs.existsSync(PASSKEY_FILE)) fs.unlinkSync(PASSKEY_FILE); } catch (_) {}
  try { if (fs.existsSync(VERIFY_FILE)) fs.unlinkSync(VERIFY_FILE); } catch (_) {}
  try { if (VAULT_HEADER_FILE && fs.existsSync(VAULT_HEADER_FILE)) fs.unlinkSync(VAULT_HEADER_FILE); } catch (_) {}
  const cfg = readAppConfig();
  cfg.encryption = { enabled: false };
  writeAppConfig(cfg);
  return { ok: true, converted: decReport?.converted ?? 0, failed: decReport?.failed?.length ?? 0 };
});

// Switch between "encrypted at rest" and "plaintext while open" WITHOUT changing
// the passphrase. Requires the vault to be unlocked.
ipcMain.handle('vault:setRestMode', async (_, openPlaintext) => {
  const cfg = readAppConfig();
  if (!cfg.encryption?.enabled) return { ok: false, error: 'Encryption non attiva', code: 'ENC_INACTIVE' };
  const want = !!openPlaintext;
  const isPlain = (cfg.encryption.openPlaintext === true);
  if (want === isPlain) {
    // No transition needed — just persist the flag.
    cfg.encryption.openPlaintext = want; writeAppConfig(cfg); return { ok: true };
  }
  let modeReport = null;
  if (want) {
    // at-rest → plaintext: need the live key.
    const key = ENCRYPTION_KEY;
    if (!key) return { ok: false, error: 'Vault bloccato' };
    writeVerifyToken(key);
    try { modeReport = decryptVaultToDisk(key); } catch (e) { return { ok: false, error: 'Decifratura fallita' }; }
    _REENCRYPT_KEY = key; _reencryptDone = false;
    ENCRYPTION_KEY = null;
  } else {
    // plaintext → at-rest: encrypt now with the stashed key.
    const key = _REENCRYPT_KEY || ENCRYPTION_KEY;
    if (!key) return { ok: false, error: 'Vault bloccato' };
    try { modeReport = encryptVaultToDisk(key); } catch (e) { return { ok: false, error: 'Cifratura fallita' }; }
    ENCRYPTION_KEY = key; _REENCRYPT_KEY = null;
  }
  cfg.encryption.openPlaintext = want;
  writeAppConfig(cfg);
  refreshSyncPlaintextFlag();   // pause sync while plaintext / resume when at-rest
  return { ok: true, converted: modeReport?.converted ?? 0, failed: modeReport?.failed?.length ?? 0 };
});

// Verify a passphrase against the vault and, on success, set ENCRYPTION_KEY.
// Shared by the manual unlock overlay and the remember-password auto-unlock.
// With encryption ON at rest, a plaintext note/draw sitting next to its encrypted
// form is a STALE leftover (e.g. an old .md re-pulled from a synced share that
// still had pre-encryption plaintext, or left by a crash) — and a privacy leak.
// SAFE cleanup (reversible): a plaintext file is set aside ONLY when ALL hold:
//   1) an encrypted counterpart exists,
//   2) that .enc actually DECRYPTS (the kept copy is provably good, not corrupt),
//   3) the plaintext is NOT newer than the .enc (never drop fresher content).
// It is MOVED (not deleted) to an out-of-vault backup so nothing is ever lost and
// no plaintext leaks; the removal from the vault then propagates over two-way sync.
// A plaintext file with NO encrypted counterpart is left untouched (still needs
// encrypting elsewhere). Best-effort.
function purgeStalePlaintextNotes(key) {
  if (!NOTES_DIR || !fs.existsSync(NOTES_DIR)) return 0;
  const quarantine = path.join(APP_HOME, 'stale-plaintext-backup');
  let moved = 0;
  const walk = (dir) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue; }
      let encSibling = null;
      if (it.name.endsWith('.md'))        encSibling = full.slice(0, -3) + ENC_EXT;   // foo.md   → foo.enc
      else if (it.name.endsWith('.draw')) encSibling = full + ENC_EXT;                // foo.draw → foo.draw.enc
      if (!encSibling || !fs.existsSync(encSibling)) continue;
      // (3) keep the plaintext if it is newer than the encrypted copy.
      try { if (fs.statSync(full).mtimeMs > fs.statSync(encSibling).mtimeMs + 2000) continue; } catch (_) { continue; }
      // (2) keep the plaintext unless the .enc provably decrypts.
      if (key) { try { decryptContent(fs.readFileSync(encSibling, 'utf8'), key); } catch (_) { continue; } }
      // Move to an out-of-vault backup (reversible, no leak, removal syncs).
      try {
        const dest = path.join(quarantine, path.relative(NOTES_DIR, full));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(full, dest);
        moved++;
      } catch (_) {}
    }
  };
  try { walk(NOTES_DIR); } catch (e) { console.error('[enc] purge stale plaintext failed:', e.message); }
  if (moved) console.log('[enc] set aside', moved, 'stale plaintext note(s) →', quarantine);
  return moved;
}

// Replace EVERY occurrence of `find` with `repl` (literal, no regex — filenames
// can contain regex metacharacters like parentheses).
function _replaceAllLiteral(hay, find, repl) {
  return (find && hay.includes(find)) ? hay.split(find).join(repl) : hay;
}

// Rewrite attachment links in all notes for a set of {oldLogical,newLogical} moves
// (paths relative to attachments/, e.g. media/clip.mp4 → videos/clip.mp4). Handles
// both the clean `attachments/…` and legacy `inkwell://attachments/…` link forms,
// and both raw and per-segment URL-encoded spellings (the renderer encodes each
// segment with encodeURIComponent). `key` decrypts/re-encrypts .enc notes; pass
// null in plaintext-on-disk mode. Notes are rewritten atomically; draws untouched.
function _rewriteAttachmentLinksInNotes(pairs, key) {
  if (!NOTES_DIR || !fs.existsSync(NOTES_DIR) || !pairs.length) return 0;
  const encSeg = (rel) => rel.split('/').map(encodeURIComponent).join('/');
  let touched = 0;
  const walk = (dir) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { if (it.name === 'attachments') continue; walk(full); continue; }
      // NOTE detection mirrors listNotesRecursive: an encrypted note is <stem>.enc
      // (the .md is REPLACED, not appended), while draws are <stem>.draw.enc — so a
      // bare .enc that isn't a .draw.enc is a note. Plaintext notes are *.md.
      const isDrawEnc = it.name.endsWith('.draw' + ENC_EXT) || it.name.endsWith('.draw' + LEGACY_ENC_EXT);
      const isEnc = !isDrawEnc && (it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT));
      const isPlainNote = it.name.endsWith('.md');
      if (!isEnc && !isPlainNote) continue;            // notes only (skip draws/other)
      let raw; try { raw = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
      let body; try { body = (key && isEnc) ? decryptContent(raw, key) : raw; } catch (_) { continue; }
      let out = body;
      for (const p of pairs) {
        for (const oldRel of new Set([p.oldLogical, encSeg(p.oldLogical)])) {
          const newRel = encSeg(p.newLogical);
          // inkwell:// form FIRST so the bare-form pass can't touch an already-rewritten link
          out = _replaceAllLiteral(out, 'inkwell://attachments/' + oldRel, 'inkwell://attachments/' + newRel);
          out = _replaceAllLiteral(out, 'attachments/' + oldRel, 'attachments/' + newRel);
        }
      }
      if (out !== body) {
        try {
          const toWrite = (key && isEnc) ? encryptContent(out, key) : out;
          const tmp = full + '.amelie-tmp';
          const fd = fs.openSync(tmp, 'w');
          try { fs.writeFileSync(fd, toWrite, 'utf8'); try { fs.fsyncSync(fd); } catch (_) {} }
          finally { fs.closeSync(fd); }
          fs.renameSync(tmp, full);
          touched++;
          console.log('[videos] updated links in', path.relative(NOTES_DIR, full));
        } catch (e) { console.error('[videos] link rewrite failed for', full, e.message); }
      }
    }
  };
  walk(NOTES_DIR);
  return touched;
}

// One-time, idempotent: move every VIDEO attachment out of the legacy flat root /
// media/ / video/ locations into attachments/videos/, and fix the links in notes
// to match. Runs on unlock (key available → can rewrite .enc notes; in plaintext-
// while-open mode files are already plaintext and key is null). New imports already
// land in videos/ (renderer _attachmentTarget), so on a tidy vault this is a no-op.
// A dot-prefixed name inside attachments/ is never a file the user put there: it is
// one of ours mid-flight — `.amelie-import-<pid>-<ts>.mp4` while a media file is being
// stored (temp first, so faststart can rewrite it and the dedup can compare the bytes
// that would actually be stored), or `.amelie-enc-tmp` while one is re-encrypted. They
// carry a REAL extension, so the extension tests below matched them and a tree refresh
// landing mid-import listed the temp in the sidebar as a video of its own. Hidden names
// are skipped wherever attachments are surfaced or moved.
const isOwnTempOrHidden = (name) => name.startsWith('.');

const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|m4v|avi|wmv|mpeg)$/i;
function migrateVideosToVideosFolder(key) {
  if (!ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return 0;
  const videosDir = path.join(ATTACHMENTS_DIR, 'videos');
  // Scan only the legacy locations — NEVER videos/ itself (would be a no-op loop),
  // nor pdf/ or images/ (no videos there).
  const scan = [
    ['', ATTACHMENTS_DIR],
    ['media/', path.join(ATTACHMENTS_DIR, 'media')],
    ['video/', path.join(ATTACHMENTS_DIR, 'video')],
  ];
  const moves = [];
  for (const [relPrefix, abs] of scan) {
    if (!fs.existsSync(abs)) continue;
    let items; try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const it of items) {
      if (!it.isFile() || isOwnTempOrHidden(it.name)) continue;
      const onDiskName = it.name;                                   // may end .enc/.amd
      const logical = onDiskName.replace(/\.(enc|amd)$/, '');
      if (!VIDEO_EXT_RE.test(logical)) continue;
      moves.push({ relPrefix, abs, onDiskName, logical });
    }
  }
  if (!moves.length) return 0;
  fs.mkdirSync(videosDir, { recursive: true });
  const linkPairs = [];
  let moved = 0;
  for (const m of moves) {
    const encSuffix = m.onDiskName.endsWith(ENC_EXT) ? ENC_EXT
                    : m.onDiskName.endsWith(LEGACY_ENC_EXT) ? LEGACY_ENC_EXT : '';
    const ext = path.extname(m.logical);
    const stem = path.basename(m.logical, ext);
    // Collision-free target leaf inside videos/.
    let leaf = m.logical, n = 1;
    while (fs.existsSync(path.join(videosDir, leaf + encSuffix)) || fs.existsSync(path.join(videosDir, leaf))) {
      leaf = `${stem}-${n}${ext}`; n++;
    }
    try {
      fs.renameSync(path.join(m.abs, m.onDiskName), path.join(videosDir, leaf + encSuffix));
      moved++;
      linkPairs.push({ oldLogical: m.relPrefix + m.logical, newLogical: 'videos/' + leaf });
    } catch (e) { console.error('[videos] move failed:', m.onDiskName, e.message); }
  }
  if (linkPairs.length) {
    try { _rewriteAttachmentLinksInNotes(linkPairs, key); } catch (e) { console.error('[videos] link rewrite pass failed:', e.message); }
  }
  // Drop now-empty legacy dirs (best-effort; only removes if empty).
  for (const d of ['media', 'video']) { try { fs.rmdirSync(path.join(ATTACHMENTS_DIR, d)); } catch (_) {} }
  if (moved) {
    console.log('[videos] moved', moved, 'video(s) → attachments/videos/');
    if (syncManager) syncManager.scheduleSync();
  }
  return moved;
}

// Consolidate legacy audio into attachments/audio/, and fix the links in notes to
// match. Mirrors migrateVideosToVideosFolder. Sources: the vault root (drag/paste
// used to drop audio there) and the old shared media/ bucket (import used to put
// audio+video together). New audio already lands in audio/ (renderer
// _attachmentTarget + importObsidian), so on a tidy vault this is a no-op.
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|flac|aac|opus|wma|weba)$/i;
function migrateAudioToAudioFolder(key) {
  if (!ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return 0;
  const audioDir = path.join(ATTACHMENTS_DIR, 'audio');
  // Scan only the legacy locations — NEVER audio/ itself, nor pdf/videos/images/.
  // AUDIO_EXT_RE filtering keeps images in the root untouched.
  const scan = [
    ['', ATTACHMENTS_DIR],
    ['media/', path.join(ATTACHMENTS_DIR, 'media')],
  ];
  const moves = [];
  for (const [relPrefix, abs] of scan) {
    if (!fs.existsSync(abs)) continue;
    let items; try { items = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const it of items) {
      if (!it.isFile() || isOwnTempOrHidden(it.name)) continue;
      const onDiskName = it.name;                                   // may end .enc/.amd
      const logical = onDiskName.replace(/\.(enc|amd)$/, '');
      if (!AUDIO_EXT_RE.test(logical)) continue;
      moves.push({ relPrefix, abs, onDiskName, logical });
    }
  }
  if (!moves.length) return 0;
  fs.mkdirSync(audioDir, { recursive: true });
  const linkPairs = [];
  let moved = 0;
  for (const m of moves) {
    const encSuffix = m.onDiskName.endsWith(ENC_EXT) ? ENC_EXT
                    : m.onDiskName.endsWith(LEGACY_ENC_EXT) ? LEGACY_ENC_EXT : '';
    const ext = path.extname(m.logical);
    const stem = path.basename(m.logical, ext);
    // Collision-free target leaf inside audio/.
    let leaf = m.logical, n = 1;
    while (fs.existsSync(path.join(audioDir, leaf + encSuffix)) || fs.existsSync(path.join(audioDir, leaf))) {
      leaf = `${stem}-${n}${ext}`; n++;
    }
    try {
      fs.renameSync(path.join(m.abs, m.onDiskName), path.join(audioDir, leaf + encSuffix));
      moved++;
      linkPairs.push({ oldLogical: m.relPrefix + m.logical, newLogical: 'audio/' + leaf });
    } catch (e) { console.error('[audio] move failed:', m.onDiskName, e.message); }
  }
  if (linkPairs.length) {
    try { _rewriteAttachmentLinksInNotes(linkPairs, key); } catch (e) { console.error('[audio] link rewrite pass failed:', e.message); }
  }
  // Drop the now-possibly-empty legacy media/ dir (best-effort; only if empty).
  try { fs.rmdirSync(path.join(ATTACHMENTS_DIR, 'media')); } catch (_) {}
  if (moved) {
    console.log('[audio] moved', moved, 'audio file(s) → attachments/audio/');
    if (syncManager) syncManager.scheduleSync();
  }
  return moved;
}

async function unlockWithPassphrase(passphrase) {
  const cfg = readAppConfig();
  if (!cfg.encryption?.enabled) return { ok: true };
  const header = readVaultHeader();
  // Algo/KDF: the header is authoritative (it travels with the vault, so a 2nd PC
  // gets the right values even if its local config is stale); else fall back to config.
  ENCRYPTION_ALGO = (header?.algo || cfg.encryption?.algo) === 'chacha' ? 'chacha' : 'aes';
  KDF = normKdf(header?.kdf || cfg.encryption?.kdf);
  const openPlain = cfg.encryption?.openPlaintext === true;
  let key;   // the DATA key (DEK) — everything downstream uses it exactly as before
  try {
    if (header) {
      // ENVELOPE: derive the KEK with the HEADER's salt, unwrap the DEK. A wrong
      // password fails the AEAD tag here → caught below as "Passphrase errata".
      const salt = Buffer.from(header.salt, 'hex');
      const kek = await deriveKey(passphrase, KDF, salt);
      key = unwrapDEK(header.wrappedKey, kek, ENCRYPTION_ALGO);
      // Cache the salt locally so the recovery tool / other paths still find it.
      try { if (!fs.existsSync(SALT_FILE)) fs.writeFileSync(SALT_FILE, salt); } catch (_) {}
    } else {
      // LEGACY (pre-envelope vault, no header yet): old direct-key model. Verify
      // with the token (or by decrypting one note), then ADOPT the derived key as
      // the DEK and write a header — migrating the vault to envelope IN PLACE,
      // WITHOUT re-encrypting anything (DEK == the existing key).
      key = await deriveKey(passphrase);
      const vt = verifyKey(key);
      if (vt === false) return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
      if (vt === null) {
        const testNotes = [];
        const findFirst = (dir) => {
          for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            if (testNotes.length) return;
            if (item.isDirectory()) { findFirst(path.join(dir, item.name)); continue; }
            if (item.name.endsWith(ENC_EXT) || item.name.endsWith(LEGACY_ENC_EXT)) testNotes.push(path.join(dir, item.name));
          }
        };
        findFirst(NOTES_DIR);
        if (testNotes.length > 0) decryptContent(fs.readFileSync(testNotes[0], 'utf8'), key); // throws if wrong
        writeVerifyToken(key);
      }
      // Migrate to envelope (best-effort: a failure here doesn't block unlock).
      try { writeVaultHeader(key, key, getOrCreateSalt()); } catch (_) {}
    }

    if (openPlain) {
      // "Plaintext while open": decrypt the WHOLE vault to disk now (no-op if a
      // previous crash already left it decrypted), then run with the vault
      // treated as plaintext (ENCRYPTION_KEY null). Re-encrypted on quit.
      try { const r = decryptVaultToDisk(key); if (r && !r.ok) console.error('[enc] unlock decrypt: ' + r.failed.length + ' file(s) failed, kept encrypted'); } catch (_) {}
      _REENCRYPT_KEY = key; _reencryptDone = false;
      ENCRYPTION_KEY = null;
      try { migrateNotesFrontmatter(null); } catch (_) {}     // notes are plaintext .md on disk now
      try { migrateVideosToVideosFolder(null); } catch (_) {} // legacy videos → videos/ + fix links (plaintext)
      try { migrateAudioToAudioFolder(null); } catch (_) {}   // legacy audio (root/media) → audio/ + fix links
    } else {
      ENCRYPTION_KEY = key;
      try { migrateNoteExt(); } catch (_) {}                  // legacy .amd → .enc (rename only)
      try { migrateAttachmentsEncrypt(key); } catch (_) {}    // encrypt + .enc marker on attachments
      try { migrateDrawsEnc(key); } catch (_) {}              // .draw → .draw.enc marker
      try { migrateTodos('encrypt', null, key); } catch (_) {} // todo .md → .md.enc marker
      try { migrateNotesFrontmatter(key); } catch (_) {}      // add created/modified frontmatter to .md notes
      try { migrateVideosToVideosFolder(key); } catch (_) {}  // legacy videos → videos/ + fix links (at rest)
      try { migrateAudioToAudioFolder(key); } catch (_) {}    // legacy audio (root/media) → audio/ + fix links
      try { purgeStalePlaintextNotes(key); } catch (_) {}     // remove stale plaintext leftovers (verified+reversible)
    }
    refreshSyncPlaintextFlag();   // pause sync if unlocked into plaintext-while-open mode
    return { ok: true };
  } catch(_) {
    return { ok: false, error: 'Passphrase errata', code: 'WRONG_PASS' };
  }
}

ipcMain.handle('vault:unlock', async (_, passphrase) => await unlockWithPassphrase(passphrase));

// NOTE: "remember password" is gone by design — the passphrase is never stored,
// so there are no remember/forget/isRemembered handlers. PASSKEY_FILE only
// survives as something to SCRUB if an older version left one behind (below).

// Try to unlock from the stored passphrase. Returns {ok:false, noKey:true}
// when there is nothing stored (renderer then shows the manual overlay).
ipcMain.handle('vault:autoUnlock', async () => {
  const cfg = readAppConfig();
  if (!cfg.encryption?.enabled) return { ok: true, skipped: true };
  // Already unlocked in this main-process session (e.g. right after a restore that
  // validated the decrypt password) → no overlay on the renderer reload.
  if (ENCRYPTION_KEY) return { ok: true, alreadyUnlocked: true };
  // "Remember password" was removed: the passphrase is NEVER stored, so there is
  // no silent unlock. Scrub any stale passkey left by an older version and force
  // the unlock prompt.
  try { if (PASSKEY_FILE && fs.existsSync(PASSKEY_FILE)) fs.unlinkSync(PASSKEY_FILE); } catch (_) {}
  return { ok: false, noKey: true };
});

/** Count the attachments by type (pdf / video / audio / image / script / other). */
function _attachmentStats() {
  const stats = { total: 0, pdf: 0, video: 0, audio: 0, image: 0, script: 0, other: 0 };
  const VIDEO = ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'];
  // Wider than what Amelie now accepts (.ogg, .avif): these count what is ON DISK, so
  // a file imported before they were dropped is still counted as audio/image instead of
  // falling into "other".
  const AUDIO = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.opus', '.aac'];
  const IMAGE = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];
  const SCRIPT = ['.sh', '.bash', '.zsh', '.py', '.js', '.ts', '.rb', '.pl', '.lua', '.ps1', '.bat'];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      stats.total++;
      // On an encrypted vault the file on disk is "<name>.<realext>.enc", so the
      // type has to be read from the LOGICAL name — otherwise every attachment
      // counts as ".enc" → "other" and each row reads 0.
      let name = e.name;
      if (name.endsWith(ENC_EXT))             name = name.slice(0, -ENC_EXT.length);
      else if (name.endsWith(LEGACY_ENC_EXT)) name = name.slice(0, -LEGACY_ENC_EXT.length);
      const ext = path.extname(name).toLowerCase();
      if (ext === '.pdf')             stats.pdf++;
      else if (VIDEO.includes(ext))   stats.video++;
      else if (AUDIO.includes(ext))   stats.audio++;
      else if (IMAGE.includes(ext))   stats.image++;
      else if (SCRIPT.includes(ext))  stats.script++;
      else                            stats.other++;
    }
  };
  if (ATTACHMENTS_DIR && fs.existsSync(ATTACHMENTS_DIR)) walk(ATTACHMENTS_DIR);
  return stats;
}

ipcMain.handle('vault:getInfo', async () => {
  const cfg = readAppConfig();
  return {
    vaultPath: VAULT_DIR,
    encryptionEnabled: !!cfg.encryption?.enabled,
    encryptionAlgo: cfg.encryption?.algo === 'chacha' ? 'chacha' : 'aes',
    encryptionOpenPlaintext: cfg.encryption?.openPlaintext === true,
    noteCount: NOTES_DIR ? countNotesRecursive(NOTES_DIR) : 0,
    attachments: _attachmentStats(),
  };
});

// ─── IPC: File System ────────────────────────────────────────────────────────

ipcMain.handle('fs:listNotes', async () => {
  return listNotesRecursive(NOTES_DIR);
});

// Full-text fuzzy search across all notes
ipcMain.handle('fs:searchNotes', async (_, query) => {
  if (!query || query.trim().length < 1) return [];

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  const searchDir = (dir, base) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch(_) { return; }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      if (item.isDirectory()) {
        searchDir(abs, base ? `${base}/${item.name}` : item.name);
        continue;
      }

      // Resolve the LOGICAL note name + whether the on-disk bytes are encrypted.
      // Encrypted notes SWAP .md→.enc (foo.md → foo.enc); plaintext notes keep
      // .md. Encrypted drawings are foo.draw.enc — not notes, so skip them.
      let logicalName = null, encrypted = false;
      if (item.name.endsWith(ENC_EXT)) {
        const stem = item.name.slice(0, -ENC_EXT.length);
        if (stem.endsWith('.draw')) continue;   // encrypted drawing, not a note
        logicalName = stem + '.md';
        encrypted = true;
      } else if (item.name.endsWith('.md')) {
        logicalName = item.name;
      } else {
        continue;
      }

      let content;
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        content = stripNoteFrontmatter(encrypted && ENCRYPTION_KEY ? decryptContent(raw, ENCRYPTION_KEY) : raw);
      } catch(_) { continue; }
      const rel   = base ? `${base}/${logicalName}` : logicalName;
      const lower = content.toLowerCase();
      const name  = logicalName.replace('.md','').toLowerCase();

      // Score: all terms must appear (in name OR content)
      let matched = true;
      let score = 0;
      for (const t of terms) {
        const inName    = name.includes(t);
        const inContent = lower.includes(t);
        if (!inName && !inContent) { matched = false; break; }
        if (inName) score += 10;
        if (inContent) score += lower.split(t).length - 1; // frequency
      }
      if (!matched) continue;

      // Extract a snippet around the first term hit. The lead-in is SHORT on purpose:
      // the sidebar draws this on one line, ellipsised at roughly 45 characters, so with
      // the old 40 characters of context the matched word landed exactly on the cut and
      // you searched for something and saw no trace of it in the results. 12 in front is
      // enough to show where the phrase starts and still leaves the match in view.
      const firstTerm = terms[0];
      const idx = lower.indexOf(firstTerm);
      let snippet = '';
      if (idx !== -1) {
        const start = Math.max(0, idx - 12);
        const end   = Math.min(content.length, idx + 140);
        snippet = (start > 0 ? '…' : '') + content.slice(start, end).replace(/\n+/g, ' ').trim() + (end < content.length ? '…' : '');
      }

      const stat = fs.statSync(abs);
      results.push({
        path: rel,
        name: logicalName.replace('.md',''),
        snippet,
        score,
        modified: stat.mtime.toISOString(),
      });
    }
  };

  searchDir(NOTES_DIR, '');
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 20);
});

ipcMain.handle('fs:readNote', async (_, filePath) => {
  const fullPath = noteFilePath(filePath);
  if (!fullPath.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  return readNoteContent(filePath);
});

ipcMain.handle('fs:writeNote', async (_, filePath, content, opts) => {
  const fullPath = noteFilePath(filePath);
  if (!fullPath.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  writeNoteContent(filePath, content, !!(opts && opts.keepModified));
  if (syncManager) syncManager.scheduleSync();
  return true;
});

ipcMain.handle('fs:deleteNote', async (_, filePath) => {
  _internalWriteUntil = Date.now() + 1500;   // our own delete — the UI refreshes itself; don't fire the watcher
  const fullPath = noteFilePath(filePath);
  if (!fullPath.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  if (syncManager) syncManager.scheduleSync();
  return true;
});

// Gentle cap: a filename segment can't exceed the filesystem's ~255-byte limit.
// The UI already caps input at 254 chars; this is the net for multibyte names —
// truncates the LAST path segment (keeping any extension) so create/rename never
// crashes with a raw FS error, it just quietly shortens an over-long name.
function capSegmentBytes(relPath, maxBytes = 255) {
  const parts = String(relPath).split('/');
  let seg = parts[parts.length - 1];
  if (Buffer.byteLength(seg, 'utf8') <= maxBytes) return relPath;
  const dot = seg.lastIndexOf('.');
  const ext = dot > 0 ? seg.slice(dot) : '';
  let base = dot > 0 ? seg.slice(0, dot) : seg;
  while (base.length && Buffer.byteLength(base + ext, 'utf8') > maxBytes) base = base.slice(0, -1);
  parts[parts.length - 1] = base + ext;
  return parts.join('/');
}

ipcMain.handle('fs:createFolder', async (_, folderPath) => {
  const fullPath = path.join(NOTES_DIR, capSegmentBytes(folderPath));
  if (!fullPath.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  fs.mkdirSync(fullPath, { recursive: true });
  return true;
});

ipcMain.handle('fs:deleteFolder', async (_, folderPath) => {
  _internalWriteUntil = Date.now() + 1500;   // our own delete — the UI refreshes itself; don't fire the watcher
  const fullPath = path.join(NOTES_DIR, folderPath);
  // Guard: must be strictly inside NOTES_DIR (never the vault root itself)
  if (!fullPath.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true, force: true });
  if (syncManager) syncManager.scheduleSync();
  return true;
});

ipcMain.handle('fs:renameNote', async (_, oldPath, newPath) => {
  newPath = capSegmentBytes(newPath);   // gentle 255-byte name cap (no FS error)
  // Map through noteFilePath so encrypted notes (.md→.enc) and draws
  // (.draw→.draw.enc) rename their REAL on-disk file, not the logical name.
  const fullOld = noteFilePath(oldPath);
  const fullNew = noteFilePath(newPath);
  if (!fullOld.startsWith(NOTES_DIR + path.sep) || !fullNew.startsWith(NOTES_DIR + path.sep)) throw new Error('Invalid path');
  const dir = path.dirname(fullNew);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(fullOld, fullNew);
  if (syncManager) syncManager.scheduleSync();
  return true;
});



// ─── IPC: Export note → PDF ──────────────────────────────────────────────────
// The renderer hands us a self-contained HTML document (markdown already
// rendered, print stylesheet inlined). We load it in an offscreen window so
// inkwell:// image attachments resolve through the global protocol handler,
// print it to PDF, then write it where the user chooses.
ipcMain.handle('note:exportPdf', async (_, name, html, opts) => {
  const o = opts || {};
  const safeName = String(name || 'note').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 120) || 'note';
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow || undefined, {
    title: 'Esporta in PDF',
    defaultPath: path.join(app.getPath('documents') || os.homedir(), `${safeName}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  // Validate the options coming from the renderer.
  const VALID_SIZES = ['A3', 'A4', 'A5', 'Letter', 'Legal', 'Tabloid'];
  const pageSize = VALID_SIZES.includes(o.pageSize) ? o.pageSize : 'A4';
  const landscape = o.landscape === true;
  const m = (typeof o.margin === 'number' && o.margin >= 0) ? o.margin : 0.6;

  // The 16:9 "Wide" format is driven by a CSS @page rule embedded in the HTML;
  // here we just honour it via preferCSSPageSize (custom pageSize objects fail
  // to print in this Electron build, so this is the only reliable path).
  const printOpts = o.wide
    ? { printBackground: true, preferCSSPageSize: true }
    : { printBackground: true, landscape, pageSize,
        margins: { marginType: 'custom', top: m, bottom: m, left: m, right: m } };

  // Stage the HTML as a temp file so it loads from disk (lets inkwell:// images
  // resolve) rather than from a data: URL. The HTML holds the DECRYPTED note
  // body, so keep it OUT of the world-readable shared tmp: a private 0700 dir
  // (mkdtemp) + a 0600 file, removed in finally.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-export-'));
  const tmpFile = path.join(tmpDir, 'export.html');
  let win = null;
  try {
    fs.writeFileSync(tmpFile, html, { encoding: 'utf8', mode: 0o600 });
    win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    await win.loadFile(tmpFile);
    // Wait for web fonts to finish loading (so wrapping matches the on-screen
    // view), bounded so a missing CDN can't hang the export.
    try {
      await Promise.race([
        win.webContents.executeJavaScript('document.fonts.ready.then(() => true)'),
        new Promise(r => setTimeout(r, 1500)),
      ]);
    } catch (_) {}
    // Give late-loading images a final moment to settle before printing.
    await new Promise(r => setTimeout(r, 200));
    const pdf = await win.webContents.printToPDF(printOpts);
    fs.writeFileSync(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { error: String(err && err.message || err) };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ─── IPC: Attachments ────────────────────────────────────────────────────────────

// Save file with a human-readable name, auto-incrementing to avoid collisions
// mp4/mov files indexed at the END (moov after mdat) don't play through the
// custom protocol (the demuxer rejects the stitched head+tail). A lossless
// faststart remux (-c copy) moves the index to the head — instant even for
// big files. Best-effort: skipped silently when ffmpeg isn't installed.
const { execFile: _execFile } = require('child_process');
const _execFileP = require('util').promisify(_execFile);
let _ffmpegOk = null;
async function _ffmpegAvailable() {
  if (_ffmpegOk !== null) return _ffmpegOk;
  try { await _execFileP('ffmpeg', ['-version'], { timeout: 5000 }); _ffmpegOk = true; }
  catch (_) { _ffmpegOk = false; }
  return _ffmpegOk;
}
async function maybeFaststart(filePath) {
  if (!/\.(mp4|mov|m4v)$/i.test(filePath)) return;
  if (!(await _ffmpegAvailable())) return;
  const tmp = filePath + '.faststart.tmp.mp4';
  try {
    await _execFileP('ffmpeg', ['-y', '-v', 'error', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmp], { timeout: 180000 });
    fs.renameSync(tmp, filePath);
  } catch (_) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  }
}

// A file in `dir` with the exact same bytes as `candidatePath` (temp files and
// the candidate itself excluded), or null. Size filter first: full reads only
// happen on same-size files, which are rare.
function _findIdenticalFile(dir, candidatePath) {
  const size = fs.statSync(candidatePath).size;
  const candName = path.basename(candidatePath);
  let candBytes = null;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || f.name === candName || f.name.startsWith('.amelie-import-')) continue;
    const p = path.join(dir, f.name);
    try {
      if (fs.statSync(p).size !== size) continue;
      if (!candBytes) candBytes = fs.readFileSync(candidatePath);
      if (fs.readFileSync(p).equals(candBytes)) return f.name;
    } catch (_) {}
  }
  return null;
}

// Hard per-file import cap. Import reads the whole file into memory (often a few
// transient full-size Buffers, plus a re-encrypt concat), so an oversized file
// risks OOM / Node's ~Buffer.MAX_LENGTH wall. Playback is streamed and unaffected.
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;   // 512 MB

// ─── Does the content match the extension? (magic bytes) ─────────────────────
// An extension is a claim, not evidence: an executable renamed fake.png was stored
// as an image, and a PDF is exactly the kind of file people forward on. Every format
// Amelie accepts has a recognisable head, so the first 4 KB are matched against the
// extension the file arrives under and refused when they disagree. This is NOT a virus
// scan and cannot be one — it stops the mismatch, nothing more.
const _ascii = (b, off, s) => b.length >= off + s.length && b.toString('latin1', off, off + s.length) === s;
const _riff = (b, form) => _ascii(b, 0, 'RIFF') && _ascii(b, 8, form);
// ISO base media (mp4/m4v/m4a/mov). Not only 'ftyp': an older QuickTime file can open
// on another top-level atom, and refusing those would be a false accusation.
const _isoBmff = (b) => ['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'].some(a => _ascii(b, 4, a));
// MPEG audio: an ID3 tag, or a bare frame sync (11 set bits).
const _mp3ish = (b) => _ascii(b, 0, 'ID3') || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
const _asf  = (b) => b.length > 3 && b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xb2 && b[3] === 0x75;  // wma/wmv
const _ebml = (b) => b.length > 3 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;  // webm/mkv/weba
const _mpegVideo = (b) =>
  (b.length > 3 && b[0] === 0 && b[1] === 0 && b[2] === 1 && [0xb3, 0xba, 0xbb].includes(b[3]))  // program/elementary
  || (b.length > 188 && b[0] === 0x47 && b[188] === 0x47);                                        // transport stream
const ATTACHMENT_SIGNATURES = {
  png:  b => _ascii(b, 0, '\x89PNG\r\n\x1a\n'),
  jpg:  b => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif:  b => _ascii(b, 0, 'GIF87a') || _ascii(b, 0, 'GIF89a'),
  webp: b => _riff(b, 'WEBP'),
  bmp:  b => _ascii(b, 0, 'BM'),
  svg:  b => /<svg[\s>]/i.test(b.toString('utf8')),   // text format: no magic number to read
  pdf:  b => b.toString('latin1').includes('%PDF-'),  // readers tolerate junk before the header
  mp3:  _mp3ish,
  wav:  b => _riff(b, 'WAVE'),
  flac: b => _ascii(b, 0, 'fLaC') || _ascii(b, 0, 'ID3'),
  aac:  b => _mp3ish(b) || _ascii(b, 0, 'ADIF'),
  opus: b => _ascii(b, 0, 'OggS'),                    // Opus ships inside an Ogg container
  wma:  _asf,  wmv: _asf,
  weba: _ebml, webm: _ebml, mkv: _ebml,
  m4a:  _isoBmff, mp4: _isoBmff, m4v: _isoBmff, mov: _isoBmff,
  avi:  b => _riff(b, 'AVI '),
  mpeg: _mpegVideo,
};
ATTACHMENT_SIGNATURES.jpeg = ATTACHMENT_SIGNATURES.jpg;

async function saveAttachmentBuffer(originalName, buffer) {
  const blen = (buffer && (buffer.byteLength != null ? buffer.byteLength : buffer.length)) || 0;
  if (blen > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  const ext = path.extname(originalName) || '.png';
  // Both routes into the vault (bytes from the renderer, a path main reads off disk)
  // come through here, so the content check belongs here rather than at each entrance.
  {
    const check = ATTACHMENT_SIGNATURES[ext.slice(1).toLowerCase()];
    if (check) {
      const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
      if (!check(Buffer.from(u8.subarray(0, 4096)))) throw new Error('ATTACHMENT_CONTENT_MISMATCH');
    }
  }
  const baseName = path.basename(originalName, ext)
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40) || 'image';
  // Optional subfolder (e.g. "scripts/") preserved from the passed name.
  const rawSub = path.dirname(originalName);
  const subDir = (rawSub && rawSub !== '.') ? rawSub.split(/[\\/]+/).map(s => s.replace(/[^a-zA-Z0-9_\-]/g, '_')).filter(Boolean).join('/') : '';
  const destDir = subDir ? path.join(ATTACHMENTS_DIR, subDir) : ATTACHMENTS_DIR;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Land on a temp file first: faststart may rewrite the bytes, and the dedup
  // below must compare the bytes that would actually be stored.
  const tmp = path.join(destDir, `.amelie-import-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, Buffer.from(buffer));
  await maybeFaststart(tmp);   // mp4/mov: move the index to the head

  // Pasting a file that's ALREADY in the attachments folder reuses the existing
  // copy instead of storing image-1.png, image-2.png … duplicates. Skipped when
  // encrypting: stored files are ciphertext (random IV) so byte-compare can't match.
  if (!ENCRYPTION_KEY) {
    try {
      const dup = _findIdenticalFile(destDir, tmp);
      if (dup) {
        fs.rmSync(tmp, { force: true });
        return subDir ? `${subDir}/${dup}` : dup;
      }
    } catch (_) {}
  }

  // Find a unique LOGICAL name: image.png, image-1.png … (checking both the
  // plain and the .enc on-disk form so encrypted files never collide).
  let leaf = baseName + ext;
  let counter = 1;
  while (attachmentTaken(path.join(destDir, leaf))) {
    leaf = `${baseName}-${counter}${ext}`;
    counter++;
  }

  // writeAttachmentFile encrypts at rest and names the file <leaf>.enc; the
  // returned LOGICAL leaf (no .enc) keeps the real extension for mime detection.
  writeAttachmentFile(path.join(destDir, leaf), fs.readFileSync(tmp));
  fs.rmSync(tmp, { force: true });
  return subDir ? `${subDir}/${leaf}` : leaf;   // e.g. "audio/rec-20260730-1015.weba"
}

ipcMain.handle('attachment:save', async (_, originalName, buffer) => {
  // The BYTES route (paste, drop, voice recorder) had NO check here: the renderer's own
  // predicate was the only thing between a .zip or a .sh and the vault, so a compromised
  // renderer could plant any file it liked — while the path route below was properly
  // gated. Same allowlist for both. Tested on the extension actually STORED, because
  // saveAttachmentBuffer gives a name that has none the default .png: a name-less pasted
  // blob must still be accepted.
  const _saveExt = (path.extname(String(originalName || '')) || '.png').slice(1).toLowerCase();
  if (!IMPORTABLE_ATTACHMENT_EXT.has(_saveExt)) throw new Error('Unsupported attachment type');
  const r = await saveAttachmentBuffer(originalName, buffer);
  if (syncManager) syncManager.scheduleSync();   // realtime sync: media counts as a change
  return r;
});

// Which notes link a given attachment. The sidebar lists media as files of their own,
// but a recording, a photo or a video usually BELONGS to a note — so finding one in the
// search means "where do I use this?", and the answer is that note. Same reference scan
// as the unused-media sweep, so the two always agree on what "linked" means.
// Unlike the sweep, a note that cannot be read (vault locked, unreadable file) is SKIPPED
// rather than aborting: the cost of missing one here is opening the file on its own, not
// deleting something.
// What "linked" MEANS, in one place. Three passes ask the question — this
// lookup, the unused-media sweep, and the sidebar's folder placement — and they
// must never disagree: a file the sweep calls unused must not be sitting inside
// a folder because the placement thought some note used it.
// `inkwell://attachments/x` needs no case of its own — it contains
// `attachments/x`. Returns the LOGICAL names, the form links always carry.
const ATT_REF_RE = /attachments\/([^)\s"'<>\]]+)/g;
function attachmentRefsIn(content) {
  const out = new Set();
  let m; ATT_REF_RE.lastIndex = 0;
  while ((m = ATT_REF_RE.exec(content)) !== null) {
    const ref = m[1].replace(/\{[^}]*\}$/, '').replace(/#.*$/, '')   // drop {width=…}/#frag
      .split('/').map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } }).join('/');
    if (ref) out.add(ref);
  }
  return out;
}

ipcMain.handle('attachment:usedBy', async (_, attachmentName) => {
  const want = String(attachmentName || '').replace(/^attachments\//, '');
  if (!want || !NOTES_DIR) return [];
  const out = [];
  const walk = (dir, base) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) { walk(abs, base ? `${base}/${it.name}` : it.name); continue; }
      // Present the note under its LOGICAL name, the one the tree uses (an encrypted
      // note is `foo.enc` on disk but `foo.md` everywhere else).
      let logical = null, encrypted = false;
      if (it.name.endsWith(ENC_EXT)) {
        if (!ENCRYPTION_KEY) continue;
        const stem = it.name.slice(0, -ENC_EXT.length);
        logical = stem.endsWith('.draw') ? stem : stem + '.md';
        encrypted = true;
      } else if (it.name.endsWith('.md') || it.name.endsWith('.draw')) {
        logical = it.name;
      } else continue;
      let content;
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        content = encrypted ? decryptContent(raw, ENCRYPTION_KEY) : raw;
      } catch (_) { continue; }
      if (attachmentRefsIn(content).has(want)) {
        let mtime = 0;
        try { mtime = fs.statSync(abs).mtimeMs; } catch (_) {}
        out.push({ p: base ? `${base}/${logical}` : logical, mtime });
      }
    }
  };
  walk(NOTES_DIR, '');
  // Most recently touched note first: when a photo is used in several notes, the one the
  // user worked on last is the one they are most likely looking for. Directory order,
  // which is what a plain walk gives, would be arbitrary.
  return out.sort((a, b) => b.mtime - a.mtime).map(x => x.p);
});

/** Does the attachment still exist on disk? (used to mark dead links). */
ipcMain.handle('attachment:exists', async (_, rel) => {
  try {
    const safe = String(rel || '').replace(/\.\./g, '');
    return attachmentTaken(path.join(ATTACHMENTS_DIR, safe));   // plain OR .enc form
  } catch (_) { return false; }
});

// Import an attachment from a LOCAL file path (paste of a file copied in the
// file manager: the clipboard only carries a file:// URI, not the bytes).
// targetName decides the subfolder routing (e.g. "video/clip.mp4").
// Attachment types Amelie actually supports (images / audio / video / pdf) — the gate
// for BOTH routes into the vault: attachment:save (bytes from the renderer) and
// attachment:importPath (a path main reads off disk). importPath is the dangerous one:
// without the check a compromised renderer (post-XSS) could ask main to read arbitrary
// files (~/.ssh/id_rsa, /etc/passwd, browser cookie DBs…) into the vault and then read
// them back → exfiltration. Never trust the renderer's own predicate for this.
// Keep in step with SUPPORTED_ATTACH_RE in the renderer: ico, avif, ogg, oga, mka,
// mpg and flv are no longer accepted (`weba` is — the voice recorder writes it).
const IMPORTABLE_ATTACHMENT_EXT = new Set([
  'png','jpg','jpeg','gif','webp','svg','bmp',                 // images
  'mp3','wav','m4a','flac','aac','opus','wma','weba',          // audio
  'mp4','m4v','mkv','mov','avi','wmv','mpeg','webm',           // video
  'pdf',
]);
ipcMain.handle('attachment:importPath', async (_, srcPath, targetName) => {
  const _ext = path.extname(String(srcPath || '')).slice(1).toLowerCase();
  if (!IMPORTABLE_ATTACHMENT_EXT.has(_ext)) throw new Error('Unsupported attachment type');
  const st = fs.statSync(srcPath);
  if (!st.isFile()) throw new Error('Not a file');
  // Check size BEFORE reading the whole file into memory.
  if (st.size > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  const r = await saveAttachmentBuffer(targetName || path.basename(srcPath), fs.readFileSync(srcPath));
  if (syncManager) syncManager.scheduleSync();   // realtime sync: media counts as a change
  return r;
});

// Delete an attachment (right-click → "Elimina media"). Subfolders allowed,
// escaping ATTACHMENTS_DIR is not.
ipcMain.handle('attachment:delete', async (_, name) => {
  _internalWriteUntil = Date.now() + 1500;   // our own delete — the UI refreshes itself; don't fire the watcher
  const fullPath = path.resolve(ATTACHMENTS_DIR, String(name || ''));
  if (!fullPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) throw new Error('Invalid path');
  fs.rmSync(encDisk(fullPath), { force: true });   // delete whichever form exists
  if (syncManager) syncManager.scheduleSync();   // realtime sync: removal counts as a change
  return true;
});

// Read copied FILE PATHS straight from the system clipboard (synchronous).
// Chromium's DataTransfer often mangles file copies (hollow stubs, missing
// uri-list); the Electron clipboard API sees the raw desktop formats — KDE,
// GNOME and plain-text variants alike. Only EXISTING files are returned.
ipcMain.on('clipboard:file-paths', (e) => {
  try {
    const parse = (s) => String(s || '').split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('file://'))
      .map(l => { try { return decodeURIComponent(l.replace(/^file:\/\//, '')); } catch (_) { return null; } })
      .filter(Boolean);
    const formats = clipboard.availableFormats();
    let out = [];
    if (formats.includes('text/uri-list')) out = parse(clipboard.readBuffer('text/uri-list').toString('utf8'));
    if (!out.length && formats.includes('x-special/gnome-copied-files')) out = parse(clipboard.readBuffer('x-special/gnome-copied-files').toString('utf8'));
    if (!out.length) {
      const t = clipboard.readText();
      const lines = String(t || '').split('\n').map(l => l.trim()).filter(Boolean);
      if (lines.length && lines.every(l => l.startsWith('file://'))) out = parse(t);
    }
    // Wayland fallback: the app runs on XWayland and KDE's clipboard bridge
    // can silently fail — files copied in Wayland-native apps (Dolphin) never
    // reach the X11 selection Electron reads. wl-paste reads the Wayland
    // clipboard directly.
    if (!out.length) {
      try {
        const { execFileSync } = require('child_process');
        const uris = execFileSync('wl-paste', ['-t', 'text/uri-list'], { timeout: 2000 }).toString('utf8');
        out = parse(uris);
      } catch (_) { /* wl-paste missing or clipboard not uri-list */ }
    }
    e.returnValue = out.filter(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  } catch (_) { e.returnValue = []; }
});

// Reveal an attachment in the system file manager (right-click → "Apri percorso").
ipcMain.handle('attachment:showInFolder', async (_, name) => {
  const fullPath = path.resolve(ATTACHMENTS_DIR, String(name || ''));
  if (!fullPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) throw new Error('Invalid path');
  shell.showItemInFolder(encDisk(fullPath));   // reveal the real on-disk file
  return true;
});

// Open an attachment with the system default app (e.g. the media player for
// codecs the embedded Chromium cannot decode — H.264/AAC are not bundled).
ipcMain.handle('attachment:openFile', async (_, name) => {
  const fullPath = path.resolve(ATTACHMENTS_DIR, String(name || ''));
  if (!fullPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) throw new Error('Invalid path');
  openAttachmentExternally(encDisk(fullPath));
  return true;
});

ipcMain.handle('attachment:readBinary', async (_, name) => {
  // Attachments can live in subfolders (pdf/, scripts/): resolve the relative
  // path but never allow escaping ATTACHMENTS_DIR.
  const fullPath = path.resolve(ATTACHMENTS_DIR, String(name || ''));
  if (!fullPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) throw new Error('Invalid path');
  // Return raw bytes — IPC clones them as transferable binary, much faster
  // than the base64 roundtrip for large files (PDFs). Decrypt encrypted
  // attachments on the fly so the renderer always gets plaintext.
  const _disk = encDisk(fullPath);
  _assertRealInside(ATTACHMENTS_DIR, _disk);   // reject a symlink escaping the vault
  let buf = fs.readFileSync(_disk);
  if (ENCRYPTION_KEY && bufIsEncryptedAttachment(buf)) {
    buf = decryptAttachmentBuffer(buf, ENCRYPTION_KEY);
  }
  return buf;
});

// PDF editor: bake annotations into the PDF and save it back in place.
// The renderer sends annotations in PDF point coordinates (origin bottom-left);
// pdf-lib draws them, then we overwrite the file (re-encrypting if needed).
function _hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 0.9, g: 0.28, b: 0.3 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}
// Resolve symlinks and confirm the real target is still inside `baseDir`. The
// other guards validate only the path TEXT; because the vault SYNCS (SMB/WebDAV)
// and imports from Obsidian, a note/attachment on disk could be a SYMLINK
// pointing outside the vault (e.g. ~/.ssh/id_rsa) — reading/serving/opening it
// would leak the target. Call on the on-disk path right before touching it.
// Throws on escape (or if the file is missing — callers already handle that).
function _assertRealInside(baseDir, onDiskPath) {
  let realBase;
  try { realBase = fs.realpathSync(baseDir); } catch (_) { realBase = path.resolve(baseDir); }
  const real = fs.realpathSync(onDiskPath);
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error('Invalid path (symlink escape)');
  return real;
}

// Resolve a relative attachment name to a safe absolute path under ATTACHMENTS_DIR.
function _safeAttachmentPath(name) {
  const fullPath = path.resolve(ATTACHMENTS_DIR, String(name || ''));
  if (!fullPath.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) throw new Error('Invalid path');
  return fullPath;
}

// Write a baked (plaintext) PDF buffer to disk, re-encrypting if the vault is
// encrypted, via an atomic tmp+rename. Triggers a sync.
function _writeBakedPdf(fullPath, plainBuf) {
  // fullPath is the LOGICAL path; writeAttachmentFile targets <path>.enc when
  // encrypted (atomic tmp+rename) and clears the stale sibling form.
  writeAttachmentFile(fullPath, plainBuf);
  if (syncManager) syncManager.scheduleSync();
}

// Strip a trailing " (N)" or " (edited)" / " (edited 2)" group from a file stem
// so repeated "save as" doesn't stack suffixes. Handles the localized copy words
// from any language plus the current `suffix`, and bare numbers.
function _baseAttachmentStem(stem, suffix) {
  const words = new Set(['copy', 'edited', 'modificato', 'modifié', 'modifie',
    'bearbeitet', 'editado', 'edytowany', 'editat']);
  if (suffix) words.add(String(suffix).toLowerCase().trim());
  const strippable = (inner) => {
    inner = inner.trim().toLowerCase();
    if (/^\d+$/.test(inner)) return true;                 // "(3)"
    for (const w of words) {
      if (!w) continue;
      if (inner === w) return true;                       // "(edited)"
      if (inner.startsWith(w + ' ') && /^\d+$/.test(inner.slice(w.length + 1).trim()))
        return true;                                      // "(edited 2)"
    }
    return false;
  };
  let s = String(stem);
  for (;;) {
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(s);
    if (m && strippable(m[2])) { s = m[1].trim(); continue; }
    break;
  }
  return s || String(stem);
}

// Build a collision-free sibling name with a simple numeric suffix:
// "<base> (1).pdf", "<base> (2).pdf", … (base = stem with any prior suffix removed).
function _siblingAttachmentName(srcRel, suffix) {
  srcRel = String(srcRel || '');
  const dir = (path.dirname(srcRel) === '.' ? '' : path.dirname(srcRel) + '/');
  const ext = path.extname(srcRel) || '.pdf';
  const stem = _baseAttachmentStem(path.basename(srcRel, ext), suffix);
  let rel, n = 1;
  do {
    rel = `${dir}${stem} (${n})${ext}`;
    n++;
  } while (attachmentTaken(_safeAttachmentPath(rel)));
  return rel;
}

// Like _siblingAttachmentName but actually EMBEDS a label word in the name,
// e.g. "report" + "compresso" → "report compresso.pdf" (then " (2)" on clash).
// Strips any prior trailing label so re-compressing doesn't stack the word.
function _labeledSiblingName(srcRel, label) {
  srcRel = String(srcRel || '');
  const dir = (path.dirname(srcRel) === '.' ? '' : path.dirname(srcRel) + '/');
  const ext = path.extname(srcRel) || '.pdf';
  const lbl = String(label || '').trim() || 'compressed';
  let base = _baseAttachmentStem(path.basename(srcRel, ext), lbl);   // drops "(n)"/"(edited)"
  const bareRe = new RegExp('\\s+' + lbl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  base = (base.replace(bareRe, '').trim()) || base;                  // drop a trailing bare label
  const stem = `${base} ${lbl}`;
  let rel = `${dir}${stem}${ext}`, n = 2;
  while (attachmentTaken(_safeAttachmentPath(rel))) { rel = `${dir}${stem} (${n})${ext}`; n++; }
  return rel;
}

// Load the source PDF (decrypting first), draw the annotations onto it and
// return the baked PDF bytes (plaintext). Throws 'ENCRYPTED_PDF' for PDFs that
// carry their own encryption (see note below) — the caller leaves files alone.
async function _bakePdfToBuffer(name, annots, formB64) {
  // Source bytes: either a form-filled buffer from the renderer (pdf.js
  // saveDocument output, already plaintext) or the on-disk file (decrypted).
  let buf;
  if (formB64) {
    buf = Buffer.from(String(formB64), 'base64');
  } else {
    const onDisk = encDisk(_safeAttachmentPath(name));
    if (!fs.existsSync(onDisk)) throw new Error('Attachment not found');
    buf = fs.readFileSync(onDisk);
    if (ENCRYPTION_KEY && bufIsEncryptedAttachment(buf)) buf = decryptAttachmentBuffer(buf, ENCRYPTION_KEY);
  }

  const { PDFDocument, rgb, LineCapStyle, StandardFonts, degrees } = require('pdf-lib');
  // NEVER pass ignoreEncryption:true here. For a PDF that carries its OWN
  // encryption dictionary, pdf-lib loads the structure but cannot decrypt the
  // content streams — re-saving then writes those still-encrypted streams with
  // no encryption dict, producing a file no viewer can open. Better to refuse
  // the save with a clear message and leave the original file untouched.
  let doc;
  try {
    doc = await PDFDocument.load(buf);
  } catch (e) {
    if (e && /encrypt/i.test(e.message || '')) {
      // Stable marker — the renderer maps it to a localized message.
      throw new Error('ENCRYPTED_PDF');
    }
    throw e;
  }
  const pages = doc.getPages();
  const fin = (...ns) => ns.every(n => Number.isFinite(n));
  // Helvetica (a StandardFont) can only encode WinAnsi/CP1252; any other code
  // point (emoji, arrows, CJK…) makes drawText throw. Map those to '?' so one
  // stray glyph never aborts the whole save.
  const winAnsiSafe = (s) => s.replace(
    /[^\x00-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g,
    '?');
  // Text-box fonts: map the renderer's font id (see PDF_FONTS in app.js) to a
  // pdf-lib StandardFont, embedding each at most once. Base-14 fonts render in
  // every viewer with no font file to bundle.
  const _FONT_STD = {
    Helvetica:            StandardFonts.Helvetica,
    HelveticaBold:        StandardFonts.HelveticaBold,
    HelveticaOblique:     StandardFonts.HelveticaOblique,
    HelveticaBoldOblique: StandardFonts.HelveticaBoldOblique,
    Times:                StandardFonts.TimesRoman,
    TimesBold:            StandardFonts.TimesRomanBold,
    TimesItalic:          StandardFonts.TimesRomanItalic,
    TimesBoldItalic:      StandardFonts.TimesRomanBoldItalic,
    Courier:              StandardFonts.Courier,
    CourierBold:          StandardFonts.CourierBold,
    CourierOblique:       StandardFonts.CourierOblique,
    CourierBoldOblique:   StandardFonts.CourierBoldOblique,
  };
  const _fontCache = {};
  const embedPdfFont = async (id) => {
    const key = _FONT_STD[id] ? id : 'Helvetica';
    if (!_fontCache[key]) _fontCache[key] = await doc.embedFont(_FONT_STD[key]);
    return _fontCache[key];
  };
  for (const a of (annots || [])) {
    try {
      const pg = pages[(a.page | 0) - 1];
      if (!pg) continue;

      // Rotation-aware placement. The editor overlay uses pdf.js's ROTATED view
      // (a /Rotate page is displayed upright-rotated), but pdf-lib draws in the
      // UNROTATED page space. Without this, annotations on a rotated page land
      // wildly off (cut-off image, invisible text). Map the annotation's displayed
      // coords (dxLeft from left, dyBottom from bottom) back to page space, and
      // counter-rotate the drawn content. `toPage` verified against pdf.js
      // viewport.convertToPdfPoint (R=270). For R=0 it's the identity.
      const _R = ((pg.getRotation().angle % 360) + 360) % 360;
      const { width: _Wp, height: _Hp } = pg.getSize();
      const _Hd = (_R === 90 || _R === 270) ? _Wp : _Hp;   // displayed page height
      const toPage = (dxLeft, dyBottom) => {
        const cx = dxLeft, cy = _Hd - dyBottom;            // → top-left displayed
        switch (_R) {
          case 90:  return [cy, cx];
          case 180: return [_Wp - cx, cy];
          case 270: return [_Wp - cy, _Hp - cx];
          default:  return [cx, _Hp - cy];                 // R = 0
        }
      };
      const _rot = degrees(_R);

      if (a.type === 'text') {
        const txt = String(a.text || '').replace(/\r/g, '');
        if (!txt.trim() || !fin(+a.x, +a.y)) continue;
        const font = await embedPdfFont(a.font);
        const c = _hexToRgb01(a.color);
        const size = Math.max(1, +a.size || 14);
        const lineH = size * 1.2;
        const ascent = size * 0.82;   // CSS line-box top → glyph baseline (line-height 1.2)
        txt.split('\n').forEach((line, li) => {
          if (!line) return;
          const [px, py] = toPage(+a.x, +a.y - ascent - li * lineH);
          pg.drawText(winAnsiSafe(line), {
            x: px, y: py,
            size, font, color: rgb(c.r, c.g, c.b), rotate: _rot,
          });
        });
        continue;
      }

      if (a.type === 'image') {
        if (!a.dataB64 || !fin(+a.x, +a.y, +a.w, +a.h) || +a.w <= 0 || +a.h <= 0) continue;
        const bytes = Buffer.from(a.dataB64, 'base64');
        const emb = /png/i.test(a.mime || '') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const [ix, iy] = toPage(+a.x, +a.y - +a.h);
        pg.drawImage(emb, { x: ix, y: iy, width: +a.w, height: +a.h, rotate: _rot });
        continue;
      }

      if (!Array.isArray(a.points) || a.points.length < 2) continue;
      const c = _hexToRgb01(a.color);
      const color = rgb(c.r, c.g, c.b);
      const thickness = Math.max(0.2, +a.width || 2);
      const opacity = a.type === 'highlight' ? 0.4 : 1;
      for (let k = 1; k < a.points.length; k++) {
        const p0 = a.points[k - 1], p1 = a.points[k];
        if (!fin(p0[0], p0[1], p1[0], p1[1])) continue;
        const [sx, sy] = toPage(p0[0], p0[1]);
        const [ex, ey] = toPage(p1[0], p1[1]);
        pg.drawLine({
          start: { x: sx, y: sy }, end: { x: ex, y: ey },
          thickness, color, opacity, lineCap: LineCapStyle.Round,
        });
      }
    } catch (e) {
      // One malformed annotation must never corrupt the whole save.
      console.error('bake: annotation skipped', a && a.type, e && e.message);
    }
  }
  return Buffer.from(await doc.save());
}

// Bake annotations back into the SAME file (overwrites the original).
ipcMain.handle('pdf:bakeAnnotations', async (_, name, annots, formB64) => {
  const out = await _bakePdfToBuffer(name, annots, formB64);
  _writeBakedPdf(_safeAttachmentPath(name), out);
  return { ok: true };
});

// Bake annotations into a NEW sibling file, leaving the original untouched.
// `suffix` is a localized word from the renderer (e.g. "modificato"/"edited").
ipcMain.handle('pdf:bakeAnnotationsAsNew', async (_, name, annots, suffix, formB64) => {
  const out = await _bakePdfToBuffer(name, annots, formB64);
  const rel = _siblingAttachmentName(name, suffix);
  _writeBakedPdf(_safeAttachmentPath(rel), out);
  return { ok: true, name: rel };
});

// Form fill: write the renderer's already-filled PDF bytes (pdf.js
// saveDocument output, base64) straight back, re-encrypting if needed. No
// pdf-lib roundtrip — saveDocument already produced a complete, valid PDF.
ipcMain.handle('pdf:savePdfBytes', async (_, name, b64) => {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new Error('Empty PDF buffer');
  _writeBakedPdf(_safeAttachmentPath(name), buf);
  return { ok: true };
});

ipcMain.handle('pdf:savePdfBytesAsNew', async (_, name, b64, suffix) => {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (!buf.length) throw new Error('Empty PDF buffer');
  const rel = _siblingAttachmentName(name, suffix);
  _writeBakedPdf(_safeAttachmentPath(rel), buf);
  return { ok: true, name: rel };
});

// Compress a PDF IN PLACE via Ghostscript (downsamples/recompresses images —
// lossy). level → gs -dPDFSETTINGS preset: 'screen' (~72dpi, smallest),
// 'ebook' (~150dpi, balanced), 'printer' (~300dpi, high quality). Reads +
// decrypts the current bytes, runs gs on a temp file, and overwrites the
// original ONLY if the result is a valid, actually-smaller PDF. Returns
// {ok, before, after} on success, or {ok:false, error} where error is
// 'NO_GS' (Ghostscript missing), 'NO_GAIN' (already optimal), 'NOT_FOUND',
// 'FAIL'. The plaintext temp copy is deleted in `finally`.
// Debug: append CM-engine trace lines to a file we can read from outside.
ipcMain.handle('debug:cmlog', (_, text) => {
  try { fs.appendFileSync('/tmp/amelie-cm-debug.log', String(text) + '\n'); } catch (_) {}
});

ipcMain.handle('pdf:compress', async (_, name, level, label) => {
  const preset = ({ screen: 'screen', ebook: 'ebook', printer: 'printer' })[level] || 'ebook';
  const onDisk = encDisk(_safeAttachmentPath(name));
  if (!fs.existsSync(onDisk)) return { ok: false, error: 'NOT_FOUND' };
  let buf = fs.readFileSync(onDisk);
  if (ENCRYPTION_KEY && bufIsEncryptedAttachment(buf)) buf = decryptAttachmentBuffer(buf, ENCRYPTION_KEY);
  const before = buf.length;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-gs-'));
  const inPath = path.join(tmpDir, 'in.pdf');
  const outPath = path.join(tmpDir, 'out.pdf');
  try {
    fs.writeFileSync(inPath, buf, { mode: 0o600 });
    try {
      // ASYNC exec (not execFileSync): Ghostscript can take several seconds on a
      // big PDF — running it synchronously froze the whole app. _execFileP awaits
      // without blocking the main-process event loop, so the UI stays responsive.
      await _execFileP('gs', [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.4',
        `-dPDFSETTINGS=/${preset}`,
        '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER',
        '-dDetectDuplicateImages=true', '-dCompressFonts=true',
        `-sOutputFile=${outPath}`, inPath,
      ], { timeout: 120000 });
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: false, error: 'NO_GS' };
      console.error('pdf compress: gs failed', e && e.message);
      return { ok: false, error: 'FAIL' };
    }
    if (!fs.existsSync(outPath)) return { ok: false, error: 'FAIL' };
    const outBuf = fs.readFileSync(outPath);
    const after = outBuf.length;
    // Guard: gs must have produced a real, non-trivial PDF. Never overwrite with garbage.
    if (after < 100 || outBuf.slice(0, 5).toString('latin1') !== '%PDF-') return { ok: false, error: 'FAIL' };
    // Always produce the file at the level the user explicitly chose (Balanced /
    // High quality / Maximum) — even if it doesn't shrink (an already-compressed
    // file re-rendered at the same level yields ~the same size). The renderer
    // reports the real before→after so "no saving" is shown honestly.
    // Write to a NEW sibling file (…"compresso".pdf), leaving the original intact.
    const rel = _labeledSiblingName(name, label);
    _writeBakedPdf(_safeAttachmentPath(rel), outBuf);
    return { ok: true, before, after, name: rel };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// Pick a PDF from disk to merge into the open one. Returns its raw bytes
// (base64) so the renderer can preview its pages; merged on apply.
ipcMain.handle('pdf:pickPdf', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const bytes = fs.readFileSync(result.filePaths[0]);
  return { dataB64: bytes.toString('base64') };
});

// Rebuild the PDF from a page "plan": an ordered list of {src, i, rot}, where
// src is 'main' (the open file, decrypted from disk) or a key in `sources`
// (base64 bytes of a merged PDF). Each page is copied in order with its extra
// rotation applied. Returns the rebuilt PDF bytes (plaintext).
async function _buildPlannedPdf(name, plan, sources) {
  const onDisk = encDisk(_safeAttachmentPath(name));
  if (!fs.existsSync(onDisk)) throw new Error('Attachment not found');
  let buf = fs.readFileSync(onDisk);
  if (ENCRYPTION_KEY && bufIsEncryptedAttachment(buf)) buf = decryptAttachmentBuffer(buf, ENCRYPTION_KEY);

  const { PDFDocument, degrees } = require('pdf-lib');
  // Same rule as the annotation bake: never ignoreEncryption — a self-encrypted
  // PDF would re-save with undecrypted streams and become unopenable.
  const loadDoc = async (b) => {
    try { return await PDFDocument.load(b); }
    catch (e) { if (e && /encrypt/i.test(e.message || '')) throw new Error('ENCRYPTED_PDF'); throw e; }
  };

  const docs = { main: await loadDoc(buf) };
  for (const [k, b64] of Object.entries(sources || {})) {
    docs[k] = await loadDoc(Buffer.from(String(b64), 'base64'));
  }

  const plan2 = Array.isArray(plan) ? plan : [];
  if (!plan2.length) throw new Error('EMPTY_PLAN');

  const out = await PDFDocument.create();
  // Batch-copy each source's pages once (each page index is unique per source),
  // so shared resources aren't duplicated per page.
  const copied = {};
  for (const src of Object.keys(docs)) {
    const idxs = [...new Set(
      plan2.filter(e => e.src === src)
        .map(e => e.i | 0)
        .filter(i => i >= 0 && i < docs[src].getPageCount())
    )];
    copied[src] = {};
    if (!idxs.length) continue;
    const pgs = await out.copyPages(docs[src], idxs);
    idxs.forEach((i, k) => { copied[src][i] = pgs[k]; });
  }

  for (const entry of plan2) {
    const pg = copied[entry.src]?.[entry.i | 0];
    if (!pg) continue;
    const add = (((Number(entry.rot) || 0) % 360) + 360) % 360;
    if (add) {
      const cur = (pg.getRotation && pg.getRotation().angle) || 0;
      pg.setRotation(degrees((cur + add) % 360));
    }
    out.addPage(pg);
  }
  if (out.getPageCount() === 0) throw new Error('EMPTY_PLAN');
  return Buffer.from(await out.save());
}

// Apply page operations: in place, or as a new sibling file when opts.asNew.
ipcMain.handle('pdf:applyPageOps', async (_, name, plan, sources, opts) => {
  const out = await _buildPlannedPdf(name, plan, sources);
  if (opts && opts.asNew) {
    const rel = _siblingAttachmentName(name, opts.suffix);
    _writeBakedPdf(_safeAttachmentPath(rel), out);
    return { ok: true, name: rel };
  }
  _writeBakedPdf(_safeAttachmentPath(name), out);
  return { ok: true };
});

// PDF editor: pick an image from disk to drop onto a page. Returns the raw
// bytes (base64) + mime so the renderer can preview it; baked in on save.
ipcMain.handle('pdf:pickImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const p = result.filePaths[0];
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  const bytes = fs.readFileSync(p);
  return { mime, dataB64: bytes.toString('base64') };
});

// Open file dialog, copy to images dir with readable name
ipcMain.handle('attachment:openDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'All Files', extensions: ['*'] }, { name: 'Images', extensions: ['jpg','jpeg','png','gif','webp','svg'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'Video', extensions: ['mp4','mkv','mov','avi','webm'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const srcPath = result.filePaths[0];
  const ext = path.extname(srcPath);
  const base = path.basename(srcPath, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40) || 'image';

  let finalName = base + ext;
  let c = 1;
  while (attachmentTaken(path.join(ATTACHMENTS_DIR, finalName))) {
    finalName = `${base}-${c}${ext}`;
    c++;
  }
  // Encrypt at rest (name gets .enc) when the vault is unlocked; plaintext otherwise.
  writeAttachmentFile(path.join(ATTACHMENTS_DIR, finalName), fs.readFileSync(srcPath));
  return finalName;   // LOGICAL name (no .enc)
});

// ── Remove unused media ──────────────────────────────────────────────────────
// Delete images/videos/audio in attachments/ that NO note links to. `apply=false`
// only reports what WOULD be deleted (for a confirm dialog); `apply=true` deletes.
// SAFETY: if any note can't be read/decrypted we ABORT (throw) rather than risk
// deleting media referenced by a note we couldn't inspect.
// PDFs are NEVER swept — see the media matcher below for why.
const UNUSED_IMG_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;
ipcMain.handle('attachment:removeUnusedMedia', async (_, apply) => {
  if (!ATTACHMENTS_DIR || !fs.existsSync(ATTACHMENTS_DIR)) return { files: [], count: 0, bytes: 0 };

  // 1) Every `attachments/…` reference across all notes (.md + encrypted notes).
  const referenced = new Set();
  const walkNotes = (dir) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) { walkNotes(abs); continue; }
      // Scan notes AND drawings for references — a .draw could carry an external
      // attachments/ image, so include them to avoid deleting media a drawing uses.
      let encrypted = false;
      if (it.name.endsWith(ENC_EXT)) {
        if (!ENCRYPTION_KEY) throw new Error('locked'); // encrypted content but vault locked → abort
        encrypted = true;                                // covers encrypted notes AND .draw.enc
      } else if (!it.name.endsWith('.md') && !it.name.endsWith('.draw')) {
        continue;
      }
      let content;
      try {
        const raw = fs.readFileSync(abs, 'utf8');
        content = encrypted ? decryptContent(raw, ENCRYPTION_KEY) : raw;
      } catch (_) {
        throw new Error('unreadable'); // can't inspect a note → abort, don't delete
      }
      for (const ref of attachmentRefsIn(content)) referenced.add(ref);
    }
  };
  walkNotes(NOTES_DIR);

  // 2) Image + video + audio media in attachments/ (recursive — includes the
  //    media/ subfolders).
  //    PDFs are DELIBERATELY EXCLUDED. In Amelie a PDF is a document in its own
  //    right: you drop it in the vault, it shows up in the tree and you open it
  //    from there — it does not have to be embedded in a note to be in use. So
  //    "no note links to it" does NOT mean "unused", and sweeping PDFs deleted
  //    documents people were actively keeping. Only true note media (images,
  //    video, audio) is swept.
  const media = [];
  const walkMedia = (dir, rel) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) { walkMedia(path.join(dir, it.name), relPath); continue; }
      const logical = stripEnc(relPath); // logical rel path (strip .enc marker)
      if (!(UNUSED_IMG_RE.test(logical) || VIDEO_EXT_RE.test(logical) || AUDIO_EXT_RE.test(logical))) continue;
      media.push({ logical, abs: path.join(dir, it.name) });
    }
  };
  walkMedia(ATTACHMENTS_DIR, '');

  // 3) Unused = logical rel path referenced by no note.
  const unused = media.filter(f => !referenced.has(f.logical));
  let bytes = 0;
  const files = [];
  for (const f of unused) {
    try { bytes += fs.statSync(f.abs).size; } catch (_) {}
    files.push(f.logical);
    if (apply) { try { fs.rmSync(f.abs, { force: true }); } catch (_) {} }
  }
  if (apply && files.length && syncManager) syncManager.scheduleSync();
  return { files, count: files.length, bytes };
});

// Rename an image and return the new name; also patch all open notes
// A `file://` URL for a PLAINTEXT attachment, or null when the bytes on disk are
// ciphertext (only we can read those). This is what lets a player need no server at
// all: Chromium opens the file itself — the same thing Obsidian does, visible as a
// plain file descriptor on its process — and its own loader answers the ranged
// requests a seek is made of.
//
// Measured, because two other routes looked right and were not: streaming the file
// from this process through a custom protocol seeks in isolation but breaks the player
// in a real note (the renderer is busy colouring a long code block and the load is
// aborted), and `net.fetch(file://)` relayed through protocol.handle loads but cannot
// seek at all — currentTime stays at 0. A plain file:// URL seeks even with the main
// thread deliberately blocked for two seconds.
ipcMain.handle('attachment:localUrl', async (_, rel) => {
  try {
    if (!rel || !ATTACHMENTS_DIR) return null;
    const full = path.resolve(ATTACHMENTS_DIR, String(rel));
    if (!full.startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep)) return null;
    const onDisk = encDisk(full);                       // <name> or <name>.enc
    if (!fs.existsSync(onDisk)) return null;
    _assertRealInside(ATTACHMENTS_DIR, onDisk);         // no symlink out of the vault
    // Encrypted at rest → there is nothing at that path a player could read. Checked
    // on the BYTES, not on whether a key is loaded: a locked vault must not hand out a
    // path to ciphertext either.
    if (isEncryptedAttachment(onDisk)) return null;
    return pathToFileURL(onDisk).toString();
  } catch (_) { return null; }
});

ipcMain.handle('attachment:rename', async (_, oldName, newName) => {
  // Confine the SOURCE to ATTACHMENTS_DIR. oldName carries the subfolder prefix
  // and was previously unchecked, so `../../…` escaped the vault → arbitrary
  // file rename/move. (The destination is re-checked below, after finalName.)
  if (!path.resolve(ATTACHMENTS_DIR, String(oldName || '')).startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep))
    throw new Error('Invalid path');
  const ext = path.extname(oldName);
  // Preserve the attachment's subfolder (pdf/, media/, scripts/…) so renaming a PDF or
  // video keeps it in its folder instead of moving it to the attachments/ root.
  const dir = path.dirname(oldName);
  const subPrefix = (dir && dir !== '.') ? dir.replace(/\\/g, '/') + '/' : '';
  // Sanitize the STEM ONLY and keep the file's own extension. Sanitizing the whole
  // leaf turned the dot into an underscore, and since the result then no longer ended
  // in the extension it was appended again: the rename box is pre-filled with the full
  // name, so editing `clip.mp4` into `gain-summit.mp4` stored `gain-summit_mp4.mp4`.
  // Every rename made through the UI mangled the name that way. A rename never changes
  // the type either, so the ORIGINAL extension is the one that is kept.
  const inLeaf = path.basename(newName);
  const inExt = path.extname(inLeaf);
  const stem = inExt ? inLeaf.slice(0, -inExt.length) : inLeaf;
  const safeStem = stem.replace(/[^a-zA-Z0-9_\-]/g, '_') || 'file';

  // Avoid collisions (against both the plain and .enc on-disk forms)
  let finalName = subPrefix + safeStem + ext;
  let c = 1;
  while (attachmentTaken(path.join(ATTACHMENTS_DIR, finalName)) && finalName !== oldName) {
    finalName = subPrefix + `${safeStem}-${c}${ext}`;
    c++;
  }

  // Destination must also stay inside ATTACHMENTS_DIR (finalName keeps oldName's
  // subfolder prefix, which could carry `../`).
  if (!path.resolve(ATTACHMENTS_DIR, finalName).startsWith(path.resolve(ATTACHMENTS_DIR) + path.sep))
    throw new Error('Invalid path');
  // Rename the real on-disk file, preserving the .enc marker if it was encrypted.
  const oldDisk = encDisk(path.join(ATTACHMENTS_DIR, oldName));
  const newDisk = path.join(ATTACHMENTS_DIR, finalName) + (oldDisk.endsWith(ENC_EXT) ? ENC_EXT : '');
  fs.renameSync(oldDisk, newDisk);

  // Rewrite links in ALL notes via the shared helper: it is KEY-AWARE (rewrites
  // & re-encrypts .enc notes — the old patcher only touched plaintext .md, so on
  // an encrypted-at-rest vault every link to the renamed file went dead), does
  // LITERAL segment-aware replacement (the old global regex over-matched
  // substrings like thumb-img.png), handles URL-encoded names, and writes each
  // note atomically.
  try {
    _rewriteAttachmentLinksInNotes([{ oldLogical: oldName, newLogical: finalName }], ENCRYPTION_KEY);
  } catch (e) { console.error('[rename] link rewrite failed:', e.message); }
  if (syncManager) syncManager.scheduleSync();

  return finalName;
});

// (attachment:delete is registered above, with subfolder + path-escape guard.)

// ─── IPC: Config & Sync ─────────────────────────────────────────────────────

ipcMain.handle('config:read', async () => {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  // Decrypt SMB/WebDAV passwords for the renderer (settings UI shows them).
  return mapConfigSecrets(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), decSecret);
});

ipcMain.handle('config:write', async (_, config) => {
  writeConfig(config);
  if (syncManager) syncManager.reloadConfig(config);
  return true;
});

// Manual sidebar order. Stored as a PLAINTEXT dotfile INSIDE notes/ so it rides
// along with the note two-way sync (newest-wins) to every PC — the encryption
// walkers and listNotesRecursive ignore non-.md/.draw/.enc files, so it stays
// invisible in the tree and untouched by at-rest encryption. Holds only paths.
function treeOrderFile() { return NOTES_DIR ? path.join(NOTES_DIR, '.amelie-order.json') : null; }
ipcMain.handle('tree-order:read', async () => {
  try {
    const f = treeOrderFile();
    if (!f || !fs.existsSync(f)) return {};
    return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (_) { return {}; }
});
ipcMain.handle('tree-order:write', async (_, order) => {
  try {
    const f = treeOrderFile();
    if (!f) return false;
    fs.writeFileSync(f, JSON.stringify(order || {}, null, 2), 'utf8');
    if (syncManager) syncManager.scheduleSync();   // sync the order with the notes
    return true;
  } catch (e) { console.error('[tree-order] write failed:', e.message); return false; }
});

// Force a two-way sync (the toolbar Sync button).
ipcMain.handle('sync:triggerTwoway', async () => {
  if (syncManager) return syncManager.runTwoway({ manual: true });
  return { success: false, error: 'Sync manager not initialized' };
});

// The manual backup (the "Backup now" button in Settings → Backup). NOT forced:
// with nothing changed since the last successful copy there is nothing to write,
// and keepLast means writing it anyway would evict a real snapshot to make room
// for a duplicate. The run reports back that it skipped, and the button says so.
ipcMain.handle('sync:triggerBackup', async () => {
  if (syncManager) return syncManager.runBackup({ force: false, manual: true });
  return { success: false, error: 'Sync manager not initialized' };
});

ipcMain.handle('shell:showItemInFolder', async (_, relPath) => {
  // Attachments (PDFs/images) live at the VAULT ROOT (<vault>/attachments/…),
  // while notes/draws/folders live under <vault>/notes/. The tree gives an
  // attachment node a vault-root-relative path ("attachments/pdf/foo.pdf"), so
  // resolving it against NOTES_DIR would point at <vault>/notes/attachments/…
  // (nonexistent) → "open location" errored. Pick the base by prefix.
  const rel = String(relPath || '');
  const isAttachment = rel === 'attachments' || rel.startsWith('attachments/');
  const base = (isAttachment && VAULT_DIR) ? VAULT_DIR : NOTES_DIR;
  const fullPath = path.join(base, rel);
  // Confine to the vault before handing a path to the file manager: `rel` comes
  // from the renderer, so a `../` escape must not open an arbitrary directory.
  const _root = path.resolve(base);
  const _res = path.resolve(fullPath);
  if (_res !== _root && !_res.startsWith(_root + path.sep)) throw new Error('Invalid path');
  // Open the containing folder: for a folder the folder itself, for a note the
  // folder that contains it.
  let dir = fullPath;
  try { if (!fs.statSync(fullPath).isDirectory()) dir = path.dirname(fullPath); }
  catch (_) { dir = path.dirname(fullPath); }
  // Electron's shell.openPath / showItemInFolder silently no-op inside the
  // sandboxed AppImage on KDE/Wayland, so launch the system file manager
  // directly with xdg-open (verified working), falling back to Electron's shell.
  try {
    const { spawn } = require('child_process');
    spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) {
    try { const e = await shell.openPath(dir); if (e) shell.showItemInFolder(fullPath); }
    catch (_) { shell.showItemInFolder(fullPath); }
  }
  return true;
});

// Open an external URL with the system default browser. Accepts http(s)://
// and bare URLs (e.g. starting with www.) — those get a leading https:// added.
ipcMain.handle('shell:openExternal', async (_, url) => {
  if (typeof url !== 'string' || !url) return false;
  let target = url.trim();
  // Disallow non-web schemes for safety (file:, javascript:, etc.).
  if (/^[a-z][a-z0-9+.\-]*:/i.test(target)) {
    if (!/^https?:/i.test(target) && !/^mailto:/i.test(target)) return false;
  } else {
    target = 'https://' + target.replace(/^\/+/, '');
  }
  try { await shell.openExternal(target); return true; }
  catch { return false; }
});

// ─── IPC: Custom themes ─────────────────────────────────────────────────────
// Custom themes live in <app-data>/themes: one .css file per theme, which must
// define [data-theme="<file-name>"] { --variables }. On first open a commented
// template is created to copy/edit.
const THEMES_DIR = path.join(APP_HOME, 'themes');
// Body of a freshly created custom theme ("Add theme" button). The header and
// the commented built-in palette reference are added by _newThemeCss().
const _themeBlock = (id) => `[data-theme="${id}"] {
  --bg-0: #0d1117;        /* editor background */
  --bg-1: #161b22;        /* sidebar background */
  --bg-2: #1c2128;        /* panels, cards */
  --bg-3: #22272e;        /* hover */
  --bg-4: #2d333b;        /* buttons */
  --border: #30363d;       /* borders */
  --border-light: #3d444d; /* highlighted borders */
  --text-0: #e6edf3;       /* main text */
  --text-1: #8b949e;       /* secondary text */
  --text-2: #6e7681;       /* dimmed text */
  --text-3: #484f58;       /* very dimmed text */
  --accent: #3fb950;       /* accent color (links, selections) */
  --accent-dim: #238636;   /* dark accent */
  --accent-glow: rgba(63,185,80,0.12);
  --active-bg: rgba(63,185,80,0.10);
  --active-border: #3fb950;
  --red: #f85149;
  --green: #3fb950;
  --yellow: #d29922;
  /* Optional — headings & links (omit them to keep the app defaults) */
  --h1: #4ade80;           /* heading 1 */
  --h2: #34d399;           /* heading 2 */
  --h3: #2dd4bf;           /* heading 3 */
  --h4: #6ee7b7;           /* heading 4 */
  --link: #5b8def;         /* links & wiki-links */
}
`;

// Built-in theme palettes extracted from the app CSS (always in sync), as a
// fully commented-out reference appended to every new theme file.
function _builtinPalettesComment() {
  try {
    const appCss = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
    const keep = /--(bg|text|border|accent|active|red|green|yellow|h[1-4]|link)/;
    const blocks = [];
    const rootM = appCss.match(/:root\s*\{([^}]*)\}/);
    if (rootM) {
      const vars = rootM[1].split('\n').filter(l => keep.test(l)).join('\n');
      blocks.push('[data-theme="github-dark"] {\n' + vars + '\n}');
    }
    const re = /\[data-theme="([a-z0-9-]+)"\]\s*\{[^}]*\}/g;
    let m; while ((m = re.exec(appCss))) blocks.push(m[0]);
    return '\n/* ─── BUILT-IN palettes for reference (commented out) ──────────────\n\n'
      + blocks.join('\n\n') + '\n*/\n';
  } catch (_) { return ''; }
}

function _newThemeCss(id) {
  return `/* ───────────────────────────────────────────────────────────────
   Amelie — custom theme "${id}"
   Edit the colors below and save: reopen Amelie to see the changes.
   This file may hold SEVERAL [data-theme="…"] blocks — each block
   becomes its own theme card. The built-in palettes are at the
   bottom of the file (commented out) to copy colors from.
─────────────────────────────────────────────────────────────── */
${_themeBlock(id)}${_builtinPalettesComment()}`;
}

function ensureThemesDir() {
  if (!fs.existsSync(THEMES_DIR)) fs.mkdirSync(THEMES_DIR, { recursive: true });
  // One-shot migration: the folder used to hold generated template/reference
  // files; users edited or deleted them by accident (their content now ships
  // inside every file created by the "Add theme" button). Drop them all.
  for (const old of ['template-esempio.css', 'temi-integrati-riferimento.css',
                     'theme-template.css', 'builtin-themes-reference.css']) {
    try { fs.rmSync(path.join(THEMES_DIR, old), { force: true }); } catch (_) {}
  }
}

// Special files in the themes folder: never loaded as themes.
// Old Italian names kept for safety (in case a backup restores them).
const THEME_SPECIAL_FILES = ['theme-template.css', 'builtin-themes-reference.css',
                             'template-esempio.css', 'temi-integrati-riferimento.css'];

ipcMain.handle('themes:list', async () => {
  try {
    ensureThemesDir();
    return fs.readdirSync(THEMES_DIR)
      .filter(f => f.endsWith('.css') && !THEME_SPECIAL_FILES.includes(f))
      .flatMap(f => {
        let css = '';
        try { css = fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'); } catch (_) { return []; }
        // Safety: no tag closings inside the injected <style>.
        if (/<\s*\//.test(css)) return [];
        // A file may contain MULTIPLE [data-theme="x"] blocks: each block is its
        // own theme (card). Blocks inside /* */ comments don't count.
        const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
        const ids = [...new Set(
          [...noComments.matchAll(/\[data-theme="([a-zA-Z0-9_-]+)"\]/g)].map(m => m[1])
        )];
        if (!ids.length) {
          // No block: legacy fallback, the id is the file name.
          const id = f.replace(/\.css$/, '').replace(/[^a-zA-Z0-9_-]/g, '');
          return id ? [{ id, css, inject: css }] : [];
        }
        // One entry per block: `css` is the SINGLE block (for the card colors),
        // `inject` is the whole file, present only on the first entry (the <style>
        // must be injected only once per file).
        return ids.map((id, i) => {
          const m = noComments.match(new RegExp('\\[data-theme="' + id + '"\\]\\s*\\{[^}]*\\}'));
          return { id, css: m ? m[0] : css, inject: i === 0 ? css : '' };
        });
      });
  } catch (_) { return []; }
});

// "Add theme": create a ready-to-use my-theme-N.css (active block + commented
// built-in palettes) and open it in the system editor.
// Count distinct custom theme ids across all custom css files (for the cap).
function _customThemeCount() {
  try {
    const ids = new Set();
    for (const f of fs.readdirSync(THEMES_DIR)) {
      if (!f.endsWith('.css') || THEME_SPECIAL_FILES.includes(f)) continue;
      let css = '';
      try { css = fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'); } catch (_) { continue; }
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of noComments.matchAll(/\[data-theme="([a-zA-Z0-9_-]+)"\]/g)) ids.add(m[1]);
    }
    return ids.size;
  } catch (_) { return 0; }
}
const MAX_CUSTOM_THEMES = 10;

ipcMain.handle('themes:create', async () => {
  try {
    ensureThemesDir();
    if (_customThemeCount() >= MAX_CUSTOM_THEMES) return { ok: false, error: 'limit', limit: MAX_CUSTOM_THEMES };
    let n = 1, file;
    while (fs.existsSync(file = path.join(THEMES_DIR, `my-theme-${n}.css`))) n++;
    const id = `my-theme-${n}`;
    fs.writeFileSync(file, _newThemeCss(id), 'utf8');
    // Open in the system editor (skipped in diag runs: no desktop windows).
    if (process.env.AMELIE_TEST !== '1') shell.openPath(file).catch(() => {});
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Find the custom css file whose ACTIVE (non-commented) blocks include the id.
function _findThemeFile(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id || '')) return null;
  for (const f of fs.readdirSync(THEMES_DIR)) {
    if (!f.endsWith('.css') || THEME_SPECIAL_FILES.includes(f)) continue;
    const full = path.join(THEMES_DIR, f);
    let css = '';
    try { css = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
    const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    if (noComments.includes(`[data-theme="${id}"]`)) return full;
  }
  return null;
}

// "Edit theme": open the theme's css file in the system editor.
ipcMain.handle('themes:edit', async (_, id) => {
  try {
    ensureThemesDir();
    const full = _findThemeFile(id);
    if (!full) return { ok: false, error: 'not found' };
    if (process.env.AMELIE_TEST !== '1') shell.openPath(full).catch(() => {});
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// "Remove theme": delete the [data-theme="id"] block from whichever custom css
// file holds it; if the file has no other theme blocks, delete the file.
ipcMain.handle('themes:delete', async (_, id) => {
  try {
    ensureThemesDir();
    const full = _findThemeFile(id);
    if (!full) return { ok: false, error: 'not found' };
    const css = fs.readFileSync(full, 'utf8');
    const blockRe = new RegExp('\\[data-theme="' + id + '"\\]\\s*\\{[^}]*\\}\\n?', 'g');
    const remaining = css.replace(blockRe, '');
    // Other ACTIVE blocks left (comments don't count)? Keep the file.
    const noComments = remaining.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\[data-theme="/.test(noComments)) fs.writeFileSync(full, remaining, 'utf8');
    else fs.rmSync(full, { force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});


// ─── IPC: VPN with Samba ───────────────────────────────────────────────

/** Save uploaded .conf and return parsed info (no private key). */
/** A freshly imported VPN REPLACES the previous connection (one at a time): the
 * flags that drove the old tunnel must not auto-activate the new one — it has
 * no tested credentials yet, and NetworkManager would pop the OS "provide
 * secrets" dialog (and kill any transfer running on the old tunnel). The user
 * re-enables the flag after testing the new connection. */
function disableVpnFlagsAfterImport() {
  try {
    let vaultCfg = {};
    if (fs.existsSync(CONFIG_FILE)) vaultCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const s = vaultCfg.sync;
    if (!s) return;
    // The Samba data belonged to the REPLACED connection: wipe it too, so a
    // fresh import starts a fresh setup (nothing pre-populated from the past).
    if (s.vpn)    s.vpn    = { enabled: false };
    if (s.samba)  delete s.samba;
    if (s.twoway) { s.twoway.enabled = false; delete s.twoway.smb; }
    s.enabled = !!(s.webdav?.enabled || s.local?.enabled);
    writeConfig(vaultCfg);
    if (syncManager) syncManager.reloadConfig(vaultCfg);   // flag off → tunnel down
  } catch (_) {}
}

ipcMain.handle('wg:saveConf', async (_, confContent) => {
  try {
    const parsed = wgManager.saveConf(confContent);
    // (Re)create the NM connection from the .conf (no password) so it's ready —
    // but DON'T bring the tunnel up here. The tunnel activates only when the
    // backup/sync FLAG is toggled on (or briefly during a test). Importing must
    // not leave a tunnel connected.
    const nm = await wgManager.importToNetworkManager();
    disableVpnFlagsAfterImport();
    return { ok: true, parsed, nm };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

/** Compute which OPTIONAL network tools are missing, detect the distro, and
 * build the exact install command — from FIXED distro/package tables ONLY, with
 * zero caller input. SECURITY: `deps:install` recomputes the command here rather
 * than trusting one from the renderer; a renderer-supplied command handed to
 * pkexec would be arbitrary root code execution. Package names come only from
 * the PKG table below and are additionally validated before use. */
function _computeDepsStatus() {
  // OpenVPN NM plugin: a service/plugin file whose name contains "openvpn" under
  // one of NetworkManager's dirs. Search RECURSIVELY (a couple levels): on Ubuntu
  // the editor .so lives in a per-version subdir (…/NetworkManager/1.x.y/libnm-…-openvpn.so),
  // and the .name marker in a VPN/ subdir — a flat readdir misses both. We do NOT
  // fall back to the `openvpn` CLI: the base binary is not the NM plugin.
  const ovpnPlugin = (() => {
    const roots = ['/usr/lib/NetworkManager', '/usr/lib64/NetworkManager', '/usr/lib/x86_64-linux-gnu/NetworkManager', '/usr/libexec', '/etc/NetworkManager/VPN'];
    const hit = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
      for (const e of ents) {
        if (/openvpn/i.test(e.name)) return true;
        if (depth > 0 && e.isDirectory() && hit(path.join(dir, e.name), depth - 1)) return true;
      }
      return false;
    };
    return roots.some(r => hit(r, 2));
  })();
  let distro = '';
  try { const m = /^ID=(.+)$/m.exec(fs.readFileSync('/etc/os-release', 'utf8')); distro = (m ? m[1] : '').replace(/"/g, '').toLowerCase(); } catch (_) {}
  const fam = ['fedora', 'rhel', 'centos', 'rocky', 'almalinux'].includes(distro) ? 'fedora'
            : ['ubuntu', 'linuxmint', 'pop'].includes(distro) ? 'ubuntu'
            : ['debian'].includes(distro) ? 'debian'
            : ['arch', 'manjaro', 'endeavouros'].includes(distro) ? 'arch' : '';
  const mgr = fam === 'fedora' ? 'dnf' : (fam === 'ubuntu' || fam === 'debian') ? 'apt' : fam === 'arch' ? 'pacman' : '';
  // Samba sync no longer needs the system `smbclient` — Amelie bundles a static
  // SMB2/3 helper (amelie-smb). Only the OpenVPN NetworkManager plugin (a system
  // daemon that cannot be bundled) remains an optional dependency.
  const PKG = {
    openvpn:   { fedora: 'NetworkManager-openvpn', ubuntu: 'network-manager-openvpn-gnome', debian: 'network-manager-openvpn-gnome', arch: 'networkmanager-openvpn' },
  };
  const missing = [];
  if (!ovpnPlugin)       missing.push({ key: 'openvpn',   label: 'plugin OpenVPN (NetworkManager)', pkg: PKG.openvpn[fam] || '' });
  // pkg names come only from the PKG table; validate anyway as defense-in-depth
  // so nothing but a plain package token can ever reach the pkexec command.
  const pkgs = missing.map(m => m.pkg).filter(Boolean).filter(p => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(p));
  let installCmd = '';
  if (pkgs.length && mgr) {
    installCmd = mgr === 'dnf' ? `dnf install -y ${pkgs.join(' ')}`
               : mgr === 'apt' ? `apt-get update && apt-get install -y ${pkgs.join(' ')}`
               : mgr === 'pacman' ? `pacman -S --noconfirm ${pkgs.join(' ')}` : '';
  }
  return { distro, fam, mgr, missing, installCmd };
}

/** Check which OPTIONAL system tools Amelie's network features need are
 * present, detect the distro, and build the right install command. */
ipcMain.handle('deps:check', async () => {
  return { ok: true, ..._computeDepsStatus() };
});

/** Install missing packages via pkexec (GUI password prompt — no terminal).
 * SECURITY: the command is recomputed from fixed tables here — any argument
 * from the renderer is IGNORED. Trusting a caller-supplied command string would
 * be arbitrary root code execution through pkexec sh -c. */
ipcMain.handle('deps:install', async () => {
  const { installCmd } = _computeDepsStatus();
  if (!installCmd) return { ok: false, error: 'nessun comando di installazione' };
  const cp = require('child_process');
  const which = (c) => { try { cp.execFileSync('sh', ['-c', 'command -v ' + c], { stdio: 'ignore' }); return true; } catch { return false; } };
  if (!which('pkexec')) return { ok: false, error: 'pkexec non disponibile — installa i pacchetti manualmente' };
  try {
    await new Promise((resolve, reject) => {
      cp.execFile('pkexec', ['sh', '-c', installCmd], { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message || '').toString().trim())); else resolve();
      });
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/** Save + import an OpenVPN .ovpn (alternative to WireGuard — one VPN at a
 * time). Imports into NetworkManager with optional user/pass; does NOT bring it
 * up (the flag does). No sudo — NM/polkit authorizes the active session. */
ipcMain.handle('ovpn:saveConf', async (_, { content, username, password } = {}) => {
  try {
    if (!content || typeof content !== 'string') return { ok: false, error: 'contenuto .ovpn mancante' };
    const saved = wgManager.saveOvpn(content);
    // Identical .ovpn already imported → credentials-only update, no destructive
    // re-import (down+delete+import flaps an active VPN connection).
    const nm = await wgManager.importOvpnToNM({ username, password, skipIfImported: saved.unchanged });
    // Fresh import (NOT the unchanged-reuse path) → the flags must come off.
    if (nm.ok && !nm.unchanged) disableVpnFlagsAfterImport();
    return nm.ok ? { ok: true, nm } : { ok: false, error: nm.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Update user/pass on the imported OpenVPN connection without re-importing
 * (no NM connection churn, no VPN flap). */
ipcMain.handle('ovpn:updateCreds', async (_, { username, password } = {}) => {
  try {
    return await wgManager.updateOvpnCreds({ username, password });
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Remove the whole WireGuard backup setup: tear down + delete the NM
 * connection and the saved .conf (no password), then clear the Samba/WG sync
 * config from the vault settings so backup-via-WG is no longer configured. */
ipcMain.handle('wg:removeConf', async () => {
  try {
    const wg = await wgManager.removeAll();
    let vaultCfg = {};
    try { if (fs.existsSync(CONFIG_FILE)) vaultCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
    if (vaultCfg.sync) {
      // Drop the WG-backed Samba backup target (both shapes: sync.vpn holds the
      // WG/Samba backup config that wgSetupComplete() checks; sync.samba is the
      // SyncManager target written by saveSambaConfig).
      // Reset the WHOLE vpn block (not just smb): leftovers like peerIp /
      // wgConfig / remotePath would re-prefill the Samba IP/share fields on the
      // next settings open — after a Remove the form must be back to defaults.
      if (vaultCfg.sync.vpn) vaultCfg.sync.vpn = { enabled: false };
      if (vaultCfg.sync.samba) delete vaultCfg.sync.samba;
      // If the two-way sync was riding on the same WG+Samba link, disable it
      // and drop its connection too (same shared link — the Sync view must not
      // keep showing a "configured" summary for a removed connection).
      if (vaultCfg.sync.twoway) {
        vaultCfg.sync.twoway.enabled = false;
        vaultCfg.sync.twoway.useWireGuard = false;
        delete vaultCfg.sync.twoway.smb;
      }
      writeConfig(vaultCfg);
      if (syncManager) syncManager.reloadConfig(vaultCfg);
    }
    return { ok: true, wg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Partial removals (separate "Remove" buttons for VPN vs Samba) ─────────────
// Remove ONLY the VPN (tunnel + .conf), KEEP the Samba config (sync.samba /
// sync.twoway.smb). The Samba fields survive so the user can drop a new VPN.
ipcMain.handle('wg:removeVpnKeepSamba', async () => {
  try {
    const wg = await wgManager.removeAll();
    let cfg = {};
    try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
    if (cfg.sync) {
      if (cfg.sync.vpn) cfg.sync.vpn = { enabled: false };
      if (cfg.sync.twoway) cfg.sync.twoway.useWireGuard = false;
      // KEEP cfg.sync.samba and cfg.sync.twoway.smb
      writeConfig(cfg);
      if (syncManager) syncManager.reloadConfig(cfg);
    }
    return { ok: true, wg };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Remove ONLY the Samba config, KEEP the VPN. scope: 'backup' → sync.samba,
// 'sync' → sync.twoway.smb.
ipcMain.handle('wg:removeSambaOnly', async (_, scope) => {
  try {
    let cfg = {};
    try { if (fs.existsSync(CONFIG_FILE)) cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
    if (cfg.sync) {
      if (scope === 'sync') {
        if (cfg.sync.twoway) { delete cfg.sync.twoway.smb; cfg.sync.twoway.enabled = false; }
      } else {
        if (cfg.sync.samba) delete cfg.sync.samba;
      }
      writeConfig(cfg);
      if (syncManager) syncManager.reloadConfig(cfg);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/** Return parsed info from saved .conf (used on settings open). */
ipcMain.handle('wg:getConf', async () => {
  const parsed = wgManager.loadSavedConf();
  // ovpnExists: the OpenVPN config is SINGLE and shared between Backup and Sync —
  // both tabs need it to show "configuration already loaded". ovpnMeta carries
  // the saved username + hasPassword (never the password) for the credential UI.
  return { ok: true, exists: wgManager.confExists(), parsed, ovpnExists: wgManager.ovpnExists(), ovpnMeta: wgManager.ovpnMeta(), ovpnParsed: wgManager.ovpnExists() ? wgManager.ovpnParsed() : null };
});

// Full raw config text (WireGuard .conf / OpenVPN .ovpn) for the "Show config"
// view. Contains secrets (private key) — only returned to the local renderer.
ipcMain.handle('wg:getRawConf', async () => {
  return { ok: true, wg: wgManager.rawConf(), ovpn: wgManager.rawOvpn() };
});

/**
 * Live status of our tunnel. When up, ping the WireGuard GATEWAY derived from
 * the saved config (the tunnel subnet's .1, e.g. Address 10.100.0.5 → 10.100.0.1):
 * pinging the other end of the tunnel proves the handshake actually works. It's
 * config-driven, so it follows whatever WireGuard config you import. No root.
 */
ipcMain.handle('wg:status', async () => {
  // "up" = an Amelie NM WireGuard connection is active (or our own iface exists).
  const conn = await wgManager.nmActiveAmelie();
  const ifaceUp = await wgManager._ifaceExists();
  const up = !!conn || ifaceUp;
  const via = conn || (ifaceUp ? wgManager._ifaceName() : null);

  let smbIp = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    smbIp = cfg?.sync?.vpn?.smb?.ip || cfg?.sync?.vpn?.peerIp || null;
  } catch (_) {}

  let latency = null, target = null, reachable = false, direct = false;
  if (up) {
    try {
      wgManager.loadSavedConf();
      const addr = String(wgManager.parsedConf?.localIp || '').split('/')[0].trim();
      const gw = /^\d+\.\d+\.\d+\.\d+$/.test(addr) ? addr.replace(/\.\d+$/, '.1') : null;
      // Ping the tunnel gateway (config-derived) — proves the handshake works.
      if (gw) {
        const p = await wgManager._ping(gw, 1);
        if (p.ok) { reachable = true; latency = p.latency; target = gw; }
      }
    } catch (_) {}
  }
  // Share TCP check (works whether direct on the LAN or through the tunnel).
  // Gateways often block ICMP, so this is the most meaningful "can I back up?" signal.
  if (!reachable && smbIp) {
    try {
      if (await wgManager._hostReachable(smbIp, 445, 3000)) {
        reachable = true; target = smbIp; direct = !up;   // reachable without the tunnel
      }
    } catch (_) {}
  }
  return { exists: ifaceUp, up, via, target, reachable, latency, direct };
});

/**
 * Should the VPN tunnel stay up after a test? Yes whenever the backup VPN flag
 * or the two-way-sync WG flag is ON (same logic as SyncManager.ensureVpnTunnel:
 * the FLAG owns the tunnel lifecycle — a test must never leave it down while
 * the flag says up, nor leave it lingering while the flag says off).
 */
function vpnFlagWantsTunnelUp() {
  try {
    const s = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).sync || {};
    return !!(s.vpn?.enabled
      || (s.samba?.enabled && s.samba?.useWireGuard)
      || (s.twoway?.enabled && s.twoway?.useWireGuard));
  } catch (_) { return false; }
}

/** WireGuard test: bring the tunnel up via NetworkManager (NO password) and
 * check the share is reachable (:445) through it. host = the Samba server IP. */
ipcMain.handle('wg:testTunnel', async (_, { host } = {}) => {
  return await wgManager.testTunnel({ host, keepUp: vpnFlagWantsTunnelUp() });
});

/** Latest WireGuard handshake (passive read, no ping). */
ipcMain.handle('wg:handshake', async () => {
  return await wgManager.latestHandshake();
});

/** Minimal test: can we WRITE to the Samba share. keepUp follows the FLAG: with
 * the backup/sync flag ON the tunnel must stay up after the test (tearing it
 * down would break the scheduled backup and flap the VPN down/up); with the
 * flag OFF a tunnel brought up just for the test is torn back down. */
ipcMain.handle('wg:testSmbWrite', async (_, smbConfig, purpose) => {
  // Backup and Sync must use DIFFERENT folders. Besides the on-share marker
  // files (written on first run), refuse at TEST time a folder that matches
  // the one CONFIGURED for the other purpose — markers may not exist yet if
  // the other side never ran.
  let avoid = null;
  try {
    const vaultCfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
    const s = vaultCfg.sync || {};
    if (purpose === 'backup') {
      const t = s.twoway?.smb;
      if (t && t.share) avoid = { ip: t.ip || t.host, share: t.share, path: t.remoteSubPath ?? s.twoway?.subPath ?? '' };
    } else if (purpose === 'sync') {
      if (s.vpn?.smb?.share)   avoid = { ip: s.vpn.smb.ip, share: s.vpn.smb.share, path: s.vpn.smb.path || s.vpn.remotePath || '' };
      else if (s.samba?.share) avoid = { ip: s.samba.host, share: s.samba.share, path: s.samba.remoteSubPath || '' };
    }
  } catch (_) {}
  return await wgManager.testSmbWrite(smbConfig, { keepUp: vpnFlagWantsTunnelUp(), purpose, avoid });
});

/**
 * Save a WireGuard+Samba connection for TWO-WAY SYNC ONLY, without enabling any
 * backup. Stored under sync.twoway.smb so SyncManager's two-way engine can use
 * it independently. Config: { ip, share, path, username, password }
 */
ipcMain.handle('wg:saveSyncConnection', async (_, smbConfig) => {
  try {
    let vaultCfg = {};
    if (fs.existsSync(CONFIG_FILE)) vaultCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    vaultCfg.sync = vaultCfg.sync || {};
    vaultCfg.sync.twoway = vaultCfg.sync.twoway || {};
    // Do NOT touch useWireGuard/transport here. This handler saves a CONNECTION,
    // not a method: the Sync tab's method choice owns those two, and forcing the
    // flag turned a Samba (LAN) setup back into a VPN one the moment its share
    // fields were saved.
    vaultCfg.sync.twoway.smb = {
      host:          smbConfig.ip,
      ip:            smbConfig.ip,
      share:         smbConfig.share,
      remoteSubPath: smbConfig.path || '',
      username:      smbConfig.username,
      password:      smbConfig.password,
    };
    // NOTE: deliberately does NOT touch sync.samba / sync.enabled — syncing must
    // be usable without turning on the backup.
    writeConfig(vaultCfg);
    if (syncManager) syncManager.reloadConfig(vaultCfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** Complete WireGuard removal from the Sync view: the tunnel is a single shared
 * connection, so this fully tears it down (NM connection + .conf) and clears
 * BOTH the sync and the backup WG/Samba config — same effect as Remove in the
 * Backup tab, plus clearing the two-way connection. */
ipcMain.handle('wg:removeSyncConnection', async () => {
  try {
    const removedWg = await wgManager.removeAll();   // tunnel + .conf, always
    let vaultCfg = {};
    try { if (fs.existsSync(CONFIG_FILE)) vaultCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}
    if (vaultCfg.sync) {
      // Reset the WHOLE vpn block (see wg:removeConf): leftover peerIp/wgConfig
      // would re-prefill the Samba fields after a Remove + re-import.
      if (vaultCfg.sync.vpn) vaultCfg.sync.vpn = { enabled: false };
      if (vaultCfg.sync.samba) delete vaultCfg.sync.samba;
      if (vaultCfg.sync.twoway) {
        vaultCfg.sync.twoway.enabled = false;
        vaultCfg.sync.twoway.useWireGuard = false;
        delete vaultCfg.sync.twoway.smb;
      }
      writeConfig(vaultCfg);
      if (syncManager) syncManager.reloadConfig(vaultCfg);
    }
    return { ok: true, removedWg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Load saved WireGuard conf on startup
wgManager.loadSavedConf();

// Auto-create .desktop entry when running as AppImage (Linux desktop integration)
function autoCreateDesktopEntry() {
  const appimage = process.env.APPIMAGE;
  if (!appimage || process.platform !== 'linux') return;
  try {
    const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications');
    const desktopFile = path.join(desktopDir, 'amelie.desktop');
    // --appimage-extract-and-run: launch WITHOUT needing FUSE (libfuse2). Many
    // distros (Debian/Ubuntu recent, some minimal installs) don't ship libfuse2,
    // so a direct AppImage exec would fail to start from the menu. Extract-and-run
    // unpacks to a cached temp dir and runs — works on every Linux distro. Matches
    // the installer's `amelie` wrapper, so the menu entry never breaks after the
    // app self-heals this file.
    // Copy icon first so we can point Icon= at the ABSOLUTE path — bypasses the
    // icon-theme cache (which on some GNOME setups showed a stale/wrong icon in
    // search). Matches the installer's .desktop.
    const iconDir = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor', '256x256', 'apps');
    fs.mkdirSync(iconDir, { recursive: true });
    const iconSrc = path.join(__dirname, '../../assets/icon.png');
    const iconDst = path.join(iconDir, 'amelie.png');
    if (fs.existsSync(iconSrc)) { try { fs.copyFileSync(iconSrc, iconDst); } catch (_) {} }
    const iconRef = fs.existsSync(iconDst) ? iconDst : 'amelie';
    // When APPIMAGE points at an extracted AppRun (the installer unpacks once for
    // fast startup), drop --appimage-extract-and-run — that's an AppImage-runtime
    // flag; AppRun would just forward it to Chromium. Plain FUSE launch keeps it.
    const extractFlag = /AppRun$/.test(appimage) ? '' : '--appimage-extract-and-run ';
    const content = `[Desktop Entry]
Version=1.0
Type=Application
Name=Amelie
Exec=${appimage} ${extractFlag}--class=amelie %U
Icon=${iconRef}
Terminal=false
StartupNotify=false
Categories=Office;TextEditor;Utility;
Keywords=note;markdown;appunti;vault;
StartupWMClass=amelie
`;
    // Skip only if the file is already EXACTLY this — so template changes (e.g.
    // dropping the old "Note App" GenericName subtitle) self-heal on next launch.
    if (fs.existsSync(desktopFile) && fs.readFileSync(desktopFile, 'utf8') === content) return;
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(desktopFile, content, 'utf8');
    fs.chmodSync(desktopFile, 0o755);
  } catch(_) { /* desktop integration is optional */ }
}
autoCreateDesktopEntry();

// Keep the installed menu/launcher icon (hicolor theme) in sync with the
// bundled icon. Runs on every launch — including when started via the extracted
// squashfs wrapper (where APPIMAGE isn't set, so autoCreateDesktopEntry skips).
// Uses a content hash so it only rewrites + refreshes the cache when the icon
// actually changed.
function refreshInstalledIcon() {
  if (process.platform !== 'linux') return;
  try {
    const { nativeImage } = require('electron');
    const crypto = require('crypto');
    const resIcon = path.join(process.resourcesPath, 'icon.png');
    const iconSrc = fs.existsSync(resIcon) ? resIcon : path.join(__dirname, '../../assets/icon.png');
    if (!fs.existsSync(iconSrc)) return;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(iconSrc)).digest('hex');
    const hicolor = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor');
    const marker = path.join(os.homedir(), '.local', 'share', 'amelie', 'icon.hash');
    let prev = ''; try { prev = fs.readFileSync(marker, 'utf8'); } catch (_) {}
    const ref512 = path.join(hicolor, '512x512', 'apps', 'amelie.png');
    if (prev === hash && fs.existsSync(ref512)) return;   // already up to date
    const img = nativeImage.createFromPath(iconSrc);
    for (const sz of [48, 128, 256, 512]) {
      const dir = path.join(hicolor, `${sz}x${sz}`, 'apps');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'amelie.png'),
        img.resize({ width: sz, height: sz, quality: 'best' }).toPNG());
    }
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    try { fs.writeFileSync(marker, hash); } catch (_) {}
    // Best-effort cache refresh so the launcher picks up the new icon.
    const cp = require('child_process');
    try { cp.execFile('gtk-update-icon-cache', ['-f', '-t', hicolor], () => {}); } catch (_) {}
    try { cp.execFile('kbuildsycoca6', [], () => {}); } catch (_) {}
  } catch (_) { /* icon refresh is best-effort */ }
}
refreshInstalledIcon();

ipcMain.handle('sync:testLocalPath', async (_, localPath) => {
  try {
    if (!localPath) return { ok: false, error: 'Percorso vuoto' };
    let created = false;
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true });
      created = true;
    }
    fs.accessSync(localPath, fs.constants.R_OK | fs.constants.W_OK);
    // Quick write test
    const testFile = path.join(localPath, '.k7tz-test');
    fs.writeFileSync(testFile, 'ok');
    fs.unlinkSync(testFile);
    return { ok: true, created };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// WebDAV connection test — done HERE in main (Node), NOT in the renderer. A
// renderer fetch() to an external server is blocked by the CSP (default-src
// 'self', no connect-src) AND by CORS (file:// origin) → "Failed to fetch".
// Node has no such restriction. Mirrors the old PROPFIND: 207/200 = OK.
ipcMain.handle('sync:testWebdav', async (_, cfg = {}) => {
  const rawUrl = (cfg.url || '').trim();
  if (!rawUrl) return { ok: false, error: 'URL vuoto' };
  let u;
  try { u = new URL(rawUrl); } catch (_) { return { ok: false, error: 'URL non valido' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'URL deve iniziare con http:// o https://' };
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const headers = {
    'Content-Type': 'application/xml',
    'Depth': '0',
    'Content-Length': Buffer.byteLength('<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'),
  };
  if (cfg.username) headers['Authorization'] = 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
  return await new Promise((resolve) => {
    const req = lib.request({
      method: 'PROPFIND',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: 12000,
    }, (res) => {
      res.resume();   // drain
      const s = res.statusCode;
      if (s === 207 || s === 200) resolve({ ok: true, status: s });
      else if (s === 401 || s === 403) resolve({ ok: false, status: s, error: `Autenticazione fallita (${s}) — controlla utente/password` });
      else resolve({ ok: false, status: s, error: `Risposta ${s} ${res.statusMessage || ''}`.trim() });
    });
    req.on('timeout', () => { req.destroy(new Error('Timeout: il server non risponde')); });
    req.on('error', (e) => {
      let msg = e.message;
      if (e.code === 'ENOTFOUND') msg = 'Host non trovato (controlla l\'URL)';
      else if (e.code === 'ECONNREFUSED') msg = 'Connessione rifiutata (porta/servizio)';
      else if (e.code && /CERT|SELF_SIGNED|ALT_NAME/.test(e.code)) msg = 'Certificato TLS non valido: ' + e.code;
      resolve({ ok: false, error: msg });
    });
    req.end('<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>');
  });
});

// ─── IPC: Window Controls ───────────────────────────────────────────────────

ipcMain.on('window:minimize', () => mainWindow.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow.close());
ipcMain.on('vault:close', () => { if (vaultWindow) vaultWindow.close(); });

// Detached note windows: a standalone, natively-framed reading window for a
// single note, so the user can drag it onto another monitor. Native frame keeps
// move/resize/close simple and independent of the main window's controls.
const detachedWindows = new Set();
function openDetachedNoteWindow({ path: notePath, name, theme } = {}) {
  if (!notePath) return;
  const win = new BrowserWindow({
    width: 720, height: 820, minWidth: 360, minHeight: 300,
    backgroundColor: '#0d0d0f',
    title: name || 'Amelie',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: true,
      plugins: true,
    },
    icon: path.join(__dirname, '../../assets/icon.png'),
  });
  Menu.setApplicationMenu(null);
  // Same guards as the main window: clicking a web link must never navigate
  // this window away from the note, and no popups (target=_blank etc.).
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const q = new URLSearchParams({ path: notePath, name: name || '', theme: theme || '' });
  win.loadFile(path.join(__dirname, '../renderer/detached.html'), { search: q.toString() });
  detachedWindows.add(win);
  win.on('closed', () => detachedWindows.delete(win));
}
ipcMain.on('window:detach', (_evt, opts) => openDetachedNoteWindow(opts));

// The renderer tells us (synchronously, right before the native context menu
// pops) which note lives under the right-clicked pane, so the menu can offer
// "Open in new window" for the correct note. null = not over a note pane.
let _ctxNoteTarget = null;
ipcMain.on('ctx:set-note-target', (e, info) => {
  // Keep it when it names a note (path) OR just flags the editor (isEditor),
  // so the formatting menu shows even on an unsaved note.
  _ctxNoteTarget = (info && (info.path || info.isEditor)) ? info : null;
  e.returnValue = true;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

// Lightweight note count: recurses counting note files WITHOUT building the tree.
// (The old noteCount did `listNotesRecursive(NOTES_DIR).length` — a full tree of
// up-to-100k objects allocated just to read the top-level length, a big transient
// RAM/CPU spike at load. This allocates nothing but an integer, and counts the
// REAL total of notes — .md or, when unlocked, the encrypted <stem>.enc form.)
function countNotesRecursive(dir) {
  let n = 0, items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const it of items) {
    if (it.isDirectory()) {
      if (it.name === 'attachments') continue;
      n += countNotesRecursive(path.join(dir, it.name));
      continue;
    }
    const isDrawEnc = it.name.endsWith('.draw' + ENC_EXT) || it.name.endsWith('.draw' + LEGACY_ENC_EXT);
    const isEnc = ENCRYPTION_KEY && !isDrawEnc && (it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT));
    if (it.name.endsWith('.md') || isEnc) n++;
  }
  return n;
}

// ── Which folder does a media file belong to? ───────────────────────────────
// Every attachment lives in one flat place on disk (attachments/{videos,images,
// audio,pdf}/) and used to be listed only at the ROOT of the sidebar, so a vault
// with folders piled every recording, photo and PDF at the bottom of the tree,
// far from the notes they belong to. Nothing moves on disk — the sidebar now
// shows an attachment inside the folder whose notes link to it (in each of them
// when several do), and keeps at the root the ones nobody links.
//
// Reading every note on every tree refresh would be far too much work, so a
// note's links are cached against its size+mtime: after a save, exactly one
// note is read again.
const _noteLinkCache = new Map();   // note abs path → { mtimeMs, size, links }

function _noteAttachmentLinks(abs, stat, encrypted) {
  const hit = _noteLinkCache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.links;
  let links = new Set();
  try {
    const raw  = fs.readFileSync(abs, 'utf8');
    const body = (encrypted && ENCRYPTION_KEY) ? decryptContent(raw, ENCRYPTION_KEY) : raw;
    links = attachmentRefsIn(body);       // the one shared rule — see attachmentRefsIn
  } catch (_) { /* unreadable or still locked → no links → listed at the root */ }
  if (_noteLinkCache.size > 5000) _noteLinkCache.clear();   // renamed/deleted notes
  _noteLinkCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, links });
  return links;
}

// logical attachment name ('videos/clip.mp4') → the folders that link to it.
function _attachmentUsage() {
  const map = new Map();
  const walk = (dir, base) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (it.name === 'attachments' && !base) continue;
        walk(path.join(dir, it.name), base ? `${base}/${it.name}` : it.name);
        continue;
      }
      // Notes AND drawings, in both forms — a drawing embeds an attachments/
      // image too, and the same file test is what attachment:usedBy uses.
      const isEnc = it.name.endsWith(ENC_EXT) || it.name.endsWith(LEGACY_ENC_EXT);
      if (isEnc ? !ENCRYPTION_KEY
                : !(it.name.endsWith('.md') || it.name.endsWith('.draw'))) continue;
      const abs = path.join(dir, it.name);
      let stat; try { stat = fs.statSync(abs); } catch (_) { continue; }
      for (const rel of _noteAttachmentLinks(abs, stat, isEnc)) {
        let set = map.get(rel);
        if (!set) map.set(rel, set = new Set());
        set.add(base);
      }
    }
  };
  walk(NOTES_DIR, '');
  return map;
}

// folder rel path ('' = vault root) → the attachment nodes to list there.
// Built ONCE per tree walk and handed down the recursion.
function _attachmentPlacement() {
  const byFolder = new Map();
  const nodes = _collectAttachmentNodes();
  if (!nodes.length) return byFolder;                 // no attachments → don't read a single note
  const usage = _attachmentUsage();
  const add = (folder, node) => {
    let arr = byFolder.get(folder);
    if (!arr) byFolder.set(folder, arr = []);
    arr.push(node);
  };
  for (const node of nodes) {
    const folders = usage.get(node.attachmentName);
    if (!folders || !folders.size) { add('', node); continue; }
    // A file used from two folders is shown in both — same file behind each.
    let first = true;
    for (const f of folders) { add(f, first ? node : { ...node }); first = false; }
  }
  return byFolder;
}

function listNotesRecursive(dir, base = '', place = null) {
  if (!place) place = _attachmentPlacement();
  const entries = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const relPath = base ? `${base}/${item.name}` : item.name;
    if (item.isDirectory() && item.name === 'attachments' && !base) continue;
    if (item.isDirectory()) {
      entries.push({
        type: 'folder',
        name: item.name,
        path: relPath,
        children: listNotesRecursive(path.join(dir, item.name), relPath, place),
      });
    } else {
      // A note (.md) or draw (.draw) — and, when the vault is unlocked, the
      // encrypted form on disk is <stem>.enc (was <stem>.md). Present it to the
      // renderer under the SAME logical .md name so the tree looks identical
      // whether or not encryption is on (noteFilePath swaps .md<->.enc on read).
      let logicalName = null;
      if (item.name.endsWith('.md') || item.name.endsWith('.draw')) {
        logicalName = item.name;
      } else if (ENCRYPTION_KEY && item.name.endsWith('.draw' + ENC_EXT)) {
        logicalName = item.name.slice(0, -ENC_EXT.length);          // foo.draw.enc → foo.draw
      } else if (ENCRYPTION_KEY && item.name.endsWith(ENC_EXT)) {
        logicalName = item.name.slice(0, -ENC_EXT.length) + '.md';  // foo.enc → foo.md
      }
      if (logicalName) {
        const stat = fs.statSync(path.join(dir, item.name));
        const isDraw = logicalName.endsWith('.draw');
        const relLogical = base ? `${base}/${logicalName}` : logicalName;
        const fullPath = path.join(dir, item.name);
        entries.push({
          type: isDraw ? 'draw' : 'note',
          name: isDraw ? logicalName.replace('.draw', '') : logicalName.replace('.md', ''),
          path: relLogical,
          modified: stat.mtime.toISOString(),
          // Notes: created comes from the frontmatter (stable across the atomic
          // save's inode swap); draws/no-frontmatter fall back to the fs time.
          created: isDraw ? (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString()
                          : _noteCreatedISO(fullPath, stat),
          size: stat.size,
        });
      }
    }
  }
  for (const node of place.get(base) || []) entries.push(node);
  // Order: folders (alphabetical) → notes/draws (oldest → newest) → attachments
  // (PDFs, photos, audio, video — oldest → newest). Sorting notes/attachments by
  // creation time ascending means newly imported items land at the bottom.
  const ATTACH_KINDS = ['pdf', 'image', 'audio', 'video'];
  const rank = t => t === 'folder' ? 0 : ATTACH_KINDS.includes(t) ? 2 : 1;
  const ts = n => new Date(n.created || n.modified || 0).getTime();
  return entries.sort((a, b) => {
    const ra = rank(a.type), rb = rank(b.type);
    if (ra !== rb) return ra - rb;
    if (a.type === 'folder') return a.name.localeCompare(b.name);
    return ts(a) - ts(b);
  });
}

// Every attachment in the vault, as sidebar nodes. Where each one is SHOWN is
// _attachmentPlacement's business; this only says what exists.
function _collectAttachmentNodes() {
  const entries = [];
  if (!ATTACHMENTS_DIR) return entries;
  {
    // PDFs: new ones go to attachments/pdf/; legacy ones sit at the attachments
    // root and keep working — both locations are scanned.
    const attachDir = ATTACHMENTS_DIR;   // <vault>/attachments
    const pdfSources = [
      { dir: attachDir, sub: '' },
      { dir: path.join(attachDir, 'pdf'), sub: 'pdf/' },
    ];
    for (const src of pdfSources) {
      if (!fs.existsSync(src.dir)) continue;
      for (const item of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (!item.isFile() || isOwnTempOrHidden(item.name)) continue;
        const logical = stripEnc(item.name);   // drop the at-rest .enc marker
        if (!logical.toLowerCase().endsWith('.pdf')) continue;
        const stat = fs.statSync(path.join(src.dir, item.name));
        entries.push({
          type: 'pdf',
          name: logical,
          path: `attachments/${src.sub}${logical}`,
          attachmentName: `${src.sub}${logical}`,
          modified: stat.mtime.toISOString(),
          created: (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString(),
          size: stat.size,
        });
      }
    }
    // Photos dropped on the sidebar live in attachments/images/ and are
    // surfaced as nodes like PDFs (note-embedded images at the attachments
    // root are NOT listed — they belong to their notes).
    const imgDir = path.join(attachDir, 'images');
    if (fs.existsSync(imgDir)) {
      for (const item of fs.readdirSync(imgDir, { withFileTypes: true })) {
        if (!item.isFile() || isOwnTempOrHidden(item.name)) continue;
        const logical = stripEnc(item.name);   // drop the at-rest .enc marker
        if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(logical)) continue;
        const stat = fs.statSync(path.join(imgDir, item.name));
        entries.push({
          type: 'image',
          name: logical,
          path: `attachments/images/${logical}`,
          attachmentName: `images/${logical}`,
          modified: stat.mtime.toISOString(),
          created: (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString(),
          size: stat.size,
        });
      }
    }
    // Audio and video, surfaced like the PDFs and photos above: they were on disk
    // and playable inside a note, but invisible in the tree — so there was no way
    // to reach a recording except through the note that embedded it, and nothing
    // for a search like `.mp3` to match. Both folders also hold media recorded or
    // pasted into notes; being listed does not change how a note plays them.
    const avSources = [
      { dir: path.join(attachDir, 'audio'),  sub: 'audio/',  type: 'audio', re: AUDIO_EXT_RE },
      { dir: path.join(attachDir, 'videos'), sub: 'videos/', type: 'video', re: VIDEO_EXT_RE },
    ];
    for (const src of avSources) {
      if (!fs.existsSync(src.dir)) continue;
      for (const item of fs.readdirSync(src.dir, { withFileTypes: true })) {
        if (!item.isFile() || isOwnTempOrHidden(item.name)) continue;
        const logical = stripEnc(item.name);   // drop the at-rest .enc marker
        if (!src.re.test(logical)) continue;
        const stat = fs.statSync(path.join(src.dir, item.name));
        entries.push({
          type: src.type,
          name: logical,
          path: `attachments/${src.sub}${logical}`,
          attachmentName: `${src.sub}${logical}`,
          modified: stat.mtime.toISOString(),
          created: (stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime).toISOString(),
          size: stat.size,
        });
      }
    }
  }
  return entries;
}
