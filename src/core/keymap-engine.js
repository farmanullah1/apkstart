'use strict';
/**
 * Keymap runtime engine.
 *
 * When an app window is focused: intercepts keyboard events → looks up mapping for current app → converts to adb input command.
 * Works alongside pointer.js (mouse hooks).
 *
 * Design constraints:
 *  - Pure Node module without Electron BrowserWindow dependency (easy unit testing)
 *  - Dispatches adb commands via injected `execInput(cmd)` callback
 *  - Rate-limits command emission (default 50ms) to prevent queuing latency
 *  - Stores key mappings indexed by package name
 */

const { lookup, toCommand } = require('./keymap');

class KeymapEngine {
  /**
   * @param {object} opts
   * @param {Function} opts.execInput  (cmd) => Promise — dispatches adb shell input command
   * @param {Function} opts.getSize    () => {width, height} — current LCD dimensions
   * @param {number}   [opts.minInterval=50]  minimum interval between consecutive commands (ms)
   */
  constructor({ execInput, getSize, minInterval = 50 } = {}) {
    this._exec = execInput || (() => Promise.resolve());
    this._getSize = getSize || (() => ({ width: 720, height: 1280 }));
    this._minInterval = minInterval;
    this._lastExec = 0;
    this._enabled = false;
    // pkg → mappings[]
    this._maps = new Map();
  }

  /** Sets mapping table for a package */
  setMap(pkg, mappings) {
    if (!pkg) return;
    if (!mappings || !mappings.length) { this._maps.delete(pkg); return; }
    this._maps.set(pkg, mappings);
  }

  /** Gets mapping table for a package */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** Enables or disables keymapping */
  enable(on) { this._enabled = !!on; }
  get enabled() { return this._enabled; }

  /**
   * Handles a keyboard event.
   * @param {string} key Electron KeyboardEvent.key
   * @param {string} pkg Package name of active app
   * @returns {Promise<boolean>} Whether key event was consumed (true = mapped and sent)
   */
  async handleKey(key, pkg) {
    if (!this._enabled || !pkg) return false;
    const mappings = this._maps.get(pkg);
    if (!mappings || !mappings.length) return false;
    const hit = lookup(mappings, key);
    if (!hit) return false;
    const { width, height } = this._getSize();
    const cmd = toCommand(hit, width, height);
    if (!cmd) return false;
    // Rate limit: prevents adb shell backlog on rapid repeated keystrokes
    const now = Date.now();
    const wait = Math.max(0, this._minInterval - (now - this._lastExec));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastExec = Date.now();
    try { await this._exec(cmd); } catch (_) { /* Injection failures should not disrupt application */ }
    return true;
  }
}

module.exports = { KeymapEngine };
