'use strict';
/**
<<<<<<< HEAD
 * Device adaptive / auto-diagnostics (zero-config base)
 *
 * Goal: on different machines users should not need to tweak any parameters.
 *  - chooseProfile()  derives startup parameters from physical RAM, CPU, disk, acceleration state, and emulator version;
 *  - planVariants()   produces a retry plan that degrades step by step after a failed launch (GPU → acceleration → memory → cold boot);
 *  - diagnose()       translates the emulator's English stderr into actionable fix advice;
 *  - shortPath()      handles Chinese/space install paths (emulator's QEMU is extremely sensitive to non-ASCII paths).
 *
 * This module is pure functions + read-only probes: it does not write settings or launch Android, so it is easy to unit-test.
=======
 * 设备自适应 / 自动诊断（零配置底座）
 *
 * 目标：不同机器上都不需要用户调任何参数。
 *  - chooseProfile()  根据物理内存、CPU、磁盘、加速状态、emulator 版本推导启动参数；
 *  - planVariants()   给出「启动失败后依次降级」的重试方案（GPU → 加速 → 内存 → 冷启动）；
 *  - diagnose()       把 emulator 的英文 stderr 翻译成可执行的修复建议；
 *  - shortPath()      处理中文/空格安装路径（emulator 的 QEMU 对非 ASCII 路径极其敏感）。
 *
 * 本模块是纯函数 + 只读探测，不写设置、不拉起 Android，方便单测。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { memoryLimits } = require('./resources');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

<<<<<<< HEAD
/** Local machine profile (millisecond-level, read-only) */
=======
/** 本机画像（毫秒级，只读） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

<<<<<<< HEAD
/** Available space on the drive holding the directory (MB); returns 0 when it cannot be obtained */
=======
/** 目录所在盘可用空间（MB）；取不到返回 0 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
<<<<<<< HEAD
 * Detects the GPU vendor (NVIDIA / AMD / Intel), used to adjust render backend priority.
 * Only queries WMI on Windows; other platforms return 'unknown'.
 * Caches the result for 10 minutes to avoid spawning wmic on every chooseProfile().
=======
 * 检测 GPU 厂商（NVIDIA / AMD / Intel），用于调整渲染后端优先级。
 * 只在 Windows 上查 WMI；其他平台返回 'unknown'。
 * 结果缓存 10 分钟，避免每次 chooseProfile 都 spawn wmic。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
<<<<<<< HEAD
    // wmic was removed in Win11 24H2+; use PowerShell Get-CimInstance instead
=======
    // wmic 在 Win11 24H2+ 已被移除，改用 PowerShell Get-CimInstance
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
<<<<<<< HEAD
      // fall back to wmic (older systems still have it)
=======
      // 回退到 wmic（老系统仍可用）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
<<<<<<< HEAD
    // prefer discrete GPUs (NVIDIA/AMD); virtual display adapters rank last
=======
    // 优先匹配独显（NVIDIA/AMD），虚拟显示适配器排在后面
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (/nvidia|geforce|rtx\s|gtx\s/.test(lower)) vendor = 'nvidia';
    else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/.test(lower)) vendor = 'amd';
    else if (/intel|uhd\s|iris|arc\s/.test(lower)) vendor = 'intel';
    _gpuVendorCache = { vendor, at: Date.now() };
    return vendor;
  } catch (_) {
    _gpuVendorCache = { vendor: 'unknown', at: Date.now() };
    return 'unknown';
  }
}

/**
<<<<<<< HEAD
 * emulator 36.4.9 deprecates swiftshader_indirect and adds -gpu software.
 * On 37.x, passing swiftshader_indirect makes GL init fail or the emulator exit outright (varies a lot by machine).
 * So candidates must be chosen per version, and every candidate needs a fallback.
 *
 * Vendor-specific priority tweaks:
 *   NVIDIA: host is almost always best (mature drivers), swangle as fallback
 *   AMD: host crashes with some drivers (especially old ones), swangle moves up to second
 *   Intel: host is usually fine, but swangle is steadier on weak integrated graphics
 *   unknown: keep the default order
=======
 * emulator 36.4.9 起把 swiftshader_indirect 标记为弃用，新增 -gpu software。
 * 37.x 上传 swiftshader_indirect 会出现 GL 初始化失败/直接退出（设备差异很大）。
 * 因此必须按版本挑候选，且每个候选都有退路。
 *
 * 按 GPU 厂商微调优先级：
 *   NVIDIA：host 几乎总是最优（驱动成熟），swangle 兜底
 *   AMD：host 在部分驱动下会崩（尤其老驱动），swangle 提到第二优先
 *   Intel：host 通常 OK，但集显性能弱时 swangle 更稳
 *   unknown：保持默认顺序
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
<<<<<<< HEAD
    // Some AMD drivers fail GL init in host mode, so try swangle first
=======
    // AMD 驱动在某些版本下 host 模式会 GL 初始化失败，把 swangle 提到前面
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

<<<<<<< HEAD
/** Windows 8.3 short path: the emulator cannot find files under a non-ASCII user name / install directory */
/**
 * Screen profile. landscape=true yields a real landscape panel (1280x720).
 *
 * Why the panel size must change instead of calling `wm size` at runtime: the emulator LCD is a
 * "physical panel", and Qt opens its window at that panel size and draws the picture in the
 * top-left corner. Changing `wm size` at runtime only changes Android's logical resolution;
 * the physical panel stays portrait, so the picture ends up rotated 90 degrees, squeezed into
 * a strip in the top-left with wide black borders and misplaced taps. Only switching hw.lcd.width/height to landscape and restarting gives an upright, full-screen landscape picture.
=======
/** Windows 8.3 短路径：中文用户名 / 中文安装目录时 emulator 会找不到文件 */
/**
 * 屏幕规格。landscape=true 时给出真正的横屏面板（1280x720）。
 *
 * 为什么必须改面板尺寸而不是运行时 wm size：模拟器的 LCD 是「物理面板」，
 * Qt 按面板尺寸开窗口并把画面贴在左上角。运行时改 wm size 只会改 Android 的
 * 逻辑分辨率，物理面板仍是竖的 —— 结果就是画面躺倒 90°、只占左上角一条、
 * 四周大片黑边、点击坐标错位。只有把 hw.lcd.width/height 真的换成横屏并重启，
 * 才能得到「正立 + 铺满」的横屏。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
<<<<<<< HEAD
  } catch (_) { /* keep the original path when 8.3 names are disabled */ }
