const fs = require('fs');
const path = require('path');
const { execSync, exec, execFileSync } = require('child_process');
const os = require('os');

/**
 * SyncManager handles bidirectional sync between local notes and:
 * 1. WebDAV servers (Nextcloud, ownCloud, generic WebDAV)
 * 2. Samba/SMB shares (via system mount or WireGuard tunnel)
 *
 * Strategy: Inkwell uses a "last-write-wins" conflict resolution with
 * mtime comparison. For production you could extend this with CRDT/OT.
 */
class SyncManager {
  constructor(notesDir, attachmentsDir, configFile) {
    this.notesDir = notesDir;
    this.attachmentsDir = attachmentsDir;
    this.configFile = configFile;
    this.config = {};
    this.status = 'idle'; // idle | syncing | error | ok
    this.lastSync = null;
    this.webdavClient = null;
  }

  async init() {
    if (fs.existsSync(this.configFile)) {
      try {
        this.config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      } catch (e) {
        console.error('[Sync] Failed to load config:', e);
      }
    }
    this._setupWebDAV();
    // No UNCONDITIONAL backup at startup — the user asked for that and it stands.
    // What runs here is the missed one: the interval timer counts app UPTIME and
    // dies with the app, so half an hour of work, closed, reopened five hours
    // later, never reached an hourly pass and nothing was ever copied. The last
    // successful run is now on disk (nothing survived the process before), so
    // startup can tell an overdue backup from a punctual one.
    this._loadSyncState();
    if (this.config.sync?.enabled) {
      this._startAutoSync();
      this._scheduleCatchUp();
    }
    // Bring the WireGuard tunnel up at startup if the option is enabled.
    this.ensureVpnTunnel();
  }

  reloadConfig(newConfig) {
    // A scheduled backup is skipped when the vault hasn't changed since the last
    // successful one — but that shortcut is only sound while the DESTINATIONS
    // stay the same. Switching a share ON left it empty for as long as the vault
    // sat untouched: the fingerprint still matched a run that had written
    // somewhere else entirely, so every hourly pass skipped and nothing was ever
    // copied to the new destination (silently, since a skip reports no status).
    // Any change to WHERE, or in WHAT FORMAT, the backup writes drops the
    // shortcut so the next scheduled pass actually runs.
    const prevDests = this._backupDestSignature(this.config);
    const prevTargets = this._enabledDestTargets(this.config);
    this.config = newConfig;
    const newTargets = this._enabledDestTargets(newConfig);
    if (this._backupDestSignature(newConfig) !== prevDests) this._lastBackupSig = null;
    this._setupWebDAV();
    this._stopAutoSync();
    if (newConfig.sync?.enabled) {
      this._startAutoSync();
    }
    // Reconcile the WireGuard tunnel with the current flag in EVERY case —
    // including when sync got fully disabled (so disabling WireGuard always
    // brings our tunnel down, and enabling it brings it up).
    this.ensureVpnTunnel();
    // A destination you just switched on gets its FIRST copy right away, instead
    // of at the end of the next interval — and, with an untouched vault, instead
    // of never: the interval run would find nothing changed and skip, leaving a
    // brand-new destination empty for as long as nobody edited a note. Only a
    // destination (or target, or format) that WASN'T being written before earns
    // this; switching one off, or changing the frequency, does not.
    const gained = newTargets.filter(t => !prevTargets.includes(t));
    if (gained.length) this._scheduleFirstBackup(gained);
    else if (!this._anyBackupDestination() && !this._twowayConfigured()) { this._cancelFirstBackup(); this._cancelCatchUp(); }
  }

  /** True when at least one backup destination is enabled. */
  _anyBackupDestination() {
    const s = this.config?.sync || {};
    return !!(s.local?.enabled || s.vpn?.enabled || s.samba?.enabled || s.webdav?.enabled);
  }

  // Settings are autosaved on every toggle and every keystroke, so setting a
  // destination up produces a burst of config reloads. Wait for it to settle and
  // then run ONE backup — re-arming on each new gain, never cancelled by a later
  // reload that gained nothing (that would swallow the run the burst started).
  _FIRST_BACKUP_DELAY_MS = 5000;
  _scheduleFirstBackup(reason) {
    if (this._firstBackupTimer) clearTimeout(this._firstBackupTimer);
    this._firstBackupTimer = setTimeout(() => {
      this._firstBackupTimer = null;
      if (!this._anyBackupDestination()) return;      // switched back off meanwhile
      console.log('[Sync] New backup destination (' + reason.join(', ') + ') — first backup now');
      // force: the vault may be untouched, and this copy still has to be made.
      // manual: false — nobody pressed a button, so the notification reads as the
      // automatic run it is.
      Promise.resolve(this.runBackup({ force: true, manual: false })).catch(() => {});
    }, this._FIRST_BACKUP_DELAY_MS);
  }
  _cancelFirstBackup() {
    if (this._firstBackupTimer) { clearTimeout(this._firstBackupTimer); this._firstBackupTimer = null; }
  }

  // How often a backup is due, in minutes. Historically stored under the LOCAL
  // destination and still read from there so existing settings keep working —
  // which is why it reads oddly when, as here, the local folder is switched off
  // and the share is the one being written. Read in ONE place so the interval
  // timer and the startup catch-up can never disagree about the frequency.
  _backupIntervalMinutes() {
    const min = parseInt(this.config?.sync?.local?.intervalMinutes, 10);
    return (Number.isFinite(min) && min > 0) ? min : 60;
  }

  // The two-way sync's own frequency, read in one place for the same reason.
  _twowayIntervalMinutes() {
    const min = parseInt(this.config?.sync?.twoway?.intervalMinutes, 10);
    return (Number.isFinite(min) && min > 0) ? min : 15;
  }

  // Whether the two-way sync has somewhere to sync WITH — the same condition
  // _startAutoSync uses to decide it deserves a timer at all.
  _twowayConfigured() {
    const tw = this.config?.sync?.twoway || {};
    const hasFolder = tw.smb?.remoteSubPath || tw.subPath || tw.path
      || (tw.transport === 'webdav' && tw.webdav?.url);
    return !!(tw.enabled && hasFolder);
  }

  // When each of the two last succeeded. Kept beside the settings rather than
  // inside them: the renderer rewrites the whole settings file on every toggle and
  // every keystroke, so a value written from here would be raced away.
  _syncStatePath() { return path.join(path.dirname(this.configFile), 'sync-state.json'); }

