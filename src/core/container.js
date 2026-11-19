'use strict';
/**
 * Application-level container (pure computation layer).
 * Coordinates cold boot orchestration, background memory reclaiming, and process lifecycle.
 */

/** Must never be trimmed: modifying these causes black screens or crashes */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Disabled only in deep trimming: background-only services (print, updater, screensaver) */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (background updates)
  'com.google.android.setupwizard',         // Setup wizard
  'com.android.printspooler',               // Print spooler
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // Screensaver
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** System/framework packages: excluded from session trimming */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Validates Android package names against shell injection */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Trimming commands to run when launching an app.
 * @param {object} o
 * @param {string} o.pkg            Package being launched
 * @param {string[]} o.installed    List of installed packages
 * @param {boolean} o.deep          Deep trimming (disable optional system services)
 * @param {boolean} o.killBackground Whether to kill cached background processes
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Kill cached background processes (excludes foreground and persistent services)
  // to ensure memory is physically released.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // Restrict background data on metered connections to avoid wake-locks
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * Idle commands to run when closing the last app, letting Android idle without consuming CPU.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Re-enables packages disabled during deep trimming (invoked when user turns setting off) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Session state machine: determines container state after launch / close events.
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** Diagnostic summary line for logs */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container idle (Android resident with lowered priority, 0 app processes)';
  return `Container active: ${n} app window(s)${plan && plan.stopped && plan.stopped.length
    ? `, stopped ${plan.stopped.length} background app(s)` : ''}`;
}

/**
 * Multi-window session state machine.
 * Distinguishes foreground active app from background apps, managing memory tombstone states.
 * @param {string[]} active        List of currently active package names
 * @param {string} foreground      Current foreground package (or null)
 * @returns {{foreground:string|null, background:string[], count:number}}
 */
function sessionRoles(active = [], foreground = null) {
  const set = (active || []).filter(Boolean);
  const fg = foreground && set.includes(foreground) ? foreground : (set.length ? set[set.length - 1] : null);
  return {
    foreground: fg,
    background: set.filter((p) => p !== fg),
    count: set.length,
  };
}

/**
 * Determines which background apps should be tombstoned (force-stopped to reclaim memory).
 * Policy: never touches foreground; skips system packages; keeps recent N apps; tombstones the rest.
 * @param {object} o { background, installedSystem?, keepRecent?, tombstone? }
 * @returns {{tombstone:string[], keep:string[]}}
 */
function planTombstones({ background = [], keepRecent = 1 } = {}) {
  const bg = (background || []).filter((p) => p && !isSystemPackage(p) && !NEVER_TRIM.includes(p));
  // background array ends with most recent; keep last keepRecent apps, tombstone the rest
  const keepCount = Math.max(0, Number(keepRecent) || 0);
  const keep = bg.slice(Math.max(0, bg.length - keepCount));
  const tombstone = bg.filter((p) => !keep.includes(p));
  return { tombstone, keep };
}

/** Generates tombstone commands: force-stops background packages to free memory */
function buildTombstoneCommands(pkgs = []) {
  return pkgs.filter((p) => SAFE_PKG.test(String(p))).map((p) => `am force-stop ${p}`);
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
  sessionRoles, planTombstones, buildTombstoneCommands,
};