=======
  } catch (_) { /* 8.3 被关闭时保持原路径 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  return p;
}

/**
<<<<<<< HEAD
 * Derive zero-config startup parameters.
 * If the user explicitly set engine.memoryMB / cores / gpuMode they act as caps/overrides,
 * but an unset value no longer hardcodes 4GB / 4 cores and crushes low-memory machines.
 */
/**
 * "Light container" quota: constrains only what hurts host responsiveness most - the vCPU count.
 *
 * The old logic gave a 16-core machine 4 cores, so qemu's 4 vCPU threads kept physical cores busy
 * and the Windows desktop, mouse and browser fought over the remaining timeslices - laggy from the start.
 * A single Android app is fine on 2 vCPUs; extra cores only slow the host down.
 *
 * Memory and resolution are deliberately left alone: the memory cap is already 2-3GB, and lowering
 * resolution would change the quickboot snapshot fingerprint and force a cold boot on every mode switch.
 *
 * Pure function; returns null when settings is null (keeps old callers and unit tests unchanged).
=======
 * 推导零配置启动参数。
 * 用户设置里若显式给了 engine.memoryMB / cores / gpuMode，则作为上限/覆盖，
 * 但不会再因为「没设置」而用 4G/4核 硬编码把小内存机器搞崩。
 */
/**
 * 「轻量容器」配额：只约束最影响主机手感的那一项 —— vCPU 数。
 *
 * 旧逻辑给 16 核机器分 4 核，qemu 的 4 个 vCPU 线程会长期占满物理核，
 * Windows 桌面、鼠标、浏览器只能抢剩下的时间片，表现就是「一打开就卡」。
 * 实际跑一个 Android App 2 个 vCPU 已经绰绰有余，多给只是拖慢主机。
 *
 * 内存、分辨率刻意不动：内存上限本来就是 2~3G，降分辨率还会让 quickboot
 * 快照指纹变化、每次切模式都要重新冷启动，得不偿失。
 *
 * 纯函数，settings 为 null 时返回 null（保持旧调用方/单测的行为不变）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
<<<<<<< HEAD
    // The old logic was floor(cores/4) clamped to 2-3 - an 8-core machine got 2 vCPUs, and software
    // video decoding (Douyin-style apps) turned into a slideshow. Now: half the physical cores, max 4:
    // 8 cores gives 4, 4 cores gives 2, leaving the desktop headroom while video stays usable.
=======
    // 老逻辑是 floor(核数/4) 再夹到 2~3 —— 8 核机器只给 2 个 vCPU，软件解码视频
    // （红果/抖音这类）直接卡成幻灯片。改成「一半物理核、上限 4」：
    // 8 核给 4、4 核给 2，桌面仍有富余核，视频也够用。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
<<<<<<< HEAD
  // 3GB is enough for Android 14 and mainstream apps; more only inflates memory use and snapshot size
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // "Save resources" mode: light use (video, reading) never needs 3GB, so cap it at 2GB.
  // qemu then holds ~1GB less RAM and the quickboot snapshot shrinks ~1GB (cheaper disk sync).
  // Only applied when the user has not set memory manually; manual values always win.
=======
  // 3GB 足够 Android 14 与主流应用；再高只会放大内存占用和 quickboot 快照体积
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // 「省资源」模式：刷视频/看小说这类轻负载用不到 3G，把上限压到 2G。
  // 直接效果是 qemu 常驻内存少约 1GB、quickboot 快照也小 1GB（磁盘同步受益）。
  // 只有用户没手动指定内存时才收敛，手动值永远优先。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
<<<<<<< HEAD
  // Shrunk when physical free memory is short; Android 14 needs at least 2GB, below that only slow TCG works
=======
  // 物理可用内存不够时下调；Android 14 最低 2G，低于此只能靠 TCG 慢速跑
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
<<<<<<< HEAD
    // The cap follows the host: a hardcoded 8192 meant even 32GB machines got at most 8GB,
    // so large games (especially with HD asset packs) recycled textures constantly - stutter and black screens.
=======
    // 上限跟着宿主走：早先写死 8192，结果 32GB 机器上也最多只能分 8GB，
    // 大型游戏（尤其带高清资源包的）进场景就频繁回收贴图，表现是卡顿/黑屏。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
<<<<<<< HEAD
    // Follows the host too: always leave 1 core for Windows, single-core machines still get 1
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // Only lite mode narrows cores when the user did not set them; manual values always win
=======
    // 同样跟着宿主：至少留 1 核给 Windows，单核机器仍然给 1 核
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // 用户没手动指定核数时才由轻量模式收敛，手动值永远优先
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
<<<<<<< HEAD
  // /data capacity: app bodies, game asset packs and their update packages all live here; 4GB fills up fast
  // (showing up as "not enough disk space" during in-app updates). Defaults to 6/8GB by free disk,
  // and users can set it directly in settings (growing it resizes in place on the next boot, keeping data).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // The automatic value follows free disk too: a 50GB game unpacks to ~90GB, so roomy machines start at 16GB
  // so installing the first big game does not immediately report "out of space".
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // User values are capped at 80% of the target disk: asking for 128GB on a 20GB disk would fail halfway
=======
  // /data 容量：应用本体、游戏资源包和它们的「更新包」都占这里，4GB 太容易满
  // （表现就是应用内更新时提示「磁盘空间不足」）。默认按磁盘余量给 6/8GB，
  // 用户也可以直接在设置里指定（改大后下次开机就地扩容，不丢数据）。
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // 自动值也跟磁盘余量走：50GB 级游戏解包后接近 90GB，余量大的机器给 16GB 起步，
  // 免得装完第一个大游戏就开始报「空间不足」。
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // 用户指定时按「所在磁盘的 80%」封顶：填 128GB 但盘里只有 20GB，只会装到一半失败
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

<<<<<<< HEAD
  // Render resolution: auto picks by acceleration state (software emulation drops to 540x960 for speed)
  // Landscape first: landscape is decided by the "physical panel size", so it must be written to the AVD and
  // needs a restart to apply. Orientation comes from settings.display.landscape, then renderSize is applied.
=======
  // 渲染分辨率：auto 时按加速状态选（软件模拟降到 540x960 保流畅）
  // 横屏优先：横屏是由「物理面板尺寸」决定的，必须写进 AVD 并重启才生效，
  // 所以这里先按 settings.display.landscape 定方向，再叠加 renderSize。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
<<<<<<< HEAD
      // If an explicit resolution does not match the orientation, correct it (landscape uses the long edge as width)
=======
      // 用户显式分辨率若与当前方向不一致，按方向校正（横屏取长边作宽）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
<<<<<<< HEAD
    // Pure software emulation does work on Windows, but an Android 14 cold boot can take 5-10 minutes
=======
    // 无加速的纯软件模拟在 Windows 上确实能起来，但 Android 14 冷启动可能 5-10 分钟
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
<<<<<<< HEAD
 * Turn user settings from the advanced panel into overrides.
 * 0 / auto / unset all mean "no override" and still go through automatic derivation;
 * only an explicit number with automatic memory turned off takes effect.
=======
 * 把「高级参数」里的用户设置转成 overrides。
 * 0 / auto / 未设置一律视为「不覆盖」，仍然走自动推导；
 * 只有用户主动关掉自动内存并填了具体数值才生效。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
<<<<<<< HEAD
 * Single entry point for display and diagnostics: computes the same parameters a real boot uses, without starting Android.
 * The settings page used to call chooseProfile() without version or accel state, which on 37.x machines
 * wrongly showed the deprecated swiftshader_indirect / software emulation, disagreeing with what actually ran.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host is injectable so tests and diagnostics can imitate a "4-core small machine" without real hardware.
    // When omitted, the real machine is used (the normal runtime path).
=======
 * 展示 / 诊断用的统一入口：不启动 Android 也能算出与真实开机一致的参数。
 * 之前设置页直接调 chooseProfile()（不带版本和加速状态），会在 37.x 机器上
 * 错误地显示已弃用的 swiftshader_indirect / 软件模拟，和实跑参数对不上。
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host 可注入：单测/诊断想复现「4 核小机器」时不用真的换机器。
    // 不传就按本机实际情况算（正常运行时都是这条路径）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
<<<<<<< HEAD
 * Failure retry matrix: from "best" to "most conservative", at most 4 attempts.
 * Switch GPU backend -> drop hardware acceleration for TCG -> lower memory and cold-boot to clear the snapshot.
=======
 * 失败重试矩阵：从「最优」到「最保守」，最多 4 次。
 * 依次换 GPU 后端 → 关硬件加速走 TCG → 降内存并强制冷启动清快照。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
<<<<<<< HEAD
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'hardware accel' : 'software emulation'}`, wipe: false, snapshot: true });
=======
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? '硬件加速' : '软件模拟'}`, wipe: false, snapshot: true });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
<<<<<<< HEAD
    label: 'Software emulation without acceleration (slow, but most compatible)',
=======
    label: '关闭加速的软件模拟（慢，但兼容性最好）',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
<<<<<<< HEAD
    label: 'Conservative cold boot (minimum memory + cleared snapshot)',
    // This must **never** wipe: it used to be wipe:true, and with a full disk every attempt failed,
    // so consecutive retries cleared the snapshot plus data, taking the user's installed apps and saves with them -
    // that is exactly how "the disk filled up and opening ApkStart lost every app" happened.
    // When userdata must be rebuilt, ensureDataPartition decides itself (only on image corruption),
    // rather than relying on -wipe-data in the launch arguments.
=======
    label: '保守冷启动（最小内存 + 清快照）',
    // 这里**绝对不能** wipe：以前写的是 wipe:true，而磁盘写满时每次尝试都会失败，
    // 于是连续重试把用户已装的应用和存档一起「清快照 + 清数据」了 ——
    // 「磁盘满了，结果打开 ApkStart 应用全没了」就是这么发生的。
    // 需要重建 userdata 时由 ensureDataPartition 自己判断（它只在镜像损坏时重建），
    // 不靠启动参数里的 -wipe-data。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
<<<<<<< HEAD
  // Deduplicate (the same gpu/accel/wipe combination is not retried) - but the last entry must stay:
  // it is the only "no snapshot" option, and on low-memory machines it may match the previous entry exactly.
=======
  // 去重（相同 gpu/accel/wipe 组合不重复试）——但「最后一档」必须保留：
  // 它是唯一「不加载快照」的方案，小内存机器上可能和前一档参数完全一样。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

<<<<<<< HEAD
/** Find a free port pair (emulator console + adb registration must be adjacent even/odd numbers) */
=======
/** 检测一对空闲端口（emulator console + adb 注册端口必须相邻偶数/奇数） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
<<<<<<< HEAD
 * adb server port: fixed, never probed for reuse.
 * It used to scan upward from 5044 for a free port, but the adb server is a long-lived process holding that port,
 * so every ApkStart launch added another adb server (six showed up in a single session),
 * and the ever-changing port made it impossible to reattach to the previous emulator.
 * 5044 is ApkStart's dedicated port (a user's own adb uses 5037), so it is used as-is.
=======
 * adb server 端口：固定不复用探测。
 * 之前是"从 5044 往上找一个空闲端口"，但 adb server 本身是常驻进程，占着这个端口，
 * 于是每启动一次 ApkStart 就会多一个 adb server（实测一次会话跑出 6 个），
 * 而且端口老是变，下次启动想接管上次的模拟器时对不上号。
 * 5044 是 ApkStart 专用端口（用户自己的 adb 在 5037），直接固定用。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
<<<<<<< HEAD
 * Config fingerprint: the snapshot is dropped only when the image / data partition / engine version changes.
 * GPU, acceleration mode and memory are deliberately excluded - auto-retry changes them constantly,
 * and including them would make every retry trigger -wipe-data and wipe the user's apps.
 */
/**
 * Quickboot snapshot "config fingerprint": only these changes invalidate an old snapshot (black screen / no boot).
 *
 * **dataMB is deliberately excluded**: an enlarged data partition still works with the old snapshot (qemu remounts
 * at the new size). Including it meant "the user only wanted more space and got the snapshot dropped + a cold boot +
 * data deleted" - hit once in testing, at the cost of every app on the machine.
=======
 * 配置指纹：只有「镜像 / 数据分区 / 引擎版本」变化才作废快照。
 * 故意不包含 GPU、加速方式、内存 —— 那些是自动重试会频繁切换的参数，
 * 若纳入会让每次重试都触发 -wipe-data，把用户已装的应用清空。
 */
/**
 * quickboot 快照的「配置指纹」：只有这些变化会让旧快照失效（加载后黑屏/起不来）。
 *
 * 刻意**不包含 dataMB**：数据分区调大以后旧快照照样能用（qemu 会按新的分区大小
 * 重新挂载），把它算进指纹的后果是「用户只想扩个容，结果快照作废 + 冷启动 +
 * 数据被删」—— 实测踩过一次，代价是整机应用全丢。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
<<<<<<< HEAD
 * System image "identity": keep only the part after `system-images/...`.
 *
 * The image can live on any drive; moving the same image elsewhere should not count as "a different image" -
 * otherwise after moving the runtime from C: to D: (which our own settings advice suggests),
 * the AVD's sysdir no longer matches -> image considered changed -> -wipe-data -> every installed app lost.
 * This really happens in practice, so both places (AVD config, snapshot fingerprint) must use identity, not an absolute path.
=======
 * 系统镜像的「身份」：只保留 `system-images/...` 之后的部分。
 *
 * 镜像放哪个盘都无所谓，同一套镜像换个目录不该被当成「换了镜像」——
 * 否则用户把运行时从 C 盘挪到 D 盘（我们自己在设置里就建议这么做）以后，
 * AVD 里的 sysdir 与新路径不一致 → 判定镜像变了 → -wipe-data → 已装应用全丢。
 * 这个坑在实测中真的会踩到，所以两个地方（AVD 配置、快照指纹）都必须用身份而不是绝对路径。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

const RULES = [
  {
    code: 'ACCESS_VIOLATION',
<<<<<<< HEAD
    // On Windows emulator/qemu exits with 0xC0000005 (3221225477 in decimal):
    // seen mostly when the graphics driver / Vulkan backend dies just as the guest starts,
    // unrelated to CPU, memory or image (switching to -gpu software usually gets past it).
    // Must come before GPU_INIT: crash logs also mention render init, so matching the crash first is more accurate.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Render backend crashed (0xC0000005 access violation)',
    hint: 'Automatically retried with a more conservative render backend, and it will not be tried first again.'
      + ' If it keeps happening, update the graphics driver, or lower the quality in Settings -> Performance & Resources and turn off Remote Desktop / VM GPU passthrough, then retry.',
  },
  {
    code: 'GPU_INIT',
    // Match failure context only: normal logs also mention Vulkan/EGL/ANGLE, so do not treat those as fatal
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'GPU render backend failed to initialize',
    hint: 'Automatically retried with software rendering. If it still fails, update the graphics driver, or turn off Remote Desktop / VM GPU passthrough and retry.',
=======
    // Windows 上 emulator/qemu 以 0xC0000005（十进制 3221225477）退出：
    // 实测多见于「显卡驱动 / Vulkan 后端在 guest 刚要启动时崩掉」，
    // 与 CPU、内存、镜像都无关（同机换 -gpu software 往往就能过）。
    // 必须排在 GPU_INIT 前面：崩溃日志里通常也带着渲染初始化信息，先判崩溃更准。
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: '渲染后端崩溃（0xC0000005 访问冲突）',
    hint: '已自动改用更保守的渲染后端重试，并记住这个后端下次不再先试。'
      + '若反复出现，请更新显卡驱动；或在设置 → 性能与资源里把画质调低、关闭远程桌面/虚拟机显卡直通后再试。',
  },
  {
    code: 'GPU_INIT',
    // 只匹配「失败」语境：正常日志里也会出现 Vulkan/EGL/ANGLE 字样，不能误判为致命错误
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: '显卡渲染后端初始化失败',
    hint: '已自动切换软件渲染重试。若仍失败，请更新显卡驱动，或关闭远程桌面/虚拟机显卡直通后再试。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
<<<<<<< HEAD
    title: 'This runtime rejects that GPU mode',
    hint: 'Automatically retried with a GPU mode that fits the runtime version (swiftshader_indirect on older builds, software on newer ones).',
=======
    title: '当前运行时不接受该 GPU 模式',
    hint: '已自动按运行时版本挑选可用的 GPU 模式重试（老版本用 swiftshader_indirect，新版本用 software）。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
<<<<<<< HEAD
    title: 'Hardware acceleration unavailable',
    hint: 'Automatically fell back to software emulation (the first boot is noticeably slower). For smooth performance enable "Virtual Machine Platform" in Windows Features, or install the AEHD driver and reboot.',
=======
    title: '硬件加速不可用',
    hint: '已自动回退软件模拟（首次启动会明显变慢）。想要流畅可用，请在「Windows 功能」勾选「虚拟机平台」，或安装 AEHD 驱动后重启。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
<<<<<<< HEAD
    title: 'Memory allocation failed',
    hint: 'Automatically lowered the memory and cores given to Android. Close memory-hungry programs and retry.',
=======
    title: '内存分配失败',
    hint: '已自动下调分配给 Android 的内存与核心数。请关闭占内存的程序后重试。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
<<<<<<< HEAD
    title: 'Emulator port already in use',
    hint: 'Automatically switched to a free port. If it keeps happening, quit other emulators (Nox/MuMu/BlueStacks) or reboot.',
=======
    title: '模拟器端口被占用',
    hint: '已自动换用空闲端口。若反复出现，请退出夜神/MuMu/蓝叠等模拟器，或重启电脑。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
<<<<<<< HEAD
    title: 'A lock file was left over from the previous run',
    hint: 'Automatically cleared the AVD lock file and restarted.',
=======
    title: '上次运行残留了锁文件',
    hint: '已自动清理 AVD 锁文件并重新拉起。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
<<<<<<< HEAD
    title: 'System image missing or corrupt / incompatible with old user data',
    hint: 'Automatically restarted with clean user data. If it still fails, delete the image under "Runtime" and download it again.',
=======
    title: '系统镜像缺失或损坏 / 与旧用户数据不兼容',
    hint: '已自动用干净的用户数据重新开机。若仍失败，请在「运行时」里删除镜像后重新下载。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
<<<<<<< HEAD
    title: 'Runtime components removed by antivirus, or the VC++ runtime is missing',
    hint: 'Add the ApkStart folder to your antivirus allowlist, extract the package again, and install the Microsoft VC++ 2015-2022 runtime.',
=======
    title: '运行时组件被杀毒软件删除或缺少 VC++ 运行库',
    hint: '请把 ApkStart 目录加入杀毒软件白名单后重新解压安装包，并安装微软 VC++ 2015-2022 运行库。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
<<<<<<< HEAD
    title: 'Not enough disk space to start Android',
    hint: 'Move the runtime directory (Settings -> System Integration -> Runtime data directory) to a drive with free space,'
      + ' or turn off "Keep quick-boot snapshot" / shrink the data partition in settings. Android data is never cleared automatically.',
=======
    title: '磁盘空间不足，无法启动安卓',
    hint: '请把运行时目录（设置 → 系统集成 → 运行时数据目录）改到空间充足的盘，'
      + '或在设置里关掉「保留快速启动快照」/ 调小数据分区。安卓数据不会被自动清除。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
<<<<<<< HEAD
    title: 'Install path contains non-ASCII or special characters',
    hint: 'Automatically switched to the Windows short path. If it still fails, move ApkStart to a pure-ASCII directory (e.g. C:\\ApkStart).',
  },
  {
    // After a forced exit the AVD directory keeps hardware-qemu.ini.lock / multiinstance.lock,
    // and the emulator refuses to start while reporting something easily mistaken for a CPU problem. Must precede the CPU rule.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'The previous run did not exit cleanly and left lock files behind',
    hint: 'ApkStart clears the leftover locks and retries; if it keeps happening, check whether another emulator is using the same runtime.',
=======
    title: '安装路径含中文或特殊字符',
    hint: '已自动改用 Windows 短路径。若仍失败，请把 ApkStart 移到纯英文目录（如 C:\\ApkStart）。',
  },
  {
    // 上次被强制结束后 AVD 目录会留下 hardware-qemu.ini.lock / multiinstance.lock，
    // 模拟器一律拒绝启动，报出来的却是容易被误读成 CPU 问题的话。必须排在 CPU 规则前。
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: '上一次运行没有正常退出，残留了锁文件',
    hint: 'ApkStart 会自动清掉残留锁并重试；若反复出现，请检查是否有别的模拟器正在用同一套运行时。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
<<<<<<< HEAD
    title: 'CPU lacks an instruction set the runtime requires',
    hint: 'On some older CPUs this is only a warning and Android still boots. If it really will not start, roll the engine under "Runtime" back to an older compatible build, or use a machine with VT-x/AVX.',
=======
    title: 'CPU 缺少运行时要求的指令集',
    hint: '这类提示在部分老 CPU 上只是警告、仍能开机；若确实起不来，请把「运行时」里的引擎更新到较旧兼容版本，或换一台支持 VT-x/AVX 的电脑。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
<<<<<<< HEAD
    title: 'Quick-boot snapshot is corrupt',
    hint: 'The old snapshot was dropped and a cold boot used; a fresh snapshot is written on the next clean exit.',
  },
];

/** Turn a log into {code,title,hint} for the UI and for automatic retry decisions */
=======
    title: '快速启动快照损坏',
    hint: '已自动丢弃旧快照走冷启动；下一次正常退出会重新生成快照。',
  },
];

