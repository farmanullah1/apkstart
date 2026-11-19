'use strict';
/**
 * Emulator engine: drives the Google official Android Emulator as ApkStart's runtime.
 *
 * Biggest difference from the old version: this no longer assumes "one set of parameters runs on every machine".
 *  1. Derives parameters automatically via doctor.chooseProfile() from RAM/CPU/disk/acceleration state/engine version;
 *  2. On launch failure, retries with automatic degradation via planVariants() (GPU backend → software emulation → minimal-memory cold boot);
 *  3. Dynamically picks an idle port, clears AVD locks, converts Chinese paths to short paths, and auto-invalidates snapshots after image changes;
 *  4. quickboot snapshots + a small data partition, sharing a read-only base layer like a container and restoring in seconds.
 *
 * The probe callback is supplied by the upper layer (Runtime) to judge whether Android is truly ready.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Translates emulator/qemu exit codes into human-readable text on Windows.
 * 0xC0000005 (3221225477) is the most common crash exit code: access violation, in practice often caused by
 * the GPU driver / Vulkan backend crashing at the instant the guest starts — switching to software rendering sidesteps it.
 */
function describeExitCode(code) {
     // When terminated by a signal the code is null (on Windows both taskkill and adb emu kill do this);
   // it must not be treated as 0 "normal exit", but it is not exactly an error either — return an empty string and let the caller display it as-is.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'Normal exit';
    case 1: return 'Startup parameter or environment error';
    case 3221225477: return '0xC0000005 access violation, render backend crashed';
    case 3221225725: return '0xC00000FD stack overflow';
    case 3221225781: return '0xC0000135 missing DLL (VC++ runtime / runtime components removed by antivirus)';
    case 3221225506: return '0xC0000022 access denied (driver or permission problem)';
    case 3221225595: return '0xC000007B image bitness mismatch or corrupt DLL';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * Driver (compatibility patch) effects applied for this boot, plus the matched driver list.
     * Filled by _resolveDrivers() in start(); buildArgs / env / ensureAvd only read it.
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // A snapshot's ram.bin is roughly the memory given to the VM (2-4GB).
    // Machines that already cold-boot fast should not spend several GB of disk on it; save only when genuinely slow.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Persist "last failed start" to disk.
   * Older versions kept it in memory only (this.attempts), so after an ApkStart restart the exported
   * report showed attempts: [], bootLog: [] - the direct cause of "the report is attached but
   * shows no reason" in issues #20/#25.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* failing to persist must not break the main flow */ }
  }

  /** Read back the last failure record (used by diagnostics / pre-boot hints) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe and system image directory (user runtime dir first, then the bundled engine/) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Pick an image: use the general image (API 34 Play) when available so users never switch "compatibility mode" */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Drop the quickboot snapshot.
   * A snapshot holds both memory and disk state; loading an old one after installing apps or clearing data
   * makes users see "the app I just installed vanished after a restart".
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Clear locks left behind by an abnormal exit.
   * Note hardware-qemu.ini.lock is a **directory**, not a file, so rmSync(force) cannot remove it,
   * and the emulator keeps failing with "Running multiple emulators with the same AVD"
   * (true after a forced kill), so removal must be recursive.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* still in use - skip and try again next time */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Does the AVD directory really hold a **complete** quickboot snapshot?
   * "The directory is not empty" is not enough: an interrupted save leaves a 12-byte snapshot.pb shell,
   * the emulator tries to load it, fails ("does not have the requested snapshot") and falls back to a cold boot,
   * wasting seconds. So validate by file size and clean up shells plus legacy default_boot (3GB each).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // Newer emulators (37.x) write ram.bin, older ones ram.img.
    // Only accepting ram.img is severe: a freshly saved 3GB snapshot gets deleted as an empty shell,
    // so every launch passes -no-snapshot-load and always cold-boots - half the reason "opening is slow".
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // nothing there - do not delete anything
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Remove snapshot directories left by older versions / failed renames (default_boot can hold a 3GB ram.img) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Kill orphan emulators holding the AVD lock.
   * emulator.exe is only a launcher; the real qemu is spawned detached,
   * so killing only our own proc handle often leaves an orphan holding multiinstance.lock
   * and the next start fails with FATAL "Running multiple emulators with the same AVD".
   * Clean by both "pid from the AVD lock" and "qemu/emulator whose command line names this AVD".
   */
  /**
   * Is the current AVD panel landscape or portrait?
   *
   * Why ask: landscape only works through the **physical panel** - `wm size` changes the logical resolution only and the picture
   * falls over 90 degrees; `adb emu rotate` rotates content only and the system stays portrait. What works is swapping
   * `hw.lcd.width/height` and restarting. config.ini is written at each boot from the current settings,
   * so reading it tells us the orientation of **the instance running now**.
   *
   * @returns {boolean|null} true=landscape panel, false=portrait panel, null=unreadable
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Fast path (hit on every cold boot):
    //  - no .lock -> no live emulator can hold this AVD, return immediately;
    //  - lock present but nothing listening on the port -> leftovers from a forced kill, just clean up.
    // It used to run wmic in every case (1-3s and heavy on CPU), noticeably slowing cold boots.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) the pid the emulator itself wrote into the lock file (most reliable)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) fallback: find live qemu by process name + port (tasklist/netstat are an order of magnitude faster than wmic)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* without a process list, rely on the pid in the lock file */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Cleaned up ${pids.size} leftover emulator processes`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Is any emulator console port listening in 5554-5620? (a refused connection returns instantly and costs nothing) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Driver report for the UI and diagnostics: which were used this boot, which were skipped, and why.
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * Apply the config.ini overrides a driver declares to the default config.
   * Existing keys are replaced in place (no duplicate lines); missing ones are appended.
   * Only keys on the drivers.js allowlist are handled; invalid keys are rejected during validation.
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = Object.keys(over);
    if (!keys.length) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !(m[1] in over)) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * Scan the driver directory, pick the ones matching this machine and store the effect for this boot.
   *
   * Directory order is priority: bundled examples (read-only, enabled:false by default) first, user drivers after;
   * on the same id the user directory wins - editing an example takes effect without touching the install directory.
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* treat as 0; drivers matching on osBuild will not apply */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * Prepare the AVD: write config.ini. Rewritten each start from the current auto profile so fallbacks apply immediately.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Screen resolution: with hardware acceleration 720x1280@320 is crisp and text stays sharp;
    // in pure software emulation drop to 540x960 for frame rate (56% of the area, far less visible than stutter).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // Compare "image identity" rather than an absolute path: the same image on another drive/folder is not a new image,
      // otherwise changing the runtime directory wipes every installed app (see doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // Old userdata is incompatible with the new image (APEX boot loop) and must be rebuilt
        this.wipePending = true;
      }
    }

    // A config fingerprint change means the old quickboot snapshot will fail to load or show a black screen, so drop it.
    // Note: only the **snapshot** is dropped here, never -wipe-data - user data holds installed apps and saves.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* first run */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Deletion may be blocked by the system / security software (snapshot dirs run to several GB).
      // On failure rename it so the emulator cannot load it, but never abort the start because cleanup failed.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // -wipe-data is only needed when the "image changed" (tag / sysdir): old userdata and the new image
    // have incompatible APEX and without a rebuild it loops on boot. Capacity / resolution / renderer changes do not count.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be the ABI itself (x86_64 must not be truncated to x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // Older versions hardcoded 16G, which creates huge files on small disks / quotas and slows the first boot
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // Virtual Wi-Fi must be enabled explicitly. On API 34 Play images networking runs over
      // wlan0 (the netsim virtual NIC), not the older eth0. Without this line in config.ini
      // the emulator never brings up a link for wlan0 - it stays NO-CARRIER,
      // `dumpsys connectivity` shows "Active default network: none", and apps keep
      // showing "network error, try again later". The -netdelay/-netspeed/-dns-server flags
      // only tune QEMU's user-mode NAT; they do not bring up the guest NIC.
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // Snapshots are fully controlled by -snapshot apkstart: a dedicated name never accidentally loads
      // a legacy default_boot (that is an API30 image's memory state; loading it always boot-loops).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Orientation and accelerometer must be off: when enabled Android auto-rotates from sensors and turns
      // portrait content sideways (picture rotated 90 degrees, vertical text, black bars). Layout switching now relies
      // only on wm density (smallestWidth) and must not involve sensors.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // The /data partition must be genuinely usable first, or everything after it waits for nothing (see ensureDataPartition)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Make the userdata partition a **truly usable** ext4 - the foundation for "tap an app and reach the launcher in 30s".
   *
   * Why do it ourselves (all three measured):
   *  1. userdata.img in the image is a 1MB all-zero placeholder; the real formatting happens through avdmanager calling
   *     mke2fs. ApkStart writes config.ini and starts the emulator directly, skipping that -> /data all zeros ->
   *     kernel "Invalid ext4 superblock on /dev/block/vdc" -> the guest falls into a recovery reboot loop ->
   *     adbd never comes up -> probes stay pending and time out after 240s. Old symptom: minutes of waiting after tapping.
   *  2. the bundled e2fsck/resize2fs is cygwin e2fsprogs 1.42.12, which does **not understand the encrypt
   *     feature** and exits 8 when that bit is set, so growing the filesystem must happen before restoring the bit.
   *  3. the filesystem must be >= the partition size: at 64MB APEX unpacking + dexopt fill it immediately,
   *     then every setxattr returns ENOSPC -> SELinux labels cannot be written -> netd/media/tombstoned
   *     all exit 1 -> boot hangs on the animation and adb stays offline forever.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* missing */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // "Nothing to do" requires both a large enough file and a filesystem that really grew to that size.
      // Checking only the file size misses a real failure: qemu-img enlarged the file while resize2fs failed,
      // leaving a 6GB file with 64MB of Android - users see "not enough space" when installing games.
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // The capacity setting grew (or the filesystem did not): grow in place, no rebuild, keep installed apps
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata grow: file ${size} -> ${wantBytes}, filesystem ${fsBytes} -> ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Growing userdata failed (keeping the current partition): ${e.message}`);
        // The old partition still works, but the caller must be told the growth did not happen instead of the settings page claiming success
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // First run / legacy all-zero placeholder / corrupt image: build a fresh one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Create it without the encrypt bit first (old e2fsck/resize2fs only work then)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`Rebuilt userdata: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (4K blocks, FBE capable)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Best effort: even if growing failed, restore the encrypt bit so FBE can initialize (the partition will be small)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Rebuilding userdata failed: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** The bundled qemu-img.exe: enlarge a raw image file to the target size (sparse, instant)
   *  Mind the argument order: `qemu-img <command> -f raw <file> <size>`.
   *  Putting -f before the command makes it a global option and reports unrecognized option. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** The bundled resize2fs.exe (cygwin build; must run from bin64 to find its DLLs) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('resize2fs.exe is missing');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs failed: ${(r.stderr || '').trim() || r.status}`);
  }

  /** The emulator uses these env vars to locate the SDK / AVD; non-ASCII paths always become 8.3 short paths */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // The AVD directory must match provisioner.paths().avdHome: with a bundled read-only runtime (resources/runtime
    // next to the EXE) root/avd does not exist and is not writable, so the AVD belongs in the user data directory.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      // Driver-declared env vars: only ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefixes are allowed (see drivers.js)
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  /**
   * System locale to inject. Defaults to en-US; users can change it in settings (engine.locale).
   * Setting it to 'off' leaves the stock image locale untouched.
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'en-US').trim();
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    // Drivers may pin the render backend / force software emulation. Applied first so it feeds gpu/accel,
    // and everything below (-accel off, config.ini hw.gpu.mode) follows it.
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Audio: on by default so Android app sounds and video audio play. Only pass -no-audio when the user explicitly turned it off to save CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Disable crash reporting: once a crash report exists the emulator shows an "agree to upload" modal,
      // blocking the main thread so it never boots (the log says "Showing crashdialog to get consent").
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      // AMD + emulator 37.x: Vulkan init in the host backend fails and the process exits 1 after ten-odd seconds,
      // so it is recorded as "host unusable" and permanently falls back to swangle (software rendering),
      // making video and scrolling stutter. Disabling Vulkan lets it use GL and actually get hardware acceleration.
      // The software backend never uses Vulkan anyway, so this applies to host only.
      ...(gpu === 'host' && process.platform === 'win32' && doctor.detectGpuVendor() === 'amd'
        ? ['-feature', '-Vulkan'] : []),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // Networking: AOSP emulators use QEMU user-mode NAT (-netdev user) by default; Android gets a
    // 10.0.2.x virtual address and traffic leaves through the host's physical NIC NAT.
    // This mode creates **no** virtual NIC or switch on Windows
    // (that needs -netdev tap or bridging, which is never enabled here).
    // So the Android device sits behind the host NAT and the host network stack is untouched,
    // with no driver to install and no extra network adapter.
    // Explicitly request unlimited speed: the default is full, but some -gpu / -net combinations
    // pull in conservative emulator settings and video apps' first screen lags noticeably.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // System locale: defaults to en-US.
    // Measured: `-prop persist.sys.locale=zh-CN` has no effect - the emulator blocks protected properties
    // like persist.sys.*, and ro.product.locale is overridden by the image's build.prop; getprop in the guest
    // never shows it. The official -change-locale really changes the system locale and restarts the framework,
    // and writes it to /data so it survives snapshot restores.
    // Users can pick another locale or turn it off in settings (engine.locale='off').
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS: Android uses 10.0.2.3 (forwarded to the host DNS) by default. With a VPN / corporate network / some ISPs
    // one lookup can take hundreds of milliseconds, showing up as "the page spins for ages before loading". A public
    // DNS is used first and the system still falls back. Users can turn it off in settings (intranet names).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Note: **-no-skin must not be passed**. It overrides -skin above and the panel size falls back to the
      // old config.ini value - exactly "landscape was chosen in settings but it is still portrait",
      // and "the picture only fills a strip in the top-left". The panel size must come from -skin.
      // The device frame is not drawn anyway (ShowDeviceFrame=no plus the style options below).
      // Note: -qt-hide-window must not be used. It stops the emulator from **creating** that Qt window,
      // and the window proxy relies on SetParent to embed that window in the app shell -
      // with it, probes never find the window and users see a fully black app window.
      // Hiding the window is handled by the resident window proxy (see QuietSweep in win/agent.ps1).
    }
    // Pass -snapshot only when a snapshot really exists: on a fresh AVD (or right after dropping one) qemu
    // waits forever for a memory state that does not exist, stays alive and never boots -
    // the caller only sees "boot timed out", retries with other parameters and hits the AVD lock.
    // "Running multiple emulators with the same AVD"。
    // Snapshot flags decide "8 seconds or 90 seconds next boot" - the second fatal point:
    // the old code passed -no-snapshot when there was none, and -no-snapshot also disables **saving on exit**,
    // so no snapshot was ever produced and every launch was a full boot.
    // The right flag is -no-snapshot-load: do not load this time (no waiting for a missing snapshot),
    // but still write apkstart on exit so the next start restores instantly.
    // A snapshot costs a ~2-3GB ram.bin (users low on disk can disable it; it only affects boot speed)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // Resetting data must not load the old snapshot (it no longer matches), but **must allow saving a new one**:
      // network self-heal depends on "first boot after reset has a network -> save immediately -> restore next time".
      // The old code passed -no-snapshot here, disabling saving too, so a snapshot was never stored.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // Network self-heal requires this cold boot: the snapshot may have been saved without a network and restores that way.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // Other driver-declared flags: -gpu / -accel are already handled by gpu/accel above, so skip them here
    // to avoid passing a flag twice (emulator versions disagree on duplicate flags).
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

  /** Start a single process (no boot wait; the probe loop in start() does that) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: keep the emulator independent of the ApkStart process group.
      // Electron closes its job object on exit and takes child processes with it -
      // which looks like "closing ApkStart and reopening means another 20 second cold boot". Detached it survives,
      // and the next start adopts it (see Runtime.adoptExisting), so opening is instant.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`Runtime exited (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu is detached, so wait until it is really up before lowering its priority.
    // Otherwise 2-4 vCPU threads compete with the Windows desktop at Normal priority,
    // which users feel as "the mouse stutters and the whole machine lags the moment ApkStart opens".
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Write the emulator log with size-based rotation so long-term use cannot fill the disk */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Actual state of the current /data image (for the settings page, without starting Android) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* not created yet */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* not created yet or corrupt */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // Real filesystem size (not the image file size): they differ when the image grew but resize2fs did not
      fsGB,
      configuredGB,
      // The user set a target but the filesystem has not reached it yet
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot creates a qcow2 overlay for userdata; the guest sees that, not the base image
      overlay: this._hasDataOverlay(img),
    };
  }

  /** Is userdata taken over by quickboot's qcow2 overlay (then only a reset works, not in-place growth) */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * Grow /data right now (the emulator must be stopped or the image is in use).
   *
   * Two paths, both measured:
   *  - no quickboot overlay: grow in place (qemu-img resize + resize2fs), keeping installed apps;
   *  - with an overlay: the guest mounts `userdata-qemu.img.qcow2`, so growing the base image and the
   *    filesystem to 8GB still shows 5.7GB in `df /data` (the overlay keeps its old size),
   *    and the overlay's filesystem cannot be changed without root. Then the honest answer is "reset required",
   *    not the old success - users would think it grew and a 50GB game would still fail halfway.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `Android is using the quick-boot diff disk; in-place growth cannot reach it (target ${wantGB} GB).`
          + ' Use "Reset Android data" to rebuild /data at the new size - installed apps and saves will be erased, so confirm first.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition returns ok:false when resize2fs fails; re-check the filesystem size so
    // "the file grew, the filesystem did not" is never reported as success (users see "not enough space" when installing).
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `The image grew to ${wantGB} GB, but the filesystem only reached ${(fsAfter / 1073741824).toFixed(1)} GB (resize2fs did not succeed).`
          + ' Try "Grow now" again, or free up disk space and retry.',
      };
    }
    return r;
  }

  /**
   * Adjust the priority of this machine's qemu/emulator processes (only those whose command line names this AVD).
   * level: idle (container parked) | below (an app is in front) | normal (performance first).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Force-kill the current attempt (including the qemu process tree) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // The proc handle is often gone already (emulator.exe exits after launching, qemu is detached),
    // so without a fallback cleanup by process name the next round fails on the AVD lock with FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Rebuild the adb server on this machine's dedicated port.
   *
   * This is the main culprit behind "opening an app takes two minutes"; the old implementation only killed the server and returned:
   * The emulator connects to the adb daemon on ANDROID_ADB_SERVER_PORT at startup,
   * and never registers the device when it cannot - adb devices either has no emulator-5554
   * or it stays offline forever (the log line "Unable to connect to adb daemon on port: 5044").
   * Probes then never see sys.boot_completed, wait 3 minutes and time out, and every retry
   * is a full cold boot that cannot save a snapshot because "the device is not online" - a loop.
   *
   * So kill first (clearing old device records) then start, and only return once the port really listens.
   */
  /** Lets the caller restart the server once when an adb transport stalls (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* use the one on PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server returns quickly on some machines while the port is not listening yet,
    // so wait until it accepts a connection (up to ~3s, normally tens of milliseconds).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Handle the "exit right after spawn" case.
   * Bad parameters / missing DLLs usually make the emulator exit within a second; while the process lives this returns at once,
   * with no need to waste a fixed 2.5s - on a snapshot restore that is enough to finish half the boot.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Make the **next start** cold-boot (no quickboot snapshot).
   *
   * The snapshot also captures NIC state: one saved without a network keeps restoring without one.
   * Cold-booting once during network self-heal bypasses that bad snapshot.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Make the **next start** pass -wipe-data (only used by "repair network" after several attempts fail).
   * Deleting the userdata image file is not the same as the emulator's `-wipe-data`, so use the latter.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Check whether the VM really has a working network.
   *
   * Why: the VM's Wi-Fi config lives in /data, and once it is corrupted (typically the same AndroidWifi
   * appearing twice in `cmd wifi list-networks` with colliding ids) wlan0 stays NO-CARRIER and gets no IP.
   * Network pages then render as a black screen in apps - that is the reported "black screen after tapping Agree",
   * entirely unrelated to GPU/rendering.
   *
   * @param {string} [adbPath] explicit adb executable (Runtime resolves a better one)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    // Like repairWifi: guard against callers passing a function where a path is expected
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() only checks the "version file", which is empty in many install layouts;
      // looking for the bundled platform-tools under the runtime root is more reliable.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Android's multiple routing tables make the main table of `ip route` look empty (the default route lives in the per-interface table),
    // and the shell uid is not in the app network group, so `ping` often reports "Network is unreachable" wrongly,
    // even when Wi-Fi is connected and apps work. So rely on "did we get an IPv4 address"
    // plus `cmd wifi status` as a cross-check, never on ping.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi association + DHCP often finish tens of seconds after sys.boot_completed.
      // When the caller passed waitMs, keep waiting instead of concluding "no network" right now.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // An IP does not mean the internet works. Measured: 10.0.2.16 assigned but DNS/routing blocked still leaves
    // app home pages on "network error" while the caller assumes the network is fine. Add a real HTTP probe.
    // Use nc against port 80 rather than ping: QEMU user-mode NAT drops ICMP, so ping always lies.
    // Only on the "wait for network" path (waitMs>0); fast polling skips it - otherwise every 3s
    // would spend 4s probing and slow the boot. The result goes into reachable without changing ok: with an IP
    // let the app start; one DNS hiccup must not block the whole launch.
    let reachable = null;
    if (waitMs > 0) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connect.rom.miui.com\\r\\n\\r\\n' "
        + "| nc -w 4 connect.rom.miui.com 80 2>/dev/null | head -1",
        7000,
      );
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * Connect the saved AndroidWifi network that does not auto-connect.
   *
   * Measured on real machines: the emulator's virtual AndroidWifi hotspot can end up as two entries
   * in the config store (open + owe), which the system then treats as
   *   「Saved / Won't automatically connect」
   * so wlan0 stays NO-CARRIER after boot and apps keep reporting network errors.
   *
   * Worse, the shell (uid 2000) lacks NETWORK_SETTINGS,
   * so `cmd wifi connect-network` throws a SecurityException - the command line is not an option.
   * Instead open the Wi-Fi settings page and tap the saved network, exactly like a user would.
   *
   * @returns {Promise<boolean>} whether it is connected
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
    // Guard: callers may pass the function itself by mistake (rt.adbPath is a method).
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 10000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Once connected, switch the connectivity-check URL to one reachable in this region.
    // Android uses connectivitycheck.gstatic.com to decide "is there really internet"; when that is unreachable
    // the system marks the network with "!" (connected but no internet) and some apps
    // decide they are offline and refuse to load. The replacement endpoint returns 204.
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
    // Nothing to do when it is already connected
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
    // If Wi-Fi was turned off (accidentally / by an earlier -svc wifi disable), turn it on first
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Open the Wi-Fi settings page and tap the AndroidWifi row via uiautomator.
    // More robust than tapping coordinates: those differ by resolution and language.
    await sh('am start -a android.settings.WIFI_SETTINGS');
    await new Promise((r) => setTimeout(r, 2500));
    await sh('uiautomator dump /sdcard/ui.xml');
    const xml = await new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', 'cat', '/sdcard/ui.xml'],
          { timeout: 10000, windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 },
          (e, out) => resolve(e ? '' : String(out || '')));
      } catch (_) { resolve(''); }
    });
    // Nodes look like <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await sh(`input tap ${cx} ${cy}`);
        await new Promise((r) => setTimeout(r, 6000));
        if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // Fallback: try a plain reconnect (some versions dump no text, only content-desc)
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * Start with automatic retries.
   * @param {Function} probe async callback returning 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // Important: emulator.exe is only a launcher and exits after spawning qemu, while this proc
      // object stays around (killed stays false). Trusting it treats an "already shut down machine"
      // as alive - hit right after restarting with a different panel: start() returned
      // reused, the caller used a dead serial with adb, got `device not found`,
      // and switching apps failed outright.
      // So confirm something really runs on the console port before reusing.
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('The previous emulator has exited; booting again...');
      this.proc = null;
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('Runtime engine is not installed; deploy it on the "Runtime" page first');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('System image is not ready; download an Android system image on the "Runtime" page first');
    }

    const s = this.settings;
    // Check disk before booting: the emulator writes the AVD (data partition + snapshot, several GB),
    // so only the free space on that disk decides whether it can boot; the runtime directory only holds logs.
    // Taking the minimum of both wrongly reported "not enough disk" when the data directory had been moved to D:
    // while C: had 400MB left - moving the directory achieved nothing.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Not enough disk space: the disk holding the Android data directory (${avdHome}) has only ${(avdFreeMB / 1024).toFixed(1)} GB left,`
        + ` but the runtime needs at least ${(needMB / 1024).toFixed(1)} GB free. Change it under "Settings -> System Integration -> Android data directory"`
        + ' to a drive with more room (e.g. D:), or free up disk space first. Your apps and saves are never deleted automatically.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `The disk holding the runtime directory (${loc.root}) has only ${(diskMB / 1024).toFixed(1)} GB left,`
        + ' not even enough for logs and temporary files. Free up space, or move the "Runtime data directory" to another drive.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Make every adb call in this process and the emulator use the same server port
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four are independent, so run them in parallel: they used to be "check accel -> version -> probe port -> clear adb server"
    // serially, wasting 3-5s before a cold boot, exactly while users stare at the loading box.
    // A leftover adb server may still hold old device records (pushing the new emulator offline),
    // so it still has to be cleared, just not awaited on its own.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Drivers (compatibility patches): first see what this machine is, then look for patches written for it.
    // Only JSON is read, no code is executed; no match means no effect, exactly as before.
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`Driver load failed: ${e.message}`);
      onLog(`Driver load failed (ignored, starting with defaults): ${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`Drivers applied: ${drv.applied.map((d) => `${d.name} v${d.version}`).join(', ')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('No driver matched; starting with default parameters');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`${drv.errors.length} driver files failed to load (see Settings -> Drivers for the reason)`);
    }

    // Shares one entry point with the settings page and diagnostics, so what is "shown" is what "runs"
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // When a driver pins the render backend / requires software emulation, follow it every round:
    // the whole point of the driver is "this machine only works this way", so retrying a crashing backend just wastes time.
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`Driver pinned the render backend to ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / driver requires software emulation` }));
        onLog('Driver requires hardware acceleration to be off (software emulation)');
      }
    }

    // Remember the GPU backend that crashed immediately last time and try it last this time.
    // Measured on an AMD Radeon 780M: `-gpu host` passes the emulator's own hardware check
    // but the process exits 1 ten-plus seconds after the VM starts (the log only has "AEHD is operational"),
    // wasting 20 seconds before falling back to swangle. The key includes the emulator version,
    // so upgrading the runtime gives it another chance automatically.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    // With Vulkan disabled host may really work: retry once per emulator version,
    // so an old record does not permanently pin users to software rendering (one root cause of "always laggy").
    const vulkanRetried = String(this.settings.engine.badGpuVulkanTried || '');
    const retryHostWithoutVulkan = badGpu === 'host' && badVer === emuVersion && vulkanRetried !== emuVersion;
    if (retryHostWithoutVulkan) {
      store.saveSettings({ engine: { badGpu: '', badGpuVulkanTried: emuVersion } });
      onLog('The last host crash looked Vulkan-related; retrying hardware acceleration with -feature -Vulkan');
    } else if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`The ${badGpu} backend crashed on start last time; trying ${variants[1].gpu} first this time`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // The screen profile stays fixed through the whole start; changing resolution on every retry would drop snapshots constantly.
    // Resolution comes from doctor's profile (quality is configurable), auto picks by acceleration state.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Clear orphans before a cold boot: a leftover qemu holding the AVD lock makes
    // every attempt fail instantly with FATAL "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // A busy port also causes failures, so probe again on every retry
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      // Reset the exit code each round: last round's 0xC0000005 must not leak into this round's diagnosis
      this.lastExitCode = null;
      // Split the log per round too: the in-memory log accumulates, and a crash line from round 1 left at the tail
      // would make round 2 (say a port conflict after switching backends) look like the same crash.
      const logStart = this._log.length;
      onLog(`Starting runtime (attempt ${i + 1}/${variants.length}: ${plan.label})...`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe also takes part in "delete the old snapshot": after a data reset the old snapshot always fails
        // (measured: "Failed to load snapshot" then a cold boot), so clear it before rebuilding.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Hook: main uses this to open the black-window suppressor **before** the emulator starts.
      // The console window appears tens of milliseconds after spawn, so scanning afterwards always flashes;
      // therefore open it first, then spawn.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot applies to this spawn only, so later boots do not degrade into slow cold boots.
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Bad parameters / missing DLLs exit immediately
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // A full disk is not "another parameter set will fix it": retrying only fails again,
        // and historically the last set had wipe, which erased user data. Stop and report honestly.
        if (d.code === 'DISK_FULL') {
          onLog('Not enough disk space; stopping retries (your apps and saves are untouched).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Acceleration / image conclusions may be stale cache, so drop them and re-probe on the next start
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}; retrying with another parameter set...`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // Snapshot restores often finish within seconds, and a fixed 3s poll means waiting 1.5s on average
      // before noticing. Start at 200ms and back off to 1.2s: early boot is caught immediately,
      // and a long boot does not burn CPU on polling.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // Once adb can run a shell the kernel is booting, so ordinary Vulkan/EGL lines in the log are not failures
        if (state === 'booting') sawBooting = true;
        // Still nothing at 45s with a clear fatal error in the log -> switch approach early instead of waiting 4 minutes
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // One progress line every 15s: a modulo test used to print two or three duplicates with adaptive intervals
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Booting... ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // It really booted: clear the previous failure record so diagnostics do not dig up old news
        this._clearFailure();
        // Always save a quickboot snapshot: the emulator process ends when ApkStart exits (Electron's
        // job object kills children), so a snapshot decides between 25s and 7s next time.
        // The installer drops the snapshot when a new app is installed, avoiding "the app vanishes after a restart".
        this.snapshotWorthSaving = true;
        onLog(`Runtime ready (${Math.round(bootMs / 1000)}s, ${plan.label})`);
        // A successful boot is not the same as usable: check the network. Without one, pages stay black
        // and users only say "this app shows a black screen", rarely suspecting the network. Check and say so.
        //
        // But do not "check once and conclude": Wi-Fi association + DHCP typically lag sys.boot_completed by
        // 5-20s, and calling checkNetwork() once meant **every cold boot** logged
        // "no network, reset Android data" five seconds before it came up - users following that
        // would lose every installed app. Give it a 12s window (returning as soon as it is ready),
        // warn only on a real timeout, and never suggest destructive actions.
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* a failed check is not a failed boot */ }
        if (network && !network.ok) {
          onLog('Android has no network yet (Wi-Fi not associated or no address obtained).'
            + ' Apps that need the internet may show a black screen: reopen them in a moment;'
            + ' if it stays offline, use Settings -> Repair network (installed apps are kept).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Boot timed out (a slow first boot or hardware acceleration not active)';
      onLog(`${lastError}; retrying with another parameter set...`);
      // A stuck authorization dialog is not a render backend problem, so do not blacklist the current GPU as "crashes on start",
      // otherwise the next start skips a backend the user's machine can actually use.
      if (d.code !== 'ADB_UNAUTHORIZED') this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `The runtime still will not start after several attempts (${d.title}).\n${d.hint}\n\n`
      + `Tried: ${this.attempts.map((a) => `${a.plan} -> ${a.diagnosis}`).join('; ')}\n`
      + `Diagnostic report: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Save a quickboot snapshot (the next boot restores memory directly, like WSA / quick start).
   *
   * Timing matters: the old implementation saved 6s after boot, competing with the user tapping an app for disk I/O
   * (a snapshot writes 1-3GB), which felt slower. Now it saves when idle, triggered by Runtime
   * when the last app window closes; if that never happens it also saves on shutdown.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // The emulator's save command may answer OK before the write finishes, so confirm by file integrity:
    // only a snapshot.pb that really landed counts (otherwise the next load fails and wastes seconds).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Schedule one "save when idle".
   * Only one is scheduled; if an app is still in front at that time, postpone until genuinely idle.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Skip when there is not enough disk (memory size + 1GB): forcing it fills the disk,
        // which makes the next boot fail. A snapshot only affects boot speed, never data.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Skipping snapshot save: ${(freeMB / 1024).toFixed(1)}GB free < ${(needMB / 1024).toFixed(1)}GB needed`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Graceful stop: on slow machines save the quickboot snapshot, shut down via the console, then force-kill the tree */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // An adopted instance has no proc handle although something really runs on the port, so returning true is wrong
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    // Check guest health before shutting down, asking adb once:
    //  - healthy -> save a snapshot (so the next start is instant if the idle path missed it);
    //  - unhealthy (adb stuck unauthorized / boot not complete) -> do not save and **drop the snapshot after exit**:
    //    `adb emu kill` makes the emulator save a quickboot memory state itself, which also
    //    freezes the unauthorized state. Left alone, the next restore is a "boot always times out" poison snapshot.
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // Writing 3GB takes seconds to twenty-plus, so allow a big timeout instead of killing it halfway.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('Guest unauthorized / not ready at shutdown: dropping the snapshot so the next cold boot re-injects debug authorization');
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Let it finish "write -> exit". A fixed 6s wait used to cut the snapshot write off,
    // leaving a shell with ram.img but no snapshot.pb.
    //
    // Do not wait on this.proc: emulator.exe is only a launcher and exits after spawning qemu;
    // treating its exit as "shutdown complete" jumps straight into the force-kill branch. Use the console port.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    // Once it is really down, drop the launcher handle. Keeping it makes running() return true forever
    // and start() think it can reuse (see the note in start()).
    this.proc = null;
    // The process has exited, so now drop any poison snapshot it may have saved on exit. Order matters:
    // this must come after emu kill + the port closing, or it writes the just-deleted snapshot back.
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
   * Remember the GPU backend that "crashed on start" so it is tried last next time.
   * Only in auto mode: an explicit backend chosen by the user is respected, never silently changed.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Software rendering is the fallback; it is already the slowest/steadiest option with nothing worse to fall back to
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Is something still running on this instance's console port (5554) - "is it really down?" */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * Is the guest healthy enough to save a snapshot: adb authorized + boot complete.
   * On a cold boot with the "Allow USB debugging?" dialog still up, state is unauthorized - saving
   * memory + disk then leaves the guest without the host's adbkey.pub, so the next restore is unauthorized too,
   * every probe's shell throws and 240s of waiting gets misdiagnosed as a GPU/virtualization problem.
   */
  async _adbGuestHealthy(adbPath) {
    if (!adbPath) return false;
    try {
      const { AdbClient } = require('./adb');
      const probe = new AdbClient({ adbPath, serial: this.serial });
      const state = await probe.deviceState();
      const out = await probe.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // unreadable counts as unhealthy
    }
  }

  /**
   * Save a snapshot via adb (false on failure; the caller decides whether to retry).
   * Only when the guest is healthy: better a 20-second cold boot than a "boot always fails" poison snapshot.
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
      this.log('Skipping snapshot save: guest unauthorized or boot incomplete (avoiding an unauthorized poison snapshot)');
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Only the log lines from "this round of start attempts".
   * The in-memory log accumulates (the report needs every attempt), but the diagnosis must only see this round:
   * otherwise round 1's `emulator exit 3221225477` makes any round-2 failure look like the same crash.
   * When this round has no lines at all (the process never started) fall back to the overall tail for at least a conclusion.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Read the last n lines from the emulator.log file (when the in-memory buffer is empty).
   * After a restart the in-memory this._log is empty, which is why old reports
   * only said UNKNOWN - the real crash reason was in the log file all along.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Reading from the start can leave a truncated first line - drop it
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
