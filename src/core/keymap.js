'use strict';
/**
 * Game keymapping —— Pure data layer
 *
 * Maps keyboard keys to Android touch coordinates. Each entry:
 *   { key: 'w', action: 'tap', x: 0.15, y: 0.85 }   // Relative coordinates (0~1)
 *   { key: 'space', action: 'tap', x: 0.5, y: 0.9 }
 *   { key: 'j', action: 'swipe', x1: 0.7, y1: 0.5, x2: 0.3, y2: 0.5, duration: 100 }
 *
 * Coordinates are normalized to LCD panel (0~1), scaled by runtime wm size.
 *
 * Preset templates for common game categories:
 *   - fps: WASD movement joystick area + mouse aim (mouse handled natively via Qt)
 *   - rpg: WASD movement + J/K/L skills + Space confirm
 *   - generic: Arrow keys + Enter/Space
 */

const PRESETS = {
  fps: {
    label: 'FPS / Shooter',
    desc: 'WASD for left virtual joystick area, J shoot, K reload, Space jump',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.85, y: 0.75 },
      { key: 'k', action: 'tap', x: 0.92, y: 0.82 },
      { key: ' ', action: 'tap', x: 0.78, y: 0.82 },
    ],
  },
  rpg: {
    label: 'RPG / Action',
    desc: 'WASD movement, J attack, K skill, L ultimate, Space interact/confirm',
    mappings: [
      { key: 'w', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'a', action: 'tap', x: 0.08, y: 0.82 },
      { key: 's', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'd', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'j', action: 'tap', x: 0.82, y: 0.78 },
      { key: 'k', action: 'tap', x: 0.90, y: 0.78 },
      { key: 'l', action: 'tap', x: 0.86, y: 0.70 },
      { key: ' ', action: 'tap', x: 0.5, y: 0.92 },
    ],
  },
  generic: {
    label: 'Casual / Generic',
    desc: 'Arrow keys movement, Enter confirm, Space back/cancel',
    mappings: [
      { key: 'ArrowUp', action: 'tap', x: 0.15, y: 0.75 },
      { key: 'ArrowLeft', action: 'tap', x: 0.08, y: 0.82 },
      { key: 'ArrowDown', action: 'tap', x: 0.15, y: 0.89 },
      { key: 'ArrowRight', action: 'tap', x: 0.22, y: 0.82 },
      { key: 'Enter', action: 'tap', x: 0.5, y: 0.92 },
      { key: ' ', action: 'keyevent', code: 4 },  // BACK
    ],
  },
};

/**
 * Normalizes Electron key names to the mapping format.
 * Examples: 'w', 'W', 'ArrowUp', ' ', 'Enter'.
 */
function normalizeKey(key) {
  if (!key) return '';
  // Normalize single letters to lower case
  if (key.length === 1 && /[A-Za-z]/.test(key)) return key.toLowerCase();
  return key;
}

/**
 * Looks up key action in current mapping table.
 * @param {Array} mappings Mappings array
 * @param {string} key Electron KeyboardEvent.key
 * @returns {object|null} Matched mapping entry
 */
function lookup(mappings, key) {
  const nk = normalizeKey(key);
  if (!nk || !Array.isArray(mappings)) return null;
  return mappings.find((m) => normalizeKey(m.key) === nk) || null;
}

/**
 * Converts a mapping entry + LCD dimensions to an adb shell command.
 * @param {object} mapping Mapping entry
 * @param {number} width LCD width (px)
 * @param {number} height LCD height (px)
 * @returns {string} adb shell command (e.g. 'input tap 192 612')
 */
function toCommand(mapping, width, height) {
  if (!mapping) return '';
  if (mapping.action === 'tap') {
    const x = Math.round(mapping.x * width);
    const y = Math.round(mapping.y * height);
    return `input tap ${x} ${y}`;
  }
  if (mapping.action === 'swipe') {
    const x1 = Math.round(mapping.x1 * width);
    const y1 = Math.round(mapping.y1 * height);
    const x2 = Math.round(mapping.x2 * width);
    const y2 = Math.round(mapping.y2 * height);
    const dur = mapping.duration || 100;
    return `input swipe ${x1} ${y1} ${x2} ${y2} ${dur}`;
  }
  if (mapping.action === 'keyevent') {
    return `input keyevent ${mapping.code}`;
  }
  return '';
}

module.exports = { PRESETS, normalizeKey, lookup, toCommand };
