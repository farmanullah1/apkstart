'use strict';
/**
 * Windows Window Agent: communicates with the resident process in src/core/win/agent.ps1.
 *
 * Why not spawn a PowerShell process every time: resizing during window dragging happens frequently,
 * and spawning powershell.exe takes 150-300ms each time, causing stutter.
 * Here it starts only once and communicates over local loopback TCP (one JSON per line), with round-trip <2ms.
 *
 * The agent optionally manages the WH_MOUSE_LL mouse hook: right-click back / wheel swipe / side button forward and back.
 * This hook is global and intercepts every mouse event in the OS, so it is installed only when the app window
 * is foreground and at least one mapping is enabled; uninstalled immediately on blur.
 * See setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Start agent and wait until TCP connected (idempotent) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Window agent is unavailable')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Window agent has exited');
        if (wasReady) this.emit('exit');
        fail(new Error('Failed to start window agent'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Window agent start timed out')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Window agent connection disconnected');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Events carry payloads (dx/dy/nx/ny for wheel); older listeners ignore extra parameters
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Send a command and wait for response */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Window agent is not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Window agent timed out: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- Convenience Methods ----------------

  /**
   * Declare which process directories belong to us.
   * Must be called before bootHide / embed: window agent is only permitted to touch windows created by these processes.
   * If omitted or empty, agent touches no windows.
   * @param {string[]} dirs Runtime root directory / bundled engine directory
   * @param {number} [appPid] Main process pid: agent only embeds into windows of this process
   */
  async scope(dirs, appPid) {
    /**
     * Directories must be resolved to real paths before passing to the agent.
     * The agent checks process ownership using the executable path prefix,
     * and Windows Process.MainModule.FileName returns the resolved real path.
     */
    const raw = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const list = [];
    for (const d of raw) {
      try {
        const real = fs.realpathSync.native ? fs.realpathSync.native(d) : fs.realpathSync(d);
        if (real) list.push(real);
      } catch (_) { /* Directory does not exist, keep original path */ }
      list.push(d);
    }
    const uniq = [...new Set(list.filter(Boolean))];
    const req = { cmd: 'scope', dirs: uniq.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /**
   * Embed display window into host window and position at x,y,w,h (host client coordinates).
   *
   * @param {number|string} hostHwnd Host window handle
   * @param {object} rect { x, y, w, h, clipTop }
   * @param {string[]} [targets] Candidate handles reported by third-party backends ("0x…").
   *        Omitted = legacy behavior: agent searches for bundled emulator window by process scope.
   */
  async embed(hostHwnd, rect, targets = null) {
    const req = {
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    };
    if (Array.isArray(targets) && targets.length) {
      req.target = targets.map((t) => String(t)).join(',');
    }
    return this.call(req, 6000);
  }

  /** Check how many candidate handles currently exist (readiness gate for third-party backends) */
  async windowReady(targets = []) {
    if (!Array.isArray(targets) || !targets.length) return { ok: false, alive: 0 };
    return this.call({ cmd: 'winready', target: targets.join(',') }, 3000)
      .catch(() => ({ ok: false, alive: 0 }));
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // The Qt emulator window has EMU_PAD outer border beyond the LCD; clip it at the top
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Notify agent to enter low-latency mode: reduce window scan frequency to yield CPU to Android rendering */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  /** @param {boolean} keep true=switch to detached window mode (do not hide emulator window, keep handle) */
  async detach(keep = false) { return this.call({ cmd: 'detach', keep: keep ? 1 : 0 }, 5000); }
  /** Detached window mode: place emulator native window at specified screen rect (without embedding) */
  async layout(rect) {
    return this.call({
      cmd: 'layout',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    }, 4000);
  }
  /**
   * Set emulator native window title from "Android Emulator - apkstart:5554" to a user-friendly name.
   * Defaults to "ApkStart" if empty. Agent continuously re-applies in maintenance loop.
   */
  async setTitle(text = 'ApkStart') {
    return this.call({ cmd: 'title', text: String(text || 'ApkStart') }, 4000);
  }
  /**
   * Set icon for emulator native window (displayed in taskbar / Alt+Tab in detached window mode).
   * @param {string} file Absolute path to PNG/ICO
   */
  async setIcon(file) {
    return this.call({ cmd: 'icon', file: String(file || '') }, 4000);
  }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** List currently visible top-level windows (for verifying window isolation) */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * Detach and hide the primary suspicious window.
   * Must be called before host window destruction to prevent an orphan black window on desktop.
   * Gives a 700ms hard deadline.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Enable resident suppression: hide emulator main window (QWindowIcon) + toolbar + qemu / netsimd console windows,
   * except the one embedded in our window.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Disable resident suppression */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Global mouse hook toggle (idempotent).
   * Installed only when app window is foreground and at least one mapping is enabled;
   * when opts change, sends updated config to resident agent without restarting thread.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Do not spawn PowerShell process just to turn off when already off (zero cold start cost)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  dispose() {
    // Uninstall global hook before terminating process
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // Intentionally do not kill agent process: after disconnect it enters guardian mode (_lingerUntil).
    // The emulator may still be booting; agent will exit on its own once emulator disappears (up to 3 minutes).
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
