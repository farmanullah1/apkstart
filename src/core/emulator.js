'use strict';
/**
<<<<<<< HEAD
 * Emulator engine: drives the Google official Android Emulator as ApkStart's runtime.
 *
 * Biggest difference from the old version: this no longer assumes "one set of parameters runs on every machine".
 *  1. Derives parameters automatically via doctor.chooseProfile() from RAM/CPU/disk/acceleration state/engine version;
 *  2. On launch failure, retries with automatic degradation via planVariants() (GPU backend → software emulation → minimal-memory cold boot);
 *  3. Dynamically picks an idle port, clears AVD locks, converts Chinese paths to short paths, and auto-invalidates snapshots after image changes;
 *  4. quickboot snapshots + a small data partition, sharing a read-only base layer like a container and restoring in seconds.
 *
 * The probe callback is supplied by the upper layer (Runtime) to judge whether Android is truly ready.
=======
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 与旧版最大的不同：这里不再假设「一套参数在所有电脑上都能跑」。
 *  1. 用 doctor.chooseProfile() 按内存/CPU/磁盘/加速状态/引擎版本自动推导参数；
 *  2. 启动失败时按 planVariants() 自动降级重试（GPU 后端 → 软件模拟 → 最小内存冷启动）；
 *  3. 动态挑空闲端口、清 AVD 锁、中文路径转短路径、镜像变更后自动作废快照；
 *  4. quickboot 快照 + 小数据分区，做到「像容器一样」共享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，用于判断 Android 是否真正就绪。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
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
=======
 * Windows 上把 emulator/qemu 的退出码翻译成人话。
 * 0xC0000005（3221225477）是崩溃里最常见的那个：访问冲突，实测多由
 * 显卡驱动 / Vulkan 后端在 guest 启动瞬间崩掉引起，换软件渲染即可绕过。
 */
function describeExitCode(code) {
  // 被信号结束时 code 是 null（Windows 上走 taskkill / adb emu kill 都会这样），
  // 不能当成 0 报「正常退出」，但也谈不上异常，返回空串让调用方原样显示。
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return '正常退出';
    case 1: return '启动参数或环境错误';
    case 3221225477: return '0xC0000005 访问冲突，渲染后端崩溃';
    case 3221225725: return '0xC00000FD 栈溢出';
    case 3221225781: return '0xC0000135 缺少 DLL（VC++ 运行库 / 运行时组件被杀毒删除）';
    case 3221225506: return '0xC0000022 拒绝访问（驱动或权限问题）';
    case 3221225595: return '0xC000007B 镜像位数不匹配或 DLL 损坏';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
     * Driver (compatibility patch) effects applied for this boot, plus the matched driver list.
     * Filled by _resolveDrivers() in start(); buildArgs / env / ensureAvd only read it.
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // A snapshot's ram.bin is roughly the memory given to the VM (2-4GB).
    // Machines that already cold-boot fast should not spend several GB of disk on it; save only when genuinely slow.
=======
     * 本次开机生效的驱动（兼容补丁）效果，以及命中的驱动清单。
     * 由 start() 里的 _resolveDrivers() 填；buildArgs / env / ensureAvd 只读它。
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // 快照的 ram.bin ≈ 分配给虚拟机的内存（2-4GB）。
    // 冷启动本来就快的机器不该为它付出几个 GB 的磁盘，只在「真慢」时才保存。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
<<<<<<< HEAD
   * Persist "last failed start" to disk.
   * Older versions kept it in memory only (this.attempts), so after an ApkStart restart the exported
   * report showed attempts: [], bootLog: [] - the direct cause of "the report is attached but
   * shows no reason" in issues #20/#25.
=======
   * 把「最后一次启动失败」落盘。
   * 旧版只放在内存里（this.attempts），用户重启 ApkStart 后再导出诊断报告，
   * 报告里就是 attempts: []、bootLog: [] 一片空白，只能在日志里翻 —— 这也是
   * issue #20/#25 里「附了报告却看不出原因」的直接原因。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    } catch (_) { /* failing to persist must not break the main flow */ }
  }

  /** Read back the last failure record (used by diagnostics / pre-boot hints) */
=======
    } catch (_) { /* 落盘失败不影响主流程 */ }
  }

  /** 读回上一次失败记录（诊断报告 / 开机前提示用） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

<<<<<<< HEAD
  /** emulator.exe and system image directory (user runtime dir first, then the bundled engine/) */
=======
  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

<<<<<<< HEAD
  /** Pick an image: use the general image (API 34 Play) when available so users never switch "compatibility mode" */
=======
  /** 选镜像：有通用镜像（API 34 Play）就用它，不再让用户切「兼容模式」 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
<<<<<<< HEAD
   * Drop the quickboot snapshot.
   * A snapshot holds both memory and disk state; loading an old one after installing apps or clearing data
   * makes users see "the app I just installed vanished after a restart".
=======
   * 作废 quickboot 快照。
   * 快照同时保存内存和磁盘镜像，装完新应用/清了数据后如果还加载旧快照，
   * 用户会看到「刚刚装好的应用重启后又不见了」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Clear locks left behind by an abnormal exit.
   * Note hardware-qemu.ini.lock is a **directory**, not a file, so rmSync(force) cannot remove it,
   * and the emulator keeps failing with "Running multiple emulators with the same AVD"
   * (true after a forced kill), so removal must be recursive.
=======
   * 清掉上次异常退出留下的锁。
   * 注意 hardware-qemu.ini.lock 是**目录**不是文件，bsdtar 式的 rmSync(force) 删不掉它，
   * 于是模拟器会一直报 "Running multiple emulators with the same AVD" 起不来
   * （被强杀过一次就会这样），必须递归删。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
<<<<<<< HEAD
        } catch (_) { /* still in use - skip and try again next time */ }
=======
        } catch (_) { /* 被占用就跳过，下次再清 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      }
    } catch (_) { /* ignore */ }
  }

  /**
<<<<<<< HEAD
   * Does the AVD directory really hold a **complete** quickboot snapshot?
   * "The directory is not empty" is not enough: an interrupted save leaves a 12-byte snapshot.pb shell,
   * the emulator tries to load it, fails ("does not have the requested snapshot") and falls back to a cold boot,
   * wasting seconds. So validate by file size and clean up shells plus legacy default_boot (3GB each).
=======
   * AVD 目录里是否真的有一份**完整**的 quickboot 快照。
   * 只判断「目录非空」是不够的：保存被中断时会留下一个只有 12 字节 snapshot.pb 的空壳，
   * emulator 会尝试加载、失败（日志 "does not have the requested snapshot"）再回退冷启动，
   * 白等几秒。这里按文件大小校验，顺手清掉空壳和旧版遗留的 default_boot（单个 3GB）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
<<<<<<< HEAD
    // Newer emulators (37.x) write ram.bin, older ones ram.img.
    // Only accepting ram.img is severe: a freshly saved 3GB snapshot gets deleted as an empty shell,
    // so every launch passes -no-snapshot-load and always cold-boots - half the reason "opening is slow".
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // nothing there - do not delete anything
=======
    // 新版 emulator（37.x）写的是 ram.bin，老版本写 ram.img。
    // 只认 ram.img 的后果非常严重：刚存好的 3GB 快照会被当成空壳删掉，
    // 于是每次都带 -no-snapshot-load，永远冷启动 —— 这是「打开很慢」的一半原因。
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // 目录本来就没有，别白删
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

<<<<<<< HEAD
  /** Remove snapshot directories left by older versions / failed renames (default_boot can hold a 3GB ram.img) */
