'use strict';
/**
 * Resource allocation (memory / CPU / storage) pure logic.
 *
 * Why a dedicated layer: "how much memory to allocate to Android" ends up in qemu command line (-memory / -cores),
 * taking effect on next boot; but logic deciding valid bounds and consequence of exceeding them is a pure function,
 * extracted without electron dependencies so CI can directly unit-test it.
 *
 * Three hard constraints (from real-world testing):
 *   1. Memory cannot consume all host RAM: Windows + foreground apps need at least 25%, otherwise machine pages,
 *      causing prolonged black screens and frozen animations on Android.
 *   2. Storage must be estimated as "package * 1.8 + 2GB": 50GB online games extract to 80-90GB;
 *      approving based only on package size leads to installation failing halfway.
 *   3. All automatic values must be calculable: fall back to conservative defaults if host info unavailable, never NaN.
 */

const DEFAULT_STEP_MB = 512;
const MIN_MEM_MB = 1024;
/** Ratio reserved for host (Windows + foreground apps) */
const HOST_RESERVE_RATIO = 0.25;
/** Ratio below which a "tight" warning is triggered */
const TIGHT_RATIO = 0.8;
/** Absolute minimum to run system */
const ABSOLUTE_MIN_MB = 768;

function toInt(v, fallback = 0) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Host capabilities. Parameters injectable for testing; otherwise reads current machine.
 * @returns {{ totalMB:number, cores:number }}
 */
function hostProfile(sys) {
  let totalMB = 0;
  let cores = 0;
  const src = sys || {};
  if (Number(src.totalMB) > 0) {
    totalMB = toInt(src.totalMB);
  } else if (Number(src.totalmem) > 0) {
    totalMB = Math.round(Number(src.totalmem) / 1048576);
  } else {
    try {
      // Lazy require('os') inside function to avoid touching host environment during module load
      const os = require('os');
      totalMB = Math.round(os.totalmem() / 1048576);
      cores = os.cpus() ? os.cpus().length : 0;
    } catch (_) { totalMB = 0; }
  }
  if (Number(src.cores) > 0) cores = toInt(src.cores);
  return { totalMB, cores: Math.max(1, cores || 1) };
}

/**
 * Valid memory allocation range. Conservative fallback when host RAM is unreadable to avoid 0 in UI.
 * @returns {{ minMB:number, maxMB:number, stepMB:number, totalMB:number }}
 */
function memoryLimits(totalMB) {
  const total = toInt(totalMB);
  if (total <= 0) return { minMB: MIN_MEM_MB, maxMB: 8192, stepMB: DEFAULT_STEP_MB, totalMB: 0 };
  const usable = Math.floor((total * (1 - HOST_RESERVE_RATIO)) / DEFAULT_STEP_MB) * DEFAULT_STEP_MB;
  const maxMB = Math.max(MIN_MEM_MB, Math.min(usable, 65536));
  return { minMB: MIN_MEM_MB, maxMB, stepMB: DEFAULT_STEP_MB, totalMB: total };
}

/**
 * Clamp user-entered memory to valid range. 0 = auto, returns 0 as-is (derived by backend).
 * @returns {{ mb:number, capped:boolean, reason:string }}
 */
function clampMemoryMB(mb, totalMB) {
  const want = toInt(mb);
  if (want <= 0) return { mb: 0, capped: false, reason: 'auto' };
  const lim = memoryLimits(totalMB);
  const rounded = Math.round(want / lim.stepMB) * lim.stepMB;
  if (rounded > lim.maxMB) {
    return {
      mb: lim.maxMB,
      capped: true,
      reason: `Host RAM ${Math.round(lim.totalMB / 1024)} GB, can allocate at most ${Math.round(lim.maxMB / 1024)} GB (最多只能分 ${Math.round(lim.maxMB / 1024)} GB, leaving 25% for Windows)`,
    };
  }
  if (rounded < lim.minMB) return { mb: lim.minMB, capped: true, reason: `Android requires at least ${lim.minMB} MB to boot` };
  return { mb: rounded, capped: rounded !== want, reason: rounded !== want ? 'Aligned to 512 MB step' : '' };
}

/**
 * Clamp CPU cores. 0 = auto.
 * Upper bound is "physical cores - 1", leaving at least 1 core for host; single-core machines get 1 core.
 */
function clampCores(n, hostCores) {
  const want = toInt(n);
  const total = Math.max(1, toInt(hostCores) || 1);
  const max = total > 1 ? total - 1 : 1;
  if (want <= 0) return { cores: 0, capped: false, reason: 'auto' };
  if (want > max) {
    return { cores: max, capped: true, reason: `Host has ${total} cores, can allocate at most ${max} cores (leaving 1 core for Windows)` };
  }
  return { cores: Math.max(1, want), capped: false, reason: '' };
}

/**
 * Evaluate if memory allocation is reasonable (for UI tips and warnings before large installs).
 * @returns {{ level:'ok'|'tight'|'insufficient'|'unknown', ratio:number, note:string }}
 */
