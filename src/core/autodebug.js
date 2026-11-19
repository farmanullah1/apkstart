'use strict';
/**
 * Auto-detection (auto debug) core
 *
 * Deliberately split into two layers:
 *   1) Probe layer (src/core/autodebug-probe.js, main process): gathers machine state into a pure-data snapshot `obs`;
 *   2) Evaluation layer (this file, pure functions): evaluate(obs) → issues[].
 *
 * The evaluation layer touches neither fs / child_process / electron, so CI can directly require and unit test it
 * (lesson from 2026-11-17: requiring modules that depend on top-level electron fails on CI).
 *
 * An iron rule: fields not present in `obs` are treated as "unknown"; never report an issue simply because probing failed.
 * False positives harm user trust more than omissions - once users find a reported issue is fake,
 * they will no longer trust any conclusion from auto-detection.
 */

/** Issue categories (displayed grouped in this order on the settings page) */
const CATEGORIES = [
  { id: 'runtime', name: 'Runtime', hint: 'Android VM process, boot phase, snapshots, and residual locks' },
  { id: 'device', name: 'Device Connection', hint: 'adb authorization status, device online check' },
  { id: 'storage', name: 'Storage', hint: 'Free disk space, data partition, shared folder' },
  { id: 'settings', name: 'Settings', hint: 'Configuration conflicts and overrides' },
  { id: 'network', name: 'Network', hint: 'Android network and download source connectivity' },
  { id: 'logs', name: 'Logs', hint: 'Errors in runtime logs' },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

/** Severity ranking: higher number is more severe */
const SEVERITY_RANK = { error: 3, warn: 2, info: 1 };

/** Normalize an issue to ensure the UI always receives complete fields */
function normalise(raw) {
  if (!raw || !raw.code) return null;
  const severity = SEVERITY_RANK[raw.severity] ? raw.severity : 'info';
  return {
    code: String(raw.code),
    category: CATEGORY_IDS.includes(raw.category) ? raw.category : 'runtime',
    severity,
    title: String(raw.title || raw.code),
    hint: String(raw.hint || ''),
    // fix is the action name for "one-click fix", mapped by the rendering layer; empty if none
    fix: raw.fix || '',
    // detail is supplementary human-readable information (path, numbers, etc.), not in title
    detail: raw.detail === undefined || raw.detail === null ? '' : String(raw.detail),
  };
}

/**
 * Evaluate: turn observation snapshot into an issue list
 * @param {object} obs Snapshot from probe layer (fields may be omitted)
 * @returns {Array<object>} Normalized issue list
 */
function evaluate(obs) {
  const o = obs || {};
  const runtime = o.runtime || {};
  const device = o.device || {};
  const storage = o.storage || {};
  const settings = o.settings || {};
  const network = o.network || {};
  const logs = o.logs || {};
  const accel = o.accel || {};
  const out = [];

  const push = (raw) => {
    const it = normalise(raw);
    if (it) out.push(it);
  };

  /* ---------------- Runtime ---------------- */

  // Boot failure: provide the last real reason directly, don't make the user guess
  const bootError = runtime.error || (runtime.lastFailure && runtime.lastFailure.error) || '';
  if (bootError) {
    push({
      code: 'runtime.bootFailed',
      category: 'runtime',
      severity: 'error',
      title: 'Android runtime failed to start last time',
      hint: 'The real runtime error has been obtained. Addressing this reason usually resolves it immediately.',
      detail: bootError,
      fix: 'restartRuntime',
    });
  }

  // Stuck booting: over threshold without being ready, likely a broken snapshot or image issue
  if (runtime.running && runtime.phase && runtime.phase !== 'ready' && runtime.bootMs > 150000) {
    push({
      code: 'runtime.stuckBoot',
      category: 'runtime',
      severity: 'warn',
      title: 'Android boot stuck in startup phase',
      hint: 'Booting has exceeded 2.5 minutes without entering the system. A common cause is a corrupted quick-boot snapshot; restarting the runtime (which performs a cold boot) usually resolves it.',
      detail: `Phase: ${runtime.phase}`,
      fix: 'restartRuntime',
    });
  }

  // Residual lock files: will cause next boot to be judged as "AVD already in use" and fail fatally
  if (Number(runtime.locks) > 0) {
    push({
      code: 'runtime.staleLocks',
      category: 'runtime',
      severity: 'warn',
      title: `Detected ${runtime.locks} leftover lock file(s) from last run`,
      hint: 'Uncleared lock files cause the next boot to fail because the AVD is seen as occupied. Can be cleared with one click.',
      fix: 'lock',
    });
  }

  // Orphan processes: emulator.exe is just a launcher, qemu is a detached independent process;
  // killing only the launcher leaves orphans holding multiinstance.lock.
  if (Number(runtime.orphans) > 0) {
    push({
      code: 'runtime.orphanProcesses',
      category: 'runtime',
      severity: 'warn',
      title: `${runtime.orphans} leftover emulator process(es) detected`,
      hint: 'Android processes from an unclean shutdown are still holding resources and AVD locks, which will cause the next boot to fail. Can be cleaned up with one click (installed apps and data are untouched).',
      fix: 'orphans',
    });
  }

  // Hollow snapshot: file exists but fails verification, causing every boot to fail loading and cold boot, wasting several GB
  if (runtime.snapshotStale) {
    push({
      code: 'runtime.staleSnapshot',
      category: 'runtime',
      severity: 'warn',
      title: 'Quick boot snapshot is corrupted',
      hint: 'The snapshot file exists but verification fails, causing an extra cold boot on every launch. Deleting it will reclaim disk space with a one-time cold boot.',
      fix: 'snapshots',
    });
  }

  /* ---------------- Device Connection ---------------- */

  // unauthorized: Android showed "Allow USB debugging?" but nobody clicked it
  if (device.state === 'unauthorized') {
    push({
      code: 'device.unauthorized',
      category: 'device',
      severity: 'error',
      title: 'Android device unauthorized for debugging',
      hint: 'Android showed "Allow USB debugging?" but it was not confirmed, so adb cannot connect. Restarting the runtime (cold boot) will show the confirmation dialog again.',
      fix: 'restartRuntime',
    });
  } else if (device.state === 'offline') {
    push({
      code: 'device.offline',
      category: 'device',
      severity: 'warn',
      title: 'Android device is offline',
      hint: 'adb can see the device but cannot connect, usually because the VM is still booting or the adb handshake has not finished. If it does not recover shortly, restart the runtime.',
      fix: 'restartRuntime',
    });
  } else if (runtime.running && device.checked && device.state === 'no-device') {
    push({
      code: 'device.missing',
      category: 'device',
      severity: 'warn',
      title: 'Runtime is running, but adb does not see the device',
      hint: 'The Android process is active but adb cannot see the device, likely because the adb port is occupied by another program or boot is not complete.',
      fix: 'restartRuntime',
    });
  }

  /* ---------------- Storage ---------------- */

  const freeMB = Number(storage.freeMB) || 0;
  if (freeMB > 0 && freeMB < 2048) {
    push({
      code: 'storage.diskCritical',
      category: 'storage',
      severity: 'error',
      title: 'Runtime disk is almost full',
      hint: 'Less than 2 GB remaining; app installation and snapshot writing will fail. Click "One-Click Cleanup" to reclaim old images, old snapshots, and logs.',
      detail: `${freeMB} MB free`,
      fix: 'disk',
    });
  } else if (freeMB > 0 && freeMB < 8192) {
    push({
      code: 'storage.diskLow',
      category: 'storage',
      severity: 'warn',
      title: 'Runtime disk space is low',
      hint: 'Less than 8 GB remaining; snapshots and system images require space. It is recommended to clean up reclaimable files.',
      detail: `${freeMB} MB free`,
      fix: 'disk',
    });
  }

  // Data partition actual capacity smaller than configured -> installed games show "Insufficient storage space"
  if (storage.needsReset) {
    push({
      code: 'storage.dataNeedsReset',
      category: 'storage',
      severity: 'warn',
      title: 'Data partition expansion has not taken effect',
      hint: 'The differential disk used by quick boot prevents in-place expansion, so the guest still sees the old capacity. Resetting Android data will recreate it with the new size (installed apps will be cleared).',
      detail: `Configured: ${storage.configuredGB} GB · Actual: ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  } else if (Number(storage.configuredGB) > 0 && Number(storage.actualGB) > 0
    && Number(storage.configuredGB) > Number(storage.actualGB)) {
    push({
      code: 'storage.dataMismatch',
      category: 'storage',
      severity: 'error',
      title: 'Android data partition is smaller than configured',
      hint: 'Actual available capacity in Android is smaller than the setting; installing large games will report insufficient storage.',
      detail: `Configured: ${storage.configuredGB} GB · Actual: ${storage.actualGB} GB`,
      fix: 'dataReset',
    });
  }

  if (storage.sharedOk === false) {
    push({
      code: 'storage.sharedBroken',
      category: 'storage',
      severity: 'warn',
      title: 'Shared directory is unavailable',
      hint: 'The local folder used for file sharing does not exist or has no write permission; files saved in Android cannot sync.',
      detail: storage.sharedPath || '',
      fix: 'shared',
    });
  }

  /* ---------------- Settings ---------------- */

  // Orientation policy conflicts with physical panel -> Android only gives a narrow center picture
  const mode = String(settings.orientationMode || 'auto');
  if (mode === 'portrait' && settings.landscape === true) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Screen orientation policy conflicts with panel orientation',
      hint: 'Policy requires portrait, but panel is currently landscape; Android will display a narrow window with black bars on both sides. Changing the panel orientation to match the policy will fix it.',
      fix: 'orientation',
    });
  } else if (mode === 'landscape' && settings.landscape === false) {
    push({
      code: 'settings.orientationConflict',
      category: 'settings',
      severity: 'warn',
      title: 'Screen orientation policy conflicts with panel orientation',
      hint: 'Policy requires landscape, but panel is currently portrait; media/games will display as a narrow vertical window. Changing the panel orientation to match the policy will fix it.',
      fix: 'orientation',
    });
  }

  if (settings.windowEmbed === false && settings.autoFullscreen) {
    push({
      code: 'settings.detachedFullscreen',
      category: 'settings',
      severity: 'info',
      title: '"Auto Fullscreen on Launch" does not take effect in native window mode',
      hint: 'In native window mode, the emulator opens its own window and manages its own fullscreen state, independent of this setting. To fill the screen, press F11 inside the window or switch to embedded window mode.',
    });
  }

  if (settings.keepSnapshot === false && freeMB > 0 && freeMB < 4096) {
    push({
      code: 'settings.snapshotOffLowDisk',
      category: 'settings',
      severity: 'info',
      title: 'Disk space low; quick boot snapshot is disabled',
      hint: 'Current disk space is under 4 GB and snapshots are disabled: launching apps will perform a full cold boot (~tens of seconds). If disk space permits, re-enabling snapshots is recommended.',
      fix: 'settings',
    });
  }

  /* ---------------- Network ---------------- */

  if (network.ok === false) {
    push({
      code: 'network.guestDown',
      category: 'network',
      severity: 'warn',
      title: 'No network in Android',
      hint: 'DNS resolution or networking failed inside Android; video and news apps will keep spinning. Resetting Android data with "Repair Network" can resolve this (app list is preserved).',
      detail: network.reason || '',
      fix: 'repairNetwork',
    });
  }

  const badSources = Array.isArray(network.sources) ? network.sources.filter((s) => s && s.ok === false) : [];
  if (badSources.length) {
    push({
      code: 'network.sourcesDown',
      category: 'network',
      severity: 'warn',
      title: `${badSources.length} download source(s) unreachable`,
      hint: 'Update checks query multiple sources simultaneously; one unreachable source does not affect usage. If all are unreachable, check network or proxy settings.',
      detail: badSources.map((s) => s.name).join(', '),
      fix: 'settings',
    });
  }

  /* ---------------- Logs ---------------- */

  const errLines = Array.isArray(logs.errors) ? logs.errors.filter(Boolean) : [];
  if (errLines.length) {
    push({
      code: 'logs.errors',
      category: 'logs',
      severity: 'warn',
      title: `${errLines.length} error(s) found in runtime logs`,
      hint: 'The most recent run left error records; expand the diagnostic report to see full context.',
      detail: errLines.slice(-1)[0],
      fix: 'report',
    });
  }

  /* ---------------- Acceleration ---------------- */

  if (accel.checked && accel.ok === false) {
    push({
      code: 'accel.softwareEmulation',
      category: 'runtime',
      severity: 'warn',
      title: 'Hardware acceleration is currently unavailable',
      hint: 'Running in pure software emulation; boot can take minutes and frame rate drops easily. Enable "Windows Hypervisor Platform" and restart to resolve.',
      detail: accel.note || '',
      fix: 'virtualization',
    });
  }

  return dedupe(out);
}

/** Keep only the last issue for the same code (later detection overwrites earlier) */
function dedupe(issues) {
  const map = new Map();
  for (const raw of issues || []) {
    const it = normalise(raw);
    if (!it) continue;
    map.set(it.code, it);
  }
  return Array.from(map.values());
}

/** Sort by severity descending */
function bySeverity(a, b) {
  const d = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (d) return d;
  return String(a.code).localeCompare(String(b.code));
}

/** Summarize: counts for status bar, categorization for settings page */
function summarize(issues) {
  const list = dedupe(issues).sort(bySeverity);
  const errors = list.filter((i) => i.severity === 'error').length;
  const warns = list.filter((i) => i.severity === 'warn').length;
  const infos = list.filter((i) => i.severity === 'info').length;
  const byCategory = CATEGORIES.map((c) => {
    const items = list.filter((i) => i.category === c.id);
    return {
      id: c.id,
      name: c.name,
      count: items.length,
      errors: items.filter((i) => i.severity === 'error').length,
    };
  });
  return {
    total: list.length,
    errors,
    warns,
    infos,
    byCategory,
    // Easily see if there is an issue that must be addressed immediately
    health: errors ? 'error' : (warns ? 'warn' : (infos ? 'info' : 'ok')),
  };
}

/** Group by category for settings page rendering */
function groupByCategory(issues) {
  const list = dedupe(issues).sort(bySeverity);
  return CATEGORIES.map((c) => ({
    ...c,
    items: list.filter((i) => i.category === c.id),
  })).filter((g) => g.items.length);
}

/**
 * Compare two detection results: identify "newly added" and "resolved" issues.
 * Auto-detection only notifies the user when new issues arise; resolved ones are quietly recorded -
 * popping up "3 items resolved" every time becomes noisy.
 */
function diff(prevIssues, nextIssues) {
  const prev = new Map((prevIssues || []).map((i) => [i.code, i]));
  const next = new Map((nextIssues || []).map((i) => [i.code, i]));
  const added = [];
  const resolved = [];
  for (const [code, it] of next) {
    const before = prev.get(code);
    if (!before || before.severity !== it.severity) added.push(it);
  }
  for (const [code, it] of prev) {
    if (!next.has(code)) resolved.push(it);
  }
  return { added, resolved };
}

module.exports = {
  CATEGORIES,
  CATEGORY_IDS,
  SEVERITY_RANK,
  normalise,
  evaluate,
  dedupe,
  summarize,
  groupByCategory,
  diff,
  bySeverity,
};