=======
  /** 清掉旧版遗留/失败重命名留下的快照目录（default_boot 里的 ram.img 可达 3GB） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
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
=======
   * 清掉占着 AVD 锁的孤儿模拟器。
   * emulator.exe 只是个启动器，真正的 qemu 被 spawn 成独立进程（detached），
   * 所以只 kill 自己手上的 proc 句柄经常留个孤儿在那占着 multiinstance.lock，
   * 下一次启动就会 FATAL "Running multiple emulators with the same AVD"。
   * 按「AVD 锁里的 pid」+「命令行带本 AVD 名的 qemu/emulator」两个来源清。
   */
  /**
   * 当前 AVD 面板是横的还是竖的。
   *
   * 为什么要问这个：横屏**只能靠物理面板**实现 —— `wm size` 只改逻辑分辨率，画面会
   * 躺倒 90°；`adb emu rotate` 只转内容，系统里还是竖屏。真正生效的是
   * `hw.lcd.width/height` 互换 + 重启。而 config.ini 是每次开机时按当时的设置写的，
   * 所以读它就知道**现在跑着的这台**是什么方向。
   *
   * @returns {boolean|null} true=横屏面板，false=竖屏面板，null=读不到
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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

<<<<<<< HEAD
    // Fast path (hit on every cold boot):
    //  - no .lock -> no live emulator can hold this AVD, return immediately;
    //  - lock present but nothing listening on the port -> leftovers from a forced kill, just clean up.
    // It used to run wmic in every case (1-3s and heavy on CPU), noticeably slowing cold boots.
=======
    // 快速路径（每次冷启动都会走到）：
    //  - 没有 .lock → 不可能有活着的 emulator 占着这个 AVD，直接返回；
    //  - 有 lock 但端口没人监听 → 只是上次强杀留下的残留目录，清掉即可。
    // 以前无论什么情况都要跑一次 wmic（1~3 秒，还很吃 CPU），冷启动时明显拖慢。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
<<<<<<< HEAD
    // 1) the pid the emulator itself wrote into the lock file (most reliable)
=======
    // 1) 锁文件里 emulator 自己写的 pid（最可靠）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
<<<<<<< HEAD
    // 2) fallback: find live qemu by process name + port (tasklist/netstat are an order of magnitude faster than wmic)
=======
    // 2) 兜底：按进程名 + 端口找活着的 qemu（tasklist/netstat 比 wmic 快一个量级）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    } catch (_) { /* without a process list, rely on the pid in the lock file */ }
