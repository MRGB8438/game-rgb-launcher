/* ==================================================================
   Game RGB — Capacitor bridge (Android TV + Mobile)
   ------------------------------------------------------------------
   Loaded ONLY inside the Android APK (script tag injected when the
   Capacitor runtime is detected). It never touches Electron/plain-web.

   What it does:
     ① electronAPI shim — a *minimal*, honest shim: isElectron() is
        FALSE (the app stays in web mode / IndexedDB storage), but the
        EJS pipeline gets a "local core server" that is actually the
        app bundle itself (https://localhost/ejs/), so runtime files
        always boot offline-first, exactly like the Electron loopback.
     ② Core/zip import — the Iranian uploadkon zip can be imported
        straight from the file picker or downloaded in-app via the
        native HTTP bridge (CORS-free), cores land in EmulatorJS's own
        IndexedDB cache (same DB the app already fills).
     ③ Report fetch shim — CDN report requests are served from the
        bundled /ejs/cores/reports/*.json (version chain fully local).
     ④ window.open → system browser; Android Back button → Escape.
     ⑤ TV spatial navigation (D-Pad) + gamepad menu navigation.
     ⑥ Virtual gamepad overlay for touch devices.
     ⑦ Self-updater: version.json from GitHub → Iran mirror fallback,
        native APK download with progress, install prompt.
   ================================================================== */
