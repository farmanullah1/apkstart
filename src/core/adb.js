'use strict';
/**
 * ADB client wrapper.
 * Covers only what ApkStart needs: install / launch / stop / uninstall / file sync / screenshot.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { autoRotateSetting } = require('./orientation');

/**
 * The in-guest "auto-rotate" toggle value that must be written ('1' = on / '0' = off).
 * Panel orientation is NOT determined here — the `wm user-rotation lock 0` +
 * `wm set-ignore-orientation-request` calls in setOrientation / resetDisplayOverrides
 * are the authoritative source of rotation. This only keeps the system Settings
 * toggle visually "on" so apps that read the setting get what they expect.
 */
function guestAutoRotate() {
  try { return autoRotateSetting(store.getSettings()); } catch (_) { return '1'; }
}

/**
 * Logical density for tablet layout.
 * 720px ÷ (190/160) = 606dp ≥ 600dp, which crosses Android's tablet breakpoint;
 * 320dpi (image default) gives only 360dp, which triggers phone layout.
 */
const TABLET_DENSITY = 190;
function tabletDensity() {
  try {
    return (store.getSettings().display || {}).tabletMode !== false ? String(TABLET_DENSITY) : 'reset';
  } catch (_) {
    return String(TABLET_DENSITY);
  }
}

/**
 * Known adb locations on the system. **Only Android SDK and common manual install paths are listed.**
 * Third-party emulator adb binaries (MuMu / LDPlayer / BlueStacks) are intentionally excluded —
 * using their adb inherits a foreign server state (port, auth, offline jitter) that conflicts
 * with ApkStart's isolated operation. The bundled adb in the runtime directory always has
 * highest priority (see engine.adbPath).
 */
const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:/Android/platform-tools/adb.exe',
  'C:/adb/adb.exe',
];

