const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * VpnTester — tests VPN + share connectivity step by step.
 * Returns structured results so the UI can show per-step status.
 *
 * Steps:
 *  1. vpnPing   — ping the WireGuard peer IP
 *  2. mountOk   — try to mount the SMB/NFS share
 *  3. pathOk    — check the remote subfolder exists (or create it)
 *  4. writeOk   — write + delete a test file to verify write permissions
 */
class VpnTester {
  async test(cfg) {
    const steps = { vpnPing: false, mountOk: false, pathOk: false, writeOk: false };
    const tmpMount = path.join(os.tmpdir(), `inkwell-test-${Date.now()}`);

    // ── Step 1: Ping peer ────────────────────────────────────────────────────
    try {
      const t0 = Date.now();
      // execFileSync (no shell) — cfg.peerIp is an argv element, never interpolated.
      execFileSync('ping', ['-c', '1', '-W', '3', String(cfg.peerIp)], { stdio: 'ignore', timeout: 5000 });
      steps.vpnPing = true;
      steps.pingMs = Date.now() - t0;
    } catch (e) {
      return {
        success: false,
        steps,
        error: `Ping a ${cfg.peerIp} fallito. Verifica che WireGuard sia attivo (wg-quick up wg0) e che l'IP sia corretto.`,
      };
    }

    // ── Step 2: Mount share ──────────────────────────────────────────────────
    try {
      fs.mkdirSync(tmpMount, { recursive: true });
    } catch (_) {}

    try {
      if (cfg.protocol === 'smb') {
        await this._mountSmb(cfg, tmpMount);
      } else {
        await this._mountNfs(cfg, tmpMount);
      }
      steps.mountOk = true;
    } catch (e) {
      this._cleanup(tmpMount, false);
      return {
        success: false,
        steps,
        mountError: e.message,
        error: `Mount fallito: ${e.message}. Assicurati che cifs-utils (SMB) o nfs-common (NFS) siano installati.`,
      };
    }

    // ── Step 3: Check/create remote path ────────────────────────────────────
    const remotePath = path.join(tmpMount, cfg.remotePath || 'inkwell');
    try {
      if (!fs.existsSync(remotePath)) {
        fs.mkdirSync(remotePath, { recursive: true });
      }
      fs.accessSync(remotePath, fs.constants.R_OK);
      steps.pathOk = true;
    } catch (e) {
      this._cleanup(tmpMount, true);
      return { success: false, steps, error: `Accesso a "${cfg.remotePath}" fallito: ${e.message}` };
    }

    // ── Step 4: Write test ───────────────────────────────────────────────────
    const testFile = path.join(remotePath, '.inkwell-test');
    try {
      fs.writeFileSync(testFile, `inkwell-test-${Date.now()}`);
      fs.unlinkSync(testFile);
      steps.writeOk = true;
    } catch (e) {
      this._cleanup(tmpMount, true);
      return { success: false, steps, error: `Scrittura negata in "${cfg.remotePath}": ${e.message}` };
    }

    this._cleanup(tmpMount, true);
    return { success: true, steps };
  }

  _mountSmb(cfg, mountPoint) {
    return new Promise((resolve, reject) => {
      // execFile with an argv array → NO shell, so share/peerIp/username can't
      // inject commands. The password is written to a private 0600 credentials
      // file (NEVER on argv/-o, where `ps`/`/proc/<pid>/cmdline` would expose it).
      const unc = `//${cfg.peerIp}/${cfg.smb.share}`;
      const optList = [`uid=${process.getuid()}`, `gid=${process.getgid()}`, 'vers=3.0'];
      let credDir = null;
      if (cfg.smb.username) {
        credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-creds-'));
        const credFile = path.join(credDir, 'cifs');
        let body = `username=${cfg.smb.username}\npassword=${cfg.smb.password || ''}\n`;
        if (cfg.smb.domain) body += `domain=${cfg.smb.domain}\n`;
        fs.writeFileSync(credFile, body, { mode: 0o600 });
        optList.push(`credentials=${credFile}`);
      } else {
        optList.push('guest');
      }
      execFile('mount', ['-t', 'cifs', unc, mountPoint, '-o', optList.join(',')], { timeout: 15000 }, (err) => {
        if (credDir) { try { fs.rmSync(credDir, { recursive: true, force: true }); } catch (_) {} }
        if (err) reject(new Error(/Permission denied/.test(err.message)
          ? 'Credenziali SMB errate'
          : err.message.split('\n')[0]));
        else resolve();
      });
    });
  }

  _mountNfs(cfg, mountPoint) {
    return new Promise((resolve, reject) => {
      const src = `${cfg.peerIp}:${cfg.nfs.export}`;
      const ver = cfg.nfs.version || '4';
      let opts = `nfsvers=${ver}`;
      if (cfg.nfs.options) opts += `,${cfg.nfs.options}`;
      // execFile (no shell): src/opts are argv elements, never shell-interpolated.
      execFile('mount', ['-t', 'nfs', src, mountPoint, '-o', opts], { timeout: 15000 }, (err) => {
        if (err) reject(new Error(err.message.split('\n')[0]));
        else resolve();
      });
    });
  }

  _cleanup(mountPoint, mounted) {
    try {
      if (mounted) execFileSync('umount', [mountPoint], { stdio: 'ignore', timeout: 5000 });
    } catch (_) {}
    try { fs.rmdirSync(mountPoint); } catch (_) {}
  }
}

module.exports = { VpnTester };