(function () {
  'use strict';
  if (!window.Capacitor || window.__capBridgeReady) return;
  window.__capBridgeReady = true;

  /* ===================== CONFIG ===================== */
  var INTERNAL_CORES_ZIP_URL = 'https://uploadkon.ir/uploads/a7ab30_26hastegame.zip';
  // Self-updater sources (1st = GitHub raw, 2nd = Iran mirror).
  // Edit after publishing the repo, or override at runtime:
  //   localStorage.setItem('cap-update-urls', JSON.stringify(['https://...', 'https://...']))
  var UPDATE_URLS_DEFAULT = [
    'https://raw.githubusercontent.com/MRGB8438/game-rgb-launcher/main/version.json',
    'https://game-rgb.ir/version.json'
  ];
  var UPDATE_CHECK_DELAY_MS = 9000;
  var UPDATE_TIMEOUT_MS = 8000;
  var CORES = ['fceumm', 'snes9x', 'gambatte', 'mgba', 'genesis_plus_gx',
    'smsplus', 'picodrive', 'stella2014', 'prosystem', 'mednafen_psx_hw'];
  var RUNTIME_FILES = ['loader.js', 'emulator.min.js', 'emulator.min.css',
    'extract7z.js', 'extractzip.js', 'libunrar.js', 'libunrar.wasm'];
  // EmulatorJS 4.2.3 default keyboard map (player 0) — extracted from the
  // bundled emulator.min.js. [keyCode, key]
  var VPAD_KEYS = {
    up: [38, 'Up Arrow'], down: [40, 'Down Arrow'], left: [37, 'Left Arrow'],
    right: [39, 'Right Arrow'], a: [88, 'x'], b: [83, 's'], x: [90, 'z'],
    y: [65, 'a'], l: [81, 'q'], r: [69, 'e'], start: [13, 'Enter'], select: [86, 'v']
  };

  /* ===================== i18n (mini) ===================== */
  var CAP_M = {
    fa: {
      zipDownloading: 'در حال دریافت بسته هسته‌ها…', zipParsing: 'در حال پردازش زیپ…',
      zipImported: '{c} هسته اضافه شد — آماده بازی است', zipEmpty: 'هسته‌ای در زیپ پیدا نشد',
      zipFail: 'ایمپورت زیپ ناموفق بود', zipReadFail: 'خواندن فایل ناموفق بود',
      vpadOn: 'گیم‌پد مجازی روشن شد', vpadOff: 'گیم‌پد مجازی خاموش شد',
      updateAvail: 'نسخه جدید {v} منتشر شده — برای نصب لمس کن',
      updateCheckFail: '', updateLatest: 'شما جدیدترین نسخه را دارید',
      updateDownloading: 'در حال دانلود نسخه جدید… {p}٪', updateDlDone: 'دانلود کامل شد — آماده نصب',
      updateDlFail: 'دانلود نسخه جدید ناموفق بود', updateInstall: 'نصب نسخه {v}',
      updateInstallAsk: 'نسخه {v} دانلود شد. نصب شود؟', updateNeedPerm: 'برای نصب، اجازه «نصب برنامه‌های ناشناس» را بده',
      exitHint: 'برای خروج دوباره برگردید', coresWebZip: 'بسته هسته‌ها دریافت و نصب شد',
      gameDownloading: 'در حال دریافت… {p}٪', gameDlFail: 'دانلود ناموفق بود',
      corePreparing: 'در حال آماده‌سازی هسته شبیه‌ساز…', coreReady: 'هسته بازی آماده شد',
      coreFail: 'دانلود هسته ناموفق بود — اینترنت را بررسی کنید', coreAlready: 'هسته بازی از قبل آماده است'
    },
    en: {
      zipDownloading: 'Downloading cores bundle…', zipParsing: 'Processing zip…',
      zipImported: '{c} cores imported — ready to play', zipEmpty: 'No cores found in the zip',
      zipFail: 'Zip import failed', zipReadFail: 'Could not read the file',
      vpadOn: 'Virtual gamepad ON', vpadOff: 'Virtual gamepad OFF',
      updateAvail: 'New version {v} available — tap to install',
      updateCheckFail: '', updateLatest: 'You are on the latest version',
      updateDownloading: 'Downloading update… {p}%', updateDlDone: 'Download complete — ready to install',
      updateDlFail: 'Update download failed', updateInstall: 'Install {v}',
      updateInstallAsk: 'Version {v} downloaded. Install now?', updateNeedPerm: 'Grant the "install unknown apps" permission first',
      exitHint: 'Press back again to exit', coresWebZip: 'Cores bundle downloaded and installed',
      gameDownloading: 'Downloading… {p}%', gameDlFail: 'Download failed',
      corePreparing: 'Preparing emulator core…', coreReady: 'Emulator core is ready',
      coreFail: 'Core download failed — check your connection', coreAlready: 'Emulator core already ready'
    },
    ja: {
      zipDownloading: 'コアバンドルをダウンロード中…', zipParsing: 'ZIPを処理中…',
      zipImported: '{c}個のコアを追加 — プレイ可能', zipEmpty: 'ZIPにコアが見つかりません',
      zipFail: 'ZIPの取り込みに失敗', zipReadFail: 'ファイルを読めません',
      vpadOn: 'バーチャルパッド ON', vpadOff: 'バーチャルパッド OFF',
      updateAvail: '新バージョン {v} — タップして更新',
      updateCheckFail: '', updateLatest: '最新版です',
      updateDownloading: 'アップデートをダウンロード中… {p}%', updateDlDone: 'ダウンロード完了 — インストール可能',
      updateDlFail: 'ダウンロードに失敗しました', updateInstall: '{v} をインストール',
      updateInstallAsk: 'バージョン {v} をダウンロードしました。インストールしますか？',
      updateNeedPerm: '「提供元不明のアプリ」の許可が必要です',
      exitHint: 'もう一度戻るで終了します', coresWebZip: 'コアバンドルを導入しました',
      gameDownloading: 'ダウンロード中… {p}%', gameDlFail: 'ダウンロードに失敗しました',
      corePreparing: 'エミュレータコアを準備中…', coreReady: 'コアの準備ができました',
      coreFail: 'コアのダウンロードに失敗 — 接続を確認してください', coreAlready: 'コアは準備済みです'
    }
  };
  function capLang() {
    try {
      var l = (document.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase();
      if (CAP_M[l]) return l;
      var n = (navigator.language || 'en').slice(0, 2).toLowerCase();
      return CAP_M[n] ? n : 'en';
    } catch (e) { return 'en'; }
  }
  function capT(k, vars) {
    var s = (CAP_M[capLang()] || CAP_M.en)[k];
    if (s == null) s = CAP_M.en[k] || k;
    if (vars) Object.keys(vars).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); });
    return s;
  }

  /* ===================== platform class =====================
     v1.1.5: phones ALWAYS have a touchscreen, TV boxes never report one.
     Touch capability decides the UI density (cap-mobile = compact
     phone skin at native resolution, cap-tv = 10-foot UI + D-Pad). */
  var HAS_TOUCH = (navigator.maxTouchPoints > 0) || ('ontouchstart' in window);
  var IS_TV = !HAS_TOUCH ||
    /leanback|android tv|tv build|bravia|firetv|shield tv|smart tv/i.test(navigator.userAgent);
  document.documentElement.classList.add(IS_TV ? 'cap-tv' : 'cap-mobile');

  /* ---- v1.1.6: fit-to-screen zoom for TV mode ----
     cap-tv.css used to hardcode `zoom: 1.28`, tuned for one resolution.
     TV WebViews report CSS px ≈ physical px regardless of the box's real
     resolution (no density scaling like phones), so a fixed multiplier
     overflowed the frame on 720p boxes and under-filled it on others.
     Instead, scale the desktop layout (designed for a ~1400×800 baseline)
     to whatever the real screen is, clamped to a sane readable range. */
  var TV_DESIGN_W = 1400, TV_DESIGN_H = 800;
  var TV_ZOOM_MIN = 0.85, TV_ZOOM_MAX = 1.6;
  function setTvZoom() {
    if (!IS_TV) return;
    try {
      var w = window.innerWidth || document.documentElement.clientWidth;
      var h = window.innerHeight || document.documentElement.clientHeight;
      if (!w || !h) return;
      var z = Math.min(w / TV_DESIGN_W, h / TV_DESIGN_H);
      z = Math.max(TV_ZOOM_MIN, Math.min(TV_ZOOM_MAX, z));
      document.body.style.zoom = z;
    } catch (e) {}
  }
  if (IS_TV) {
    if (document.body) setTvZoom();
    else document.addEventListener('DOMContentLoaded', setTvZoom);
    window.addEventListener('load', setTvZoom); // re-measure after all resources
    window.addEventListener('resize', setTvZoom);
    window.addEventListener('orientationchange', setTvZoom);
  }

  /* ---- lock the viewport (v1.1.5): NATIVE device resolution for every
     device — the WebView lays out at the real phone width and the compact
     skin in cap-tv.css sizes the whole launcher to fit it, exactly like
     the PC version's density. Pinch-zoom is disabled (no accidental
     «بزرگنمایی») and viewport-fit=cover keeps the notch out of the frame. */
  try {
    var _vp = document.querySelector('meta[name="viewport"]');
    if (!_vp) {
      _vp = document.createElement('meta');
      _vp.setAttribute('name', 'viewport');
      (document.head || document.documentElement).appendChild(_vp);
    }
    _vp.setAttribute('content',
      'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
  } catch (e) {}

  /* ===================== tiny helpers ===================== */
  function capToast(msg, kind, ms) {
    try {
      if (typeof window.toast === 'function') { window.toast(msg, kind || 'info', ms || 5000); return; }
    } catch (e) {}
    // standalone fallback bubble
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:999999;' +
      'background:rgba(20,16,38,.95);color:#efeaff;padding:10px 16px;border-radius:12px;font-size:12.5px;' +
      'border:1px solid rgba(155,124,255,.45);max-width:80vw;font-weight:600';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, ms || 5000);
  }

  /* ==================================================
     ① electronAPI shim — honest & minimal
     ================================================== */
  var nativeHttp = null;
  function getNativeHttp() {
    if (nativeHttp) return nativeHttp;
    try { nativeHttp = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) || null; } catch (e) { nativeHttp = null; }
    return nativeHttp;
  }
  var nativeHttp0 = getNativeHttp();

  function nativeGetBuffer(url, timeoutMs) {
    var http = getNativeHttp();
    if (!http) return Promise.reject(new Error('no-native-http'));
    return http.request({
      url: url, method: 'GET', responseType: 'arraybuffer',
      connectTimeout: timeoutMs || 15000, readTimeout: timeoutMs || 30000
    }).then(function (r) {
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      var d = r.data;
      var buf = (d instanceof ArrayBuffer) ? d : null;
      if (!buf && typeof d === 'string') {
        // base64 fallback
        var bin = window.atob(d); buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        buf = buf.buffer;
      }
      if (!buf) throw new Error('bad-body');
      return buf;
    });
  }

  var api = {
    // the app stays in WEB mode — this is the honest answer
    isElectron: function () { return false; },
    // EJS pipeline: "local core server" = the app bundle itself.
    // The pipeline appends '/ejs/' — www/ejs/ holds the bundled runtime.
    startCoreServer: function () { return Promise.resolve({ success: true, url: location.origin }); },
    // bundled runtime is always complete — verify cheaply
    ejsAssetCheck: function () {
      return Promise.all(RUNTIME_FILES.map(function (n) {
        return fetch('/ejs/' + n, { method: 'HEAD', cache: 'no-store' })
          .then(function (r) { return { n: n, ok: r.ok, size: +(r.headers.get('content-length') || 0) }; })
          .catch(function () { return { n: n, ok: false, size: 0 }; });
      })).then(function (res) {
        var files = {}, complete = true, total = 0;
        res.forEach(function (x) {
          files[x.n] = { size: x.size, ok: x.ok };
          if (!x.ok) complete = false;
          total += x.size || 0;
        });
        return { success: true, complete: complete, files: files, total: total };
      });
    },
    ejsAssetDownload: function () { return Promise.resolve({ success: true, complete: true, bundled: true }); },
    checkLocalCore: function () { return Promise.resolve(null); },
    // v1.2.4: DNS ping via the native plugin (/system/bin/ping) — webview has no ICMP
    dnsPing: function (host, count) {
      return new Promise(function (resolve) {
        var plugin = getDlPlugin();
        if (plugin && typeof plugin.ping === 'function') {
          try {
            plugin.ping({ host: String(host || ''), count: count || 3 }).then(function (r) {
              resolve(r || { success: false });
            }).catch(function () { resolve({ success: false }); });
            return;
          } catch (e) {}
        }
        resolve({ success: false, unsupported: true });
      });
    },
    copyToClipboard: function (text) {
      return new Promise(function (resolve) {
        var s = String(text == null ? '' : text);
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(s).then(function () { resolve({ success: true }); },
              function () { resolve({ success: false }); });
            return;
          }
        } catch (e) {}
        resolve({ success: false });
      });
    }
  };
  window.electronAPI = api;

  /* ==================================================
     ③ fetch shim — two layers:
        a) CDN core reports → bundled copies (offline boot).
        b) cross-origin GET (ROM / catalog game downloads) →
           native HTTP (CORS-free) → app-private file → Blob →
           real Response. The app's own downloader logic (progress
           UI, archive extraction, addGameToLibrary) runs unchanged
           on top of it — downloads no longer fail with CORS errors
           and every game lands in the library like on desktop.
     ================================================== */
  var _origFetch = window.fetch ? window.fetch.bind(window) : null;
  // v1.2.1: resolve the native plugin LAZILY — re-checked on every use so a
  // late-populating bridge can never leave us holding a dead reference.
  var gameDlPlugin = null;
  function getDlPlugin() {
    if (gameDlPlugin) return gameDlPlugin;
    try { gameDlPlugin = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GameRGBUpdater) || null; } catch (e) { gameDlPlugin = null; }
    return gameDlPlugin;
  }
  (function () { var p0 = getDlPlugin(); if (p0 && p0.clearGameDownloads) { try { p0.clearGameDownloads(); } catch (e) {} } })(); // stale partial files
  function capFileNameFromUrl(u) {
    try {
      var p = new URL(u).pathname.split('/');
      var n = decodeURIComponent(p.pop() || '');
      return n || 'game.bin';
    } catch (e) { return 'game.bin'; }
  }
  // native file → Blob (chunked base64 reads, 3 MB at a time)
  // v1.1.7: build the Blob INCREMENTALLY — each chunk is merged into the
  // running Blob immediately instead of piling up in a JS array until the
  // end. Blob data lives in the browser's blob store (disk-backed under
  // memory pressure), so peak WebView heap stays around one chunk instead
  // of ≈2× the file size — multi-hundred-MB PS1/PS2 downloads no longer
  // stall or silently OOM the WebView.
  function capFileToBlob(path) {
    var plugin = getDlPlugin();
    if (!plugin) return Promise.reject(new Error('no-native-plugin'));
    var CHUNK = 3 * 1024 * 1024;
    var offset = 0;
    var running = new Blob([]);
    function readMore() {
      return plugin.readFileChunk({ path: path, offset: offset, length: CHUNK })
        .then(function (r) {
          if (!r || typeof r.data !== 'string') throw new Error('read-chunk-failed');
          var read = r.read || 0;
          if (read > 0) {
            var bin = window.atob(r.data);
            var u8 = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            running = new Blob([running, u8]);
            offset += read;
          }
          if (read >= CHUNK) return readMore(); // more to come
        });
    }
    return Promise.resolve().then(readMore).then(function () {
      if (!running.size) throw new Error('empty-download');
      return running;
    });
  }

  /* ---- live progress UI: the native download happens BEFORE the Response
         reaches the app, so the app's own progress bar would sit at 0% for
         the whole network phase. This toast shows the real percent. ---- */
  var _capDlActive = 0;
  function capDlProgressWatch() {
    var dlP = getDlPlugin();
    if (!dlP || !dlP.addListener) return;
    try {
      dlP.addListener('capGameProgress', function (data) {
        _capDlActive++;
        // v1.2.4: also expose the raw progress to the page (settings bars)
        try { window.dispatchEvent(new CustomEvent('cap-dl-progress', { detail: data || {} })); } catch (e0) {}
        var pct = Math.max(0, Math.min(100, Math.round((data && data.pct) || 0)));
        var d = dlToastShow('⬇ ' + capT('gameDownloading', { p: pct }));
        var fill = d.querySelector('.cap-dl-fill');
        if (fill) fill.style.width = pct + '%';
        if (pct >= 100) setTimeout(function () {
          if (--_capDlActive <= 0) { _capDlActive = 0; dlToastHide(); }
        }, 1200);
      });
    } catch (e) {}
  }

  // dedupe: two parallel fetches of the same URL share one native download
  var _inflight = {};
  function capNativeBuffer(url) {
    if (_inflight[url]) return _inflight[url];
    var plugin = getDlPlugin();
    if (!plugin) return Promise.reject(new Error('no-native-plugin')); // v1.2.1: was TypeError on undefined
    var p = plugin.downloadGameFile({ url: url, fileName: capFileNameFromUrl(url) })
      .then(function (r) {
        if (!r || !r.success || !r.path) throw new Error('native-dl-failed');
        return capFileToBlob(r.path).then(function (blob) {
          try { plugin.deleteGameFile({ path: r.path }); } catch (e) {}
          return { blob: blob, ctype: String(r.contentType || '') };
        });
      })
      .finally(function () { delete _inflight[url]; });
    _inflight[url] = p;
    return p;
  }
  // layer 2: CapacitorHttp arraybuffer (independent native stack — recovers
  // hosts that trip on HttpURLConnection quirks, SSL pinning, redirects…)
  function capHttpBuffer(url) {
    return nativeGetBuffer(url, 60000).then(function (buf) {
      return { blob: new Blob([buf]), ctype: '' };
    });
  }
  function capBlobResponse(res) {
    var ctype = String(res.ctype || '').split(';')[0].trim().toLowerCase();
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(ctype) || ctype === 'text/html') ctype = 'application/octet-stream';
    var headers = { 'content-type': ctype };
    try { headers['content-length'] = String(res.blob.size); } catch (e) {}
    return new Response(res.blob, { status: 200, statusText: 'OK', headers: headers });
  }
  function capNativeResponse(url) {
    var fname = capFileNameFromUrl(url);
    return capNativeBuffer(url)
      .catch(function (err1) {
        return capHttpBuffer(url).catch(function () { throw err1; }); // keep 1st error
      })
      .then(function (res) { return capBlobResponse(res); })
      .catch(function (err) {
        // last resort: plain fetch (host may allow CORS)
        return _origFetch(url).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r;
        }).catch(function () {
          capToast(capT('gameDlFail') + ' — ' + fname, 'error', 7000);
          throw err;
        });
      });
  }
  if (_origFetch) {
    var REPORT_RE = /^https?:\/\/[^/]*emulatorjs\.org[^/]*\/data\/cores\/reports\/([A-Za-z0-9_-]+)\.json(\?.*)?$/;
    window.fetch = function (input, init) {
      try {
        var url = (typeof input === 'string') ? input : (input && input.url) || '';
        var m = REPORT_RE.exec(url);
        if (m) {
          return _origFetch('/ejs/cores/reports/' + m[1] + '.json', { cache: 'no-store' })
            .then(function (r) { if (r.ok) return r; throw new Error('no-bundled-report'); })
            .catch(function () { return _origFetch(input, init); });
        }
        // cross-origin GET without body → native CORS-free path
        var method = 'GET';
        try { method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase(); } catch (e2) {}
        var cross = false;
        try { cross = /^https?:/i.test(url) && (new URL(url, location.href).origin !== location.origin); } catch (e3) {}
        // v1.2.1: route EVERY cross-origin GET through the native layers —
        // layer 1 (GameRGBUpdater) is optional now: capNativeBuffer rejects
        // with no-native-plugin and layer 2 (CapacitorHttp, always present)
        // takes over, then plain fetch. Previously the whole chain was gated
        // on gameDlPlugin being truthy, so a missing plugin silently pushed
        // every download into CORS-bound plain fetch ("Failed to fetch").
        if (cross && method === 'GET' && !(init && init.body)) {
          return capNativeResponse(url);
        }
      } catch (e) {}
      return _origFetch(input, init);
    };
  }
  capDlProgressWatch(); // live % toast for native game downloads

  /* ==================================================
     ② Core cache writer (EmulatorJS IndexedDB)
     Copied from the app's own proven v1.0.6 logic.
     ================================================== */
  var EJS_CORE_DB = 'EmulatorJS-core', EJS_CORE_STORE = 'core';
  function ejsOpenCoreDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexedDB'));
      var req = indexedDB.open(EJS_CORE_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(EJS_CORE_STORE)) db.createObjectStore(EJS_CORE_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb open failed')); };
    });
  }
  function ejsCoreGet(key) {
    return ejsOpenCoreDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var r = db.transaction([EJS_CORE_STORE], 'readonly').objectStore(EJS_CORE_STORE).get(key);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }).catch(function () { return null; });
  }
  function ejsCorePutRaw(key, val) {
    return ejsOpenCoreDb().then(function (db) {
      return new Promise(function (resolve) {
        try {
          var r = db.transaction([EJS_CORE_STORE], 'readwrite').objectStore(EJS_CORE_STORE).put(val, key);
          r.onsuccess = resolve; r.onerror = resolve;
        } catch (e) { resolve(); }
      });
    });
  }
  // EmulatorJS tracks its cached files in a "?EJS_KEYS!" index record — keep it
  // in sync. Concurrent imports (the 10-core zip) race the read-modify-write,
  // so every update is serialized through a promise chain.
  var _keyIndexChain = Promise.resolve();
  function ejsCoreSyncKeyIndex(key, added) {
    var run = function () {
      return ejsCoreGet('?EJS_KEYS!').then(function (keys) {
        if (!Array.isArray(keys)) keys = [];
        var has = keys.indexOf(key) >= 0;
        if (added && !has) keys.push(key);
        else if (!added && has) keys = keys.filter(function (k) { return k !== key; });
        return ejsCorePutRaw('?EJS_KEYS!', keys);
      });
    };
    _keyIndexChain = _keyIndexChain.then(run, run);
    return _keyIndexChain;
  }
  function webgl2Ok() {
    try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
  }
  function coreFileName(core, rep) {
    var defaultGL2 = !!(rep && rep.options && rep.options.defaultWebGL2);
    return core + ((webgl2Ok() && defaultGL2) ? '' : '-legacy') + '-wasm.data';
  }
  function coreAltFileName(core, rep) {
    var f = coreFileName(core, rep);
    return f.indexOf('-legacy-') >= 0 ? f.replace('-legacy-', '-') : f.replace('-wasm.data', '-legacy-wasm.data');
  }
  function bundledReport(core) {
    // v1.2.3 FIX: use XHR instead of fetch() for the relative /ejs/ path —
    // same-origin XHR is untouched by the native fetch shim and always
    // reaches the bundled report JSON. The bundled buildStart is the SAME
    // identity EmulatorJS sees when booting from the bundled data path, so
    // seeding with it keeps the IndexedDB cache hitting on every launch
    // (previously a shim-relative-URL failure silently yielded version
    // 'local-zip', which EJS never matched → core re-downloaded each game).
    return new Promise(function (resolve) {
      try {
        var xhr = new XMLHttpRequest();
        var t = setTimeout(function () { try { xhr.abort(); } catch (e) {} resolve(null); }, 4000);
        xhr.onload = function () {
          clearTimeout(t);
          try {
            if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
            else resolve(null);
          } catch (e) { resolve(null); }
        };
        xhr.onerror = function () { clearTimeout(t); resolve(null); };
        xhr.open('GET', '/ejs/cores/reports/' + core + '.json', true);
        xhr.send();
      } catch (e) { resolve(null); }
    });
  }
  function storeCore(core, data, forcedRep) {
    // v1.2.3: optional forced report (used by the mirror downloader so the
    // seeded version identity matches the mirror the bytes came from).
    var repP = forcedRep ? Promise.resolve(forcedRep) : bundledReport(core);
    return repP.then(function (rep) {
      var bs = rep && (rep.buildStart || (rep.data && rep.data.buildStart));
      var primary = coreFileName(core, rep);
      var rec = { version: String(bs || 'local-zip'), data: data };
      var jobs = [ejsCorePutRaw(primary, rec).then(function () { return ejsCoreSyncKeyIndex(primary, true); })];
      if (!bs) { // no version chain — write both variants to be safe
        var alt = coreAltFileName(core, rep);
        jobs.push(ejsCorePutRaw(alt, rec).then(function () { return ejsCoreSyncKeyIndex(alt, true); }));
      }
      return Promise.all(jobs);
    });
  }

  /* ==================================================
     ② ZIP parser (STORE + DEFLATE, no deps)
     ================================================== */
  function u16(v, o) { return v[o] | (v[o + 1] << 8); }
  function u32(v, o) { return (v[o] | (v[o + 1] << 8) | (v[o + 2] << 16) | (v[o + 3] << 24)) >>> 0; }
  function parseZip(buf) {
    var v = new Uint8Array(buf);
    // find EOCD
    var i = v.length - 22, min = Math.max(0, v.length - 65558);
    while (i >= min && !(v[i] === 0x50 && v[i + 1] === 0x4b && v[i + 2] === 0x05 && v[i + 3] === 0x06)) i--;
    if (i < min) return Promise.reject(new Error('no-eocd'));
    var count = u16(v, i + 10), cdOff = u32(v, i + 16);
    var entries = [], p = cdOff;
    for (var e = 0; e < count; e++) {
      if (v[p] !== 0x50 || v[p + 1] !== 0x4b || v[p + 2] !== 0x01 || v[p + 3] !== 0x02) break;
      var method = u16(v, p + 10), csize = u32(v, p + 20), usize = u32(v, p + 24);
      var nlen = u16(v, p + 28), elen = u16(v, p + 30), clen = u16(v, p + 32);
      var lho = u32(v, p + 42);
      var name = '';
      for (var c = 0; c < nlen; c++) name += String.fromCharCode(v[p + 46 + c]);
      entries.push({ name: name, method: method, csize: csize, usize: usize, lho: lho });
      p += 46 + nlen + elen + clen;
    }
    function inflate(raw, method) {
      if (method === 0) return Promise.resolve(raw);
      if (method !== 8 || typeof DecompressionStream === 'undefined')
        return Promise.reject(new Error('unsupported-method-' + method));
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([raw]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer();
    }
    function entryData(en) {
      var h = en.lho;
      if (v[h] !== 0x50 || v[h + 1] !== 0x4b || v[h + 2] !== 0x03 || v[h + 3] !== 0x04)
        return Promise.reject(new Error('bad-lfh'));
      var n2 = u16(v, h + 26), e2 = u16(v, h + 28);
      var start = h + 30 + n2 + e2;
      var raw = v.slice(start, start + en.csize);
      return inflate(raw, en.method);
    }
    return Promise.all(entries.map(function (en) {
      return entryData(en).then(function (data) { return { name: en.name, data: data }; })
        .catch(function () { return null; });
    })).then(function (list) { return list.filter(Boolean); });
  }

  var CORE_FILE_RE = /^[A-Za-z0-9_-]+-(legacy-)?wasm\.(data|7z)$/i;
  function importZipBundle(buf) {
    capToast(capT('zipParsing'), 'info');
    return parseZip(buf).then(function (items) {
      var cores = 0, assets = 0, jobs = [];
      items.forEach(function (it) {
        var base = (it.name.split('/').pop() || '');
        if (CORE_FILE_RE.test(base)) {
          var core = base.replace(/-(legacy-)?wasm\.(data|7z)$/i, '').toLowerCase();
          jobs.push(storeCore(core, it.data).then(function () { cores++; }));
        } else if (RUNTIME_FILES.indexOf(base.toLowerCase()) >= 0) {
          assets++; // bundled in the APK already — nothing to store
        }
      });
      return Promise.all(jobs).then(function () { return { success: true, cores: cores, assets: assets }; });
    });
  }

  // ---- file-picker import (feeds the existing «وارد کردن زیپ هسته‌ها…» button)
  api.ejsZipFileImport = function () {
    return new Promise(function (resolve) {
      var input = document.getElementById('import-zip-input');
      if (!input) {
        input = document.createElement('input');
        input.type = 'file'; input.accept = '.zip'; input.style.display = 'none';
        input.id = 'import-zip-input';
        document.body.appendChild(input);
      }
      var done = false;
      input.onchange = function () {
        var f = input.files && input.files[0];
        input.value = '';
        if (!f) { if (!done) { done = true; resolve({ canceled: true }); } return; }
        capToast(capT('zipDownloading'), 'info');
        f.arrayBuffer().then(function (buf) { return importZipBundle(buf); })
          .then(function (r) { if (!done) { done = true; resolve(r); } })
          .catch(function (err) { if (!done) { done = true; resolve({ success: false, error: err && err.message }); } });
      };
      try { input.click(); } catch (e) { if (!done) { done = true; resolve({ success: false, error: 'picker-failed' }); } }
      // window 'change' may not fire if user cancels on some WebViews —
      // focus recovery acts as cancel detection
      window.addEventListener('focus', function onFocus() {
        setTimeout(function () {
          if (!done && !(input.files && input.files.length)) { done = true; resolve({ canceled: true }); }
          window.removeEventListener('focus', onFocus);
        }, 900);
      }, { once: true });
    });
  };
  // ---- direct download from the Iranian mirror (native HTTP, CORS-free)
  api.ejsZipUrlImport = function (url) {
    var u = url || INTERNAL_CORES_ZIP_URL;
    capToast(capT('zipDownloading'), 'info', 8000);
    return nativeGetBuffer(u, 30000)
      .then(function (buf) { return importZipBundle(buf); })
      .catch(function (err) { return { success: false, error: err && err.message }; });
  };

  /* ==================================================
     ②½ Core auto-ensure (v1.1.4) — THE missing piece that made
     games never boot on the APK: EJS resolves cores from its own
     IndexedDB cache and on a miss fetches
     <pathtodata>/cores/<core>-wasm.data — not bundled → 404 →
     black screen. __capEnsureCore(core) guarantees presence:
       1) already cached with a fresh version → instant true
       2) single-core download from the 4 CDN mirrors (the fetch
          shim makes it native / CORS-free) — ~1-2 MB, seconds
       3) full Iran cores zip (uploadkon) → all 10 cores at once
     Also a silent first-run prewarm imports the whole bundle.
     ================================================== */
  var EJS_CORE_MIRRORS = [
    'https://cdn.emulatorjs.org/stable/data/',
    'https://cdn.emulatorjs.org/latest/data/',
    'https://cdn.jsdelivr.net/npm/@emulatorjs/emulatorjs@4.2.3/data/',
    'https://cdn.jsdelivr.net/gh/EmulatorJS/EmulatorJS@4.2.3/data/'
  ];
  function ejsCoreFresh(core) {
    return bundledReport(core).then(function (rep) {
      var bs = rep && (rep.buildStart || (rep.data && rep.data.buildStart));
      var names = [coreFileName(core, rep), coreAltFileName(core, rep)];
      return Promise.all(names.map(function (n) { return ejsCoreGet(n); })).then(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (r && r.data && (!bs || String(r.version) === String(bs))) return true;
        }
        return false;
      });
    }).catch(function () { return false; });
  }
  function capDownloadCoreFromMirrors(core) {
    var i = 0;
    // v1.2.3: resolve the report FROM THE SAME MIRROR the bytes come from so
    // the seeded record's version/filename identity is exactly the one EJS
    // computes for that build (bundled report only as fallback).
    function mirrorReport(base) {
      return window.fetch(base + 'cores/reports/' + core + '.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('report HTTP ' + r.status); return r.json(); })
        .catch(function () { return null; });
    }
    function tryNext() {
      if (i >= EJS_CORE_MIRRORS.length) return Promise.resolve(false);
      var base = EJS_CORE_MIRRORS[i++];
      return mirrorReport(base).then(function (rep) {
        return rep || bundledReport(core);
      }).then(function (rep) {
        var fname = coreFileName(core, rep);
        // window.fetch = the shim → native CORS-free download + live % toast
        return window.fetch(base + 'cores/' + fname, { cache: 'no-store' })
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
          })
          .then(function (buf) { return storeCore(core, buf, rep).then(function () { return true; }); });
      }).catch(function () { return tryNext(); });
    }
    return tryNext();
  }
  function capImportCoresZip() {
    // v1.2.1: native engine first (streaming + live capGameProgress % toast).
    // Two fixes here:
    //  a) parseZip() needs an ArrayBuffer — the native path used to hand it a
    //     Blob (new Uint8Array(blob) is empty) so the import always failed
    //     with "no-eocd" even when the download itself worked;
    //  b) if the native plugin is unavailable, fall back to the fetch shim,
    //     whose layer-2 (CapacitorHttp) keeps the CORS-free download working
    //     instead of crashing with a TypeError on undefined.
    var viaNative = getDlPlugin()
      ? capNativeBuffer(INTERNAL_CORES_ZIP_URL).then(function (res) { return res.blob.arrayBuffer(); })
      : Promise.reject(new Error('no-native-plugin'));
    return viaNative
      .catch(function () {
        return window.fetch(INTERNAL_CORES_ZIP_URL, { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        });
      })
      .then(function (ab) { return importZipBundle(ab); })
      .then(function (res) {
        if (res && res.success && res.cores > 0) {
          capToast(capT('zipImported', { c: res.cores }), 'success', 4500);
          return true;
        }
        return false;
      });
  }
  var _ensureChain = Promise.resolve();
  function capEnsureCore(core) {
    core = String(core || '').toLowerCase();
    if (!core) return Promise.resolve(false);
    var run = function () {
      return ejsCoreFresh(core).then(function (ok) {
        if (ok) return true;
        capToast(capT('corePreparing'), 'info', 9000);
        return capDownloadCoreFromMirrors(core).then(function (ok2) {
          if (ok2) { capToast(capT('coreReady'), 'success', 3500); return true; }
          return capImportCoresZip().then(function (zipOk) {
            return zipOk ? ejsCoreFresh(core) : false;
          }).then(function (finalOk) {
            if (!finalOk) capToast(capT('coreFail'), 'error', 7000);
            return finalOk;
          });
        });
      });
    };
    _ensureChain = _ensureChain.then(run, run);
    return _ensureChain;
  }
  window.__capEnsureCore = function (core) {
    return capEnsureCore(core).catch(function () { return false; });
  };
  // silent first-run prewarm: core cache completely empty → import the whole
  // Iran bundle in the background so the first game launch needs zero waiting
  setTimeout(function () {
    ejsCoreGet('?EJS_KEYS!').then(function (keys) {
      if (Array.isArray(keys) && keys.length) return;
      if (document.body.classList.contains('player-active')) return;
      capImportCoresZip().catch(function () {});
    });
  }, 11000);

  /* ==================================================
     ④ window.open → system browser
     ================================================== */
  var appPlugin = null;
  try { appPlugin = window.Capacitor.Plugins && window.Capacitor.Plugins.App; } catch (e) {}
  var _origOpen = window.open ? window.open.bind(window) : null;
  window.open = function (url, target, features) {
    try {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        if (appPlugin && appPlugin.launchUrl) {
          appPlugin.launchUrl({ url: url, openInSystemBrowser: true });
          return null;
        }
      }
    } catch (e) {}
    return _origOpen ? _origOpen(url, target, features) : null;
  };

  /* ==================================================
     ④ Android Back button → Escape (double-press exits)
     ================================================== */
  if (appPlugin && appPlugin.addListener && appPlugin.backButton) {
    var lastBack = 0;
    appPlugin.addListener('backButton', function () {
      try {
        var now = Date.now();
        var inPlayer = document.body.classList.contains('player-active');
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        }));
        document.body.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
        }));
        // if nothing visually handled it, a second press within 2.4s exits
        if (now - lastBack < 2400 && !inPlayer) {
          try { appPlugin.exitApp(); } catch (e2) {}
          return;
        }
        if (!inPlayer) capToast(capT('exitHint'), 'info', 2000);
        lastBack = now;
      } catch (e) {}
    });
  }

  /* ==================================================
     ⑤ TV spatial navigation (D-Pad)
     ================================================== */
  var FOCUS_SEL = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, ' +
    '[tabindex]:not([tabindex="-1"]), .game-card, .ejs-core-row, .storage-row, .nav-btn, label, .chip, .tag-chip';
  var focusCur = null;
  function capVisible(el) {
    if (!el || !el.getClientRects().length) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
  }
  function focusables() {
    var list = [];
    try { list = Array.prototype.slice.call(document.querySelectorAll(FOCUS_SEL)); } catch (e) {}
    list = list.filter(capVisible);
    // restrict to open modal/dialog subtree when the current focus lives there
    if (focusCur) {
      var box = focusCur.closest &&
        focusCur.closest('[class*="modal"], [class*="dialog"], [class*="sheet"], [class*="overlay"]');
      if (box) {
        var inner = list.filter(function (el) { return box.contains(el); });
        if (inner.length) list = inner;
      }
    }
    return list;
  }
  function setFocus(el) {
    if (!el) return;
    if (focusCur && focusCur.classList) focusCur.classList.remove('cap-focused');
    focusCur = el;
    try {
      if (!IS_TV) { el.focus && el.focus(); return; }
      el.classList.add('cap-focused');
      el.focus && el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch (e) {}
  }
  function moveFocus(dir) {
    var cands = focusables();
    if (!cands.length) return;
    if (!focusCur || !capVisible(focusCur)) {
      var first = cands.find(function (el) { return el.getBoundingClientRect().top >= 0; }) || cands[0];
      setFocus(first); return;
    }
    var cr = focusCur.getBoundingClientRect();
    var cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    var best = null, bestScore = Infinity;
    cands.forEach(function (el) {
      if (el === focusCur) return;
      var r = el.getBoundingClientRect();
      var ex = r.left + r.width / 2, ey = r.top + r.height / 2;
      var dx = ex - cx, dy = ey - cy;
      var primary, cross, ok = false;
      if (dir === 'left') { ok = dx < -4; primary = -dx; cross = Math.abs(dy); }
      else if (dir === 'right') { ok = dx > 4; primary = dx; cross = Math.abs(dy); }
      else if (dir === 'up') { ok = dy < -4; primary = -dy; cross = Math.abs(dx); }
      else { ok = dy > 4; primary = dy; cross = Math.abs(dx); }
      if (!ok) return;
      var score = primary + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    });
    if (best) setFocus(best);
  }
  function capActivate(el) {
    if (!el) return;
    if (/^(input|textarea|select)$/i.test(el.tagName)) { el.focus(); return; }
    el.click && el.click();
  }
  if (IS_TV) {
    document.addEventListener('keydown', function (ev) {
      var tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      var typing = tag === 'input' || tag === 'textarea' || (document.activeElement && document.activeElement.isContentEditable);
      if (typing) return;
      switch (ev.key) {
        case 'ArrowUp': ev.preventDefault(); moveFocus('up'); break;
        case 'ArrowDown': ev.preventDefault(); moveFocus('down'); break;
        case 'ArrowLeft': ev.preventDefault(); moveFocus('left'); break;
        case 'ArrowRight': ev.preventDefault(); moveFocus('right'); break;
        case 'Enter': {
          var el = focusCur || document.activeElement;
          if (el && el !== document.body) { ev.preventDefault(); capActivate(el); }
          break;
        }
      }
    }, true);
    document.addEventListener('focusin', function (ev) {
      if (ev.target && ev.target !== focusCur) setFocus(ev.target);
    });
  }

  /* ---- gamepad menu navigation (menus only, never during gameplay) ---- */
  if (IS_TV) {
    var gpLast = { mv: 0, btn: {} };
    function gamepadMenuTick() {
      if (document.body.classList.contains('player-active')) return;
      var pads;
      try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { return; }
      for (var i = 0; i < pads.length; i++) {
        var gp = pads[i]; if (!gp || !gp.connected) continue;
        var now = Date.now();
        var ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        var dir = null;
        if (gp.buttons[14] && gp.buttons[14].pressed || ax < -0.55) dir = 'left';
        else if (gp.buttons[15] && gp.buttons[15].pressed || ax > 0.55) dir = 'right';
        else if (gp.buttons[12] && gp.buttons[12].pressed || ay < -0.55) dir = 'up';
        else if (gp.buttons[13] && gp.buttons[13].pressed || ay > 0.55) dir = 'down';
        if (dir && now - gpLast.mv > 190) { gpLast.mv = now; moveFocus(dir); }
        if (gp.buttons[0] && gp.buttons[0].pressed && !gpLast.btn[0]) capActivate(focusCur || document.activeElement);
        if (gp.buttons[1] && gp.buttons[1].pressed && !gpLast.btn[1]) {
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        }
        gpLast.btn[0] = gp.buttons[0] && gp.buttons[0].pressed;
        gpLast.btn[1] = gp.buttons[1] && gp.buttons[1].pressed;
      }
    }
    setInterval(gamepadMenuTick, 90);
  }

  /* ==================================================
     ⑥ Virtual gamepad (touch devices, in-game only)
     ================================================== */
  function dispatchToGame(type, btn) {
    try {
      var fr = document.querySelector('#player iframe');
      var idoc = fr && fr.contentDocument;
      if (!idoc) return false;
      // EJS 4.2.3 binds keydown/keyup on its .ejs_parent div (no capture)
      var target = idoc.querySelector('.ejs_parent') || idoc.getElementById('game') || idoc.body;
      if (!target) return false;
      var cfg = VPAD_KEYS[btn]; if (!cfg) return false;
      var ev = new KeyboardEvent(type, { key: cfg[1], bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'keyCode', { get: function () { return cfg[0]; } });
      Object.defineProperty(ev, 'which', { get: function () { return cfg[0]; } });
      target.dispatchEvent(ev);
      return true;
    } catch (e) { return false; }
  }
  if (!IS_TV) {
    var vpad = document.createElement('div');
    vpad.id = 'cap-vpad';
    var dpadCls = ['up', 'down', 'left', 'right'];
    var dpadGlyph = { up: '▲', down: '▼', left: '◀', right: '▶' };
    var h = '<div class="vp-cluster vp-left"><div class="vp-dpad">';
    dpadCls.forEach(function (d) { h += '<div class="vp-btn vp-' + d + '" data-vp="' + d + '">' + dpadGlyph[d] + '</div>'; });
    h += '<div class="vp-center"></div></div></div>';
    h += '<div class="vp-cluster vp-right"><div class="vp-face">';
    ['a', 'b', 'x', 'y'].forEach(function (b) {
      h += '<div class="vp-btn vp-' + b + '" data-vp="' + b + '"><span>' + b.toUpperCase() + '</span></div>';
    });
    h += '</div></div>';
    // v1.1.4: ✕ lives ON the pad itself — the floating 🎮 handle previously
    // collided with the face buttons; now the handle only shows when OFF
    h += '<div class="vp-mid">' +
      '<div class="vp-btn small" data-vp="select">SELECT</div>' +
      '<div class="vp-btn small" data-vp="start">START</div>' +
      '<div class="vp-btn small vp-close" id="cap-vpad-close">✕</div></div>';
    h += '<div class="vp-shoulder vp-ls"><div class="vp-btn" data-vp="l">L</div></div>';
    h += '<div class="vp-shoulder vp-rs"><div class="vp-btn" data-vp="r">R</div></div>';
    vpad.innerHTML = h;
    document.body.appendChild(vpad);
    var handle = document.createElement('div');
    handle.id = 'cap-vpad-handle';
    handle.textContent = '🎮';
    document.body.appendChild(handle);
    var vpadOn = false;
    try { vpadOn = localStorage.getItem('cap-vpad-on') === '1'; } catch (e) {}
    function applyVpad() {
      vpad.classList.toggle('show', vpadOn);
      document.body.classList.toggle('cap-vpad-on', vpadOn);
      try { localStorage.setItem('cap-vpad-on', vpadOn ? '1' : '0'); } catch (e) {}
    }
    applyVpad();
    handle.addEventListener('click', function () {
      vpadOn = !vpadOn; applyVpad();
      capToast(capT(vpadOn ? 'vpadOn' : 'vpadOff'), 'info', 2500);
    });
    /* ---- input plumbing (v1.1.4 rework) ----
       • per-pointer map + setPointerCapture: the release event always lands
         on the pressed button even if the finger slides off → keys never
         stick (the old container-level pointerleave never fired because the
         container is pointer-events:none)
       • full multi-touch: D-Pad + face buttons held simultaneously
       • D-Pad slide: rolling the thumb from ▲ to ▶ switches direction
         without lifting, like a real pad */
    var pressed = {}; // pointerId → button element
    vpad.addEventListener('pointerdown', function (ev) {
      var closeB = ev.target.closest && ev.target.closest('#cap-vpad-close');
      if (closeB) {
        ev.preventDefault(); ev.stopPropagation();
        vpadOn = false; applyVpad();
        capToast(capT('vpadOff'), 'info', 2000);
        return;
      }
      var b = ev.target.closest && ev.target.closest('[data-vp]');
      if (!b) return;
      ev.preventDefault(); ev.stopPropagation();
      try { if (b.setPointerCapture) b.setPointerCapture(ev.pointerId); } catch (e) {}
      pressed[ev.pointerId] = b;
      b.classList.add('pressed');
      dispatchToGame('keydown', b.getAttribute('data-vp'));
    }, { passive: false });
    function vpRelease(ev) {
      var b = pressed[ev.pointerId];
      if (!b) return;
      delete pressed[ev.pointerId];
      b.classList.remove('pressed');
      dispatchToGame('keyup', b.getAttribute('data-vp'));
    }
    vpad.addEventListener('pointerup', vpRelease);
    vpad.addEventListener('pointercancel', vpRelease);
    document.addEventListener('pointerup', vpRelease, true);   // safety net
    document.addEventListener('pointercancel', vpRelease, true);
    vpad.addEventListener('pointermove', function (ev) { // D-Pad slide
      var b = pressed[ev.pointerId];
      if (!b || !b.closest('.vp-dpad')) return;
      var el = null;
      try { el = document.elementFromPoint(ev.clientX, ev.clientY); } catch (e) {}
      var nb = el && el.closest ? el.closest('#cap-vpad .vp-dpad [data-vp]') : null;
      if (nb && nb !== b) {
        b.classList.remove('pressed');
        dispatchToGame('keyup', b.getAttribute('data-vp'));
        pressed[ev.pointerId] = nb;
        try { if (nb.setPointerCapture) nb.setPointerCapture(ev.pointerId); } catch (e) {}
        nb.classList.add('pressed');
        dispatchToGame('keydown', nb.getAttribute('data-vp'));
      }
    }, { passive: true });
    vpad.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

    // v1.1.6: release ALL held buttons on any interruption that doesn't
    // reliably deliver pointercancel on some WebViews — app backgrounded,
    // screen locked, incoming call, or the pad toggled off mid-press.
    // Without this a button could stay "held" in the game forever.
    function releaseAllVpad() {
      Object.keys(pressed).forEach(function (pid) {
        var b = pressed[pid];
        delete pressed[pid];
        if (b) { b.classList.remove('pressed'); dispatchToGame('keyup', b.getAttribute('data-vp')); }
      });
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) releaseAllVpad();
    });
    window.addEventListener('pagehide', releaseAllVpad);
    window.addEventListener('blur', releaseAllVpad);
    var _origApplyVpad = applyVpad;
    applyVpad = function () { if (!vpadOn) releaseAllVpad(); _origApplyVpad(); };
  }

  /* ==================================================
     ⑦ Self-updater (GitHub → Iran mirror fallback)
     ================================================== */
  var updaterPlugin = null;
  function getUpdaterPlugin() {
    if (updaterPlugin) return updaterPlugin;
    try { updaterPlugin = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GameRGBUpdater) || null; } catch (e) { updaterPlugin = null; }
    return updaterPlugin;
  }
  getUpdaterPlugin();

  function updateUrls() {
    try {
      var o = JSON.parse(localStorage.getItem('cap-update-urls') || 'null');
      if (Array.isArray(o) && o.length && o.every(function (u) { return typeof u === 'string'; })) return o;
    } catch (e) {}
    return UPDATE_URLS_DEFAULT;
  }
  function fetchVersionInfo() {
    var urls = updateUrls(), i = 0;
    function tryNext() {
      if (i >= urls.length) return Promise.reject(new Error('all-sources-failed'));
      var u = urls[i++];
      var useNative = /^https?:/i.test(u);
      var p = (useNative && getNativeHttp())
        ? nativeHttp.request({ url: u, method: 'GET', connectTimeout: UPDATE_TIMEOUT_MS, readTimeout: UPDATE_TIMEOUT_MS })
          .then(function (r) {
            var d = r.data;
            return (typeof d === 'string') ? JSON.parse(d) : d;
          })
        : _origFetch(u, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      return p.catch(function () { return tryNext(); });
    }
    return tryNext();
  }
  function versionNums(v) {
    return String(v || '').replace(/[^0-9.]/g, '').split('.').map(function (x) { return parseInt(x || '0', 10); });
  }
  function isNewer(a, b) { // a > b ?
    var x = versionNums(a), y = versionNums(b), n = Math.max(x.length, y.length);
    for (var i = 0; i < n; i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }
  function ensureChip() {
    var chip = document.getElementById('cap-update-chip');
    if (chip) return chip;
    chip = document.createElement('div');
    chip.id = 'cap-update-chip';
    chip.innerHTML = '<span class="cap-uc-ico">⬆</span><span class="cap-uc-msg"></span>';
    document.body.appendChild(chip);
    return chip;
  }
  function showChip(msg, onclick) {
    var chip = ensureChip();
    chip.querySelector('.cap-uc-msg').textContent = msg;
    chip.onclick = onclick;
    chip.classList.add('show');
  }
  function hideChip() { var c = document.getElementById('cap-update-chip'); if (c) c.classList.remove('show'); }
  function dlToastShow(msg) {
    var d = document.getElementById('cap-dl-toast') || (function () {
      var el = document.createElement('div');
      el.id = 'cap-dl-toast';
      el.innerHTML = '<span class="cap-dl-msg"></span><div class="cap-dl-bar"><div class="cap-dl-fill"></div></div>';
      document.body.appendChild(el);
      return el;
    })();
    d.querySelector('.cap-dl-msg').textContent = msg;
    d.classList.add('show');
    return d;
  }
  function dlToastHide() { var d = document.getElementById('cap-dl-toast'); if (d) d.classList.remove('show'); }

  var updateBusy = false;
  function checkForUpdate(silent) {
    if (updateBusy || !getUpdaterPlugin()) return Promise.resolve();
    updateBusy = true;
    var localV = '0';
    updaterPlugin.getAppVersion().then(function (r) {
      localV = (r && (r.versionName || r.version)) || '0';
    }).catch(function () {}).then(function () {
      return fetchVersionInfo().then(function (info) {
        updateBusy = false;
        var v = info && (info.version || info.versionName);
        if (!v) return;
        if (!isNewer(v, localV)) {
          if (!silent) capToast(capT('updateLatest'), 'info', 3000);
          return;
        }
        var urls = (Array.isArray(info.apk) && info.apk.length) ? info.apk : [(info.apk || info.apkUrl)].filter(Boolean);
        showChip(capT('updateAvail', { v: v }), function () {
          hideChip();
          downloadAndOffer(v, urls);
        });
      }).catch(function () {
        updateBusy = false;
        if (!silent) capToast(capT('updateCheckFail') || capT('updateLatest'), 'info', 3000);
      });
    });
    return Promise.resolve();
  }
  function downloadAndOffer(v, urls) {
    // v1.2.1: native updater plugin missing → graceful fallback instead of a
    // dead chip: open the APK URL in the system browser so the user can still
    // download & install manually.
    if (!getUpdaterPlugin()) {
      dlToastHide();
      var u0 = (urls && urls[0]) || '';
      try {
        if (appPlugin && appPlugin.launchUrl) appPlugin.launchUrl({ url: u0, openInSystemBrowser: true });
        else if (_origOpen) _origOpen(u0, '_blank');
      } catch (e) {}
      capToast('دانلود خودکار ممکن نشد — لینک APK در مرورگر باز شد؛ فایل را دانلود و نصب کنید', 'info', 9000);
      return;
    }
    var toastEl = dlToastShow(capT('updateDownloading', { p: 0 }));
    var fill = toastEl.querySelector('.cap-dl-fill');
    var progHandler = null;
    if (updaterPlugin.addListener) {
      updaterPlugin.addListener('capApkProgress', function (data) {
        var pct = Math.max(0, Math.min(100, Math.round((data && data.pct) || 0)));
        toastEl.querySelector('.cap-dl-msg').textContent = capT('updateDownloading', { p: pct });
        fill.style.width = pct + '%';
      }).then(function (h) { progHandler = h; });
    }
    var urlsLeft = urls.slice();
    function tryDl() {
      if (!urlsLeft.length) {
        dlToastHide();
        capToast(capT('updateDlFail'), 'error', 6000);
        return;
      }
      var u = urlsLeft.shift();
      updaterPlugin.downloadApk({ url: u }).then(function (r) {
        if (progHandler && progHandler.remove) progHandler.remove();
        if (!r || !r.success || !r.path) { tryDl(); return; }
        dlToastHide();
        offerInstall(v, r.path);
      }).catch(function () { tryDl(); });
    }
    tryDl();
  }
  function offerInstall(v, path) {
    capToast(capT('updateDlDone'), 'success', 5000);
    showChip(capT('updateInstall', { v: v }), function () {
      hideChip();
      updaterPlugin.installApk({ path: path }).then(function (r) {
        if (r && r.success) return;
        if (r && r.needPermission) {
          capToast(capT('updateNeedPerm'), 'error', 6000);
          updaterPlugin.requestInstallPermission().catch(function () {});
        }
      }).catch(function () {});
    });
    // auto-offer permission upfront to smooth the flow
    updaterPlugin.hasInstallPermission().then(function (r) {
      if (r && !r.granted) updaterPlugin.requestInstallPermission().catch(function () {});
    }).catch(function () {});
  }
  setTimeout(function () { checkForUpdate(true); }, UPDATE_CHECK_DELAY_MS);
  // re-check whenever settings open (user-visible entry point)
  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('#settings-btn, [data-i18n="settings"]');
    if (t) setTimeout(function () { checkForUpdate(true); }, 1200);
  }, true);

})();
