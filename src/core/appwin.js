'use strict';
/**
 * App window: a running Android app = a clean Windows window.
 *
 * Inside the window there is only a 38px titlebar at the top (rotate / minimize / maximize / close).
 * The entire area below is the embedded emulator window (SetParent), so the Android desktop and
 * emulator sidebar toolbar are hidden, and no second taskbar icon appears.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { physicalRect } = require('./geometry');

const TITLEBAR_H = 38;
/**
 * The emulator window has an 8px grey inner padding on all sides (Qt border padding),
 * while the real LCD display starts at +8px. By enlarging the child window by 16px and
 * offsetting by -8px to the top-left, this grey border is pushed outside the client area,
 * cleanly filling the viewport.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // Source of candidate handles for display window: now only one base, always null;
    // window agent finds emulator-created windows by process scope.
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // Global mouse hook is only installed when "app window is foreground + at least one mapping is enabled".
    // pointerConfig passed as function: when settings change, takes effect on next focus without restart.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Target dimensions for window content in portrait / landscape (automatically scaled to fit screen) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Leave sufficient margin: titlebar 38 + top/bottom 24 each, left/right 40 each
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Double insurance: never exceed screen available area to prevent system clipping / black bars
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    // workArea is in DIP (logical pixels). Window agent process is per-monitor DPI-aware;
    // SetWindowPos receives physical pixels, so in detached mode values passed to agent.layout
    // must be multiplied by sf. sf and area come from the same display, preventing mismatched scaling.
    return { x: a.x, y: a.y, w: a.width, h: a.height, sf: d.scaleFactor || 1 };
  }

  /**
   * The emulator native window locks aspect ratio to the device panel.
   * Calculate target w/h ratio (including titlebar height) to set correct dimensions in one go.
   * In detached window mode, the shell window is hidden and bounds might be portrait defaults,
   * so adjust by panel orientation (in landscape, width > height, ratio > 1).
   */
  _panelRatio() {
    const b = this.win ? this.win.getBounds() : this._area();
    if (b && b.width > 0 && b.height > 0) {
      // Under landscape panel, shell window bounds might still be portrait (hidden in detached mode);
      // reading directly yields 0.56 (9:16), while the actual panel is 16:9.
      // Use portrait h/w as width (landscape = portrait panel rotated 90 deg)
      if (this.state.landscape && b.height > b.width) {
        return b.height / b.width;
      }
      return b.width / b.height;
    }
    return 0.5625; // Portrait 9:16 fallback
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Convert a DIP (logical pixel) rectangle to physical pixels for window agent's SetWindowPos.
   * Electron screen/BrowserWindow coordinates are DIP; agent.ps1 declares per-monitor v2 DPI awareness,
   * so Win32 SetWindowPos receives physical pixels. Mixing them caused the 125%/150% scaling bug (issue #99).
   */
  _physical(rect, sf) {
    return physicalRect(rect, sf);
  }

  /**
   * Open (or reuse) the app window.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached,
   *                     showWhileWaiting, onClosed }
   *        detached=true: "detached window mode" - shell window loads but remains hidden, display is in emulator native window.
   *        showWhileWaiting=true: during the wait period, show shell window first (with prompt text),
   *        then hide it via openDetached() once emulator window connects. Switching to an app with different orientation
   *        requires restarting runtime (~40s); previously the screen was empty and users assumed a crash.
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached } = o;
    this.detachedMode = !!detached;
    this.waitingForRestart = false;
    this._showWhileWaiting = !!o.showWhileWaiting;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      // In detached window mode the shell window should never be shown (it has no content, just black).
      // Clicking the same app again means "bring currently viewed window to front",
      // delegated to window agent to raise the emulator native window.
      if (this.detachedMode) this.agent.show().catch(() => {});
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    // Remember original icon file path: in detached mode pass it to emulator native window
    // (Win32 LoadImage only accepts file paths, not data URLs used by HTML).
    this.iconFilePath = iconPath || '';
    this.portrait = portrait || { w: 540, h: 960 };
    // In detached mode "fullscreen" applies to emulator window (our shell is hidden;
    // maximizing a hidden window has no visual effect; openDetached reads this flag).
    this._wantFullscreen = !!fullscreen;
    this.state = { label: label || 'App', tip: 'Starting Android runtime...', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // Page title changes window title to shell.html <title>, making the taskbar lose the app identity;
    // intercept it here so OS title always matches the app name (relied on by taskbar tooltip, Alt+Tab).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* Window might be destroyed */ }
    });
    this.win.once('ready-to-show', () => {
      // In detached window mode, Android display is in the emulator's native window; our shell has no content.
      // Keeping it would show an extra black empty window. Load only, do not show (shell remains for state/close logic).
      // Exception: showWhileWaiting (switching apps without splash animation) - show the waiting prompt shell rather than an empty desktop for 40s.
      if (this.detachedMode && !this._showWhileWaiting) return;
      this.win.show();
      this._push();
    });

    // When Electron maximizes, window size stabilizes across several steps (OS animation, DPI recalculation).
    // A single 40ms debounce often catches an intermediate state, causing embedded screen to fill only top-left.
    // Instead, use multi-round convergence, recalculating by getContentBounds on each round.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() wraps up after park completes
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // Closing without close() (Alt+F4, taskbar close, system shutdown) must also stop Android app
      // and detach emulator window. Otherwise app runs in background and reopening just switches to it.
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Install global mouse hook only when app window is truly foreground and at least one mapping is enabled;
    // uninstall immediately on blur/close so ApkStart never slows down the system mouse in background.
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    // Note: maximize() displays a show:false window directly.
    // In detached mode display is in emulator native window, so maximizing here shows a black shell in screen center.
    if (fullscreen && !this.detachedMode) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // In game/low-latency mode do not install global mouse hook: WH_MOUSE_LL synchronously callbacks
    // on every desktop mouse event, adding pointer latency; FPS needs raw input directly in Qt window.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Settings page changed mouse mapping: re-sync by current focus (without reinstalling hook thread) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // Window not foreground: uninstall only, avoid idle hook in background
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  /**
   * Temporarily reveal shell window in detached window mode.
   *
   * Scenario: switching to an app with a different orientation restarts Android runtime (~40s),
   * during which emulator native window is destroyed and new window is not yet created.
   * Explicitly call before/after restart: show shell with prompt, hide via openDetached() once connected.
   */
  showWaiting(tip) {
    if (!this.isOpen) return false;
    // Mark "waiting for restart": pre-attach polling in boot phase will yield to avoid prematurely hiding the shell
    this.waitingForRestart = true;
    if (tip) this.state = { ...this.state, tip, ready: false };
    this._push();
    try {
      this.win.show();
      this.win.moveTop();
    } catch (_) {
      return false;
    }
    return true;
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* Window might have just closed */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Detached window mode: do NOT embed emulator into our window; let it open its own native window.
   *
   * Why have this path: SetParent causes Z-order issues, black borders, coordinate mapping bugs,
   * incomplete maximization, and aspect ratio conflicts between Qt panel and host window.
   * Under detached window mode, emulator window is a native window: orientation, scaling, and input
   * are managed by it directly.
   *
   * @returns {Promise<boolean>} Whether detached mode was successfully opened
   */
  async openDetached() {
    // If shell window is closed, there is nothing to host.
    // Record reason: otherwise upper-level logs only show "unknown".
    if (!this.isOpen) { this.lastEmbedError = 'shell-closed'; return false; }
    // Start taking over, wait flag ends here
    this.waitingForRestart = false;
    // Shell window must not be visible in detached mode (it has no content, just black).
    // In showWhileWaiting it is visible as a waiting prompt; hide it here.
    try { this.win.hide(); } catch (_) { /* ignore */ }
    // Ensure it is detached (when switching from embedded mode parent of _emu is host).
    // keep=true: tell agent this is "switching to detached", not "ending embed".
    const dt = await this.agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    // Title must be set before show.
    // Agent process is persistent and caches previous title (_ourTitle); newly shown window would briefly display old title.
    const title = this.state && this.state.label ? this.state.label : 'ApkStart';
    await this.agent.setTitle(title).catch(() => {});
    await sleep(600);
    // Make emulator window truly visible
    const shown = await this.agent.show().catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (!shown || shown.ok === false) { this.lastEmbedError = this._detachedDebug; return false; }
    // Update icon to current app's: emulator native window defaults to green robot icon.
    // Win32 LoadImage supports .ico most reliably; installer generated .ico for each app, prioritize it here.
    const icoForNative = this.iconFilePath
      ? this.iconFilePath.replace(/\.png$/i, '.ico')
      : '';
    if (icoForNative && fs.existsSync(icoForNative)) {
      try { await this.agent.setIcon(icoForNative); } catch (_) { /* ignore */ }
    } else if (this.iconFilePath) {
      try { await this.agent.setIcon(this.iconFilePath); } catch (_) { /* ignore */ }
    }
    await sleep(300);
    // Center and size according to available screen area.
    // Emulator native window locks aspect ratio to device panel (portrait 9:16);
    // proactively calculate dimensions by panel ratio so it fits correctly in one pass.
    const area = this._area();
    const ratio = this._panelRatio();
    let w;
    let h;
    let x;
    let y;
    if (this._wantFullscreen) {
      // Fullscreen must also respect panel aspect ratio.
      const fitW = Math.min(area.w, Math.round(area.h * ratio));
      w = fitW;
      h = Math.round(fitW / ratio);
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + (area.h - h) / 2);
      // Sync fullscreen flag so first maximize click restores rather than entering fullscreen
      this._detachedFullscreen = true;
    } else {
      this._detachedFullscreen = false;
      const maxH = Math.min(area.h - 140, 1000);
      const maxW = Math.min(area.w - 80, 1280);
      w = maxW;
      h = Math.round(w / ratio);
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + 60);
    }
    // area/x/y/w/h are DIP logical pixels; window agent SetWindowPos receives physical pixels.
    // Pass through _physical with area.sf (issue #99).
    const lay = await this.agent.layout(this._physical({ x, y, w, h }, area.sf))
      .catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedError = this._detachedDebug;
    this.lastEmbedOk = false;
    return !!(lay && lay.ok !== false);
  }

  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // If external caller provided candidate handles (legacy interface, currently always null); retry if unavailable
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) { this.lastEmbedOk = true; return true; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Record failure reason for upper-level app.log diagnostics
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** Target rectangle for emulator child window (physical pixels, 8px padding pushed out of view) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // Pushed EMU_PAD extends onto titlebar, clipped by window agent (agent.fit clipTop)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds Number of consecutive fit passes (recalculates latest bounds during resize)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Screen orientation rotation (titlebar rotate button) = change physical panel to landscape or portrait.
   *
   * Changing hw.lcd.width/height to 1280x720 and restarting the emulator (~30-60s) is the only reliable way
   * to get an upright, full-bleed landscape display without distortion or letterboxing.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] Injected restart implementation
   * @param {boolean} [explicitNext] Explicit target orientation
   */
  async rotate(onRestart, explicitNext) {
    if (!this.isOpen) return this.state.landscape;
    const next = explicitNext === undefined || explicitNext === null
      ? !this.state.landscape : !!explicitNext;
    this.setState({ tip: next ? 'Switching to landscape (restarting Android runtime, ~30-60s)...' : 'Switching to portrait (restarting Android runtime, ~30-60s)...', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // Panel dimensions changed; fit multiple passes to converge
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Fall back to density method if restart not injected or failed
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Switch to target orientation when needed (fullscreen=landscape, window=portrait) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  async toggleMaximize() {
    if (!this.isOpen) return;
    // In detached mode display is in emulator native window and shell window is hidden.
    // Toggle emulator window between fullscreen workArea and previous size.
    if (this.detachedMode) {
      const area = this._area();
      if (this._detachedFullscreen) {
        // Restore to pre-fullscreen size if remembered, else default proportional center
        this._detachedFullscreen = false;
        if (this._preFullscreenRect) {
          await this.agent.layout(this._preFullscreenRect).catch(() => {});
          this._preFullscreenRect = null;
        } else {
          await this.openDetachedLayoutOnly(area);
        }
      } else {
        // Remember current position and size before going fullscreen
        try {
          const probe = await this.agent.probe().catch(() => null);
          if (probe && probe.w > 0 && probe.h > 0) {
            this._preFullscreenRect = { x: probe.x, y: probe.y, w: probe.w, h: probe.h };
          }
        } catch (_) { /* Fallback to default if unavailable */ }
        this._detachedFullscreen = true;
        // Same as openDetached: respect panel aspect ratio and center
        const ratio = this._panelRatio();
        const fitW = Math.min(area.w, Math.round(area.h * ratio));
        const fitH = Math.round(fitW / ratio);
        await this.agent.layout(this._physical({
          x: Math.round(area.x + (area.w - fitW) / 2),
          y: Math.round(area.y + (area.h - fitH) / 2),
          w: fitW,
          h: fitH,
        }, area.sf)).catch(() => {});
      }
      return;
    }
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  /**
   * Recalculate emulator window size only (without detach/show) for fullscreen/restore toggling.
   */
  async openDetachedLayoutOnly(area) {
    const maxH = Math.min(area.h - 140, 1000);
    const maxW = Math.min(area.w - 80, 1280);
    const ratio = this._panelRatio();
    let w = maxW;
    let h = Math.round(w / ratio);
    if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
    await this.agent.layout(this._physical({
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + 60),
      w, h,
    }, area.sf)).catch(() => {});
  }

  minimize() {
    if (!this.isOpen) return;
    // In detached mode minimize emulator native window (agent.hide) rather than hidden shell
    if (this.detachedMode) { this.agent.hide().catch(() => {}); return; }
    this.win.minimize();
  }

  /**
   * Close window. By default also stops the Android app to save memory, keeping engine running for instant reopen.
   * Order is critical: detach and hide emulator window before destroying host window to prevent orphan black window.
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this.lastEmbedOk = false;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
