const { contextBridge, ipcRenderer } = require('electron');
// v1.1.2: webUtils.getPathForFile resolves a dropped File to its real on-disk
// path — only available in the preload (needs the File object identity).
let _getPathForFile = null;
try { _getPathForFile = require('electron').webUtils && require('electron').webUtils.getPathForFile; } catch (e) {}

contextBridge.exposeInMainWorld('electronAPI', {
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  isElectron: () => true,

  // v1.1.2 — real path of a dragged/dropped file (Windows .lnk shortcuts etc.)
  getPathForFile: async (fileObj) => {
    try {
      if (_getPathForFile && fileObj && typeof fileObj === 'object') {
        const p = _getPathForFile(fileObj);
        if (p) {
          const r = await ipcRenderer.invoke('resolve-file-path', p);
          if (r && r.success) return r.path;
        }
      }
      if (fileObj && fileObj.path) {
        const r = await ipcRenderer.invoke('resolve-file-path', fileObj.path);
        if (r && r.success) return r.path;
      }
    } catch (e) {}
    return '';
  },

  // Auto-updater
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  getAutoUpdateSetting: () => ipcRenderer.invoke('get-auto-update-setting'),
  setAutoUpdateSetting: (enabled) => ipcRenderer.invoke('set-auto-update-setting', enabled),

  // Update events
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on('update-progress', (e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', () => cb()),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (e, info) => cb(info)),

  // Windows game direct launch (OS opens/runs the file itself)
  launchWindowsGame: (filePath) => ipcRenderer.invoke('launch-windows-game', filePath),

  // Steam cover lookup (main process, bypasses browser CORS)
  steamSearch: (title) => ipcRenderer.invoke('steam-search', title),

  // v1.1.4: PC game auto-detection (Steam + Epic) and protocol launching
  pcDetectGames: () => ipcRenderer.invoke('pc-detect-games'),
  pcLaunchGame: (data) => ipcRenderer.invoke('pc-launch-game', data),

  // External emulator (PS2, etc.)
  launchExternal: (data) => ipcRenderer.invoke('launch-external', data),
  browseEmulator: () => ipcRenderer.invoke('browse-emulator'),
  saveRomTemp: (data) => ipcRenderer.invoke('save-rom-temp', data),
  fileExists: (path) => ipcRenderer.invoke('file-exists', path),

  // Extract icon from .exe file (for Windows game covers)
  extractExeIcon: (data) => ipcRenderer.invoke('extract-exe-icon', data),

  // Generic HTTP(S) proxy (main process, bypasses browser CORS) — used for AI chat/image calls
  httpRequest: (opts) => ipcRenderer.invoke('http-request', opts),

  // v1.2.5 — loopback-only channel for local AI runtimes (Ollama/LM Studio).
  // Same response shape as httpRequest; the main process enforces loopback +
  // port-allowlist so the SSRF wall on the generic proxy stays intact.
  aiLocalRequest: (opts) => ipcRenderer.invoke('ai-local-request', opts),
  aiLocalPortAllow: (port) => ipcRenderer.invoke('ai-local-port-allow', port),

  // Data folders (v1.0.8 storage manager): ROMs/Saves/Screenshots/Recordings/Covers/Backups/Cores
  getDataPaths: () => ipcRenderer.invoke('data-paths-info'),
  chooseDataRoot: (migrate) => ipcRenderer.invoke('choose-data-root', migrate),
  openDataPath: (idOrPath) => ipcRenderer.invoke('open-data-path', idOrPath),
  saveDataFile: (data) => ipcRenderer.invoke('save-data-file', data),
  deleteDataFile: (data) => ipcRenderer.invoke('delete-data-file', data),

  // v1.2.2 — EJS offline backend (loopback mirror + Iranian zip import + clipboard)
  quitAndInstall: () => ipcRenderer.invoke('update-install'),
  startCoreServer: () => ipcRenderer.invoke('core-server-start'),
  readLocalFile: (kind, name) => ipcRenderer.invoke('local-file-read', kind, name),
  checkLocalCore: (realCore) => ipcRenderer.invoke('local-core-check', realCore),
  deleteLocalCore: (realCore) => ipcRenderer.invoke('local-core-delete', realCore),
  ejsAssetCheck: () => ipcRenderer.invoke('ejs-assets-check'),
  ejsAssetDownload: () => ipcRenderer.invoke('ejs-assets-download'),
  saveCoreFile: (name, data) => ipcRenderer.invoke('core-file-save', name, data),
  downloadWithProgress: (id, url, timeoutMs) => ipcRenderer.invoke('download-with-progress', { id, url, timeoutMs }),
  onDlProgress: (cb) => ipcRenderer.on('dl-progress', (e, d) => cb(d)),
  importZipBuffer: (buffer) => ipcRenderer.invoke('import-zip-buffer', { buffer }),
  ejsZipUrlImport: (url) => ipcRenderer.invoke('ejs-zip-url-import', url),
  ejsZipFileImport: () => ipcRenderer.invoke('ejs-zip-file-import'),
  copyToClipboard: (text) => ipcRenderer.invoke('clip-copy', text),

  // v1.2.4 — live progress downloads + DNS manager
  coreDownload: (url, progressId) => ipcRenderer.invoke('core-download', { url, progressId }),
  onCoreDlProgress: (cb) => ipcRenderer.on('core-dl-progress', (e, d) => cb(d)),
  dnsPing: (host, count) => ipcRenderer.invoke('dns-ping', host, count),
  dnsApply: (dns1, dns2) => ipcRenderer.invoke('dns-apply', dns1, dns2),
  dnsReset: () => ipcRenderer.invoke('dns-reset'),

  // v1.3.0 — custom title bar (frameless window) controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  windowFullscreen: () => ipcRenderer.invoke('window-fullscreen'),
  toggleDevtools: () => ipcRenderer.invoke('toggle-devtools'),
  onWindowState: (cb) => ipcRenderer.on('window-state-changed', (e, s) => cb(s)),

  // v1.3.0 — external emulator packages (ePSXe PS1 / PCSX2 PS2) + inventory
  emuPkgDownload: (pkgId) => ipcRenderer.invoke('emu-pkg-download', pkgId),
  emuPkgStatus: () => ipcRenderer.invoke('emu-pkg-status'),
  emuInventory: () => ipcRenderer.invoke('emu-inventory'),

  // v1.1.2 — wallpaper gallery (all network I/O happens in the main process)
  galleryFetch: (opts) => ipcRenderer.invoke('gallery-fetch', opts),
  wallpaperDownload: (opts) => ipcRenderer.invoke('wallpaper-download', opts),
  wallpaperCancel: (id) => ipcRenderer.invoke('wallpaper-cancel', id),
  wallpaperList: () => ipcRenderer.invoke('wallpaper-list'),
  wallpaperDelete: (file) => ipcRenderer.invoke('wallpaper-delete', file),
  wallpaperCleanup: (opts) => ipcRenderer.invoke('wallpaper-cleanup', opts),
  onWpDlProgress: (cb) => ipcRenderer.on('wp-dl-progress', (e, d) => cb(d))
});
