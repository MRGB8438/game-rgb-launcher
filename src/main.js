const { app, BrowserWindow, Menu, ipcMain, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');

// ============================================================================
// v1.2.0 — SECURITY HARDENING HELPERS
// ============================================================================
// Path containment done right: path.resolve + path.relative, so a root of
// C:\Data can never "contain" C:\Data-evil\x (the old startsWith() bug).
function isPathInside(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Extensions the app never legitimately writes/launches through its data
// pipelines. Blocking them on WRITE kills the "plant a file, then launch it"
// chain (save-data-file → launch-windows-game).
const BLOCKED_WRITE_EXTS = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.pif', '.msi',
  '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1', '.hta', '.jar',
  '.lnk', '.reg', '.dll', '.sys', '.cpl', '.msp', '.mst', '.inf']);
// Extensions the "Windows game" launcher may open (user's own library games).
const LAUNCHABLE_EXTS = new Set(['.exe', '.lnk', '.url']);

function hasBlockedWriteExt(p) {
  return BLOCKED_WRITE_EXTS.has(path.extname(String(p || '')).toLowerCase());
}
function sanitizeFileName(name, fallback) {
  const base = path.basename(String(name || fallback || 'file.bin'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return base || (fallback || 'file.bin');
}

// ---- SSRF protection: the renderer must never be able to aim the main
// process' HTTP stack at loopback / LAN / link-local / cloud-metadata targets.
function isPrivateAddress(a) {
  a = String(a || '').toLowerCase();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(a)) {
    const p = a.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;               // 0/8, 10/8, loopback
    if (p[0] === 169 && p[1] === 254) return true;                              // link-local (incl. 169.254.169.254)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;                  // 172.16/12
    if (p[0] === 192 && p[1] === 168) return true;                              // 192.168/16
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;                 // CGNAT 100.64/10
    if (p[0] >= 224) return true;                                               // multicast + reserved
    return false;
  }
  if (a === '::' || a === '::1') return true;                                   // unspecified + loopback
  if (/^::ffff:/.test(a)) return isPrivateAddress(a.slice(7));                  // v4-mapped
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true;                                // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true;                                // link-local fe80::/10
  if (/^64:ff9b:/.test(a)) return false;                                        // NAT64 to v4 — checked below anyway
  return false;
}
const _dnsPromises = require('dns').promises;
async function assertPublicHttpUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked protocol: ' + u.protocol);
  const h = (u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('empty host');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home')) {
    throw new Error('blocked host');
  }
  let addrs = [];
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h) || h.includes(':')) {
    addrs = [h];
  } else {
    try { addrs = (await _dnsPromises.lookup(h, { all: true, verbatim: true })).map(x => x.address); }
    catch (e) { throw new Error('dns lookup failed'); }
  }
  if (!addrs.length) throw new Error('dns empty');
  for (const a of addrs) {
    if (isPrivateAddress(a)) throw new Error('blocked address (private/internal)');
  }
  return true;
}

// ===== Auto-updater =====
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  console.log('electron-updater not installed');
}

let mainWindow = null;
let autoUpdateEnabled = true;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0a14',
    title: 'Game RGB Launcher',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    // v1.3.0: custom frameless title bar — the renderer draws GAME RGB's own
    // Dark-Glass title bar (logo + version + min/max/close) and drives it via
    // the window-* IPC channels. The Windows-default menu bar is removed too
    // (Menu.setApplicationMenu(null) below).
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // v1.2.0: true OS-level sandbox for the renderer. The preload only uses
      // contextBridge + ipcRenderer, both fully supported inside the sandbox.
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // v1.1.1: timers/animations throttle to ~1/sec while the window is
      // hidden or minimized — measurably lower idle CPU when a game runs on
      // top of the launcher or the window is in the background.
      backgroundThrottling: true
    }
  });

  const htmlPath = path.join(__dirname, '..', 'game-rgb-launcher.html');
  if (fs.existsSync(htmlPath)) {
    // v1.2.0: desktop-features.js is now loaded through a normal <script> tag
    // at the end of <body> inside the HTML itself — no executeJavaScript()
    // injection from the main process anymore.
    mainWindow.loadFile(htmlPath);
  } else {
    mainWindow.loadURL('data:text/html,<h1 style="color:white;background:black;padding:50px;font-family:sans-serif">game-rgb-launcher.html not found!</h1>');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // v1.2.0: never allow the renderer to spawn real child windows/popups.
    // External http(s) links open in the system browser instead.
    try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch (e) {}
    return { action: 'deny' };
  });

  // v1.2.0: the window must never navigate away from the local launcher
  // document (e.g. through a crafted link or window.location assignment).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!/^file:/i.test(url)) {
      event.preventDefault();
      try { if (/^https?:/i.test(url)) shell.openExternal(url); } catch (e) {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // v1.3.0 — push window state to the custom title bar (maximize/restore and
  // fullscreen transitions must update the max/restore icon and hide the bar
  // in fullscreen). Works across multi-monitor setups and DPI changes.
  const sendWinState = () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('window-state-changed', {
          maximized: mainWindow.isMaximized(),
          fullscreen: mainWindow.isFullScreen()
        });
      }
    } catch (e) {}
  };
  ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'].forEach(ev => {
    mainWindow.on(ev, () => sendWinState());
  });
}

// ===== Auto-updater setup =====
function setupAutoUpdater() {
  if (!autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    if (!autoUpdateEnabled) return;
    sendToRenderer('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || ''
    });
  });

  // Download progress — fired repeatedly during download
  // percent may be undefined on some servers; we coerce to 0
  autoUpdater.on('download-progress', (progressObj) => {
    if (!autoUpdateEnabled) return;
    const percent = Math.max(0, Math.min(100, Math.round(progressObj.percent || 0)));
    const transferred = progressObj.transferred || 0;
    const total = progressObj.total || 0;
    const bytesPerSecond = progressObj.bytesPerSecond || 0;
    sendToRenderer('update-progress', {
      percent,
      transferred,
      total,
      bytesPerSecond
    });
  });

  autoUpdater.on('update-downloaded', () => {
    if (!autoUpdateEnabled) return;
    sendToRenderer('update-downloaded', {});
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err.message);
    sendToRenderer('update-error', { message: err.message });
  });

  // Check 5 seconds after launch
  setTimeout(() => {
    if (autoUpdateEnabled) {
      autoUpdater.checkForUpdates().catch(() => {});
    }
  }, 5000);
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// ===== v1.1.2 — real on-disk path for dragged files (.lnk support) =====
// Sandboxed renderers expose File.path as empty; webUtils.getPathForFile is
// the supported way to resolve a dropped File to its path. It must run in the
// PRELOAD (needs the File object identity), which then hands the path to this
// handler for validation. Fallback heuristic (name+size) for older Electron.
ipcMain.handle('resolve-file-path', async (event, filePath) => {
  const p = String(filePath || '');
  if (!p || !path.isAbsolute(p)) return { success: false };
  try { if (!fs.existsSync(p)) return { success: false }; } catch (e) { return { success: false }; }
  return { success: true, path: p };
});

