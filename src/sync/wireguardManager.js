/**
 * WireGuard / OpenVPN Manager for Amelie
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages Amelie's VPN tunnel through NetworkManager (`nmcli`) — the config is
 * imported as an NM connection and brought up/down from there.
 *
 * Security model:
 *   - The .conf/.ovpn files live in <app-data>/vpn/ (chmod 600)
 *   - NO root anywhere: NM authorizes the active session, so nothing here ever
 *     needs sudo/pkexec and the app never pops a password dialog
 *   - Secrets never travel on argv (see _nmSetVpnSecret) and are never logged
 *
 * Requirements: NetworkManager (+ the NetworkManager-openvpn plugin for .ovpn —
 * the app offers to install it). The Samba side needs no kernel mount either:
 * it goes through the bundled `amelie-smb` helper (see _smb).
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
// the user may have. NM derives the interface name from the .conf filename, so
// amelie-wg.conf → interface "amelie-wg". The matching NM connection is named
// "amelie-wg" too (interface-name = amelie-wg).
const WG_CONF     = path.join(VPN_DIR, 'amelie-wg.conf');
const OLD_WG_CONF = path.join(APP_HOME, 'wg-tunnel.conf');   // legacy name (auto-migrated)
const OVPN_CONF   = path.join(VPN_DIR, 'amelie.ovpn');       // OpenVPN alternative (one VPN at a time)
const OVPN_NAME   = 'amelie-ovpn';                           // NM connection id for OpenVPN
// Non-secret credential META (username + whether a password is stored in NM —
// NEVER the password itself) so the UI can show "user + ***" on reopen.
const OVPN_META   = path.join(VPN_DIR, 'amelie-ovpn-meta.json');

class WireGuardManager {
  constructor() {
    this.tunnelActive  = false;
    this.parsedConf    = null;
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
   * Ensure the tunnel is up — via NetworkManager only, so NO password prompt.
   * If there's no Amelie NM connection, we rely on NM autoconnect / the user to
   * bring the VPN up.
   */
  async bringUp() {
    if (await this._isTunnelUp()) return { ok: true, alreadyUp: true };
    if (await this._nmUp())       return { ok: true, viaNm: true };
    return { ok: false, error: 'tunnel non attivo (attivalo da NetworkManager)' };
  }

  /**
   * Name of the WireGuard interface Amelie manages. It's derived from the .conf
   * filename (NM imports it with interface-name = the file's base name), so
   * amelie-wg.conf → interface "amelie-wg".
   */
  _ifaceName() {
    return path.basename(WG_CONF).replace(/\.conf$/i, '');
  }

  /**
   * Latest WireGuard handshake time for our interface. This is a PASSIVE read of
   * kernel state — it does NOT generate any traffic (no ping), so it's the ideal
   * one-shot tunnel-health signal. `wg show` normally needs CAP_NET_ADMIN, so on
   * a plain user session this simply reports { ok:false, reason:'no-perm' } and
   * the UI falls back to showing no handshake age (we never escalate for it).
   * Returns { ok, ts } where ts is the Unix time of the last handshake (0 = none
   * yet).
   */
  async latestHandshake() {
    const iface = this._ifaceName();
    if (!this._which('wg')) return { ok: false, reason: 'no-wg' };
    try {
      const { stdout } = await execFileAsync('wg', ['show', iface, 'latest-handshakes'], { timeout: 5000 });
      const line = (stdout || '').trim().split('\n').filter(Boolean)[0];
      if (!line) return { ok: true, ts: 0 };
      const ts = parseInt(line.split(/\s+/).pop(), 10);
      if (Number.isFinite(ts)) return { ok: true, ts };
    } catch (_) { /* no permission / no interface */ }
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
   * Bring down a leftover Amelie tunnel from a previous run that skipped the
   * normal teardown (crash, kill -9, power loss). Done through NetworkManager —
   * taking the NM connection down also removes the `amelie-wg` netdev — so this
   * NEVER needs root and never pops a password dialog at startup.
   * Best-effort and non-blocking: never throws. Call once on app startup.
   *
   * SAFETY: only Amelie-named NM connections are touched (see _nmAmelieConns),
   * never the user's own tunnels. A stale interface NOT managed by NM (e.g. left
   * behind by an old wg-quick-era version) is only reported — removing it would
   * require root, and Amelie no longer escalates for anything.
   */
  async cleanupStaleTunnels({ keepOwn = false } = {}) {
    // keepOwn = the WireGuard option is enabled → the tunnel is meant to stay
    // up, so don't tear it down at startup.
    if (!keepOwn) {
      try { await this._nmDown(); } catch(_) { /* best-effort */ }
      try {
        if (await this._ifaceExists(this._ifaceName())) {
          console.warn('[WG] Leftover interface not managed by NetworkManager:', this._ifaceName(),
                       '— remove it manually with: sudo ip link delete dev ' + this._ifaceName());
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
   * A leftover DOWN stub counts as NOT up, but _ifaceExists() still sees it for
   * cleanup.
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
   * Clean teardown for app shutdown: bring our tunnel down. Safe to call
   * unconditionally — it's a no-op if nothing is up.
   */
  async shutdown() {
    // Teardown on app close with NO password prompt: bring the tunnel down via
    // NetworkManager only (the active session is already authorized). With NM
    // autoconnect off, _nmDown() sticks (the tunnel won't be auto-re-upped), so
    // the share/network is freed on exit.
    try { await this._nmDown(); } catch(_) {}
  }

  // ── Connectivity tests ─────────────────────────────────────────────────────

  /**
   * Test step 2: verify tunnel is up AND peer is reachable.
   * Best practice: a test must not leave a tunnel lingering. If the test itself
   * brought the tunnel up, it tears it back down on the way out (set
   * keepUp:true only when the caller will keep using the tunnel right after).
   */
  async testTunnel({ host = null, keepUp = false } = {}) {
    // NetworkManager-only test → NO password prompt, consistent with how the
    // tunnel is managed everywhere else. Brings the tunnel up via NM (no-op if
    // already up) and checks reachability THROUGH it.
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

  // ── Samba reachability ────────────────────────────────────────────────────

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
   * Full connection test — entirely via the `amelie-smb` helper (NO mount, NO
   * root, NO password prompt). 4 steps: reachable → connect → folder → write.
   */
  async testFullConnection(smbConfig, { keepUp = false } = {}) {
    const steps = [];
    const wasActive = !!(await this.nmActiveAmelie());
    let broughtUp = false;
    try {
      // 1. Reachability. If not reachable, bring the tunnel up via
      // NetworkManager (no password).
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
      { key: 'wg',    label: 'Connesso via WireGuard',     lkey: 'sync.ts_step_wg',    ok: false, detail: '' },
      { key: 'reach', label: 'Samba share raggiungibile',  lkey: 'sync.ts_step_reach', ok: false, detail: '' },
      { key: 'write', label: 'Scrittura nella cartella',   lkey: 'sync.ts_step_write', ok: false, detail: '' },
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  _which(cmd) {
    try { return execSync(`which ${cmd}`, { stdio: ['ignore','pipe','ignore'] }).toString().trim(); }
    catch(_) { return null; }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { WireGuardManager };
