'use strict';
/**
 * Portable packaging: produces dist/ApkStart-win64-portable/
 *   ApkStart.exe (electron.exe renamed, icon/version resources patched in) + resources/app (this app's source)
 * No installer involved: extract and run.
 *
 * With --full (or APKSTART_PACK_FULL=1) it produces the "full build":
 *   build/runtime is copied into resources/runtime as well, so extracting is enough and the first launch downloads nothing.
 *   The output defaults to dist/ApkStart-v<version>-win64-full and never overwrites the light build.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertStandalone } = require('./guard-standalone');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));
const FULL = process.argv.includes('--full') || process.env.APKSTART_PACK_FULL === '1';
// Allow an explicit output directory (for when a running instance holds the default one: build elsewhere, then swap)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', FULL ? `ApkStart-v${PKG.version}-win64-full` : 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// On Windows, fs.cpSync over a tree of many small files plus a huge image intermittently fails with
// EINPROGRESS (Node misreports it as "not enough space on the disk" while hundreds of GB are free).
// A plain recursive copyFileSync is a little slower, but every file is its own syscall, so a tree-level
// race cannot interrupt it, and unlike robocopy it never hangs inside a managed shell.
function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copy(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

console.log(FULL ? 'Packaging the full build (with runtime) ->' : 'Packaging the portable build ->', OUT);
// Never wipe an existing target tree: some environments block bulk deletion, and a failure mid-pack would
// lose the last working build. Rename the old directory aside and build fresh; if it is locked, switch output directories.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Previous build kept ->', backup);
  } catch (_) {
    // Some environments (antivirus / search indexer / Explorer) hold directory handles for a long time, so
    // renaming the whole tree always fails with EBUSY; fall back to a versioned directory, equally usable and unique.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Old directory is locked, writing to ->', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron runtime
console.log('Copying the Electron runtime...');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Locale slimming: Electron ships 55 languages totalling 41MB and we only ship the ones we list below.
//     Keeping just en-US / en-GB / zh-CN / zh-TW deletes the rest (-39MB, about 15% off the whole package).
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* no locales directory is fine too */ }

// 1.2 Files nobody will ever open: changelogs, debug symbols, a few unused paks (0.1-9MB each)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Runtime libraries that can go:
//     d3dcompiler_47.dll compiles ANGLE's HLSL into GPU instructions, but Windows 8.1 and later ship a
//     same-named DLL in System32, and LoadLibrary falls back to it when the bundled copy is missing.
//     With it removed the UI, icons and text render exactly as before (no diff in --smoke screenshots). Saves 2.1MB.
//     Note: vk_swiftshader.dll / vulkan-1.dll must stay -- Chromium needs them as the software fallback
//     when no GPU driver works, and deleting them gives a white screen.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* not present anyway */ }
}

// 2. The app itself
// assets/ holds resources shipped with the package: PinyinIME.apk (a Chinese input method), installed
// silently into Android at boot by Runtime.prepare(). Without it users cannot type Chinese.
console.log('Copying the app...');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'assets', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 2.1 Production dependencies (native modules): copying src/ alone is not enough -- runtime npm deps ship too.
// The classic victim: @napi-rs/lzma extracts system.img.xz / vendor.img.xz and lives in package.json
// dependencies, while the old pack.js never copied node_modules at all.
// The result was "installation finishes but tapping an app does nothing": image extraction threw
// Cannot find module '@napi-rs/lzma', the runtime never started and all four parameter sets ended in boot-failed.
// That was the fatal 0.5.9 regression.
// Scoped packages (@scope/name) are copied with their whole scope, because native binaries
const prodDeps = Object.keys((require(path.join(ROOT, 'package.json')).dependencies) || {});
if (prodDeps.length) {
  console.log(`Copying production dependencies (${prodDeps.length}): ${prodDeps.join(', ')}`);
  const destModules = path.join(appDir, 'node_modules');
  for (const dep of prodDeps) {
    if (dep.startsWith('@')) {
      const scope = dep.split('/')[0];
      const scopeSrc = path.join(ROOT, 'node_modules', scope);
      if (fs.existsSync(scopeSrc)) copy(scopeSrc, path.join(destModules, scope));
    } else {
      const depSrc = path.join(ROOT, 'node_modules', dep);
      if (fs.existsSync(depSrc)) copy(depSrc, path.join(destModules, dep));
    }
  }
}

// 3. Optional directories
// Only documentation-style content from engine/ ships; the large runtime pieces (emulator, system-images,
// platform-tools, avd) are downloaded from official sources on first launch and never enter the installer.
// tools/ holds development self-check scripts (black-window probes, speed tests) users never need, so it no longer ships.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    copy(path.join(src, entry.name), path.join(dest, entry.name));
  }
}

