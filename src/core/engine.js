'use strict';
/**
 * Runtime engine: the QEMU + Android-x86 virtual machine shipped with ApkStart
 *
 * Design principles:
 *  - Fully self-contained by default (builtin): adb / QEMU / system image are all managed by ApkStart itself, no dependency on any third-party emulator
 *  - All operations against Android go through adb, so the engine is replaceable
 *  - The VM starts on demand and is automatically reclaimed when idle; after launch it is reused as a resident, so installing / opening apps is almost zero-wait
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient, isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Whether someone is listening on a TCP port (used to tell whether the leftover emulator from last time is still around) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // Container session: currently open app windows
    // Background apps tombstoned in multi-window mode (force-stop but data retained); next launch uses hot restore.
    this._tombstoned = new Set();
    // Result of the most recent network check. The status bar needs to show "network OK / offline", but the status is polled at high frequency,
    // so it must not run a full shell inside the guest every time — only the conclusion is cached here, and the cached value is distrusted when expired (>5 minutes).
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // The port is picked dynamically, so the serial changes with it
    /**
          * Backend adapter layer: pulls "where Android comes from" out of this class.
      *
      * Since 0.5.6 there is **only one implementation** here: builtin (shipped emulator + system image).
      * There are no longer mumu / fydeos / attach branches — on any machine, any settings, any leftover configuration
      * the user only ever gets the shipped runtime, guaranteeing ApkStart always runs standalone and is independent of third-party emulators.
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * Current backend instance (there is only one: builtin).
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * Does this machine actually have the backend the settings ask for?
   *
   * Only the bundled runtime exists now and it is always available (a missing image is a provision concern, not "the backend is absent").
   * The method is kept so callers do not have to change.
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** Backend id, always 'builtin'; used by the UI and logs */
  get backendId() { return this.backend.id; }

  /** Drop stale connection and port assumptions (call after changing the runtime directory or resetting data) */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** Is the emulator engine running? */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- Basics ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // The bundled adb always comes first: one device only ever has one adb state, so it never flaps offline.
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // When the port or adb changes, do not leave the old persistent adb shell holding the connection
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- State ----------------

  /**
   * Network snapshot for the status bar (result of the most recent check).
   * Anything older than 5 minutes is not trusted: the network may have dropped, so show "unknown" rather than lie.
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * Run a network check in the background (does not block the status response).
   * The status bar shows network state, but status() is polled often and must not run a guest shell every time.
   * So the first time (or once stale) it runs in the background, caches into _lastNetwork, and the next poll shows it.
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // checked within a minute - do not repeat
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* leave it as-is on failure and retry next round */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // "Why did it not start last time": fall back to the persisted record so the settings page and diagnostics show the real reason
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'adb is missing: click "Deploy" to download it automatically';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // "No hardware acceleration" is no longer a blocking step: doctor falls back to software emulation
    // and retries GPU / acceleration / memory combinations when a boot fails.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /**
   * Devices already connected to the local adb (read-only diagnostics).
   *
   * Since 0.5.6 there is no "connect to an existing runtime" mode: nothing here connects to another emulator port,
   * it just lists what adb currently sees so troubleshooting can confirm "is that our emulator-5554".
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- Start / stop the VM ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Preferred: the official emulator (device model and GPU translation built in, best experience)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Start Android with the official emulator.
   * Unlike QEMU+ISO there is no "install the system" step: the image *is* the system, and the first start boots it.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No hardware acceleration detected: falling back to software emulation (the first boot is much slower; nothing to configure)');
    }

    this.vmStarting = true;
    try {
      // probe is handed to EmulatorEngine's boot loop: on a process exit or fatal log it retries with another parameter set
      // One adb command per round: it used to spawn get-state + getprop + pm path as three processes,
      // costing 300-500ms per snapshot-restore round - exactly the "tap the app" responsiveness users feel.
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let authHealed = false;  // has this start() already cold-booted after an "unauthorized" result
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: 'Android debug authorization is incomplete (tap "Allow" once)',
        // The old text told users to delete %USERPROFILE%\.android\adbkey - measured to be **counterproductive**:
        // a fresh key does not match the old public key already stored on the device, so authorization never succeeds
        // (Android only writes a new key when adb_keys is absent). The right fix is tapping "Allow" in the
        // emulator window, or clearing Android data so the system rebuilds its authorization table.
        hint: 'The emulator is showing the "Allow USB debugging?" dialog. Tap "Allow" in that emulator window -'
          + ' tick "Always allow from this computer" before tapping and it will not ask again.'
          + ' If the window does not respond or never appears: Settings -> Runtime -> Clear Android data and retry'
          + ' (installed apps are erased and can be reinstalled; the APK files are untouched).',
      });
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // Key branch: an adb shell error can mean "still booting" or "the authorization dialog is stuck".
          // In the latter every shell throws, and the old implementation treated it as ordinary offline: it restarted the server and
          // then waited 240s x 4 parameter sets before reporting "the runtime failed to boot", making it look like a GPU/virtualization problem.
          // Here the error text is checked first, then the devices state column (get-state cannot tell authorized apart),
          // confirming unauthorized twice; on a hit the snapshot is dropped, a cold boot runs and an accurate diagnosis is shown instead of waiting.
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            if (!authHealed) {
              authHealed = true;
              onLog('adb is stuck on the "Allow USB debugging" dialog; dropping the snapshot and cold booting to re-inject the key...');
              try { this.emulator.invalidateSnapshot(); } catch (_) { /* ignore */ }
              this.emulator._coldBoot = true; // force a cold boot next round so the emulator re-injects the adb key
              await this.emulator.resetAdbServer().catch(() => {});
              this._probeClient = null;
            }
            // Hand back to start() to retry with another parameter set right away; a cold boot clears the dialog problem
            return 'fatal';
          }
          // Other adb transport errors: keep the old restart-the-server self-heal
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb connection failed; restarting the adb server and continuing to wait...');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // On failure start() returns {ok:false} instead of throwing (insufficient disk, every retry failed, ...).
      // The old implementation ignored that field and returned ok:true, so the caller believed it was ready,
      // adb then reported device not found, and users saw "tapping does nothing" instead of the real reason.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'The Android runtime failed to start',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // Snapshots moved to "save when idle": saving immediately writes 1-3GB and competes with the app the user just opened
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Pass the retry/diagnosis conclusion to the UI unchanged instead of wrapping it in a vague "start failed"
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- Prewarm (keep the environment resident like WSA) ----------------

  /** Save a quickboot snapshot while idle: write only when no app window is open, so it never competes with an app launch */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** For the installer and others: save a fresh snapshot after installing so the next boot is still instant */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Force a snapshot now, **without waiting for idle**.
   *
   * Needed when the network was just repaired and an app is about to launch. The normal
   * scheduleSnapshotSave only writes with no app window open, and an app never goes idle while running,
   * so the "network is up" state was never persisted - the next boot restored the old offline
   * snapshot and reconnected every time. This bypasses the idle check: one write saves every future start.
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * Prewarm: boot the Android environment in the background before the user taps an app.
   * WSA and PC app stores use the same idea - a resident environment means tapping an icon is just an am start.
   *  - fully silent: no dialog, no error, a failure never blocks opening an app;
   *  - idempotent: while booting or already ready it reuses the same Promise and never starts a second instance;
   *  - thrifty: after booting, park qemu at the lowest priority.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`prewarm: ${m}`) });
        if (r && r.ok) {
          // The user may have opened an app during prewarm: do not force it down to idle priority
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`prewarm complete (${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU is not installed; deploy the runtime first');
    if (install && !env.iso.ok) throw new Error('The system image (ISO) is not ready');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Android has not been installed to the virtual disk yet');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Starting runtime (${env.hypervisor.whpx ? 'WHPX hardware acceleration' : 'pure software emulation'})...`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Start failed: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Runtime exited (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU failed to start; see the log: ${logFile}`);

    // Install mode: the ISO contains a Linux installer, with no adb, so the 'wait for adb' path does not apply
    if (install) {
      onLog('Installer has started; complete the installation inside the VM window following the prompts');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'VM has started, but adb could not connect: please enable "Developer options → ADB over network" inside the VM and retry',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android kernel boot not completed; check the runtime log (possible image corruption or acceleration not effective)'
          : 'Android has booted, but system services are not ready (it may be stuck on the first boot setup screen; complete the wizard inside the VM window)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Wait for Android to be truly usable: adb online ≠ system usable.
   * Must wait until sys.boot_completed=1 and the package manager can respond, otherwise am start will fail directly.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android kernel has started, waiting for system services to be ready… (${Math.round((Date.now() - start) / 1000)}s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android ready (${Math.round((Date.now() - start) / 1000)}s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Waiting for system services… ${Math.round((Date.now() - start) / 1000)}s`
          : `Booting Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 and friends are registered by the emulator itself; no adb connect needed
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android to boot... ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // Chinese environment (system language + Chinese IME) is done only once per **boot**.
    // The system language is injected via emulator -prop (SELinux-protected, cannot be changed at runtime); this supplements
    // the app-level locale / timezone, and silently installs and enables the bundled Google Pinyin IME.
    // Users can turn off automatic configuration in settings (engine.chineseIme=false).
    if (!this._chineseReady && this.settings.engine.chineseIme !== false) {
      try {
        const locale = this.settings.engine.locale || 'en-US';
        await client.ensureChineseLocale(locale);
        const path = require('path');
        const apk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        const r = await client.ensureChineseIme(apk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // Only mark it ready on real success; a failure lets the next prepare() retry,
        // otherwise a single flaky adb call would leave this machine without Chinese input forever.
        if (r && r.ok) this._chineseReady = true;
        this.log(`Chinese IME: ${r.ok ? (r.installed ? 'installed and enabled' : 'ready') : (r.reason || 'not ready')}`);
        // -change-locale is only executed and framework restarted during a 'full boot'; it is skipped when restoring from a quickboot snapshot.
        // Old snapshots are in English, so when a mismatched system language is detected, invalidate the snapshot and
        // cold-boot once on the next startup (with -change-locale). New snapshots saved afterward will then be in Chinese,
        // with no further restart needed. The marker ensures this is corrected only once per life.
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`Chinese environment initialization skipped: ${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /**
   * One-time system UI language correction.
   *
   * Measured behaviour (easy to get wrong): after `-change-locale` takes effect it does **not** write
   * persist.sys.locale, and ro.product.locale still shows the image's en-US. What it actually changes is
   * `settings system system_locales` (the language picker shows the new language, the system UI follows).
   * So check system_locales, not getprop.
   *
   * `-change-locale` only runs on a full boot and restarts the framework; it is skipped when restoring
   * from a quickboot snapshot. An old snapshot still has the previous language, so when a mismatch is
   * detected the snapshot is invalidated and the next start cold-boots once. Snapshots saved afterwards
   * already carry the new language. The marker guarantees this is corrected only once.
   */
  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'en-US');
    if (want === 'off' || want === 'en-US') return;
    // Already applied (system_locales is the target locale, or its first entry is)
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.indexOf(want) === 0 || /^zh[-_]/.test(s)) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`System locale is still ${s || '(empty)'}; dropping the snapshot so the next boot cold-starts into ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`System locale correction skipped: ${e.message}`);
    }
  }

  /** Graceful stop: the emulator shuts down via its console, QEMU via its monitor */
  async stop({ graceful = true } = {}) {
    // Stopping the runtime invalidates the cached guest network result; otherwise after a rotation/restart
    // the new machine has no network yet but waitForNetwork returns ok from the 8-second cache and apps go black.
    this._lastNetwork = null;
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // An adopted emulator (adoptExisting) has no proc handle in this process, so the old logic
    // returned false and the idle watchdog could never shut it down, leaving the container on CPU/memory.
    // This path shuts down via the adb console and falls back to killing by port when needed.
    //
    // Note: emulator.exe is only a launcher and exits after spawning qemu, so "self-started"
    // machines often take this branch too. Call saveSnapshotNow before shutting down, or no snapshot is ever stored
    // and every launch is a full 25-second cold boot instead of 8 seconds.
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor timeout')));
      sock.on('error', (e) => {
        // QEMU closes the connection after commands like quit (ECONNRESET/EPIPE), which is normal
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Install the system to the virtual disk ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Download or import an Android system image (ISO) first');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'The install environment failed to start');
    return r;
  }

  /** After installing: close the installer -> write the marker -> boot from the disk from then on */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Adopt the emulator left over by the previous run.
   * Every emulator has its own console port (5554/5556/...), with the adb port at +1.
   * When the port answers and the system has finished boot_completed, use it as our runtime,
   * so "close ApkStart and tap an app again" is instant instead of another cold boot.
   */
  /**
   * Find every live emulator console port.
   * "Try 5554 upward" does not work: ports drift up with every start (5554 -> 5556 -> 5558...),
   * and any fixed range eventually misses one, which starts yet another machine. Instead find every
   * TCP port qemu listens on by process name, so nothing is missed.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* fall back to port probing */ }

    if (ports.size) {
      // Both the console port (even) and the adb port (+1) are listening; keep only console ports
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Fallback: without qemu process info, probe directly (a refused connection returns instantly and costs little)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No previous runtime found; preparing a cold boot');
      return null;
    }
    onLog(`Found ${alive.length} leftover runtime(s) (ports ${alive.join(', ')}); trying to adopt`);

    // The adb server may still hold offline records from the previous process (true after an adbd restart),
    // so clear them before connecting, or get-state always returns offline and a healthy machine gets killed as "not ready".
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Found a previous runtime (${serial}) but it is not ready; shutting it down and booting fresh`);
        // The AVD directory is locked: leaving this instance makes the new one exit, showing up as "it never boots".
        // adb cannot reach it, so find the process by console port and kill it.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Adopted the running runtime (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Which process is listening on a given TCP port (used to kill a stuck emulator) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Clean up orphan emulators left by the previous run that were not adopted.
   * emulator is detached when ApkStart closes, so qemu survives; on the next start it still holds the AVD lock,
   * showing up as FATAL "Running multiple emulators with the same AVD" on a cold boot.
   * The implementation lives in EmulatorEngine so the retry path (killAttempt) uses the same logic.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Idempotent entry: preheat and user clicks can happen at the same time, sharing one Promise,
   * to avoid both sides judging 'not online' once each and then each launching an emulator (AVD lock conflict + double memory).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      /**
       * 'online' does not equal 'can do work'.
       *
       * In the few hundred milliseconds right after the emulator process exits or is restarting,
       * adb still replies `device` to `-s emulator-5554 get-state`. The old logic treated that as reused directly,
       * and the launch chain for switching panel direction then got an already-dead client —
       * every later command became `device 'emulator-5554' not found` (in practice ensure
       * reported 'ready' in 0.2 seconds, and all app launches collapsed). 
       *
       * Here a real command is added: only executing getprop counts as the device truly being there (a 0 return means
       * it is still booting, which is normal, reuse and wait per the original logic); a command failure is treated as not ready,
       * and the launch flow below continues.
       */
      const probe = await client.shell('getprop sys.boot_completed', { timeout: 5000 })
        .then((v) => String(v == null ? '' : v).trim())
        .catch(() => null);
      if (probe !== null) {
        await this.prepare(client);
        return { ok: true, client, engine: 'builtin', reused: true };
      }
      onLog('adb reports device online but commands do not go through (emulator may be restarting); relaunching runtime…');
    }

    // The emulator left over when ApkStart last exited (next click opens instantly), but the new process
    // has no handle for it, and the adb server may have been restarted too — relying only on isOnline()
    // would judge 'no runtime', and then open a new one. Here take over any still-living emulator first,
    // to avoid opening a duplicate machine and eating memory.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // Leftover from last session / emulator started by another process: reuse it even on a different port,
    // never open a duplicate one.
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* if not found, just launch normally */ }

    // Process still running but device offline (most likely stuck in boot): stop it first, then relaunch,
    // to avoid waiting dryly.
    if (this.emulator.running()) {
      onLog('Detected a stuck runtime, restarting…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Unique path: bundled runtime
    // The single-file release's image is compressed; expand it first (already expanded is instant).
    // Do not swallow a failed expansion: otherwise later checkEnv() will only say 'system image still needed',
    // and the user will think it was not downloaded, rather than a decompression failure (disk full / file corruption).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`System image expansion failed: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });



    const env = await this.provisioner.checkEnv();

    // Emulator path: the image is the system; there is no 'install to disk' step
    if (env.emulator.ok && env.sysimg.ok) {
      // After ApkStart is closed, there may be an un-adopted emulator left (detached qemu still alive),
      // which keeps holding the AVD lock and would make a cold boot immediately FATAL with "Running multiple emulators with the same AVD".
      // When adoption fails, clear those orphans first, then cold boot, to guarantee 'close then open' can always come up.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
                  return { ok: false, error: r.error, env,
            diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
          };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU path (user-supplied ISO already installed to a virtual disk)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'System image still needed: click "Download system image" to continue'
          : 'Runtime components are not fully deployed yet',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- App-level container session ----------------

  /**
   * "Open like a container":
   * the Android environment boots once and stays resident (quickboot snapshot + adoptExisting adoption),
   * so every app open is just am start plus attaching the existing window instead of re-running the system.
   * Three extra things reduce system pressure:
   *   - stop other user apps' processes so only what the current app needs runs;
   *   - give qemu a "yield to the foreground" priority while a window is open;
   *   - start file sync / notification polling only while a window is open (onActive hands that to the UI layer).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Scheduling level while an app is in front. balanced uses normal (not below):
    // below lets qemu starve when the system is busy, showing up as dropped video frames and sluggish taps -
    // the main cause of "taps do not feel responsive". normal matches the desktop and costs no extra CPU/memory/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // An app is about to start: postpone the "save snapshot while idle" so it does not compete for disk
      this.emulator.cancelSnapshotSave();
    }
    // Ensure the priority on every open/switch back: endApp drops an idle qemu to idle priority,
    // and switching back without raising it again leaves it low - taps feel numb. setPriority is idempotent
    // (the script changes nothing when the value already matches) and costs very little.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* a failed polling start does not block opening the app */ }
    }

    // Multi-window mode (plan B): opening a new app **no longer** force-stops the others, which would defeat multi-tasking.
    // Instead background apps are reclaimed by a tombstone policy, so several can coexist without runaway memory.
    // With multiWindow off the old "keep only the current one" behaviour returns, so it stays reversible.
    if (s.engine && s.engine.multiWindow) {
      const roles = container.sessionRoles([...this._activeApps], pkg);
      const { tombstone } = container.planTombstones({
        background: roles.background,
        keepRecent: Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      });
      const cmds = container.buildTombstoneCommands(tombstone);
      if (cmds.length) {
        await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
        for (const p of tombstone) this._tombstoned.add(p);   // remember suspended apps so the next tap restores them warm
        this.log(`multi-window: foreground ${pkg}, keeping ${roles.background.length - tombstone.length} in the background, tombstoning ${tombstone.length}`);
      } else {
        this.log(`multi-window: ${roles.count} apps coexist, nothing to reclaim`);
      }
      return { ...roles, plan: { commands: cmds, stopped: tombstone } };
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // The app was just started with am start, and clearing background now could hit a process entering the foreground; reclaim in endApp instead
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Close an app window: stop its process; if it was the last window, park the container
   * in a "resident but nearly idle" state (background cleared + Android idle + qemu priority lowered).
   * No shutdown, no AVD deletion - the next open is still instant.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // In game mode keep the high priority even with no app window,
      // otherwise the next open has to raise it again and the first input lags noticeably.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Idlest moment: save the memory state as a snapshot so the next boot restores instead of cold booting
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Container parked (Android resident, 0 app processes, qemu at lowest priority)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Re-enable system packages disabled by "deep trim" when the settings page switches it off */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Idle reclamation ----------------

  /**
   * Orientation self-heal: keep the "logical display space" and the "physical panel" orientation aligned.
   *
   * Evidence (real dumpsys window displays):
   *   init=1280x720 ... cur=1280x720   -> correct (landscape panel + landscape logic)
   *   init=1280x720 ... cur=720x1280   -> fallen over: the logical space was rotated 90 degrees
   * When cur's width/height order is reversed from init, an app or the system changed the orientation back;
   * re-locking the orientation and ignoring app requests fixes it without restarting the VM.
   *
   * Settings are written only on a real mismatch, so normally it is one read-only shell every 60 seconds.
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // Panel orientation disagrees with settings -> that needs a restart and cannot be fixed here (runLaunch.beforeStart handles it)
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // Really fallen over: re-lock the orientation + ignore app requests + restore density
      this.log(`orientation self-heal: init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} fallen over, re-converging`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand).catch(() => {});
      return;
    }
    // Not fallen over does not mean correct. Tablet layout depends on two easily lost runtime states:
    //   - mSetIgnoreOrientationRequest (must be true in landscape, or app orientation skews the panel)
    //   - wm density override 190 (720 wide -> sw606dp >= 600dp for tablet layout)
    // Losing either falls back to phone form - exactly the "tablet mode is unstable" complaint.
    // A light check restores whichever is missing (both commands are idempotent and not written in the normal case).
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // Only correct when an "Override density: N" line exists and equals the target
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`display state convergence: ignore-orientation=${ignoreOk} density=${densityOk} -> filling gaps`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // Only restore density when **no app is in the foreground**.
      // Changing density triggers a configuration change + Activity recreation, and apps that cached DisplayMetrics
      // recompute dp against the old value, shrinking the picture into the top-left with the rest blank -
      // the reported "the reader app does not fill the window". With an app running, leave it to the next launch path;
      // installer.launch's resetDisplayOverrides sets it before am start.
      if (!densityOk) {
        if (this._activeApps.size === 0) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} missing but an app is in the foreground: skipping, will be set on the next launch (avoids a shrunk picture)`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // Orientation self-heal: app starts / Activity recreation / system dialogs can reset user-rotation or
      // "ignore app orientation requests". Once reset, the picture on a landscape panel falls over 90 degrees
      // ("tablet mode apps are always sideways"). Each watchdog round reads the real state and
      // corrects only on a **real mismatch**, with zero writes in the normal case.
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // An adopted emulator has no local proc handle, so vmRunning is false:
      // the old code returned here and the container was never reclaimed. Now the adb online state is checked too.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Diagnostics / trimming (called by the UI) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // In-memory attempts only live for this session; after a restart they are empty.
    // Fall back to the persisted failure record and include the tail of emulator.log - otherwise the report
    // only says UNKNOWN and the real reason is invisible (issues #20/#25 both hit this).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Reclaim old images / old AVDs / lock files / snapshots from the runtime.
   * Root cause of "cleanup does nothing": with the runtime running, keepSnapshots excluded the current AVD's
   * quickboot snapshot (~several GB of ram.img), leaving almost nothing to clean with a single AVD.
   * Callers can now pass includeSnapshots explicitly: stop the runtime first, then trim, and snapshots are really reclaimed.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // If the preview phase stopped the machine, tell the user they can restart the runtime manually
    return { ...report, apply, stoppedVm };
  }

  /**
   * Completely reset Android data (wipe the /data user partition + installed apps + quickboot snapshot),
   * returning the AVD to "system just installed, no third-party apps".
   * This really deletes an 8-16GB user data image, so it needs a second confirmation (the UI does that) and only touches
   * the current active AVD (apkstart.avd), never the read-only base image or other AVDs.
   * config.ini / hardware-qemu.ini are kept so the AVD stays valid and the next app open cold-boots fresh data.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Delete: user data image (qcow2 diff + base), quickboot snapshot, leftover lock files/directories.
          // Keep: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / the *.ini / *.txt / *.cache files - they are the AVD's identity and
          //       infrastructure; deleting them invalidates the AVD or breaks the next boot. The emulator rebuilds /data with -wipe-data semantics.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* still in use - skip for now and clean next time */ }
        }
      }
      // After the user data image is gone, the user-side "installed apps" records must go too,
      // or the desktop/launcher still lists apps that no longer exist.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Connect the saved AndroidWifi network that does not auto-connect (non-destructive; no restart, no data loss).
   * Implementation and the real-world cause live in emulator.repairWifi.
   *
   * @returns {Promise<boolean>} whether it is connected
   */
  async repairWifi(adbPath = '') {
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * Wait for the VM to get a network.
   *
   * Measured: `sys.boot_completed` only means the system is up; Wi-Fi association + DHCP need another
   * ten seconds to a minute before 10.0.2.16 arrives. Apps like Hongguo fetch their home feed immediately,
   * and without a network the page renders as one black block (the privacy dialog is local, so it shows),
   * which users see as "stuck on black after tapping Agree and continue". So wait for the network before launching.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // Speed: after a warm start / rotation restart the launch path calls this repeatedly
    // (restartForOrientation waits once, installer.launch waits again).
    // Network readiness is stable, so reuse a conclusion confirmed within 8 seconds and skip a whole adb round trip
    // (each isOnline + checkNetwork is two shells, measured at hundreds of ms to 1s).
    // 8 seconds covers consecutive calls without lying to users for long after a real disconnect.
    // Note stop() clears _lastNetwork, so a restarted VM never reuses the pre-shutdown state.
    const cached = this._lastNetwork;
    if (cached && cached.ok && Date.now() - cached.at < 8000) return cached;
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // A freshly restarted VM may not even have adb online yet, so do not give up on the first offline
        // (the old code returned device-offline immediately after a data reset and reported "repair failed").
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` means "Wi-Fi never associated", not "associated and waiting for DHCP".
        // Waiting until timeout in that state is pure waste: this boot will not connect by itself (on real machines AndroidWifi
        // often lands as "saved but does not auto-connect"). After a few rounds with that reason, stop early
        // and let the caller do a real reconnect instead of burning 20 seconds.
        // Three rounds (~9s) rather than two: Wi-Fi needs a few seconds to associate right after boot,
        // and judging too early opens the settings page and interrupts it.
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Waiting for Android to get a network... ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * Repair "Android has no network".
   * Almost always Wi-Fi association is just slower than the boot, and restarting plus waiting fixes it
   * **without** clearing user data; only after a timeout should users be pointed at "Reset Android data".
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Make sure the VM has a network: wait, cold boot once if it does not (bypassing a possibly offline snapshot), wait again.
   * This is the cure for "black screen after tapping Agree": an app must only start once the network is ready.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Try the cheap fix first: tap the saved AndroidWifi network that does not auto-connect.
    // Orders of magnitude lighter than a cold boot or a data reset: no restart, no user data touched.
    // On real machines this is the real cause of most "the VM has no network" cases (see emulator.repairWifi).
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('The VM cannot reach Wi-Fi; trying to reconnect...');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`Network restored (${net.ip || ''}); saving the working state so the next start is fine.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* on failure fall through to the heavier path below */ }
    }
    // Cold boot is expensive (tens of seconds); do it only once per process: otherwise every time the user opens an app
    // they have to redo it from scratch, and what the user feels is 'opening takes several minutes'.
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('Network is still not ready; cold-booting a VM once (without loading snapshot) and retrying…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Save a snapshot right after the network works so the NIC state restores with it next time
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Repair "Android has no network".
   * Order: cold boot (no data change) -> wait for a network -> only then reset data (loses in-app data).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Stepped repair, cheapest first; never lose data if it can be avoided:
      //   1) reconnect Wi-Fi (no restart, no data change)
      //   2) cold boot (no snapshot load, still no data change)
      //   3) only then reset data
      onLog('Repairing the VM network: trying a Wi-Fi reconnect first (installed apps are kept)...');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'The VM failed to start', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`Network restored (${net1.ip || ''}); a working snapshot was saved.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // Step 2: cold boot, bypassing a possibly offline snapshot
      onLog('Reconnect did not help; cold booting the VM once (no snapshot loaded, data kept)...');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'The VM failed to start', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored (${network.ip || ''}); a working snapshot was saved.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // Step 3: still nothing - only a data reset is left (loses in-app data)
      onLog('Still no network; resetting Android data and booting again (the app list is kept and apps reinstall when opened)...');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Give the previous qemu / netsimd time to exit, or -wipe-data hits the AVD lock
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'The VM failed to start', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Save the "network works" state as a snapshot immediately so the NIC state restores next time,
        // otherwise closing and reopening lands back on no network.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Network restored (${network.ip || ''} gateway ${network.gateway || 'reachable'}); a working snapshot was saved.`);
      } else {
        onLog('Still offline after the reset. Check whether the host network/firewall blocks the emulator (netsimd uses a loopback port).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // The backend adapter only has the bundled runtime; dispose only cleans up its own state and never touches external emulators
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // **Never** force-kill qemu here:
    //  1) it truncates a quickboot snapshot mid-write, leaving a multi-GB ram.img shell,
    //     so the next boot fails to load it -> full cold boot, the direct cause of "every open waits two minutes";
    //  2) leaving it alive lets the next ApkStart adopt it and open apps instantly (same as WSA / PC app stores).
    // Uninstalling takes another path (app:removeSelf explicitly cleans up processes).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
