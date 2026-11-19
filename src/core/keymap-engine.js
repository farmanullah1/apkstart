'use strict';
/**
<<<<<<< HEAD
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
=======
 * 按键映射运行时引擎
 *
 * 在应用窗口前台时，拦截键盘事件 → 查当前应用的映射表 → 转成 adb input 命令。
 * 与 pointer.js（鼠标钩子）并行工作：鼠标走 Qt 原生 + 右键/滚轮钩子，
 * 键盘走这里。两者互不干扰。
 *
 * 设计约束：
 *  - 纯 Node 模块，不依赖 Electron BrowserWindow（方便单测）；
 *  - adb 命令通过注入的 `execInput(cmd)` 回调发送，解耦 AdbClient；
 *  - 每条命令有最小间隔（默认 50ms），防止快速连按时 adb shell 排队卡死；
 *  - 映射表按应用包名存储，切换应用时自动切换。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */

const { lookup, toCommand } = require('./keymap');

class KeymapEngine {
  /**
   * @param {object} opts
<<<<<<< HEAD
   * @param {Function} opts.execInput  (cmd) => Promise — dispatches adb shell input command
   * @param {Function} opts.getSize    () => {width, height} — current LCD dimensions
   * @param {number}   [opts.minInterval=50]  minimum interval between consecutive commands (ms)
=======
   * @param {Function} opts.execInput  (cmd) => Promise — 发送 adb shell input 命令
   * @param {Function} opts.getSize    () => {width, height} — 当前 LCD 尺寸
   * @param {number}   [opts.minInterval=50]  两条命令之间的最小间隔（ms）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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

<<<<<<< HEAD
  /** Sets mapping table for a package */
=======
  /** 设置某个应用的映射表 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  setMap(pkg, mappings) {
    if (!pkg) return;
    if (!mappings || !mappings.length) { this._maps.delete(pkg); return; }
    this._maps.set(pkg, mappings);
  }

<<<<<<< HEAD
  /** Gets mapping table for a package */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** Enables or disables keymapping */
=======
  /** 获取某个应用的映射表 */
  getMap(pkg) { return this._maps.get(pkg) || []; }

  /** 启用/禁用 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  enable(on) { this._enabled = !!on; }
  get enabled() { return this._enabled; }

  /**
<<<<<<< HEAD
   * Handles a keyboard event.
   * @param {string} key Electron KeyboardEvent.key
   * @param {string} pkg Package name of active app
   * @returns {Promise<boolean>} Whether key event was consumed (true = mapped and sent)
=======
   * 处理一个键盘事件。
   * @param {string} key Electron KeyboardEvent.key
   * @param {string} pkg 当前前台应用包名
   * @returns {Promise<boolean>} 是否消费了这个按键（true = 已映射并发送）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // Rate limit: prevents adb shell backlog on rapid repeated keystrokes
=======
    // 限流：防止快速连按时 adb shell 排队
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const now = Date.now();
    const wait = Math.max(0, this._minInterval - (now - this._lastExec));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastExec = Date.now();
<<<<<<< HEAD
    try { await this._exec(cmd); } catch (_) { /* Injection failures should not disrupt application */ }
=======
    try { await this._exec(cmd); } catch (_) { /* 输入注入失败不影响游戏 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return true;
  }
}

module.exports = { KeymapEngine };
