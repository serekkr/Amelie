// WebDAV two-way: how many requests a pass costs, and how many of them travel together.
//
// From serekkr's own Nextcloud on 13/10/2026: "sto facendo il sync now tramite webdav
// ma e molto lento". Measured while it ran — one TCP connection, one request in
// flight, about a second each against a vault of 794 files. The transfers were
// strictly one after the other and every upload asked for its folder again first,
// so a first pass was roughly 1600 requests in single file.
//
// What this pins, against a fake server (the engine's requests are what is measured,
// not whether WebDAV works):
//   - transfers ride six at a time, and never more;
//   - a folder costs ONE MKCOL per pass, not one per file in it;
//   - a pass that uploads nothing does not pay the second full listing;
//   - and none of that changes what lands on the server.
//
//   run: npm test
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── the fake server ────────────────────────────────────────────────────────────
// Every call costs a tick of latency, so "in flight at the same time" is a real
// measurement and not an artefact of synchronous code.
function fakeServer({ latencyMs = 5 } = {}) {
  const files = new Map();                 // '/amelie/sync/notes/a.md' → { body, mtime }
  const dirs = new Set(['/amelie/sync']);
  const stats = { propfind: 0, mkcol: 0, put: 0, get: 0, del: 0, exists: 0, maxPar: 0, cur: 0 };
  const trip = async (fn) => {
    stats.cur++; if (stats.cur > stats.maxPar) stats.maxPar = stats.cur;
    try { await sleep(latencyMs); return fn(); } finally { stats.cur--; }
  };
  const client = {
    async getDirectoryContents(base, opts) {
      return trip(() => {
        stats.propfind++;
        if (!dirs.has(base.replace(/\/+$/, ''))) { const e = new Error('404 Not Found'); throw e; }
        const out = [];
        for (const [p, v] of files) if (p.startsWith(base.replace(/\/+$/, '') + '/'))
          out.push({ type: 'file', filename: p, lastmod: new Date(v.mtime).toUTCString() });
        return out;
      });
    },
    async createDirectory(d, _o) { return trip(() => { stats.mkcol++; let acc = ''; for (const seg of d.split('/')) { if (!seg) continue; acc += '/' + seg; dirs.add(acc); } }); },
    async putFileContents(p, body, _o) { return trip(() => { stats.put++; const dir = p.slice(0, p.lastIndexOf('/')); if (!dirs.has(dir)) throw new Error('409 Conflict: ' + dir); files.set(p, { body: Buffer.from(body), mtime: Date.now() }); return true; }); },
    async getFileContents(p, _o) { return trip(() => { stats.get++; const v = files.get(p); if (!v) throw new Error('404 Not Found'); return v.body; }); },
    async deleteFile(p) { return trip(() => { stats.del++; if (!files.delete(p)) throw new Error('404 Not Found'); }); },
    async exists(p) { return trip(() => { stats.exists++; return files.has(p) || dirs.has(p); }); },
    async stat(p) { return trip(() => { const v = files.get(p); if (!v) throw new Error('404 Not Found'); return { size: v.body.length, lastmod: new Date(v.mtime).toUTCString() }; }); },
  };
  return { client, files, dirs, stats };
}