// ===== Windows game direct launch (OS opens/runs the file itself) =====
ipcMain.handle('launch-windows-game', async (event, filePath) => {
  // v1.2.0 hardening: absolute path + extension allowlist (.exe/.lnk/.url).
  // Combined with the write-side extension blocks this removes the
  // "plant-then-launch" chain while keeping the user's own games working.
  const p = String(filePath || '');
  if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) {
    return { success: false, error: 'فایل بازی پیدا نشد' };
  }
  if (!LAUNCHABLE_EXTS.has(path.extname(p).toLowerCase())) {
    return { success: false, error: 'این نوع فایل مجاز به اجرا نیست' };
  }
  try {
    // shell.openPath lets Windows itself open/run the file, exactly like
    // double-clicking it in File Explorer — the launcher only triggers it,
    // it does not spawn/own the game process itself.
    const errorMessage = await shell.openPath(p);
    if (errorMessage) {
      return { success: false, error: errorMessage };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== External emulator support (PS2, etc.) =====
ipcMain.handle('launch-external', async (event, data) => {
  const { emulatorPath, romPath } = data || {};
  // v1.2.0 hardening: the emulator must be a real .exe the user picked via
  // the browse dialog, and both paths must exist. args are passed as an
  // array (never a shell string), so no shell-injection is possible.
  if (!emulatorPath || !fs.existsSync(emulatorPath)) {
    return { success: false, error: 'مسیر شبیه‌ساز پیدا نشد' };
  }
  if (path.extname(emulatorPath).toLowerCase() !== '.exe') {
    return { success: false, error: 'شبیه‌ساز باید فایل exe باشد' };
  }
  if (!romPath || !fs.existsSync(romPath)) {
    return { success: false, error: 'فایل بازی پیدا نشد' };
  }
  try {
    const child = spawn(emulatorPath, [romPath], {
      detached: true, stdio: 'ignore'
    });
    child.on('error', (err) => {
      console.error('PCSX2 launch error:', err);
    });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== v1.1.4: PC game auto-detection (Steam + Epic Games Launcher) =====
// Scans the local libraries read-only and returns what it found:
//   Steam → libraryfolders.vdf + appmanifest_*.acf (installed games only)
//   Epic  → ProgramData/Epic/EpicGamesLauncher/Data/Manifests/*.item (JSON)
// The renderer turns each find into a library card; launching goes through
// the official steam:// / epic:// URL protocols (the store client itself
// starts the game — we never spawn it or touch DRM).

// Minimal Valve VDF text parser — handles nested braces and quoted strings.
// Made tolerant of comments and stray tokens (Valve's own files sometimes
// carry both).
function vdfParse(text) {
  const root = {};
  const stack = [root];
  let i = 0;
  const n = text.length;
  const skipJunk = () => {
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/') { // comment till end of line (// only; '/' can't otherwise start a token in vdf)
        if (text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
        return;
      }
      return;
    }
  };
  const readString = () => {
    skipJunk();
    if (text[i] === '"') {
      i++;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) { out += text[i + 1]; i += 2; continue; }
        out += text[i]; i++;
      }
      i++; // closing quote
      return out;
    }
    // unquoted token (some manifests use them)
    const start = i;
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  while (i < n) {
    skipJunk();
    if (i >= n) break;
    const c = text[i];
    if (c === '{') { i++; const o = {}; const top = stack[stack.length - 1]; top.__last = o; stack.push(o); continue; }
    if (c === '}') { i++; if (stack.length > 1) stack.pop(); continue; }
    const key = readString();
    if (!key) { i++; continue; }
    skipJunk();
    if (text[i] === '{') { i++; const o = {}; top = stack[stack.length - 1]; top[key] = o; stack.push(o); continue; }
    if (text[i] === '"') { stack[stack.length - 1][key] = readString(); }
    else { stack[stack.length - 1][key] = ''; }
  }
  return root;
}

// Steam companion tools / redistributables that show up as appmanifests but
// are not games the user would want on their launcher shelf.
const STEAM_SKIP_APPS = new Set([
  2289833800,  // Steamworks SDK redistributable
  1628370800   // Steamworks Common Redistributables (appid varies — also skipped by size/name heuristics below)
]);

function scanSteamLibrary() {
  const out = [];
  const roots = [];
  try {
    const home = app.getPath('home'); // C:\Users\<name>
    // Steam in standard locations + registry-less fallbacks for portable installs
    const candidates = [
      path.join('C:', 'Program Files (x86)', 'Steam'),
      path.join('C:', 'Program Files', 'Steam'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Steam'),
      'D:\\SteamLibrary', 'E:\\SteamLibrary', 'F:\\SteamLibrary', 'G:\\SteamLibrary'
    ];
    // libraryfolders.vdf may live inside any of these and point to others
    const seenRoot = new Set();
    for (const c of candidates) {
      try {
        const lf = path.join(c, 'steamapps', 'libraryfolders.vdf');
        if (!fs.existsSync(lf)) continue;
        if (!seenRoot.has(c)) { seenRoot.add(c); roots.push(c); }
        const vdf = vdfParse(fs.readFileSync(lf, 'utf8'));
        const folders = vdf && vdf.libraryfolders;
        if (!folders) continue;
        for (const k of Object.keys(folders)) {
          const f = folders[k];
          const p = f && f.path;
          if (p && fs.existsSync(p) && !seenRoot.has(p)) { seenRoot.add(p); roots.push(p); }
        }
      } catch (e) { /* unreadable — skip */ }
    }
    if (!roots.length) return out;
    const seenApp = new Set();
    for (const root of roots) {
      const appsDir = path.join(root, 'steamapps');
      let files = [];
      try { files = fs.readdirSync(appsDir); } catch (e) { continue; }
      for (const f of files) {
        if (!f.startsWith('appmanifest_') || !f.endsWith('.acf')) continue;
        try {
          const m = vdfParse(fs.readFileSync(path.join(appsDir, f), 'utf8'));
          const st = m && (m.appState || m.AppState); // Valve writes "AppState" (capital A)
          if (!st) continue;
          const appid = parseInt(st.appid, 10);
          const name = String(st.name || '').trim();
          if (!appid || !name) continue;
          if (seenApp.has(appid)) continue;
          // Only fully-installed games: StateFlags bit 4 = fully installed,
          // AND the game's own install folder must actually exist on disk
          // (a "Downloading" manifest keeps bit 4 set while the folder is
          // missing — Dota 2 mid-download would otherwise show up).
          const flags = parseInt(st.StateFlags, 10) || 0;
          if ((flags & 4) === 0) continue;
          const installdir = String(st.installdir || '').trim();
          if (installdir && !fs.existsSync(path.join(appsDir, 'common', installdir))) continue;
          if (STEAM_SKIP_APPS.has(appid)) continue;
          const sizeGb = (parseInt(st.SizeOnDisk, 10) || 0) / 1024 / 1024 / 1024;
          // Skip tiny redistributables/tool manifests that lack a real name match
          if (sizeGb < 0.01 && /redistribut|sdk|runtime|steamworks/i.test(name)) continue;
          seenApp.add(appid);
          out.push({
            source: 'steam',
            appid: String(appid),
            title: name,
            sizeGb: Math.round(sizeGb * 10) / 10,
            coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg'
          });
        } catch (e) { /* malformed manifest — skip */ }
      }
    }
  } catch (e) { /* whole scan failed — return what we have */ }
  return out;
}

function scanEpicLibrary() {
  const out = [];
  try {
    const roots = [
      path.join('C:', 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests'),
      path.join('C:', 'Program Files', 'Epic Games'),
      path.join('D:', 'Epic Games'),
      path.join('E:', 'Epic Games')
    ];
    const seen = new Set();
    for (const dir of roots) {
      if (!fs.existsSync(dir)) continue;
      let files = [];
      try { files = fs.readdirSync(dir); } catch (e) { continue; }
      for (const f of files) {
        if (!f.endsWith('.item')) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          // real install manifests have an install location + display name
          const title = String(m.DisplayName || '').trim();
          if (!title) continue;
          const appName = String(m.AppName || m.CatalogNamespace || '');
          const install = String(m.InstallLocation || '');
          if (appName && seen.has(appName)) continue;
          if (m.bIsIncompleteInstall === true) continue;
          if (install && !fs.existsSync(install)) continue; // uninstalled leftover
          if (appName) seen.add(appName);
          out.push({
            source: 'epic',
            appName: appName,
            title: title,
            sizeGb: Math.round(((m.AppSizeBytes || 0) / 1024 / 1024 / 1024) * 10) / 10,
            // Epic has no public cover CDN keyed by AppName — the renderer
            // falls back to its normal SGDB/curated cover search.
            coverUrl: null
          });
        } catch (e) { /* malformed .item — skip */ }
      }
    }
  } catch (e) { /* whole scan failed */ }
  return out;
}

ipcMain.handle('pc-detect-games', async () => {
  try {
    const steam = scanSteamLibrary();
    const epic = scanEpicLibrary();
    return {
      ok: true,
      steamFound: steam.length > 0 || fs.existsSync(path.join('C:', 'Program Files (x86)', 'Steam', 'steamapps')),
      epicFound: epic.length > 0 || fs.existsSync(path.join('C:', 'ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')),
      games: steam.concat(epic)
    };
  } catch (e) {
    return { ok: false, error: e.message, games: [] };
  }
});

// Launch a PC platform game via its official URL protocol (steam://rungameid/<appid>,
// epic://apps/<appName>) — the store client itself starts the game.
ipcMain.handle('pc-launch-game', async (event, data) => {
  try {
    const { source, appid, appName } = data || {};
    let url = '';
    if (source === 'steam' && /^\d+$/.test(String(appid || ''))) url = 'steam://rungameid/' + appid;
    else if (source === 'epic' && /^[a-zA-Z0-9._-]+$/.test(String(appName || ''))) url = 'epic://apps/' + appName;
    if (!url) return { success: false, error: 'invalid target' };
    await shell.openExternal(url); // protocols are handed to the OS handler (the store client)
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== Steam cover lookup (runs in main process — no CORS restrictions) =====
ipcMain.handle('steam-search', async (event, title) => {
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const url = 'https://store.steampowered.com/api/storesearch/?term=' +
        encodeURIComponent(title) + '&l=english&cc=us';
      const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.items) && data.items.length > 0) {
              const item = data.items[0];
              resolve({ success: true, appid: item.id, name: item.name });
            } else {
              resolve({ success: false, error: 'not found' });
            }
          } catch (e) {
            resolve({ success: false, error: e.message });
          }
        });
      });
      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.setTimeout(6000, () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
});

ipcMain.handle('file-exists', async (event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch (e) {
    return false;
  }
});

// ===== Generic HTTP(S) proxy for AI service calls (runs in main process — no CORS) =====
// Used by acHttpFetch() in the renderer for chat/image-gen providers (OpenRouter,
// Together, Fireworks, Gemini, Hugging Face, custom endpoints, ...). Running the
// request here means:
//   - no renderer-side CORS: this is a plain Node network request, not a browser fetch
//   - the OS/system proxy or VPN is respected automatically, same as any other app
// v1.2.5: shared request core. `guard(url)` is awaited for the initial URL and
// again for every redirect hop — it must throw to reject the target. Both the
// public proxy (SSRF guard) and the loopback-only local-AI channel use it.
function runProxiedRequest({ url, method = 'GET', headers = {}, body = null }, guard) {
  const MAX_RESPONSE_BYTES = 64 * 1024 * 1024; // 64 MB safety cap
  return new Promise((resolve) => {
    try {
      const https = require('https');
      const http = require('http');
      const { URL } = require('url');
      const zlib = require('zlib');

      // Default to a real-browser User-Agent if caller didn't set one.
      // Many sites (e.g. gamefa.com behind Cloudflare) reject requests that
      // look like scripts/bots. Using a full Chrome UA + Accept-Encoding lets
      // us fetch the page directly with the Iranian network (no VPN needed).
      const finalHeaders = { ...headers };
      if (!finalHeaders['User-Agent'] && !finalHeaders['user-agent']) {
        finalHeaders['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
      }
      if (!finalHeaders['Accept'] && !finalHeaders['accept']) {
        finalHeaders['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
      }
      if (!finalHeaders['Accept-Language'] && !finalHeaders['accept-language']) {
        finalHeaders['Accept-Language'] = 'en-US,en;q=0.9,fa;q=0.8';
      }
      // Tell the server we accept gzip — we decompress below. Without this,
      // some sites (e.g. zoomg.ir) send raw bytes that aren't valid UTF-8 and
      // the renderer-side HTML parser can't extract any articles.
      if (!finalHeaders['Accept-Encoding'] && !finalHeaders['accept-encoding']) {
        finalHeaders['Accept-Encoding'] = 'gzip, deflate';
      }

      const doRequest = async (currentUrl, method, redirectsLeft) => {
        try { await guard(currentUrl); }
        catch (e) {
          resolve({ ok: false, status: 0, statusText: 'blocked', error: 'blocked: ' + e.message, bodyBase64: '' });
          return;
        }
        let parsedUrl;
        try {
          parsedUrl = new URL(currentUrl);
        } catch (e) {
          resolve({ ok: false, status: 0, statusText: 'invalid URL', error: e.message, bodyBase64: '' });
          return;
        }
        const currentLib = parsedUrl.protocol === 'http:' ? http : https;
        const reqOptions = {
          method,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (parsedUrl.protocol === 'http:' ? 80 : 443),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: finalHeaders
        };

        const req = currentLib.request(reqOptions, (res) => {
          // Follow redirects ourselves — Node's raw http/https.request does NOT
          // follow 3xx responses automatically (unlike browser fetch()). Without
          // this, any site that redirects the requested URL (trailing-slash
          // normalization, http->https, category path changes, etc.) would come
          // back as a failed/empty response here even though it works fine in a
          // real browser tab or the web build.
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume(); // discard body
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            // 303 always becomes GET; 301/302 conventionally downgrade POST->GET too
            const nextMethod = (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method !== 'GET')) ? 'GET' : method;
            doRequest(nextUrl, nextMethod, redirectsLeft - 1);
            return;
          }

          const chunks = [];
          let received = 0;
          res.on('data', chunk => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              try { req.destroy(); } catch (e) {}
              resolve({ ok: false, status: 0, statusText: 'response too large', error: 'response-too-large', bodyBase64: '' });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            let buffer = Buffer.concat(chunks);
            const enc = (res.headers['content-encoding'] || '').toLowerCase();
            try {
              if (enc.includes('gzip')) {
                buffer = zlib.gunzipSync(buffer);
              } else if (enc.includes('deflate')) {
                buffer = zlib.inflateSync(buffer);
              } else if (enc.includes('br')) {
                buffer = zlib.brotliDecompressSync(buffer);
              }
            } catch (e) {
              // If decompression fails, fall through with the raw buffer —
              // the caller's parser may still be able to extract something.
            }
            let contentType = res.headers['content-type'] || '';
            if (Array.isArray(contentType)) contentType = contentType[0] || '';
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              statusText: res.statusMessage || '',
              contentType,
              bodyBase64: buffer.toString('base64')
            });
          });
          res.on('error', (err) => {
            resolve({ ok: false, status: 0, statusText: err.message, error: err.message, bodyBase64: '' });
          });
        });

        req.on('error', (err) => {
          // e.g. DNS failure, connection refused, provider blocked/filtered, etc.
          resolve({ ok: false, status: 0, statusText: err.message, error: err.message, bodyBase64: '' });
        });

        req.setTimeout(30000, () => { req.destroy(); resolve({ ok: false, status: 0, statusText: 'timeout', error: 'timeout', bodyBase64: '' }); });

        if (body && method !== 'GET') {
          req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
      };

      doRequest(url, method, 5);
    } catch (err) {
      resolve({ ok: false, status: 0, statusText: err.message, error: err.message, bodyBase64: '' });
    }
  });
}

ipcMain.handle('http-request', async (event, opts) => {
  // v1.2.0: SSRF guard — reject anything that is not a public http(s) target
  // BEFORE the first byte goes on the wire (covers loopback, LAN, link-local,
  // CGNAT, ULA and cloud-metadata ranges, and every redirect hop as well).
  try { await assertPublicHttpUrl(opts && opts.url); }
  catch (e) { return { ok: false, status: 0, statusText: 'blocked', error: 'blocked: ' + e.message, bodyBase64: '' }; }
  return runProxiedRequest(opts || {}, assertPublicHttpUrl);
});