/** 把日志翻译成 {code,title,hint}，供 UI 展示与自动重试决策 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
<<<<<<< HEAD
    title: 'The runtime failed to finish booting',
    hint: 'Automatically retried with several parameter combinations. Use "Export diagnostic report" to send the log for diagnosis.',
  };
}

/** Human-readable one-line summary so advanced users can see what was chosen automatically */
function describeProfile(p) {
  return `Auto: ${(p.memoryMB / 1024).toFixed(1)}GB RAM \u00b7 ${p.cores} cores \u00b7 ${p.gpu} renderer \u00b7 `
    + `${p.accelOk ? 'hardware accel' : 'software emulation'} \u00b7 ${p.snapshot ? 'snapshot on demand' : 'cold boot'}`
    + `${p.lite ? ' \u00b7 light container' : ''} \u00b7 port ${p.port}`;
}

/** Export a diagnostic report (plain text, easy to mail or paste into an issue) */
=======
    title: '运行时未能完成开机',
    hint: '已自动按多种参数组合重试。可点「导出诊断报告」把日志发给作者定位。',
  };
}

/** 人类可读的一行摘要，放在设置页让高级用户知道自动选了什么 */
function describeProfile(p) {
  return `自动：${(p.memoryMB / 1024).toFixed(1)}GB 内存 · ${p.cores} 核 · ${p.gpu} 渲染 · `
    + `${p.accelOk ? '硬件加速' : '软件模拟'} · ${p.snapshot ? '按需快照' : '冷启动'}`
    + `${p.lite ? ' · 轻量容器' : ''} · 端口 ${p.port}`;
}

