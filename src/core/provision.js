'use strict';
/**
 * Runtime self-bootstrapping (Provisioning)
 *
 * ApkStart depends on no third-party emulator: adb, QEMU, and system images are all downloaded / verified / managed by itself.
 * All runtime files are placed under %APPDATA%\apkstart\runtime, so they are writable at any install location.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile, resolveZipEntry } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Google official SDK index: the real addresses of the emulator and system images are dynamically resolved from here, version numbers are not hard-coded
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Fallback: known versions used directly when the index is unavailable
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // ARM compatibility image (Google Play edition, with built-in native bridge)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): only used when the user already supplies their own ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // Lightweight edition (without runtime) gets the "runtime full package" from here: this project's own GitHub Release.
  // Previously the lightweight edition had to download the emulator / system image separately from dl.google.com, and the domestic network often
  // stuck at tens of KB/s or returned 404 directly; after switching to a full package + this project's GitHub, the download source and the update source
  // are the same place, and when something goes wrong it only needs to be fixed in one place.
  ghReleaseApi: 'https://api.github.com/repos/farmanullah1/APK-START-English/releases',
  ghReleasePage: 'https://github.com/farmanullah1/apkstart/releases',
  // Same-content Gitee mirror: domestic direct connections to api.github.com often take tens of seconds to respond, Gitee is usually a few hundred milliseconds.
  // Ask both sides once; whichever gives back the "highest version with runtime full package" first is used.
  giteeReleaseApi: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases',
  giteeReleasePage: 'https://gitee.com/daily-miku/apkstart/releases',
};

/**
 * The <url> inside the SDK index is a relative path, and the base directory differs for each:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * So the base directory is always taken as "the directory the index file itself is in". Previously using the bare filename as a URL threw Invalid URL.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Only a single "general base image" is kept.
 * Older versions had AOSP API30 by default plus an optional API34 Play compatibility image, which meant:
 *   - installing Chinese ARM apps always failed and users had to switch images by hand (a real usability wall);
 *   - two images of 0.6-3GB each, so the runtime directory easily reached tens of GB;
 *   - switching images required wipe-data, losing every installed app.
 * Now there is one Android 14 Google Play x86_64 image: x86 apps, ARM apps and GMS all run,
 * and only one read-only base layer is stored per machine (container-style sharing), downloaded once on demand.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Directory writability probe (result cached per directory).
 *
 * Why not fs.accessSync(dir, W_OK): on Windows it only looks at the read-only file attribute,
 * not ACLs, so an MSIX install directory wrongly reports "writable" and .img.xz extraction fails halfway.
 * So really write a probe file and delete it again.
 */
const _dirWritableCache = new Map();
function provisionDirWritable(dir) {
  if (_dirWritableCache.has(dir)) return _dirWritableCache.get(dir);
  let ok = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.apkstart-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _dirWritableCache.set(dir, ok);
  return ok;
}

