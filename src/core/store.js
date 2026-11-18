'use strict';
/**
 * Local persistence: app catalog + settings
 * Data directory: %APPDATA%\apkstart (see STORE_BUILD explanation below for MSIX/Store edition)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
 * Is this a Microsoft Store (MSIX / APPX) packaged build?
 *
 * Full-trust MSIX apps redirect writes under `%APPDATA%` / `%LOCALAPPDATA%`
 * to `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`,
 * but environment variables and APIs still return the pre-redirected real paths.
 * This leads to two categories of issues:
 *   1. emulator/adb/qemu spawned from %APPDATA%\apkstart without package identity
 *      will see "file not found" when looking for real paths;
 *   2. User clicking "Open Data Directory" sees an empty directory.
 * Therefore, Store builds place data directories outside AppData (%USERPROFILE%\ApkStart),
 * completely bypassing virtualization so parent and child processes access the same physical files.
 *
 * process.windowsStore is injected by Electron in MSIX/APPX environments (undefined in regular node).
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'ApkStart', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
   * Driver (compatibility patch) extensions: user-authored JSON patches in drivers/ under data dir.
   * Only stores user-disabled IDs here -- all enabled by default; can be disabled with one click without deleting files.
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // Only one runtime: built-in runtime (builtin). Field kept for merging legacy settings.json;
    // forced back to 'builtin' during settings read (see getSettings migration).
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = automatically decided by doctor based on machine RAM
    cores: 0,                // 0 = automatic
    autoMemory: true,        // Zero-config: automatically derive RAM/cores/disk/rendering parameters
    idleShutdownMinutes: 15,
    startVisible: true,
    // Windowed mode required: SurfaceFlinger does not emit VSYNC in headless mode;
    // emulator with window delivers native 60fps + native mouse/keyboard, ApkStart frames it as an app window.
    headless: false,
    gpuMode: 'auto',         // auto = select backend based on emulator version and fallback progressively
    // Last crash-on-start rendering backend (format: `<emulator_version>|<gpu>`); auto mode moves it to last
    // to avoid waiting 20s before falling back to software rendering on every launch. Invalidated on runtime update.
    badGpu: '',
    forceTcg: false,         // Kept for advanced troubleshooting; normal flow automatically rolled back by doctor
    audio: true,             // Android app audio (notifications/video). Disable to save slight CPU
    // ---- Lightweight container (all enabled by default to save resources, toggleable by user) ----
    liteMode: true,          // Restrict vCPU quota to prevent qemu from pegging physical cores and slowing Windows
    // Strategy preset: save / balanced / smooth (video/games prioritized).
    // Single option exposed in UI, translated to liteMode / priorityMode / renderSize upon save,
    // with fine-grained switches preserved at the bottom for advanced users.
    resourceMode: 'balanced',
    // Data partition capacity (GB): apps, game caches, and update packages are installed here.
    // 0 = auto (6/8GB based on free disk space). Expanding it performs an in-place expansion on next start without data loss.
    dataPartitionGB: 0,
    // Rendering resolution: lower resolution is smoother and saves battery; auto = 720x1280 or 540x960 based on accel
    renderSize: 'auto',
    // Network acceleration: specify public DNS for emulator. Android default 10.0.2.3 routes through host DNS,
    // which can add hundreds of ms latency on VPN / corporate networks / certain ISPs.
    fastDns: true,
    // System locale: injected via emulator -prop at startup (guest setprop is blocked by SELinux).
    // Defaults to zh-CN; set to en-US or off to return to stock image English.
    locale: 'zh-CN',
    // Chinese IME: bundled AOSP Google Pinyin IME, silently installed and enabled at startup.
    // System image only includes LatinIME (English keyboard); without this Chinese input is unavailable.
    chineseIme: true,
    chineseImeDefault: true,
    // Snapshot: quickboot RAM snapshot enables secondary boots in seconds at the cost of ~2-3GB ram.bin.
    // Can be disabled under disk pressure (only affects boot speed, not app data).
    keepSnapshot: true,
    // Log file limit (KB): rolls over once exceeded to prevent filling disk over long-term use
    logLimitKB: 2048,
    // Mouse key mappings: left click natively mapped by emulator to confirm/tap.
    // Right click back and smooth wheel require low-level hooks, only installed when app window is focused.
    mouseRightBack: true,    // Right click = Android Back (intercepts Qt default "right click as tap" misclicks)
    mouseWheelMode: 'smooth', // smooth = throttle and inject swipe | native = Qt native | off = unhandled
    mouseSideButtons: false, // Side buttons Back/Forward: disabled by default
    deepTrim: false,         // Deep trim background system packages (Play Store / setup wizard), off by default
    // balanced = yield foreground | performance = qemu Normal | game = qemu High + low latency input
    priorityMode: 'balanced',
    // Prewarm: boots Android environment in background after ApkStart starts so first app launch is instant.
    // Costs ~1GB resident RAM (same tradeoff as WSA), can be turned off anytime.
    prewarm: true,
    // Multi-window: allows opening multiple apps concurrently with independent windows. Off by default,
    // preserving single-window behavior; when enabled, uses tombstoning to recycle background apps.
    multiWindow: false,
    // Number of recent background apps kept from tombstoning in multi-window mode.
    // 0 = maximum memory savings (foreground only), default 1.
    keepBackground: 1,
    // Keymapping (keyboard -> touchscreen): enabled by default, user-configurable in settings
    keymapEnabled: true,
    // Per-app keymap table: { "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // Empty = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // Manual QEMU package URL override
    isoUrl: '',              // Manual system image URL override
    isoPath: '',             // System image (ISO) path
    diskPath: '',            // Virtual disk for installed system
    diskSizeGB: 24,
    headless: false,         // Hide VM window (debug only)
    installMode: 'guided',   // guided (guided manual install) | auto (experimental auto install)
    emulatorUrl: '',         // Manual emulator package URL (empty = auto-resolved from SDK index)
    sysimgUrl: '',           // Manual system image package URL
    compatImage: false,      // ARM compatibility mode: uses Google Play image (native bridge for ARM-only apps)
    deployFailedAt: 0,       // Timestamp of last failed auto-deploy (0 = no failure). Prevents retry within 30 min
    // Lightweight runtime bundle: downloaded from GitHub Release by default,
    // falls back to dl.google.com component downloads.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub accelerator mirror prefix (optional, e.g. https://ghfast.top/).
    // Empty = direct connection.
    mirrorPrefix: '',
    // Download concurrency: number of connections for chunked download. Default 8, adjustable to 16.
    downloadConnections: 8,
    // Source preference: auto = benchmark GitHub and Gitee with 128KB test, use fastest; or force single source.
    sourcePreference: 'auto',
    // Automatically try public GitHub acceleration mirrors (ghfast / gh-proxy).
    autoMirror: true,
    // Gitee releases API requires access_token; empty uses GitHub + mirror.
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Start menu shortcut = allows Windows Search to discover apps
  shortcutDir: '',           // Empty = Desktop
  freeform: false,           // Shared single runtime window, no Android freeform mini-windows
  hideAfterLaunch: false,    // Main process must remain resident to keep Android runtime alive
  notifyOnInstall: true,
  autoStart: true,           // Auto-start on boot, enabled by default
  autoDeploy: true,          // Auto-completes all deployment steps on first run
  // Welcome card: lastDate records last auto-display date; disabled = user checked "Do not show again".
  welcome: { lastDate: '', disabled: false },
  /**
   * Automatic diagnostics: periodically inspects machine health and pushes issue list to UI.
   * auto = whether to run periodically; intervalMin = interval (minutes);
   * notify = show notification on new critical issues.
   */
  debug: { auto: true, intervalMin: 10, notify: true },
  display: {
    mode: 'window',          // window (portrait window, resizable) | fullscreen (auto-fit screen)
    portrait: '900x1600',    // Portrait resolution for windowed mode
    density: 0,              // 0 = auto-derived from resolution
    rememberBounds: true,    // Remember window position and size for each app
    autoFullscreenOnLaunch: false,
    // Landscape = switch AVD physical panel to 1280x720 and restart.
    // Persisted here so ApkStart boots in this orientation on next restart.
    landscape: false,
    // Screen orientation policy:
    //   auto      = automatically switch physical panel according to app manifest (recommended)
    //   landscape = force landscape panel
    //   portrait  = force portrait panel
    // In auto mode, landscape field degrades to recording actual current panel orientation.
    orientationMode: 'auto',
    // Tablet layout: override guest logical density to 190dpi (720 width -> sw606dp >= 600dp, crossing tablet breakpoint).
    tabletMode: true,
    // Window hosting mode: false = emulator native window (Qt direct rendering);
    // true = embed Android surface into ApkStart shell window via SetParent.
    // Default native window since 0.6.0.
    windowEmbed: false,
    // 镜像内 (In-image) auto-rotate toggle: enabled by default (writes guest accelerometer_rotation=1).
    // Panel orientation is still locked by wm user-rotation lock + set-ignore-orientation-request,
    // so it will not be skewed by sensors. Disabling it restores legacy strict lock behavior.
    autoRotate: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Strip potential UTF-8 BOM. When present, JSON.parse throws directly and config falls back to default.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resource policy -> specific flags.
 *   save     : 2 vCPU + low priority + 540x960, for older laptops / idling;
 *   balanced : vCPU = half of physical cores (2-4) + yield foreground + 720x1280;
 *   smooth   : unrestricted vCPU + foreground priority + 720x1280, video/game priority.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
  // Store (MSIX) packaged build flag: disables auto-updater and admin driver install
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
     * Legacy third-party runtime migration: mode=mumu / fydeos / attach cleaned up and normalized to builtin.
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
    // Legacy default was headless; migrate unconditionally to windowed mode
    s.engine.headless = false;
    // Legacy shell exit killed Android runtime; keep alive
    s.hideAfterLaunch = false;
    // Legacy used Android freeform mini-windows; now full window
    s.freeform = false;

    /**
     * Final verdict on window hosting: **default must be emulator native window**.
     * Corrects legacy windowEmbed to false unless user explicitly selected it in settings page.
     */
    try {
      const raw = readJson(SETTINGS_FILE, {});
      const d = (raw && raw.display) || {};
      if (d.windowEmbedChosen !== true && d.windowEmbed !== false) {
        s.display.windowEmbed = false;
        s.display.windowEmbedMigrated2 = true;
        // Write back immediately to ensure config file also reverts to native
        writeJson(SETTINGS_FILE, {
          ...raw,
          display: { ...d, windowEmbed: false, windowEmbedMigrated2: true },
        });
      }
    } catch (_) { /* Migration failure does not block boot */ }

    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // Translate resourceMode preset to 3 concrete flags
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
    // Defense-in-depth: lock package name strictly inside ICON_DIR
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