// ── a server that answers about folders the way Nextcloud does ─────────────────
// MKCOL on a folder that is already there is a 405, MKCOL whose parent is missing
// is a 409, and PUT into a folder that does not exist is a 404. `recursive: true`
// is what the webdav client does: walk the path and create what is missing, one
// request at a time — which is where six uploads sharing an ancestor collide.
function fakeNextcloud({ latencyMs = 5 } = {}) {
  const files = new Map();
  const dirs = new Set(['/amelie/sync']);
  const stats = { propfind: 0, mkcol: 0, put: 0, put404: 0, mkcol405: 0, get: 0, del: 0, exists: 0, maxPar: 0, cur: 0, recursive: 0 };
  const trip = async (fn) => {
    stats.cur++; if (stats.cur > stats.maxPar) stats.maxPar = stats.cur;
    try { await sleep(latencyMs); return fn(); } finally { stats.cur--; }
  };
  const mkcol = (d) => trip(() => {
    stats.mkcol++;
    const parent = d.slice(0, d.lastIndexOf('/'));
    if (dirs.has(d)) { stats.mkcol405++; throw new Error('Invalid response: 405 Method Not Allowed'); }
    if (parent && !dirs.has(parent)) throw new Error('Invalid response: 409 Conflict');
    dirs.add(d);
  });
  const client = {
    async getDirectoryContents(base, opts) {
      return trip(() => {
        stats.propfind++;
        if (!dirs.has(base.replace(/\/+$/, ''))) throw new Error('Invalid response: 404 Not Found');
        const out = [];
        for (const [p, v] of files) if (p.startsWith(base.replace(/\/+$/, '') + '/'))
          out.push({ type: 'file', filename: p, lastmod: new Date(v.mtime).toUTCString() });
        return out;
      });
    },
    async createDirectory(d, o) {
      d = d.replace(/\/+$/, '');
      if (!o || !o.recursive) return mkcol(d);
      stats.recursive++;
      let acc = '';
      for (const seg of d.split('/')) {           // the client's own walk: one hop at a time
        if (!seg) continue;
        acc += '/' + seg;
        if (!dirs.has(acc)) await mkcol(acc);     // and it gives up the rest of the chain on a 405
      }
    },
    async putFileContents(p, body, _o) {
      return trip(() => {
        const dir = p.slice(0, p.lastIndexOf('/'));
        if (!dirs.has(dir)) { stats.put404++; throw new Error('Invalid response: 404 Not Found'); }
        stats.put++; files.set(p, { body: Buffer.from(body), mtime: Date.now() }); return true;
      });
    },
    async getFileContents(p, _o) { return trip(() => { stats.get++; const v = files.get(p); if (!v) throw new Error('404 Not Found'); return v.body; }); },
    async deleteFile(p) { return trip(() => { stats.del++; if (!files.delete(p)) throw new Error('404 Not Found'); }); },
    async exists(p) { return trip(() => { stats.exists++; return files.has(p) || dirs.has(p); }); },
    async stat(p) { return trip(() => { const v = files.get(p); if (!v) throw new Error('404 Not Found'); return { size: v.body.length, lastmod: new Date(v.mtime).toUTCString() }; }); },
  };
  return { client, files, dirs, stats };
}

// Hand the engine our client instead of the real one, through the module cache it
// reads at call time.
const wdPath = require.resolve('webdav');
let CURRENT = null;
require.cache[wdPath] = { id: wdPath, filename: wdPath, loaded: true, children: [], paths: [], exports: { createClient: () => CURRENT.client } };

const { SyncManager } = require(path.join(HERE, '../src/sync/syncManager.js'));

// ── the vault ──────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'amelie-wdfast-'));
const NOTES = path.join(ROOT, 'vault', 'notes');
const ATT = path.join(ROOT, 'vault', 'attachments');
const CONF = path.join(ROOT, 'conf', 'settings.json');
for (const d of [NOTES, ATT, path.dirname(CONF)]) fs.mkdirSync(d, { recursive: true });

const FOLDERS = ['00-dump', '01-clients', '01-clients/acme', '02-feedback'];
const NFILES = 60;
for (const f of FOLDERS) fs.mkdirSync(path.join(NOTES, f), { recursive: true });
const written = [];
for (let i = 0; i < NFILES; i++) {
  const f = FOLDERS[i % FOLDERS.length];
  const rel = `${f}/nota-${String(i).padStart(3, '0')}.md`;
  fs.writeFileSync(path.join(NOTES, rel), `# nota ${i}\n\nriga una\nriga due\n`, 'utf8');
  written.push('notes/' + rel);
}

const WD = { url: 'https://nc.example.test/remote.php/dav/files/x', remotePath: 'amelie/sync', username: 'u', password: 'p' };
const CFG = () => ({ sync: { enabled: true, twoway: {
  enabled: true, transport: 'webdav', propagateDeletes: true, conflictCopies: true, webdav: { ...WD } } } });

