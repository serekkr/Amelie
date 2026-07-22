// Credential-at-rest encryption for the SMB/WebDAV passwords in settings.json.
//
// Primary: Electron safeStorage (OS keyring). Amelie runs with
// --password-store=basic and on some setups safeStorage.isEncryptionAvailable()
// is false; in that case we encrypt with an app-level AES-256-GCM key instead,
// so the value is still stored as an object, never as a readable string.
//
// The app-level key is a random 32-byte secret in <APP_HOME>/.credkey (0600),
// mixed with the machine id — obfuscation-grade (like safeStorage's basic
// backend: someone with BOTH files on THIS machine could decrypt), and a copied
// settings.json alone is useless. Two on-disk shapes, both objects so a plain
// string can never be mistaken for an encrypted one:
//   { __sec: <base64> }  → safeStorage (OS keyring)
//   { __enc: <base64> }  → app-level AES-256-GCM (iv|ciphertext|tag)
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const APP_HOME = path.join(os.homedir(), '.local', 'share', 'amelie');

function _safeStorage() {
  try { return require('electron').safeStorage; } catch (_) { return null; }
}
function _secAvailable() {
  try { const ss = _safeStorage(); return !!(ss && ss.isEncryptionAvailable()); } catch (_) { return false; }
}

let _KEY = null;
function _credKey() {
  if (_KEY) return _KEY;
  const keyFile = path.join(APP_HOME, '.credkey');
  let raw = null;
  try { const b = fs.readFileSync(keyFile); if (b && b.length >= 32) raw = b; } catch (_) {}
  if (!raw) {
    raw = crypto.randomBytes(32);
    try { fs.mkdirSync(APP_HOME, { recursive: true }); fs.writeFileSync(keyFile, raw, { mode: 0o600 }); fs.chmodSync(keyFile, 0o600); } catch (_) {}
  }
  let machine = '';
  try { machine = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch (_) {}
  if (!machine) { try { machine = os.hostname(); } catch (_) { machine = 'amelie'; } }
  _KEY = crypto.createHash('sha256').update(raw).update(machine).digest();   // 32 bytes
  return _KEY;
}

// Encrypt a secret for storage. Objects/empty pass through unchanged (already
// encrypted, or nothing to hide). NEVER returns the raw string.
function encSecret(v) {
  if (v == null || v === '' || typeof v === 'object') return v;
  const s = String(v);
  if (_secAvailable()) {
    try { return { __sec: _safeStorage().encryptString(s).toString('base64') }; } catch (_) {}
  }
  try {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', _credKey(), iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return { __enc: Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64') };
  } catch (_) { return v; }   // crypto genuinely missing — last resort, keeps it non-fatal
}

// Decrypt a stored secret. Accepts either on-disk shape, or a plaintext string
// (freshly set from the renderer, not yet persisted) which passes through.
function decSecret(v) {
  if (v && typeof v === 'object') {
    if (typeof v.__sec === 'string') {
      try { return _safeStorage().decryptString(Buffer.from(v.__sec, 'base64')); } catch (_) { return ''; }
    }
    if (typeof v.__enc === 'string') {
      try {
        const buf = Buffer.from(v.__enc, 'base64');
        const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), ct = buf.subarray(12, buf.length - 16);
        const d = crypto.createDecipheriv('aes-256-gcm', _credKey(), iv);
        d.setAuthTag(tag);
        return d.update(ct) + d.final('utf8');
      } catch (_) { return ''; }
    }
    return '';
  }
  return v;
}

module.exports = { encSecret, decSecret, secAvailable: _secAvailable };
