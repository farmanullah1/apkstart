'use strict';
/**
 * Device adaptive / auto-diagnostics (zero-config base)
 *
 * Goal: on different machines users should not need to tweak any parameters.
 *  - chooseProfile()  derives startup parameters from physical RAM, CPU, disk, acceleration state, and emulator version;
 *  - planVariants()   produces a retry plan that degrades step by step after a failed launch (GPU → acceleration → memory → cold boot);
 *  - diagnose()       translates the emulator's English stderr into actionable fix advice;
 *  - shortPath()      handles Chinese/space install paths (emulator's QEMU is extremely sensitive to non-ASCII paths).
 *
 * This module is pure functions + read-only probes: it does not write settings or launch Android, so it is easy to unit-test.
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

/** Local machine profile (millisecond-level, read-only) */
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

/** Available space on the drive holding the directory (MB); returns 0 when it cannot be obtained */
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
 * Detects the GPU vendor (NVIDIA / AMD / Intel), used to adjust render backend priority.
 * Only queries WMI on Windows; other platforms return 'unknown'.
 * Caches the result for 10 minutes to avoid spawning wmic on every chooseProfile().
 */
let _gpuVendorCache = { vendor: 'unknown', at: 0 };
function detectGpuVendor() {
  if (process.platform !== 'win32') return 'unknown';
  if (Date.now() - _gpuVendorCache.at < 600000) return _gpuVendorCache.vendor;
  try {
    const { execFileSync } = require('child_process');
    // wmic was removed in Win11 24H2+; use PowerShell Get-CimInstance instead
    let names = '';
    try {
      names = execFileSync('powershell.exe', [
        '-NoProfile', '-Command',
        '(Get-CimInstance Win32_VideoController).Name -join "|"',
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    } catch (_) {
      // fall back to wmic (older systems still have it)
      try {
        names = execFileSync('wmic', ['path', 'win32_videocontroller', 'get', 'name', '/format:list'],
          { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      } catch (__) { /* ignore */ }
    }
    const lower = String(names).toLowerCase();
    let vendor = 'unknown';
    // prefer discrete GPUs (NVIDIA/AMD); virtual display adapters rank last
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
 * emulator 36.4.9 deprecates swiftshader_indirect and adds -gpu software.
 * On 37.x, passing swiftshader_indirect makes GL init fail or the emulator exit outright (varies a lot by machine).
 * So candidates must be chosen per version, and every candidate needs a fallback.
 *
 * Vendor-specific priority tweaks:
 *   NVIDIA: host is almost always best (mature drivers), swangle as fallback
 *   AMD: host crashes with some drivers (especially old ones), swangle moves up to second
 *   Intel: host is usually fine, but swangle is steadier on weak integrated graphics
 *   unknown: keep the default order
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  const base = modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
  const vendor = detectGpuVendor();
  if (vendor === 'amd' && modern) {
    // Some AMD drivers fail GL init in host mode, so try swangle first
    return ['swangle', 'host', 'software', 'swiftshader'];
  }
  return base;
}

/** Windows 8.3 short path: the emulator cannot find files under a non-ASCII user name / install directory */
/**
 * Screen profile. landscape=true yields a real landscape panel (1280x720).
 *
 * Why the panel size must change instead of calling `wm size` at runtime: the emulator LCD is a
 * "physical panel", and Qt opens its window at that panel size and draws the picture in the
 * top-left corner. Changing `wm size` at runtime only changes Android's logical resolution;
 * the physical panel stays portrait, so the picture ends up rotated 90 degrees, squeezed into
 * a strip in the top-left with wide black borders and misplaced taps. Only switching hw.lcd.width/height to landscape and restarting gives an upright, full-screen landscape picture.
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
  } catch (_) { /* keep the original path when 8.3 names are disabled */ }
  return p;
}

/**
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
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // The old logic was floor(cores/4) clamped to 2-3 - an 8-core machine got 2 vCPUs, and software
    // video decoding (Douyin-style apps) turned into a slideshow. Now: half the physical cores, max 4:
    // 8 cores gives 4, 4 cores gives 2, leaving the desktop headroom while video stays usable.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB is enough for Android 14 and mainstream apps; more only inflates memory use and snapshot size
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // "Save resources" mode: light use (video, reading) never needs 3GB, so cap it at 2GB.
  // qemu then holds ~1GB less RAM and the quickboot snapshot shrinks ~1GB (cheaper disk sync).
  // Only applied when the user has not set memory manually; manual values always win.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // Shrunk when physical free memory is short; Android 14 needs at least 2GB, below that only slow TCG works
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) {
    // The cap follows the host: a hardcoded 8192 meant even 32GB machines got at most 8GB,
    // so large games (especially with HD asset packs) recycled textures constantly - stutter and black screens.
    const lim = memoryLimits(host.totalMB);
    memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, lim.maxMB);
  }

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) {
    // Follows the host too: always leave 1 core for Windows, single-core machines still get 1
    const maxCores = Math.max(1, (host.cores || 1) - 1);
    cores = clamp(Number(overrides.cores) || cores, 1, maxCores);
  }
  // Only lite mode narrows cores when the user did not set them; manual values always win
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // /data capacity: app bodies, game asset packs and their update packages all live here; 4GB fills up fast
  // (showing up as "not enough disk space" during in-app updates). Defaults to 6/8GB by free disk,
  // and users can set it directly in settings (growing it resizes in place on the next boot, keeping data).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  // The automatic value follows free disk too: a 50GB game unpacks to ~90GB, so roomy machines start at 16GB
  // so installing the first big game does not immediately report "out of space".
  const autoDataMB = disk && disk < 12288 ? 4096 : (disk && disk > 262144 ? 16384 : 6144);
  // User values are capped at 80% of the target disk: asking for 128GB on a 20GB disk would fail halfway
  const dataMaxMB = disk ? Math.max(2048, Math.floor((disk * 0.8) / 1024) * 1024) : 262144;
  const dataMB = wantGB > 0
    ? clamp(Math.round(wantGB * 1024), 2048, Math.min(262144, dataMaxMB))
    : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Render resolution: auto picks by acceleration state (software emulation drops to 540x960 for speed)
  // Landscape first: landscape is decided by the "physical panel size", so it must be written to the AVD and
  // needs a restart to apply. Orientation comes from settings.display.landscape, then renderSize is applied.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // If an explicit resolution does not match the orientation, correct it (landscape uses the long edge as width)
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
    // Pure software emulation does work on Windows, but an Android 14 cold boot can take 5-10 minutes
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Turn user settings from the advanced panel into overrides.
 * 0 / auto / unset all mean "no override" and still go through automatic derivation;
 * only an explicit number with automatic memory turned off takes effect.
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
 * Single entry point for display and diagnostics: computes the same parameters a real boot uses, without starting Android.
 * The settings page used to call chooseProfile() without version or accel state, which on 37.x machines
 * wrongly showed the deprecated swiftshader_indirect / software emulation, disagreeing with what actually ran.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = null } = {}) {
  return chooseProfile({
    // host is injectable so tests and diagnostics can imitate a "4-core small machine" without real hardware.
    // When omitted, the real machine is used (the normal runtime path).
    host: host || hostInfo(),
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Failure retry matrix: from "best" to "most conservative", at most 4 attempts.
 * Switch GPU backend -> drop hardware acceleration for TCG -> lower memory and cold-boot to clear the snapshot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'hardware accel' : 'software emulation'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Software emulation without acceleration (slow, but most compatible)',
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
    label: 'Conservative cold boot (minimum memory + cleared snapshot)',
    // This must **never** wipe: it used to be wipe:true, and with a full disk every attempt failed,
    // so consecutive retries cleared the snapshot plus data, taking the user's installed apps and saves with them -
    // that is exactly how "the disk filled up and opening ApkStart lost every app" happened.
    // When userdata must be rebuilt, ensureDataPartition decides itself (only on image corruption),
    // rather than relying on -wipe-data in the launch arguments.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Deduplicate (the same gpu/accel/wipe combination is not retried) - but the last entry must stay:
  // it is the only "no snapshot" option, and on low-memory machines it may match the previous entry exactly.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Find a free port pair (emulator console + adb registration must be adjacent even/odd numbers) */
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
 * adb server port: fixed, never probed for reuse.
 * It used to scan upward from 5044 for a free port, but the adb server is a long-lived process holding that port,
 * so every ApkStart launch added another adb server (six showed up in a single session),
 * and the ever-changing port made it impossible to reattach to the previous emulator.
 * 5044 is ApkStart's dedicated port (a user's own adb uses 5037), so it is used as-is.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
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
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 * System image "identity": keep only the part after `system-images/...`.
 *
 * The image can live on any drive; moving the same image elsewhere should not count as "a different image" -
 * otherwise after moving the runtime from C: to D: (which our own settings advice suggests),
 * the AVD's sysdir no longer matches -> image considered changed -> -wipe-data -> every installed app lost.
 * This really happens in practice, so both places (AVD config, snapshot fingerprint) must use identity, not an absolute path.
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
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'This runtime rejects that GPU mode',
    hint: 'Automatically retried with a GPU mode that fits the runtime version (swiftshader_indirect on older builds, software on newer ones).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Hardware acceleration unavailable',
    hint: 'Automatically fell back to software emulation (the first boot is noticeably slower). For smooth performance enable "Virtual Machine Platform" in Windows Features, or install the AEHD driver and reboot.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: 'Memory allocation failed',
    hint: 'Automatically lowered the memory and cores given to Android. Close memory-hungry programs and retry.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Emulator port already in use',
    hint: 'Automatically switched to a free port. If it keeps happening, quit other emulators (Nox/MuMu/BlueStacks) or reboot.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'A lock file was left over from the previous run',
    hint: 'Automatically cleared the AVD lock file and restarted.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'System image missing or corrupt / incompatible with old user data',
    hint: 'Automatically restarted with clean user data. If it still fails, delete the image under "Runtime" and download it again.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'Runtime components removed by antivirus, or the VC++ runtime is missing',
    hint: 'Add the ApkStart folder to your antivirus allowlist, extract the package again, and install the Microsoft VC++ 2015-2022 runtime.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足/i,
    title: 'Not enough disk space to start Android',
    hint: 'Move the runtime directory (Settings -> System Integration -> Runtime data directory) to a drive with free space,'
      + ' or turn off "Keep quick-boot snapshot" / shrink the data partition in settings. Android data is never cleared automatically.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
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
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU lacks an instruction set the runtime requires',
    hint: 'On some older CPUs this is only a warning and Android still boots. If it really will not start, roll the engine under "Runtime" back to an older compatible build, or use a machine with VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Quick-boot snapshot is corrupt',
    hint: 'The old snapshot was dropped and a cold boot used; a fresh snapshot is written on the next clean exit.',
  },
];

/** Turn a log into {code,title,hint} for the UI and for automatic retry decisions */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
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
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
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
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
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
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* fall back to the registry */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* a missing key means not installed */ }
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
