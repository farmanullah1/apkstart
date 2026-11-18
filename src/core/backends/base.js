'use strict';
/**
 * Backend driver layer: abstracts runtime provider implementation details.
 * Sole supported implementation: builtin (bundled Google Android Emulator / QEMU).
 */

/** Capability flags for backend feature detection */
const CAPS = {
  /** Supports automatic download/deployment of runtime components */
  provision: 'provision',
  /** Supports snapshot saves for instantaneous subsequent boots */
  snapshot: 'snapshot',
  /** Supports userdata partition resizing */
  resizeData: 'resizeData',
  /** Supports factory data reset (/data) */
  resetData: 'resetData',
  /** Supports hardware display orientation modification */
  rotatePanel: 'rotatePanel',
  /** Supports VM process priority adjustments */
  priority: 'priority',
  /** Supports clean full termination */
  shutdown: 'shutdown',
  /** Window created by external software */
  sharedHost: 'sharedHost',
};

class Backend {
  /**
   * @param {object} appRoot Application root directory
   * @param {object} deps    Shared dependencies: { store, log }
   */
  constructor(appRoot, deps = {}) {
    this.appRoot = appRoot || '';
    this.deps = deps || {};
    /** adb serial (e.g. emulator-5554 / 127.0.0.1:16384) */
    this.serial = '';
    /** Absolute path to adb.exe */
    this.adbPath = '';
    /** Last diagnostic error */
    this.lastError = '';
  }

  /** Stable backend id (written to settings) */
  static get id() { return 'base'; }

  /** Display label */
  static get label() { return 'Unnamed Backend'; }

  /** Description for settings page */
  static get summary() { return ''; }

  /** Meets embedded window criteria */
  static get embedCapable() { return false; }

  get id() { return this.constructor.id; }

  get label() { return this.constructor.label; }

  /** Set of supported capability flags (see CAPS) */
  get caps() {
    return new Set();
  }

  has(cap) { return this.caps.has(cap); }

  /** Whether the runtime process is currently running */
  running() { return false; }

  /**
   * Probes for backend availability on this machine.
   * @returns {Promise<{ok:boolean, found:boolean, path?:string, detail?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async probe() { return { ok: true, found: false }; }

  /**
   * Readiness check.
   * @returns {Promise<{ok:boolean, reason?:string, needs?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async check() { return { ok: false, reason: 'Not implemented' }; }

  /** Resolves available adb path */
  async resolveAdb() { return ''; }

  /**
   * Ensures runtime is ready and connected.
   * @param {object} o { onLog }
   * @returns {Promise<{ok:boolean, serial?:string, adbPath?:string, reused?:boolean, error?:string}>}
   */
  // eslint-disable-next-line class-methods-use-this
  async ensure(o = {}) { return { ok: false, error: 'Not implemented' }; }

  /**
   * Candidate HWNDs for the display window.
   * @returns {Promise<string[]>}
   */
  // eslint-disable-next-line class-methods-use-this
  async windowTargets() { return []; }

  /**
   * Checks if display window is ready for embedding.
   * @param {object} o { isEmbedded?: () => boolean }
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async windowReady(o = {}) { // eslint-disable-line no-unused-vars
    const targets = await this.windowTargets().catch(() => []);
    return targets.length ? { ok: true } : { ok: false, reason: 'no-window' };
  }

  /**
   * Hides the display window during boot/warmup.
   * @returns {Promise<string|null>} Hidden HWND
   */
  async hideWindow() { return null; }

  /** Stops runtime */
  // eslint-disable-next-line class-methods-use-this
  async stop(o = {}) { return { ok: false, error: 'Not implemented' }; }

  /** Deploys missing components */
  // eslint-disable-next-line class-methods-use-this
  async install(component, onProgress) { return { ok: false, error: 'Backend does not support auto-provisioning' }; }

  /** Storage usage breakdown for settings */
  // eslint-disable-next-line class-methods-use-this
  usage() { return { total: 0, items: [] }; }

  /** Data partition metadata */
  // eslint-disable-next-line class-methods-use-this
  dataInfo() { return { ok: false }; }

  /** Resizes data partition */
  // eslint-disable-next-line class-methods-use-this
  async resizeData(mb) { return { ok: false, error: 'Backend does not support resizing data partition' }; }

  /** Factory resets Android user data */
  // eslint-disable-next-line class-methods-use-this
  async resetData() { return { ok: false, error: 'Backend does not support resetting data' }; }

  /** Releases resources on quit */
  // eslint-disable-next-line class-methods-use-this
  dispose() {}

  /** Diagnostic info for bug reports */
  // eslint-disable-next-line class-methods-use-this
  diagnose() { return {}; }
}

module.exports = { Backend, CAPS };
