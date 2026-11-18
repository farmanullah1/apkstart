'use strict';
/**
 * Auto-detection · Probe layer (runs in main process only)
 *
 * Responsibility: Collect real machine status into a **pure data** snapshot `obs` and pass it to src/core/autodebug.js for evaluation.
 * Probing is allowed to fail - leave missing values empty and let the evaluation layer treat them as "unknown", never fabricate conclusions.
 *
 * Probe items and time budget (one full pass takes ~2-5s):
 *   - Runtime status (engine status: environment + adb online)
 *   - adb device authorization status
 *   - Free disk space, data partition capacity, shared directory writability
 *   - AVD leftover locks, hollow snapshots, orphan emulator processes
 *   - Error lines in recent logs
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AVD_NAME, SNAPSHOT_NAME } = require('./emulator');

/** Boot phase timing: timestamp when first observed "running but not ready" */
let bootingSince = 0;

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { setTimeout(() => resolve(fallback), ms); }),
  ]);
}

/** Count residual .lock entries in AVD directory (both files and directories count) */
function countLocks(avdDir) {
  try {
    return fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Check if snapshot is a "hollow shell": snapshot.pb exists but RAM image is missing or too small.
 * Such snapshots cause every boot to "fail loading then cold boot", wasting several GB of disk.
 * Read-only check, does not delete here - deletion is left to user confirmation or fix action.
 */
function inspectSnapshot(avdHome, avdName, snapshotName) {
  const base = path.join(avdHome, `${avdName}.avd`, 'snapshots', snapshotName);
  const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
  const pb = size(path.join(base, 'snapshot.pb'));
  const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
  if (pb === 0 && ram === 0) return { present: false, stale: false, mb: 0 };
  const mb = Math.round((pb + ram) / 1048576);
  const stale = !(pb > 1024 && ram > 1024 * 1024);
  return { present: true, stale, mb };
}

/** Count surviving emulator orphan processes (emulator.exe / qemu-system*.exe) */
function countOrphanProcesses() {
  return new Promise((resolve) => {
    let out = '';
    try {
      execFile('tasklist.exe', ['/NH', '/FO', 'CSV'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) { resolve(null); return; }
        out = String(stdout || '');
        const lines = out.split(/\r?\n/).filter((l) => /emulator\.exe|qemu-system/i.test(l));
        resolve(lines.length);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** Read error lines from recent log files (checks at most the last 300 lines) */
function recentLogErrors(files, max = 300) {
  const out = [];
  for (const file of files) {
    let text = '';
    try {
      const size = fs.statSync(file).size;
      const take = Math.min(size, 512 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        text = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch (_) { continue; }
    const lines = text.split(/\r?\n/).slice(-max);
    for (const line of lines) {
      if (/\b(ERROR|FATAL|FATAL ERROR|Exception|FATAL:|panic:)\b/i.test(line)) {
        out.push(line.trim().slice(0, 240));
      }
    }
  }
  return out.slice(-20);
}

/**
 * Collect an observation snapshot
 * @param {object} ctx { runtime, store, doctor }
 * @returns {Promise<object>} obs
 */
async function collect(ctx) {
  const { runtime, store, doctor } = ctx;
  const obs = {
    at: Date.now(),
    runtime: {},
    device: { checked: false },
    storage: {},
    settings: {},
    network: {},
    logs: {},
    accel: { checked: false },
  };

  // ---- Settings (cheapest, fetch first) ----
  let settings = {};
  try { settings = store.getSettings() || {}; } catch (_) { settings = {}; }
  obs.settings = {
    orientationMode: (settings.display && settings.display.orientationMode) || 'auto',
    landscape: !!(settings.display && settings.display.landscape),
    // Default to native window since 0.6.0: only explicit true counts as embedded mode
    windowEmbed: !!(settings.display && settings.display.windowEmbed === true),
    autoFullscreen: !!(settings.display && settings.display.autoFullscreenOnLaunch),
    keepSnapshot: !(settings.engine && settings.engine.keepSnapshot === false),
    resourceMode: (settings.engine && settings.engine.resourceMode) || '',
  };

  // ---- Runtime status ----
  let status = null;
  try {
    status = await withTimeout(runtime.status(), 20000, null);
  } catch (_) { status = null; }

  let paths = null;
  try { paths = runtime.provisioner.paths(); } catch (_) { paths = null; }

  const running = !!(status && status.vmRunning)
    || (() => { try { return !!(runtime.emulator && runtime.emulator.running()); } catch (_) { return false; } })();

  const phase = status ? (status.phase || '') : '';
  const ready = !!(status && status.ready);
  if (running && !ready) {
    if (!bootingSince) bootingSince = Date.now();
  } else {
    bootingSince = 0;
  }

  const lastFailure = status ? status.lastFailure : null;
  obs.runtime = {
    running,
    phase,
    ready,
    bootMs: bootingSince ? Date.now() - bootingSince : 0,
    error: (status && status.error && !/(?:缺少 adb|Missing adb)/i.test(status.error)) ? status.error : '',
    lastFailure: lastFailure ? { error: lastFailure.error || lastFailure.reason || '' } : null,
    locks: paths ? countLocks(paths.avdHome) : 0,
    orphans: null,
    snapshotStale: false,
  };

  // ---- adb device authorization status ----
  try {
    const client = runtime.client();
    if (client && typeof client.deviceState === 'function') {
      const state = await withTimeout(client.deviceState(), 10000, null);
      if (state) {
        obs.device = { checked: true, state };
      }
    }
  } catch (_) { /* Leave checked:false if undetectable */ }

  // ---- Storage ----
  try {
    const root = paths ? paths.root : null;
    if (root) {
      const freeMB = doctor.freeDiskMB(root);
      obs.storage.freeMB = Number(freeMB) || 0;
    }
  } catch (_) { /* ignore */ }

  try {
    const backend = runtime.backend;
    const info = (backend && typeof backend.dataInfo === 'function') ? (backend.dataInfo() || {}) : {};
    obs.storage.configuredGB = Number(info.configuredGB) || 0;
    obs.storage.actualGB = Number(info.actualGB) || 0;
    obs.storage.needsReset = !!(info.pendingGB || info.needsReset);
  } catch (_) { /* ignore */ }

  try {
    const shared = String(settings.sharedDir || '').trim();
    if (shared) {
      let ok = true;
      try {
        fs.accessSync(shared, fs.constants.W_OK);
      } catch (_) { ok = false; }
      obs.storage.sharedOk = ok;
      obs.storage.sharedPath = shared;
    }
  } catch (_) { /* ignore */ }

  // ---- Snapshot / locks / orphans ----
  try {
    if (paths) {
      const snap = inspectSnapshot(paths.avdHome, AVD_NAME, SNAPSHOT_NAME);
      obs.runtime.snapshotStale = snap.stale;
      obs.runtime.snapshotMB = snap.mb;
    }
  } catch (_) { /* ignore */ }

  const orphans = await countOrphanProcesses();
  if (orphans !== null) {
    // The running instance itself consists of emulator.exe + qemu (2 processes), not leftovers.
    const expected = running ? 2 : 0;
    obs.runtime.orphans = Math.max(0, orphans - expected);
  }

  // ---- Network ----
  try {
    const snap = typeof runtime._networkSnapshot === 'function' ? runtime._networkSnapshot() : null;
    if (snap) obs.network = { ok: !!snap.ok, reason: snap.reason || '', ip: snap.ip || '' };
  } catch (_) { /* ignore */ }

  // ---- Acceleration ----
  try {
    if (status && status.accel) {
      obs.accel = { checked: true, ok: !!status.accel.ok, note: status.accel.note || '' };
    }
  } catch (_) { /* ignore */ }

  // ---- Logs ----
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const files = [path.join(store.DATA_DIR, 'app.log'), path.join(dir, 'emulator.log')];
    const errors = recentLogErrors(files);
    obs.logs = { errors, count: errors.length };
  } catch (_) { /* ignore */ }

  return obs;
}

module.exports = { collect, inspectSnapshot, countLocks, recentLogErrors, countOrphanProcesses };
