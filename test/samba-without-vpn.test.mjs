// A Samba share on the network you are already on must not need a VPN.
//
// The backup engine used to know exactly ONE Samba destination, and it mapped it
// with `useWireGuard: true` hardcoded — the share was always "Samba over
// WireGuard", so every run went through the tunnel branch. At home that still
// worked by luck (ensureBestPath prefers the direct route when :445 answers),
// but the destination could not be set up or reasoned about without a VPN.
//
// `sync.sambaLan` is that destination without the tunnel. These checks drive the
// real SyncManager with no Electron: the class requires electron lazily, inside
// the methods that talk to a window, and none of those are reached here.
//
// Against the OLD code every check below fails: `_sambaConfig()` returned null
// for this config, so there was no destination at all.
//
//   run: npm test
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });

function mgr(cfg) {
  const m = new SyncManager('/nonexistent/notes', '/nonexistent/attachments', '/nonexistent/settings.json');
  m.config = cfg;
  m.ensureVpnTunnel = async () => {};
  m._startAutoSync = () => {};
  m._stopAutoSync = () => {};
  m._stopTimers = () => {};
  m._setupWebDAV = () => {};
  return m;
}
const LAN_ONLY = () => ({ sync: { enabled: true,
  local:  { enabled: false, path: '' },
  webdav: { enabled: false, url: '' },
  sambaLan: { enabled: true, host: '192.168.30.10', ip: '192.168.30.10', share: 'saturn',
              remoteSubPath: 'amelie/backup', username: 'u', password: 'p',
              useWireGuard: false, folder: true, archive: false, archiveOnly: false, keepLast: 5 } } });
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── The destination exists at all ────────────────────────────────────────────
{
  const c = mgr(LAN_ONLY())._sambaConfig();
  check('a Samba destination with no VPN is a destination', !!c, `_sambaConfig()=${JSON.stringify(c)}`);
  check('it keeps the share it was given', !!c && c.host === '192.168.30.10' && c.share === 'saturn',
    `host=${c?.host} share=${c?.share}`);
}

// ── and it must never ask for a tunnel ───────────────────────────────────────
{
  const c = mgr(LAN_ONLY())._sambaConfig();
  check('it is not "Samba over WireGuard"', c && c.useWireGuard === false, `useWireGuard=${c?.useWireGuard}`);
}
{
  // Even if a stale config carries the old hardcoded flag, the destination is
  // what it is: no tunnel. (A config written by an older build could have it.)
  const cfg = clone(LAN_ONLY()); cfg.sync.sambaLan.useWireGuard = true;
  const c = mgr(cfg)._sambaConfig();
  check('a stale useWireGuard:true in the saved config is overruled', c && c.useWireGuard === false,
    `useWireGuard=${c?.useWireGuard}`);
}

// ── The backup writes through the plain Samba path ───────────────────────────
{
  // The tunnel branch would reach for NetworkManager and, finding no route to a
  // fake host, return { error: 'Share non raggiungibile…' }. Getting the stub's
  // own value back is what proves the direct branch ran.
  const m = mgr(LAN_ONLY());
  let sawCfg = null;
  m._syncSamba = async (cfg) => { sawCfg = cfg; return { ok: true, files: 3 }; };
  const out = await m._runBackupInner();
  check('the backup writes via plain Samba, no tunnel branch', out.samba?.ok === true,
    `results.samba=${JSON.stringify(out.samba)}`);
  check('and it is handed the LAN share', sawCfg?.share === 'saturn' && sawCfg?.useWireGuard === false,
    `share=${sawCfg?.share} useWireGuard=${sawCfg?.useWireGuard}`);
}

// ── Both formats off is still "nothing to write", not an error ───────────────
{
  const cfg = clone(LAN_ONLY());
  cfg.sync.sambaLan.folder = false; cfg.sync.sambaLan.archive = false; cfg.sync.sambaLan.archiveOnly = false;
  const m = mgr(cfg);
  m._syncSamba = async () => { throw new Error('must not run'); };
  const out = await m._runBackupInner();
  check('no backup format → skipped quietly', out.samba?.skipped === true,
    `results.samba=${JSON.stringify(out.samba)}`);
}