=======
    } catch (_) { /* 拿不到进程列表就只靠锁文件里的 pid */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
<<<<<<< HEAD
    onLog(`Cleaned up ${pids.size} leftover emulator processes`);
=======
    onLog(`清理 ${pids.size} 个残留模拟器进程`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

<<<<<<< HEAD
  /** Is any emulator console port listening in 5554-5620? (a refused connection returns instantly and costs nothing) */
=======
  /** 5554~5620 里是否有 emulator 控制台端口在监听（连接被拒会立刻返回，代价极小） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Driver report for the UI and diagnostics: which were used this boot, which were skipped, and why.
=======
   * 给界面/诊断用的驱动报告：这次开机用了哪些、跳过了哪些、为什么。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Apply the config.ini overrides a driver declares to the default config.
   * Existing keys are replaced in place (no duplicate lines); missing ones are appended.
   * Only keys on the drivers.js allowlist are handled; invalid keys are rejected during validation.
=======
   * 把驱动声明的 config.ini 覆盖项套到默认配置上。
   * 已存在的键就地替换（不产生重复行），不存在的追加在后面。
   * 只处理 drivers.js 白名单里的键，非法键在校验阶段就被拒了。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Scan the driver directory, pick the ones matching this machine and store the effect for this boot.
   *
   * Directory order is priority: bundled examples (read-only, enabled:false by default) first, user drivers after;
   * on the same id the user directory wins - editing an example takes effect without touching the install directory.
=======
   * 读一遍驱动目录，挑出匹配这台机器的，存成本次开机的效果。
   *
   * 目录顺序即优先级：内置示例（只读，默认 enabled:false）在前，用户驱动在后，
   * 同 id 时用户目录覆盖内置 —— 用户改了示例就能直接生效，不用改安装目录。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    } catch (_) { /* treat as 0; drivers matching on osBuild will not apply */ }
=======
    } catch (_) { /* 拿不到就当 0，匹配条件里带 osBuild 的驱动不会生效 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Prepare the AVD: write config.ini. Rewritten each start from the current auto profile so fallbacks apply immediately.
=======
   * 准备 AVD：写 config.ini。每次启动按当前自动配置重写，保证降级重试即时生效。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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

<<<<<<< HEAD
    // Screen resolution: with hardware acceleration 720x1280@320 is crisp and text stays sharp;
    // in pure software emulation drop to 540x960 for frame rate (56% of the area, far less visible than stutter).
=======
    // 屏幕分辨率：有硬件加速时 720x1280@320 画面清晰、文字不糊；
    // 纯软件模拟时降到 540x960，帧率优先（面积只有 56%，肉眼差距远小于流畅度差距）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
<<<<<<< HEAD
    const tagDisplay = choice.compat ? 'Google Play (ARM compatible)' : 'AOSP';
=======
    const tagDisplay = choice.compat ? 'Google Play (ARM 兼容)' : 'AOSP';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

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
<<<<<<< HEAD
      // Compare "image identity" rather than an absolute path: the same image on another drive/folder is not a new image,
      // otherwise changing the runtime directory wipes every installed app (see doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // Old userdata is incompatible with the new image (APEX boot loop) and must be rebuilt
=======
      // 比较「镜像身份」而不是绝对路径：同一套镜像换盘/换目录不算换镜像，
      // 否则用户一改运行时目录就会被清掉所有已装应用（见 doctor.imageIdentity 注释）。
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // 旧 userdata 与新镜像不兼容（APEX 引导循环），必须重建
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        this.wipePending = true;
      }
    }

<<<<<<< HEAD
    // A config fingerprint change means the old quickboot snapshot will fail to load or show a black screen, so drop it.
    // Note: only the **snapshot** is dropped here, never -wipe-data - user data holds installed apps and saves.
=======
    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废。
    // 注意：这里只作废**快照**，绝不能顺手 -wipe-data —— 用户数据里是已装的应用和存档。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
<<<<<<< HEAD
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* first run */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Deletion may be blocked by the system / security software (snapshot dirs run to several GB).
      // On failure rename it so the emulator cannot load it, but never abort the start because cleanup failed.
=======
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
<<<<<<< HEAD
    // -wipe-data is only needed when the "image changed" (tag / sysdir): old userdata and the new image
    // have incompatible APEX and without a rebuild it loops on boot. Capacity / resolution / renderer changes do not count.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch must be the ABI itself (x86_64 must not be truncated to x86)
=======
    // 只有「镜像换了」（tag / sysdir 变化）才需要 -wipe-data：旧 userdata 与新镜像
    // 的 APEX 不兼容，不重建会一直卡在引导循环。改容量 / 改分辨率 / 换渲染后端都不算。
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      // Older versions hardcoded 16G, which creates huge files on small disks / quotas and slows the first boot
=======
      // 旧版写死 16G，会在小硬盘/配额环境下生成巨型文件并拖慢首次开机
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
<<<<<<< HEAD
      // Virtual Wi-Fi must be enabled explicitly. On API 34 Play images networking runs over
      // wlan0 (the netsim virtual NIC), not the older eth0. Without this line in config.ini
      // the emulator never brings up a link for wlan0 - it stays NO-CARRIER,
      // `dumpsys connectivity` shows "Active default network: none", and apps keep
      // showing "network error, try again later". The -netdelay/-netspeed/-dns-server flags
      // only tune QEMU's user-mode NAT; they do not bring up the guest NIC.
=======
      // 虚拟 Wi-Fi 必须显式打开。API 34 的 Play Store 镜像上网走的是
      // wlan0（netsim 虚拟网卡），不是早期的 eth0。config.ini 里少了这一行，
      // 模拟器就不会给 wlan0 建链路——表现是 wlan0 一直 NO-CARRIER、
      // `dumpsys connectivity` 显示 Active default network: none，应用里就是
      // 一直「网络错误，请稍后再试」。命令行的 -netdelay/-netspeed/-dns-server
      // 都只是 QEMU 用户态 NAT 的参数，跟 guest 内部的网卡有没有被拉起来无关。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
<<<<<<< HEAD
      // Snapshots are fully controlled by -snapshot apkstart: a dedicated name never accidentally loads
      // a legacy default_boot (that is an API30 image's memory state; loading it always boot-loops).
=======
      // 快照完全由命令行 -snapshot apkstart 控制：用独立名字，绝不误加载
      // 旧版遗留的 default_boot（那是 API30 镜像的内存状态，加载必进引导循环）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
<<<<<<< HEAD
      // Orientation and accelerometer must be off: when enabled Android auto-rotates from sensors and turns
      // portrait content sideways (picture rotated 90 degrees, vertical text, black bars). Layout switching now relies
      // only on wm density (smallestWidth) and must not involve sensors.
=======
      // 方向/加速度传感器必须关：一旦开启，Android 会按传感器自动旋转，把竖屏
      // 内容转成横的（画面整体躺倒 90°、文字竖着、四周黑边）。排版切换现在只靠
      // wm density（改 smallestWidth），不需要也不允许传感器参与。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

<<<<<<< HEAD
    // The /data partition must be genuinely usable first, or everything after it waits for nothing (see ensureDataPartition)
=======
    // /data 分区必须先「真的能用」，否则后面一切都是白等（见 ensureDataPartition 注释）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
<<<<<<< HEAD
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
=======
   * 保证 userdata 分区是一个**真正可用**的 ext4 —— 这是「点开应用 30 秒进桌面」的地基。
   *
   * 为什么必须自己做（三条都是实测踩出来的）：
   *  1. 系统镜像包里的 userdata.img 是 1MB 全零占位，真正格式化靠 avdmanager 调 SDK 的
   *     mke2fs。ApkStart 直接写 config.ini 拉 emulator，跳过那一步 → /data 全零 →
   *     内核 "Invalid ext4 superblock on /dev/block/vdc" → guest 掉进 recovery 重启循环 →
   *     adbd 永远不上线 → 上层 probe 一直 pending，最后 240s 超时。原表现：点开要等好几分钟。
   *  2. emulator 自带的 e2fsck/resize2fs 是 cygwin 版 e2fsprogs 1.42.12，**不认识 encrypt
   *     特性**，带这个位它直接 exit 8 拒绝干活，所以「扩文件系统」必须排在补位之前。
   *  3. 文件系统必须 ≥ 分区大小：只给 64MB 的话，APEX 解压 + dexopt 立刻写满，
   *     之后所有 setxattr 返回 ENOSPC → SELinux 标签写不进去 → netd/media/tombstoned
   *     一起 exit 1 → 开机卡在启动动画，adb 永远 offline。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
<<<<<<< HEAD
    try { size = fs.statSync(img).size; } catch (_) { /* missing */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // "Nothing to do" requires both a large enough file and a filesystem that really grew to that size.
      // Checking only the file size misses a real failure: qemu-img enlarged the file while resize2fs failed,
      // leaving a 6GB file with 64MB of Android - users see "not enough space" when installing games.
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // The capacity setting grew (or the filesystem did not): grow in place, no rebuild, keep installed apps
=======
    try { size = fs.statSync(img).size; } catch (_) { /* 不存在 */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // 文件够大 + 文件系统也真的长到了这个大小，才算「不用动」。
      // 只看文件大小会漏掉一种真实故障：qemu-img 撑开了文件、resize2fs 却失败了，
      // 于是文件 6GB、安卓只有 64MB —— 用户看到的就是「装游戏说空间不足」。
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // 容量配置变大了（或文件系统没长到位）：就地扩容，不重建、保留已装应用
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
<<<<<<< HEAD
        this.log(`userdata grow: file ${size} -> ${wantBytes}, filesystem ${fsBytes} -> ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Growing userdata failed (keeping the current partition): ${e.message}`);
        // The old partition still works, but the caller must be told the growth did not happen instead of the settings page claiming success
=======
        this.log(`userdata 扩容：文件 ${size} → ${wantBytes}，文件系统 ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`扩容 userdata 失败（继续用现有分区）：${e.message}`);
        // 老分区仍然可用，但必须如实告诉调用方「这次没扩成」，不能让设置页显示成功
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

<<<<<<< HEAD
    // First run / legacy all-zero placeholder / corrupt image: build a fresh one
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Create it without the encrypt bit first (old e2fsck/resize2fs only work then)
=======
    // 首次 / 旧版留下的全零占位 / 镜像损坏：全新造一个
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // 先不带 encrypt 位（老 e2fsck/resize2fs 才肯干活）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
<<<<<<< HEAD
      this.log(`Rebuilt userdata: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (4K blocks, FBE capable)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Best effort: even if growing failed, restore the encrypt bit so FBE can initialize (the partition will be small)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Rebuilding userdata failed: ${e.message}`);
=======
      this.log(`已重建 userdata：${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4（4K block，支持 FBE）`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // 尽力而为：哪怕扩容失败，也要把 encrypt 位补回去，让 FBE 能初始化（分区会偏小）
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`重建 userdata 失败：${e.message}`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      return { ok: false, created: true, error: e.message };
    }
  }

<<<<<<< HEAD
  /** The bundled qemu-img.exe: enlarge a raw image file to the target size (sparse, instant)
   *  Mind the argument order: `qemu-img <command> -f raw <file> <size>`.
   *  Putting -f before the command makes it a global option and reports unrecognized option. */
=======
  /** emulator 自带 qemu-img.exe：把原始镜像文件撑到目标大小（稀疏，瞬间完成）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <大小>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
<<<<<<< HEAD
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
=======
    if (r.status !== 0) throw new Error(`qemu-img ${op} 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 自带 resize2fs.exe（cygwin 版，必须在 bin64 目录下跑才能找到 DLL） */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('缺少 resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      // Driver-declared env vars: only ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefixes are allowed (see drivers.js)
=======
      // 驱动声明的环境变量：只放行 ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ 前缀（见 drivers.js）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      ...((this._driverEffect && this._driverEffect.env) || {}),
    };
  }

  /**
<<<<<<< HEAD
   * System locale to inject. Defaults to en-US; users can change it in settings (engine.locale).
   * Setting it to 'off' leaves the stock image locale untouched.
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'en-US').trim();
=======
   * 要注入的系统语言。默认简体中文；用户可在设置里改（engine.locale），
   * 设成 'en-US' 或 'off' 就回到镜像原生英文。
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'zh-CN').trim();
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
<<<<<<< HEAD
    // Drivers may pin the render backend / force software emulation. Applied first so it feeds gpu/accel,
    // and everything below (-accel off, config.ini hw.gpu.mode) follows it.
=======
    // 驱动可以固定渲染后端 / 强制软件模拟。放在最前面算进 gpu/accel，
    // 这样后面所有逻辑（-accel off、config.ini 的 hw.gpu.mode）都跟着它走。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
<<<<<<< HEAD
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
=======
      // 音频：默认开启（让安卓应用的提示音/视频声音能放出来）。      // 仅当用户在设置里显式关闭时才传 -no-audio 省一点 CPU。
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主线程被卡住、永远不开机（日志表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      // AMD + emulator 37.x：host 后端的 Vulkan 初始化会失败，进程起来十几秒
      // 后直接 exit 1，于是被记成「host 不可用」永久退回 swangle（软件渲染），
      // 视频/滑动全都掉帧。关掉 Vulkan 让它走 GL，才能真的吃到硬件加速。
      // 软件后端本来就不用 Vulkan，加上只会多一层不确定性，所以只对 host 生效。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      ...(gpu === 'host' && process.platform === 'win32' && doctor.detectGpuVendor() === 'amd'
        ? ['-feature', '-Vulkan'] : []),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
<<<<<<< HEAD
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
=======
    // 网络：AOSP 模拟器默认走 QEMU 用户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x 的虚拟地址，出口直接复用主机的物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上创建任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启用）。
    // 所以安卓应用用的是"一台挂在主机 NAT 后面的设备"，主机网络栈完全不动，
    // 不需要装驱动、也不多一个网络适配器。
    // 显式声明不限速：默认值虽然是 full，但某些 -gpu / -net 组合下会被带上
    // 模拟器的保守配置，视频类应用（红果、抖音）首屏就会明显慢半拍。
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // 系统语言：默认简体中文。
    // 实测 `-prop persist.sys.locale=zh-CN` 完全无效 —— 模拟器会拦截 persist.sys.*
    // 这类受保护属性，ro.product.locale 又被镜像 build.prop 覆盖；guest 里 getprop
    // 一个都看不到。官方专门给了 -change-locale：它会真正改系统语言并重启 framework，
    // 且会写进 /data，从快照恢复也能保留。
    // 用户可在设置里改成其它 locale 或关掉（engine.locale='off'）。
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS：安卓默认用 10.0.2.3（转发到主机 DNS）。主机走 VPN / 公司网 / 某些运营商
    // 时，一次解析能拖到几百毫秒，表现为「页面转圈半天才开始加载」。给一份国内公共
    // DNS 作为首选，失败时系统仍会回退。用户可在设置里关掉（内网域名场景）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
<<<<<<< HEAD
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
=======
      // 注意：**不能再传 -no-skin**。它会覆盖上面的 -skin，让面板尺寸退回
      // config.ini 里的旧值 —— 表现就是「设置里切了横屏、实际还是竖屏」，
      // 以及「画面只占左上角一条」。面板尺寸必须由 -skin 决定。
      // 设备外壳本来就不会画（ShowDeviceFrame=no + 下面这组 style 参数）。
      // 注意：不能用 -qt-hide-window。它会让模拟器**根本不创建**那个 Qt 窗口，
      // 而窗口代理正是靠 SetParent 把这个窗口嵌进应用窗口来显示画面的 ——
      // 用了它之后 probe 永远找不到窗口，用户看到的是一个全黑的应用窗口。
      // 窗口的隐藏改由窗口代理常驻压制完成（见 win/agent.ps1 的 QuietSweep）。
    }
    // 只有快照真的存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份不存在的内存状态，进程活着但永远不开机——
    // 上层只看到「开机超时」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 快照参数决定「下次开机是 8 秒还是 90 秒」，这里是第二个致命点：
    // 老实现「没有快照就传 -no-snapshot」，而 -no-snapshot 同时禁掉了**退出时保存**，
    // 于是第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
    // 正确做法是 -no-snapshot-load：这次不加载（避免等一个不存在的快照），
    // 但退出时照常把内存状态写成 apkstart，下次就直接恢复。
    // 快照要占一份约 2~3GB 的 ram.bin（磁盘紧张的用户可以关掉，只影响启动速度）
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // 重置数据时不能加载旧快照（数据都对不上了），但**必须允许保存新快照**：
      // 修复网络就是靠「重置后第一次开机有网 → 立刻存快照 → 下次恢复」这条链路，
      // 老写法这里推的是 -no-snapshot，会把保存一起关掉，快照永远存不下来。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
<<<<<<< HEAD
      // Network self-heal requires this cold boot: the snapshot may have been saved without a network and restores that way.
=======
      // 网络自愈要求这次冷启动：快照可能是在「没网」时存的，恢复出来依旧没网。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
<<<<<<< HEAD
    // Other driver-declared flags: -gpu / -accel are already handled by gpu/accel above, so skip them here
    // to avoid passing a flag twice (emulator versions disagree on duplicate flags).
=======
    // 驱动声明的其它参数：-gpu / -accel 已经由上面的 gpu/accel 统一处理，这里跳过，
    // 避免同一个参数出现两次（emulator 对重复参数的行为在不同版本上不一致）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel') continue;
      if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    return args;
  }

<<<<<<< HEAD
  /** Start a single process (no boot wait; the probe loop in start() does that) */
=======
  /** 拉起单个进程（不做开机等待，开机等待在 start() 的 probe 循环里） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      // detached: keep the emulator independent of the ApkStart process group.
      // Electron closes its job object on exit and takes child processes with it -
      // which looks like "closing ApkStart and reopening means another 20 second cold boot". Detached it survives,
      // and the next start adopts it (see Runtime.adoptExisting), so opening is instant.
=======
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron 退出时会把自己创建的 job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再打开又要冷启动 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      onLog(`Runtime exited (code=${code}${meaning ? `, ${meaning}` : ''})`);
=======
      onLog(`运行时已退出（code=${code}${meaning ? `，${meaning}` : ''}）`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

<<<<<<< HEAD
    // qemu is detached, so wait until it is really up before lowering its priority.
    // Otherwise 2-4 vCPU threads compete with the Windows desktop at Normal priority,
    // which users feel as "the mouse stutters and the whole machine lags the moment ApkStart opens".
=======
    // qemu 是 detached 的独立进程，等它真正起来再把优先级降下来。
    // 不降的话 2~4 个 vCPU 线程会以 Normal 优先级和 Windows 桌面抢 CPU，
    // 用户最直观的感受就是「一打开 ApkStart，鼠标就发飘、整机变卡」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

<<<<<<< HEAD
  /** Write the emulator log with size-based rotation so long-term use cannot fill the disk */
=======
  /** 写模拟器日志：带大小滚动，避免长期使用把磁盘写满 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

<<<<<<< HEAD
  /** Actual state of the current /data image (for the settings page, without starting Android) */
=======
  /** 当前 /data 镜像的实际情况（设置页展示用，不启动安卓也能取） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
<<<<<<< HEAD
    try { bytes = fs.statSync(img).size; } catch (_) { /* not created yet */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* not created yet or corrupt */ }
=======
    try { bytes = fs.statSync(img).size; } catch (_) { /* 还没建 */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* 还没建或损坏 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
<<<<<<< HEAD
      // Real filesystem size (not the image file size): they differ when the image grew but resize2fs did not
      fsGB,
      configuredGB,
      // The user set a target but the filesystem has not reached it yet
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot creates a qcow2 overlay for userdata; the guest sees that, not the base image
=======
      // 文件系统实际大小（≠ 镜像文件大小）：扩了镜像但 resize2fs 没到位时这两个数会不一样
      fsGB,
      configuredGB,
      // 用户设了目标、但文件系统还没长到目标
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot 会给 userdata 建一层 qcow2 覆盖层，guest 看到的是它，不是底座镜像
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      overlay: this._hasDataOverlay(img),
    };
  }

<<<<<<< HEAD
  /** Is userdata taken over by quickboot's qcow2 overlay (then only a reset works, not in-place growth) */
=======
  /** userdata 是否被 quickboot 的 qcow2 覆盖层接管（有它就只能重置，不能就地扩容） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
<<<<<<< HEAD
   * Grow /data right now (the emulator must be stopped or the image is in use).
   *
   * Two paths, both measured:
   *  - no quickboot overlay: grow in place (qemu-img resize + resize2fs), keeping installed apps;
   *  - with an overlay: the guest mounts `userdata-qemu.img.qcow2`, so growing the base image and the
   *    filesystem to 8GB still shows 5.7GB in `df /data` (the overlay keeps its old size),
   *    and the overlay's filesystem cannot be changed without root. Then the honest answer is "reset required",
   *    not the old success - users would think it grew and a 50GB game would still fail halfway.
=======
   * 立即把 /data 分区扩容到指定大小（必须保证模拟器已停止，否则镜像被占用）。
   *
   * 两种路径，取舍是实测出来的：
   *  - 没有 quickboot 覆盖层：就地扩（qemu-img resize + resize2fs），不丢已装应用；
   *  - 有覆盖层：guest 真正挂载的是 `userdata-qemu.img.qcow2`，底座扩到 8GB、
   *    文件系统也长到 8GB，guest 里 `df /data` 依旧是 5.7GB（覆盖层还是旧大小），
   *    而覆盖层里的文件系统没有 root 权限改不了。这种时候必须如实返回「需要重置」，
   *    不能再像以前那样返回成功 —— 用户会以为扩好了，装 50GB 游戏依旧半路失败。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
        error: `Android is using the quick-boot diff disk; in-place growth cannot reach it (target ${wantGB} GB).`
          + ' Use "Reset Android data" to rebuild /data at the new size - installed apps and saves will be erased, so confirm first.',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition returns ok:false when resize2fs fails; re-check the filesystem size so
    // "the file grew, the filesystem did not" is never reported as success (users see "not enough space" when installing).
=======
        error: `安卓正在用快速启动的差量盘，就地扩容改不到它（目标 ${wantGB} GB）。`
          + '需要「重置安卓数据」后按新容量重建 /data —— 已装应用和存档会被清空，请先确认。',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition 在 resize2fs 失败时会返回 ok:false；再核一次文件系统大小，
    // 防止「文件撑开了、文件系统没长」被当成功（用户看到的就是装游戏说空间不足）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
<<<<<<< HEAD
        error: `The image grew to ${wantGB} GB, but the filesystem only reached ${(fsAfter / 1073741824).toFixed(1)} GB (resize2fs did not succeed).`
          + ' Try "Grow now" again, or free up disk space and retry.',
=======
        error: `镜像已扩到 ${wantGB} GB，但文件系统只到 ${(fsAfter / 1073741824).toFixed(1)} GB（resize2fs 没成功）。`
          + '可以再点一次「立即扩容」，或清理磁盘后重试。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      };
    }
    return r;
  }

  /**
<<<<<<< HEAD
   * Adjust the priority of this machine's qemu/emulator processes (only those whose command line names this AVD).
   * level: idle (container parked) | below (an app is in front) | normal (performance first).
=======
   * 调整本机 qemu/emulator 进程的优先级（只匹配命令行里带本 AVD 名的进程）。
   * level: idle（容器停放）| below（有应用在前台）| normal（性能优先）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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

<<<<<<< HEAD
  /** Force-kill the current attempt (including the qemu process tree) */
=======
  /** 强杀当前尝试（含 qemu 子进程树） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // The proc handle is often gone already (emulator.exe exits after launching, qemu is detached),
    // so without a fallback cleanup by process name the next round fails on the AVD lock with FATAL.
=======
    // proc 句柄常常已经没了（emulator.exe 启动完就退出，qemu 是 detached 的独立进程），
    // 不按进程名兜底清一遍，下一轮就会被 AVD 锁挡成 FATAL。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
<<<<<<< HEAD
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
=======
   * 重建本专用端口上的 adb server。
   *
   * 这里是「打开应用要等两分钟」最主要的元凶，历史实现只 kill-server 就返回了：
   * emulator 在启动瞬间会去连 ANDROID_ADB_SERVER_PORT 上的 adb daemon，
   * 连不上就**再也不注册这台设备** —— adb devices 里要么没有 emulator-5554，
   * 要么永远停在 offline（日志里就是那句 "Unable to connect to adb daemon on port: 5044"）。
   * 于是上层 probe 一直拿不到 sys.boot_completed，白等 3 分钟超时后重试，
   * 每次重试都是全量冷启动，快照也因为「设备不在线」保存不了，形成死循环。
   *
   * 所以必须先 kill（清掉旧设备记录）再 start，并等到端口真的在监听才返回。
   */
  /** 供上层在 adb 传输卡住（offline / unauthorized）时主动重启一次 server */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
<<<<<<< HEAD
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* use the one on PATH */ }
=======
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* 用 PATH 里的 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
<<<<<<< HEAD
    // adb start-server returns quickly on some machines while the port is not listening yet,
    // so wait until it accepts a connection (up to ~3s, normally tens of milliseconds).
=======
    // adb start-server 在部分机器上同步返回得很快，但端口还没真正 listen，
    // 这里等到能连上为止（最多 ~3 秒，正常几十毫秒）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Handle the "exit right after spawn" case.
   * Bad parameters / missing DLLs usually make the emulator exit within a second; while the process lives this returns at once,
   * with no need to waste a fixed 2.5s - on a snapshot restore that is enough to finish half the boot.
=======
   * 等待「spawn 后马上退」的情况。
   * 参数错误/DLL 缺失时 emulator 通常 1 秒内就退；进程还在则立刻返回，
   * 不必再干等固定 2.5 秒 —— 快照恢复时这段时间足够开机跑完一半。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Make the **next start** cold-boot (no quickboot snapshot).
   *
   * The snapshot also captures NIC state: one saved without a network keeps restoring without one.
   * Cold-booting once during network self-heal bypasses that bad snapshot.
=======
   * 让「下一次启动」强制冷启动（不加载快速启动快照）。
   *
   * 快照里连网卡状态一起被保存：如果快照是在「没网」的时候存的，之后每次恢复都会
   * 继续没网。网络自愈时先冷启动一次能绕开这份坏快照。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
<<<<<<< HEAD
   * Make the **next start** pass -wipe-data (only used by "repair network" after several attempts fail).
   * Deleting the userdata image file is not the same as the emulator's `-wipe-data`, so use the latter.
=======
   * 让「下一次启动」带上 -wipe-data（仅「修复网络」在多种尝试都失败后使用）。
   * 「删掉 userdata 镜像文件」与 emulator 的 `-wipe-data` 并不等价，必须走后者。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
<<<<<<< HEAD
   * Check whether the VM really has a working network.
   *
   * Why: the VM's Wi-Fi config lives in /data, and once it is corrupted (typically the same AndroidWifi
   * appearing twice in `cmd wifi list-networks` with colliding ids) wlan0 stays NO-CARRIER and gets no IP.
   * Network pages then render as a black screen in apps - that is the reported "black screen after tapping Agree",
   * entirely unrelated to GPU/rendering.
   *
   * @param {string} [adbPath] explicit adb executable (Runtime resolves a better one)