// ============================================================================
// v1.2.5 — dedicated loopback-only channel for local AI runtimes (Ollama,
// LM Studio, llama.cpp servers …). The generic http-request proxy blocks
// loopback on purpose (SSRF); local AI is a first-class feature though, so it
// gets this separate, tightly-scoped channel:
//   * host MUST be a loopback literal (127.0.0.1 / ::1 / localhost)
//   * port MUST be in the allowlist (seeded with Ollama's 11434; the renderer
//     registers the port the user configured for their local runtime)
//   * every redirect hop is re-checked with the same rules
// ============================================================================
const aiLocalPorts = new Set([11434]);
function isLoopbackHostLiteral(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}
async function assertLoopbackAiUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked protocol: ' + u.protocol);
  if (!isLoopbackHostLiteral(u.hostname)) throw new Error('not a loopback host');
  const port = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);
  if (!aiLocalPorts.has(port)) throw new Error('local-AI port not allowed: ' + port);
  return true;
}
ipcMain.handle('ai-local-port-allow', (event, port) => {
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { success: false };
  if (aiLocalPorts.size >= 24) { aiLocalPorts.clear(); aiLocalPorts.add(11434); } // hard cap
  aiLocalPorts.add(p);
  return { success: true };
});
ipcMain.handle('ai-local-request', async (event, opts) => {
  try { await assertLoopbackAiUrl(opts && opts.url); }
  catch (e) { return { ok: false, status: 0, statusText: 'blocked', error: 'blocked: ' + e.message, bodyBase64: '' }; }
  return runProxiedRequest(opts || {}, assertLoopbackAiUrl);
});

