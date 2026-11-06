console.log('Electron API available:', !!window.electronAPI);

if (window.electronAPI && window.electronAPI.isElectron()) {
  console.log('Running in Electron desktop mode');

  // Sync auto-update setting from launcher settings to Electron
  async function syncAutoUpdateSetting() {
    if (!window._settings) return;
    const enabled = _settings.autoUpdate !== false;
    await window.electronAPI.setAutoUpdateSetting(enabled);
  }

  // Check setting on load and when it changes
  setTimeout(syncAutoUpdateSetting, 2000);

  // ===== Persistent update progress bar (bottom-right) =====
  // We create it once and keep it hidden until download-progress fires.
  // This way the user always sees progress in the same place.
  function ensureUpdateProgressUI() {
    let el = document.getElementById('update-progress-ui');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'update-progress-ui';
    el.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 340px;
      background: rgba(10, 10, 25, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(0, 214, 143, 0.4);
      border-radius: 12px;
      padding: 14px 16px;
      z-index: 99999;
      box-shadow: 0 8px 32px rgba(0, 214, 143, 0.25), 0 0 0 1px rgba(255,255,255,0.04) inset;
      font-family: 'Vazirmatn', system-ui, sans-serif;
      color: #e6f5ff;
      display: none;
      direction: rtl;
    `;

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <div style="width:14px;height:14px;border:2px solid #00d68f;border-top-color:transparent;border-radius:50%;animation:upd-spin 0.8s linear infinite"></div>
        <div style="font-weight:600;font-size:13px;color:#08d9d6">در حال دانلود آپدیت...</div>
        <div id="update-progress-percent" style="margin-right:auto;font-weight:700;font-size:14px;color:#00d68f;font-variant-numeric:tabular-nums">0%</div>
      </div>
      <div style="width:100%;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden">
        <div id="update-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#00d68f,#08d9d6);border-radius:4px;transition:width 0.2s ease;box-shadow:0 0 12px rgba(0,214,143,0.6)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:rgba(230,245,255,0.6);font-variant-numeric:tabular-nums">
        <span id="update-progress-size">0 MB / 0 MB</span>
        <span id="update-progress-speed">0 KB/s</span>
      </div>
    `;

    document.body.appendChild(el);

    // Inject spinner keyframes (only once)
    if (!document.getElementById('update-progress-style')) {
      const style = document.createElement('style');
      style.id = 'update-progress-style';
      style.textContent = `
        @keyframes upd-spin { to { transform: rotate(360deg); } }
      `;
      document.head.appendChild(style);
    }

    return el;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 0) return '0 B/s';
    return formatBytes(bytesPerSec) + '/s';
  }

  // ===== Update events =====

  // Helper: strip HTML tags from release notes (GitHub sends HTML)
  function stripHtml(html) {
    if (!html) return '';
    // Convert <br>, </p>, </li>, </h*> to newlines first
    let text = String(html)
      .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '') // strip remaining tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  // Helper: get first line of release notes (or first ~80 chars)
  function getReleaseSummary(notes) {
    const text = stripHtml(notes);
    if (!text) return '';
    // Take first non-empty line
    const firstLine = text.split('\n').find(l => l.trim().length > 0) || '';
    if (firstLine.length <= 120) return firstLine;
    return firstLine.slice(0, 117) + '...';
  }

  // 1. New update detected — show version + release notes summary
  window.electronAPI.onUpdateAvailable((info) => {
    const summary = getReleaseSummary(info.releaseNotes);
    const msg = summary
      ? 'نسخه ' + info.version + ' — ' + summary
      : 'نسخه ' + info.version + ' - در حال شروع دانلود...';
    showUpdateToast('آپدیت جدید موجود است!', msg, false, false);
  });

  // 2. Download progress (fires many times)
  window.electronAPI.onUpdateProgress((p) => {
    const ui = ensureUpdateProgressUI();
    ui.style.display = 'block';

    const percentEl = ui.querySelector('#update-progress-percent');
    const barEl = ui.querySelector('#update-progress-bar');
    const sizeEl = ui.querySelector('#update-progress-size');
    const speedEl = ui.querySelector('#update-progress-speed');

    if (percentEl) percentEl.textContent = p.percent + '%';
    if (barEl) barEl.style.width = p.percent + '%';
    if (sizeEl) sizeEl.textContent = formatBytes(p.transferred) + ' / ' + formatBytes(p.total);
    if (speedEl) speedEl.textContent = formatSpeed(p.bytesPerSecond);
  });

  // 3. Download complete — hide progress bar, show install button
  window.electronAPI.onUpdateDownloaded(() => {
    const ui = document.getElementById('update-progress-ui');
    if (ui) ui.style.display = 'none';

    showUpdateToast('آپدیت دانلود شد!', 'برای نصب دکمه زیر را بزنید', false, true);
  });

  // 4. Error
  window.electronAPI.onUpdateError((info) => {
    const ui = document.getElementById('update-progress-ui');
    if (ui) ui.style.display = 'none';

    showUpdateToast('خطا در آپدیت', info.message || 'خطای ناشناخته', false, false);
  });

  // Override saveSettings to sync auto-update
  const _origSaveSettings = window.saveSettings;
  if (_origSaveSettings) {
    window.saveSettings = async function(patch) {
      const result = await _origSaveSettings(patch);
      if (patch.autoUpdate !== undefined) {
        await window.electronAPI.setAutoUpdateSetting(patch.autoUpdate);
      }
      return result;
    };
  }
}

function showUpdateToast(title, msg, hasDownload, hasInstall) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast success';
  el.style.minWidth = '320px';
  el.style.maxWidth = '380px';
  el.innerHTML = `
    <div style="flex:1">
      <div style="font-weight:600;font-size:13px;color:#08d9d6;display:flex;align-items:center;gap:6px">🔄 ${title}</div>
      <div style="font-size:11.5px;color:var(--text-muted);margin-top:6px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${msg}</div>
      ${hasInstall ? '<button onclick="window.electronAPI.installUpdate()" style="margin-top:10px;padding:6px 16px;background:#00d68f;color:#000;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">نصب و ری‌استارت</button>' : ''}
    </div>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .4s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, 12000);
}