  _loadSyncState() {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(this._syncStatePath(), 'utf8')); } catch (_) {}
    this._syncState = st;
    // Carry the unchanged-vault shortcut across restarts, but ONLY while the
    // destinations are still the ones that run wrote to — the same reasoning as
    // reloadConfig. Without this the vault fingerprint started empty every launch
    // and an untouched vault was copied again on every catch-up, spending the
    // keepLast slots on identical snapshots.
    if (st && st.dests === this._backupDestSignature(this.config)) {
      this._lastBackupSig = st.vaultSig || null;
    }
    return st;
  }

  // Merged, never wholesale: the backup and the two-way sync each stamp their own
  // key, and one finishing must not erase the other's record.
  _updateSyncState(patch) {
    // Merged against what is on DISK, not just against what this instance happens
    // to hold: main rebuilds the SyncManager on a vault switch, and an instance
    // that never loaded the file would otherwise write its own key and silently
    // drop the other one's.
    let onDisk = null;
    try { onDisk = JSON.parse(fs.readFileSync(this._syncStatePath(), 'utf8')); } catch (_) {}
    const next = Object.assign({}, onDisk || {}, this._syncState || {}, patch);
    this._syncState = next;
    try {
      fs.writeFileSync(this._syncStatePath(), JSON.stringify(next, null, 1));
    } catch (e) {
      // Not fatal: the run itself succeeded. It only means the next start cannot
      // tell whether one is overdue, and will make one up to be safe.
      console.error('[Sync] could not record the run time:', e.message);
    }
  }

  _recordBackupState(vaultSig) {
    this._updateSyncState({
      lastBackupAt: new Date().toISOString(),
      vaultSig,
      dests: this._backupDestSignature(this.config),
    });
  }

  _recordTwowayState() {
    this._updateSyncState({ lastTwowayAt: new Date().toISOString() });
  }

  // How long past due a run is, in ms. No record at all counts as overdue: it is
  // either a first run under this version or an unreadable file, and making one
  // extra copy is the safe way to be wrong.
  _overdueBy(stamp, minutes) {
    const at = Date.parse(this._syncState?.[stamp] || '');
    if (!Number.isFinite(at)) return { overdue: true, sinceMin: null };
    return { overdue: Date.now() - (at + minutes * 60 * 1000) >= 0,
             sinceMin: Math.round((Date.now() - at) / 60000) };
  }

  // Runs missed while the app was closed, made up shortly after launch.
  //
  // The backup catch-up is NOT forced: an untouched vault still skips, so
  // restarting five times over an idle vault does not spend five of the keepLast
  // snapshots on identical copies. The two-way sync has no such shortcut — it has
  // to reach the remote to find out whether anything came in — so an overdue one
  // always runs.
  //
  // They run in SEQUENCE, never together: _busy() rejects a second run while one
  // is in flight ("Already syncing"), which would turn the loser into an error in
  // the bell. Awaiting the first is what keeps a slow backup from doing that to
  // the sync behind it.
  _CATCH_UP_DELAY_MS = 30000;
  _scheduleCatchUp() {
    this._cancelCatchUp();
    const jobs = [];

    if (this._anyBackupDestination()) {
      const min = this._backupIntervalMinutes();
      const { overdue, sinceMin } = this._overdueBy('lastBackupAt', min);
      if (overdue) {
        console.log(sinceMin == null
          ? '[Sync] No record of a previous backup — catching up'
          : `[Sync] Last backup ${sinceMin} min ago, past the ${min} min interval — catching up`);
        jobs.push({ what: 'backup', run: () => this._anyBackupDestination() && this.runBackup({ manual: false }) });
      } else {
        console.log(`[Sync] Last backup ${sinceMin} min ago — under the ${min} min interval, nothing to catch up`);
      }
    }

    if (this._twowayConfigured()) {
      const min = this._twowayIntervalMinutes();
      const { overdue, sinceMin } = this._overdueBy('lastTwowayAt', min);
      if (overdue) {
        console.log(sinceMin == null
          ? '[Sync] No record of a previous two-way sync — catching up'
          : `[Sync] Last two-way sync ${sinceMin} min ago, past the ${min} min interval — catching up`);
        jobs.push({ what: 'twoway', run: () => this._twowayConfigured() && this.runTwoway({ manual: false }) });
      } else {
        console.log(`[Sync] Last two-way sync ${sinceMin} min ago — under the ${min} min interval, nothing to catch up`);
      }
    }

    if (!jobs.length) return;
    this._catchUpTimer = setTimeout(async () => {
      this._catchUpTimer = null;
      for (const job of jobs) {
        // Re-checked at the moment it fires: the destination may have been
        // switched off during the wait.
        try { await job.run(); } catch (e) { console.error(`[Sync] catch-up ${job.what} failed:`, e && e.message); }
      }
    }, this._CATCH_UP_DELAY_MS);
  }

  _cancelCatchUp() {
    if (this._catchUpTimer) { clearTimeout(this._catchUpTimer); this._catchUpTimer = null; }
  }

  _stopTimers() {
    if (this._backupTimer) { clearInterval(this._backupTimer); this._backupTimer = null; }
    if (this._twowayTimer) { clearInterval(this._twowayTimer); this._twowayTimer = null; }
  }

  // SMB/WebDAV passwords are stored encrypted at rest as { __sec } (OS keyring)
  // or { __enc } (app-level key when the keyring is unavailable) — see
  // credCrypto.js. Tolerant: the in-memory config may hold either the encrypted
  // object (loaded from disk) or a plaintext string (just set from the
  // renderer). Decrypt only at the point of use.
  _decSecret(v) {
    return require('../main/credCrypto').decSecret(v);
  }

  _setupWebDAV() {
    const cfg = this.config?.sync?.webdav;
    if (cfg?.enabled && cfg.url) {
      try {
        const { createClient } = require('webdav');
        this.webdavClient = createClient(cfg.url, {
          username: cfg.username || '',
          password: this._decSecret(cfg.password) || '',
        });
        console.log('[Sync] WebDAV client initialized:', cfg.url);
      } catch (e) {
        console.error('[Sync] WebDAV init failed:', e);
        this.webdavClient = null;
      }
    } else {
      this.webdavClient = null;
    }
  }

  _startAutoSync() {
    this._stopTimers();
    const s = this.config.sync || {};
    // Backup timer (one-way: local / WireGuard+Samba / WebDAV) on the backup
    // frequency (default hourly — a sensible backup cadence).
    const backupOn = s.local?.enabled || s.vpn?.enabled || s.samba?.enabled || s.webdav?.enabled;
    if (backupOn) {
      const min = this._backupIntervalMinutes();
      this._backupTimer = setInterval(() => this.runBackup(), min * 60 * 1000);
      console.log(`[Sync] Backup every ${min} min`);
    }
    // Two-way sync timer on its own (shorter) frequency. The remote folder comes
    // from the connection (smb.remoteSubPath) or a legacy local path/subPath.
    const twHasFolder = s.twoway?.smb?.remoteSubPath || s.twoway?.subPath || s.twoway?.path
      || (s.twoway?.transport === 'webdav' && s.twoway?.webdav?.url);
    if (s.twoway?.enabled && twHasFolder) {
      const min = this._twowayIntervalMinutes();
      this._twowayTimer = setInterval(() => this.runTwoway(), min * 60 * 1000);
      console.log(`[Sync] Two-way sync every ${min} min`);
    }
  }

  _stopAutoSync() {
    this._stopTimers();
  }

  // True when encryption-at-rest is OFF and the vault is currently DECRYPTED on
  // disk ("plaintext while open"). Set by main on unlock / rest-mode change. In
  // this state ALL sync/backup is PAUSED so plaintext never leaves to the share —
  // the share stays encrypted. Syncing resumes once encryption-at-rest is back on.
  _syncPausedPlaintext() {
    if (this._plaintextOpen) { console.log('[Sync] paused: encryption-at-rest is OFF (vault plaintext while open) — keeping the share encrypted'); return true; }
    return false;
  }

  scheduleSync() {
    if (this._plaintextOpen) return;   // no realtime push while the vault is plaintext
    // The two-way Sync always runs on its interval timer. It ALSO syncs on each
    // edit (debounced) ONLY when the "realtime" option is on — otherwise it does
    // NOT trigger on note creation / edits / folder drops.
    const tw = this.config.sync?.twoway;
    if (!tw?.enabled || !tw?.realtime) return;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.runTwoway(), 8000);
  }

  // Scheduled backup (one-way: local → remote, plus WireGuard/WebDAV).
  // force=true (manual "Esegui backup ora") always runs; scheduled runs skip
  // when the vault hasn't changed since the last successful backup.
  // `manual` decides only the wording in the notifications bell, and defaults to
  // following `force` (the "Back up now" button is the usual forced run). The
  // first backup of a freshly enabled destination forces WITHOUT being manual —
  // nobody pressed anything — so it must be able to say so.
  async runBackup({ force = false, manual = force } = {}) {
    if (this._syncPausedPlaintext()) return { success: false, skipped: true, plaintextOpen: true, error: 'Cifratura a riposo disattivata: backup in pausa per non esporre i file in chiaro. Riattiva "Cifra i file a riposo".' };
    if (this._busy()) return { success: false, error: 'Already syncing' };
    // No enabled destination → don't pretend "backup complete". Tell the user.
    const s = this.config.sync || {};
    const anyEnabled = !!(s.local?.enabled || this._sambaConfig() || s.webdav?.enabled);
    if (!anyEnabled) {
      this._setStatus('idle');
      return { success: false, noDestination: true,
        error: 'Nessuna destinazione di backup attiva: attiva "VPN with Samba share" (o Locale/WebDAV) nelle impostazioni Backup.' };
    }
    const sig = this._vaultSignature();
    if (!force && this._lastBackupSig && sig === this._lastBackupSig) {
      console.log('[Sync] Vault unchanged — automatic backup skipped');
      // Say so, once. A skip used to be entirely silent, which is indistinguishable
      // from a backup that never ran at all — the question this answers is "why is
      // there nothing new on the share?". Only the FIRST of a run of skips is
      // reported: an app left open all day over an untouched vault would otherwise
      // file the same line every hour and bury everything else in the bell.
      if (!this._skipNotified) {
        this._skipNotified = true;
        this._setStatus('ok', null, { op: 'backup', manual: !!manual, unchanged: true });
      }
      return { success: true, skipped: true };
    }
    this._skipNotified = false;
    const meta = { op: 'backup', manual: !!manual };
    this._setStatus('syncing', null, meta);
    console.log('[Sync] Backup run...', force ? '(forced)' : '');
    try {
      const results = await this._runBackupInner();
      this.lastSync = new Date().toISOString();
      // A destination that failed (e.g. Samba mount) is recorded as { error }
      // inside results without aborting the others. Surface those so the UI
      // doesn't report "complete" when a target actually failed.
      const errs = [];
      for (const [dest, r] of Object.entries(results)) {
        if (r && typeof r === 'object' && r.error) errs.push(`${dest}: ${r.error}`);
      }
      if (errs.length) {
        const msg = errs.join(' · ');
        this._setStatus('error', msg, meta);
        return { success: false, error: msg, results, lastSync: this.lastSync };
      }
      this._lastBackupSig = sig;   // remember success → skip next time if unchanged
      this._recordBackupState(sig);   // and on disk, so the next start knows if one is overdue
      // Tell the renderer WHICH destinations were written, so the notification can
      // name them. "Backup completed" alone is ambiguous when more than one
      // destination exists: a run that only wrote the local folder looked exactly
      // like one that also reached the share.
      meta.dests = SyncManager._writtenDests(results);
      this._setStatus('ok', null, meta);
      return { success: true, results, lastSync: this.lastSync };
    } catch (e) {
      console.error('[Sync] Backup failed:', e);
      this._setStatus('error', e.message, meta);
      return { success: false, error: e.message };
    }
  }

  /**
   * Fingerprint of WHERE a backup writes: which destinations are enabled, the
   * target each one points at, and the formats requested (a dated folder and/or
   * a .tar.gz). Compared across a config reload to decide whether the
   * "vault unchanged → skip" shortcut still covers what is now configured:
   * turning on a share, repointing one at another folder, or asking for the
   * archive alongside the folder all mean the previous run's output no longer
   * does. Deliberately ignores everything else in the config (frequency, how
   * many copies to keep, two-way sync) — those don't change what gets written.
   */
  _backupDestSignature(cfg) {
    const s = (cfg && cfg.sync) || {};
    const l = s.local || {}, w = s.webdav || {}, v = s.vpn || {}, sa = s.samba || {};
    const smb = v.smb || {};
    const fmt = (d) => [d.folder !== false, !!d.archive, !!d.archiveOnly];
    return JSON.stringify([
      !!l.enabled, l.path || '', fmt(l),
      !!w.enabled, w.url || '', w.remotePath || '', fmt(w),
      !!v.enabled, smb.ip || v.peerIp || '', smb.share || '', smb.path || v.remotePath || '', fmt(v),
      !!sa.enabled, sa.host || sa.ip || '', sa.share || '', sa.remoteSubPath || '',
    ]);
  }

  /**
   * One string per ENABLED destination, describing what it writes and where.
   * Comparing two of these lists tells whether the backup gained somewhere new
   * to write (a destination switched on, repointed, or asked for another format)
   * as opposed to merely losing one or being reconfigured in ways that don't
   * change its output.
   */
  _enabledDestTargets(cfg) {
    const s = (cfg && cfg.sync) || {};
    const out = [];
    const fmt = (d) => `folder=${d.folder !== false}:archive=${!!d.archive}:only=${!!d.archiveOnly}`;
    const l = s.local || {}, w = s.webdav || {}, v = s.vpn || {}, sa = s.samba || {};
    if (l.enabled) out.push(`local|${l.path || ''}|${fmt(l)}`);
    if (w.enabled) out.push(`webdav|${w.url || ''}|${w.remotePath || ''}|${fmt(w)}`);
    if (v.enabled) {
      const smb = v.smb || {};
      out.push(`samba|${smb.ip || v.peerIp || ''}|${smb.share || ''}|${smb.path || v.remotePath || ''}|${fmt(v)}`);
    } else if (sa.enabled) {
      out.push(`samba|${sa.host || sa.ip || ''}|${sa.share || ''}|${sa.remoteSubPath || ''}|${fmt(v)}`);
    }
    return out;
  }

  /**
   * Which destinations actually WROTE in this run, as stable keys the renderer
   * turns into names ('local' | 'samba' | 'webdav'). A destination that was
   * skipped (e.g. Samba with both backup formats off) or returned an empty
   * result wrote nothing, so it must not be named — the notification would
   * otherwise claim a copy that doesn't exist.
   */
  static _writtenDests(results) {
    const wrote = (r) => !!r && !r.error && !r.skipped
      && (typeof r !== 'object' || Object.keys(r).length > 0);
    const out = [];
    if (wrote(results.local)) out.push('local');
    if (wrote(results.webdav) || wrote(results.webdavArchive)) out.push('webdav');
    if (wrote(results.samba)) out.push('samba');
    return out;
  }

  /**
   * Cheap fingerprint of the vault: file count + total size + newest mtime.
   * Any add/edit/delete changes it. Used to skip redundant scheduled backups.
   */
  _vaultSignature() {
    let count = 0, size = 0, maxMtime = 0;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { try { const st = fs.statSync(p); count++; size += st.size; if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs; } catch (_) {} }
      }
    };
    walk(this.notesDir);
    // Attachments count as the vault changing. The backup copies them (putdir of
    // attachmentsDir alongside notes), but the fingerprint used to describe the
    // notes alone — so a batch of photos or recordings added without touching a
    // single note left the fingerprint identical, every scheduled run skipped,
    // and those files reached no destination until some note happened to change.
    walk(this.attachmentsDir);
    return `${count}:${size}:${Math.round(maxMtime)}`;
  }

  // Scheduled two-way sync (read remote + update local + push).
  // `manual` distinguishes the toolbar Sync button from the scheduled run — only
  // the label in the notifications bell depends on it.
  async runTwoway({ manual = false } = {}) {
    if (this._syncPausedPlaintext()) return { success: false, skipped: true, plaintextOpen: true, error: 'Cifratura a riposo disattivata: sync in pausa per non esporre i file in chiaro sullo share. Attiva "Cifra i file a riposo" nelle impostazioni Vault per sincronizzare.' };
    if (this._busy()) return { success: false, error: 'Already syncing' };
    if (!this.config.sync?.twoway?.enabled) return { success: false, error: 'Two-way disabled' };
    const meta = { op: 'twoway', manual: !!manual };
    this._setStatus('syncing', null, meta);
    console.log('[Sync] Two-way run...');
    try {
      const twoway = await this._syncTwoway();
      this.lastSync = new Date().toISOString();
      this._recordTwowayState();   // so the next start knows if one is overdue
      this._setStatus('ok', null, meta);
      return { success: true, results: { twoway }, lastSync: this.lastSync };
    } catch (e) {
      console.error('[Sync] Two-way failed:', e);
      this._setStatus('error', e.message, meta);
      return { success: false, error: e.message };
    }
  }

  /**
   * Normalize the WireGuard/Samba backup destination into a single shape.
   * The settings UI saves it under `sync.vpn` (with `vpn.smb.*`), while the
   * backup engine works in terms of a `samba` config. Support both, preferring
   * an explicit `sync.samba` if present, else mapping from `sync.vpn`.
   * Returns null when not enabled.
   */
  /**
   * Make the WireGuard tunnel follow the backup WireGuard flag — entirely via
   * NetworkManager:
   *   - option ON  → if the share isn't reachable, bring up the Amelie NM
   *                  connection (NM autoconnect usually already did it).
   *   - option OFF → bring the Amelie NM connection down.
   */
  async ensureVpnTunnel() {
    const scfg = this._sambaConfig();
    const tw = this.config.sync?.twoway;
    // The tunnel should be up whenever EITHER the backup WG flag OR the two-way
    // sync flag (with a WG+Samba connection) is on — toggling the flag is what
    // activates the tunnel.
    const twoWantsUp = !!(tw && tw.enabled && tw.useWireGuard && tw.transport !== 'webdav' && this._twowaySambaConn());
    // A backup destination with BOTH formats off has nothing to write — don't
    // bring the tunnel up just for it (only two-way sync would, above).
    const backupHasContent = !!(scfg && !(scfg.folder === false && !scfg.archive && !scfg.archiveOnly));
    const wantUp = !!((scfg && scfg.enabled && scfg.useWireGuard && backupHasContent) || twoWantsUp);
    try {
      const { WireGuardManager } = require('./wireguardManager');
      const wg = new WireGuardManager();
      wg.loadSavedConf();
      // THE FLAG COMMANDS THE TUNNEL, in both directions: flag on → up (when
      // needed), flag off → down. Amelie's NM connections are imported with
      // autoconnect=no, so a down sticks (no flapping — the old reason for
      // never auto-downing no longer applies).
      if (wantUp) {
        // Bring the tunnel up ONLY if the share isn't reachable directly. On the
        // share's own LAN (e.g. at home) the direct route is used and the tunnel
        // stays down — routing LAN traffic through the VPN would hairpin out and
        // back (drastically slower, large uploads time out). Off its LAN (e.g. at
        // work) the share isn't directly reachable, so the tunnel comes up.
        const host = (scfg && (scfg.host || scfg.ip)) || (twoWantsUp && (() => { const c = this._twowaySambaConn(); return c && (c.host || c.ip); })());
        const mode = await wg.ensureBestPath(host || null);
        console.log('[Sync] VPN tunnel: path →', mode);
      } else {
        // Flag off → the VPN must be OFF (only touches amelie-named connections).
        const downed = await wg._nmDown();
        if (downed) console.log('[Sync] VPN tunnel: flag off → brought down');
      }
    } catch (e) {
      console.warn('[Sync] ensureVpnTunnel:', e.message);
    }
  }

  _sambaConfig() {
    const s = this.config.sync || {};
    // The legacy `sync.samba` mirror holds only the connection — the backup
    // MODE prefs (folder snapshot / .tar.gz archive) live under sync.vpn.
    // Merge them in, or the toggles would be silently ignored on this path.
    if (s.samba && s.samba.enabled) {
      const v = s.vpn || {};
      const r = { folder: v.folder, archive: !!v.archive, archiveOnly: !!v.archiveOnly, ...s.samba };
      r.password = this._decSecret(r.password);
      return r;
    }
    const v = s.vpn;
    if (v && v.enabled) {
      const smb = v.smb || {};
      return {
        enabled:      true,
        useWireGuard: true,                         // the "vpn" destination = Samba over WireGuard
        host:         smb.ip || v.peerIp,
        ip:           smb.ip || v.peerIp,
        share:        smb.share,
        remoteSubPath: smb.path || v.remotePath || 'amelie/backup',
        username:     smb.username,
        password:     this._decSecret(smb.password),
        folder:       v.folder,            // false = folder snapshot OFF
        archive:      !!v.archive,
        archiveOnly:  !!v.archiveOnly,
        keepLast:     parseInt(v.keepLast) || parseInt(s.local?.keepLast) || 5,
      };
    }
    return null;
  }

  // Samba connection used by TWO-WAY sync. Independent from the backup: prefer a
  // dedicated `sync.twoway.smb` (set up from the Sync tab, no backup enabled),
  // then fall back to the backup's Samba/VPN connection (legacy/shared setups).
  // Only needs host/share/credentials — no "enabled" flag required.
  _twowaySambaConn() {
    const s = this.config.sync || {};
    const tw = s.twoway || {};
    const cand = tw.smb
      || (s.samba && (s.samba.host || s.samba.ip) ? s.samba : null)
      || (s.vpn && s.vpn.smb ? { ...s.vpn.smb, host: s.vpn.smb.ip || s.vpn.peerIp, ip: s.vpn.smb.ip || s.vpn.peerIp } : null);
    if (!cand) return null;
    const host = cand.host || cand.ip;
    const share = cand.share;
    if (!host || !share) return null;
    return {
      enabled:       true,
      useWireGuard:  true,
      host, ip: host, share,
      username:      cand.username,
      password:      this._decSecret(cand.password),
      remoteSubPath: cand.remoteSubPath || cand.path || '',
    };
  }

  async _runBackupInner() {
    const results = { webdav: null, samba: null, local: null };
    // WebDAV sync
    if (this.config.sync?.webdav?.enabled && this.webdavClient) {
      const wcfg = this.config.sync.webdav;
      // Folder sync unless "archive only" OR the folder snapshot is explicitly off.
      if (wcfg.folder !== false && !wcfg.archiveOnly) results.webdav = await this._syncWebDAV();
      if (wcfg.archive) results.webdavArchive = await this._archiveToWebDAV();
    }
    // Local folder backup (one-way) (+ tar.gz if requested)
    if (this.config.sync?.local?.enabled) {
      results.local = await this._syncLocal();
    }
    // Samba / WireGuard share — config lives under sync.vpn (or legacy sync.samba).
    const scfg = this._sambaConfig();
    if (scfg && scfg.enabled) {
      // BOTH backup modes off (no folder snapshot, no archive) → nothing to
      // write. This is now a VALID state (the user can turn off both formats to
      // stop backup content), so SKIP quietly — no error notification, and don't
      // bring the tunnel up for nothing.
      if (scfg.folder === false && !scfg.archive && !scfg.archiveOnly) {
        results.samba = { skipped: true, reason: 'no-backup-mode' };
      } else if (scfg.useWireGuard) {
        try {
          // Pick the FASTEST path: if the share is reachable directly (you're on
          // its LAN, e.g. at home) use the direct route — going through the WG
          // tunnel would hairpin out to the internet and back, ~14000x slower,
          // and the large .tar.gz upload would time out. Only use the tunnel when
          // the share ISN'T directly reachable (e.g. at work, another network).
          const { WireGuardManager } = require('./wireguardManager');
          const wg = new WireGuardManager();
          wg.loadSavedConf();
          const host = scfg.host || scfg.ip;
          const mode = await wg.ensureBestPath(host);
          console.log('[Sync] Samba backup path →', mode);
          if (mode === 'tunnel' && host && !await wg._waitReachable(host, 445)) {
            results.samba = { error: 'Share non raggiungibile nel tunnel (riprova tra qualche secondo).' };
          } else if (mode === 'none') {
            results.samba = { error: 'Share non raggiungibile (né direttamente né via tunnel).' };
          } else {
            results.samba = await this._syncSamba(scfg);
          }
        } catch (e) {
          console.error('[Sync] WireGuard+Samba sync failed:', e.message);
          results.samba = { error: e.message };
        }
      } else {
        results.samba = await this._syncSamba(scfg);
      }
    }
    return results;
  }

  // Two-way sync. Two modes:
  //  - useWireGuard: reuse the SAME WireGuard+Samba connection as the backup and
  //    two-way sync a DIFFERENT folder on the share (via smbclient, no mount).
  //  - legacy: a local/mounted folder path (bidirectional rsync engine).
  async _syncTwoway() {
    const cfg = this.config.sync?.twoway;
    if (!cfg || !cfg.enabled) throw new Error('Two-way: disabilitato');

    // WebDAV transport (e.g. Nextcloud) — independent of WireGuard/Samba.
    if (cfg.transport === 'webdav' && cfg.webdav && cfg.webdav.url) {
      const out = await this._twowayWebdav(cfg.webdav);
      console.log('[Two-way] WebDAV', out);
      return out;
    }

    if (cfg.useWireGuard) {
      // Two-way uses its OWN WireGuard+Samba connection, independent of the
      // backup: you can sync WITHOUT enabling any backup. Falls back to the
      // backup's Samba connection if a dedicated one isn't set (legacy setups).
      const smb = this._twowaySambaConn();
      if (!smb || !(smb.host || smb.ip) || !smb.share) throw new Error('Two-way: WireGuard+Samba non configurato (configuralo qui nel tab Sync).');
      // The sync folder is the connection's own remote folder (the "Cartella
      // remota" entered in setup). Legacy configs may still carry cfg.subPath.
      const sub = String(smb.remoteSubPath || cfg.subPath || '').trim();
      if (!sub) throw new Error('Two-way: indica la cartella remota nella connessione.');
      // Fastest path: direct if the share is reachable without the tunnel (e.g.
      // on its LAN at home), otherwise bring the tunnel up. Same logic as backup.
      try { const { WireGuardManager } = require('./wireguardManager'); const wg = new WireGuardManager(); const mode = await wg.ensureBestPath(smb.host || smb.ip); console.log('[Two-way] Path →', mode); } catch (_) {}
      // Refuse a folder already claimed by Backup.
      if (await this._smbHasFile(smb, sub, SyncManager._MARK_BACKUP) || await this._smbHasFile(smb, sub, 'amelie-backup')) throw new Error('Two-way: questa cartella è usata per il BACKUP — scegline un\'altra o elimina il file ".amelie-backup".');
      const out = await this._twowaySamba(smb, sub);
      // Claim the folder for Sync.
      try { await this._smbWriteFile(smb, sub, SyncManager._MARK_SYNC); } catch (_) {}
      console.log('[Two-way] Samba', out);
      return out;
    }

    if (!cfg.path) throw new Error('Two-way: percorso remoto mancante');
    if (!fs.existsSync(cfg.path)) fs.mkdirSync(cfg.path, { recursive: true });
    const out = await this._syncToMountPoint(cfg.path, 'amelie', { twoway: true });
    console.log('[Two-way] done', out);
    return out;
  }

  // Self-describing marker files that claim a share folder for ONE purpose, so
  // the other purpose refuses it. Backup writes `amelie-backup`; Sync writes
  // `.amelie-sync`. Each explains how to repurpose the folder (delete the file).
  static get _MARK_BACKUP() { return '.amelie-backup'; }   // dotfile, like .amelie-sync (legacy 'amelie-backup' still honored)
  static get _MARK_SYNC()   { return '.amelie-sync'; }
  static get _MARK_TEXT() {
    return {
      '.amelie-backup': 'This folder is used by Amelie as a BACKUP repository (notes, attachments, dated snapshots and .tar.gz archives).\nTo use this folder for another purpose, DELETE this file.\n',
      '.amelie-sync':  'This folder is used by Amelie for two-way SYNC of your notes.\nTo use this folder for another purpose, DELETE this file.\n',
    };
  }

  // ── SMB via the bundled `amelie-smb` helper (Go, SMB2/3 + encryption) ────────
  // Replaces the external `smbclient` binary: one static ~3.5MB binary shipped in
  // the AppImage → no install, no root, and SMB3 works even on encryption-required
  // servers. Credentials go through the ENVIRONMENT (never argv → never in ps/proc).

  /** Path of the bundled helper (packaged in <resources>/amelie-smb, or the repo
   * copy in dev). Returns null if missing. */
  _smbHelperBin() {
    if (this.__smbBin !== undefined) return this.__smbBin;
    const cands = [];
    try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'amelie-smb')); } catch (_) {}
    cands.push(path.join(__dirname, '..', '..', 'smb-helper', 'amelie-smb'));   // dev (not in the asar)
    this.__smbBin = null;
    for (const c of cands) { try { if (fs.existsSync(c)) { this.__smbBin = c; break; } } catch (_) {} }
    return this.__smbBin;
  }

  /** Run the helper with a subcommand. Credentials injected via env (not argv).
   * Returns stdout. Throws on failure (stderr in the message). */
  async _smb(cfg, args, opts = {}) {
    const bin = this._smbHelperBin();
    if (!bin) throw new Error('amelie-smb (SMB helper) non disponibile');
    const { execFile } = require('child_process');
    const execFileAsync = require('util').promisify(execFile);
    const env = {
      ...process.env,
      AMELIE_SMB_HOST:   String(cfg.host || cfg.ip || ''),
      AMELIE_SMB_PORT:   String(cfg.port || 445),
      AMELIE_SMB_SHARE:  String(cfg.share || ''),
      AMELIE_SMB_USER:   String(cfg.username || ''),
      AMELIE_SMB_PASS:   String(cfg.password || ''),
      AMELIE_SMB_DOMAIN: String(cfg.domain || 'WORKGROUP'),
    };
    const { stdout } = await execFileAsync(bin, args, {
      env, timeout: opts.timeout || 120000, maxBuffer: opts.maxBuffer || 64 * 1024 * 1024,
    });
    return stdout;
  }

  /** Same as _smb but parses the JSON the helper prints (list/listr/stat). */
  async _smbJson(cfg, args, opts = {}) {
    const out = await this._smb(cfg, args, opts);
    try { return JSON.parse(out); } catch (_) { return null; }
  }

  /** Write a claim-marker file (with its README text) into a folder on the share. */
  async _smbWriteFile(cfg, subPath, filename) {
    const tmp = path.join(os.homedir(), '.local', 'share', 'amelie', 'tmp');
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
    const local = path.join(tmp, filename);
    try { fs.writeFileSync(local, SyncManager._MARK_TEXT[filename] || ''); } catch (_) {}
    const remote = String(subPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' + filename;
    try { await this._smb(cfg, ['put', local, remote], { timeout: 30000 }); } catch (_) {}
  }

  /** Does `subPath` on the share contain `filename`? (used for the backup/sync claim) */
  async _smbHasFile(cfg, subPath, filename) {
    const remote = String(subPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') + '/' + filename;
    try {
      const r = await this._smbJson(cfg, ['stat', remote], { timeout: 30000 });
      return !!(r && r.exists);
    } catch (_) { return false; }
  }

  /** WebDAV equivalents of _smbHasFile/_smbWriteFile — same backup/sync folder claim. */
  async _webdavHasFile(client, base, filename) {
    try { return !!(await client.exists(base.replace(/\/+$/, '') + '/' + filename)); } catch (_) { return false; }
  }
  async _webdavWriteFile(client, base, filename) {
    try { await client.putFileContents(base.replace(/\/+$/, '') + '/' + filename, SyncManager._MARK_TEXT[filename] || '', { overwrite: true }); } catch (_) {}
  }

  // ─── Archive (.tar.gz of the full vault: notes + attachments) ──────────────

  async createArchive(destDir) {
    if (!destDir) throw new Error('createArchive: destinazione mancante');
    const tar = require('tar');
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const file = path.join(destDir, `amelie-vault-${ts}.tar.gz`);
    const vaultDir = path.dirname(this.notesDir);   // <vault>; notes/ + attachments/ are siblings here
    // Bundle notes/ AND attachments/ (images, PDFs — they live at the vault root,
    // siblings of notes/, since the attachment-location migration). Without
    // attachments the .tar.gz would silently omit every image/PDF on restore.
    const entries = ['notes'];
    if (fs.existsSync(path.join(vaultDir, 'attachments'))) entries.push('attachments');
    // Also bundle the envelope header (.amelie-vault.json) so a restored archive
    // on another PC carries the wrapped DEK + salt and can be unlocked.
    if (fs.existsSync(path.join(vaultDir, '.amelie-vault.json'))) entries.push('.amelie-vault.json');
    // Defence-in-depth: NEVER pack a credential/password file even if one somehow
    // sits inside the vault (they normally live in ~/.local/share/amelie, outside).
    await tar.c({ gzip: true, file, cwd: vaultDir, filter: (p) => !SyncManager._SENSITIVE_NAMES.has(String(p).split('/').pop()) }, entries);
    console.log('[Archive] Created', file);
    return file;
  }

  // Local backup to a folder (and/or .tar.gz). ONE-WAY: local → remote.
  // - "Archive only"   → just the .tar.gz (rotated by keepLast).
  // - normal folder    → a SNAPSHOT in a dated folder <path>/<YYYY-MM-DD>/
  //   containing notes/ and attachments/. Dated folders are rotated (keepLast)
  //   so daily snapshots don't accumulate forever.
  // - both flags       → does both the dated snapshot and the .tar.gz.
  async _syncLocal() {
    const cfg = this.config.sync.local;
    if (!cfg || !cfg.path) throw new Error('Local: percorso mancante');
    if (!fs.existsSync(cfg.path)) fs.mkdirSync(cfg.path, { recursive: true });
    const out = {};

    // .tar.gz archive (if "archive" or "archive only").
    if (cfg.archive || cfg.archiveOnly) {
      out.archive = path.basename(await this.createArchive(cfg.path));
      this._pruneArchives(cfg.path, cfg.keepLast);
    }

    // Dated folder snapshot (unless "archive only" OR the folder snapshot is
    // explicitly off — folder===false lets the user disable BOTH formats).
    if (cfg.folder !== false && !cfg.archiveOnly) {
      const dated = this._snapshotName();   // e.g. amelie-vault-2026-06-20_19-48-00
      out.folder = await this._syncToMountPoint(cfg.path, dated, { oneWay: true });
      out.folder.dateFolder = dated;
      this._pruneDatedFolders(cfg.path, cfg.keepLast);
    }

    // Clean up old layout (fixed amelie/inkwell folder, before dated snapshots).
    for (const stale of ['amelie', 'inkwell']) {
      const d = path.join(cfg.path, stale);
      try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }

    console.log('[Local] Backup done', out);
    return out;
  }

  /**
   * Timestamp YYYY-MM-DD_HH-MM-SS — names a snapshot folder. Including the time
   * means each backup is its own snapshot you can tell apart at a glance; since
   * scheduled backups are skipped when the vault is unchanged (_vaultSignature),
   * a new snapshot only appears when something actually changed.
   */
  _dateStamp() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  }

  // Snapshot folder name: the dated stamp carrying the SAME "amelie-vault-" prefix
  // the .tar.gz archives use, so folder and archive backups are named alike
  // (e.g. amelie-vault-2026-06-20_19-48-00).
  _snapshotName() { return `amelie-vault-${this._dateStamp()}`; }

  // Matches a snapshot folder name: the new "amelie-vault-" prefix (optional, so
  // legacy date-only folders are still recognised) + YYYY-MM-DD with an optional
  // _HH-MM-SS suffix. Retention uses this to clean up both old and new layouts.
  static get _SNAPSHOT_RE() { return /^(amelie-vault-)?\d{4}-\d{2}-\d{2}(_\d{2}-\d{2}-\d{2})?$/; }

  /**
   * Retention for dated snapshot folders (YYYY-MM-DD) under baseDir: keep only the
   * newest `keepLast`, delete the rest. Strictly matches the date pattern so it
   * NEVER touches other folders (archives, the user's own subfolders, etc.).
   * keepLast falsy/0 → keep everything.
   */
  _pruneDatedFolders(baseDir, keepLast) {
    const n = parseInt(keepLast);
    if (!n || n < 1) return;
    try {
      const dirs = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && SyncManager._SNAPSHOT_RE.test(e.name))
        .map(e => e.name)
        .sort();   // names sort chronologically (date then time)
      for (const name of dirs.slice(0, Math.max(0, dirs.length - n))) {
        try { fs.rmSync(path.join(baseDir, name), { recursive: true, force: true }); console.log('[Local] pruned old dated folder', name); } catch (_) {}
      }
    } catch (_) { /* retention is best-effort */ }
  }

  // Retention: keep only the newest `keepLast` amelie-vault-*.tar.gz in dir.
  // keepLast falsy/0 → keep everything.
  _pruneArchives(dir, keepLast) {
    const n = parseInt(keepLast);
    if (!n || n < 1) return;
    try {
      const files = fs.readdirSync(dir)
        .filter(f => /^amelie-vault-.*\.tar\.gz$/.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);   // newest first
      for (const { f } of files.slice(n)) {
        try { fs.unlinkSync(path.join(dir, f)); console.log('[Local] pruned old archive', f); } catch (_) {}
      }
    } catch (_) { /* retention is best-effort */ }
  }

  // Upload a vault .tar.gz to WebDAV
  async _archiveToWebDAV() {
    const tmpDir = path.join(os.homedir(), '.local', 'share', 'amelie', 'tmp');
    const file = await this.createArchive(tmpDir);
    const remoteDir = (this.config.sync.webdav.remotePath || '/amelie/backup').replace(/\/+$/, '') || '/amelie/backup';
    try { await this.webdavClient.createDirectory(remoteDir, { recursive: true }); } catch (_) {}
    // Refuse a folder claimed by SYNC (same rule as the Samba backup).
    if (await this._webdavHasFile(this.webdavClient, remoteDir, SyncManager._MARK_SYNC))
      throw new Error('Backup: questa cartella WebDAV è usata per la SYNC — elimina il file ".amelie-sync" per usarla come backup.');
    const remote = `${remoteDir}/${path.basename(file)}`;
    await this.webdavClient.putFileContents(remote, fs.readFileSync(file), { overwrite: true });
    try { fs.unlinkSync(file); } catch (_) {}
    try { await this._webdavWriteFile(this.webdavClient, remoteDir, SyncManager._MARK_BACKUP); } catch (_) {}
    console.log('[WebDAV] Archive uploaded', remote);
    return path.basename(file);
  }

  // ─── WebDAV Sync ──────────────────────────────────────────────────────────

  // WebDAV folder backup → a one-way dated SNAPSHOT, like Local and Samba:
  // uploads the vault into <remotePath>/<YYYY-MM-DD>/{notes,attachments} and
  // rotates old dated folders (keepLast). It's a backup (push only), so we never
  // pull remote → local here (two-way lives under sync.twoway).
  async _syncWebDAV() {
    const cfg = this.config.sync.webdav;
    const root = (cfg.remotePath || '/amelie/backup').replace(/\/+$/, '') || '/amelie/backup';
    const client = this.webdavClient;
    const dated = this._snapshotName();
    const base = `${root}/${dated}`;

    try { await client.createDirectory(root, { recursive: true }); } catch (_) {}
    // Refuse a folder claimed by SYNC (same rule as the Samba backup). Two-way
    // sync refuses a folder claimed by BACKUP — see _twowayWebdav.
    if (await this._webdavHasFile(client, root, SyncManager._MARK_SYNC))
      throw new Error('Backup: questa cartella WebDAV è usata per la SYNC — elimina il file ".amelie-sync" per usarla come backup.');

    for (const d of [root, base, `${base}/notes`, `${base}/attachments`]) {
      try { await client.createDirectory(d, { recursive: true }); } catch (_) { /* may exist */ }
    }

    // notes/ excludes the nested attachments dir (pushed separately as a sibling)
    // so the snapshot mirrors the Local/Samba layout.
    const noteFiles = this._getAllLocalFiles(this.notesDir, '').filter(f => !f.relPath.startsWith('attachments/'));
    const attFiles  = this._getAllLocalFiles(this.attachmentsDir, '');
    let uploaded = 0;
    const push = async (files, sub) => {
      for (const { relPath, absPath } of files) {
        const remoteFull = `${base}/${sub}/${relPath}`;
        try {
          await client.createDirectory(path.posix.dirname(remoteFull), { recursive: true }).catch(() => {});
          await client.putFileContents(remoteFull, fs.readFileSync(absPath), { overwrite: true });
          uploaded++;
        } catch (e) { console.warn('[WebDAV] Upload failed:', relPath, e.message); }
      }
    };
    await push(noteFiles, 'notes');
    await push(attFiles, 'attachments');

    // Envelope header alongside notes/ so the snapshot is restorable on a new PC.
    const hdrPath = this._vaultHeaderPath();
    if (fs.existsSync(hdrPath)) {
      try { await client.putFileContents(`${base}/.amelie-vault.json`, fs.readFileSync(hdrPath), { overwrite: true }); uploaded++; }
      catch (e) { console.warn('[WebDAV] header upload failed:', e.message); }
    }

    // Claim this folder for BACKUP so a future SYNC to the same folder refuses it.
    try { await this._webdavWriteFile(client, root, SyncManager._MARK_BACKUP); } catch (_) {}
    await this._webdavPruneDatedFolders(root, cfg.keepLast);
    console.log(`[WebDAV] Snapshot ${dated}: ↑${uploaded}`);
    return { uploaded, dateFolder: dated };
  }

  /** Keep only the newest `keepLast` YYYY-MM-DD snapshot folders on WebDAV. */
  async _webdavPruneDatedFolders(root, keepLast) {
    const n = parseInt(keepLast);
    if (!n || n < 1) return;
    const client = this.webdavClient;
    let items = [];
    try { items = await client.getDirectoryContents(root); } catch (_) { return; }
    const dated = items
      .filter(it => it.type === 'directory' && SyncManager._SNAPSHOT_RE.test(it.basename))
      .map(it => it.basename)
      .sort();
    for (const name of dated.slice(0, Math.max(0, dated.length - n))) {
      try { await client.deleteFile(`${root}/${name}`); console.log('[WebDAV] pruned old dated folder', name); }
      catch (_) { /* best-effort */ }
    }
  }

  // ─── Samba Sync ───────────────────────────────────────────────────────────

  async _syncSamba(cfg = this._sambaConfig()) {
    if (!cfg) throw new Error('Samba: destinazione non configurata');

    const archOpts = { archive: !!cfg.archive, archiveOnly: !!cfg.archiveOnly };
    // Push over SMB with the bundled `amelie-smb` helper: userspace, no mount,
    // nothing left behind on the host. (A share the user pre-mounted themselves
    // is configured as a Local destination instead.)
    if (cfg.host && cfg.share) {
      return this._syncSambaDirect(cfg, archOpts);
    }
    throw new Error('Samba: no host/share configured');
  }

  /**
   * Push the vault to a Samba share using the system `smbclient` binary.
   * No mount, no extra npm dependency. Requires the share to be
   * reachable (same LAN, or a WireGuard/VPN tunnel up — e.g. via NetworkManager).
   */
  async _syncSambaDirect(cfg, archOpts = {}) {
    const host = cfg.host || cfg.ip;
    if (!host || !cfg.share) throw new Error('Samba: host/share mancante');
    const base = String(cfg.remoteSubPath || 'amelie/backup').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    // Refuse a folder already claimed by the two-way Sync.
    if (await this._smbHasFile(cfg, base, SyncManager._MARK_SYNC)) {
      throw new Error('Backup: questa cartella è usata per la SYNC — elimina il file ".amelie-sync" per usarla come backup.');
    }
    await this._smb(cfg, ['mkdirp', base]).catch(() => {});

    // Build the local tar.gz first (if requested) so we can upload it too.
    let archiveName = null, tmpDir = null;
    if (archOpts.archive || archOpts.archiveOnly) {
      tmpDir = path.join(os.homedir(), '.local', 'share', 'amelie', 'tmp');
      archiveName = path.basename(await this.createArchive(tmpDir));
    }
    try {
      // Folder snapshot → dated subfolder <base>/<YYYY-MM-DD>/ (skipped in
      // "archive only" mode). putdir uploads each tree in ONE SMB session.
      let dateFolder = null;
      if (!archOpts.archiveOnly) {
        dateFolder = this._snapshotName();
        const snap = base + '/' + dateFolder;
        await this._smb(cfg, ['putdir', this.notesDir, snap + '/notes'], { timeout: 1800000 });
        await this._smb(cfg, ['putdir', this.attachmentsDir, snap + '/attachments'], { timeout: 1800000 });
        // Envelope header alongside notes/ so the snapshot is restorable on a new PC.
        if (fs.existsSync(this._vaultHeaderPath())) {
          await this._smb(cfg, ['put', this._vaultHeaderPath(), snap + '/.amelie-vault.json'], { timeout: 60000 }).catch(() => {});
        }
      }
      if (archiveName) {
        await this._smb(cfg, ['put', path.join(tmpDir, archiveName), base + '/' + archiveName], { timeout: 1800000 });
      }
      console.log('[Samba] push done', archiveName ? `(+ ${archiveName})` : '');

      // Remote retention: keep only the newest N .tar.gz on the share.
      if (archiveName && cfg.keepLast > 0) {
        try { await this._smbPruneArchives(cfg, base, cfg.keepLast); }
        catch (e) { console.warn('[Samba] remote archive rotation failed:', e.message); }
      }
      // Remote retention: keep only the newest N dated snapshot folders.
      if (dateFolder && cfg.keepLast > 0) {
        try { await this._smbPruneDatedFolders(cfg, base, cfg.keepLast); }
        catch (e) { console.warn('[Samba] dated folder rotation failed:', e.message); }
      }
      // Mark this as a BACKUP folder so the two-way Sync UI can refuse it.
      try { await this._smbWriteFile(cfg, base, SyncManager._MARK_BACKUP); } catch (_) {}
      return { method: 'smb', archive: archiveName || undefined, dateFolder: dateFolder || undefined };
    } finally {
      if (archiveName && tmpDir) { try { fs.unlinkSync(path.join(tmpDir, archiveName)); } catch (_) {} }
    }
  }

  /** Keep only the newest `keepLast` YYYY-MM-DD snapshot folders on the share. */
  async _smbPruneDatedFolders(cfg, subPath, keepLast) {
    const n = parseInt(keepLast);
    if (!n || n < 1) return;
    const list = await this._smbJson(cfg, ['list', subPath], { timeout: 30000 });
    if (!Array.isArray(list)) return;
    const found = [];
    for (const e of list) {
      // Keep only names that are a snapshot timestamp AND a directory.
      if (e.dir && /^(?:amelie-vault-)?\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2})?$/.test(e.name || '')) found.push(e.name);
    }
    const sorted = [...new Set(found)].sort();
    const toDelete = sorted.slice(0, Math.max(0, sorted.length - n));
    for (const d of toDelete) { try { await this._smb(cfg, ['deltree', subPath + '/' + d], { timeout: 120000 }); } catch (_) {} }
    if (toDelete.length) console.log('[Samba] Rotation: removed', toDelete.length, 'old dated folders');
  }

  /** Recursively list files under `base` on the share → { relPathUnderBase: mtimeMs }. */
  async _smbListRecursive(cfg, base) {
    const map = {};
    try {
      const entries = await this._smbJson(cfg, ['listr', base], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (e.dir) continue;              // files only (as before)
          map[e.path] = +e.mtime || 0;      // path already relative to base, mtime already in ms
        }
      }
    } catch (_) { /* transient error → {} (the caller does not delete on an empty listing) */ }
    return map;
  }

  // Build a conflict-copy relative path:
  //   "notes/foo/bar.md" → "notes/foo/bar (conflitto 2026-06-21 1530-05).md".
  // `when` (ms) stamps the LOSING side's mtime so the copy is identifiable.
  _conflictRel(rel, when) {
    const dir  = path.posix.dirname(rel);
    const ext  = path.posix.extname(rel);
    const stem = path.posix.basename(rel, ext);
    const d = new Date(when || Date.now());
    const p2 = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const name = `${stem} (conflitto ${stamp})${ext}`;
    return dir === '.' ? name : `${dir}/${name}`;
  }

  /**
   * PURE per-file two-way decision (no I/O, unit-tested). Given the local mtime
   * `L`, remote mtime `R` (either undefined if absent), the last-sync baseline
   * `base` ({r,l} or null), whether this is the first sync of the share, and the
   * conflict-copy preference, return the action to take:
   *   adopt    — both present, assume in sync, just record the baseline
   *   skip     — neither side changed since baseline
   *   upload   — push local → remote
   *   download — pull remote → local
   *   conflict — both changed since baseline; {winner:'local'|'remote'} = newer
   *   delete-remote — file was deleted locally on purpose → remove it on the share
   *   delete-local  — file was deleted on the other PC → remove it here
   * With conflictCopies OFF a both-changed case degrades to last-write-wins
   * (upload if local is newer, else download) — the older edit is overwritten.
   * Delete propagation only fires when propagateDeletes is on AND the file had a
   * baseline (was in sync before); a delete never beats a concurrent edit on the
   * other side (that side's edit is resurrected instead).
   */
  _twowayDecide(L, R, base, firstRun, conflictCopies, propagateDeletes, TOL = 3000) {
    const has = v => v != null;
    if (!has(L) && !has(R)) return { action: 'skip' };
    if (!has(L) && has(R)) {
      // Absent locally, present remotely. With delete-propagation + a baseline
      // (in sync before), a local disappearance = an on-purpose delete → remove
      // it on the share, UNLESS the remote changed since (edited elsewhere) →
      // resurrect that edit instead.
      if (propagateDeletes && base) return (R > base.r + TOL) ? { action: 'download' } : { action: 'delete-remote' };
      return { action: 'download' };
    }
    if (has(L) && !has(R)) {
      // Present locally, absent remotely (mirror): deleted on the other PC →
      // remove here, unless we edited it locally since the baseline → keep mine.
      if (propagateDeletes && base) return (L > base.l + TOL) ? { action: 'upload' } : { action: 'delete-local' };
      return { action: 'upload' };
    }
    // Both present. No baseline (first sync of the share, or a pre-existing
    // untracked file): we can't prove a concurrent edit, so resolve by
    // last-write-wins — never a conflict copy, that would be spurious.
    if (firstRun || !base) {
      if (Math.abs(L - R) <= TOL) return { action: 'adopt' };
      return L >= R ? { action: 'upload' } : { action: 'download' };
    }
    const localChanged  = L > base.l + TOL;
    const remoteChanged = R > base.r + TOL;
    if (!localChanged && !remoteChanged) return { action: 'skip' };
    if (localChanged && !remoteChanged)  return { action: 'upload' };
    if (!localChanged && remoteChanged)  return { action: 'download' };
    if (conflictCopies) return { action: 'conflict', winner: L >= R ? 'local' : 'remote' };
    return L >= R ? { action: 'upload' } : { action: 'download' };
  }

  /**
   * Two-way sync of the vault (notes + attachments) with a folder on the SMB
   * share, over smbclient (no mount). Per-file decision via _twowayDecide:
   * upload / download / skip, or — when "Copie-conflitto" is on and BOTH sides
   * changed — keep both (loser saved as a "(conflitto …)" copy, winner canonical).
   * Baselines (remote+local mtime) are stored per file so our own uploads don't
   * bounce back. Same-LAN time assumption.
   */
  async _twowaySamba(cfg, subPath) {
    // `service` string kept ONLY as the two-way-state key (same format as before,
    // so existing per-folder baselines survive this migration off smbclient).
    const service = '//' + (cfg.host || cfg.ip) + '/' + cfg.share;
    const base = String(subPath).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');   // forward-slash for amelie-smb
    // Ensure base + the two subfolders exist (mkdirp is recursive).
    try { await this._smb(cfg, ['mkdirp', base + '/notes']); } catch (_) {}
    try { await this._smb(cfg, ['mkdirp', base + '/attachments']); } catch (_) {}

    const remote = await this._smbListRecursive(cfg, base);
    const localNotes = this._getAllLocalFiles(this.notesDir, '').filter(f => !f.relPath.startsWith('attachments/')).map(f => ({ rel: 'notes/' + f.relPath, abs: f.absPath }));
    const localAtt   = this._getAllLocalFiles(this.attachmentsDir, '').map(f => ({ rel: 'attachments/' + f.relPath, abs: f.absPath }));
    const local = [...localNotes, ...localAtt];
    const localMap = {};
    for (const f of local) localMap[f.rel] = fs.statSync(f.abs).mtimeMs;
    const TOL = 3000;

    // SYNC STATE: smbclient's `put` stamps remote files with the UPLOAD time,
    // so after our own upload every remote file looks "newer" than the local
    // copy and the next sync would re-download the whole vault. The state file
    // remembers the remote mtime each file had when we last considered it in
    // sync — only files whose remote mtime moved PAST that baseline (edited
    // elsewhere) or missing locally get downloaded.
    const stateFile = path.join(os.homedir(), '.local', 'share', 'amelie', 'twoway-state.json');
    let allState = {};
    try { allState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
    const stateKey = `${service}/${base.replace(/\//g, '\\')}`;   // backslash base → same key as pre-migration
    const firstRun = !allState[stateKey];
    const st = allState[stateKey] || {};

    // "Copie-conflitto" preference (sync.twoway.conflictCopies). Default ON
    // (no silent data loss) unless explicitly turned off.
    const conflictCopies = this.config?.sync?.twoway?.conflictCopies !== false;
    // Deletions ALWAYS propagate (delete on one PC → removed everywhere) — that's
    // normal sync behaviour, decoupled from the conflict-copies toggle. Protected
    // from a failed/empty remote listing by the anti-wipe guard below.
    const propagateDeletes = this.config?.sync?.twoway?.propagateDeletes !== false;

    // Baseline accessor: state entries are { r, l } (remote+local mtime at last
    // sync). Legacy entries were a bare number (remote-only) — read both fields
    // from it so an upgraded vault keeps working without a false conflict.
    const getBase = (rel) => {
      const v = st[rel];
      if (v == null) return null;
      if (typeof v === 'number') return { r: v, l: v };
      return { r: +v.r || 0, l: +v.l || 0 };
    };
    const absOf = (rel) => {
      const r = String(rel);
      const dir = r.startsWith('attachments/') ? this.attachmentsDir : this.notesDir;
      const sub = r.startsWith('attachments/') ? r.slice('attachments/'.length) : r.slice('notes/'.length);
      const p = path.join(dir, sub);
      // rel can come from the UNTRUSTED remote listing — a malicious/compromised
      // server could serve a name with `../` to write outside the vault. Confine
      // the resolved path to its notes/attachments root.
      const root = path.resolve(dir);
      const res = path.resolve(p);
      if (res !== root && !res.startsWith(root + path.sep)) throw new Error('Unsafe sync path: ' + r);
      return p;
    };
    const uploadRel = async (rel) => {
      // put creates the parent folders on the share automatically (mkdirp).
      try { await this._smb(cfg, ['put', absOf(rel), base + '/' + rel], { timeout: 600000 }); return true; }
      catch (_) { return false; }
    };
    const downloadRel = async (rel, destAbs) => {
      const abs = destAbs || absOf(rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try { await this._smb(cfg, ['get', base + '/' + rel, abs], { timeout: 600000 }); return true; }
      catch (_) { return false; }
    };
    const deleteRemoteRel = async (rel) => {
      // Already gone = success too.
      try { await this._smb(cfg, ['del', base + '/' + rel], { timeout: 60000 }); return true; }
      catch (e) { return /NO_SUCH_FILE|NOT_FOUND|not exist|no such/i.test(e.message || ''); }
    };
    const deleteLocalRel = (rel) => {
      const abs = absOf(rel);
      try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') return false; }
      // Best-effort: prune now-empty parent dirs up to (but not including) the root.
      let dir = path.dirname(abs);
      const stopAt = rel.startsWith('attachments/') ? this.attachmentsDir : this.notesDir;
      while (dir.startsWith(stopAt) && dir !== stopAt) {
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); else break; } catch (_) { break; }
        dir = path.dirname(dir);
      }
      return true;
    };
    // Push a freshly-created local conflict copy up so the other PC gets it too.
    const pushConflictCopy = async (cRel) => {
      const cAbs = absOf(cRel);
      if (!fs.existsSync(cAbs)) return;
      localMap[cRel] = fs.statSync(cAbs).mtimeMs;
      if (await uploadRel(cRel)) { uploaded++; st[cRel] = { r: Date.now(), l: localMap[cRel] }; }
    };

    // Union of every file seen on either side (markers/strays excluded).
    const allRels = new Set();
    for (const f of local) allRels.add(f.rel);
    for (const rel of Object.keys(remote)) {
      if (rel.startsWith('notes/') || rel.startsWith('attachments/')) allRels.add(rel);
    }

    // SAFETY: never let a failed/empty remote listing turn into a mass local
    // wipe. _smbListRecursive returns {} on a transient error; if we've synced
    // before (baselines exist) or have local files, an all-empty remote almost
    // certainly means the listing failed → skip delete propagation this run.
    let pd = propagateDeletes;
    if (pd) {
      const remoteCount = Object.keys(remote).filter(r => r.startsWith('notes/') || r.startsWith('attachments/')).length;
      if (remoteCount === 0 && (Object.keys(st).length > 0 || local.length > 0)) {
        pd = false;
        console.warn('[Two-way] remote listing empty but baseline/local non-empty — skipping delete propagation this run (suspected listing failure)');
      }
    }

    let uploaded = 0, downloaded = 0, conflicts = 0, deleted = 0;
    for (const rel of allRels) {
      const L = localMap[rel];
      const R = remote[rel];
      const d = this._twowayDecide(L, R, getBase(rel), firstRun, conflictCopies, pd, TOL);
      if (d.action === 'adopt' || d.action === 'skip') {
        st[rel] = { r: R || 0, l: L || 0 };
      } else if (d.action === 'upload') {
        if (await uploadRel(rel)) { uploaded++; st[rel] = { r: Date.now(), l: L }; }
      } else if (d.action === 'download') {
        if (await downloadRel(rel)) { downloaded++; try { const t = R / 1000; fs.utimesSync(absOf(rel), t, t); } catch (_) {} st[rel] = { r: R, l: R }; }
      } else if (d.action === 'delete-remote') {
        if (await deleteRemoteRel(rel)) { deleted++; delete st[rel]; console.warn('[Two-way] deleted on share (propagated):', rel); }
      } else if (d.action === 'delete-local') {
        if (deleteLocalRel(rel)) { deleted++; delete st[rel]; console.warn('[Two-way] deleted locally (propagated from other PC):', rel); }
      } else if (d.action === 'conflict') {
        const abs  = absOf(rel);
        // Stamp the conflict copy with the LOSING side's mtime.
        const cRel = this._conflictRel(rel, d.winner === 'local' ? R : L);
        const cAbs = absOf(cRel);
        fs.mkdirSync(path.dirname(cAbs), { recursive: true });
        if (d.winner === 'local') {
          // Local wins: first preserve the remote version as a local conflict
          // copy; only if that succeeds do we overwrite the remote with local.
          if (await downloadRel(rel, cAbs)) {
            if (await uploadRel(rel)) { uploaded++; st[rel] = { r: Date.now(), l: L }; }
            await pushConflictCopy(cRel);
            conflicts++;
            console.warn('[Two-way] conflict on', rel, '→ kept both (local wins)');
          } else {
            console.warn('[Two-way] conflict on', rel, '→ could NOT preserve remote, skipped this round');
          }
        } else {
          // Remote wins: preserve local as a conflict copy (rename), then pull
          // remote to the canonical name. Restore on a failed download.
          try { fs.renameSync(abs, cAbs); } catch (_) {}
          if (await downloadRel(rel)) {
            downloaded++; try { const t = R / 1000; fs.utimesSync(abs, t, t); } catch (_) {} st[rel] = { r: R, l: R };
            await pushConflictCopy(cRel);
            conflicts++;
            console.warn('[Two-way] conflict on', rel, '→ kept both (remote wins)');
          } else {
            try { fs.renameSync(cAbs, abs); } catch (_) {}   // restore: no data lost
            console.warn('[Two-way] conflict on', rel, '→ download failed, restored local, retry next run');
          }
        }
      }
    }

    // Clock-skew reconcile: our uploads recorded baseline.r = client Date.now(),
    // but the file's mtime on the SERVER uses the server clock. If the two differ
    // (NAS vs PC), an in-sync file would look "remote-changed" next run — which
    // would resurrect a local deletion (delete misread as a remote edit) or cause
    // spurious re-downloads. Re-list once and pin baseline.r to the REAL remote
    // mtime so subsequent comparisons are against the server's own clock.
    try {
      const after = await this._smbListRecursive(cfg, base);
      for (const rel of Object.keys(st)) {
        if (st[rel] && typeof st[rel] === 'object' && (rel in after)) st[rel].r = after[rel];
      }
    } catch (_) {}

    // Envelope vault header (.amelie-vault.json) — transport it alongside notes/
    // and attachments/ so a 2nd PC syncing this share adopts the wrapped DEK +
    // salt and can unlock with just the password. Newer mtime wins; never deleted.
    const HDR = '.amelie-vault.json';
    const localHdr = this._vaultHeaderPath();
    const localHdrMtime = fs.existsSync(localHdr) ? fs.statSync(localHdr).mtimeMs : 0;
    const remoteHdrMtime = (HDR in remote) ? remote[HDR] : 0;
    if (localHdrMtime && (!remoteHdrMtime || localHdrMtime > remoteHdrMtime + TOL)) {
      try {
        await this._smb(cfg, ['put', localHdr, base + '/' + HDR], { timeout: 60000 });
        // Stamp local ≈ now so the freshly-uploaded remote copy isn't re-pulled next run.
        uploaded++; try { const t = Date.now() / 1000; fs.utimesSync(localHdr, t, t); } catch (_) {}
      } catch (_) {}
    } else if (remoteHdrMtime && (!localHdrMtime || remoteHdrMtime > localHdrMtime + TOL)) {
      fs.mkdirSync(path.dirname(localHdr), { recursive: true });
      try {
        await this._smb(cfg, ['get', base + '/' + HDR, localHdr], { timeout: 60000 });
        downloaded++; try { const t = remote[HDR] / 1000; fs.utimesSync(localHdr, t, t); } catch (_) {}
      } catch (_) {}
    }

    // Persist the baseline for the next run.
    try { allState[stateKey] = st; fs.writeFileSync(stateFile, JSON.stringify(allState), 'utf8'); } catch (_) {}
    console.log(`[Two-way] Samba done: ↑${uploaded} ↓${downloaded}${deleted ? ` ✗${deleted} eliminati` : ''}${conflicts ? ` ⚠${conflicts} conflitti (entrambe le versioni tenute)` : ''}`);
    return { method: 'smb-twoway', uploaded, downloaded, deleted, conflicts };
  }

  // List every FILE recursively under a WebDAV base dir → { rel: mtimeMs }.
  // rel is the path relative to base (e.g. "notes/foo.md"). Returns {} on error.
  async _webdavTwowayList(client, base) {
    const out = {};
    const items = await client.getDirectoryContents(base, { deep: true });
    const baseN = base.replace(/\/+$/, '');
    for (const it of items) {
      if (it.type !== 'file') continue;
      let rel = decodeURIComponent(it.filename || '');
      if (rel.startsWith(baseN + '/')) rel = rel.slice(baseN.length + 1);
      else rel = rel.replace(/^\/+/, '');
      rel = rel.replace(/^\/+/, '');
      if (!rel) continue;
      out[rel] = new Date(it.lastmod).getTime();
    }
    return out;
  }

  /**
   * Two-way sync of the vault (notes + attachments) with a folder on a WebDAV
   * server (e.g. Nextcloud). Same engine as _twowaySamba — per-file _twowayDecide
   * (upload/download/skip, conflict-copies, delete propagation), per-file baseline
   * in twoway-state.json (keyed by webdav:url/base) so our own uploads don't bounce
   * back, anti-wipe guard on an empty/failed listing, clock-skew reconcile. Runs
   * entirely in main over the `webdav` client (no CSP/CORS — see [[amelie-webdav-test]]).
   */
  async _twowayWebdav(wcfg) {
    const { createClient } = require('webdav');
    const url = (wcfg.url || '').trim();
    if (!url) throw new Error('Two-way WebDAV: URL mancante');
    const base = '/' + String(wcfg.remotePath || 'amelie/sync').replace(/^\/+|\/+$/g, '');
    const client = createClient(url, { username: wcfg.username || '', password: this._decSecret(wcfg.password) || '' });
    const ensureDir = async (dir) => { try { await client.createDirectory(dir, { recursive: true }); } catch (_) {} };
    await ensureDir(base); await ensureDir(base + '/notes'); await ensureDir(base + '/attachments');

    // Refuse a folder already claimed by BACKUP (same rule as Samba). The backup
    // side refuses a folder claimed by SYNC (.amelie-sync) — see _syncWebDAV.
    if (await this._webdavHasFile(client, base, SyncManager._MARK_BACKUP) || await this._webdavHasFile(client, base, 'amelie-backup'))
      throw new Error('Two-way: questa cartella WebDAV è usata per il BACKUP — scegline un\'altra o elimina il file ".amelie-backup".');

    let remote = {};
    try { remote = await this._webdavTwowayList(client, base); }
    catch (e) { console.warn('[Two-way WebDAV] list failed:', e.message); remote = {}; }

    const localNotes = this._getAllLocalFiles(this.notesDir, '').filter(f => !f.relPath.startsWith('attachments/')).map(f => ({ rel: 'notes/' + f.relPath, abs: f.absPath }));
    const localAtt   = this._getAllLocalFiles(this.attachmentsDir, '').map(f => ({ rel: 'attachments/' + f.relPath, abs: f.absPath }));
    const local = [...localNotes, ...localAtt];
    const localMap = {};
    for (const f of local) localMap[f.rel] = fs.statSync(f.abs).mtimeMs;
    const TOL = 3000;

    const stateFile = path.join(os.homedir(), '.local', 'share', 'amelie', 'twoway-state.json');
    let allState = {};
    try { allState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
    const stateKey = `webdav:${url}/${base}`;
    const firstRun = !allState[stateKey];
    const st = allState[stateKey] || {};
    const conflictCopies = this.config?.sync?.twoway?.conflictCopies !== false;
    const propagateDeletes = this.config?.sync?.twoway?.propagateDeletes !== false;

    const getBase = (rel) => { const v = st[rel]; if (v == null) return null; if (typeof v === 'number') return { r: v, l: v }; return { r: +v.r || 0, l: +v.l || 0 }; };
    const absOf = (rel) => {
      const r = String(rel);
      const dir = r.startsWith('attachments/') ? this.attachmentsDir : this.notesDir;
      const sub = r.startsWith('attachments/') ? r.slice('attachments/'.length) : r.slice('notes/'.length);
      const p = path.join(dir, sub);
      // rel can come from the UNTRUSTED remote listing — a malicious/compromised
      // server could serve a name with `../` to write outside the vault. Confine
      // the resolved path to its notes/attachments root.
      const root = path.resolve(dir);
      const res = path.resolve(p);
      if (res !== root && !res.startsWith(root + path.sep)) throw new Error('Unsafe sync path: ' + r);
      return p;
    };
    const remoteOf = (rel) => base + '/' + rel;
    const uploadRel = async (rel) => {
      try {
        const abs = absOf(rel);
        const dir = rel.split('/').slice(0, -1).join('/');
        if (dir) await ensureDir(base + '/' + dir);
        await client.putFileContents(remoteOf(rel), fs.readFileSync(abs), { overwrite: true });
        return true;
      } catch (e) { console.warn('[Two-way WebDAV] upload failed', rel, e.message); return false; }
    };
    const downloadRel = async (rel, destAbs) => {
      try {
        const abs = destAbs || absOf(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const buf = await client.getFileContents(remoteOf(rel), { format: 'binary' });
        fs.writeFileSync(abs, Buffer.from(buf));
        return true;
      } catch (e) { console.warn('[Two-way WebDAV] download failed', rel, e.message); return false; }
    };
    const deleteRemoteRel = async (rel) => {
      try { await client.deleteFile(remoteOf(rel)); return true; }
      catch (e) { if (/\b404\b|not found/i.test(e.message || '')) return true; console.warn('[Two-way WebDAV] delete failed', rel, e.message); return false; }
    };
    const deleteLocalRel = (rel) => {
      const abs = absOf(rel);
      try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') return false; }
      let dir = path.dirname(abs);
      const stopAt = rel.startsWith('attachments/') ? this.attachmentsDir : this.notesDir;
      while (dir.startsWith(stopAt) && dir !== stopAt) {
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); else break; } catch (_) { break; }
        dir = path.dirname(dir);
      }
      return true;
    };
    let uploaded = 0, downloaded = 0, conflicts = 0, deleted = 0;
    const pushConflictCopy = async (cRel) => {
      const cAbs = absOf(cRel);
      if (!fs.existsSync(cAbs)) return;
      localMap[cRel] = fs.statSync(cAbs).mtimeMs;
      if (await uploadRel(cRel)) { uploaded++; st[cRel] = { r: Date.now(), l: localMap[cRel] }; }
    };

    const allRels = new Set();
    for (const f of local) allRels.add(f.rel);
    for (const rel of Object.keys(remote)) { if (rel.startsWith('notes/') || rel.startsWith('attachments/')) allRels.add(rel); }

    // Anti-wipe: an empty remote listing with existing baseline/local is almost
    // certainly a failed PROPFIND — don't propagate that as a mass delete.
    let pd = propagateDeletes;
    if (pd) {
      const remoteCount = Object.keys(remote).filter(r => r.startsWith('notes/') || r.startsWith('attachments/')).length;
      if (remoteCount === 0 && (Object.keys(st).length > 0 || local.length > 0)) {
        pd = false;
        console.warn('[Two-way WebDAV] remote listing empty but baseline/local non-empty — skipping delete propagation this run');
      }
    }

    for (const rel of allRels) {
      const L = localMap[rel];
      const R = remote[rel];
      const d = this._twowayDecide(L, R, getBase(rel), firstRun, conflictCopies, pd, TOL);
      if (d.action === 'adopt' || d.action === 'skip') {
        st[rel] = { r: R || 0, l: L || 0 };
      } else if (d.action === 'upload') {
        if (await uploadRel(rel)) { uploaded++; st[rel] = { r: Date.now(), l: L }; }
      } else if (d.action === 'download') {
        if (await downloadRel(rel)) { downloaded++; try { const t = R / 1000; fs.utimesSync(absOf(rel), t, t); } catch (_) {} st[rel] = { r: R, l: R }; }
      } else if (d.action === 'delete-remote') {
        if (await deleteRemoteRel(rel)) { deleted++; delete st[rel]; console.warn('[Two-way WebDAV] deleted on server (propagated):', rel); }
      } else if (d.action === 'delete-local') {
        if (deleteLocalRel(rel)) { deleted++; delete st[rel]; console.warn('[Two-way WebDAV] deleted locally (propagated):', rel); }
      } else if (d.action === 'conflict') {
        const abs = absOf(rel);
        const cRel = this._conflictRel(rel, d.winner === 'local' ? R : L);
        const cAbs = absOf(cRel);
        fs.mkdirSync(path.dirname(cAbs), { recursive: true });
        if (d.winner === 'local') {
          if (await downloadRel(rel, cAbs)) {
            if (await uploadRel(rel)) { uploaded++; st[rel] = { r: Date.now(), l: L }; }
            await pushConflictCopy(cRel); conflicts++;
            console.warn('[Two-way WebDAV] conflict on', rel, '→ kept both (local wins)');
          }
        } else {
          try { fs.renameSync(abs, cAbs); } catch (_) {}
          if (await downloadRel(rel)) {
            downloaded++; try { const t = R / 1000; fs.utimesSync(abs, t, t); } catch (_) {} st[rel] = { r: R, l: R };
            await pushConflictCopy(cRel); conflicts++;
            console.warn('[Two-way WebDAV] conflict on', rel, '→ kept both (remote wins)');
          } else { try { fs.renameSync(cAbs, abs); } catch (_) {} }
        }
      }
    }

    // Clock-skew reconcile: pin baseline.r to the server's real mtime.
    try {
      const after = await this._webdavTwowayList(client, base);
      for (const rel of Object.keys(st)) { if (st[rel] && typeof st[rel] === 'object' && (rel in after)) st[rel].r = after[rel]; }
    } catch (_) {}

    // Envelope header (.amelie-vault.json) — newer mtime wins, never deleted.
    const HDR = '.amelie-vault.json';
    const localHdr = this._vaultHeaderPath();
    const localHdrMtime = fs.existsSync(localHdr) ? fs.statSync(localHdr).mtimeMs : 0;
    const remoteHdrMtime = (HDR in remote) ? remote[HDR] : 0;
    if (localHdrMtime && (!remoteHdrMtime || localHdrMtime > remoteHdrMtime + TOL)) {
      try { await client.putFileContents(base + '/' + HDR, fs.readFileSync(localHdr), { overwrite: true }); uploaded++; } catch (_) {}
    } else if (remoteHdrMtime && (!localHdrMtime || remoteHdrMtime > localHdrMtime + TOL)) {
      try { fs.mkdirSync(path.dirname(localHdr), { recursive: true }); const buf = await client.getFileContents(base + '/' + HDR, { format: 'binary' }); fs.writeFileSync(localHdr, Buffer.from(buf)); const t = remoteHdrMtime / 1000; fs.utimesSync(localHdr, t, t); downloaded++; } catch (_) {}
    }

    try { allState[stateKey] = st; fs.writeFileSync(stateFile, JSON.stringify(allState), 'utf8'); } catch (_) {}
    // Claim this folder for SYNC so a future BACKUP to the same folder refuses it.
    try { await this._webdavWriteFile(client, base, SyncManager._MARK_SYNC); } catch (_) {}
    console.log(`[Two-way] WebDAV done: ↑${uploaded} ↓${downloaded}${deleted ? ` ✗${deleted} eliminati` : ''}${conflicts ? ` ⚠${conflicts} conflitti` : ''}`);
    return { method: 'webdav-twoway', uploaded, downloaded, deleted, conflicts };
  }

  /** Keep only the newest `keepLast` amelie-vault-*.tar.gz on the share. */
  async _smbPruneArchives(cfg, subPath, keepLast) {
    const list = await this._smbJson(cfg, ['list', subPath], { timeout: 30000 });
    if (!Array.isArray(list)) return;
    const found = list.filter(e => !e.dir && /^amelie-vault-\d{8}-\d{6}\.tar\.gz$/.test(e.name || '')).map(e => e.name);
    const sorted = [...new Set(found)].sort();   // timestamp in name → chronological
    const toDelete = sorted.slice(0, Math.max(0, sorted.length - keepLast));
    for (const f of toDelete) { try { await this._smb(cfg, ['del', subPath + '/' + f], { timeout: 60000 }); } catch (_) {} }
    if (toDelete.length) console.log('[Samba] Rotation: removed', toDelete.length, 'old remote archives');
  }

  async _syncToMountPoint(mountPath, subPath, opts = {}) {
    const remoteBase        = path.join(mountPath, subPath);
    const remoteNotes       = path.join(remoteBase, 'notes');
    const remoteAttachments = path.join(remoteBase, 'attachments');

    // Ensure remote folders exist (create on first sync)
    [remoteBase, remoteNotes, remoteAttachments].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });

    // Archive only: skip copying the folder, just create the .tar.gz
    if (opts.archiveOnly) {
      const a = path.basename(await this.createArchive(remoteBase));
      return { method: 'archive-only', archive: a };
    }

    // Envelope vault header (.amelie-vault.json): push local → remote alongside
    // notes/ + attachments/; for two-way also pull a newer remote header back so
    // a 2nd PC adopts the wrapped DEK + salt. Lives at the base, never deleted.
    const localHdr = this._vaultHeaderPath();
    const remoteHdr = path.join(remoteBase, '.amelie-vault.json');
    this._copyFileNewer(localHdr, remoteHdr);
    if (!opts.oneWay) this._copyFileNewer(remoteHdr, localHdr);

    // ── Strategy: LOCAL IS MASTER ─────────────────────────────────────────
    // The vault on disk is always the source of truth.
    // Samba is a remote BACKUP COPY — we push local → remote.
    // We never overwrite a local file with an older remote version.
    //
    // Rules:
    //   1. Local file exists, remote missing  → copy to remote
    //   2. Local file exists, remote older    → overwrite remote
    //   3. Local file missing, remote exists  → copy to local
    //      (another device wrote it — pull it in)
    //   4. Both exist, same mtime             → skip
    //   5. Both exist, remote newer           → copy to local
    //      (edited on another machine via the share)

    const rs = this._rsyncBin();   // bundled rsync, else system, else null

    if (rs) {
      try {
        // Push local → remote. For BACKUP (opts.oneWay) local is master, so
        // --delete mirrors removals to the backup. For TWO-WAY, the push must NOT
        // --delete: a file that exists only on the remote (created on another PC)
        // would otherwise be wiped BEFORE the pull could bring it in. Two-way then
        // pulls remote → local with --update (newer remote files come in, never
        // overwriting a newer local file).
        // execFileSync (args as an ARRAY, no shell) so a path with shell
        // metacharacters can never be interpreted — the paths reach rsync verbatim.
        const eo = { timeout: 120000, env: rs.env };
        const del = opts.oneWay ? ['--delete'] : [];
        const base = ['-az', '--update'];
        execFileSync(rs.bin, [...base, ...del, this.notesDir + '/', remoteNotes + '/'], eo);
        if (!opts.oneWay) execFileSync(rs.bin, [...base, remoteNotes + '/', this.notesDir + '/'], eo);
        execFileSync(rs.bin, [...base, ...del, this.attachmentsDir + '/', remoteAttachments + '/'], eo);
        if (!opts.oneWay) execFileSync(rs.bin, [...base, remoteAttachments + '/', this.attachmentsDir + '/'], eo);
        console.log(`[Sync] rsync ${opts.oneWay ? 'one-way done (local → remote)' : 'two-way done (local is master)'} [${rs.label}]`);
        const r = { method: 'rsync', direction: opts.oneWay ? 'one-way' : 'two-way' };
        if (opts.archive) r.archive = path.basename(await this.createArchive(remoteBase));
        return r;
      } catch (e) {
        // rsync failed (e.g. bundled binary incompatible) → file-by-file copy below.
        console.warn('[Sync] rsync failed, falling back to file-by-file copy:', e.message);
      }
    }

    // Fallback: manual mtime-based copy (also reached if rsync threw above)
    let toRemote = 0, toLocal = 0;

    const syncDirs = [
      { local: this.notesDir,       remote: remoteNotes       },
      { local: this.attachmentsDir, remote: remoteAttachments },
    ];

    for (const { local, remote } of syncDirs) {
      // Push: local → remote (local is master)
      toRemote += this._copyNewer(local, remote);
      // Pull: remote → local only for two-way sync (not for one-way backup)
      if (!opts.oneWay) toLocal += this._copyNewer(remote, local);
    }

    console.log(`[Samba] Manual sync done: →remote ${toRemote}, →local ${toLocal}`);
    const rr = { method: 'manual', toRemote, toLocal };
    if (opts.archive) rr.archive = path.basename(await this.createArchive(remoteBase));
    return rr;
  }

  /**
   * Copy files from src to dst where src is newer than dst.
   * Never overwrites a dst file that is newer than src.
   */
  _copyNewer(srcDir, dstDir) {
    let count = 0;
    if (!fs.existsSync(srcDir)) return 0;
    const files = this._getAllLocalFiles(srcDir, '');
    for (const { relPath, absPath } of files) {
      const dstPath = path.join(dstDir, relPath);
      const srcMtime = fs.statSync(absPath).mtimeMs;
      let dstMtime = 0;
      try { dstMtime = fs.statSync(dstPath).mtimeMs; } catch(_) {}
      if (srcMtime > dstMtime) {
        const dir = path.dirname(dstPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(absPath, dstPath);
        // Preserve mtime so next sync detects no change
        const srcStat = fs.statSync(absPath);
        fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime);
        count++;
      }
    }
    return count;
  }

  // Absolute path of the envelope vault header (.amelie-vault.json). It lives in
  // the vault root (parent of notes/) and carries the wrapped DEK + salt, so
  // transporting it lets a 2nd PC adopt the key and unlock with just the password.
  _vaultHeaderPath() { return path.join(path.dirname(this.notesDir), '.amelie-vault.json'); }

  /** Copy a single file src→dst when src exists and is newer than dst (mtime). Preserves mtime. Best-effort. */
  _copyFileNewer(src, dst) {
    try {
      if (!fs.existsSync(src)) return false;
      const s = fs.statSync(src).mtimeMs;
      let d = 0; try { d = fs.statSync(dst).mtimeMs; } catch (_) {}
      if (s <= d) return false;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      const st = fs.statSync(src);
      fs.utimesSync(dst, st.atime, st.mtime);
      return true;
    } catch (_) { return false; }
  }

  // Files that must NEVER be transmitted in a backup or sync — credential /
  // password material. They live in the app-data dir (~/.local/share/amelie),
  // NOT in the vault, so they normally can't be reached by these walkers anyway;
  // this is defence-in-depth so even a stray copy inside the vault is skipped.
  // (NB: .amelie-vault.json — the envelope HEADER — is intentionally NOT here; it
  // holds only salt + KDF params + the AEAD-wrapped DEK, no password, and must
  // travel so another PC can unlock with the password. .amelie-order.json also
  // syncs by design.)
  static get _SENSITIVE_NAMES() {
    return new Set(['.passkey', '.salt', '.passphrase', 'settings.json', 'amelie.json', 'twoway-state.json']);
  }

  _getAllLocalFiles(dir, prefix) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const walk = (current, rel) => {
      const items = fs.readdirSync(current, { withFileTypes: true });
      for (const item of items) {
        const relPath = rel ? `${rel}/${item.name}` : item.name;
        const absPath = path.join(current, item.name);
        if (item.isDirectory()) {
          walk(absPath, relPath);
        } else {
          if (SyncManager._SENSITIVE_NAMES.has(item.name)) continue;   // never sync/back up credential files
          results.push({ relPath: prefix ? `${prefix}/${relPath}` : relPath, absPath });
        }
      }
    };
    walk(dir, '');
    return results;
  }

  _commandExists(cmd) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch (_) {
      return false;
    }
  }

  // Directory holding the BUNDLED rsync (the binary + its shared libs), shipped
  // via electron-builder `extraResources` → <resources>/rsync. In dev it lives in
  // the repo at vendor/rsync. Returns null if not present.
  _bundledRsyncDir() {
    const cands = [];
    try { if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'rsync')); } catch (_) {}
    cands.push(path.join(__dirname, '..', '..', 'vendor', 'rsync'));   // dev (not in the asar)
    for (const c of cands) { try { if (fs.existsSync(path.join(c, 'rsync'))) return c; } catch (_) {} }
    return null;
  }

  // Pick an rsync that actually RUNS on this host: the bundled one first (its libs
  // are loaded via LD_LIBRARY_PATH so it's self-contained — works on Debian/RedHat/
  // Fedora/Arch with a recent glibc), else the distro's own rsync on PATH, else
  // null → the file-by-file copy fallback. Cached. Each candidate is probed with
  // `--version` so a glibc-incompatible bundled binary cleanly defers to system.
  _rsyncBin() {
    if (this.__rsyncBin !== undefined) return this.__rsyncBin;
    const { execFileSync } = require('child_process');
    const works = (bin, env) => { try { execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 8000, env }); return true; } catch (_) { return false; } };
    const dir = this._bundledRsyncDir();
    if (dir) {
      const bin = path.join(dir, 'rsync');
      const env = { ...process.env, LD_LIBRARY_PATH: dir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '') };
      if (works(bin, env)) { this.__rsyncBin = { bin, env, label: 'bundled' }; return this.__rsyncBin; }
    }
    if (works('rsync', process.env)) { this.__rsyncBin = { bin: 'rsync', env: process.env, label: 'system' }; return this.__rsyncBin; }
    this.__rsyncBin = null;
    return this.__rsyncBin;
  }

  // True if a sync/backup is genuinely in progress. A 'syncing' flag older than
  // 10 minutes is treated as stale (e.g. an upload that hung over the tunnel) so
  // a stuck flag can never lock the user out of all future backups.
  _busy() {
    if (this.status !== 'syncing') return false;
    if (this._syncStartedAt && (Date.now() - this._syncStartedAt) > 10 * 60 * 1000) {
      console.warn('[Sync] stale "syncing" flag (>10min) — allowing a new backup');
      return false;
    }
    return true;
  }

  // `meta` tells the renderer WHAT finished — { op: 'backup' | 'twoway' | 'sync',
  // manual: true|false } — so it can log the right line in the notifications bell.
  // Without it every run looked identical and an automatic backup was
  // indistinguishable from a scheduled two-way sync.
  _setStatus(status, error = null, meta = null) {
    this.status = status;
    this.lastError = error;
    if (status === 'syncing') this._syncStartedAt = Date.now();
    // Notify renderer
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows();
    wins.forEach(w => w.webContents.send('sync:statusUpdate', {
      status,
      error,
      lastSync: this.lastSync,
      op: meta && meta.op ? meta.op : null,
      manual: !!(meta && meta.manual),
      // Destinations actually written (backup only) → named in the notification.
      dests: Array.isArray(meta && meta.dests) ? meta.dests : null,
      // A pass that found nothing to copy: reported, but worded as the no-op it is.
      unchanged: !!(meta && meta.unchanged),
    }));
  }

}

module.exports = { SyncManager };