=======
   * 体检虚拟机内是否真的能联网。
   *
   * 为什么需要这一步：安卓虚拟机的 Wi-Fi 配置存在 /data 里，一旦写坏（典型表现是
   * `cmd wifi list-networks` 里同一个 AndroidWifi 出现两条、网络 id 撞车），
   * wlan0 就会一直 NO-CARRIER、拿不到 IP。这时「需要联网的页面」在应用里就是一块
   * 黑屏 —— 用户看到的「红果点同意后黑屏」就是这么来的，跟 GPU/渲染完全无关。
   *
   * @param {string} [adbPath] 显式指定 adb 可执行文件（Runtime 有更权威的解析）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
<<<<<<< HEAD
    // Like repairWifi: guard against callers passing a function where a path is expected
=======
    // 同 repairWifi：防住「把函数当路径传进来」这种调用错误
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let adb = typeof adbPath === 'function' ? adbPath() : (adbPath || '');
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
<<<<<<< HEAD
      // adbVersionPath() only checks the "version file", which is empty in many install layouts;
      // looking for the bundled platform-tools under the runtime root is more reliable.
=======
      // adbVersionPath() 只查「版本文件」，很多安装形态下是空的；
      // 直接按运行时根目录找 bundled 的 platform-tools 才稳。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // Android's multiple routing tables make the main table of `ip route` look empty (the default route lives in the per-interface table),
    // and the shell uid is not in the app network group, so `ping` often reports "Network is unreachable" wrongly,
    // even when Wi-Fi is connected and apps work. So rely on "did we get an IPv4 address"
    // plus `cmd wifi status` as a cross-check, never on ping.