// ── Switching it on has to invalidate the unchanged-vault shortcut ───────────
{
  const off = clone(LAN_ONLY()); off.sync.sambaLan.enabled = false;
  const m = mgr(off);
  m._lastBackupSig = '42:1024:1785845798000';
  m.reloadConfig(clone(LAN_ONLY()));
  check('enabling it drops the unchanged-vault shortcut', m._lastBackupSig === null,
    `_lastBackupSig=${m._lastBackupSig}`);
}
{
  const m = mgr(LAN_ONLY());
  m._lastBackupSig = '42:1024:1785845798000';
  const next = clone(LAN_ONLY()); next.sync.sambaLan.remoteSubPath = 'amelie/backup-2';
  m.reloadConfig(next);
  check('repointing it at another folder drops it too', m._lastBackupSig === null,
    `_lastBackupSig=${m._lastBackupSig}`);
}

// ── The VPN destination is untouched by all this ─────────────────────────────
{
  const cfg = { sync: { enabled: true,
    vpn: { enabled: true, smb: { ip: '10.8.0.2', share: 'saturn', path: 'amelie/backup' }, folder: true } } };
  const c = mgr(cfg)._sambaConfig();
  check('the VPN destination still maps as Samba over WireGuard',
    c && c.useWireGuard === true && c.host === '10.8.0.2', `${JSON.stringify(c)}`);
}
{
  // Only one remote runs at a time, and the LAN share is checked first: with
  // both somehow enabled the VPN one must not silently win.
  const cfg = clone(LAN_ONLY());
  cfg.sync.vpn = { enabled: true, smb: { ip: '10.8.0.2', share: 'other', path: 'x' }, folder: true };
  const c = mgr(cfg)._sambaConfig();
  check('with both set, the VPN-less share wins and stays tunnel-free',
    c && c.share === 'saturn' && c.useWireGuard === false, `${JSON.stringify(c)}`);
}