ipcMain.handle('browse-emulator', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Emulator',
    filters: [{ name: 'Executables', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled) return { canceled: true };
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('save-rom-temp', async (event, data) => {
  const { name, buffer } = data || {};
  // v1.2.0: sanitized filename (no traversal, no dangerous executable types)
  const safeName = sanitizeFileName(name, 'rom.bin');
  if (hasBlockedWriteExt(safeName)) return { success: false, error: 'invalid file type' };
  const tempDir = path.join(app.getPath('temp'), 'gamergb');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, safeName);
  fs.writeFileSync(tempPath, Buffer.from(buffer || []));
  return { success: true, path: tempPath };
});

// ===== Extract icon from .exe file (for Windows game covers) =====
ipcMain.handle('extract-exe-icon', async (event, data) => {
  const { name, buffer } = data;
  try {
    const tempDir = path.join(app.getPath('temp'), 'gamergb_icons');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    // v1.2.0: strict charset — the name is interpolated into a PowerShell
    // script, so ONLY [A-Za-z0-9._ -] survive ($, backtick, quotes, parens
    // and friends are all rejected here, killing any PS injection vector).
    const safeName = (name || 'temp.exe').replace(/[^A-Za-z0-9._ -]/g, '_').slice(-80);
    if (!safeName) return { success: false, error: 'invalid name' };
    const parsed = path.parse(safeName);
    const uniquePrefix = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tempExePath = path.join(tempDir, uniquePrefix + '_' + safeName);
    const iconPath = path.join(tempDir, uniquePrefix + '_' + parsed.name + '.png');
    fs.writeFileSync(tempExePath, Buffer.from(buffer));

    // Only .exe/.dll/.ico carry a real associated icon on Windows; .bat/.msi
    // generally don't, but we still try — ExtractAssociatedIcon falls back
    // to a generic shell icon rather than throwing, in most cases.
    const { execFile } = require('child_process');
    // v1.2.0: single-quoted PS literals with '' escaping (defence in depth —
    // combined with the strict charset above there is nothing left to escape).
    const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const psScript = `
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psQuote(tempExePath.replace(/\\/g, '\\\\'))})
$bmp = $icon.ToBitmap()
$bmp.Save(${psQuote(iconPath.replace(/\\/g, '\\\\'))}, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$icon.Dispose()
`;

    await new Promise((resolve) => {
      // execFile (not execSync) so this runs off the main thread and doesn't
      // freeze the app UI while auto-fetching covers for several games in a row.
      const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 5000 }, (err) => {
        resolve();
      });
      child.on('error', () => resolve());
    });

    if (fs.existsSync(iconPath)) {
      const iconBuffer = fs.readFileSync(iconPath);
      const iconBase64 = iconBuffer.toString('base64');
      const dataUrl = 'data:image/png;base64,' + iconBase64;
      // Cleanup
      try { fs.unlinkSync(tempExePath); } catch(e) {}
      try { fs.unlinkSync(iconPath); } catch(e) {}
      return { success: true, iconData: dataUrl };
    }
    try { fs.unlinkSync(tempExePath); } catch(e) {}
    return { success: false, error: 'Icon not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== Auto-update setting IPC (v1.0.6: registered once at top level —
// previously inside createWindow(), which could throw "second handler" errors
// if the window was ever recreated) =====
ipcMain.handle('get-auto-update-setting', async () => {
  return autoUpdateEnabled;
});

ipcMain.handle('set-auto-update-setting', async (event, enabled) => {
  autoUpdateEnabled = enabled;
  if (!enabled && autoUpdater) {
    autoUpdater.autoDownload = false;
  } else if (enabled && autoUpdater) {
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdates().catch(() => {});
  }
  return { success: true };
});

// ===== Data folders (v1.0.8): a dedicated storage root with one subfolder per
// asset type (ROMs / Saves / Screenshots / Recordings / Covers / Backups).
// The root defaults to userData/GameRGBData but the user can relocate it from
// the Storage Manager — the choice persists in gamergb-data-root.json.
const DATA_FOLDERS = [
  { id: 'roms',        dir: 'ROMs' },
  { id: 'saves',       dir: 'Saves' },
  { id: 'screenshots', dir: 'Screenshots' },
  { id: 'recordings',  dir: 'Recordings' },
  { id: 'covers',      dir: 'Covers' },
  { id: 'backups',     dir: 'Backups' },
  { id: 'cores',       dir: 'Cores' },
  // v1.3.0: external emulator packages (ePSXe PS1 / PCSX2 PS2) live here —
  // registered like every other folder so the Storage Manager and the
  // emu manager panel can show / open / size it.
  { id: 'emulators',   dir: 'Emulators' }
];

function dataRootConfigPath() {
  return path.join(app.getPath('userData'), 'gamergb-data-root.json');
}

function getDataRoot() {
  try {
    const cfg = JSON.parse(fs.readFileSync(dataRootConfigPath(), 'utf8'));
    if (cfg && cfg.root && typeof cfg.root === 'string' && cfg.root.length > 2) return cfg.root;
  } catch (e) {}
  return path.join(app.getPath('userData'), 'GameRGBData');
}

function setDataRoot(root) {
  try { fs.writeFileSync(dataRootConfigPath(), JSON.stringify({ root })); } catch (e) {}
}

function ensureDataFolders(root) {
  const out = {};
  DATA_FOLDERS.forEach(f => {
    const p = path.join(root, f.dir);
    if (!fs.existsSync(p)) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
    out[f.id] = p;
  });
  return out;
}

function dirStats(dirPath, depth) {
  let size = 0, files = 0;
  try {
    for (const name of fs.readdirSync(dirPath)) {
      const p = path.join(dirPath, name);
      let st = null;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (depth > 0) { const sub = dirStats(p, depth - 1); size += sub.size; files += sub.files; }
      } else { size += st.size; files++; }
    }
  } catch (e) {}
  return { size, files };
}

ipcMain.handle('data-paths-info', async () => {
  try {
    const root = getDataRoot();
    const folders = ensureDataFolders(root);
    const out = { root, folders: {} };
    DATA_FOLDERS.forEach(f => {
      const p = folders[f.id];
      const st = dirStats(p, 2);
      out.folders[f.id] = { path: p, size: st.size, files: st.files };
    });
    return { success: true, ...out };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('choose-data-root', async (event, migrate) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب محل ذخیره‌سازی داده‌ها',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const newRoot = result.filePaths[0];
  const oldRoot = getDataRoot();
  setDataRoot(newRoot);
  let moved = 0;
  // Best-effort migration: copy existing managed files into the new root
  // (never overwriting anything already there). The old copy is kept as a
  // safety net — the user can delete it manually.
  if (migrate && oldRoot !== newRoot) {
    const folders = ensureDataFolders(newRoot);
    DATA_FOLDERS.forEach(f => {
      const src = path.join(oldRoot, f.dir);
      const dst = folders[f.id];
      if (!fs.existsSync(src)) return;
      try {
        for (const name of fs.readdirSync(src)) {
          const from = path.join(src, name);
          const to = path.join(dst, name);
          if (fs.existsSync(to)) continue;
          try { fs.copyFileSync(from, to); moved++; } catch (e) {}
        }
      } catch (e) {}
    });
  }
  ensureDataFolders(newRoot);
  return { success: true, root: newRoot, migrated: moved };
});

ipcMain.handle('open-data-path', async (event, idOrPath) => {
  // v1.2.0: only known folder ids, the data root itself, or paths strictly
  // INSIDE the data root may be opened in Explorer — arbitrary paths are gone.
  const root = getDataRoot();
  const folders = ensureDataFolders(root);
  let target = null;
  if (Object.prototype.hasOwnProperty.call(folders, String(idOrPath))) {
    target = folders[idOrPath];
  } else if (typeof idOrPath === 'string' && idOrPath.length && isPathInside(root, idOrPath)) {
    target = idOrPath;
  }
  if (!target) return { success: false, error: 'invalid path' };
  try {
    const err = await shell.openPath(target);
    return { success: !err, error: err || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-data-file', async (event, data) => {
  const { folderId, name, buffer } = data || {};
  try {
    const root = getDataRoot();
    const folders = ensureDataFolders(root);
    const dir = folders[folderId] || root;
    const safeName = sanitizeFileName(name, 'file.bin');
    // v1.2.0: the managed data folders hold ROMs/saves/covers/recordings —
    // never executables. This blocks the plant-a-file-then-launch chain.
    if (hasBlockedWriteExt(safeName)) {
      return { success: false, error: 'این نوع فایل مجاز به ذخیره‌سازی نیست' };
    }
    let p = path.join(dir, safeName);
    // Never overwrite — add a numeric suffix when the name already exists
    let n = 1;
    while (fs.existsSync(p)) {
      const parsed = path.parse(safeName);
      p = path.join(dir, parsed.name + '-' + (n++) + parsed.ext);
    }
    fs.writeFileSync(p, Buffer.from(buffer));
    return { success: true, path: p };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-data-file', async (event, data) => {
  try {
    const { filePath } = data || {};
    if (!filePath) return { success: false, error: 'invalid path' };
    // v1.2.0 FIX: real containment check. The old startsWith(root) let
    // C:\Data-evil\x through when the root was C:\Data. path.relative +
    // separator check makes prefix-sibling escapes impossible.
    if (!isPathInside(getDataRoot(), filePath)) {
      return { success: false, error: 'outside data root' };
    }
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ===== App lifecycle =====
// v1.1.1: optional software-rendering fallback for very old GPUs. Electron 33
// defaults to GPU compositing; on broken/black-screen setups the user can
// create a file named "gamergb-no-gpu" next to the executable (or in the
// data root) to relaunch with --disable-gpu. Measured benefit on the test
// machine was limited, so it stays opt-in rather than automatic.
if (process.argv.indexOf('--disable-gpu') === -1) {
  const noGpuMarker = path.join(app.getPath('userData'), 'gamergb-no-gpu');
  try {
    if (fs.existsSync(noGpuMarker)) app.commandLine.appendSwitch('disable-gpu');
  } catch (e) {}
}
app.whenReady().then(() => {
  createWindow();
  if (autoUpdater) setupAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ===== IPC handlers =====
ipcMain.handle('update-check', async () => {
  if (autoUpdater && autoUpdateEnabled) {
    try { await autoUpdater.checkForUpdates(); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
  }
  return { success: false, error: 'Auto-update disabled or not available' };
});

ipcMain.handle('update-install', async () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

ipcMain.handle('app-version', () => app.getVersion());

// ===== Menu =====
// v1.3.0: the Windows-default menu bar (File / View / Help) is REMOVED — the
// launcher renders its own frameless title bar and every launcher feature is
// reachable from the in-app UI. Setting the application menu to null also
// drops the default accelerators; the renderer provides its own key handling
// (F11 fullscreen etc.) through the window-* IPC channels, and devtools are
// available through the (undocumented) toggle-devtools channel.
Menu.setApplicationMenu(null);

// ===== v1.3.0 — custom title bar window controls (frameless window) =====
ipcMain.handle('window-minimize', () => { if (mainWindow) mainWindow.minimize(); return true; });
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return true;
});
ipcMain.handle('window-close', () => { if (mainWindow) mainWindow.close(); return true; });
ipcMain.handle('window-is-maximized', () => !!mainWindow && mainWindow.isMaximized());
ipcMain.handle('window-fullscreen', () => {
  if (!mainWindow) return false;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return true;
});
ipcMain.handle('toggle-devtools', () => {
  if (!mainWindow) return false;
  if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
  else mainWindow.webContents.openDevTools();
  return true;
});

// ============================================================================
// v1.2.2 — EJS OFFLINE BACKEND (parity with the v1.1.x launcher line)
// ----------------------------------------------------------------------------
// The unified launcher html (shared with the Android/TV app) drives a
// four-stage offline boot pipeline:
//   ① local loopback mirror   http://127.0.0.1:<port>/ejs/
//   ② remembered CDN data path
//   ③ public CDN mirrors (probed in parallel)
//   ④ offline blob mode (runtime + core read straight from disk)
// This backend implements the main-process side of that contract:
//   - a loopback static server that mirrors the official EmulatorJS data/
//     layout from <DataRoot>/Cores (runtime files + generated/bundled reports
//     + cores), with CORS headers so the emulator iframe can XHR it;
//   - bundled-runtime seeding: the 7 runtime files + 10 core reports that
//     ship inside the installer are copied into <DataRoot>/Cores/ejs on every
//     startup (ensureBundledEjsAssets) so first boot is already offline-capable;
//   - disk helpers (readLocalFile / checkLocalCore / saveCoreFile);
//   - the Iranian offline bundle importers (download uploadkon zip / pick a
//     local zip) extracting cores + runtime files + reports in one pass;
//   - runtime downloader (ejs-asset-download) from 4 CDN mirrors as fallback;
//   - clipboard bridge for the «کپی لینک» button.
// Layout under the data root (Cores folder is registered in DATA_FOLDERS so
// the Storage Manager can show/ move it like any other):
//   <root>/Cores/                     user-facing cores (*.data, manual drops)
//   <root>/Cores/ejs/                 loopback mirror root (served under /ejs/)
//   <root>/Cores/ejs/cores/reports/   real (bundled/ cached) core reports
// ============================================================================

const EJS_ASSET_FILES = [
  'loader.js', 'emulator.min.js', 'emulator.min.css',
  'extract7z.js', 'extractzip.js', 'libunrar.js', 'libunrar.wasm'
];
// v1.3.0: the core bundle now comes from the project owner's own distribution
// (Cores_Game_RGB_Launcher.zip: all 11 console cores in BOTH filename variants,
// the EJS runtime and ejs-assets). Replaces the old uploadkon bundle.
const EJS_CORES_ZIP_URL_DEFAULT = 'https://cdn.imgurl.ir/uploads/d936214_Cores_Game_RGB_Launcher.zip';
const EJS_CDN_MIRRORS = [
  'https://cdn.emulatorjs.org/stable/data/',
  'https://cdn.emulatorjs.org/latest/data/',
  'https://cdn.jsdelivr.net/npm/@emulatorjs/emulatorjs@4.2.3/data/',
  'https://cdn.jsdelivr.net/gh/EmulatorJS/EmulatorJS@4.2.3/data/'
];

function coresDir()  { return path.join(getDataRoot(), 'Cores'); }
// v1.1.0: factory-core deletion markers — when the user deletes a factory-
// bundled core, a marker file keeps it deleted across restarts (the startup
// seeder skips marked cores). Downloading/importing the core again clears
// the marker, so the factory behavior quietly restores itself.
function coreBaseName(name) { return String(name || '').replace(/-legacy-wasm\.data$|-wasm\.data$/, ''); }
function factorySkipPath(core) { return path.join(coresDir(), '.factory-skip-' + core); }
function markFactorySkipped(core) { try { ensureEjsDirs(); fs.writeFileSync(factorySkipPath(core), '1'); } catch (e) {} }
function clearFactorySkipForFile(name) {
  try {
    const core = coreBaseName(name);
    if (core && core !== name) { try { fs.unlinkSync(factorySkipPath(core)); } catch (e) {} }
  } catch (e) {}
}
function ejsDir()    { return path.join(coresDir(), 'ejs'); }
function ejsReportsDir() { return path.join(ejsDir(), 'cores', 'reports'); }
function ejsMirrorCoresDir() { return path.join(ejsDir(), 'cores'); }
function ejsCompressionDir() { return path.join(ejsDir(), 'compression'); }

function ensureEjsDirs() {
  [coresDir(), ejsDir(), ejsReportsDir(), ejsMirrorCoresDir(), ejsCompressionDir()].forEach(p => {
    if (!fs.existsSync(p)) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} }
  });
}

// v1.2.5: the official EmulatorJS data layout keeps its decompression workers
// under `compression/` (extract7z.js, extractzip.js, libunrar.js/.wasm) while
// our bundled runtime ships them flat next to emulator.min.js. EVERY EJS core
// download goes through those workers (cores on the CDN are 7z archives!), so
// if `compression/extract7z.js` 404s on the loopback mirror the core can never
// be decompressed — the real root cause of «بازی‌ها دیگر اجرا نمی‌شوند» when
// the launcher boots from the local mirror. These helpers map both layouts.
const EJS_COMPRESSION_FILES = ['extract7z.js', 'extractzip.js', 'libunrar.js', 'libunrar.wasm'];
function resolveEjsRuntimeFile(relPath) {
  // returns an absolute path for a pathtodata-relative runtime file, or null
  let rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('..')) return null;
  if (rel.startsWith('compression/')) {
    const base = path.basename(rel);
    const inSub = path.join(ejsCompressionDir(), base);
    if (fs.existsSync(inSub)) return inSub;      // official layout
    if (EJS_COMPRESSION_FILES.includes(base)) return path.join(ejsDir(), base); // flat fallback
    return null;
  }
  return path.join(ejsDir(), rel);
}

// --- bundled runtime seeding (called on every startup) ---------------------
function ensureBundledEjsAssets() {
  const bundled = path.join(__dirname, '..', 'ejs');
  if (!fs.existsSync(bundled)) return 0;
  ensureEjsDirs();
  let n = 0;
  const seedFile = (src, dst) => {
    try {
      const sst = fs.statSync(src);
      let need = true;
      try { need = fs.statSync(dst).size !== sst.size; } catch (e) {}
      if (need) {
        fs.copyFileSync(src, dst);
        // v1.1.1: preserve the source mtime so the deterministic buildStart
        // formula ('local-<size>-<mtime>') yields the SAME version stamp after
        // every reinstall — EmulatorJS's own IndexedDB core cache stays valid
        // and games boot instantly with zero re-downloads/re-decompressions.
        try { fs.utimesSync(dst, sst.atime, sst.mtime); } catch (e) {}
        n++;
      }
    } catch (e) {}
  };
  EJS_ASSET_FILES.forEach(f => {
    const s = path.join(bundled, f);
    if (fs.existsSync(s)) seedFile(s, path.join(ejsDir(), f));
  });
  const repDir = path.join(bundled, 'cores', 'reports');
  try {
    for (const f of fs.readdirSync(repDir)) {
      if (f.endsWith('.json')) seedFile(path.join(repDir, f), path.join(ejsReportsDir(), f));
    }
  } catch (e) {}
  // v1.1.0: FACTORY-BUNDLED CORES — the installer ships every console core
  // (<core>-legacy-wasm.data) under <app>/ejs/cores/. They are copied into the
  // user-facing <DataRoot>/Cores folder on every startup, so a fresh install
  // can boot games 100% offline with zero CDN downloads. The settings panel
  // still offers download / update / delete for each core.
  try {
    const bCores = path.join(bundled, 'cores');
    for (const f of fs.readdirSync(bCores)) {
      if (!f.endsWith('.data')) continue;
      try { if (fs.existsSync(factorySkipPath(coreBaseName(f)))) continue; } catch (e) {}
      seedFile(path.join(bCores, f), path.join(coresDir(), f));
    }
  } catch (e) {}
  // v1.2.5: seed the compression workers under the official relative path too
  // (<ejs>/compression/…) so EmulatorJS finds them from any data base.
  try {
    ensureEjsDirs();
    EJS_COMPRESSION_FILES.forEach(f => {
      const s = path.join(bundled, f);
      if (fs.existsSync(s)) seedFile(s, path.join(ejsCompressionDir(), f));
    });
  } catch (e) {}
  return n;
}

// --- core report generation (same deterministic formula as the pipeline) ---
function localBuildStart(filePath, core) {
  try {
    const st = fs.statSync(filePath);
    return { core, buildStart: 'local-' + st.size + '-' + Math.floor(st.mtimeMs / 1000), options: {} };
  } catch (e) { return null; }
}

function findCoreFile(name) {
  // name is <core>(-legacy)?-wasm.data — user folder wins, mirror folder is the fallback
  const a = path.join(coresDir(), name);
  if (fs.existsSync(a)) return a;
  const b = path.join(ejsMirrorCoresDir(), name);
  if (fs.existsSync(b)) return b;
  return null;
}

// --- loopback static server -------------------------------------------------
let coreServer = null;
let coreServerUrl = null;
const EJS_MIME = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8', '.png': 'image/png'
};

function serveFile(res, filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': EJS_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
    return true;
  } catch (e) { return false; }
}

function handleCoreServerRequest(req, res) {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    let p = decodeURIComponent(u.pathname);
    // v1.3.0: /bios/<name>.bin joins /ejs/ as a second served subtree (PSX
    // BIOS files for the PS1 core). Same traversal rules.
    if ((!p.startsWith('/ejs/') && !p.startsWith('/bios/')) || p.includes('..')) { res.writeHead(404); res.end(); return; }
    // v1.3.0 — PSX BIOS route: resolve /bios/<name>.bin from (1) the bios
    // folder of the extracted ePSXe package (Settings → PS1 package) or
    // (2) the copy bundled inside the installer (ejs/bios/*.bin — ships
    // scph1001 + scph7502). This is what makes the PS1 core boot with a
    // real BIOS out of the box, no user action needed.
    if (p.startsWith('/bios/')) {
      const base = path.basename(p);
      if (/^[\w.-]+\.bin$/i.test(base)) {
        const pkgBios = path.join(emuPkgDir('ps1'), 'bios', base);
        if (fs.existsSync(pkgBios)) { serveFile(res, pkgBios); return; }
        const bundledBios = path.join(__dirname, '..', 'ejs', 'bios', base);
        if (fs.existsSync(bundledBios)) { serveFile(res, bundledBios); return; }
      }
      res.writeHead(404); res.end(); return;
    }
    p = p.slice('/ejs/'.length);
    if (p === '' || p.endsWith('/')) p += 'index.html';
    // 1) core files: /ejs/cores/<name>.data → Cores/<name> then mirror cache
    if (p.startsWith('cores/')) {
      const base = path.basename(p);
      if (p.startsWith('cores/reports/')) {
        if (base.endsWith('.json')) {
          const rp = path.join(ejsReportsDir(), base);
          if (fs.existsSync(rp)) { serveFile(res, rp); return; }
          const core = base.replace(/\.json$/, '');
          const cf = findCoreFile(core + '-legacy-wasm.data') || findCoreFile(core + '-wasm.data');
          if (cf) {
            const rep = localBuildStart(cf, core);
            if (rep) {
              const body = JSON.stringify(rep);
              res.writeHead(200, { 'Content-Type': EJS_MIME['.json'], 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
              res.end(body);
              return;
            }
          }
        }
        res.writeHead(404); res.end(); return;
      }
      if (base.endsWith('.data')) {
        let cf = findCoreFile(base);
        // v1.2.5: identical-payload aliasing — mednafen_psx_hw-wasm.data and
        // its -legacy twin are byte-identical, so the installer ships ONE copy
        // (the -legacy name) and the sibling name resolves to it, either way.
        if (!cf) {
          const alt = base.includes('-legacy-wasm.data')
            ? base.replace('-legacy-wasm.data', '-wasm.data')
            : base.replace('-wasm.data', '-legacy-wasm.data');
          if (alt !== base) cf = findCoreFile(alt);
        }
        if (cf) { serveFile(res, cf); return; }
      }
      res.writeHead(404); res.end(); return;
    }
    // 2) runtime files (loader.js, emulator.min.js, compression libs, …)
    // v1.2.5: `compression/extract7z.js` & friends resolve through the layout
    // mapper (official compression/ subdir first, flat bundled fallback) —
    // without this the 7z/zip decompression workers 404 on the loopback and
    // NO downloaded core can ever be unpacked offline.
    const target = resolveEjsRuntimeFile(p);
    if (!target) { res.writeHead(404); res.end(); return; }
    if (!target.startsWith(ejsDir())) { res.writeHead(404); res.end(); return; }
    if (serveFile(res, target)) return;
    res.writeHead(404); res.end();
  } catch (e) {
    try { res.writeHead(500); res.end(); } catch (e2) {}
  }
}

function startCoreServerInternal() {
  if (coreServer && coreServerUrl) return { success: true, url: coreServerUrl };
  const http = require('http');
  ensureEjsDirs();
  return new Promise((resolve) => {
    try {
      const srv = http.createServer(handleCoreServerRequest);
      srv.on('error', () => resolve({ success: false, error: 'core-server-error' }));
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        coreServer = srv;
        coreServerUrl = 'http://127.0.0.1:' + port;
        resolve({ success: true, url: coreServerUrl });
      });
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

// --- https download with redirects (plain Node, no deps) --------------------
// v1.2.4: optional onProgress(received, total) — feeds the settings-page
// progress bars over the 'core-dl-progress' channel.
function httpsDownload(url, destPath, redirects, onProgress) {
  return new Promise((resolve, reject) => {
    const maxR = (redirects == null) ? 5 : redirects;
    try {
      const mod = url.startsWith('http://') ? require('http') : require('https');
      const req = mod.get(url, { headers: { 'User-Agent': 'GameRGBLauncher/1.1.1' }, timeout: 60000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (maxR <= 0) { reject(new Error('too-many-redirects')); return; }
          const next = new URL(res.headers.location, url).toString();
          httpsDownload(next, destPath, maxR - 1, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); return; }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        if (onProgress) { try { onProgress(0, total); } catch (e) {} }
        const out = fs.createWriteStream(destPath);
        res.on('data', (c) => { received += c.length; if (onProgress) { try { onProgress(received, total); } catch (e) {} } });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function httpsGetBuffer(url, redirects, onProgress) {
  return new Promise((resolve, reject) => {
    const maxR = (redirects == null) ? 5 : redirects;
    try {
      const mod = url.startsWith('http://') ? require('http') : require('https');
      const req = mod.get(url, { headers: { 'User-Agent': 'GameRGBLauncher/1.1.1' }, timeout: 90000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (maxR <= 0) { reject(new Error('too-many-redirects')); return; }
          httpsGetBuffer(new URL(res.headers.location, url).toString(), maxR - 1, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        const chunks = [];
        let size = 0;
        const totalB = parseInt(res.headers['content-length'] || '0', 10) || 0;
        if (onProgress) { try { onProgress(0, totalB); } catch (e) {} }
        res.on('data', c => {
          size += c.length;
          if (onProgress) { try { onProgress(size, totalB); } catch (e) {} }
          if (size > 900 * 1024 * 1024) { req.destroy(new Error('too-large')); } else chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', reject);
    } catch (e) { reject(e); }
  });
}

function loadJSZip() {
  try { return require(path.join(__dirname, 'vendor', 'jszip.min.js')); }
  catch (e) { try { return require('jszip'); } catch (e2) { return null; } }
}

// --- offline bundle (Iranian zip) import ------------------------------------
// v1.2.5 FIX: the Iranian bundle ships every core in EmulatorJS's native
// distribution format — a 7z archive (<core>-legacy-wasm.7z). EJS ALWAYS
// decompresses core archives in-browser (compression/extract7z worker), both
// for network downloads and for its own IndexedDB cache, so the launcher must
// simply store the raw archive bytes under the .data name the emulator asks
// for. Each 7z (or pre-extracted .data) entry is therefore written under BOTH
// filename variants — <core>-legacy-wasm.data and <core>-wasm.data — because
// WebGL2-capable devices request the plain name while older devices request
// the legacy one; the legacy build runs on every device. Previously only
// *.data matched, so the whole 10-core zip imported 0 files and every import
// ended with «وارد کردن بسته ناموفق بود» while no game could boot offline.
// v1.2.5b: parse the core id from `<core>(-legacy)?wasm.(data|7z)`. Two explicit
// branches instead of one greedy regex — `[-\w]+` would greedily swallow the
// `-legacy` marker and mis-name the WebGL2 variant (genesis_plus_gx-legacy-…).
function coreIdFromFileName(base) {
  const s = String(base || '');
  let m = /^([\w.+()]+)-legacy-wasm\.(data|7z)$/i.exec(s);
  if (m) return m[1];
  m = /^([\w.+()]+)-wasm\.(data|7z)$/i.exec(s);
  if (m) return m[1];
  return null;
}
function coreImportNames(base) {
  const id = coreIdFromFileName(base);
  return id ? [id + '-legacy-wasm.data', id + '-wasm.data'] : null;
}
async function importCoresZipFromBuffer(zipBuf) {
  const JSZip = loadJSZip();
  if (!JSZip) return { success: false, error: 'jszip-unavailable' };
  ensureEjsDirs();
  let zip;
  try { zip = await JSZip.loadAsync(zipBuf); }
  catch (e) { return { success: false, error: 'bad-zip: ' + e.message }; }
  let cores = 0, assets = 0, reports = 0;
  const entries = [];
  zip.forEach((relPath, entry) => { if (!entry.dir) entries.push({ relPath, entry }); });
  for (const { relPath, entry } of entries) {
    if (relPath.includes('__MACOSX')) continue;
    const base = path.basename(relPath);
    if (!base || base.startsWith('.')) continue;
    try {
      const coreId = coreIdFromFileName(base);
      if (coreId) {
        const buf = await entry.async('nodebuffer');
        for (const nm of coreImportNames(base)) { fs.writeFileSync(path.join(coresDir(), nm), buf); clearFactorySkipForFile(nm); }
        cores++;
      } else if (base.endsWith('.data')) {
        const buf = await entry.async('nodebuffer');
        fs.writeFileSync(path.join(coresDir(), base), buf);
        clearFactorySkipForFile(base);
        cores++;
      } else if (EJS_ASSET_FILES.includes(base)) {
        const buf = await entry.async('nodebuffer');
        fs.writeFileSync(path.join(ejsDir(), base), buf);
        // keep the official compression/ copy in sync when the zip ships one
        if (EJS_COMPRESSION_FILES.includes(base)) {
          try { fs.writeFileSync(path.join(ejsCompressionDir(), base), buf); } catch (e) {}
        }
        assets++;
      } else if (/^cores[\\/]reports[\\/][\w.-]+\.json$/i.test(relPath) && base.endsWith('.json')) {
        const buf = await entry.async('nodebuffer');
        fs.writeFileSync(path.join(ejsReportsDir(), base), buf);
        reports++;
      }
    } catch (e) { /* keep importing the rest */ }
  }
  return { success: (cores + assets) > 0, cores, assets, reports };
}

ipcMain.handle('core-server-start', async () => {
  return await startCoreServerInternal();
});

ipcMain.handle('local-file-read', async (event, kind, name) => {
  try {
    if (kind === 'asset') {
      if (!EJS_ASSET_FILES.includes(name)) return null;
      const p = path.join(ejsDir(), name);
      if (!fs.existsSync(p)) return null;
      const st = fs.statSync(p);
      const buf = fs.readFileSync(p);
      return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), size: st.size, mtime: st.mtimeMs / 1000 };
    }
    if (kind === 'core') {
      if (!/^[-\w.+()]+\.data$/.test(String(name || ''))) return null;
      const p = findCoreFile(name);
      if (!p) return null;
      const st = fs.statSync(p);
      const buf = fs.readFileSync(p);
      return { buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), size: st.size, mtime: st.mtimeMs / 1000 };
    }
    return null;
  } catch (e) { return null; }
});

ipcMain.handle('local-core-check', async (event, realCore) => {
  try {
    const core = String(realCore || '').replace(/[^؀-ۿ\w.-]/g, '');
    if (!core) return { legacy: false, plain: false };
    const legacyPath = path.join(coresDir(), core + '-legacy-wasm.data');
    const plainPath = path.join(coresDir(), core + '-wasm.data');
    return { legacy: fs.existsSync(legacyPath), plain: fs.existsSync(plainPath) };
  } catch (e) { return { legacy: false, plain: false }; }
});

// v1.2.3: delete the on-disk copy of an emulator core (Settings → cores →
// «پاک کردن»). Complements the IndexedDB-side deletion in the renderer.
ipcMain.handle('local-core-delete', async (event, realCore) => {
  try {
    const core = String(realCore || '').replace(/[^؀-ۿ\w.-]/g, '');
    if (!core) return { success: false, error: 'invalid core' };
    let removed = 0;
    for (const suffix of ['-legacy-wasm.data', '-wasm.data']) {
      const p = path.join(coresDir(), core + suffix);
      try {
        if (path.resolve(p).startsWith(path.resolve(getDataRoot())) && fs.existsSync(p)) {
          fs.unlinkSync(p);
          removed++;
        }
      } catch (e) {}
    }
    // v1.1.0: keep the factory seeder from restoring the deleted core
    if (removed > 0) markFactorySkipped(core);
    return { success: true, removed };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('ejs-assets-check', async () => {
  try {
    ensureEjsDirs();
    const files = {};
    let complete = true;
    for (const f of EJS_ASSET_FILES) {
      const p = path.join(ejsDir(), f);
      try {
        const st = fs.statSync(p);
        files[f] = { size: st.size, mtime: st.mtimeMs / 1000 };
        if (st.size <= 0) complete = false;
      } catch (e) { files[f] = { size: 0, mtime: 0 }; complete = false; }
    }
    return { success: true, complete, files };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('ejs-assets-download', async (event) => {
  ensureEjsDirs();
  const errors = [];
  const send = (payload) => { try { event.sender.send('core-dl-progress', payload); } catch (e) {} };
  for (let fi = 0; fi < EJS_ASSET_FILES.length; fi++) {
    const f = EJS_ASSET_FILES[fi];
    const tmp = path.join(ejsDir(), f + '.part');
    let ok = false, lastErr = null;
    for (const mirror of EJS_CDN_MIRRORS) {
      try {
        if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (e) {} }
        // v1.2.4: per-file + in-file progress (id: assets)
        await httpsDownload(mirror + f, tmp, undefined, (received, total) => {
          send({ id: 'assets', received: received || 0, total: total || 0, file: f, idx: fi, count: EJS_ASSET_FILES.length });
        });
        if (fs.statSync(tmp).size > 0) { ok = true; break; }
      } catch (e) { lastErr = e; }
    }
    if (ok) {
      fs.renameSync(tmp, path.join(ejsDir(), f));
    } else {
      try { fs.unlinkSync(tmp); } catch (e) {}
      errors.push(f + (lastErr ? ': ' + lastErr.message : ''));
    }
  }
  send({ id: 'assets', phase: 'done', total: 1 });
  if (errors.length) return { success: false, error: errors.join('; ') };
  return { success: true };
});

// v1.2.4: single-core download with live progress events — the renderer
// stores the returned buffer into the EmulatorJS IndexedDB cache itself.
ipcMain.handle('core-download', async (event, { url, progressId }) => {
  try {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) return { success: false, error: 'bad-url' };
    const id = String(progressId || 'core');
    const send = (payload) => { try { payload.id = id; event.sender.send('core-dl-progress', payload); } catch (e) {} };
    const buf = await httpsGetBuffer(u, undefined, (received, total) => send({ received: received || 0, total: total || 0 }));
    if (!buf || !buf.length) return { success: false, error: 'empty' };
    send({ phase: 'done', total: buf.length });
    return { success: true, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), size: buf.length };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('core-file-save', async (event, name, data) => {
  try {
    const base = path.basename(String(name || ''));
    // v1.2.5: accept EmulatorJS's native 7z core archives too (manual import
    // of a single core) — stored as raw .data, decompressed by EJS in-browser.
    const coreId = coreIdFromFileName(base);
    if (!coreId) return { success: false, error: 'bad-name' };
    ensureEjsDirs();
    const buf = Buffer.from(data || []);
    if (!buf.length) return { success: false, error: 'empty' };
    // both WebGL2 filename variants so the core boots on every device
    for (const nm of [coreId + '-legacy-wasm.data', coreId + '-wasm.data']) {
      fs.writeFileSync(path.join(coresDir(), nm), buf);
      clearFactorySkipForFile(nm);
    }
    return { success: true, path: path.join(coresDir(), coreId + '-wasm.data') };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('ejs-zip-url-import', async (event, url) => {
  const target = (url && /^https?:\/\//i.test(url)) ? url : EJS_CORES_ZIP_URL_DEFAULT;
  const tmp = path.join(app.getPath('temp'), 'grgb-cores-' + Date.now() + '.zip');
  const send = (payload) => { try { payload.id = 'zip'; event.sender.send('core-dl-progress', payload); } catch (e) {} };
  try {
    // v1.2.4: live download progress (MB + %) for the internal-server bundle
    await httpsDownload(target, tmp, undefined, (received, total) => send({ received: received || 0, total: total || 0 }));
    if (fs.statSync(tmp).size < 1024) throw new Error('downloaded file is too small');
    send({ phase: 'extract' });
    const buf = fs.readFileSync(tmp);
    const r = await importCoresZipFromBuffer(buf);
    send({ phase: 'done', total: 1 });
    return r;
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
});

ipcMain.handle('ejs-zip-file-import', async () => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'انتخاب زیپ هسته‌های شبیه‌ساز',
    filters: [{ name: 'Cores zip', extensions: ['zip'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  try {
    const buf = fs.readFileSync(result.filePaths[0]);
    return await importCoresZipFromBuffer(buf);
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('clip-copy', async (event, text) => {
  try {
    const { clipboard } = require('electron');
    clipboard.writeText(String(text == null ? '' : text));
    return { success: true };
  } catch (e) { return { success: false, error: e.message };
  }
});

// ===== v1.2.5: STREAMING DOWNLOAD WITH PROGRESS (cores + bundle) ============
// ============================================================================
// The old core download buffered the whole file through http-request with no
// progress feedback. This handler streams the response and emits periodic
// «dl-progress» events ({ id, received, total, percent, done }) so the
// renderer can draw a real progress bar with MB + % for every core download
// (both the official CDNs and the Iranian mirror bundle).
const _dlAbort = new Set();

function streamDownloadWithProgress(event, id, url, timeoutMs) {
  return new Promise((resolve) => {
    const send = (payload) => { try { event.sender.send('dl-progress', { id, ...payload }); } catch (e) {} };
    try {
      const https = require('https');
      const http = require('http');
      const { URL } = require('url');
      const chunks = [];
      let received = 0;
      let total = 0;
      let lastEmit = 0;
      const grab = (currentUrl, redirectsLeft) => {
        let parsed;
        try { parsed = new URL(currentUrl); } catch (e) { resolve({ ok: false, error: 'invalid URL' }); return; }
        const lib = parsed.protocol === 'http:' ? http : https;
        const req = lib.request({
          method: 'GET',
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
          path: parsed.pathname + parsed.search,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity'
          }
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            grab(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            resolve({ ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode });
            return;
          }
          const cl = parseInt(res.headers['content-length'] || '0', 10);
          total = (cl > 0) ? cl : 0;
          res.on('data', (c) => {
            received += c.length;
            chunks.push(c);
            const now = Date.now();
            if (now - lastEmit > 120) { // throttle UI events to ~8/s
              lastEmit = now;
              send({ received, total, percent: total ? Math.min(99, Math.round(received / total * 100)) : 0 });
            }
          });
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            send({ received: buf.length, total: buf.length, percent: 100, done: true });
            resolve({ ok: true, buffer: buf, size: buf.length });
          });
          res.on('error', (err) => resolve({ ok: false, error: err.message }));
        });
        req.on('error', (err) => resolve({ ok: false, error: err.message }));
        req.setTimeout(timeoutMs || 300000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        _dlAbort.add(req);
        req.end();
      };
      grab(url, 5);
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

ipcMain.handle('download-with-progress', async (event, data) => {
  const { id, url, timeoutMs } = data || {};
  if (!id || !url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: 'bad request' };
  return streamDownloadWithProgress(event, String(id), String(url), timeoutMs);
});

// Import a bundle zip that the RENDERER already downloaded (e.g. via
// download-with-progress so the user sees a progress bar) — same importer as
// ejs-zip-file-import / ejs-zip-url-import.
ipcMain.handle('import-zip-buffer', async (event, data) => {
  try {
    const buf = data && data.buffer;
    if (!buf || !buf.byteLength) return { success: false, error: 'empty zip' };
    const counts = await importCoresZipFromBuffer(Buffer.from(buf));
    return { success: true, ...counts, zipSize: buf.byteLength };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// Import a core file picked in the renderer (settings → «وارد کردن فایل هسته»)
ipcMain.handle('save-core-file', async (event, data) => {
  try {
    const { name, buffer } = data || {};
    const safe = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!safe || !safe.endsWith('.data')) return { success: false, error: 'invalid name' };
    if (!buffer || !buffer.byteLength) return { success: false, error: 'empty file' };
    const dir = coresDir();
    const p = path.join(dir, safe);
    fs.writeFileSync(p, Buffer.from(buffer));
    clearFactorySkipForFile(safe);
    return { success: true, path: p, size: buffer.byteLength };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================================
// v1.3.0 — EXTERNAL EMULATOR PACKAGES (ePSXe PS1 / PCSX2 PS2) + INVENTORY
// ============================================================================
// One-click install flow for the project owner's distribution packages:
//   download (streamed, live progress) → JSZip extract into
//   <DataRoot>/Emulators/<PS1|PS2>/ (common root folder stripped) → open the
//   folder in Explorer → detect the main exe so the renderer can auto-wire
//   the existing launch-external path. If the payload is not a zip (e.g. a
//   RAR renamed .zip) the raw file is saved into the folder instead and the
//   on-screen tutorial takes over (manual extraction).
// The URLs are hardcoded HERE (never renderer-supplied) — no injection face.
const EMU_PACKAGES = {
  ps1: {
    id: 'ps1', label: 'ePSXe 2.0.18 (PlayStation 1)', dir: 'PS1',
    url: 'https://cdn.imgurl.ir/uploads/b726975_ps1_Game_RGB_Launcher.zip',
    exeHint: /ePSXe\.exe$/i
  },
  ps2: {
    id: 'ps2', label: 'PCSX2 (PlayStation 2)', dir: 'PS2',
    url: 'https://cdn.imgurl.ir/uploads/l59034_ps2_Game_RGB_Launcher.zip',
    exeHint: /pcsx2[\w.-]*\.exe$/i
  }
};
const EMU_PKG_EXE_FALLBACK = /\.(exe|bat)$/i;

function emuPkgDir(id) {
  const def = EMU_PACKAGES[String(id || '')];
  return path.join(getDataRoot(), 'Emulators', def ? def.dir : String(id || ''));
}

function walkDirSize(startDir, maxDepth) {
  let size = 0, files = 0;
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (depth > 0) walk(p, depth - 1);
      } else { size += st.size; files++; }
    }
  };
  walk(startDir, maxDepth == null ? 4 : maxDepth);
  return { size, files };
}

function findEmuExe(pkgId, startDir) {
  const def = EMU_PACKAGES[pkgId] || {};
  const hint = def.exeHint || EMU_PKG_EXE_FALLBACK;
  let fallback = null;
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return null; }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = path.join(dir, name);
      let st = null;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (depth > 0) { const r = walk(p, depth - 1); if (r) return r; }
      } else if (/\.exe$/i.test(name)) {
        if (hint.test(name)) return p;
        if (!fallback) fallback = p;
      }
    }
    return null;
  };
  return walk(startDir, 3) || fallback;
}

function emuPkgStatusItem(pkgId) {
  const dir = emuPkgDir(pkgId);
  const st = walkDirSize(dir, 4);
  const exe = st.files ? findEmuExe(pkgId, dir) : null;
  let biosDir = null, biosFiles = [];
  if (pkgId === 'ps1') {
    biosDir = path.join(dir, 'bios');
    try {
      for (const n of fs.readdirSync(biosDir)) {
        if (/\.bin$/i.test(n)) {
          try { biosFiles.push({ name: n, size: fs.statSync(path.join(biosDir, n)).size }); } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return {
    id: pkgId,
    label: (EMU_PACKAGES[pkgId] || {}).label || pkgId,
    dir, installed: st.files > 0,
    size: st.size, files: st.files,
    exe: exe || null,
    biosDir: biosDir && fs.existsSync(biosDir) ? biosDir : null,
    biosFiles
  };
}

ipcMain.handle('emu-pkg-status', async () => {
  try {
    return { success: true, packages: { ps1: emuPkgStatusItem('ps1'), ps2: emuPkgStatusItem('ps2') } };
  } catch (e) { return { success: false, error: e.message }; }
});

function safeZipEntryName(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/i.test(s) || s.includes('..') || s.includes('\0')) return null;
  return s;
}

ipcMain.handle('emu-pkg-download', async (event, pkgId) => {
  const send = (payload) => { try { event.sender.send('dl-progress', payload); } catch (e) {} };
  try {
    const def = EMU_PACKAGES[String(pkgId || '')];
    if (!def) return { success: false, error: 'unknown-package' };
    const id = def.id;
    const dir = emuPkgDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const progId = 'emupkg:' + id;
    // 1) streamed download with live progress (dl-progress events)
    const dl = await streamDownloadWithProgress(event, progId, def.url, 900000);
    if (!dl || !dl.ok || !dl.buffer || !dl.buffer.length) {
      return { success: false, error: (dl && dl.error) || 'empty download' };
    }
    const buf = Buffer.from(dl.buffer);
    // 2) extract as a zip; if the payload is not zip-structured (e.g. RAR),
    //    save the raw file into the folder and let the tutorial handle it.
    const JSZip = loadJSZip();
    let zip = null;
    if (JSZip) { try { zip = await JSZip.loadAsync(buf); } catch (e) { zip = null; } }
    if (!zip) {
      const rawName = (path.basename(new URL(def.url).pathname) || (id + '-package.zip'));
      const rawPath = path.join(dir, rawName);
      fs.writeFileSync(rawPath, buf);
      try { shell.openPath(dir); } catch (e) {}
      return { success: true, extracted: false, id, dir, savedFile: rawPath, size: buf.length };
    }
    // 3) normal zip path — strip a single shared top-level folder, then extract
    const entries = [];
    zip.forEach((relPath, entry) => { if (!entry.dir) entries.push({ relPath, entry }); });
    if (!entries.length) return { success: false, error: 'zip has no files' };
    const firstSeg = (s) => s.split('/')[0];
    const tops = new Set(entries.map(e => firstSeg(e.relPath)));
    const strip = (tops.size === 1 && entries.some(e => e.relPath.includes('/'))) ? [...tops][0] + '/' : '';
    let files = 0, bytes = 0;
    for (const { relPath, entry } of entries) {
      if (relPath.includes('__MACOSX')) continue;
      let rel = strip && relPath.startsWith(strip) ? relPath.slice(strip.length) : relPath;
      rel = safeZipEntryName(rel);
      if (!rel) continue;
      const base = path.basename(rel);
      if (!base || base.startsWith('.')) continue;
      try {
        const data = await entry.async('nodebuffer');
        const dst = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, data);
        files++; bytes += data.length;
      } catch (e) { /* keep extracting the rest */ }
    }
    if (!files) return { success: false, error: 'nothing extracted' };
    // 4) detect the main executable + open the folder (user asked for this)
    const exe = findEmuExe(id, dir);
    try { shell.openPath(dir); } catch (e) {}
    return { success: true, extracted: true, id, dir, files, size: bytes, exe: exe || null };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// v1.3.0 — full cores/emulators inventory for the management panel:
// every console core (both filename variants, sizes, locations), the EJS
// runtime files, bundled/package PSX BIOS, the PS1/PS2 packages and all data
// folders — everything the «پنل مدیریت هسته‌ها و شبیه‌سازها» renders.
ipcMain.handle('emu-inventory', async () => {
  try {
    ensureEjsDirs();
    const root = getDataRoot();
    // — console cores —
    const known = new Set();
    const bundledCoresDir = path.join(__dirname, '..', 'ejs', 'cores');
    try { for (const f of fs.readdirSync(bundledCoresDir)) { if (f.endsWith('.data')) known.add(coreBaseName(f)); } } catch (e) {}
    try { for (const f of fs.readdirSync(coresDir())) { if (f.endsWith('.data')) known.add(coreBaseName(f)); } } catch (e) {}
    const cores = [...known].sort().map(core => {
      const variants = {};
      for (const suffix of ['legacy-wasm.data', 'wasm.data']) {
        const nm = core + '-' + suffix;
        const p = path.join(coresDir(), nm);
        let exists = false, size = 0;
        try { const st = fs.statSync(p); exists = true; size = st.size; } catch (e) {}
        variants[suffix === 'legacy-wasm.data' ? 'legacy' : 'plain'] = { file: nm, exists, size, path: p };
      }
      return { core, variants };
    });
    // — EJS runtime —
    const runtime = { dir: ejsDir(), files: [], total: 0 };
    for (const f of EJS_ASSET_FILES) {
      const p = path.join(ejsDir(), f);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (e) {}
      runtime.files.push({ name: f, size, path: p });
      runtime.total += size;
    }
    // — PSX BIOS (bundled + extracted package) —
    const bios = { bundled: [], dir: null, package: [] };
    const bundledBiosDir = path.join(__dirname, '..', 'ejs', 'bios');
    try {
      for (const n of fs.readdirSync(bundledBiosDir)) {
        if (/\.bin$/i.test(n)) {
          try { bios.bundled.push({ name: n, size: fs.statSync(path.join(bundledBiosDir, n)).size, path: path.join(bundledBiosDir, n) }); } catch (e) {}
        }
      }
    } catch (e) {}
    bios.dir = bundledBiosDir;
    const ps1 = emuPkgStatusItem('ps1');
    bios.package = ps1.biosFiles.map(b => ({ name: b.name, size: b.size, path: path.join(ps1.dir, 'bios', b.name) }));
    // — data folders (incl. emulators + cores) —
    const folders = {};
    {
      const made = ensureDataFolders(root);
      for (const f of DATA_FOLDERS) {
        const st = walkDirSize(made[f.id], 3);
        folders[f.id] = { path: made[f.id], size: st.size, files: st.files };
      }
    }
    return { success: true, dataRoot: root, cores, runtime, bios, packages: { ps1, ps2: emuPkgStatusItem('ps2') }, folders };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ===================== v1.2.4: DNS (ping / apply / reset) =====================
// Ping: real ICMP via the OS ping binary (no admin needed, works in Iran).
ipcMain.handle('dns-ping', async (event, host, count) => {
  return new Promise((resolve) => {
    try {
      const h = String(host || '').trim();
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(h) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)) {
        return resolve({ success: false, error: 'invalid-host' });
      }
      const n = Math.min(4, Math.max(1, parseInt(count, 10) || 3));
      const { execFile } = require('child_process');
      const args = process.platform === 'win32' ? ['-n', String(n), '-w', '2000', h] : ['-c', String(n), '-W', '2', h];
      execFile('ping', args, { timeout: 14000, windowsHide: true }, (err, stdout) => {
        const out = String(stdout || '');
        let avg = null, loss = 0;
        const winAvg = /Average\s*=\s*(\d+)\s*ms/i.exec(out);
        const linAvg = /= [\d.]+\/([\d.]+)\//.exec(out);
        const lossM = /(\d{1,3})%\s*(?:packet\s*)?loss/i.exec(out);
        if (winAvg) avg = parseInt(winAvg[1], 10);
        else if (linAvg) avg = Math.round(parseFloat(linAvg[1]));
        if (lossM) loss = parseInt(lossM[1], 10);
        if (avg == null) return resolve({ success: false, error: err ? 'unreachable' : 'no-avg', loss });
        resolve({ success: true, avg, loss });
      });
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
});

// Apply/Reset: write a tiny PowerShell script and launch it elevated
// (Start-Process -Verb RunAs → UAC prompt). Sets/removes DNS on every
// ACTIVE network adapter. Canceling the UAC prompt → { canceled: true }.
function runElevatedPs(psBody) {
  return new Promise((resolve) => {
    try {
      if (process.platform !== 'win32') return resolve({ success: false, error: 'windows-only' });
      const ps1 = path.join(app.getPath('temp'), 'grgb-dns-' + Date.now() + '.ps1');
      fs.writeFileSync(ps1, psBody, 'utf8');
      const { spawn } = require('child_process');
      const inner = '-NoProfile -ExecutionPolicy Bypass -File "' + ps1 + '"';
      const child = spawn('powershell.exe', ['-NoProfile', '-Command',
        'Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList \'' + inner.replace(/'/g, "''") + '\''],
        { windowsHide: true });
      let out = '', errOut = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { errOut += d; });
      child.on('close', (code) => {
        try { fs.unlinkSync(ps1); } catch (e) {}
        const all = (out + ' ' + errOut).toLowerCase();
        if (all.includes('canceled by the user') || all.includes('operation was canceled')) return resolve({ canceled: true });
        if (code === 0) return resolve({ success: true });
        resolve({ success: false, error: 'exit-' + code });
      });
      child.on('error', (e) => resolve({ success: false, error: e.message }));
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}
ipcMain.handle('dns-apply', async (event, dns1, dns2) => {
  const ips = [String(dns1 || '').trim(), String(dns2 || '').trim()].filter(Boolean);
  if (!ips.length || !ips.every(ip => /^(\d{1,3}\.){3}\d{1,3}$/.test(ip))) return { success: false, error: 'invalid-ip' };
  const list = '@(\'' + ips.join('\',\'') + '\')';
  const body = '$ErrorActionPreference="Stop"\n' +
    '$ips = ' + list + '\n' +
    'try {\n' +
    '  Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {\n' +
    '    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses $ips\n' +
    '  }\n' +
    '  exit 0\n' +
    '} catch { exit 1 }\n';
  return runElevatedPs(body);
});
ipcMain.handle('dns-reset', async () => {
  const body = '$ErrorActionPreference="Stop"\n' +
    'try {\n' +
    '  Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object {\n' +
    '    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses\n' +
    '  }\n' +
    '  exit 0\n' +
    '} catch { exit 1 }\n';
  return runElevatedPs(body);
});

// eager loopback server + runtime seeding at boot (before any game launch)
app.whenReady().then(() => {
  try { ensureBundledEjsAssets(); } catch (e) {}
  try { startCoreServerInternal(); } catch (e) {}
});

// ============================================================================
// v1.1.2 — WALLPAPER GALLERY BACKEND (SteamGridDB + Wallhaven)
// All network fetches and downloads happen HERE in the main process; the
// renderer only talks through IPC (no direct external API calls, no CORS).
// Security model:
//   * gallery-fetch      — GET, JSON/text only, restricted to the allowlisted
//                          wallpaper API hosts (wallhaven.cc + steamgriddb.com)
//   * wallpaper-download — image files only, allowlisted download hosts
//                          (w.wallhaven.cc, th.wallhaven.cc, *.steamgriddb.com
//                          + its known CDN), 40 MB cap, public-IP-only (SSRF
//                          wall), content sniffing, .part + atomic rename
//   * wpimg:// protocol  — serves userData/wallpapers to the renderer without
//                          granting file:// access
// ============================================================================
const { protocol } = require('electron');
const WP_MAX_BYTES = 40 * 1024 * 1024;      // hard cap per wallpaper
const WP_IMG_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// API hosts the gallery may query (search endpoints)
const WP_API_HOSTS = new Set([
  'wallhaven.cc',
  'www.steamgriddb.com'
]);
// Hosts wallpapers may be downloaded from
function isWpDownloadHost(h) {
  h = String(h || '').toLowerCase();
  if (h === 'wallhaven.cc') return true;
  if (h === 'w.wallhaven.cc' || h === 'th.wallhaven.cc') return true;
  if (h === 'steamgriddb.com' || h === 'www.steamgriddb.com') return true;
  if (h.endsWith('.steamgriddb.com')) return true;   // CDN: cdn2.steamgriddb.com …
  return false;
}

function wallpapersDir() {
  const dir = path.join(app.getPath('userData'), 'wallpapers');
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

// wpimg://<filename> → userData/wallpapers/<filename>  (strictly one segment,
// resolved and containment-checked — no traversal, no subfolders)
protocol.registerSchemesAsPrivileged([{ scheme: 'wpimg', privileges: { standard: false, stream: true } }]);
app.whenReady().then(() => {
  try {
    protocol.handle('wpimg', (request) => {
      try {
        const raw = decodeURIComponent(String(request.url).replace(/^wpimg:\/\//i, '').split(/[?#]/)[0]);
        const name = path.basename(raw);
        if (!name || name !== raw || name.startsWith('.')) return new Response('bad request', { status: 400 });
        const full = path.join(wallpapersDir(), name);
        if (!isPathInside(wallpapersDir(), full)) return new Response('forbidden', { status: 403 });
        const buf = fs.readFileSync(full);
        const ext = path.extname(name).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        return new Response(buf, { headers: { 'Content-Type': mime, 'Cache-Control': 'max-age=3600' } });
      } catch (e) {
        return new Response('not found', { status: 404 });
      }
    });
  } catch (e) { /* protocol already registered (dev reload) */ }
});

// gallery fetch: GET JSON/text from the allowlisted API hosts (with optional
// X-API-Key for wallhaven, Bearer for SGDB) — SSRF wall applies to the target.
// v1.1.3: uses Electron's net module instead of runProxiedRequest (raw Node
// https) — net honors the OS proxy/VPN, so wallhaven works while a VPN is
// connected (raw https bypassed the tunnel and died with "network error").
function wpNetRequest(urlStr, headers) {
  return new Promise((resolve) => {
    try {
      const request = net.request({ url: String(urlStr), redirect: 'follow' });
      for (const [k, v] of Object.entries(headers || {})) {
        try { request.setHeader(k, v); } catch (e) {}
      }
      const chunks = [];
      let settled = false;
      const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
      const t = setTimeout(() => { try { request.abort(); } catch (e) {} finish({ ok: false, status: 0, error: 'timeout' }); }, 30000);
      request.on('response', (res) => {
        const status = res.statusCode || 0;
        res.on('data', (c) => { if (chunks.length < 400) chunks.push(c); });
        res.on('end', () => {
          clearTimeout(t);
          if (status < 200 || status >= 300) { finish({ ok: false, status, error: 'HTTP ' + status }); return; }
          finish({ ok: true, status, buffer: Buffer.concat(chunks) });
        });
        res.on('error', (err) => { clearTimeout(t); finish({ ok: false, status: 0, error: err.message }); });
      });
      request.on('error', (err) => { clearTimeout(t); finish({ ok: false, status: 0, error: err.message }); });
      request.end();
    } catch (err) {
      resolve({ ok: false, status: 0, error: err.message });
    }
  });
}

ipcMain.handle('gallery-fetch', async (event, opts) => {
  try {
    const o = opts || {};
    let u;
    try { u = new URL(String(o.url || '')); } catch (e) { return { ok: false, error: 'invalid-url' }; }
    if (u.protocol !== 'https:' || !WP_API_HOSTS.has(u.hostname.toLowerCase())) {
      return { ok: false, error: 'host-not-allowed' };
    }
    const headers = { 'User-Agent': 'GameRGBLauncher/1.1.2' };
    if (u.hostname.toLowerCase() === 'wallhaven.cc' && o.apiKey) headers['X-API-Key'] = String(o.apiKey);
    if (u.hostname.toLowerCase() === 'www.steamgriddb.com' && o.sgdbKey) headers['Authorization'] = 'Bearer ' + String(o.sgdbKey);
    try { await assertPublicHttpUrl(u.toString()); } catch (e) { return { ok: false, error: 'blocked: ' + e.message }; }
    const r = await wpNetRequest(u.toString(), headers);
    if (!r.ok) return { ok: false, status: r.status || 0, error: r.error || ('HTTP ' + (r.status || 0)) };
    let text = '';
    try { text = r.buffer.toString('utf8'); } catch (e) {}
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { ok: true, status: r.status, json, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// wallpaper download: streamed to .part with live progress + cancel, content
// sniffing, size cap, then atomic rename into userData/wallpapers.
// If the same source id is already on disk → {ok, already:true} (no re-download).
const _wpDl = new Map(); // id → { abort }
ipcMain.handle('wallpaper-download', async (event, opts) => {
  const o = opts || {};
  const id = String(o.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  const send = (payload) => { try { event.sender.send('wp-dl-progress', { id, ...payload }); } catch (e) {} };
  if (!id) return { ok: false, error: 'bad-id' };
  try {
    let u;
    try { u = new URL(String(o.url || '')); } catch (e) { return { ok: false, error: 'invalid-url' }; }
    if (u.protocol !== 'https:' || !isWpDownloadHost(u.hostname.toLowerCase())) {
      return { ok: false, error: 'host-not-allowed' };
    }
    const dir = wallpapersDir();
    const metaPath = path.join(dir, id + '.json');
    // already downloaded? → just re-apply
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta && meta.file && fs.existsSync(path.join(dir, meta.file))) {
          return { ok: true, already: true, file: meta.file, url: 'wpimg://' + meta.file };
        }
      }
    } catch (e) {}
    // SSRF wall on the target BEFORE any byte moves
    try { await assertPublicHttpUrl(u.toString()); } catch (e) { return { ok: false, error: 'blocked: ' + e.message }; }

    const https = require('https');
    const partPath = path.join(dir, id + '.part');
    const fd = fs.openSync(partPath, 'w');
    const ctrl = { abort: false };
    _wpDl.set(id, ctrl);
    const cleanup = () => { _wpDl.delete(id); try { fs.closeSync(fd); } catch (e) {} try { fs.unlinkSync(partPath); } catch (e) {} };
    const result = await new Promise((resolve) => {
      const grab = (currentUrl, redirectsLeft) => {
        let parsed;
        try { parsed = new URL(currentUrl); } catch (e) { cleanup(); return resolve({ ok: false, error: 'invalid-url' }); }
        if (parsed.protocol !== 'https:' || !isWpDownloadHost(parsed.hostname.toLowerCase())) { cleanup(); return resolve({ ok: false, error: 'redirect-host-not-allowed' }); }
        const req = https.request({
          method: 'GET', hostname: parsed.hostname, port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121 Safari/537.36', 'Accept': 'image/*', 'Accept-Encoding': 'identity' }
        }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
            res.resume();
            return grab(new URL(res.headers.location, currentUrl).toString(), redirectsLeft - 1);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); cleanup(); return resolve({ ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode }); }
          const ctype = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (!WP_IMG_TYPES[ctype]) { res.resume(); cleanup(); return resolve({ ok: false, error: 'not-an-image' }); }
          const cl = parseInt(res.headers['content-length'] || '0', 10);
          if (cl > WP_MAX_BYTES) { res.resume(); cleanup(); return resolve({ ok: false, error: 'too-large' }); }
          let received = 0, lastEmit = 0, first = true;
          res.on('data', (c) => {
            if (ctrl.abort) { req.destroy(); cleanup(); return resolve({ ok: false, error: 'canceled' }); }
            received += c.length;
            if (received > WP_MAX_BYTES) { req.destroy(); cleanup(); return resolve({ ok: false, error: 'too-large' }); }
            if (first) { // sniff magic bytes
              first = false;
              const b = c;
              const isJpg = b[0] === 0xFF && b[1] === 0xD8;
              const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
              const isWebp = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45;
              if (!isJpg && !isPng && !isWebp) { req.destroy(); cleanup(); return resolve({ ok: false, error: 'corrupt-image' }); }
            }
            try { fs.writeSync(fd, c); } catch (e) { req.destroy(); cleanup(); return resolve({ ok: false, error: 'disk-write' }); }
            const now = Date.now();
            if (now - lastEmit > 150) { lastEmit = now; send({ received, total: cl, percent: cl ? Math.min(99, Math.round(received / cl * 100)) : 0 }); }
          });
          res.on('end', () => {
            try { fs.closeSync(fd); } catch (e) {}
            _wpDl.delete(id);
            resolve({ ok: true, bytes: received, ext: WP_IMG_TYPES[ctype], finalUrl: currentUrl });
          });
          res.on('error', (err) => { cleanup(); resolve({ ok: false, error: err.message }); });
        });
        req.on('error', (err) => { cleanup(); resolve({ ok: false, error: err.message }); });
        req.setTimeout(60000, () => { req.destroy(); cleanup(); resolve({ ok: false, error: 'timeout' }); });
        req.end();
      };
      grab(u.toString(), 5);
    });
    if (!result.ok) return result;

    // optional 1080p downscale for performance mode (nativeImage — no new deps)
    let fileName = id + result.ext;
    try {
      if (o.downscale) {
        const { nativeImage } = require('electron');
        const img = nativeImage.createFromPath(partPath);
        if (!img.isEmpty()) {
          const sz = img.getSize();
          if (sz.width > 1920 || sz.height > 1080) {
            const scale = Math.min(1920 / sz.width, 1080 / sz.height);
            const resized = img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale) });
            const out = (result.ext === '.jpg') ? resized.toJPEG(87) : resized.toPNG();
            fs.writeFileSync(partPath + '.resized', out);
            fileName = id + (result.ext === '.jpg' ? '.jpg' : '.png');
            fs.unlinkSync(partPath);
            fs.renameSync(partPath + '.resized', path.join(dir, id + '.part'));
          }
        }
      }
    } catch (e) { /* downscale is best-effort — keep the original */ }

    // atomic finalize: .part → final name + sidecar metadata
    const finalPath = path.join(dir, fileName);
    try { fs.renameSync(path.join(dir, id + '.part'), finalPath); }
    catch (e) {
      // rename across the same dir should be atomic; if it failed the .part
      // may be locked — fall back to copy+delete
      try { fs.copyFileSync(path.join(dir, id + '.part'), finalPath); fs.unlinkSync(path.join(dir, id + '.part')); }
      catch (e2) { return { ok: false, error: 'finalize-failed' }; }
    }
    try {
      fs.writeFileSync(metaPath, JSON.stringify({
        id, file: fileName, bytes: result.bytes, source: o.source || null,
        sourceId: o.sourceId || null, credit: o.credit || null, creditUrl: o.creditUrl || null,
        downloadedAt: Date.now()
      }));
    } catch (e) {}
    send({ received: result.bytes, total: result.bytes, percent: 100, done: true });
    return { ok: true, file: fileName, url: 'wpimg://' + fileName, bytes: result.bytes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('wallpaper-cancel', (event, id) => {
  const ctrl = _wpDl.get(String(id || ''));
  if (ctrl) ctrl.abort = true;
  return { ok: true };
});

// list downloaded wallpapers (with byte sizes + metadata)
ipcMain.handle('wallpaper-list', async () => {
  try {
    const dir = wallpapersDir();
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.part') || name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const id = name.replace(/\.(jpg|png|webp)$/i, '');
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch (e) {}
      out.push({
        file: name, id, size: st.size, url: 'wpimg://' + name,
        credit: meta.credit || null, creditUrl: meta.creditUrl || null,
        source: meta.source || null, sourceId: meta.sourceId || null, downloadedAt: meta.downloadedAt || null
      });
    }
    out.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
    return { ok: true, items: out, totalBytes: out.reduce((s, x) => s + x.size, 0) };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('wallpaper-delete', async (event, file) => {
  try {
    const name = path.basename(String(file || ''));
    const dir = wallpapersDir();
    const full = path.join(dir, name);
    if (!isPathInside(dir, full)) return { ok: false, error: 'forbidden' };
    fs.unlinkSync(full);
    try { fs.unlinkSync(path.join(dir, name.replace(/\.(jpg|png|webp)$/i, '') + '.json')); } catch (e) {}
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// cache cleanup: evict oldest downloads until under the byte cap.
// never deletes `protectFile` (the currently-applied wallpaper).
ipcMain.handle('wallpaper-cleanup', async (event, opts) => {
  try {
    const capBytes = Math.max(50 * 1024 * 1024, parseInt(opts && opts.capBytes, 10) || 500 * 1024 * 1024);
    const protect = path.basename(String((opts && opts.protectFile) || ''));
    const dir = wallpapersDir();
    const items = [];
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.part') || name.endsWith('.json')) continue;
      const full = path.join(dir, name);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isFile()) items.push({ name, size: st.size, mtime: st.mtimeMs });
    }
    let total = items.reduce((s, x) => s + x.size, 0);
    let removed = 0;
    if (total <= capBytes) return { ok: true, removed, total };
    items.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const it of items) {
      if (total <= capBytes) break;
      if (it.name === protect) continue;
      try {
        fs.unlinkSync(path.join(dir, it.name));
        try { fs.unlinkSync(path.join(dir, it.name.replace(/\.(jpg|png|webp)$/i, '') + '.json')); } catch (e) {}
        total -= it.size; removed++;
      } catch (e) {}
    }
    return { ok: true, removed, total };
  } catch (e) { return { ok: false, error: e.message }; }
});
