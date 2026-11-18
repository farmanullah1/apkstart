'use strict';
/**
 * Containerized layering: read-only base image + lean runtime + reclaimable temporary layers.
 *
 * Analogy (same as Docker):
 *   system-images/  = read-only base layer, shared by all apps and sessions, never duplicated
 *   avd/*.avd/      = writable thin layer (qcow2 delta + quickboot snapshot), stores changes only
 *   _tmp/ snapshots = reclaimable scratch layer
 *
 * This module only performs "inventory" and "reclaim against explicit manifest", defaults to dryRun,
 * and never touches user personal files.
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Inventory runtime disk usage and list "safely reclaimable" items.
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('emulator engine', path.join(root, 'emulator'));
  groupOf('system image (read-only base layer)', path.join(root, 'system-images'));
  groupOf('AVD writable layer / snapshot', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU only needs the x86_64 target; other architectures in the package are wasted space
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'Non-x86_64 QEMU target, not needed at runtime');
      }
    }
  }

  // 2) License text / redundant directories inside image packages
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'Large documentation file inside image package');
    }
  }

  // 3) Keep only one system image: after API 34 Play image is in place, legacy API 30 images expire
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'Legacy API 30 image (contains outdated ARM translation layer)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'Duplicate image directory from misplaced extraction', 'dir');

  // 4) Inactive AVD: product only uses apkstart; legacy apkstart-arm / -houdini from testing can be purged
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'Inactive AVD (contains 8-16GB legacy user data image)', 'dir');
    }
    // 5) Lock files: residuals cause "AVD is already running"
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'Stale lock file from abnormal previous exit');
    }
    // 6) Fast boot snapshots: ram.img ≈ allocated memory, must be discarded upon corruption or config change
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Normal snapshots + stale snapshots left from rename on delete failure can both be reclaimed
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'Old quickboot snapshot (automatically rebuilt after config change)', 'dir');
      }
    }
  }

  // 7) Download cache / QEMU legacy ISO
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'Temporary download files' : 'Legacy QEMU/ISO files', 'dir');
    }
  }

  // 8) Aggressive pruning: enabled only during release package build.
  // Note: Qt6WebEngineCoreAndroidEmu.dll is a load-time dependency of qemu-system-x86_64.exe;
  // in tests, removing it prevented emulator startup, so it must not be in the prune list;
  // qsn/netsim may also be invoked on demand by snapshot and networking features, retained conservatively.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'Crash reporter tool (not needed for headless operation)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Reclaim. Must explicitly pass apply:true; caller (UI / build script) is responsible for showing list and getting confirmation.
 * Safety constraint: all targets must be within root, and root itself must not be deleted.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* Skip occupied files, clean up next time */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Short summary for settings page */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Besides runtime directory, users care about total disk usage:
  // AVD (app data + snapshots), APK cache, icons, and logs are all counted.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'Android Data (Apps + Snapshots)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'APK Package Cache', path: store.APK_DIR },
    { key: 'icons', label: 'Desktop Icon Cache', path: store.ICON_DIR },
    { key: 'logs', label: 'Logs', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'Runtime (Engine + System Image)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
