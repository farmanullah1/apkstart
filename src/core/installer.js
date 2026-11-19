'use strict';
/**
 * Install / launch / uninstall orchestration layer
 * Pipes "parse APK → install into runtime → persist local metadata → generate Desktop shortcut" into one pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK only has ARM native libraries (as do the vast majority of domestic apps) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Split install packages (.apks / .xapk): unpack the split APKs inside into a pure-ASCII temp directory.
 * Uses the file-mode ZIP reader + streaming fall-disk: split packages are often 2GB+, and reading the whole package into memory will fail.
 * Returns { meta, files, cleanup }; meta comes from the base APK that carries the AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('No APK split found in this install package (possibly not .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // A single split can also be several hundred MB: stream the decompression, do not go through a Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
             try { meta = parseApk(f); break; } catch (_) { /* no manifest in this split */ }
    }
    if (!meta) throw new Error('Split package base APK parse failed');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

     /**
    * Two copies: Desktop + Start menu.
    * Windows Search indexes the .lnk under "Start menu \ Programs"; putting it only on the Desktop would make it unfindable;
    * on some machines the Desktop is redirected by OneDrive, so the Start menu copy also guarantees the entry is not lost.
    *
    * On Linux (FydeOS) the equivalent is a freedesktop .desktop:
    * one on the Desktop, one in the application menu at ~/.local/share/applications.
    */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Keep shortcuts in their own subdirectory: Windows search still indexes it, and it never overwrites a third-party app's shortcut with the same name
      // (a real case: "Hongguo Free Drama" was already taken by another desktop helper)
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

  /** The compatibility image is downloaded on demand the first time an ARM app appears, and is shared as a read-only base layer (downloaded once) */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'First ARM app: downloading the compatibility image (~1.5GB, one time only)...' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Compatibility image download failed; check your network and retry');
    return true;
  }

  /** Switching images requires a runtime restart; afterwards installed apps are reinstalled from the local APK backups */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Switching to the compatibility image and restarting the runtime...' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Wait for the old device to disappear from the adb list so ensure() does not treat it as reusable
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable after switching to the compatibility image');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Restoring installed app ${app.label}...` });
      } catch (_) { /* a single app failing to restore must not block the rest */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Parsing APK...' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Detected ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // 50GB games: check the emulator data partition's free space up front instead of failing halfway
    // with INSTALL_INSUFFICIENT_STORAGE (which users experience as "it installed for ages and then failed").
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
            try { bytes += fs.statSync(f).size; } catch (_) { /* skip temp files */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* fall back to 0 */ }
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
      // A failed size probe must not block the install
    }

    try {
      // Zero config: apps with only ARM libraries automatically get an image with the ARM translation layer; no toggle needed
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparing the Android runtime...' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime unavailable');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Install the app itself + persist metadata + create the shortcut; on failure retry once with auto-repair */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // After installing, the old quickboot snapshot's disk state is stale; keeping it would make "the app I installed vanishes after a restart"
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Updating app...' : 'Installing app...' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // An ABI mismatch reported at this point means the current runtime is an AOSP image; switch to the compatibility image and install again
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Switched to the compatibility image; reinstalling...' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Write the icon to disk. Many APK icons are WebP, which nativeImage cannot decode, so decoding is left to the renderer plus
    // a branded placeholder fallback, guaranteeing the .lnk always has an icon (icoPath used to be null).
    // iconFallback records "the real icon could not be decoded, a placeholder was used" - surface that as a soft warning,
    // otherwise the desktop shows a generic green triangle and users think ApkStart picked the wrong icon.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* an icon failure must not block the install */ }
    }

    // Back up the APK so the app can be reinstalled or recovered later
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // Launch entry comes from the system's own resolution: the "main Activity" parsed from the APK is often not
    // the real LAUNCHER entry, and starting it skips the app's initialization screen and crashes.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* keep the APK-parsed result */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      // The app's natural orientation (computed offline from the APK manifest):
      // decides which orientation the emulator's physical panel uses; matching orientations fill the window with no black bars.
      // If the user set orientationOverride manually, theirs wins; this is only the default.
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
      // A reinstall may reset the permission table, so drop the "already granted" cache and re-check on the next launch
      permGranted: false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Creating desktop shortcut...' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Shortcut creation failed: ${e.message}` });
      }
    }

    // Compatibility warning: with only ARM native libraries an x86 runtime needs the translation layer
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`This app requires Android ${meta.minSdk}+, newer than the current runtime; it may not run correctly.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('The app icon could not be parsed (possibly an unusual adaptive icon format); the shortcut uses a placeholder icon for now.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('The app icon (WebP) failed to decode; the shortcut uses a placeholder icon for now.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Installing invalidated the old snapshot, so schedule one here: persist the "new app installed" state while idle,
    // otherwise the next boot has to cold-start again (20+ seconds).
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} installed`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    // Linux .desktop files only accept absolute PNG/SVG paths, ICO is invalid - so pass both paths down and let
    // writeShortcut pick per platform (ICO on Windows, PNG on FydeOS).
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
      description: `${app.label} - run by ApkStart`,
      cwd: this.ctx.cwd,
      // One AUMID per app: the taskbar groups by app instead of bunching everything under ApkStart
      appUserModelId: `farmanullah1.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Every primary path failed (custom shortcut directory not writable / blocked by security software):
    // fall back to the desktop and try once more - users need an icon on the desktop to find the app.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Failed to create shortcut');
    // Keep the Start menu path too, so uninstalling removes it as well
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Fill in missing shortcuts and icons: old versions only created the desktop one, and WebP icons did not convert back then */
  async ensureShortcuts() {
    const made = [];
    // Do not invent entries when the user turned off "create automatically after install" and this app never had any:
    // otherwise the switch cannot stop them from being recreated at startup.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* an icon rebuild failing must not block the entry */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // When the icon was just rebuilt, recreate even an existing .lnk so the shortcut picks up the real app icon
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* a single failure must not block startup */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
    // let, not const: beforeStart may restart the runtime when "panel orientation and app orientation disagree" and
    // return a new rt (the old client died with stop). This used to be const, so hitting the restart branch threw
    // "Assignment to constant variable." and aborted the whole launch -
    // showing up as "tapping the app right after switching orientation just fails".
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Resolution must change before the app starts, or wm size triggers a configuration change that recreates the just-started Activity
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Display adaptation skipped: ${e.message}`); return null; });
      // beforeStart may return a new rt (after a runtime restart the old client is dead),
      // so everything below uses the new one. When it returns nothing, keep the old.
      if (replaced && replaced.client) rt = replaced;
    }
    // Clear the wm size / density overrides and auto-rotate settings older versions may have left in /data.
    // Those overrides persist; without clearing them every launch comes up rotated 90 degrees with black bars
    // and taps no longer line up (the reported "rotated with black bars / not filling / cannot tap Agree").
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // A network check right after a cold boot: if there is no network, say so plainly. Otherwise users only see "this app is stuck on a black screen"
    // and never suspect the VM has no network (a network page with no data is just a black block).
    // Key fix: Wi-Fi association often lags sys.boot_completed by tens of seconds, and apps fetch their home feed immediately,
    // so without a network the home page renders as a black block - that is the real cause of "stuck on black after tapping Agree and continue".
    // So wait for the network before starting the app (up to 90 seconds); better to wait a few seconds than to hand the user a black screen.
    // Look at the network first: **only wait, never restart**.
    // This used to call ensureNetwork(), which on a slow network does "stop the VM -> cold boot",
    // so the adb device vanished mid-install and the result was "the app will not open".
    // The launch path must never do anything destructive; if the wait times out, start anyway and let pages load slowly.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`VM network ready (${net.ip || ''})`);
      } else {
        // When the network never comes up, do a **non-destructive** rescue: tap the saved
        // AndroidWifi network that does not auto-connect. It restarts nothing and touches no user data, it just opens the settings page
        // and taps a saved hotspot, which is safe on the launch path.
        // On real machines "the VM never has a network" is almost always this (see emulator.repairWifi).
        onLog('The VM cannot reach Wi-Fi; trying to reconnect...');
        try {
          // Note: repairWifi lives on engine (this.runtime), not on rt.
          // rt is ensure()'s result { ok, client, engine, ... } and only carries client;
          // rt.repairWifi would be undefined, throw a TypeError and be swallowed by catch -
          // which looks like "the log says reconnecting, but a millisecond later it still has no network".
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
              onLog(`VM network restored (${net.ip || ''})`);
              // Important: persist the "network is up" state into the snapshot immediately.
              // Otherwise the next boot restores the old "no network" snapshot and spends another ten seconds reconnecting.
              // forceSnapshotSave is used because the app is about to launch and there will never be an idle moment.
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* failing to save must not block the launch */ }
            }
          }
        } catch (e) {
          // Do not swallow the exception silently: this log is the only evidence of whether the reconnect ran.
          onLog(`Automatic Wi-Fi reconnect failed: ${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('The VM network is not ready yet; starting the app anyway (network pages may load a little later)');
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // The app may not be installed in the current runtime (image rebuilt / data cleared / first run), and starting it
    // would report "Invalid packageName". Install it from the local cache first so "open the app" always works without
    // a manual install - exactly the "tap an installed app and go straight in" experience.
    // Important: use isInstalled() (pm path plus checking every APK file really exists), not
    // `pm list packages`. When the snapshot and data partition disagree PackageManager still reports installed=true,
    // but the files under /data/app were rolled back - am start then always fails. Reinstall when the file check fails.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* treat as not installed and reinstall */ }
      if (!installed) {
        onLog('App files missing (snapshot and data disagree); reinstalling from the local backup...');
        // Drop the snapshot before reinstalling, or the old snapshot's packages.xml still claims it is installed and the next run breaks again
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Automatic install failed: ${e.message}`));
      }
    }
    // Watch for 25 seconds and require "alive for 5 consecutive seconds" before calling it a successful launch.
    // Important: "the process has not appeared yet" and "it appeared and vanished" must be distinguished. It used to fail on the first empty pidof,
    // so large apps (whose first launch takes ten-plus seconds) were force-stopped and restarted mid-load,
    // taking three attempts, which users experience as "tapping it means waiting a minute".
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Check first, then sleep: in a warm container the process usually shows up within a second,
        // so sleeping first would slow the fastest path down by a whole second.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // appeared then vanished = a real crash
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // As soon as the process appears, attach the picture (do not wait out the 4-second window).
            // Those 4 seconds confirm "it will not crash immediately", but users see "tapping did nothing";
            // showing them the app loading looks far better than hiding it for 4 seconds.
            // The callback is fire-and-forget: its failure does not affect the liveness check below.
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // failure only when the process was never seen
    };
    try {
      // Make sure runtime permissions are granted first: the install-time -g flags may have been lost after clearing data,
      // and without permissions the app is blocked behind the system grant dialog, which users see as "tapping does nothing / will not open".
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // With the grant dialog in front the app looks "unopenable"; grant first, then dismiss the dialog
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Hand a clear crash log to the caller (it may need to switch to the compatibility image); without evidence it is usually just slow and a retry is enough
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Lock the orientation right after the Activity starts. This lives here because the launch itself triggers
        // configuration changes (Activity recreation), and a user-rotation set before launching may be reset to 0 -
        // and at 0 the picture on a landscape panel falls over 90 degrees (reported as "it will not turn upright").
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`App exited after launch (attempt ${attempt}); retrying automatically...`);
      }
      if (!ok) {
        // Last resort: an abnormal exit leaves half-initialized data that makes every later launch crash.
        // Clearing app data once and relaunching has the best success rate (users should not have to clear the cache themselves).
        onLog('The app keeps exiting; resetting app data and retrying...');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear also wipes runtime permissions, so they must be granted again or the app sticks at the system dialog
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('The app exits right after launch; automatic retries and an app data reset did not help');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // The crash comes from the ARM translation layer: switch images, reinstall the backup APK and launch once more
        onLog('ARM translation layer crash detected; switching to the compatibility image automatically...');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* keep the existing package */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