/** 导出诊断报告（纯文本，便于发邮件/贴 issue） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
<<<<<<< HEAD
    'ApkStart diagnostic report',
    `Generated: ${new Date().toLocaleString()}`,
    '',
    '== Host machine ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Automatic configuration ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Diagnostics ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== Additional information ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Runtime log (last 300 lines) ==',
=======
    'ApkStart 诊断报告',
    `生成时间：${new Date().toLocaleString()}`,
    '',
    '== 本机 ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== 自动配置 ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== 诊断 ==',
    `${d.code}：${d.title}`,
    d.hint,
    '',
    '== 附加信息 ==',
    JSON.stringify(extra, null, 2),
    '',
    '== 运行时日志（末尾 300 行）==',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
<<<<<<< HEAD
 * Check whether the Microsoft VC++ 2015-2022 x64 runtime is installed.
 * The Android emulator (Qt6) and qemu both need it; without it the app will not start on other machines
 * (failing with 0xc0000135 / missing MSVCP140). The installer bundles vc_redist.x64.exe,
 * so this only detects the situation to show a clear prompt and a one-click install entry point.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Check the DLLs first: msvcp140 / vcruntime140 are exactly what Qt6 and qemu load.
  // File checks avoid spawning reg.exe (some security software blocks it, and the 60s self-check slows down),
  // and avoid false "not installed" reports when a cleanup tool removed the registry keys.
=======
 * 检测微软 VC++ 2015-2022 x64 运行库是否安装。
 * 安卓模拟器（Qt6）与 qemu 都依赖它；缺了在「其他电脑」上会直接起不来
 * （报 0xc0000135 / MSVCP140 缺失）。安装版我们已内置 vc_redist.x64.exe，
 * 这里只做检测，供启动前给出明确提示与一键安装入口。
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // 先看 DLL：msvcp140 / vcruntime140 正是 Qt6 与 qemu 真正依赖的两个文件。
  // 用文件判断既不用起 reg.exe（部分安全软件会拦、也会拖慢每 60s 的自检），
  // 也不会因为注册表项被清理工具删掉而误报「没装」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
<<<<<<< HEAD
  } catch (_) { /* fall back to the registry */ }
=======
  } catch (_) { /* 走注册表兜底 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
<<<<<<< HEAD
    } catch (_) { /* a missing key means not installed */ }
=======
    } catch (_) { /* 键不存在 = 没装 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, detectGpuVendor, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