function mgr() {
  const m = new SyncManager(NOTES, ATT, CONF);
  m.config = CFG();
  m._startAutoSync = () => {}; m._stopAutoSync = () => {}; m._stopTimers = () => {}; m._setupWebDAV = () => {};
  m._setStatus = () => {}; m._progress = () => {};
  m._decSecret = (v) => v;
  m._holdMassDelete = async () => [];
  m._vaultHeaderPath = () => path.join(ROOT, 'conf', '.amelie-vault.json');
  return m;
}

const STATE = path.join(os.homedir(), '.local', 'share', 'amelie', 'twoway-state.json');
const STATE_BAK = STATE + '.wdfast-bak';
let hadState = false;

async function main() {
  // The engine keeps its baseline in the real per-user state file. Move the user's
  // aside for the run and put it back, whatever happens.
  hadState = fs.existsSync(STATE);
  if (hadState) fs.copyFileSync(STATE, STATE_BAK);
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, '{}', 'utf8');

  // ── 1. first pass: everything goes up ────────────────────────────────────────
  CURRENT = fakeServer();
  const t0 = Date.now();
  const r1 = await mgr()._twowayWebdav({ ...WD });
  const ms1 = Date.now() - t0;
  const S = CURRENT.stats;

  check('prima passata: tutti i file caricati', r1.uploaded >= NFILES, `uploaded=${r1.uploaded} su ${NFILES}`);
  const landed = written.every(rel => CURRENT.files.has('/amelie/sync/' + rel));
  check('prima passata: ogni file e sul server', landed);
  const sample = CURRENT.files.get('/amelie/sync/' + written[7]);
  check('prima passata: contenuto intatto', sample && sample.body.toString() === fs.readFileSync(path.join(NOTES, written[7].slice('notes/'.length)), 'utf8'));

  check('sei richieste alla volta, non una', S.maxPar > 1, `max in volo = ${S.maxPar}`);
  check('e mai piu di sei', S.maxPar <= SyncManager._WEBDAV_PAR, `max in volo = ${S.maxPar}, limite ${SyncManager._WEBDAV_PAR}`);
  // base + notes + attachments + the four folders = 7. One per FILE would be 60+.
  check('una MKCOL per cartella, non una per file', S.mkcol <= 12, `mkcol=${S.mkcol} per ${NFILES} file in ${FOLDERS.length} cartelle`);
  check('due elencazioni: quella iniziale e il riallineamento degli orologi', S.propfind === 2, `propfind=${S.propfind}`);

  // ── 2. a pass with nothing to do ─────────────────────────────────────────────
  const before = { ...CURRENT.stats };
  CURRENT.stats.propfind = 0; CURRENT.stats.put = 0; CURRENT.stats.mkcol = 0; CURRENT.stats.get = 0;
  const r2 = await mgr()._twowayWebdav({ ...WD });
  check('passata a vuoto: non muove niente', r2.uploaded === 0 && r2.downloaded === 0 && r2.deleted === 0, JSON.stringify(r2));
  check('passata a vuoto: una sola elencazione', CURRENT.stats.propfind === 1, `propfind=${CURRENT.stats.propfind}`);
  check('passata a vuoto: nessun PUT', CURRENT.stats.put === 0, `put=${CURRENT.stats.put}`);
  check('passata a vuoto: nessuna cartella richiesta di nuovo', CURRENT.stats.mkcol <= 3, `mkcol=${CURRENT.stats.mkcol}`);

  // ── 3. il parallelo non e solo piu richieste: e piu veloce ──────────────────
  // Un server lento (20 ms a richiesta) e 60 file: in fila sarebbero almeno 60
  // viaggi di andata e ritorno. La soglia e larga di proposito — qui si misura che
  // le richieste si sovrappongono, non quanto e veloce questa macchina.
  fs.writeFileSync(STATE, '{}', 'utf8');
  CURRENT = fakeServer({ latencyMs: 20 });
  const t2 = Date.now();
  await mgr()._twowayWebdav({ ...WD });
  const ms2 = Date.now() - t2;
  const seq = NFILES * 20;
  check('con un server lento la passata non va in fila indiana', ms2 < seq * 0.6, `${ms2} ms, in fila sarebbero almeno ${seq} ms`);

  // ── 4. una cancellazione dal server passa anche lei in parallelo ────────────
  for (const rel of written.slice(0, 10)) fs.unlinkSync(path.join(NOTES, rel.slice('notes/'.length)));
  const m4 = mgr();
  m4._holdMassDelete = async (plan) => plan.filter(p => p.d.action === 'delete-remote').map(p => p.rel);
  CURRENT.stats.del = 0; CURRENT.stats.maxPar = 0;
  const r4 = await m4._twowayWebdav({ ...WD });
  check('dieci note tolte in locale spariscono dal server', r4.deleted === 10, `deleted=${r4.deleted}`);
  check('le cancellazioni viaggiano anche loro insieme', CURRENT.stats.maxPar > 1, `max in volo = ${CURRENT.stats.maxPar}`);
  const gone = written.slice(0, 10).every(rel => !CURRENT.files.has('/amelie/sync/' + rel));
  check('e sul server non ne resta nessuna', gone);


  // ── 5. cartelle profonde che condividono gli antenati, server alla Nextcloud ──
  // Dal Nextcloud vero di serekkr, 13/10/2026: la prima passata ha lasciato 14 file
  // per terra con un 404, perche sei caricamenti chiedevano insieme la propria
  // cartella con recursive:true e si pestavano i piedi sugli antenati in comune —
  // uno vinceva la MKCOL, gli altri prendevano 405 e il client mollava li il resto
  // della catena. Nove cartelle profonde su dodici non venivano create affatto.
  const DEEP = [];
  for (const cl of ['Aramco', 'DPI-Project', 'Acme'])
    for (const sub of ['preprod-install/ADFS', 'preprod-install/LDAP', 'Serbia/clickhouse-guida', 'Serbia/kafka'])
      DEEP.push(`02 - Work/01 - clients/${cl}/${sub}`);
  for (const d of DEEP) {
    fs.mkdirSync(path.join(NOTES, d), { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(NOTES, d, `nota-${i}.md`), `# ${d} ${i}\n`, 'utf8');
  }
  fs.writeFileSync(STATE, '{}', 'utf8');
  CURRENT = fakeNextcloud();
  const r5 = await mgr()._twowayWebdav({ ...WD });
  const D = CURRENT.stats;
  const wantDeep = DEEP.flatMap(d => [0, 1, 2].map(i => `/amelie/sync/notes/${d}/nota-${i}.md`));
  const upDeep = wantDeep.filter(p => CURRENT.files.has(p)).length;
  check('cartelle profonde: nessun PUT finisce su un 404', D.put404 === 0, `404 sui PUT = ${D.put404}`);
  check('cartelle profonde: ogni file e sul server alla PRIMA passata', upDeep === wantDeep.length, `${upDeep}/${wantDeep.length}`);
  check('nessuna MKCOL ricorsiva: le cartelle si fanno un livello per volta', D.recursive === 0, `recursive=${D.recursive}`);
  check('e nessuna cartella chiesta due volte', D.mkcol405 === 0, `405 sulle MKCOL = ${D.mkcol405}`);
  check('cartelle profonde: la passata le carica tutte', r5.uploaded >= wantDeep.length, `uploaded=${r5.uploaded}`);

  void before; void ms1;
}

main().catch(e => { check('la prova e arrivata in fondo', false, e.stack || String(e)); })
  .finally(() => {
    try { if (hadState) fs.copyFileSync(STATE_BAK, STATE); else fs.unlinkSync(STATE); } catch (_) {}
    try { fs.unlinkSync(STATE_BAK); } catch (_) {}
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
    let bad = 0;
    for (const r of results) { if (!r.pass) bad++; console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`); }
    console.log(`\n${results.length - bad}/${results.length}`);
    process.exit(bad ? 1 : 0);
  });