=======
    // 安卓的多路由表会让 `ip route` 的主表看起来是空的（默认路由在 per-interface 表里），
    // 而且 shell 的 uid 不在应用的 network 组里，`ping` 经常误报 "Network is unreachable"，
    // 哪怕 Wi-Fi 其实已经连上、应用也能正常上网。所以这里只认「有没有拿到 IPv4 地址」，
    // 再叠加 `cmd wifi status` 的连接状态做交叉确认，不用 ping 判断。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      // Wi-Fi association + DHCP often finish tens of seconds after sys.boot_completed.
      // When the caller passed waitMs, keep waiting instead of concluding "no network" right now.
=======
      // Wi-Fi 关联 + DHCP 往往比 sys.boot_completed 晚几十秒才完成。
      // 调用方给了 waitMs 就继续等，不要在这一刻就断定「没有网络」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // An IP does not mean the internet works. Measured: 10.0.2.16 assigned but DNS/routing blocked still leaves
    // app home pages on "network error" while the caller assumes the network is fine. Add a real HTTP probe.
    // Use nc against port 80 rather than ping: QEMU user-mode NAT drops ICMP, so ping always lies.
    // Only on the "wait for network" path (waitMs>0); fast polling skips it - otherwise every 3s
    // would spend 4s probing and slow the boot. The result goes into reachable without changing ok: with an IP
    // let the app start; one DNS hiccup must not block the whole launch.
=======
    // 有 IP 不等于能上网。实测拿到 10.0.2.16 但 DNS/路由被掐时，应用首页还是
    // 「网络错误」，而上层却以为网络正常。这里补一次真实 HTTP 探测。
    // 用 nc 直连 80 端口而不是 ping：QEMU 用户态 NAT 会拦 ICMP，ping 必然误报。
    // 只在「等待网络就绪」那条路径（waitMs>0）上做，快速轮询跳过——否则每 3 秒
    // 就要花 4 秒探测，反而把启动拖慢。结论放进 reachable，不改 ok：有 IP 就先
    // 让应用起来，一次 DNS 抖动不该卡住整个启动。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
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
=======
   * 把「已保存但不会自动连」的 AndroidWifi 主动连上。
   *
   * 这是实机踩出来的：模拟器自带的虚拟热点 AndroidWifi 在配置库里可能落成
   * 两条记录（open + owe），系统据此判定为
   *   「Saved / Won't automatically connect」
   * 于是开机后 wlan0 永远 NO-CARRIER，应用里一直报网络错误。
   *
   * 麻烦的是 shell（uid 2000）没有 NETWORK_SETTINGS 权限，
   * `cmd wifi connect-network` 会直接抛 SecurityException，所以不能走命令行。
   * 这里改为拉起 Wi-Fi 设置页、点一下那条已保存的网络——和用户手动点的效果一样。
   *
   * @returns {Promise<boolean>} 是否已连上
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  async repairWifi(adbPath = '') {
    const fs = require('fs');
    const path = require('path');
<<<<<<< HEAD
    // Guard: callers may pass the function itself by mistake (rt.adbPath is a method).
=======
    // 防御：调用方可能误把函数本身传进来（rt.adbPath 是个方法）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // Once connected, switch the connectivity-check URL to one reachable in this region.
    // Android uses connectivitycheck.gstatic.com to decide "is there really internet"; when that is unreachable
    // the system marks the network with "!" (connected but no internet) and some apps
    // decide they are offline and refuse to load. The replacement endpoint returns 204.
=======
    // 连上之后顺手把「联网验证」的探测地址换成国内可达的。
    // 安卓默认拿 connectifitycheck.gstatic.com 判断「是否真能上网」，国内连不上它，
    // 系统就一直给网络打「!」标记（已连接但无法访问互联网）。部分应用会因此
    // 自我判定为离线、拒绝加载内容。换成一个返回 204 的国内端点即可。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const tune = async () => {
      await sh('settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204');
      await sh('settings put global captive_portal_mode 0');
    };