/**
 * Integrity check after download. On failure the incomplete file is **deleted**.
 *
 * It used to throw without deleting, so tmp kept a half-finished zip forever. Next time
 * download() saw the existing file and resumed with Range - and when the server/source changed the resumed
 * bytes did not match the first half, failing again and keeping another partial file - which users see as "it downloads forever".
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label} download is incomplete (${(size / 1048576).toFixed(1)} MB); cleaned up, please retry`);
}

/**
 * On-disk cache of environment probe results.
 *
 * `emulator -version` and `emulator -accel-check` each spawn a new emulator process,
 * measured at 1-3 seconds on Windows, while both results are constant as long as "engine/drivers did not change".
 * They used to be cached in memory for 30 seconds only, so every cold boot paid again, right when
 * the user tapped an app. A fingerprint of "exe size+mtime + AEHD driver time + WHPX component"
 * is stored in %APPDATA% and invalidates automatically when hardware or software changes.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // an "unavailable" accel result is trusted for only 10 minutes: the user may have just enabled virtualization

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Single entry point for sources and images (the speed-test cache lives here too, shared by several components) */
  get sources() {
    return this._sources;
  }

  /** Cache fingerprint: changing either the engine files or the acceleration driver changes the key */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* first run */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* a cache write failure must not break the main flow */ }
  }

  /** Called after a failed boot (acceleration/image problems): re-probe next start so a wrong conclusion is not reused */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Paths ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // Is the runtime directory writable?
    // The Store (MSIX) build keeps emulator / platform-tools / system-images inside the package
    // (an MSIX install directory), which is read-only:
    //   - extracting .img.xz in place, creating _tmp or qemu/ all fail there;
    //   - but running executables from the package is allowed (and only then does the package identity
    //     make the %APPDATA% virtualization view match the parent process).
    // So "runnable" and "writable" must be separated: executable paths stay inside the package, while writable data
    // (image extraction directory / AVD / temp) all moves to the user data directory.
    const rootWritable = provisionDirWritable(root);
    // The AVD (user data, installed apps, quickboot snapshot) must live somewhere writable that is never cleaned up.
    // A single-file build extracts its runtime into a temp directory, so putting the AVD there loses apps on every exit.
    // Whenever the runtime directory is not under %APPDATA%, pin the AVD to the user data directory.
    // Also: "Android data directory" can be set separately in settings - that is what really fills the disk
    // (6-24GB data partition + 2-3GB snapshot), so moving only the runtime leaves C: full anyway.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Where system images live: **the runtime directory wins**.
    // The order used to be "user data directory first", and the result was: the user moves the runtime directory to D: to save C: space,
    // the 1.4GB bundle unpacks to D:, and then materializeImages expands the 3.3GB system.img back into
    // the roaming AppData apkstart system-images directory, filling C: anyway, with two copies of the same image
    // (measured: 1.2GB + 3.3GB coexisting).
    // Now: if the runtime directory already has system-images (the unpacked bundle) it is used;
    // otherwise fall back to the user data directory (older versions and single-file builds use that layout).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Three cases:
    //  1) the runtime directory already has images (unpacked bundle) -> use them;
    //  2) an older user / single-file build has images in the user data directory -> use those;
    //  3) a fresh install (neither) -> land in the runtime directory, because the user data directory may be a
    //     redirected temp directory (CI assembling a runtime does this; writing there fails validation).
    //  4) the runtime directory is read-only (inside the MSIX package) -> must use the user data directory, or .img.xz cannot be extracted.
    //
    // Also (0.6.0 fix): prefer the location that already holds expanded images. Before, any system-images entry
    // in the runtime directory was chosen (even just .img.xz), so a perfectly usable 3.1GB system.img in the user
    // data directory was ignored and the archive was decompressed every time - and once the archive is truncated (as in 0.5.9)
    // extraction always fails, showing up as "after installing, no app opens".
    // Now: use whichever is directly usable; only when neither is complete choose where to download/extract.
    const expandedImgDir = (base) => path.join(base, `android-${sysApi}`, sysTag, sysAbi, 'system.img');
    const hasExpanded = (base) => {
      try { return fs.statSync(expandedImgDir(base)).size > 100 * 1024 * 1024; } catch (_) { return false; }
    };
    let sysRoot;
    if (!rootWritable) sysRoot = dataImg;
    else if (hasExpanded(rootImg)) sysRoot = rootImg;
    else if (hasExpanded(dataImg)) sysRoot = dataImg;
    else if (fs.existsSync(rootImg)) sysRoot = rootImg;
    else if (fs.existsSync(dataImg)) sysRoot = dataImg;
    else sysRoot = rootImg;
    return {
      root,
      // Only put the temp/auxiliary directories under root when it is writable; otherwise use the data directory
      writeRoot: rootWritable ? root : path.join(store.DATA_DIR, 'runtime'),
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // emulator runtime (official Google): root doubles as ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'aehd'),
      imagesDir: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(rootWritable ? root : path.join(store.DATA_DIR, 'runtime'), '_tmp'),
      rootWritable,
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      // Tolerate each one: in the Store (MSIX) build p.root lives in a read-only package and cannot be created,
      // which is fine because every writable directory has moved to the user data directory (see paths()). One failure
      // must not make the whole startup path throw.
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* skip when read-only or in use */ }
    }
    return p;
  }

  /**
   * Disk guard: before downloading / extracting a large component, make sure the target disk has room.
   * Otherwise a download fills the system disk halfway, or extraction fails outright (leaving partial files).
   * 1GB of headroom is reserved: snapshots and the user data partition keep growing after extraction.
   * @param {string} component component name (determines the space estimate)
   * @param {string} targetDir write directory (used to locate the disk)
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Full runtime bundle: a 1.5GB archive plus ~3.3GB of images once extracted, both at peak
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // extra 1GB reserved (snapshot / data partition / extraction temp files)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Not enough space on the target disk: this component needs about ${need + buf} MB, but "${dir}" has only ${free} MB left.\n`
        + 'Suggestion: move the "Runtime data directory" to a drive with more room (Settings -> System Integration -> Runtime data directory -> Browse),'
        + ' or free up disk space / uninstall unused apps and retry.',
      );
    }
    return free;
  }

  // ---------------- Environment checks ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'not a Windows platform' }; return this._hypervisor; }
    // Only millisecond-level file checks here. The authoritative "is WHPX usable" answer comes from emulator -accel-check,
    // avoiding a PowerShell spawn (1-2 seconds on a cold start) that would slow every status poll.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // replaced with the real value by emulatorAccel()
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Virtual Machine Platform component present (availability is detected by the runtime engine)'
        : 'Windows Hypervisor Platform component not found: enable "Virtual Machine Platform" in "Turn Windows features on or off" and reboot',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // 30s cache so status polling does not keep spawning external processes
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // default winget install location
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Validate the ISO9660 primary volume descriptor ("CD001") so an error page or partial file is not taken as an image */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'not downloaded' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // A user-imported raw / already-installed disk image has no ISO boot area, so accept it by size
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `The file is only ${(size / 1048576).toFixed(1)}MB; the download did not finish`
        : 'The file is not a valid ISO9660 image (an error page may have been downloaded, or the file is corrupt)'
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // The full build (bundled runtime) ships one API 34 Google Play image, which is both the main and the compatibility image;
    // it no longer depends on a compatImage switch, avoiding "the image is there but deployment is judged missing because the switch was off"
    const playImage = this.playImageInfo();
    const compatReady = playImage.ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;
    // The package ships .xz/.gz: the image is "there", just not expanded yet. Callers use this to decide
    // "should we download" - with an image present, never download, only expand.
    const needsExtract = !!(sysimg.compressed || (compatReady && playImage.compressed));

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'not installed' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? playImage.size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        compressed: needsExtract,
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api} (${(sysimg.size / 1073741824).toFixed(2)} GB${sysimg.compressed ? ', compressed in the package, expanded on first boot' : ''})`
          : (compatReady
            ? `Android ${PLAY_SYSIMG.api} (${playImage.compressed ? 'compressed in the package, expanded on first boot' : 'ARM compatible image'})`
            : (sysimg.note || 'not downloaded')),
      },
      // true = the image is already local (in the package) and only needs one expansion; callers **must not** download anything
      needsExtract,
      playImage,
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'not downloaded',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'not created yet',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Downloading Android platform-tools (~8MB)...', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading adb... ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'adb package');

    onProgress({ stage: 'extract', message: 'Extracting adb...', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb does not run after extraction; check whether antivirus blocked it');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} ready`, percent: 100 });
    return v;
  }

  /**
   * Extract with the bundled ZIP parser (no dependency on a system unzip tool)
   * Large entries (GB-scale system.img) are streamed while small ones are read whole, avoiding Node's single-Buffer limit.
   */
  // ---------------- This project's GitHub runtime bundle (lightweight build) ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Resolve the download address of the "runtime bundle".
   * Asset naming: ApkStart-runtime-<tag>.zip (produced by .github/workflows/release.yml,
   * containing exactly build/runtime: emulator/ + platform-tools/ + aehd/ + system-images/).
   * Both GitHub and Gitee are scanned and the highest version wins; when none is found it throws so the caller
   * can fall back to Google's per-component downloads.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const pref = String(store.getSettings().runtime.sourcePreference || 'auto');
    const apis = [];
    if (pref !== 'gitee') apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });
    if (pref !== 'github') apis.push({ api: SOURCES.giteeReleaseApi, page: SOURCES.giteeReleasePage, name: 'Gitee' });

    // Query both sides concurrently; a failure on one does not affect the other
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const hit = (rel.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x.name || ''));
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} unreachable`).join(', ');
      throw new Error(`Neither source has the runtime bundle${errs ? ` (${errs})` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * Lightweight one-click deploy: download this project's runtime bundle from GitHub and extract it.
   * Images inside the bundle are .xz and are expanded on the first boot by materializeImages() (once).
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Progress first: resolving the version and speed-testing have no byte counts, and without a hint users think it hung.
    onProgress({ stage: 'download', message: 'Fetching runtime version information...', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Picking the fastest source (${pack.from || 'GitHub'} - ${pack.tag})...`, percent: 1 });
    // Candidates = origin + mirror prefixes. Measure 128KB from each first instead of guessing:
    // "guessing by domain" is often wrong - the same URL does 30KB/s in the morning and 5MB/s at night.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Downloading the runtime (~1.5 GB, one time only, ${conn} threads)...`, percent: 2 });
    // Chunked parallelism (8 threads) is much faster than a single stream: GitHub throttles single connections,
    // measured at one or two hundred KB/s, while 8 threads saturate the local link. A drop falls back to a single resumed stream.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` - about ${Math.ceil(pr.eta / 60)} min left` : '';
        onProgress({
          stage: 'download',
          message: `Downloading runtime ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'runtime bundle');

    onProgress({ stage: 'extract', message: 'Extracting the runtime (~1 minute)...', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Extracting ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* a failed marker write does not affect use */ }

    // system.img inside the bundle is .xz compressed (same as the full installer). Expand it now,
    // otherwise the next checkEnv() thinks "no system image installed" and downloads another 1.4 GB from Google.
    // A failed expansion must fail the deployment with the reason: the old code caught it into 0, so users saw progress
    // stall at 99% and then jump back to "falling back to the official source", downloading another 1.4GB.
    onProgress({ stage: 'extract', message: 'Expanding the system image (~1 minute, one time only)...', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Runtime ready', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Download address candidates: direct first, then mirror prefixes.
   * Everything goes through Sources, so automatic mirrors (ghfast / gh-proxy) and user prefixes
   * are maintained in one place and share the same speed-test cache as the multi-threaded downloader.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Large archives (emulator / system images) use the file variant: a 1.5GB zip is never read into memory,
    // so low-memory machines extract reliably; small archives keep the in-memory variant for speed.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        // zip-slip guard (issue #2 P0-4): the runtime bundle comes from the network, so entry names are untrusted.
        // Both directory and file entries must be valid relative paths inside destDir.
        const target = resolveZipEntry(destDir, name);
        if (!target) {
          if (opts.onUnsafeEntry) opts.onUnsafeEntry(name);
          continue;
        }
        if (name.endsWith('/')) {
          fs.mkdirSync(target, { recursive: true });
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (official Google runtime) ----------------

  /** Fetch a piece of XML text (with a size cap; index files are ~400KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    // issue #2 P1-1: when the limit is exceeded destroy() emits no 'end' and the error is not caught, so
    // this Promise never settles and the deploy wizard hangs on "parsing index" forever.
    // A one-shot settle latch plus a hard timeout makes every path settle exactly once.
    return new Promise((resolve) => {
      let d = '';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(() => { try { res.destroy(); } catch (_) {} finish(); }, 30000);
      res.on('data', (c) => {
        if (done) return;
        d += c;
        if (d.length > limit) {
          d = '';                       // content over the cap is unusable; do not treat a partial index as complete
          try { res.destroy(); } catch (_) {}
          finish();
        }
      });
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
  }

  /** Dynamically resolve the latest Windows emulator package URL from the SDK index */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* fall back to the defaults */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Resolve the default AOSP system image URL from the sys-img index */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* try the next index */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Probed by a previous session and the engine files are unchanged: use the on-disk result (saving a 1s+ process spawn)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * On first launch, expand the compressed images shipped in the package into the user directory (once).
   * In single-file builds system.img is .gz (3.1GB -> ~580MB), and the emulator cannot use it unexpanded.
   * Expand into %APPDATA%, not the package: a portable build's runtime directory is a fresh temp directory on every launch,
   * so storing it there means re-extracting on every boot.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // The expansion target must follow the same rules as paths().sysImgRoot, or you get
    // "bundle unpacked to D: while images expand back into C: APPDATA", using the space twice (measured 1.2GB + 3.3GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // files other than the compressed images (kernel-ranchu / ramdisk / uncompressed .img) must land in the expansion directory too
    const found = new Map(); // dest -> job (prefer .xz when both .xz and .gz exist)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Supports .img.xz (LZMA2, ~25% smaller than .gz) and the older .img.gz
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Copy the non-image files first (the emulator locates and boots through kernel-ranchu etc.; without it reports "system image missing")
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // expanding in place, nothing to copy
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Copying image components failed: ${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // "Already expanded" cannot be judged by 32MB: older builds had no .part, so an interruption could leave
      // hundreds of MB of a partial image that passed the threshold and then crashed on a corrupt image at boot.
      // A real image is always larger than its archive, so "smaller than the archive" always means "not finished".
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Extract to .part and rename on success: an interrupted extraction (app closed / power loss / full disk)
      // never leaves a half-written system.img that looks complete; otherwise the next boot skips expansion and
      // dies on a corrupt image, forcing users to wipe data.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`First launch: expanding system image ${path.basename(j.dest)} (~1 minute, one time only)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // LZMA2: must load the native binding's index.js directly.
            // The package entry points main.js / xz.js internally require('stream-polyfill.mjs'),
            // which Electron's Node 20 cannot do for ESM and throws; and exports does not allow
            // '@napi-rs/lzma/index.js' either, so resolve the directory with require.resolve and load by file path.
            const path0 = require('path');
            let lzmaDir;
            try {
              lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            } catch (_) {
              // Reached when packaging missed node_modules/@napi-rs. It used to throw
              // "Cannot find module '@napi-rs/lzma'" plus a long require stack, which users cannot parse
              // and only reads as "after installing, no app opens".
              // Say plainly that the package is incomplete rather than that their PC is broken.
              const e2 = new Error('The installation package is incomplete: the @napi-rs/lzma extractor is missing, so the system image cannot be expanded. Download the full build again, or use the Store version.');
              e2.code = 'LZMA_MISSING';
              throw e2;
            }
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // Do not swallow this silently: the caller (one-click deploy / boot) must know the image did not expand,
        // otherwise it downloads another 1.4GB from the official source, or the boot simply fails.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Image expansion failed: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`System image expansion failed (${failures.join('; ')})`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /**
   * Is the system image complete?
   *
   * There are two "complete" forms:
   *   1. an expanded `system.img` (local cache / a runtime directory chosen in settings);
   *   2. **`system.img.xz` / `.gz` shipped in the package** - the Store (MSIX) build and the full installer
   *      both ship this way, expanded in place by materializeImages() on the first boot.
   *
   * Form 2 must count as ok, or checkEnv().ready is false and autoDeploy assumes "the user has no image yet",
   * pulling 1.5GB from the network - exactly the "it shipped with an image but still downloads" root cause.
   * The compressed flag in the result means "one more expansion is needed".
   */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Look in the default location (API34 Play) first, then accept any image.
    // Single-file builds may ship only a smaller AOSP image, and hardcoding API34 would report "not downloaded"
    // even though the image is in the package, forcing users to download a new one.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    let packed = null;   // only an archive found: counts as "present" but needs expansion
    for (const dir of candidates) {
      const kernel = path.join(dir, 'kernel-ranchu');
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      // An expanded image wins
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi, compressed: false };
      }
      // Then accept an archive (the normal form for packaged images)
      if (fs.existsSync(kernel)) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            if (!packed) packed = { ok: true, dir, size: cs, api, tag, abi, compressed: true, file: name };
            break;
          }
        }
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'image incomplete' : 'system.img missing' };
      }
    }
    // With an archive present, use it: expansion is needed but the image is **not missing**, so never download
    if (packed) return packed;
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'not downloaded' };
  }

  /**
   * Hardware acceleration state.
   * On Windows the emulator supports two accelerators: WHPX (a Windows feature, needs a reboot) and AEHD (Google's own driver, works right after install).
   */
  async emulatorAccel() {
    // The status is polled every few seconds and -accel-check spawns an emulator process, so caching is required
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'emulator not installed' };

    // On-disk cache: no longer spawn an emulator process for this on a cold start.
    // An "unavailable" result is trusted for only 10 minutes - the user may have just enabled virtualization or installed AEHD.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'WHPX hardware acceleration enabled' : 'AEHD hardware acceleration enabled' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Some trimmed runtime bundles omit emulator-check.exe, so -accel-check cannot give a verdict.
      // In that case an installed AEHD driver is treated as "available": the emulator mounts the driver itself,
      // avoiding a false "no acceleration" verdict that forces -accel off (software emulation crashes outright on some machines).
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration enabled (emulator-check missing, judged by driver)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'AEHD hardware acceleration enabled' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'WHPX hardware acceleration enabled' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Hardware acceleration not enabled: falling back to software emulation (works but is slow). Install the AEHD driver or enable "Virtual Machine Platform"',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Download and install the emulator (the zip's top level is emulator/, extracted straight into the SDK root) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Downloading the runtime engine (~440MB, from the official Google source)...', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading runtime engine ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'runtime engine');

    onProgress({ stage: 'extract', message: 'Extracting the runtime engine...', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // The SDK root must also contain platform-tools, otherwise the emulator refuses to start
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('The emulator does not run after extraction; check whether antivirus blocked it');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Runtime engine ${v.version} ready`, percent: 100 });
    return v;
  }

  /** The emulator requires a platform-tools directory under the SDK root, otherwise it fails with FATAL */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Download a single general base image (Android 14 Play x86_64); no more "standard/compatible" pair */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** Is the ARM compatibility image (Google Play edition) in place? */
  playImageInfo() {
    const p = this.paths();
    const rel = `android-${PLAY_SYSIMG.api}/${PLAY_SYSIMG.tag}/${PLAY_SYSIMG.abi}`;
    // Check both places: the expansion target (writable data directory) and the original in-package location.
    // Store/full installers ship system.img.xz, expanded on the first boot - this must
    // accept it, or installSystemImage / autoDeploy download another copy.
    const dirs = [path.join(p.sysImgRoot, rel), path.join(this.root, 'system-images', rel)];
    let packed = null;
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(dir, 'kernel-ranchu'))) continue;
      const size = fileSize(path.join(dir, 'system.img'));
      if (size > MIN_SIZE.sysimg) {
        return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: false };
      }
      if (!packed) {
        for (const name of ['system.img.xz', 'system.img.gz']) {
          const cs = fileSize(path.join(dir, name));
          if (cs > MIN_SIZE.sysimg) {
            packed = { ok: true, dir, size: cs, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag, compressed: true, file: name };
            break;
          }
        }
      }
    }
    if (packed) return packed;
    const size = fileSize(path.join(dirs[0], 'system.img'));
    return { ok: false, dir: dirs[0], size, note: size ? 'image incomplete' : 'not downloaded' };
  }

  /** Resolve the Google Play image URL (<url> is relative to the index file's directory) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* fall back to the defaults */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Download and install the ARM compatibility image (Google Play edition, ~1.5GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Downloading the ARM compatibility image (Android 14, ~1.5GB)...', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading compatibility image ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1048576).toFixed(1)} MB/s）` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'compatibility image');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Extracting the compatibility image (3GB, takes ten-odd seconds)...', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Extracting compatibility image ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('The compatibility image failed validation after extraction');
    // The old (API 30) compatibility image is no longer used; remove it after a successful install to free space
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'ARM compatibility image ready; restart the runtime to apply', percent: 100 });
    return info;
  }

  /** Download the AEHD driver (small file); installing it needs admin rights, so the guided flow handles that */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Downloading the AEHD driver...', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('The AEHD driver package did not extract correctly');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'AEHD driver ready; installing it needs administrator rights', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Fetch the newest installer filename from the official directory (no hardcoded version) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* fall back to the backup source */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Finding the latest QEMU version...', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Downloading QEMU (~200MB)...`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading QEMU... ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'QEMU installer');

    onProgress({ stage: 'install', message: 'Installing QEMU (silent)...', percent: 96 });
    // qemu-w64-setup is an NSIS installer: /S for silent, /D for the directory (must be last and unquoted)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('qemu-system-x86_64.exe was not found after installing QEMU: download QEMU manually and extract it to engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} ready`, percent: 100 });
    return v;
  }

  // ---------------- System images ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Downloading Android-x86 9.0-r2 (~900MB, 8 chunked threads)...', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Downloading system image... ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? `（${(pr.speed / 1024).toFixed(0)} KB/s）` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`System image unusable: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? ' - click again to resume the download' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `System image ready (${(info.size / 1073741824).toFixed(2)} GB)`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Validate a user-imported image / ISO */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('The file does not exist or is empty');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'The image file is unusable');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Virtual disk ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Creating a ${sizeGB}GB virtual disk...`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img failed to create the virtual disk: ${r.stderr || r.stdout}`);
    } else {
      throw new Error('qemu-img.exe was not found; install QEMU first');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Virtual disk created', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- System image reachability precheck ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