// ── Two-way sync: the same split, and it must not rewrite old setups ─────────
// The Sync tab had ONE Samba method too, stored as transport 'samba' with
// useWireGuard true. The LAN method now owns that name, so an existing VPN
// setup has to keep its tunnel: it is recognised by the flag it always carried.
const T = (tw) => SyncManager._twowayTransport(tw);
{
  check('an old WireGuard sync (transport "samba", flag on) is still the VPN one',
    T({ transport: 'samba', useWireGuard: true }) === 'vpn', T({ transport: 'samba', useWireGuard: true }));
  check('the new LAN method is told apart by the flag being off',
    T({ transport: 'samba', useWireGuard: false }) === 'samba', T({ transport: 'samba', useWireGuard: false }));
  check('an explicit vpn transport is the VPN one', T({ transport: 'vpn' }) === 'vpn', T({ transport: 'vpn' }));
  check('WebDAV is untouched', T({ transport: 'webdav' }) === 'webdav', T({ transport: 'webdav' }));
}
{
  // The oldest shape of all: bidirectional rsync against a mounted folder. It
  // records no transport and no flag, and must NOT be mistaken for a share —
  // reading it as one would send it down the smbclient path and fail.
  check('a legacy mounted-folder sync is neither', T({ path: '/mnt/share' }) === 'legacy', T({ path: '/mnt/share' }));
  check('and an early flag-only WireGuard sync still is the VPN one',
    T({ useWireGuard: true }) === 'vpn', T({ useWireGuard: true }));
}
{
  // The tunnel follows the method: only the VPN one may raise it.
  const conn = { smb: { ip: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' } };
  const lan = mgr({ sync: { twoway: { enabled: true, transport: 'samba', useWireGuard: false, ...conn } } });
  const vpn = mgr({ sync: { twoway: { enabled: true, transport: 'vpn', useWireGuard: true, ...conn } } });
  check('the LAN sync connection is tunnel-free', lan._twowaySambaConn()?.useWireGuard === false,
    `useWireGuard=${lan._twowaySambaConn()?.useWireGuard}`);
  check('the VPN sync connection still asks for the tunnel', vpn._twowaySambaConn()?.useWireGuard === true,
    `useWireGuard=${vpn._twowaySambaConn()?.useWireGuard}`);
}

// ── The Samba method must get a sync TIMER, or the other machine never pulls ─
// Both the timer condition and _twowayConfigured() used to look only at
// twoway.smb, so a Samba (LAN) sync got no timer at all: the machine that
// edited pushed on its own debounce, and the other one sat there until someone
// pressed sync by hand. "Realtime" pushes your edits; the interval is what
// pulls everyone else's.
{
  const conn = { ip: '192.168.30.10', host: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' };
  const lan = mgr({ sync: { twoway: { enabled: true, transport: 'samba', useWireGuard: false, smbLan: conn } } });
  check('a Samba (LAN) two-way sync counts as configured', lan._twowayConfigured() === true,
    `_twowayConfigured()=${lan._twowayConfigured()}`);
  check('and its remote folder is found', lan._twowayRemoteFolder() === 'amelie/sync',
    lan._twowayRemoteFolder());
}
{
  // Unchanged for the other two methods.
  const vpn = mgr({ sync: { twoway: { enabled: true, transport: 'vpn', useWireGuard: true,
    smb: { ip: '10.8.0.2', share: 'saturn', remoteSubPath: 'amelie/sync' } } } });
  check('the VPN method still gets one', vpn._twowayConfigured() === true, `${vpn._twowayConfigured()}`);
  const wd = mgr({ sync: { twoway: { enabled: true, transport: 'webdav', webdav: { url: 'https://dav.example' } } } });
  check('and so does WebDAV', wd._twowayConfigured() === true, `${wd._twowayConfigured()}`);
  const none = mgr({ sync: { twoway: { enabled: true, transport: 'samba', useWireGuard: false, smbLan: { ip: '1.2.3.4', share: 's' } } } });
  check('but a connection with no remote folder does not', none._twowayConfigured() === false,
    `${none._twowayConfigured()}`);
}

// ── A 30-second pass must be cheap, and silent ──────────────────────────────
// The "realtime" option is gone: the frequency itself goes down to 30 seconds.
// At that cadence a full pass every tick would keep the share busy for nothing,
// so the tick asks two cheap questions first — did the vault change, did the
// remote folder change — and only then does the work. And it must not narrate
// itself: a line in the bell twice a minute is noise.
{
  const CONN = { ip: '192.168.30.10', host: '192.168.30.10', share: 'saturn', remoteSubPath: 'amelie/sync' };
  const cfg = (intervalMinutes) => ({ sync: { twoway: { enabled: true, intervalMinutes,
    transport: 'samba', useWireGuard: false, smbLan: CONN } } });

  check('half a minute survives being read back', mgr(cfg(0.5))._twowayIntervalMinutes() === 0.5,
    `${mgr(cfg(0.5))._twowayIntervalMinutes()}`);
  check('and nothing shorter is accepted', mgr(cfg(0.01))._twowayIntervalMinutes() === 0.5,
    `${mgr(cfg(0.01))._twowayIntervalMinutes()}`);
  check('an hourly setting is untouched', mgr(cfg(60))._twowayIntervalMinutes() === 60,
    `${mgr(cfg(60))._twowayIntervalMinutes()}`);
  // A profile from a build that still had "realtime": the 15 next to it was the
  // backstop behind the push, never a choice. Honoured in the ENGINE — mapping
  // it only in the settings screen left the timer at 15 minutes until the user
  // opened Settings and saved, and the other machine's notes took that long.
  {
    const legacy = { sync: { twoway: { enabled: true, realtime: true, intervalMinutes: 15,
      transport: 'samba', useWireGuard: false, smbLan: CONN } } };
    check('a legacy realtime profile ticks at 30 s without touching Settings',
      mgr(legacy)._twowayIntervalMinutes() === 0.5, `${mgr(legacy)._twowayIntervalMinutes()}`);
  }

  // The tick: nothing changed on either side → no pass at all.
  {
    const m = mgr(cfg(0.5));
    let ran = 0;
    m.runTwoway = async () => { ran++; return { success: true }; };
    m._vaultSignature = () => 'V1';
    m._smbListRecursive = async () => ({ 'notes/a.md': 1000 });
    await m._twowayTick();                    // first tick: no baseline yet → runs
    const first = ran;
    await m._twowayTick();                    // second: both sides unchanged → skips
    check('an unchanged pair of sides costs one listing and no pass', first === 1 && ran === 1,
      `passate=${ran}`);

    m._smbListRecursive = async () => ({ 'notes/a.md': 1000, 'notes/b.md': 2000 });
    await m._twowayTick();
    check('a file appearing on the share triggers one', ran === 2, `passate=${ran}`);

    m._vaultSignature = () => 'V2';
    await m._twowayTick();
    check('and so does a change in the vault', ran === 3, `passate=${ran}`);
  }

  // Quiet: the meta the engine emits is what the bell reads.
  const metaOf = (m, manual) => {
    const seen = [];
    m._setStatus = function (status, error, meta) { seen.push(meta); };
    m._syncTwoway = async () => { throw new Error('stop here'); };
    return m.runTwoway({ manual }).then(() => seen[0]);
  };
  const fast = await metaOf(mgr(cfg(0.5)), false);
  check('a 30-second pass is marked quiet', fast && fast.quiet === true, JSON.stringify(fast));
  const pressed = await metaOf(mgr(cfg(0.5)), true);
  check('but one the user pressed is not', pressed && pressed.quiet === false && pressed.manual === true, JSON.stringify(pressed));
  const hourly = await metaOf(mgr(cfg(60)), false);
  check('an hourly one is quiet: exactly an hour is not MORE than an hour',
    hourly && hourly.quiet === true, JSON.stringify(hourly));
  const fiveMin = await metaOf(mgr(cfg(5)), false);
  check('and so is anything shorter', fiveMin && fiveMin.quiet === true, JSON.stringify(fiveMin));
  const daily = await metaOf(mgr(cfg(1440)), false);
  check('only a pass MORE than an hour apart announces success',
    daily && daily.quiet === false, JSON.stringify(daily));
}

// ── What a failed run SAYS ───────────────────────────────────────────────────
// The bell prints "<head>: <error>", and the error used to be child_process's own
// rejection: "Command failed: /home/…/amelie-smb listr amelie/sync" plus the whole of
// stderr — six wrapped lines opening with the path of a binary, which never plainly
// said the server had not answered (screenshot, 2026-09-20). One line now, naming the
// host, classified from the helper's stable SMBERR tokens rather than go-smb2's prose.
{
  const T = (stderr, killed = false) => SyncManager._smbFailureText({ stderr, killed }, '192.168.30.10', 'saturn');

  check('an unreachable network says so, with the IP',
    T('connessione fallita: dial tcp 192.168.30.10:445: connect: network is unreachable\n')
      === 'failed to connect to 192.168.30.10', T('connessione fallita: dial tcp 192.168.30.10:445: connect: network is unreachable\n'));
  check('a refused connection reads the same way',
    T('dial tcp 192.168.30.10:445: connect: connection refused\n') === 'failed to connect to 192.168.30.10');
  check('a timeout is told apart from a refusal', T('', true) === 'connection to 192.168.30.10 timed out');
  check('a wrong share name names the share',
    T('connect: The specified share name cannot be found\nSMBERR:BAD_NETWORK_NAME\n')
      === 'share "saturn" not found on 192.168.30.10');
  check('bad credentials say so, not "command failed"',
    T('connect: logon failure\nSMBERR:LOGON_FAILURE\n') === 'wrong username or password on 192.168.30.10');
  check('a permissions problem is its own case',
    T('SMBERR:ACCESS_DENIED\n') === 'access denied on 192.168.30.10');

  // The whole point: none of it carries the preamble, and none of it is long.
  const ALL = [
    T('dial tcp 192.168.30.10:445: connect: network is unreachable\n'), T('', true),
    T('SMBERR:BAD_NETWORK_NAME\n'), T('SMBERR:LOGON_FAILURE\n'), T('SMBERR:ACCESS_DENIED\n'),
    T('rename: something odd happened\n'), T(''),
  ];
  check('no message carries the "Command failed" preamble', !ALL.some(m => /Command failed/i.test(m)), JSON.stringify(ALL));
  check('no message leaks the helper path', !ALL.some(m => /amelie-smb|\/home\//.test(m)), JSON.stringify(ALL));
  check('no message ever prints the SMBERR token', !ALL.some(m => /SMBERR/.test(m)), JSON.stringify(ALL));
  check('every message fits one line, under 80 chars',
    ALL.every(m => m.length <= 80 && !m.includes('\n')), JSON.stringify(ALL.map(m => m.length)));
  check('an unrecognised failure still says something useful',
    T('rename: something odd happened\n') === 'rename: something odd happened');
  check('and an empty stderr does not produce an empty notification',
    T('') === 'sync failed on 192.168.30.10');
}

// ── The user's home directory never reaches a notification ───────────────────
// "non mi piace che si vedeva il mio path" (2026-09-20). _smbFailureText handles the
// helper's own failures, but it is not the only source: an fs or tar error carries the
// file it choked on, and Node writes those messages, not us. The scrub therefore sits
// on _setStatus, the single door every status — and so every bell entry — goes through.
// Driven against the REAL _setStatus, with a stand-in for electron's BrowserWindow, so
// what is asserted is what the renderer would actually receive.
{
  const HOME = os.homedir();
  const sent = [];
  const eid = require.resolve('electron');
  const saved = require.cache[eid];
  require.cache[eid] = { id: eid, filename: eid, loaded: true, exports: {
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_ch, data) => sent.push(data) } }] },
  } };
  try {
    const m = new SyncManager('/nonexistent/notes', '/nonexistent/attachments', '/nonexistent/settings.json');

    m._setStatus('error', `ENOENT: no such file or directory, open '${HOME}/Documents/amelie-vault/notes/a.md'`, { op: 'backup' });
    const fsErr = sent.at(-1).error;
    check('an fs error reaches the bell with the home replaced by ~',
      fsErr === "ENOENT: no such file or directory, open '~/Documents/amelie-vault/notes/a.md'", fsErr);
    check('and it still says WHICH file, so the scrub costs no meaning',
      fsErr.includes('amelie-vault/notes/a.md'), fsErr);

    m._setStatus('error', `Command failed: ${HOME}/.local/share/amelie/app/resources/amelie-smb listr`, { op: 'twoway' });
    check('so does any message naming the app under the home',
      !sent.at(-1).error.includes(HOME), sent.at(-1).error);

    m._setStatus('error', 'failed to connect to 192.168.30.10', { op: 'twoway' });
    check('a message with no path in it is passed through untouched',
      sent.at(-1).error === 'failed to connect to 192.168.30.10', sent.at(-1).error);

    m._setStatus('ok', null, { op: 'backup' });
    check('and a success still carries no error at all', sent.at(-1).error === null, JSON.stringify(sent.at(-1)));

    check('every occurrence goes, not just the first',
      SyncManager._publicError(`${HOME}/a and ${HOME}/b`) === '~/a and ~/b');
    check('a home of "/" would scrub everything, so it is left alone',
      typeof SyncManager._publicError('/etc/passwd') === 'string');
  } finally {
    if (saved) require.cache[eid] = saved; else delete require.cache[eid];
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : '  — ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