/**
 * Maps raw pm install failure codes to user-readable error messages.
 * The original error code is appended at the end for searchability.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Installation failed: this app only provides ARM native libraries (ARM 原生库), '
      + 'and current image lacks translation layer. ApkStart will switch to compatible image and retry.',
    INSTALL_FAILED_OLDER_SDK:
      'Installation failed: the app requires a higher Android version than the current runtime (a newer system image is needed).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Installation failed: the APK has no valid signature and cannot be installed.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Installation failed: signature mismatch with the installed version — please uninstall the old version first.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Installation failed: a newer version is already installed — downgrade is not allowed.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Installation failed: not enough disk space in the runtime — please free up space and retry.',
    INSTALL_FAILED_INVALID_APK:
      'Installation failed: APK file is corrupted or incomplete (损坏/不完整) — please re-download.',
    INSTALL_FAILED_INVALID_URI: 'Installation failed: the APK path contains special characters — move the file to a path with only ASCII characters and retry.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Installation failed: an app with the same name but a different signature already exists — please uninstall it first.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Installation failed: signature mismatch with the installed version — please uninstall the old version first.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Installation failed: this app targets a very old Android API level (targetSdk too low); Android 14 blocks it by default. '
      + 'ApkStart will automatically (自动) retry with the official bypass flag.',
    INSTALL_FAILED_TEST_ONLY: 'Installation failed: this is a test-only package — ApkStart will retry with the test-package flag automatically.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Installation failed: the app depends on device-specific features (e.g. a vendor library) that are not present in this runtime.',
    INSTALL_FAILED_USER_RESTRICTION: 'Installation failed: the system is blocking installation — please restart the runtime and try again.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Installation failed: a ContentProvider conflict with an already-installed app — please uninstall the conflicting app.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Installation failed: internal system error (often caused by insufficient storage or an incomplete boot) — please restart the runtime and try again.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Installation failed: ${raw}`;
}

/** Maps post-launch crash logs to a user-readable explanation. */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'The app'} crashed on launch: ARM translation layer is incompatible with this app's signal handling.`
      + ' ApkStart will automatically switch to a compatibility image and retry.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'The app'} crashed on launch: missing native library (the app may only ship an ARM version).`
      + ' ApkStart will automatically switch to a compatible image with the ARM translation layer and retry.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'The app'} crashed immediately on launch (internal app error — may be related to the emulator environment or missing Google services).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'The app'} failed to launch: the system denied the launch request (permission or signature issue).`;
  }
  return `${pkg || 'The app'} failed to start${t ? `: ${t.slice(0, 240)}` : ' (process did not survive)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Parses the state column for a given serial from `adb devices` output.
 * Key detail: an unauthorized device reports 'device' in `get-state`, so only
 * the devices list state column can distinguish authorized / unauthorized / offline —
 * the boot probe uses this method for fast self-healing.
 */
function parseDeviceState(text, serial) {
  const lines = String(text || '').split(/\r?\n/).slice(1);
  for (const line of lines) {
    const m = /^(\S+)\s+(unauthorized|offline|recovery|sideload|no\s+permissions|device)\b/i.exec(line.trim());
    if (!m) continue;
    if (serial && m[1] !== serial) continue;
    const st = m[2].toLowerCase().replace(/\s+/g, '');
    if (st === 'device') return 'device';
    if (st === 'unauthorized' || st === 'nopermissions') return 'unauthorized';
    return st; // offline / recovery / sideload
  }
  return 'no-device';
}

/** Detects the unauthorized state from shell errors caused by an unconfirmed "Allow USB debugging" dialog. */
function isUnauthorizedError(raw) {
  return /\bunauthorized\b|no permissions|confirm.*(allow|debug)/i.test(String(raw || ''));
}

/** Extracts each APK's real path from `pm path <pkg>` output. */
function parsePmPaths(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^package:/.test(l)).map((l) => l.slice(8).trim()).filter(Boolean);
}

/** Resolved launcher entry cache (adbPath|pkg → activity), valid for 10 minutes. */
const LAUNCHER_CACHE = new Map();

/**
 * Windows adb is unstable with non-ASCII paths (Chinese usernames / Chinese download folders are common).
 * Before installing, copy the APK to a pure-ASCII temp directory; delete it when done.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Assembles an Activity into the full component form required by `am start -n`.
 * Two forms must be supported:
 *   - Plain class name (stored in older apps.json entries): `MainActivity` / `.MainActivity` → `<pkg>/<activity>`
 *   - Full component (`cmd package resolve-activity` output): `com.a.b/.Main` → used as-is.
 * The old implementation unconditionally prepended `${pkg}/`, which turned a full component
 * into `pkg/pkg/class` — causing `am start` to cancel with result code=-92
 * (symptom: tapping the icon only shows the Android home screen).
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Extracts the component belonging to pkg from `cmd package resolve-activity --brief` output (tolerates trailing blank lines / priority lines). */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * The fixed 240s adb install timeout is too short for 2 GB+ packages on slow disks —
 * "push + install + dexopt" can easily exceed 4 minutes, and when it times out the
 * install is treated as a failure (the user just sees "big package hung / failed").
 * This scales the timeout by package size, up to 20 minutes.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Parses `find -exec stat -c '%Y|%s|%n'` output.
 * Returns null if the output does not look like stat results (device does not support stat).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Output produced but no rows parsed → not stat format
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // Persistent `adb shell` process
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // fall back to PATH
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
    // Play Store images enforce ADB authorization: the host adb server and guest adbd must share
    // the same adbkey. The official approach is for adb/emulator to share
    // %USERPROFILE%\.android\adbkey{,.pub}, with the emulator baking adbkey.pub into
    // /data/misc/adb/adb_keys at boot.
    // Explicitly point adb server to the key location: some environments
    // (ANDROID_SDK_HOME / portable runtimes) cause adb to look elsewhere, so every cold boot
    // pops an "Allow USB debugging" dialog → device unauthorized.
    if (!env.ADB_VENDOR_KEYS) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const keyDir = path.join(home, '.android');
      try { if (home && fs.existsSync(keyDir)) env.ADB_VENDOR_KEYS = keyDir; } catch (_) { /* ignore */ }
    }
    return env;
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Uses a dedicated adb server port shared with the runtime emulator (default 5044),
        // isolated from WSA / third-party emulator adb on port 5037, so our device
        // registration is never kicked out causing device offline.
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // adb install failure reason is written to stdout with a non-zero exit code;
          // the old implementation only checked stderr, so users always got a vague "failed" message.
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} failed: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Persistent input channel.
   * Scroll / back are high-frequency inputs — spawning a full execFile per scroll wheel tick
   * creates a process storm that makes the desktop noticeably sluggish. This reuses a single
   * `adb shell` process, one command per line, with an echo sentinel at the end — giving us
   * both completion detection and natural back-pressure so scroll commands cannot pile up.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // Must match the whole line: some shells echo back the full command, so using
          // 'contains' would falsely detect "just written" as "already executed", causing scroll queue pile-up.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* ignore: device-offline and similar errors are handled by callers */ });
    p.stdin.on('error', () => { /* cleaned up by exit handler */ });
    p.on('error', () => { this._failWaiters(new Error('adb shell failed to start')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell exited'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Runs a whitelisted input command; on failure the session is recycled and the caller can fall back to one-shot adb. */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Illegal input command');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('input command timed out'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('input channel closed'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* may already be connected */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state is unavailable without a specified serial; fall back to the devices list
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  /**
   * Returns this serial's true state from `adb devices`: device / unauthorized / offline / no-device.
   * isOnline() uses get-state which cannot distinguish authorized from unauthorized (both appear as 'device').
   * The boot probe uses this method to detect a stalled "Allow USB debugging" dialog and self-heal quickly.
   */
  async deviceState() {
    try {
      const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
      return parseDeviceState(stdout, this.serial);
    } catch (_) {
      return 'no-device';
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Installs a single APK with automatic fallback:
   *  - `-g` (auto-grant all permissions) is included first; some images crash PermissionController with it, so it auto-degrades;
   *  - `--bypass-low-target-sdk-block` works around Android 14 blocking old targetSdk apps;
   *  - Retries with alternate invocations on unknown-option / non-ASCII path / transport errors;
   *  - NO_MATCHING_ABIS throws a coded error so the caller can automatically switch to a compatible image.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK does not exist: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g auto-grants runtime permissions to skip in-app prompts; auto-degrades if unsupported on some images
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* use default if size cannot be determined */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // Old adb does not recognize new flags / test package flag -> try alternate syntax
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // Retry once on transport errors (device offline, adb server restart)
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // No clear error code: try the last syntax option
        }
      }
      const err = new Error(friendlyInstallError(last || 'Installation failed: no specific error code returned'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** Installs split APKs (extracted from .apks / .xapk) via install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('No installable split APKs found');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('Split APK installation failed');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // Some devices require specifying --user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  /**
   * Verifies if installation really succeeded — does not naively trust PackageManager.
   *
   * When snapshots and data partition are out of sync, `pm path` may return
   * `package:/data/app/.../base.apk` (installed=true), but the APK file itself has been
   * rolled back. Continuing `am start` will fail. So we verify each path reported by pm
   * using `test -f/-s`; missing/empty files are deemed uninstalled, triggering auto-reinstall.
   *
   * @returns {Promise<boolean>}
   */
  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    const paths = parsePmPaths(out);
    if (!paths.length) return false;
    // All split APKs must be present; missing any piece prevents launch. Combined into one shell call to save adb round-trips.
    const checks = paths.map((p) => `[ -s "${p}" ]`).join(' && ');
    const probe = await this.shell(`${checks} && echo __APKSTART_PRESENT__`, { timeout: 10000 }).catch(() => '');
    return /__APKSTART_PRESENT__/.test(String(probe));
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Resolves the actual launcher activity from system (fallback when manifest parse fails) */
  /** Launcher entry may change after upgrade; remove package from cache before resolving */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Resolving launcher activity takes one adb round-trip (~200-400ms) and never changes during a launch session.
    // Cached so clicking the same app again skips this; expires after 10 min, ensuring reinstalled apps resolve correctly.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* fall back to monkey */ }
    return null;
  }

  /** Checks if the app is truly alive: am start success != process did not crash */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Do not assume failure without crash logs: some large apps take 20-40s on first launch
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Launches app with 3-tier fallback:
   *   freeform window -> normal fullscreen -> monkey fallback;
   * Verifies process survival each time, captures logcat on crash, and throws coded error for automatic image switch.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Must use system-resolved LAUNCHER entry, not just the main Activity parsed from the APK:
    // Many apps perform initialization only on their splash/entry page; jumping directly to main Activity
    // triggers errors like "had you called RpcService.init", causing an immediate crash/flash.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved may be full component (pkg/class) or just class name (legacy apps.json);
    // normalized here to the full component required by am start -n to avoid pkg/pkg/class cancellation.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(App is still loading)`;
      lastError = alive.crash || lastError;
      // If crash log points to ARM translation layer, do not retry; hand off to caller to switch compatible image
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey fallback: some images cannot resolve launcher via am start -a/-c/-p
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Prefer explicit crash info if present, otherwise preserve original launch error
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Enables freeform window support; failure does not block the main flow */
  async ensureFreeform() {
    // Batched into a single adb shell: 4 separate execFiles take 600ms+ on Windows,
    // which is directly in the critical path of opening an app.
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // Android's ls -l has both group-included and group-omitted formats; date format may be
      // "2026-11-12 18:52" or "Nov 12 18:52"; fixed regexes will fail across images.
      // Second number after permissions is file size; the final segment is the file name.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // File name appears after the time token (date has 2-3 tokens, not fixed)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Remote listing with true mtime (via toybox stat).
   * ls -l date is month/day/time without year; cannot convert reliably and causes false-positive file changes.
   * Returns null if device does not support stat; caller should fall back to listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Clears app data */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
    // Clearing data revokes permissions; must re-grant on next launch, invalidate permGranted cache
    try { store.upsertApp({ package: pkg, permGranted: false }); } catch (_) { /* ignore */ }
  }

  /** Exports app data (run-as on Windows/debug builds; adb backup fallback otherwise) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Grants all runtime permissions requested by the app in one batch.
   * Skipping this causes: 1) System dialog on first launch looking like app failed to open;
   * 2) Permissions reset after pm clear, causing app to hang on permission request screens.
   *
   * Performance: `dumpsys package` spawns an app_process in guest (takes 1-3s),
   * and each `pm grant` / `cmd appops set` spawns another. For apps with a dozen permissions,
   * this consumes over 20 seconds alone (permissions granted from +18s to +42s in logs).
   * Permissions are persistent once granted unless uninstalled or cleared,
   * so we record permGranted in apps.json and skip on future runs; flag is cleared on reset/reinstall.
   */
  async grantRuntimePermissions(pkg) {
    try {
      const rec = store.getApp(pkg);
      if (rec && rec.permGranted === true) return [];
    } catch (_) { /* if no record found, treat as not granted */ }
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // exit runtime permissions block
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Send grants in a single batch: each pm grant takes 150ms+ on Windows,
    // 4-5 permissions take 1 second, and the commands are completely independent.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Special permissions use appops, otherwise dialogs still appear
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    // Only persist flag after full run: failures will retry next time without leaving false granted state
    try { store.upsertApp({ package: pkg, permGranted: true }); } catch (_) { /* ignore */ }
    return granted;
  }

  /**
   * Sets up dedicated app foreground state:
   *  - Dismiss keyguard to prevent lock screen from blocking the app;
   *  - Hide status bar (keep bottom nav keys for back/home);
   *  - Disable system animations for significantly better responsiveness on low-end machines.
   * All commands are lightweight settings calls taking hundreds of ms, safe to repeat.
   */
  async prepareForeground() {
    // Previously 7 commands ran serially, each spawning an adb process (150-250ms on Windows),
    // totaling 1-1.7s of delay when opening apps. Combining into one shell command saves all roundtrips.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Large-screen taskbar: Pixel Launcher renders a persistent taskbar at tablet density,
      // covering content and misaligning buttons to the bottom-left.
      // See disableLauncherTaskbar(): applied idempotently on each launch in the same batch.
      'settings put global enable_taskbar 0',
      // Network captive portal check: Android uses connectivitycheck.gstatic.com by default,
      // which is unreachable in certain regions, showing exclamation marks on network status.
      // Replace with reliable 204 generating endpoint to prevent apps falsely detecting offline.
      // Applied idempotently on each start so restored snapshots are corrected automatically.
      
      'settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204',
      'settings put global captive_portal_mode 0',
      // Note: do not write wm user-rotation / accelerometer_rotation here.
      // Orientation is controlled exclusively by setOrientation / resetDisplayOverrides;
      // hardcoding lock 0 here would override landscape mode back to portrait.
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Mouse right-click / side buttons / shortcut mapping: uses persistent input channel to eliminate 100ms delay */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Fall back to one-shot adb if persistent shell is not yet connected after runtime restart
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Switches between phone and tablet layouts.
   *
   * Key: NEVER change wm size. Modifying wm size alters physical framebuffer dimensions
   * (720x1280 -> 1280x720), while embedded Qt window stays unchanged, causing squished display
   * or 90-degree sideways rotation with broken touch coordinates. Overrides also persist in /data.
   
   
   *
   * We only modify logical density (wm density); framebuffer remains 720x1280 upright:
   *   - 320dpi -> smallestWidth 360dp -> Phone layout
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> Tablet / multi-column layout
   * Size, orientation, and click mappings stay intact with no letterboxing or distortion.
   */
  async setOrientation(landscape) {
    try {
      // Enable auto-rotate toggle by default: sets guest accelerometer_rotation=1 so settings show on.
      // Actual orientation is locked via wm user-rotation lock 0 + set-ignore-orientation-request below.
      
      // Users can disable auto-rotate in settings to revert to legacy lock-0 behavior.
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}; wm size reset`, { timeout: 15000 });
      // Direction lock 0 (not 1). Physical panel orientation is determined by hw.lcd.width/height
      // (see doctor.lcdFor); locking 1 would rotate the landscape panel into portrait logic.
      
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      // Key step: apps declaring portrait force system to rotate 1280x720 panel into 720x1280 space.
      // Enabling set-ignore-orientation-request forces layout to match physical panel.
      
      // Must disable in portrait mode; otherwise previous true value keeps landscape layout.
      // Command unavailable on API < 31; safely ignore failures.
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Android shows "See and do more" prompt when freeform / ignore orientation request is enabled.
      // Mark as confirmed in settings and send fallback back key so prompt does not block app.
      
      await this.shell('settings put secure freeform_mode_confirmations confirmed', { timeout: 10000 });
      if (landscape) await this.shell('input keyevent KEYCODE_BACK', { timeout: 8000 });
      await this.shell(`wm density ${tabletDensity()}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Disables large-screen taskbar (Android 12L+ Taskbar).
   *
   * Why needed: tablet density at 190dpi crosses the 600dp breakpoint, prompting Pixel Launcher
   * to render a persistent taskbar overlay covering content and displacing buttons.
   
   
   *
   * It is not the system nav bar, so policy_control cannot hide it; must disable enable_taskbar.
   * Launcher only reads this setting on start, so force-stop both common launchers to take effect.
   
   */
  async disableLauncherTaskbar() {
    try {
      await this.shell('settings put global enable_taskbar 0', { timeout: 10000 });
      // grep -c exits with 1 on 0 matches; append || true to prevent command error
      const out = await this.shell(
        'dumpsys window windows | grep -c "Window #.*Taskbar" || true',
        { timeout: 12000 },
      ).catch(() => '0');
      const alive = parseInt(String(out).trim(), 10) || 0;
      if (alive > 0) {
        await this.shell(
          'am force-stop com.google.android.apps.nexuslauncher; am force-stop com.android.launcher3',
          { timeout: 12000 },
        ).catch(() => '');
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Waits until the app actually renders its first frame.
   *
   * Process attachment != user-visible frame: Android 12+ shows a splash screen first.
   * Boot animation should stay visible until splash screen disappears so users do not see white screens.
   
   
   *
   * Condition: no "Splash Screen" in window list, and focus is on the target package.
   * Returns false on timeout; caller dismisses animation anyway to avoid hanging indefinitely.
   */
  async waitForAppFirstFrame(pkg, { timeoutMs = 12000, intervalMs = 350 } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      // Must use `dumpsys window` (full dump); `dumpsys window windows` lacks mCurrentFocus line.
      
      
      
      const out = await this.shell(
        'dumpsys window | grep -E "Splash Screen|mCurrentFocus" | head -8',
        { timeout: 8000 },
      ).catch(() => '');
      const s = String(out);
      if (s.trim()) {
        const splashAlive = /Splash Screen/.test(s);
        const focusOnApp = s.indexOf(pkg) >= 0;
        if (!splashAlive && focusOnApp) return true;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  /** Resets leftover wm size / density overrides on boot (prevents persistent rotation glitches) */
  async resetDisplayOverrides(landscape = false) {
    try {
      // density must be configured BEFORE app launch.
      // Resetting density during runtime causes cached DisplayMetrics apps to miscalculate layout.
      
      
      
      
      await this.shell(`wm size reset; wm density ${tabletDensity()}`, { timeout: 15000 });
      await this.shell(`settings put system accelerometer_rotation ${guestAutoRotate()}`, { timeout: 15000 });
      // Consistent with setOrientation: physical panel governs, logical orientation locked to 0.
      await this.shell('wm user-rotation lock 0', { timeout: 15000 });
      await this.shell(`wm set-ignore-orientation-request ${landscape ? 'true' : 'false'}`, { timeout: 15000 });
      // Tablet density triggers taskbar; restart launcher if already running.
      
      await this.disableLauncherTaskbar();
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Ensures an input method supporting Chinese is installed in guest.
   *
   * Google Play image only bundles LatinIME; bundle AOSP Google Pinyin IME (assets/PinyinIME.apk).
   
   
   *
   * Idempotent: skips if already installed; preserves user choice if changed manually.
   *
   * @param {string} apkPath Absolute path to PinyinIME.apk
   * @param {object} [o] { setDefault } Whether to set as default IME (default true)
   * @returns {Promise<{ok:boolean, installed?:boolean, ime?:string, reason?:string}>}
   */
  async ensureChineseIme(apkPath, { setDefault = true } = {}) {
    const IME_PKG = 'com.android.inputmethod.pinyin';
    const IME_ID = IME_PKG + '/.PinyinIME';
    // ime list -s only lists enabled IMEs; verify package install status via pm list packages.
    
    
    const pkgInstalled = async () => {
      const out = await this.shell(`pm list packages ${IME_PKG}`, { timeout: 10000 }).catch(() => '');
      return String(out).indexOf('package:' + IME_PKG) >= 0;
    };
    const findEnabledIme = async () => {
      const out = await this.shell('ime list -s', { timeout: 10000 }).catch(() => '');
      return String(out).split('\n').map((s) => s.trim()).find((s) => s.indexOf(IME_PKG) === 0) || '';
    };
    try {
      let installed = await pkgInstalled();
      let justInstalled = false;
      if (!installed) {
        if (!apkPath || !fs.existsSync(apkPath)) {
          return { ok: false, reason: 'IME APK missing' };
        }
        await this.install(apkPath);
        installed = true;
        justInstalled = true;
        // Wait for PackageManager to recognize package after install
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          installed = await pkgInstalled();
          if (installed) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800));
        }
      }
      if (!installed) return { ok: false, justInstalled, reason: 'IME package not registered' };
      // Enable + set as default (secure settings writable without root).
      // Runs idempotently to ensure settings persist across snapshot restores.
      const cmds = [`ime enable ${IME_ID}`];
      if (setDefault) cmds.push(`settings put secure default_input_method ${IME_ID}`);
      await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
      const ime = await findEnabledIme();
      return { ok: !!ime, installed: justInstalled, ime: ime || IME_ID };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Ensures system language is set to Simplified Chinese.
   * persist.sys.locale is SELinux-protected; injected at emulator boot via -prop.
   
   * Sets user-space locale, timezone, and 24h format for immediate display.
   */
  async ensureChineseLocale(locale = 'zh-CN') {
    const cmds = [
      'settings put system system_locales ' + locale,
      'setprop persist.sys.timezone Asia/Shanghai',
      // 24-hour clock and common date format
      'settings put system time_12_24 24',
    ];
    await this.shell(cmds.join(' ; '), { timeout: 12000 }).catch(() => '');
    return true;
  }

  /** Current logical resolution (used to calculate window aspect ratio after rotation) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** Dismisses top-level permission dialog via Back key if user is away from keyboard */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Display scaling: matches Android resolution to monitor size in fullscreen;
   * restores portrait preset in windowed mode. Takes effect immediately without reboot.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity, parseDeviceState, isUnauthorizedError, parsePmPaths,
};