// 3.5 Full build: include the runtime (emulator + platform-tools + system images) too
if (FULL) {
  const runtime = path.join(ROOT, 'build', 'runtime');
  const runtimeExe = path.join(runtime, 'emulator', 'emulator.exe');
  if (!fs.existsSync(runtimeExe)) {
    console.error('\n[!] build/runtime/emulator/emulator.exe not found.');
    console.error('    Run node build/prepare-runtime.js (npm run runtime) to generate the runtime, then pack the full build.\n');
    process.exit(1);
  }
  console.log('Bundling the runtime (~1 GB, this takes a while)...');
  // The runtime directory can hold development leftovers: userdata.img.broken (from a failed extraction),
  // *.part (interrupted extraction), *.new (compression in progress). They take space, serve no purpose,
  // and can even ship a corrupt image -- skip them, never copy them.
  // Verify every .img.xz before packing: a truncated xz only explodes halfway through extraction
  // ("failed to fill whole buffer") long after the user has installed the app -- which shows up as
  // "it installed, but no app will open". 0.5.9 was sunk by a truncated system.img.xz
  // (495MB yielding 1366MB of an expected 2958MB). An xz stream always ends with a footer,
  // and "YZ" appears in the last 8 bytes; if it is missing, the file was never finished.
  const walkXz = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkXz(p); continue; }
      if (!/\.img\.xz$/i.test(e.name)) continue;
      const size = fs.statSync(p).size;
      const fd = fs.openSync(p, 'r');
      let tail;
      try {
        const n = Math.min(8, size);
        tail = Buffer.alloc(n);
        fs.readSync(fd, tail, 0, n, size - n);
      } finally { fs.closeSync(fd); }
      if (!tail.includes(Buffer.from('YZ'))) {
        console.error(`\n[!] Incomplete image (xz footer missing, probably a truncated download): ${p}`);
        console.error(`    Size ${(size / 1048576).toFixed(1)} MB. Fetch that image again before packing.\n`);
        process.exit(1);
      }
    }
  };
  walkXz(runtime);
  // Note: .pynew is the Python recompression temp file and, like .new, must be excluded.
  const JUNK = /(\.broken|\.part|\.new|\.pynew|\.tmp|\.bak)$/i;
  const copyRuntime = (src, dest) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        if (JUNK.test(entry)) continue;
        copyRuntime(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  copyRuntime(runtime, path.join(OUT, 'resources', 'runtime'));
}

// 3.6 Standalone guard: no MuMu / LDPlayer / BlueStacks or any other third-party emulator may appear in the output.
// A hit fails the build -- this class of problem only shows up on other people's computers, never locally.
assertStandalone(path.join(OUT, 'resources'), { label: 'portable resources' });

// 4. Rename the main executable
const exePath = path.join(OUT, 'ApkStart.exe');
fs.renameSync(path.join(OUT, 'electron.exe'), exePath);

/**
 * Patch the icon and version resources into ApkStart.exe.
 *
 * Why it is mandatory: a plainly renamed exe still carries Electron's own metadata --
 * FileDescription=Electron, ProductName=Electron, CompanyName=GitHub, Inc.,
 * version 33.4.11 and the Electron icon. Explorer, taskbar pins, shortcut properties and antivirus/system
 * info then all show "Electron" with the default icon, which is exactly the "the icon is the default one" report.
 *
 * rcedit is the same tool electron-builder / electron-winstaller use; the copy in node_modules is
 * called directly, so no network access is needed.
 */
function embedExeMeta(exe) {
  const rcedit = [
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
  ].find((p) => fs.existsSync(p));
  if (!rcedit) {
    console.warn('  [!] rcedit.exe not found; the exe keeps Electron\'s default icon/version info');
    return false;
  }
  const ico = path.join(ROOT, 'src', 'ui', 'assets', 'appicon.ico');
  if (!fs.existsSync(ico)) {
    console.warn(`  [!] ${ico} not found, skipping the icon write`);
    return false;
  }
  const args = [
    exe,
    '--set-icon', ico,
    // Four-part file version (same convention as MSIX), three-part product version
    '--set-file-version', `${PKG.version}.0`,
    '--set-product-version', PKG.version,
    '--set-version-string', 'ProductName', 'ApkStart',
    '--set-version-string', 'FileDescription', 'ApkStart Android app runner',
    '--set-version-string', 'CompanyName', PKG.author || 'farmanullah1',
    '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 ApkStart',
    '--set-version-string', 'OriginalFilename', 'ApkStart.exe',
    '--set-version-string', 'InternalName', 'ApkStart',
  ];
  try {
    execFileSync(rcedit, args, { stdio: 'pipe', windowsHide: true });
    console.log(`  exe icon/version written (${PKG.version}, FileDescription=ApkStart Android app runner)`);
    return true;
  } catch (e) {
    console.warn(`  [!] rcedit failed: ${e.message}`);
    return false;
  }
}
embedExeMeta(exePath);

// 5. Version info
const pkg = PKG;
const fullNote = FULL ? 'full build (runtime bundled, works offline after install)' : 'light build (downloads the runtime on first launch)';
fs.writeFileSync(path.join(OUT, 'VERSION.txt'),
  `ApkStart ${pkg.version}\n${fullNote}\nBuild time: ${new Date().toLocaleString('en-US')}\n`);

// 6. Size report: printed on every pack so the package cannot quietly grow again
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Done. Total ${totalMB.toFixed(0)} MB (locales saved ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `redundant libraries saved ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Compress: node build/zip.js ' + path.relative(ROOT, OUT) + ' <output.zip>');
console.log(`Run ${path.join(OUT, 'ApkStart.exe')} to use it.`);
if (!FULL) console.log('For a "download once, works offline" full build: node build/pack.js --full');
