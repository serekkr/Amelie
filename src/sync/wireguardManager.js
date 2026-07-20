/**
 * WireGuard Manager for Amelie
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages a real WireGuard tunnel on Linux using wg-quick.
 *
 * Security model:
 *   - The .conf file is saved to ~/.amelie/wg-tunnel.conf (chmod 600)
 *   - wg-quick requires root; we use pkexec (GUI sudo) or sudoers rule
 *   - We never log or expose the private key
 *
 * Requirements on Fedora:
 *   sudo dnf install wireguard-tools
 *   # Optional: passwordless sudo for wg-quick (see sudoers section below)
 */

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { execFile, execSync, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Same app-data folder as main.js (config migrated from the old ~/.amelie).
const APP_HOME    = path.join(os.homedir(), '.local', 'share', 'amelie');
// VPN configs (WireGuard + OpenVPN) live in their own subfolder.
const VPN_DIR     = path.join(APP_HOME, 'vpn');
// Distinctive interface name so Amelie is SURE an `amelie-wg` interface is its
// own and can clean it up safely, without ever touching other WireGuard tunnels
// the user may have. wg-quick derives the interface name from the .conf
// filename, so amelie-wg.conf → interface "amelie-wg". The matching NM
// connection is named "amelie-wg" too (interface-name = amelie-wg).
const WG_CONF     = path.join(VPN_DIR, 'amelie-wg.conf');
const OLD_WG_CONF = path.join(APP_HOME, 'wg-tunnel.conf');   // legacy name (auto-migrated)
const OVPN_CONF   = path.join(VPN_DIR, 'amelie.ovpn');       // OpenVPN alternative (one VPN at a time)
const OVPN_NAME   = 'amelie-ovpn';                           // NM connection id for OpenVPN
// Non-secret credential META (username + whether a password is stored in NM —
// NEVER the password itself) so the UI can show "user + ***" on reopen.
const OVPN_META   = path.join(VPN_DIR, 'amelie-ovpn-meta.json');
const MOUNT_BASE  = path.join(os.homedir(), '.local', 'share', 'amelie', 'mounts');

class WireGuardManager {
  constructor() {
    this.tunnelActive  = false;
    this.mountPoint    = null;
    this.parsedConf    = null;
    // True only when THIS process just migrated Amelie's own legacy
    // wg-tunnel.conf → amelie-wg.conf. Gates the one-time legacy interface
    // cleanup so we never delete a `wg-tunnel` the user later makes themselves.
    this.didMigrateLegacy = false;
    this._migrateLegacyConf();
  }

  /**
   * Migrate the old `wg-tunnel.conf` to the new distinctive `amelie-wg.conf`
   * so existing users don't have to re-import. No-op if already migrated.
   */
  _migrateLegacyConf() {
    try {
      // VPN files used to live at the APP_HOME root: move amelie-wg.conf,
      // amelie.ovpn and any related backups (*.bak…) into vpn/.
      if (fs.existsSync(APP_HOME)) {
        for (const f of fs.readdirSync(APP_HOME)) {
          if (!/^(amelie-wg\.conf|amelie\.ovpn)/.test(f)) continue;
          const to = path.join(VPN_DIR, f);
          if (fs.existsSync(to)) continue;
          if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
          fs.renameSync(path.join(APP_HOME, f), to);
        }
      }
      if (fs.existsSync(OLD_WG_CONF) && !fs.existsSync(WG_CONF)) {
        if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
        fs.renameSync(OLD_WG_CONF, WG_CONF);
        this.didMigrateLegacy = true;   // the old `wg-tunnel` was definitely ours
      }
    } catch(_) { /* best-effort */ }
  }

  // ── Conf file handling ────────────────────────────────────────────────────

  /**
   * Save the .conf content to disk (chmod 600 so only the user can read it).
   * Returns parsed info (no private key).
   */
  saveConf(confContent) {
    if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
    fs.writeFileSync(WG_CONF, confContent, { mode: 0o600, encoding: 'utf8' });
    this.parsedConf = this._parseConf(confContent);
    return this.parsedConf;
  }

  /** Read back the saved .conf and parse it (used on startup). */
  loadSavedConf() {
    if (!fs.existsSync(WG_CONF)) return null;
    try {
      const content = fs.readFileSync(WG_CONF, 'utf8');
      this.parsedConf = this._parseConf(content);
      return this.parsedConf;
    } catch(_) { return null; }
  }

  confExists() {
    return fs.existsSync(WG_CONF);
  }

  /** Full raw text of the saved WireGuard .conf (incl. keys) — for "Show config". */
  rawConf() {
    try { return fs.existsSync(WG_CONF) ? fs.readFileSync(WG_CONF, 'utf8') : null; } catch (_) { return null; }
  }

  /** Full raw text of the saved OpenVPN .ovpn — for "Show config". */
  rawOvpn() {
    try { return fs.existsSync(OVPN_CONF) ? fs.readFileSync(OVPN_CONF, 'utf8') : null; } catch (_) { return null; }
  }

  /** Parse a WireGuard .conf and return safe (non-secret) fields. */
  _parseConf(content) {
    const get = (key) => {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+)`, 'mi').exec(content);
      return m ? m[1].trim() : null;
    };
    return {
      interface:  get('Address')    || '?',
      localIp:    get('Address')    || '?',
      endpoint:   get('Endpoint')   || '?',
      allowedIps: get('AllowedIPs') || '?',
      dns:        get('DNS')        || null,
      // NOTE: PrivateKey is intentionally excluded
    };
  }

  // ── Tunnel lifecycle ──────────────────────────────────────────────────────

  /**
   * NetworkManager WireGuard connections whose name references Amelie
   * (e.g. "amelievpn"). We match by name — reading the endpoint from NM needs
   * root — and only ever touch Amelie-named connections, never the user's other
   * tunnels (wg-k7tz, hetzner, …).
   */
  async _nmAmelieConns() {
    if (!this._which('nmcli')) return [];
    const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], { timeout: 5000 });
    // Match Amelie's WireGuard (type wireguard) AND OpenVPN (type vpn) connections
    // — only ONE is ever configured at a time.
    return stdout.split('\n')
      .filter(l => /:(wireguard|vpn)$/.test(l))
      .map(l => l.slice(0, l.lastIndexOf(':')))
      .filter(n => /amelie/i.test(n));
  }

  /**
   * Completely remove Amelie's WireGuard setup: bring down + delete every
   * Amelie NM WireGuard connection, then delete the saved .conf file. NO
   * password. Leaves any of the user's personal (non-Amelie) tunnels untouched.
   */
  async removeAll() {
    let removedConns = 0;
    try {
      for (const name of await this._nmAmelieConns()) {
        try { await execFileAsync('nmcli', ['connection', 'down',   name], { timeout: 15000 }); } catch (_) {}
        try { await execFileAsync('nmcli', ['connection', 'delete', name], { timeout: 15000 }); removedConns++; } catch (_) {}
      }
    } catch (_) {}
    let confDeleted = false;
    try { if (fs.existsSync(WG_CONF)) { fs.unlinkSync(WG_CONF); confDeleted = true; } } catch (_) {}
    try { if (fs.existsSync(OVPN_CONF)) { fs.unlinkSync(OVPN_CONF); confDeleted = true; } } catch (_) {}
    try { if (fs.existsSync(OVPN_META)) fs.unlinkSync(OVPN_META); } catch (_) {}
    // Sweep every other amelie VPN file in vpn/ (backups like
    // amelie-wg.conf.fulltunnel.bak, stray meta…) — "Remove" means COMPLETE.
    try {
      if (fs.existsSync(VPN_DIR)) {
        for (const f of fs.readdirSync(VPN_DIR)) {
          if (!/^(amelie-wg\.conf|amelie\.ovpn|amelie-ovpn)/.test(f)) continue;
          try { fs.unlinkSync(path.join(VPN_DIR, f)); } catch (_) {}
        }
      }
    } catch (_) {}
    // Legacy locations (pre-vpn/ migration) — clear those too.
    try {
      if (fs.existsSync(APP_HOME)) {
        for (const f of fs.readdirSync(APP_HOME)) {
          if (!/^(amelie-wg\.conf|amelie\.ovpn)/.test(f)) continue;
          try { fs.unlinkSync(path.join(APP_HOME, f)); } catch (_) {}
        }
      }
      if (fs.existsSync(OLD_WG_CONF)) fs.unlinkSync(OLD_WG_CONF);
    } catch (_) {}
    this.parsedConf = null;
    return { ok: true, removedConns, confDeleted };
  }

  // ── OpenVPN (alternative to WireGuard — only ONE VPN configured at a time) ──

  ovpnExists() { return fs.existsSync(OVPN_CONF); }

  /** Non-secret info parsed from the saved .ovpn: peer endpoint (the first
   * `remote <host> <port>` — hostname or public IP, whatever the file uses)
   * and protocol. Returns null if no .ovpn or no `remote` line. */
  ovpnParsed() {
    try {
      const txt = fs.readFileSync(OVPN_CONF, 'utf8');
      const lines = txt.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith(';'));
      const remotes = lines.filter(l => /^remote\s+/i.test(l)).map(l => l.split(/\s+/));
      if (!remotes.length) return null;
      const [, host, port, inlineProto] = remotes[0];
      const protoLine = lines.find(l => /^proto\s+/i.test(l));
      const proto = inlineProto || (protoLine ? protoLine.split(/\s+/)[1] : null);
      return {
        endpoint: host + (port ? ':' + port : ''),
        proto:    proto || null,
        remotes:  remotes.length,   // some providers list several fallbacks
      };
    } catch (_) { return null; }
  }

  /** Read the non-secret OpenVPN credential meta ({ username, hasPassword }). */
  ovpnMeta() {
    try { return JSON.parse(fs.readFileSync(OVPN_META, 'utf8')); } catch (_) { return null; }
  }

  /** Persist the non-secret credential meta (the password stays ONLY in NM). */
  _writeOvpnMeta(username, hasPassword) {
    try {
      if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
      fs.writeFileSync(OVPN_META, JSON.stringify({ username: username || '', hasPassword: !!hasPassword }), { mode: 0o600, encoding: 'utf8' });
    } catch (_) {}
  }

  /**
   * Set the OpenVPN password secret on an NM connection WITHOUT putting it on
   * argv (where any local user could read it from /proc/<pid>/cmdline / `ps`).
   * `nmcli connection modify … vpn.secrets password=<pw>` would leak it; instead
   * we drive `nmcli connection edit` and feed the secret over STDIN. NM still
   * stores it (password-flags=0), so connect stays a plain `nmcli connection up`.
   * Resolves { ok } — never rejects; callers already tolerate failures.
   */
  _nmSetVpnSecret(conn, password) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok, err) => { if (!done) { done = true; resolve({ ok, error: err }); } };
      let child;
      try {
        child = spawn('nmcli', ['connection', 'edit', conn], { stdio: ['pipe', 'ignore', 'pipe'] });
      } catch (e) { return finish(false, String(e && e.message || e)); }
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(false, 'timeout'); }, 10000);
      let stderr = '';
      child.stderr && child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', e => { clearTimeout(timer); finish(false, String(e && e.message || e)); });
      child.on('close', code => { clearTimeout(timer); finish(code === 0, stderr.trim() || undefined); });
      // nmcli's interactive editor reads one command per line from stdin. The
      // password travels on stdin only — never on the process argument list.
      try {
        child.stdin.write('set vpn.secrets password=' + password + '\n');
        child.stdin.write('save persistent\n');
        child.stdin.write('quit\n');
        child.stdin.end();
      } catch (e) { clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} finish(false, String(e && e.message || e)); }
    });
  }

  /** Update user/pass on the already-imported OpenVPN NM connection (no
   * re-import, no flap). Empty fields leave the stored values untouched. */
  async updateOvpnCreds({ username = '', password = '' } = {}) {
    const conn = await this._nmOvpnConn();
    if (!conn) return { ok: false, error: 'nessuna connessione OpenVPN importata' };
    if (username) await execFileAsync('nmcli', ['connection', 'modify', conn, 'vpn.user-name', username], { timeout: 10000 }).catch(() => {});
    if (password) {
      // password-flags=0 = NM stores the secret itself; without it NM treats
      // the password as agent-requested and PROMPTS the user on connect.
      await execFileAsync('nmcli', ['connection', 'modify', conn, '+vpn.data', 'password-flags=0'], { timeout: 10000 }).catch(() => {});
      await this._nmSetVpnSecret(conn, password);   // secret via stdin, not argv
    }
    if (username || password) {
      const meta = this.ovpnMeta() || {};
      this._writeOvpnMeta(username || meta.username || '', password ? true : !!meta.hasPassword);
    }
    return { ok: true, connection: conn };
  }

  /** Name of Amelie's imported OpenVPN NM connection (type vpn), or null. */
  async _nmOvpnConn() {
    try {
      if (!this._which('nmcli')) return null;
      const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], { timeout: 5000 });
      const line = stdout.split('\n').find(l => /:vpn$/.test(l) && /amelie/i.test(l));
      return line ? line.slice(0, line.lastIndexOf(':')) : null;
    } catch (_) { return null; }
  }

  /** Save the .ovpn to disk. `unchanged` = the same content was already saved
   * (lets the caller skip a destructive NM re-import that would flap the VPN). */
  saveOvpn(content) {
    let unchanged = false;
    try { unchanged = fs.existsSync(OVPN_CONF) && fs.readFileSync(OVPN_CONF, 'utf8') === content; } catch (_) {}
    if (!fs.existsSync(VPN_DIR)) fs.mkdirSync(VPN_DIR, { recursive: true });
    fs.writeFileSync(OVPN_CONF, content, { mode: 0o600, encoding: 'utf8' });
    return { ok: true, unchanged };
  }

  /**
   * Import the saved .ovpn into NetworkManager (replacing any existing Amelie
   * VPN), set the username/password if given, harden it (no autoconnect, never
   * default route is left to the .ovpn), and leave it DOWN. Requires the
   * NetworkManager-openvpn plugin. NO tunnel is brought up here.
   */
  async importOvpnToNM({ username = '', password = '', skipIfImported = false } = {}) {
    if (!this._which('nmcli'))    return { ok: false, error: 'nmcli non disponibile (NetworkManager)' };
    if (!fs.existsSync(OVPN_CONF)) return { ok: false, error: 'File .ovpn non trovato' };
    try {
      // Same .ovpn already imported → only refresh the credentials, WITHOUT the
      // destructive down+delete+re-import (which flaps an active VPN down/up).
      if (skipIfImported) {
        const existing = await this._nmOvpnConn();
        if (existing) {
          if (username) {
            await execFileAsync('nmcli', ['connection', 'modify', existing, 'vpn.user-name', username], { timeout: 10000 }).catch(() => {});
            if (password) {
              await execFileAsync('nmcli', ['connection', 'modify', existing, '+vpn.data', 'password-flags=0'], { timeout: 10000 }).catch(() => {});
              await this._nmSetVpnSecret(existing, password);   // secret via stdin, not argv
            }
            this._writeOvpnMeta(username, password ? true : (this.ovpnMeta()?.hasPassword || false));
          }
          console.log('[OpenVPN] Config unchanged — reusing NM connection', existing);
          return { ok: true, connection: existing, unchanged: true };
        }
      }
      // Remove any existing Amelie VPN (WireGuard or OpenVPN) — one at a time.
      for (const name of await this._nmAmelieConns()) {
        try { await execFileAsync('nmcli', ['connection', 'down',   name], { timeout: 15000 }); } catch (_) {}
        try { await execFileAsync('nmcli', ['connection', 'delete', name], { timeout: 15000 }); } catch (_) {}
      }
      // Import the .ovpn. NM derives a connection id from the filename → "amelie".
      const { stdout } = await execFileAsync('nmcli', ['connection', 'import', 'type', 'openvpn', 'file', OVPN_CONF], { timeout: 30000 }).catch(e => { throw new Error((e.stderr || e.message || '').toString().trim() || 'import OpenVPN fallito (plugin NetworkManager-openvpn installato?)'); });
      // Find the just-imported connection name (the newest Amelie vpn-type one).
      let conn = OVPN_NAME;
      try {
        const list = await this._nmAmelieConns();
        if (list.length) conn = list[list.length - 1];
      } catch (_) {}
      // Rename to a stable id so we always find it.
      try { await execFileAsync('nmcli', ['connection', 'modify', conn, 'connection.id', OVPN_NAME], { timeout: 10000 }); conn = OVPN_NAME; } catch (_) {}
      // Credentials (user/pass) — many providers need auth-user-pass.
      if (username) {
        try {
          await execFileAsync('nmcli', ['connection', 'modify', conn, 'vpn.user-name', username], { timeout: 10000 });
          await execFileAsync('nmcli', ['connection', 'modify', conn, '+vpn.data', 'password-flags=0'], { timeout: 10000 }).catch(() => {});
          if (password) await this._nmSetVpnSecret(conn, password);   // secret via stdin, not argv
        } catch (_) {}
      }
      // Harden: no autoconnect.
      await execFileAsync('nmcli', ['connection', 'modify', conn, 'connection.autoconnect', 'no'], { timeout: 10000 }).catch(() => {});
      // Leave it DOWN — the tunnel comes up only with the flag.
      try { await execFileAsync('nmcli', ['connection', 'down', conn], { timeout: 15000 }); } catch (_) {}
      // Fresh import: the meta mirrors exactly what went into NM.
      this._writeOvpnMeta(username, !!password);
      console.log('[OpenVPN] Config imported into NetworkManager as', conn);
      return { ok: true, connection: conn };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || 'import fallito').toString().trim() };
    }
  }

  /**
   * Bring the tunnel up via NetworkManager (NO root/password — NM authorizes the
   * active session). Activates an Amelie-named NM WireGuard connection. Returns
   * true if one was activated.
   */
  /**
   * Decide the FASTEST path to the share and act on it. Returns:
   *   'tunnel' — the tunnel is (or was already) up; go through it;
   *   'direct' — the share is reachable WITHOUT the tunnel → leave the tunnel
   *              DOWN and use the direct route (avoids the slow VPN hairpin when
   *              you're on the share's own LAN, e.g. at home);
   *   'none'   — no tunnel could be brought up and the share isn't direct.
   * The decision is only made when the tunnel is currently DOWN (never flaps an
   * already-up tunnel). Used by BOTH backup and two-way sync.
   */
  async ensureBestPath(host) {
    if (await this.nmActiveAmelie()) return 'tunnel';        // already up → keep it
    if (host && await this._hostReachable(host, 445, 2500)) {
      console.log('[WG] Share reachable directly → no tunnel (fast path):', host);
      return 'direct';
    }
    const ok = await this._nmUp();                            // not direct → bring the tunnel up
    return ok ? 'tunnel' : 'none';
  }

  async _nmUp() {
    try {
      // Already active? Do NOT run `nmcli connection up` again — on an already-up
      // connection NM deactivates+reactivates it, which is a visible tunnel flap
      // (down→up) and briefly breaks reachability mid-backup. No-op instead.
      if (await this.nmActiveAmelie()) return true;
      for (const name of await this._nmAmelieConns()) {
        try {
          await execFileAsync('nmcli', ['connection', 'up', name], { timeout: 30000 });
          console.log('[WG] Tunnel activated via NetworkManager:', name);
          return true;
        } catch (_) { /* try next */ }
      }
    } catch (_) { /* nmcli unavailable */ }
    return false;
  }

  /**
   * Wait until host:port is reachable. Right after _nmUp() the tunnel handshake
   * may need a moment, so a backup that fires immediately can fail on the first
   * try. Polls a few times and returns true as soon as it connects.
   */
  async _waitReachable(host, port = 445, tries = 6, delayMs = 700, timeoutMs = 3000) {
    for (let i = 0; i < tries; i++) {
      if (await this._hostReachable(host, port, timeoutMs)) return true;
      await this._sleep(delayMs);
    }
    return false;
  }

  /** Name of the currently ACTIVE Amelie NM VPN connection (WireGuard or
   * OpenVPN), or null. */
  async nmActiveAmelie() {
    try {
      if (!this._which('nmcli')) return null;
      const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show', '--active'], { timeout: 5000 });
      const line = stdout.split('\n').find(l => /:(wireguard|vpn)$/.test(l) && /amelie/i.test(l));
      return line ? line.slice(0, line.lastIndexOf(':')) : null;
    } catch (_) { return null; }
  }

  /** Bring Amelie-named NM WireGuard connections down (NO password). */
  async _nmDown() {
    let any = false;
    try {
      for (const name of await this._nmAmelieConns()) {
        try {
          await execFileAsync('nmcli', ['connection', 'down', name], { timeout: 15000 });
          console.log('[WG] Tunnel deactivated via NetworkManager:', name);
          any = true;
        } catch (_) {}
      }
    } catch (_) {}
    return any;
  }

  /**
   * (Re)create the NetworkManager WireGuard connection from the saved .conf, so
   * importing a new config actually takes effect on the real tunnel (otherwise we
   * only rewrite the file while NM keeps the old endpoint/keys). NO password — NM
   * authorizes the active session for connection management.
   *
   * Steps: bring down + delete any existing Amelie NM connection (so the new
   * config fully replaces the old, no duplicates), then `nmcli connection import`
   * the saved file. The connection name derives from the filename → "amelie-wg".
   * Finally harden it: autoconnect off (avoids flapping) and never-default (so a
   * stray full-tunnel config can't hijack the default route).
   */
  async importToNetworkManager({ activate = false } = {}) {
    if (!this._which('nmcli'))      return { ok: false, error: 'nmcli non disponibile (NetworkManager)' };
    if (!fs.existsSync(WG_CONF))    return { ok: false, error: 'File .conf non trovato' };
    const iface = this._ifaceName();   // = "amelie-wg"
    try {
      // 1. Remove existing Amelie NM connections so the import replaces them.
      for (const name of await this._nmAmelieConns()) {
        try { await execFileAsync('nmcli', ['connection', 'down',   name], { timeout: 15000 }); } catch (_) {}
        try { await execFileAsync('nmcli', ['connection', 'delete', name], { timeout: 15000 }); } catch (_) {}
      }
      // 2. Import the saved .conf (connection id + interface = filename base).
      //    NOTE: `nmcli connection import` ACTIVATES the connection immediately.
      await execFileAsync('nmcli', ['connection', 'import', 'type', 'wireguard', 'file', WG_CONF], { timeout: 20000 });
      // 3. Harden: no autoconnect. We RESPECT the .conf's AllowedIPs — do NOT
      //    force never-default. (Forcing never-default broke full-tunnel configs:
      //    with AllowedIPs 0.0.0.0/0 NM then installed NO routes, so nothing —
      //    not even the share — went through the tunnel.) If you only want the
      //    share through the tunnel, use a split .conf (AllowedIPs = share subnet
      //    + WG subnet) instead of 0.0.0.0/0.
      await execFileAsync('nmcli', ['connection', 'modify', iface,
        'connection.autoconnect', 'no',
        'connection.interface-name', iface,
        'ipv4.never-default', 'no',
        'ipv6.never-default', 'no'], { timeout: 10000 }).catch(() => {});
      // 4. Unless asked to activate, leave it DOWN: importing a config must not
      //    leave a tunnel connected — the tunnel comes up only with the flag.
      if (!activate) { try { await execFileAsync('nmcli', ['connection', 'down', iface], { timeout: 15000 }); } catch (_) {} }
      console.log('[WG] Config imported into NetworkManager as', iface, activate ? '(active)' : '(inactive)');
      return { ok: true, connection: iface };
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || 'import fallito').toString().trim() };
    }
  }

  /**
   * Ensure the tunnel is up — via NetworkManager only (NO wg-quick, so NO
   * password prompt). If there's no Amelie NM connection, we rely on NM
   * autoconnect / the user to bring the VPN up.
   */
  async bringUp() {
    if (await this._isTunnelUp()) return { ok: true, alreadyUp: true };
    if (await this._nmUp())       return { ok: true, viaNm: true };
    return { ok: false, error: 'tunnel non attivo (attivalo da NetworkManager)' };
  }

  /**
   * Bring up the tunnel.
   * Tries: wg-quick (if sudoers rule exists) → pkexec → error with instructions.
   */
  async tunnelUp() {
    if (!fs.existsSync(WG_CONF)) {
      return { ok: false, error: 'File .conf non trovato. Importalo prima nelle impostazioni.' };
    }

    // Check if wg-quick is installed
    const wgPath = this._which('wg-quick');
    if (!wgPath) {
      return { ok: false, error: 'wg-quick non trovato. Installa wireguard-tools:\n  sudo dnf install wireguard-tools' };
    }

    // Check if already up
    if (await this._isTunnelUp()) {
      this.tunnelActive = true;
      return { ok: true, alreadyUp: true };
    }

    // If a leftover/half-created interface exists (present but DOWN, e.g. from a
    // previous crash), `wg-quick up` would fail with "wg-tunnel already exists".
    // Remove the stale stub first so we can bring up a clean tunnel.
    if (await this._ifaceExists()) {
      await this.tunnelDown();
    }

    // Try with sudo (passwordless rule) first, then pkexec
    const result = await this._runPrivileged('wg-quick', ['up', WG_CONF]);
    if (result.ok) {
      this.tunnelActive = true;
      // Give tunnel a moment to establish
      await this._sleep(1500);
    }
    return result;
  }

  /**
   * Bring down the tunnel and remove the interface.
   * Cleans up even a *leftover* interface (present but DOWN, e.g. a half-created
   * stub from a previous crash) so nothing dangling is left behind on exit.
   */
  async tunnelDown() {
    if (!await this._ifaceExists()) {   // nothing to remove
      this.tunnelActive = false;
      return { ok: true };
    }
    let result;
    if (fs.existsSync(WG_CONF)) {
      result = await this._runPrivileged('wg-quick', ['down', WG_CONF]);
    } else {
      // Interface exists but the .conf is gone — remove the netdev directly.
      result = await this._runPrivileged('ip', ['link', 'delete', 'dev', this._ifaceName()]);
    }
    if (result.ok) this.tunnelActive = false;
    return result;
  }

  /**
   * Name of the WireGuard interface Amelie manages. wg-quick derives it from the
   * .conf filename, so amelie-wg.conf → interface "amelie-wg".
   */
  _ifaceName() {
    return path.basename(WG_CONF).replace(/\.conf$/i, '');
  }

  /**
   * Latest WireGuard handshake time for our interface. This is a PASSIVE read of
   * kernel state — it does NOT generate any traffic (no ping), so it's the ideal
   * one-shot tunnel-health signal. `wg show` normally needs root, so we try it
   * plainly first, then `sudo -n` (works only with the NOPASSWD sudoers rule).
   * Returns { ok, ts } where ts is the Unix time of the last handshake (0 = none
   * yet), or { ok:false } if it couldn't be read (e.g. no root).
   */
  async latestHandshake() {
    const iface = this._ifaceName();
    if (!this._which('wg')) return { ok: false, reason: 'no-wg' };
    const attempts = [['wg', ['show', iface, 'latest-handshakes']]];
    if (this._which('sudo')) attempts.push(['sudo', ['-n', 'wg', 'show', iface, 'latest-handshakes']]);
    for (const [cmd, args] of attempts) {
      try {
        const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
        const line = (stdout || '').trim().split('\n').filter(Boolean)[0];
        if (!line) return { ok: true, ts: 0 };
        const ts = parseInt(line.split(/\s+/).pop(), 10);
        if (Number.isFinite(ts)) return { ok: true, ts };
      } catch (_) { /* try next */ }
    }
    return { ok: false, reason: 'no-perm' };
  }

  /**
   * Does the given interface exist at all (even if administratively DOWN)?
   * Defaults to *our* interface. Used by teardown/cleanup to catch leftover or
   * half-created stubs. `ip link show <iface>` doesn't require root.
   */
  async _ifaceExists(name = this._ifaceName()) {
    try {
      await execFileAsync('ip', ['link', 'show', name], { timeout: 3000 });
      return true;
    } catch(_) {
      return false;
    }
  }

  /**
   * Remove a leftover Amelie WireGuard interface from a previous run that
   * skipped the normal teardown (crash, kill -9, power loss).
   * Best-effort and non-blocking: never throws. Call once on app startup.
   *
   * SAFETY: we only ever remove our own distinctive `amelie-wg` interface.
   * The legacy `wg-tunnel` is removed ONLY as part of the one-time migration of
   * Amelie's own config (didMigrateLegacy) — so a `wg-tunnel` the user creates
   * later for their personal use is NEVER deleted.
   */
  async cleanupStaleTunnels({ keepOwn = false } = {}) {
    // 1. Our own interface — always safe to reclaim (the name is unmistakably
    // ours). Skipped when keepOwn is set (WireGuard option enabled → the tunnel
    // is meant to stay up, so don't tear it down at startup).
    if (!keepOwn) {
      try {
        if (await this._ifaceExists(this._ifaceName())) {
          console.log('[WG] Removing leftover interface:', this._ifaceName());
          if (fs.existsSync(WG_CONF)) await this._runPrivileged('wg-quick', ['down', WG_CONF]);
          else                        await this._runPrivileged('ip', ['link', 'delete', 'dev', this._ifaceName()]);
        }
      } catch(_) { /* best-effort */ }
    }

    // 2. Legacy `wg-tunnel` — ONLY during the one-time migration of OUR old
    // config. After that we never touch `wg-tunnel` again (could be the user's).
    if (this.didMigrateLegacy) {
      try {
        if (await this._ifaceExists('wg-tunnel')) {
          console.log('[WG] Removing old wg-tunnel interface (one-time migration)');
          // The old .conf has already been renamed away, so delete the netdev directly.
          await this._runPrivileged('ip', ['link', 'delete', 'dev', 'wg-tunnel']);
        }
      } catch(_) { /* best-effort */ }
    }

    this.tunnelActive = false;
  }

  /**
   * Check if *our* WireGuard tunnel is actually up (present AND not DOWN).
   * We check the specific interface (not "any wg interface") so we never:
   *   - think our tunnel is up just because some other wg tunnel exists, and
   *   - tear down a tunnel that isn't ours.
   * A leftover DOWN stub counts as NOT up (so tunnelUp re-establishes it
   * properly), but _ifaceExists() still sees it for cleanup.
   */
  async _isTunnelUp() {
    try {
      const { stdout } = await execFileAsync('ip', ['-br', 'link', 'show', this._ifaceName()], { timeout: 3000 });
      return !/\bDOWN\b/.test(stdout);   // exists and not administratively down
    } catch(_) {
      return false;                      // interface doesn't exist
    }
  }

  /**
   * Clean teardown for app shutdown: unmount any Samba share and bring our
   * tunnel down. Safe to call unconditionally — it's a no-op if nothing is up,
   * so it won't trigger a privilege prompt when there's nothing to remove.
   */
  async shutdown() {
    // Teardown on app close with NO password prompt: bring the tunnel down via
    // NetworkManager only (the active session is already authorized). We must
    // NEVER call wg-quick/pkexec here — that would pop a polkit password dialog
    // on every single app close. With NM autoconnect off, _nmDown() sticks (the
    // tunnel won't be auto-re-upped), so the share/network is freed on exit.
    try { await this.unmountSamba(); } catch(_) {}   // no-op unless a CIFS mount exists
    try { await this._nmDown(); } catch(_) {}        // bring the Amelie NM tunnel down (no password)
  }

  // ── Connectivity tests ─────────────────────────────────────────────────────

  /**
   * Test step 2: verify tunnel is up AND peer is reachable.
   * Best practice: a test must not leave a tunnel lingering. If the test itself
   * brought the tunnel up, it tears it back down on the way out (set
   * keepUp:true only when the caller will keep using the tunnel right after).
   */
  async testTunnel({ host = null, keepUp = false } = {}) {
    // NetworkManager-only test: NO wg-quick, NO pkexec → NO password prompt,
    // consistent with how the tunnel is managed everywhere else. Brings the
    // tunnel up via NM (no-op if already up) and checks reachability THROUGH it.
    const steps = [];
    // Remember whether the tunnel was already active, so a test that brings it
    // up only for the check tears it back down afterwards (the flag, not the
    // test, is what keeps the tunnel up).
    const wasActive = !!(await this.nmActiveAmelie()) || await this._isTunnelUp();
    let broughtUp = false;
    try {
      // 1. Tunnel up via NetworkManager.
      if (!wasActive) { await this._nmUp(); broughtUp = true; }
      const active = await this.nmActiveAmelie();
      const up = !!active || await this._isTunnelUp();
      steps.push({ label: 'wg-up', ok: up,
        detail: up ? (active ? `attivo (${active})` : 'attivo') : 'nessuna connessione NM Amelie (attiva la VPN da NetworkManager)' });
      if (!up) return { ok: false, steps };

      // 2. Reachability through the tunnel (TCP :445 — ping is often blocked).
      let latencyMs = null;
      if (host && host !== '?') {
        const t0 = Date.now();
        const reachable = await this._hostReachable(host, 445);
        latencyMs = Date.now() - t0;
        steps.push({ label: 'reach', ok: reachable,
          detail: reachable ? latencyMs + 'ms' : 'share non raggiungibile nel tunnel' });
        if (!reachable) return { ok: false, steps };
      } else {
        steps.push({ label: 'reach', ok: true, detail: 'tunnel attivo' });
      }

      // 3. Latency verdict.
      const latencyOk = latencyMs == null ? true : latencyMs < 800;
      steps.push({ label: 'latency', ok: latencyOk, detail: latencyOk ? 'ok' : 'alta' });

      return { ok: true, steps };
    } finally {
      // The FLAG commands the tunnel, not the test: with the flag off (keepUp
      // false) the VPN must be down after the test — even if it was already up
      // beforehand (e.g. left over from an import or a previous flag-on test).
      if (!keepUp) { try { await this._nmDown(); } catch (_) {} }
    }
  }

  /** Ping an IP, return { ok, latency } */
  async _ping(ip, count = 2) {
    try {
      const { stdout } = await execFileAsync('ping', ['-c', String(count), '-W', '3', ip], { timeout: 8000 });
      const m = /avg[^=]+=\s*([\d.]+)/.exec(stdout);
      return { ok: true, latency: m ? m[1] + 'ms' : 'ok' };
    } catch(e) {
      return { ok: false, error: `Ping fallito (${ip}): host non raggiungibile` };
    }
  }

  // ── Samba mount ───────────────────────────────────────────────────────────

  /** Write CIFS credentials to a private 0600 file (passed to mount via
   * `credentials=`), so the password NEVER lands on the (root) mount command
   * line — where `ps`/`/proc/<pid>/cmdline` would expose it to ANY local user —
   * and so a comma in the username/password can't inject extra `-o` mount
   * options into a command that runs as root. Returns {dir,file} (delete `dir`
   * after the mount) or null for a guest mount. */
  _cifsCredFile(username, password, domain) {
    if (!username) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-creds-'));
    const file = path.join(dir, 'cifs');
    let body = `username=${username}\npassword=${password || ''}\n`;
    if (domain) body += `domain=${domain}\n`;
    fs.writeFileSync(file, body, { mode: 0o600 });
    return { dir, file };
  }

  /**
   * Mount a CIFS/Samba share.
   * Returns the mount point path or throws.
   */
  async mountSamba({ ip, share, path: remotePath, username, password }) {
    // cifs-utils check
    if (!this._which('mount.cifs')) {
      return {
        ok: false,
        error: 'cifs-utils non installato. Installa con:\n  sudo dnf install cifs-utils'
      };
    }

    const mountDir = path.join(MOUNT_BASE, `${Date.now()}`);
    fs.mkdirSync(mountDir, { recursive: true });

    const unc = `//${ip}/${share}`;

    // Build mount options. Credentials go through a private 0600 file (never on
    // the root command line / never in the -o list) — see _cifsCredFile.
    const opts = [
      `uid=${process.getuid()}`,
      `gid=${process.getgid()}`,
      'vers=3.0',
      'iocharset=utf8',
    ];
    const cred = this._cifsCredFile(username, password);
    if (cred) opts.push(`credentials=${cred.file}`);
    else opts.push('guest');

    let result;
    try {
      result = await this._runPrivileged('mount', ['-t', 'cifs', unc, mountDir, '-o', opts.join(',')]);
    } finally {
      if (cred) { try { fs.rmSync(cred.dir, { recursive: true, force: true }); } catch (_) {} }
    }
    if (!result.ok) {
      fs.rmdirSync(mountDir, { recursive: true });
      return result;
    }

    this.mountPoint = mountDir;
    return { ok: true, mountPoint: mountDir, remotePath: remotePath || '' };
  }

  /** Unmount and clean up. */
  async unmountSamba() {
    if (!this.mountPoint) return;
    try {
      await this._runPrivileged('umount', [this.mountPoint]);
      fs.rmdirSync(this.mountPoint, { recursive: true });
    } catch(e) {
      console.warn('[WG] umount failed:', e.message);
    }
    this.mountPoint = null;
  }

  /**
   * Full connection test (step 4):
   * tunnel up → mount → access folder → write test file → unmount
   */
  // TCP reachability check (Samba is on port 445). Used to allow skipping the
  // WireGuard step when the host is already reachable directly (same LAN, or a
  // VPN already up at the OS level).
  _hostReachable(host, port = 445, timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (!host) return resolve(false);
      const net = require('net');
      const sock = new net.Socket();
      let done = false;
      const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (_) {} resolve(ok); };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true));
      sock.once('timeout', () => finish(false));
      sock.once('error', () => finish(false));
      try { sock.connect(port, host); } catch (_) { finish(false); }
    });
  }

  /** Path of the bundled `amelie-smb` helper (Go, SMB2/3), or the dev copy. */
  _smbHelperBin() {
    if (this.__smbBin !== undefined) return this.__smbBin;
    const cands = [];
    try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'amelie-smb')); } catch (_) {}
    cands.push(path.join(__dirname, '..', '..', 'smb-helper', 'amelie-smb'));   // dev
    this.__smbBin = null;
    for (const c of cands) { try { if (fs.existsSync(c)) { this.__smbBin = c; break; } } catch (_) {} }
    return this.__smbBin;
  }

  /** Run the SMB helper (credentials via env, never argv). Returns { ok, out, err }.
   * go-smb2 reports NT status as `STATUS_*` (no NT_ prefix) — callers match both. */
  async _smb(smbConfig, args) {
    const bin = this._smbHelperBin();
    if (!bin) return { ok: false, out: '', err: 'amelie-smb non disponibile' };
    const env = {
      ...process.env,
      AMELIE_SMB_HOST:   String(smbConfig.ip || smbConfig.host || ''),
      AMELIE_SMB_PORT:   String(smbConfig.port || 445),
      AMELIE_SMB_SHARE:  String(smbConfig.share || ''),
      AMELIE_SMB_USER:   String(smbConfig.username || ''),
      AMELIE_SMB_PASS:   String(smbConfig.password || ''),
      AMELIE_SMB_DOMAIN: String(smbConfig.domain || 'WORKGROUP'),
    };
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, out: (stdout || '') + (stderr || ''), err: null };
    } catch (e) {
      const out = (e.stdout || '') + (e.stderr || '') + (e.message || '');
      return { ok: false, out, err: (out.split('\n').find(Boolean) || e.message || '').trim() };
    }
  }

  /**
   * Full connection test — entirely via `smbclient` (NO mount, NO root, NO
   * password prompt). 4 steps: reachable → connect → folder → write test.
   */
  async testFullConnection(smbConfig, { keepUp = false } = {}) {
    const steps = [];
    const wasActive = !!(await this.nmActiveAmelie());
    let broughtUp = false;
    try {
      // 1. Reachability. If not reachable, try NetworkManager (no password);
      // never wg-quick.
      let reachable = await this._hostReachable(smbConfig.ip, 445);
      if (!reachable && !wasActive) broughtUp = true;
      if (!reachable) {
        if (await this._nmUp()) reachable = await this._hostReachable(smbConfig.ip, 445);
      }
      steps.push({ label: 'Share raggiungibile (:445)', ok: reachable,
        detail: reachable ? undefined : 'host non raggiungibile (tunnel/LAN?)' });
      if (!reachable) return { ok: false, steps };

      // 2. Connect (mount the share root).
      const conn = await this._smb(smbConfig, ['test']);
      steps.push({ label: 'Connessione SMB', ok: conn.ok, detail: conn.ok ? undefined : conn.err });
      if (!conn.ok) return { ok: false, steps };

      // 3. Remote folder access (create + open the subfolder). Forward-slash for the helper.
      const subFwd = String(smbConfig.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const acc = subFwd
        ? await this._smb(smbConfig, ['mkdirp', subFwd])
        : await this._smb(smbConfig, ['list', '']);
      steps.push({ label: 'Accesso cartella remota', ok: acc.ok, detail: acc.ok ? undefined : acc.err });
      if (!acc.ok) return { ok: false, steps };

      // 4. Write test (put a tiny file, then delete it).
      const tmp = path.join(APP_HOME, '.amelie-smbtest');
      try { fs.writeFileSync(tmp, 'amelie-test'); } catch(_) {}
      const t0 = Date.now();
      const remoteTest = (subFwd ? subFwd + '/' : '') + '.amelie-test';
      const wr = await this._smb(smbConfig, ['put', tmp, remoteTest]);
      if (wr.ok) await this._smb(smbConfig, ['del', remoteTest]);
      try { fs.unlinkSync(tmp); } catch(_) {}
      steps.push({ label: 'Scrittura file di test', ok: wr.ok, detail: wr.ok ? (Date.now() - t0) + 'ms' : wr.err });
      if (!wr.ok) return { ok: false, steps };

      return { ok: true, steps };
    } finally {
      if (broughtUp && !keepUp) { try { await this._nmDown(); } catch(_) {} }
    }
  }

  /**
   * Minimal connection test: just "can I WRITE to the Samba share?". Brings the
   * tunnel up if needed (no password), ensures the target folder, writes a tiny
   * file and deletes it. Reports a SINGLE step — if anything upstream fails
   * (unreachable, auth, folder), it surfaces as the write step's error.
   */
  async testSmbWrite(smbConfig, { keepUp = false, purpose = null, avoid = null } = {}) {
    // Reports THREE sub-results so the user sees exactly what worked:
    //   1) connected via WireGuard, 2) Samba share reachable, 3) write to folder.
    const steps = [
      { key: 'wg',    label: 'Connesso via WireGuard',     ok: false, detail: '' },
      { key: 'reach', label: 'Samba share raggiungibile',  ok: false, detail: '' },
      { key: 'write', label: 'Scrittura nella cartella',   ok: false, detail: '' },
    ];
    const done = (ok) => ({ ok, steps });
    // Leave an already-active tunnel alone; tear down one WE brought up for the test.
    const wasActive = !!(await this.nmActiveAmelie());
    let broughtUp = false;
    try {
      // 1. WireGuard connection.
      let reachable = await this._hostReachable(smbConfig.ip, 445);
      if (wasActive) {
        steps[0].ok = true; steps[0].detail = 'tunnel attivo'; steps[0].dkey = 'sync.ts_tunnel_active';
      } else if (reachable) {
        steps[0].ok = true; steps[0].detail = 'raggiungibile diretta (LAN) · tunnel non necessario'; steps[0].dkey = 'sync.ts_direct';
      } else {
        const up = await this._nmUp();
        if (up) {
          broughtUp = true; steps[0].ok = true; steps[0].detail = 'tunnel attivato'; steps[0].dkey = 'sync.ts_tunnel_up';
          // We JUST brought the tunnel up cold: nmcli returns as soon as NM marks
          // the connection active, but the WireGuard handshake to an internet
          // endpoint (DNS resolve + UDP round-trip) can still need a couple of
          // seconds. Wait a bit (returns the instant :445 answers) so a healthy-
          // but-cold tunnel isn't wrongly reported unreachable — but cap it ~8s
          // so a tunnel that will NEVER connect (blocked UDP/endpoint) fails fast.
          reachable = await this._waitReachable(smbConfig.ip, 445, 5, 500, 1200);
        } else { steps[0].detail = 'impossibile attivare il tunnel (connessione NM Amelie?)'; steps[0].dkey = 'sync.ts_tunnel_fail'; return done(false); }
      }

      // 2. Samba share reachable (:445).
      if (!reachable) reachable = await this._hostReachable(smbConfig.ip, 445, 800);
      steps[1].ok = reachable;
      steps[1].detail = reachable ? 'porta :445 aperta'
        : 'non raggiungibile su :445 — handshake WireGuard non completato (endpoint/UDP bloccato sulla rete attuale?) o routing remoto';
      steps[1].dkey = reachable ? 'sync.ts_port_open' : 'sync.ts_unreachable';
      if (!reachable) steps[1].params = { ip: smbConfig.ip };
      if (!reachable) return done(false);

      // 3. Write to the target folder. Forward-slash sub for the Go helper.
      const subFwd = String(smbConfig.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      // BEFORE anything else: can we access the share at all? A failed basic
      // connect reports the REAL problem (share name / credentials / permissions)
      // instead of a misleading "folder already used" from a stale root marker.
      const acc = await this._smb(smbConfig, ['test']);
      if (!acc.ok) {
        // Classify the failure → a SPECIFIC message instead of a generic
        // "check share name, username and password" wall of text. The Go helper
        // prints a stable `SMBERR:<TOKEN>` line (go-smb2's own error text is prose,
        // not a matchable status symbol).
        const out = (acc.err || '') + '\n' + (acc.out || '');
        if (/SMBERR:BAD_NETWORK_NAME/.test(out)) {
          steps[2].detail = `share "${smbConfig.share}" non trovata sul server — controlla il nome della share`;
          steps[2].dkey = 'sync.ts_share_notfound'; steps[2].params = { share: smbConfig.share };
        } else if (/SMBERR:(LOGON_FAILURE|WRONG_PASSWORD|NO_SUCH_USER|ACCOUNT_RESTRICTION|ACCOUNT_DISABLED|ACCOUNT_LOCKED_OUT|PASSWORD_EXPIRED)/.test(out)) {
          steps[2].detail = 'username o password errati';
          steps[2].dkey = 'sync.ts_auth_wrong';
        } else if (/SMBERR:ACCESS_DENIED/.test(out)) {
          steps[2].detail = 'accesso negato — questo utente non ha i permessi per la share';
          steps[2].dkey = 'sync.ts_access_denied';
        } else {
          const eline = (out.match(/SMBERR:\S+/) || [])[0]
            || (acc.err || '').split('\n')[0].slice(0, 120)
            || 'share/credenziali errati';
          steps[2].detail = 'share non accessibile: ' + eline;
          steps[2].dkey = 'sync.ts_share_denied'; steps[2].params = { err: eline };
        }
        return done(false);
      }
      // Credentials and share are VALID — only now check the folder conflicts
      // (with wrong credentials the user must see the auth error, not this).
      // First the folder CONFIGURED for the other purpose (markers may not
      // exist yet if the other side never ran)…
      if (avoid && avoid.share) {
        const norm = (x) => String(x || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
        if (String(avoid.ip || '') === String(smbConfig.ip || '') &&
            norm(avoid.share) === norm(smbConfig.share) &&
            norm(avoid.path)  === norm(smbConfig.path)) {
          steps[2].detail = purpose === 'backup'
            ? 'questa cartella è già configurata per il SYNC — usane una diversa'
            : 'questa cartella è già configurata per il BACKUP — usane una diversa';
          steps[2].dkey = 'sync.ts_conflict_cfg'; steps[2].params = { other: purpose === 'backup' ? 'SYNC' : 'BACKUP' };
          return done(false);
        }
      }
      // …then the on-share claim markers (amelie-backup / .amelie-sync), which
      // also cover folders claimed by OTHER devices. Checked with the FULL path
      // (no `cd`): if the folder doesn't exist the marker simply isn't found —
      // no fallback to the share root.
      if (purpose === 'backup' || purpose === 'sync') {
        // Backup marker is now a dotfile (.amelie-backup) like .amelie-sync;
        // the legacy visible name is still honored on folders marked earlier.
        const markers = purpose === 'backup' ? ['.amelie-sync'] : ['.amelie-backup', 'amelie-backup'];
        for (const marker of markers) {
          const markerPath = subFwd ? `${subFwd}/${marker}` : marker;
          const chk = await this._smb(smbConfig, ['stat', markerPath]);
          let found = false;
          try { found = !!JSON.parse((chk.out || '').trim()).exists; } catch (_) {}
          if (found) {
            steps[2].detail = purpose === 'backup'
              ? 'questa cartella è attualmente usata per il SYNC — scegline un\'altra (o elimina il file ".amelie-sync")'
              : `questa cartella è attualmente usata per il BACKUP — scegline un\'altra (o elimina il file "${marker}")`;
            steps[2].dkey = 'sync.ts_conflict_marker';
            steps[2].params = { other: purpose === 'backup' ? 'SYNC' : 'BACKUP', file: marker };
            return done(false);
          }
        }
      }
      const tmp = path.join(APP_HOME, '.amelie-smbtest');
      try { fs.writeFileSync(tmp, 'amelie-test'); } catch (_) {}
      const t0 = Date.now();
      if (subFwd) await this._smb(smbConfig, ['mkdirp', subFwd]);
      const remoteTest = (subFwd ? subFwd + '/' : '') + '.amelie-test';
      const wr = await this._smb(smbConfig, ['put', tmp, remoteTest]);
      if (wr.ok) await this._smb(smbConfig, ['del', remoteTest]);
      try { fs.unlinkSync(tmp); } catch (_) {}
      steps[2].ok = wr.ok;
      steps[2].detail = wr.ok ? ((Date.now() - t0) + 'ms') : ('fallita: ' + (wr.err || 'autenticazione/permessi?'));
      if (!wr.ok) { steps[2].dkey = wr.err ? 'sync.ts_write_failed' : 'sync.ts_auth_perm'; steps[2].params = { err: wr.err || '' }; }
      return done(wr.ok);
    } catch (e) {
      return done(false);
    } finally {
      // A manual "verify" must NOT change the tunnel the user already had: only
      // tear down a tunnel WE brought up just for the test (and only when the
      // flag doesn't want it up). Leaving an already-active tunnel alone avoids
      // the confusing down→up flap during verify. The flag→tunnel reconciliation
      // for disabled backup/sync happens on config change (ensureVpnTunnel), not
      // as a side effect of testing.
      if (broughtUp && !keepUp) { try { await this._nmDown(); } catch (_) {} }
    }
  }

  // ── Privilege escalation ──────────────────────────────────────────────────

  /**
   * Run a command that needs root.
   * Order of preference:
   *   1. sudo (if NOPASSWD rule exists in /etc/sudoers.d/amelie)
   *   2. pkexec (GUI password prompt — GNOME/KDE polkit)
   *   3. Return helpful error message
   */
  async _runPrivileged(cmd, args) {
    // Check for sudoers rule
    const sudoersFile = '/etc/sudoers.d/amelie';
    const hasSudoersRule = fs.existsSync(sudoersFile);

    if (hasSudoersRule) {
      try {
        const { stdout, stderr } = await execFileAsync('sudo', [cmd, ...args], { timeout: 30000 });
        return { ok: true, stdout, stderr };
      } catch(e) {
        // Fall through to pkexec
      }
    }

    // Try pkexec (polkit GUI prompt)
    if (this._which('pkexec')) {
      try {
        const { stdout, stderr } = await execFileAsync('pkexec', [cmd, ...args], { timeout: 60000 });
        return { ok: true, stdout, stderr };
      } catch(e) {
        const errMsg = e.stderr || e.message || '';
        if (errMsg.includes('dismissed') || errMsg.includes('canceled')) {
          return { ok: false, error: 'Autenticazione annullata dall\'utente.' };
        }
        return { ok: false, error: this._formatPrivilegeError(cmd, e) };
      }
    }

    // Neither available — give setup instructions
    return {
      ok: false,
      error: this._sudoersSetupMessage(cmd)
    };
  }

  _formatPrivilegeError(cmd, e) {
    return `Errore esecuzione ${cmd}: ${e.message || e.stderr || 'sconosciuto'}`;
  }

  /**
   * Returns a helpful message with the sudoers rule to add.
   * User runs this once, then Amelie never asks for password again.
   */
  _sudoersSetupMessage(cmd) {
    const user = os.userInfo().username;
    const wgPath = this._which('wg-quick') || '/usr/bin/wg-quick';
    const mountPath = this._which('mount') || '/usr/bin/mount';
    const umountPath = this._which('umount') || '/usr/bin/umount';

    return `Per usare WireGuard e Samba, Amelie ha bisogno di permessi root.

Esegui questo comando una sola volta nel terminale:

  sudo tee /etc/sudoers.d/amelie << EOF
${user} ALL=(ALL) NOPASSWD: ${wgPath}
${user} ALL=(ALL) NOPASSWD: ${mountPath} -t cifs * /home/${user}/.local/share/amelie/mounts/* -o *
${user} ALL=(ALL) NOPASSWD: ${umountPath} /home/${user}/.local/share/amelie/mounts/*
EOF
  sudo chmod 440 /etc/sudoers.d/amelie

Poi riprova.`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _which(cmd) {
    try { return execSync(`which ${cmd}`, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
    catch(_) { return null; }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { WireGuardManager };