function memVerdict(allocMB, hostMB) {
  const alloc = toInt(allocMB);
  const host = toInt(hostMB);
  if (!alloc || !host) return { level: 'unknown', ratio: 0, note: '' };
  if (alloc < ABSOLUTE_MIN_MB) {
    return { level: 'insufficient', ratio: alloc / host, note: `Allocated only ${alloc} MB; Android may not boot` };
  }
  const ratio = alloc / host;
  if (ratio > 1 - HOST_RESERVE_RATIO) {
    return {
      level: 'insufficient',
      ratio,
      note: `Uses ${Math.round(ratio * 100)}% host memory; Windows will start paging (换页), making emulator sluggish`,
    };
  }
  if (ratio > TIGHT_RATIO * (1 - HOST_RESERVE_RATIO)) {
    return { level: 'tight', ratio, note: `Using ${Math.round(ratio * 100)}% host memory; closing browser tabs is recommended` };
  }
  return { level: 'ok', ratio, note: '' };
}

/** Actual data partition space required to install a package (including extraction and update redundancy) */
function diskRequiredMB(packageBytes, ratio = 1.8, reserveMB = 2048) {
  const bytes = Math.max(0, Number(packageBytes) || 0);
  if (!bytes) return reserveMB;
  return Math.ceil((bytes / 1048576) * ratio) + reserveMB;
}

/**
 * Upper limit for user-configurable data partition.
 * @returns {{ maxGB:number, warnGB:number, freeMB:number }}
 */
function diskLimits(freeMB) {
  const free = Math.max(0, toInt(freeMB));
  // Partition image consumes host space (dynamic image grows close to size); leave 20% buffer
  const maxGB = Math.max(0, Math.floor((free / 1024) * 0.8));
  return { maxGB, warnGB: Math.max(0, maxGB - 8), freeMB: free };
}

/**
 * Clamp user-entered data partition size (GB). 0 = auto.
 * @returns {{ gb:number, capped:boolean, reason:string }}
 */
function clampDataGB(gb, freeMB) {
  const want = toInt(gb);
  if (want <= 0) return { gb: 0, capped: false, reason: 'auto' };
  const lim = diskLimits(freeMB);
  if (!lim.freeMB) return { gb: want, capped: false, reason: '' };
  if (want > lim.maxGB) {
    return {
      gb: Math.max(0, lim.maxGB),
      capped: true,
      reason: `Disk only has ${(lim.freeMB / 1024).toFixed(1)} GB remaining (只剩 ${(lim.freeMB / 1024).toFixed(1)} GB), can allocate at most ${lim.maxGB} GB`,
    };
  }
  return { gb: want, capped: false, reason: '' };
}

/**
 * Check if storage is sufficient to install this package.
 * @returns {{ ok:boolean, needMB:number, freeMB:number, shortMB:number, note:string }}
 */
function storageVerdict(freeMB, packageBytes) {
  const need = diskRequiredMB(packageBytes);
  const free = Math.max(0, toInt(freeMB));
  if (!free) return { ok: true, needMB: need, freeMB: 0, shortMB: 0, note: 'Unable to read free disk space, skipping pre-check' };
  if (free >= need) return { ok: true, needMB: need, freeMB: free, shortMB: 0, note: '' };
  const short = need - free;
  return {
    ok: false,
    needMB: need,
    freeMB: free,
    shortMB: short,
    note: `Needs ~${(need / 1024).toFixed(1)} GB, currently ${(free / 1024).toFixed(1)} GB free, deficit ${(short / 1024).toFixed(1)} GB (还差 ${(short / 1024).toFixed(1)} GB)`,
  };
}

/**
 * Check whether disk space is sufficient to install this package.
 * @returns {{ ok:boolean, unknown?:boolean, freeMB:number, requiredMB:number, message:string }}
 */
function diskVerdict(freeMB, requiredMB) {
  const free = Math.max(0, toInt(freeMB));
  const need = Math.max(0, toInt(requiredMB));
  if (!free) return { ok: true, unknown: true, freeMB: 0, requiredMB: need, message: '' };
  if (free >= need) return { ok: true, freeMB: free, requiredMB: need, message: '' };
  return {
    ok: false,
    freeMB: free,
    requiredMB: need,
    message: `Insufficient disk space (磁盘空间不足): need ~${Math.ceil(need / 1024)} GB, but disk where ApkStart runtime is located only has ${(free / 1024).toFixed(1)} GB free (ApkStart 运行时所在磁盘只剩 ${(free / 1024).toFixed(1)} GB). `
      + 'Please move runtime directory to a partition with more space in settings, or clean up disk and try again.',
  };
}

module.exports = {
  DEFAULT_STEP_MB,
  MIN_MEM_MB,
  HOST_RESERVE_RATIO,
  hostProfile,
  memoryLimits,
  clampMemoryMB,
  clampCores,
  memVerdict,
  diskRequiredMB,
  diskLimits,
  clampDataGB,
  storageVerdict,
  diskVerdict,
};