<<<<<<< HEAD
    // Nothing to do when it is already connected
=======
    // 已经连上就别折腾了
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (/Wifi is connected/i.test(await sh('cmd wifi status'))) {
      await tune();
      return true;
    }
<<<<<<< HEAD
    // If Wi-Fi was turned off (accidentally / by an earlier -svc wifi disable), turn it on first
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // Open the Wi-Fi settings page and tap the AndroidWifi row via uiautomator.
    // More robust than tapping coordinates: those differ by resolution and language.
=======
    // 开关被关掉时（用户手滑 / 之前 -svc wifi disable）先打开
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 1500));

    // 打开 Wi-Fi 设置页，用 uiautomator 找到 AndroidWifi 那一行再点它。
    // 比按坐标点稳：不同分辨率 / 语言下坐标都不一样。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // Nodes look like <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
=======
    // 节点形如 <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
    // Fallback: try a plain reconnect (some versions dump no text, only content-desc)
=======
    // 兜底：直接重连一次看看（有些版本 dump 里没有 text，只有 content-desc）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
<<<<<<< HEAD
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
=======
   * 启动 + 自动重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      // 关键：emulator.exe 只是启动器，spawn 完 qemu 自己就退出了，而这个 proc
      // 对象会一直留着（killed 仍是 false）。只看它会把「已经关掉的机器」当成
      // 还活着 —— 重启换面板后紧接着 ensure() 就踩过这个坑：start() 直接返回
      // reused，调用方拿着一个已经死掉的 serial 去 adb，报 `device not found`，
      // 表现就是「切换应用到另一个方向的 App 直接失败」。
      // 所以必须再确认控制台端口上真的有机器在跑，才算复用。
      if (await this._consoleAlive()) {
        return { ok: true, reused: true, serial: this.serial, port: this.port };
      }
      onLog('上一次的模拟器已经退出，重新开机…');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      this.proc = null;
    }

    const loc = this.locate();
<<<<<<< HEAD
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
=======
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');
    }

    const s = this.settings;
    // 开机前先看一眼磁盘：模拟器写的是 AVD（数据分区 + 快照，几个 GB），
    // 只有它所在磁盘的余量才决定能不能开机；运行时目录只写日志，要求低得多。
    // 之前把两者的余量取最小值，结果「数据目录已经挪到 D 盘、C 盘只剩 400MB」
    // 会被误判成磁盘不足 —— 挪盘等于白挪。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
<<<<<<< HEAD
      const msg = `Not enough disk space: the disk holding the Android data directory (${avdHome}) has only ${(avdFreeMB / 1024).toFixed(1)} GB left,`
        + ` but the runtime needs at least ${(needMB / 1024).toFixed(1)} GB free. Change it under "Settings -> System Integration -> Android data directory"`
        + ' to a drive with more room (e.g. D:), or free up disk space first. Your apps and saves are never deleted automatically.';
