const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('inkwell', {
  // Debug (CM engine tracing) — appends a line to /tmp/amelie-cm-debug.log
  debugLog: (text) => ipcRenderer.invoke('debug:cmlog', text),
  // Real filesystem path of a dropped/selected File (Electron 32+ removed File.path;
  // this is the supported replacement — needed to detect a dropped folder reliably,
  // since webkitGetAsEntry is flaky for directories on Linux/Wayland).
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return ''; } },
  // Vault
  vault: {
    setup:            (opts)       => ipcRenderer.invoke('vault:setup', opts),
    browseFolder:     ()           => ipcRenderer.invoke('vault:browseFolder'),
    changePath:       (p)          => ipcRenderer.invoke('vault:changePath', p),
    importFolder:     (p)          => ipcRenderer.invoke('vault:importFolder', p),
    filterDirs:       (paths)      => ipcRenderer.invoke('vault:filterDirs', paths),
    importObsidian:   (p, dest)    => ipcRenderer.invoke('vault:importObsidian', p, dest),
    restoreArchive:   (p, pass)    => ipcRenderer.invoke('vault:restoreArchive', p, pass),
    restoreFolder:    (p, pass)    => ipcRenderer.invoke('vault:restoreFolder', p, pass),
    pickRestore:      ()           => ipcRenderer.invoke('vault:pickRestore'),
    getInfo:          ()           => ipcRenderer.invoke('vault:getInfo'),
    unlock:           (pass)       => ipcRenderer.invoke('vault:unlock', pass),
    autoUnlock:        ()           => ipcRenderer.invoke('vault:autoUnlock'),
    enableEncryption: (pass, algo, openPlaintext) => ipcRenderer.invoke('vault:enableEncryption', pass, algo, openPlaintext),
    disableEncryption:(pass)       => ipcRenderer.invoke('vault:disableEncryption', pass),
    setRestMode:      (openPlaintext) => ipcRenderer.invoke('vault:setRestMode', openPlaintext),
    changePassphrase: (old, nw)    => ipcRenderer.invoke('vault:changePassphrase', old, nw),
  },

  // VPN with Samba
  deps: {
    check:   ()           => ipcRenderer.invoke('deps:check'),
    install: (payload)    => ipcRenderer.invoke('deps:install', payload),
  },
  wg: {
    saveConf:             (confContent) => ipcRenderer.invoke('wg:saveConf', confContent),
    saveOvpn:             (payload)     => ipcRenderer.invoke('ovpn:saveConf', payload),
    updateOvpnCreds:      (payload)     => ipcRenderer.invoke('ovpn:updateCreds', payload),
    removeConf:           ()            => ipcRenderer.invoke('wg:removeConf'),
    getConf:              ()            => ipcRenderer.invoke('wg:getConf'),
    getRawConf:           ()            => ipcRenderer.invoke('wg:getRawConf'),
    status:               ()            => ipcRenderer.invoke('wg:status'),
    testTunnel:           (host)        => ipcRenderer.invoke('wg:testTunnel', { host }),
    testSmbWrite:         (cfg, purpose) => ipcRenderer.invoke('wg:testSmbWrite', cfg, purpose),
    handshake:            ()            => ipcRenderer.invoke('wg:handshake'),
    saveSyncConnection:   (cfg)         => ipcRenderer.invoke('wg:saveSyncConnection', cfg),
    removeSyncConnection: ()            => ipcRenderer.invoke('wg:removeSyncConnection'),
    removeVpnKeepSamba:   ()            => ipcRenderer.invoke('wg:removeVpnKeepSamba'),
    removeSambaOnly:      (scope)       => ipcRenderer.invoke('wg:removeSambaOnly', scope),
  },

  showItemInFolder: (relPath) => ipcRenderer.invoke('shell:showItemInFolder', relPath),

  // Custom themes (<app-data>/themes): list CSS, create/delete a theme file
  themes: {
    list:       () => ipcRenderer.invoke('themes:list'),
    create:     () => ipcRenderer.invoke('themes:create'),
    edit:       (id) => ipcRenderer.invoke('themes:edit', id),
    delete:     (id) => ipcRenderer.invoke('themes:delete', id),
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', title),

  todo: {
    list:   ()                          => ipcRenderer.invoke('todo:list'),
    create: (bucket, text, due, alert)  => ipcRenderer.invoke('todo:create', bucket, text, due, alert),
    update: (bucket, file, t, due, alert) => ipcRenderer.invoke('todo:update', bucket, file, t, due, alert),
    move:   (file, from, to)            => ipcRenderer.invoke('todo:move', file, from, to),
    remove: (bucket, file)              => ipcRenderer.invoke('todo:delete', bucket, file),
  },

  // File system
  listNotes: () => ipcRenderer.invoke('fs:listNotes'),
  searchNotes: (q) => ipcRenderer.invoke('fs:searchNotes', q),
  readNote: (p) => ipcRenderer.invoke('fs:readNote', p),
  writeNote: (p, c, opts) => ipcRenderer.invoke('fs:writeNote', p, c, opts),   // opts.keepModified: don't bump `modified`
  deleteNote: (p) => ipcRenderer.invoke('fs:deleteNote', p),
  createFolder: (p) => ipcRenderer.invoke('fs:createFolder', p),
  deleteFolder: (p) => ipcRenderer.invoke('fs:deleteFolder', p),
  renameNote: (o, n) => ipcRenderer.invoke('fs:renameNote', o, n),

  // Export note → PDF (returns { ok, path } | { canceled } | { error })
  exportPdf: (name, html, opts) => ipcRenderer.invoke('note:exportPdf', name, html, opts),

  // Attachments
  attachmentExists: (rel) => ipcRenderer.invoke('attachment:exists', rel),
  saveAttachment: (name, buf) => ipcRenderer.invoke('attachment:save', name, buf),
  attachmentUsedBy: (name) => ipcRenderer.invoke('attachment:usedBy', name),   // notes that link it
  importAttachmentPath: (srcPath, name) => ipcRenderer.invoke('attachment:importPath', srcPath, name),
  showAttachmentInFolder: (name) => ipcRenderer.invoke('attachment:showInFolder', name),
  openAttachmentFile: (name) => ipcRenderer.invoke('attachment:openFile', name),
  // Synchronous: copied file paths as the OS clipboard really sees them.
  readClipboardFilePaths: () => ipcRenderer.sendSync('clipboard:file-paths'),
  // Base URL of the localhost media server (audio/video playback).
  mediaBaseUrl: () => ipcRenderer.sendSync('media:base-url'),
  readAttachment: (name) => ipcRenderer.invoke('attachment:readBinary', name),
  bakePdfAnnotations: (name, annots, formB64) => ipcRenderer.invoke('pdf:bakeAnnotations', name, annots, formB64),
  bakePdfAnnotationsAsNew: (name, annots, suffix, formB64) => ipcRenderer.invoke('pdf:bakeAnnotationsAsNew', name, annots, suffix, formB64),
  savePdfBytes: (name, b64) => ipcRenderer.invoke('pdf:savePdfBytes', name, b64),
  savePdfBytesAsNew: (name, b64, suffix) => ipcRenderer.invoke('pdf:savePdfBytesAsNew', name, b64, suffix),
  pickPdfImage: () => ipcRenderer.invoke('pdf:pickImage'),
  pickPdfForMerge: () => ipcRenderer.invoke('pdf:pickPdf'),
  applyPdfPageOps: (name, plan, sources, opts) => ipcRenderer.invoke('pdf:applyPageOps', name, plan, sources, opts),
  compressPdf: (name, level, label) => ipcRenderer.invoke('pdf:compress', name, level, label),
  openAttachmentDialog: () => ipcRenderer.invoke('attachment:openDialog'),
  renameAttachment: (oldName, newName) => ipcRenderer.invoke('attachment:rename', oldName, newName),
  deleteAttachment: (name) => ipcRenderer.invoke('attachment:delete', name),
  removeUnusedMedia: (apply) => ipcRenderer.invoke('attachment:removeUnusedMedia', apply),

  // Config & Sync
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (c) => ipcRenderer.invoke('config:write', c),
  readTreeOrder: () => ipcRenderer.invoke('tree-order:read'),
  writeTreeOrder: (o) => ipcRenderer.invoke('tree-order:write', o),
  triggerTwoway: () => ipcRenderer.invoke('sync:triggerTwoway'),
  triggerBackup: () => ipcRenderer.invoke('sync:triggerBackup'),
  testLocalPath: (p) => ipcRenderer.invoke('sync:testLocalPath', p),
  testWebdav: (cfg) => ipcRenderer.invoke('sync:testWebdav', cfg),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  startMove: () => ipcRenderer.send('window:startMove'),
  vaultClose: () => ipcRenderer.send('vault:close'),

  // Detach a note into its own resizable window (movable to another screen).
  openDetached: (path, name, theme) => ipcRenderer.send('window:detach', { path, name, theme }),
  // Synchronous: tells main which note sits under a right-click BEFORE the
  // native context menu pops, so it can offer "Open in new window" for it.
  setCtxNoteTarget: (info) => ipcRenderer.sendSync('ctx:set-note-target', info),

  // Platform info
  platform: process.platform,
  appVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Events from main process
  onSyncStatus: (cb) => ipcRenderer.on('sync:statusUpdate', (_, data) => cb(data)),
  onEditorCmd:  (cb) => ipcRenderer.on('editor:cmd', (_, cmd) => cb(cmd)),
  // Fired when notes/folders change on disk from OUTSIDE the app (file manager, sync).
  onVaultChanged: (cb) => ipcRenderer.on('vault:treeChanged', () => cb()),
});
