'use strict';
/**
 * Screen orientation resolution (pure functions, no Electron / adb / network dependencies, testable in CI).
 *
 * Centralizes orientation logic across the application (auto, title bar rotate, tray rotate)
 * to maintain a single source of truth and predictable panel behavior.
 */

const ORIENTATION_MODES = ['auto', 'landscape', 'portrait'];

/**
 * Determines whether an application should run in landscape or portrait.
 *
 * Precedence (high → low):
 *   1. Settings forced mode ('landscape' / 'portrait')
 *   2. Per-app manual override ('orientationOverride', toggled via rotate button / context menu)
 *   3. Native orientation parsed from APK manifest ('orientation')
 *   4. Current panel orientation (preserves current state when set to sensor-driven)
 */
function resolveLandscape({ mode = 'auto', orientation = null, orientationOverride = null, panelLandscape = false } = {}) {
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  if (orientationOverride === 'landscape') return true;
  if (orientationOverride === 'portrait') return false;
  if (orientation === 'landscape') return true;
  if (orientation === 'portrait') return false;
  return !!panelLandscape;
}

/** Inverts orientation for rotation button: landscape ↔ portrait */
function flipLandscape(current) {
  return !current;
}

/** Override text format: true → 'landscape', false → 'portrait' (persisted in apps.json) */
function overrideValue(landscape) {
  return landscape ? 'landscape' : 'portrait';
}

/** Parses stored override string; returns null if unset or invalid */
function parseOverride(value) {
  if (value === 'landscape') return true;
  if (value === 'portrait') return false;
  return null;
}

/**
 * Default value for in-guest "Auto-rotate" toggle.
 * Returns '0' or '1' string for Settings.System.ACCELEROMETER_ROTATION.
 */
function autoRotateSetting(settings) {
  const d = (settings && settings.display) || {};
  return d.autoRotate === false ? '0' : '1';
}

module.exports = {
  ORIENTATION_MODES,
  resolveLandscape,
  flipLandscape,
  overrideValue,
  parseOverride,
  autoRotateSetting,
};