=======
      const msg = `磁盘空间不足：安卓数据目录（${avdHome}）所在磁盘只剩 ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `运行时至少要 ${(needMB / 1024).toFixed(1)} GB 可用。请在「设置 → 系统集成 → 安卓数据目录」`
        + '把它改到空间充足的盘（例如 D:），或先清理磁盘。你的应用与存档不会被自动删除。';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
<<<<<<< HEAD
      const msg = `The disk holding the runtime directory (${loc.root}) has only ${(diskMB / 1024).toFixed(1)} GB left,`
        + ' not even enough for logs and temporary files. Free up space, or move the "Runtime data directory" to another drive.';
=======
      const msg = `运行时目录（${loc.root}）所在磁盘只剩 ${(diskMB / 1024).toFixed(1)} GB，`
        + '连日志和临时文件都写不下。请清理磁盘，或把「运行时数据目录」也换到别的盘。';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
<<<<<<< HEAD
    // Make every adb call in this process and the emulator use the same server port
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // These four are independent, so run them in parallel: they used to be "check accel -> version -> probe port -> clear adb server"
    // serially, wasting 3-5s before a cold boot, exactly while users stare at the loading box.
    // A leftover adb server may still hold old device records (pushing the new emulator offline),
    // so it still has to be cleared, just not awaited on its own.
=======
    // 让本进程里所有 adb 调用和 emulator 用同一个 server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // 这四件事互不依赖，并行做：以前是「加速检查 → 版本 → 探端口 → 清 adb server」串行，
    // 冷启动前白等 3~5 秒，正好是用户点开应用后盯着加载框的那段时间。
    // 上一次运行留下的 adb server 可能还挂着旧设备记录（会把新模拟器挤成 offline），
    // 所以清 server 仍然要做，只是不必单独等它。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

<<<<<<< HEAD
    // Drivers (compatibility patches): first see what this machine is, then look for patches written for it.
    // Only JSON is read, no code is executed; no match means no effect, exactly as before.
=======
    // 驱动（兼容补丁）：先看清这台机器是什么样，再看有没有人给它写过补丁。
    // 这一步只读 JSON，不执行任何代码；匹配不上就是空效果，行为和以前完全一致。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
<<<<<<< HEAD
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
=======
      this.log(`驱动加载失败：${e.message}`);
      onLog(`驱动加载失败（已忽略，按默认参数启动）：${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`已应用驱动：${drv.applied.map((d) => `${d.name} v${d.version}`).join('、')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('未匹配到任何驱动，按默认参数启动');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`有 ${drv.errors.length} 个驱动文件没加载成功（设置 → 驱动 里能看到原因）`);
    }

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
<<<<<<< HEAD
    // When a driver pins the render backend / requires software emulation, follow it every round:
    // the whole point of the driver is "this machine only works this way", so retrying a crashing backend just wastes time.
=======
    // 驱动指定了渲染后端 / 要求软件模拟时，每一轮都按它来：
    // 用户装驱动的目的就是「这台机器只能用这一档」，继续先试崩过的后端只会白等。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
<<<<<<< HEAD
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
=======
        onLog(`驱动把渲染后端固定为 ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / 驱动要求软件模拟` }));
        onLog('驱动要求关闭硬件加速（走软件模拟）');
      }
    }

    // 记住「上次拉起就崩」的 GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己的硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（日志里只有 "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级运行时后自动重新给它一次机会。
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    // 关掉 Vulkan 之后 host 有机会真的可用：每个 emulator 版本重试一次，
    // 免得老记录把用户永久钉在软件渲染上（那是「一直卡」的根因之一）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const vulkanRetried = String(this.settings.engine.badGpuVulkanTried || '');
    const retryHostWithoutVulkan = badGpu === 'host' && badVer === emuVersion && vulkanRetried !== emuVersion;
    if (retryHostWithoutVulkan) {
      store.saveSettings({ engine: { badGpu: '', badGpuVulkanTried: emuVersion } });
<<<<<<< HEAD
      onLog('The last host crash looked Vulkan-related; retrying hardware acceleration with -feature -Vulkan');
=======
      onLog('上次 host 渲染崩溃疑似 Vulkan 导致，本次以 -feature -Vulkan 重试硬件加速');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    } else if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
<<<<<<< HEAD
        onLog(`The ${badGpu} backend crashed on start last time; trying ${variants[1].gpu} first this time`);
=======
        onLog(`上次 ${badGpu} 渲染后端启动即崩溃，本次改用 ${variants[1].gpu} 先试`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

<<<<<<< HEAD
    // The screen profile stays fixed through the whole start; changing resolution on every retry would drop snapshots constantly.
    // Resolution comes from doctor's profile (quality is configurable), auto picks by acceleration state.
=======
    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照。
    // 分辨率来自 doctor 的 profile（设置里可改「画质」），auto 时按加速状态选。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

<<<<<<< HEAD
    // Clear orphans before a cold boot: a leftover qemu holding the AVD lock makes
    // every attempt fail instantly with FATAL "Running multiple emulators with the same AVD".
=======
    // 冷启前先清孤儿：上一次运行留下的 qemu 仍占着 AVD 锁时，
    // 所有尝试都会立刻 FATAL "Running multiple emulators with the same AVD"。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
<<<<<<< HEAD
      // A busy port also causes failures, so probe again on every retry
=======
      // 端口占用也会导致失败，每次重试重新探测一次
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
<<<<<<< HEAD
      // Reset the exit code each round: last round's 0xC0000005 must not leak into this round's diagnosis
      this.lastExitCode = null;
      // Split the log per round too: the in-memory log accumulates, and a crash line from round 1 left at the tail
      // would make round 2 (say a port conflict after switching backends) look like the same crash.
      const logStart = this._log.length;
      onLog(`Starting runtime (attempt ${i + 1}/${variants.length}: ${plan.label})...`);
=======
      // 每轮重置退出码：上一轮 0xC0000005 不能带进下一轮的诊断里
      this.lastExitCode = null;
      // 日志也按轮切分：内存日志是跨轮累积的，第 1 轮的崩溃行若留在尾部，
      // 第 2 轮（比如换后端后端口冲突）会被误诊成同一个崩溃。
      const logStart = this._log.length;
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
<<<<<<< HEAD
        // _forceWipe also takes part in "delete the old snapshot": after a data reset the old snapshot always fails
        // (measured: "Failed to load snapshot" then a cold boot), so clear it before rebuilding.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Hook: main uses this to open the black-window suppressor **before** the emulator starts.
      // The console window appears tens of milliseconds after spawn, so scanning afterwards always flashes;
      // therefore open it first, then spawn.
=======
        // _forceWipe 也要参与「删旧快照」：重置数据后旧快照必然加载失败
        // （实测报 Failed to load snapshot 后退回冷启动），必须先清掉再重建。
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // 埋点：上层（main）用它在拉起模拟器**之前**打开黑窗压制。
      // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
      // 所以这里必须先把它打开、再拉起进程。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
<<<<<<< HEAD
      // _coldBoot applies to this spawn only, so later boots do not degrade into slow cold boots.
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Bad parameters / missing DLLs exit immediately
=======
      // _coldBoot 只对这次 spawn 生效，避免之后每次开机都退化成长时间冷启动
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // 参数错误 / DLL 缺失会立刻退出
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
<<<<<<< HEAD
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
=======
        // 磁盘写满不是「换组参数就能好」的问题：继续重试只会反复失败，
        // 而且历史上最后那组参数带 wipe，会把用户数据一起抹掉。直接收工、如实报错。
        if (d.code === 'DISK_FULL') {
          onLog('磁盘空间不足，已停止重试（不会动你的应用与存档）。');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // 加速/镜像类结论可能是缓存里的旧数据，作废掉，下次启动重新探测
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}，自动换一组参数重试…`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      // Snapshot restores often finish within seconds, and a fixed 3s poll means waiting 1.5s on average
      // before noticing. Start at 200ms and back off to 1.2s: early boot is caught immediately,
      // and a long boot does not burn CPU on polling.
=======
      // 快照恢复往往几秒内就能起，固定 3 秒一次意味着平均要多等 1.5 秒才「发现」
      // 它已经好了。这里从 200ms 起步逐步放宽到 1.2 秒：开机早期能立刻抓到，
      // 长引导过程也不会把 CPU 花在轮询上。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
        // Once adb can run a shell the kernel is booting, so ordinary Vulkan/EGL lines in the log are not failures
        if (state === 'booting') sawBooting = true;
        // Still nothing at 45s with a clear fatal error in the log -> switch approach early instead of waiting 4 minutes
=======
        // 只要 adb 能执行 shell，说明内核已经在引导，日志里的普通 Vulkan/EGL 信息不算失败
        if (state === 'booting') sawBooting = true;
        // 45 秒仍完全没连上，且日志出现明确致命错误 → 提前换方案，不干等 4 分钟
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
<<<<<<< HEAD
        // One progress line every 15s: a modulo test used to print two or three duplicates with adaptive intervals
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Booting... ${Math.round((Date.now() - started) / 1000)}s`);
=======
        // 每 15 秒一条进度：以前用「取模」判断，自适应间隔下会连着打两三条重复的
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
<<<<<<< HEAD
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
=======
        // 这一次真的起来了：清掉上次的失败记录，避免以后「诊断」翻出旧账
        this._clearFailure();
        // 一定要存 quickboot 快照：模拟器进程会随 ApkStart 退出而结束（Electron 的
        // job 对象会连带杀掉子进程），下次打开有没有快照直接决定是 25 秒还是 7 秒。
        // 装完新应用时 installer 会作废快照，避免"重启后应用消失"。
        this.snapshotWorthSaving = true;
        onLog(`运行时就绪（${Math.round(bootMs / 1000)}s，${plan.label}）`);
        // 开机成功不等于能用：顺手体检网络。虚拟机没网时，需要联网的页面会一直黑屏，
        // 用户只会说「这个应用黑屏」，很难联想到是网络。这里主动查一次并说清楚。
        //
        // 但不能「查一次就下结论」：Wi-Fi 关联 + DHCP 普遍比 sys.boot_completed 晚
        // 5~20 秒，以前这里只调 checkNetwork() 一次，于是**每次冷启动**都会打一条
        // 「⚠ 没有网络，请重置安卓数据」，而 5 秒后网络就绪了 —— 用户照着做就会
        // 丢光已装应用。现在给它 12 秒等待窗口（就绪即返回），真超时才提示，
        // 而且不再建议破坏性操作。
        let network = null;
        try {
          network = await this.checkNetwork('', { waitMs: 12000, interval: 3000 });
        } catch (_) { /* 体检失败不算启动失败 */ }
        if (network && !network.ok) {
          onLog('⚠ 安卓虚拟机暂时没连上网（Wi-Fi 未关联或没拿到地址）。'
            + '需要联网的应用打开后可能一直黑屏：稍后重开应用即可；'
            + '若持续无网，可在「设置 → 修复网络」重连（不会删除已装应用）。');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Boot timed out (a slow first boot or hardware acceleration not active)';
      onLog(`${lastError}; retrying with another parameter set...`);
      // A stuck authorization dialog is not a render backend problem, so do not blacklist the current GPU as "crashes on start",
      // otherwise the next start skips a backend the user's machine can actually use.
=======
      lastError = fatal ? `${d.title}：${d.hint}` : '开机超时（可能是首次引导较慢或硬件加速未生效）';
      onLog(`${lastError}，自动换一组参数重试…`);
      // 授权对话框卡住不是渲染后端的问题，别把当前 GPU 记进「启动即崩」黑名单，
      // 否则下次启动会无缘无故跳过用户机器本来能用的后端。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      `The runtime still will not start after several attempts (${d.title}).\n${d.hint}\n\n`
      + `Tried: ${this.attempts.map((a) => `${a.plan} -> ${a.diagnosis}`).join('; ')}\n`
      + `Diagnostic report: ${report.file}`,
=======
      `运行时多次尝试仍未能启动（${d.title}）。\n${d.hint}\n\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `诊断报告：${report.file}`,
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
<<<<<<< HEAD
   * Save a quickboot snapshot (the next boot restores memory directly, like WSA / quick start).
   *
   * Timing matters: the old implementation saved 6s after boot, competing with the user tapping an app for disk I/O
   * (a snapshot writes 1-3GB), which felt slower. Now it saves when idle, triggered by Runtime
   * when the last app window closes; if that never happens it also saves on shutdown.
=======
   * 保存 quickboot 快照（下次开机直接恢复内存状态，像 WSA/应用宝的快速启动）。
   *
   * 时机很重要：以前的实现是开机后 6 秒就存，正好和用户点开应用抢磁盘 I/O
   * （快照要写 1~3GB），体感反而更慢。改成「空闲时再存」，并由 Runtime 在
   * 最后一个应用窗口关闭时触发；关机前若还没来得及存，也会补一次。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
<<<<<<< HEAD
    // The emulator's save command may answer OK before the write finishes, so confirm by file integrity:
    // only a snapshot.pb that really landed counts (otherwise the next load fails and wastes seconds).
=======
    // emulator 的 save 命令可能在写盘中途就回 OK，这里按文件完整性再确认一次，
    // 只有 snapshot.pb 真正落盘才算数（否则下次加载会失败并白等几秒）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
<<<<<<< HEAD
   * Schedule one "save when idle".
   * Only one is scheduled; if an app is still in front at that time, postpone until genuinely idle.
=======
   * 安排一次「空闲时保存快照」。
   * 只排一次；如果到点时容器还有应用在前台，就推迟到真正空闲。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
<<<<<<< HEAD
        // Skip when there is not enough disk (memory size + 1GB): forcing it fills the disk,
        // which makes the next boot fail. A snapshot only affects boot speed, never data.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Skipping snapshot save: ${(freeMB / 1024).toFixed(1)}GB free < ${(needMB / 1024).toFixed(1)}GB needed`);
=======
        // 磁盘余量不够写快照（内存大小 + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接失败。快照只影响启动速度，不写也不影响数据。
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`跳过快照保存：磁盘剩余 ${(freeMB / 1024).toFixed(1)}GB < 需要 ${(needMB / 1024).toFixed(1)}GB`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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

<<<<<<< HEAD
  /** Graceful stop: on slow machines save the quickboot snapshot, shut down via the console, then force-kill the tree */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // An adopted instance has no proc handle although something really runs on the port, so returning true is wrong
=======
  /** 优雅停止：慢机器先保存 quickboot 快照，再走控制台关机，最后强杀进程树 */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // 接管来的实例没有 proc 句柄，但端口上确实有机器在跑，不能直接返回 true 走人
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
<<<<<<< HEAD
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
=======
    // 关机前先判断 guest 是否健康，只在这一次判断里问一遍 adb：
    //  - 健康 → 补存一次快照（空闲路径没来得及存时，下次仍能秒进）；
    //  - 不健康（adb 卡在 unauthorized / 没开机完成）→ 不存，并且**在退出后作废快照**：
    //    `adb emu kill` 会让 emulator 自己按 quickboot 存一份内存状态，那份同样会
    //    冻结未授权状态。不在这里清掉，下次恢复又是一份「开机必超时」的毒快照。
    const healthy = adbPath ? await this._adbGuestHealthy(adbPath) : false;
    if (adbPath && this.snapshotWorthSaving !== false && healthy) {
      // 3GB 内存写盘要几秒到二十几秒，超时给足，别让快照写一半就被 kill 掉。
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (!healthy && this.snapshotWorthSaving !== false) {
      this.log('关机时 guest 未授权/未就绪：将作废快照，下次冷启动重新注入调试授权');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
<<<<<<< HEAD
    // Let it finish "write -> exit". A fixed 6s wait used to cut the snapshot write off,
    // leaving a shell with ram.img but no snapshot.pb.
    //
    // Do not wait on this.proc: emulator.exe is only a launcher and exits after spawning qemu;
    // treating its exit as "shutdown complete" jumps straight into the force-kill branch. Use the console port.
=======
    // 等它自己走完「落盘 → 退出」的流程。以前固定等 6 秒就强杀，
    // 正好把快照写盘掐断，留下一个只有 ram.img 没有 snapshot.pb 的空壳。
    //
    // 注意不能等 this.proc：emulator.exe 只是个启动器，spawn 完 qemu 自己就退了，
    // 拿它的 exit 当「关机完成」会立刻进入强杀分支。这里以控制台端口为准。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
<<<<<<< HEAD
    // Once it is really down, drop the launcher handle. Keeping it makes running() return true forever
    // and start() think it can reuse (see the note in start()).
    this.proc = null;
    // The process has exited, so now drop any poison snapshot it may have saved on exit. Order matters:
    // this must come after emu kill + the port closing, or it writes the just-deleted snapshot back.
=======
    // 关干净了就把启动器句柄丢掉。留着它会让 running() 永远返回 true、
    // start() 以为还能复用（见 start() 里的注释）。
    this.proc = null;
    // 进程已退出，这时再作废它可能在退出时自动存的毒快照。顺序很重要：必须放在
    // emu kill + 端口关闭之后，否则它会把刚删的快照又写回来。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (!healthy && this.snapshotWorthSaving !== false) {
      try { this.invalidateSnapshot(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  /**
<<<<<<< HEAD
   * Remember the GPU backend that "crashed on start" so it is tried last next time.
   * Only in auto mode: an explicit backend chosen by the user is respected, never silently changed.
=======
   * 记下「拉起就崩」的 GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效：用户显式指定后端时尊重用户选择，不偷偷改。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
<<<<<<< HEAD
      // Software rendering is the fallback; it is already the slowest/steadiest option with nothing worse to fall back to
=======
      // 软件渲染是兜底项，它已经是最慢/最稳的选择，没有更差的替代品可退
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

<<<<<<< HEAD
  /** Is something still running on this instance's console port (5554) - "is it really down?" */
=======
  /** 本实例的控制台端口（5554）上是否还有机器在跑 —— 判断「到底关干净了没有」 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
   * Is the guest healthy enough to save a snapshot: adb authorized + boot complete.
   * On a cold boot with the "Allow USB debugging?" dialog still up, state is unauthorized - saving
   * memory + disk then leaves the guest without the host's adbkey.pub, so the next restore is unauthorized too,
   * every probe's shell throws and 240s of waiting gets misdiagnosed as a GPU/virtualization problem.
=======
   * guest 是否处于「可以安全存快照」的健康状态：adb authorized + boot 完成。
   * 冷启动时若「允许 USB 调试吗？」对话框还挂着，state 是 unauthorized —— 这时存下
   * 内存 + 磁盘，guest 里就没有 host 的 adbkey.pub，下次恢复还是 unauthorized，
   * 每轮探测的 shell 都抛异常，干等 240s 还被误诊成显卡/虚拟化问题。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
      return false; // unreadable counts as unhealthy
=======
      return false; // 读不到就按不健康处理
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    }
  }

  /**
<<<<<<< HEAD
   * Save a snapshot via adb (false on failure; the caller decides whether to retry).
   * Only when the guest is healthy: better a 20-second cold boot than a "boot always fails" poison snapshot.
=======
   * 用 adb 触发一次快照保存（失败返回 false，调用方决定要不要再试）。
   * 只有 guest 健康时才存，宁可下次冷启动 20 多秒，也不能存一份「开机必失败」的毒快照。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  async _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    if (!(await this._adbGuestHealthy(adbPath))) {
<<<<<<< HEAD
      this.log('Skipping snapshot save: guest unauthorized or boot incomplete (avoiding an unauthorized poison snapshot)');
=======
      this.log('跳过快照保存：guest 未授权或未开机完成（避免存入未授权的毒快照）');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      return false;
    }
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
<<<<<<< HEAD
   * Only the log lines from "this round of start attempts".
   * The in-memory log accumulates (the report needs every attempt), but the diagnosis must only see this round:
   * otherwise round 1's `emulator exit 3221225477` makes any round-2 failure look like the same crash.
   * When this round has no lines at all (the process never started) fall back to the overall tail for at least a conclusion.
=======
   * 只取「本轮启动尝试」产生的日志行。
   * 内存日志是跨轮累积的（诊断报告要看到全部尝试），但诊断结论必须只看本轮：
   * 否则第 1 轮的 `emulator exit 3221225477` 会让第 2 轮的任何失败都被判成同一个崩溃。
   * 本轮一条日志都没有时（进程压根没起来）退回整体尾部，至少给个结论。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
<<<<<<< HEAD
   * Read the last n lines from the emulator.log file (when the in-memory buffer is empty).
   * After a restart the in-memory this._log is empty, which is why old reports
   * only said UNKNOWN - the real crash reason was in the log file all along.
=======
   * 从 emulator.log 文件尾部读最近 n 行（内存缓冲为空时用）。
   * 用户重启 ApkStart 再导出诊断报告时，内存里的 this._log 已经空了，
   * 旧版报告因此只剩一句 UNKNOWN —— 真实崩溃原因全在日志文件里。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
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
<<<<<<< HEAD
        // Reading from the start can leave a truncated first line - drop it
=======
        // 从头读的话第一行可能被截断，丢掉它
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
