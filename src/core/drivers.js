'use strict';
/**
<<<<<<< HEAD
 * Driver (compatibility patch) extension module.
 *
 * Background: ApkStart uses official emulator + fixed image, but "whether it can run" depends heavily on hardware:
 * older GPUs only support GLES up to 3.1, missing WHPX forces TCG fallback, certain iGPUs + old drivers crash immediately on host rendering...
 * These hardware differences cannot be covered by a single set of default parameters, and the release cadence cannot keep up with users' machine models.
 *
 * Hence this is designed as a **data-driven** extension: each driver is a JSON file declaring "which machines I match"
 * + "which startup parameters to alter upon matching". Users can write, import, and share drivers without modifying code.
 *
 * Three hard constraints in the design:
 *   1. **JSON only, no code execution**. No require / eval / script hooks -- driver files
 *      can be downloaded from the web or shared, and must never gain arbitrary code execution capability.
 *   2. **Whitelist**. Allowed modifications are strictly restricted to explicitly listed startup parameters: `-gpu=...`, `-accel=...`,
 *      a small set of config.ini keys, and a small set of environment variables. Destructive or path-altering flags like
 *      `-wipe-data`, `-datadir`, `-sysdir`, `disk.dataPartition.size` are strictly rejected.
 *   3. **Predictable**. Non-matching drivers have no effect; when multiple drivers match, they stack in ascending `priority` order,
 *      later drivers overriding earlier ones; active drivers are logged on every boot and displayed in the settings page.
 *
 * File format: docs/drivers.md; built-in examples: src/drivers/.
=======
 * 驱动（兼容补丁）扩展模块。
 *
 * 背景：ApkStart 用的是官方 emulator + 固定镜像，但「能不能跑起来」非常吃机器：
 * 老显卡的 GLES 只到 3.1、没有 WHPX 只能走 TCG、某些核显 + 老驱动一开 host 渲染就崩……
 * 这些差异没法靠一份默认参数覆盖所有机器，而发版周期又跟不上用户的机器型号。
 *
 * 所以把它做成**数据驱动**的扩展：一个驱动就是一份 JSON，声明「我匹配哪些机器」
 * + 「匹配上以后改哪些启动参数」。用户可以自己写、自己导入、互相分享，不需要改代码。
 *
 * 设计上的三条硬约束：
 *   1. **只认 JSON，不执行任何代码**。没有 require / eval / 脚本钩子 —— 驱动文件
 *      可以从网上下载、可以互相传，绝不能因此获得在本机执行任意代码的能力。
 *   2. **白名单**。能改的只有启动参数里明确列出的那些：`-gpu=…`、`-accel=…`、
 *      少量 config.ini 键、少量环境变量。`-wipe-data`、`-datadir`、`-sysdir`、
 *      `disk.dataPartition.size` 这类会毁数据 / 改落点的键一律拒绝。
 *   3. **可预期**。匹配不上就不生效；多个驱动同时命中时按 `priority` 从小到大叠加，
 *      后应用的覆盖前面的；每次开机把「用了哪些驱动」写进日志和设置页。
 *
 * 文件格式见 docs/drivers.md，内置示例在 src/drivers/。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */

const fs = require('fs');
const path = require('path');

const DRIVER_FORMAT = 'apkstart-driver/1';
const MAX_DRIVER_BYTES = 256 * 1024;
const MAX_DRIVERS = 200;

<<<<<<< HEAD
/** Startup parameters modifiable by drivers: `-flag=value` format; values must match regex whitelist */
=======
/** 驱动能改的启动参数：`-flag=value` 形式，value 必须匹配白名单正则 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const ARG_RULES = {
  '-gpu': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  '-accel': /^(auto|off|on|whpx|hax|haxm|aehd|tcg)$/,
  '-feature': /^[A-Za-z0-9_,.\-]{1,160}$/,
  '-gltransport': /^(pipe|asgpu|virtio)$/,
<<<<<<< HEAD
  // Single argument passed to qemu. Restricted charset, mount/write flags like -drive/-virtfs disallowed
  '-qemu': /^-?[A-Za-z0-9_+=,.:/\-]{1,120}$/,
};

/** Standalone flag parameters allowed (without values) */
=======
  // 直通给 qemu 的单个参数。限制字符集，且不许出现 -drive/-virtfs 这类挂载/写盘参数
  '-qemu': /^-?[A-Za-z0-9_+=,.:/\-]{1,120}$/,
};

/** 只允许「开关型」参数（不带值） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const FLAG_ONLY = new Set([
  '-no-audio',
  '-no-boot-anim',
  '-no-metrics',
  '-no-snapshot',
  '-no-snapshot-load',
  '-no-snapshot-save',
]);

/**
<<<<<<< HEAD
 * Explicitly forbidden arguments: would delete data, change paths, or bypass port/AVD management.
 * Explicitly listed to explain why they are forbidden rather than just "not in whitelist".
 */
const FORBIDDEN_ARGS = {
  '-wipe-data': 'Will clear user apps and saves',
  '-datadir': 'Will change AVD directory, breaking multi-instance isolation',
  '-sysdir': 'Will change system image source',
  '-partition-size': 'Will change data partition size; use settings page',
  '-avd': 'AVD name is managed by ApkStart',
  '-port': 'Port is dynamically allocated by ApkStart',
  '-http-proxy': 'Please configure proxy in system settings',
};

/** config.ini keys modifiable by drivers */
=======
 * 明确拒绝的参数：会删数据、改落点、绕过我们的端口/AVD 管理。
 * 单独列出来是为了在报错时说清楚「为什么不行」，而不是只说「不在白名单里」。
 */
const FORBIDDEN_ARGS = {
  '-wipe-data': '会清空用户已装应用与存档',
  '-datadir': '会改 AVD 落点，破坏多实例隔离',
  '-sysdir': '会改系统镜像来源',
  '-partition-size': '会改数据分区大小，请走设置页',
  '-avd': 'AVD 名由 ApkStart 管理',
  '-port': '端口由 ApkStart 动态分配',
  '-http-proxy': '代理请走系统设置',
};

/** 驱动能改的 config.ini 键 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const INI_RULES = {
  'hw.gpu.mode': /^(auto|host|swiftshader|swiftshader_indirect|swangle|software|angle|angle_indirect|mesa)$/,
  'hw.gpu.enabled': /^(yes|no)$/,
  'hw.gltransport': /^(pipe|asgpu|virtio)$/,
  'hw.keyboard': /^(yes|no)$/,
  'hw.audioInput': /^(yes|no|none)$/,
  'hw.audioOutput': /^(yes|no)$/,
  'hw.camera.back': /^(none|emulated|webcam0)$/,
  'hw.camera.front': /^(none|emulated|webcam0)$/,
  'hw.gps': /^(yes|no)$/,
  'vm.heapSize': /^\d{2,4}$/,
  'hw.lcd.density': /^\d{3,4}$/,
};

<<<<<<< HEAD
/** Environment variable names modifiable by drivers */
=======
/** 驱动能改的环境变量名 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const ENV_NAME_RULES = [
  /^ANDROID_[A-Z0-9_]{2,40}$/,
  /^QEMU_[A-Z0-9_]{2,40}$/,
  /^LIBGL_[A-Z0-9_]{2,40}$/,
  /^MESA_[A-Z0-9_]{2,40}$/,
  /^EMUGL_[A-Z0-9_]{2,40}$/,
];

<<<<<<< HEAD
/** Allowed keys inside match (extra keys treated as errors to prevent silent no-ops) */
=======
/** match 里允许出现的键（多一个都算错，避免用户以为自己写了但没生效） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const MATCH_KEYS = new Set([
  'any', 'platform', 'arch', 'gpuVendor', 'gpuName', 'cpuVendor',
  'osBuild', 'totalMB', 'cores', 'accel', 'emulatorVersion',
]);

const EFFECT_KEYS = new Set([
  'gpuMode', 'forceTcg', 'emulatorArgs', 'configIni', 'env', 'notes',
]);

<<<<<<< HEAD
// ---------------- Helpers ----------------
=======
// ---------------- 小工具 ----------------
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

<<<<<<< HEAD
/** Compile user-supplied regex: bounded by length and syntax; returns null on error */
=======
/** 编译用户写的正则：长度与语法都要能兜住，编译失败返回 null（校验阶段会报错） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function safeRegex(pattern) {
  const s = String(pattern || '');
  if (!s || s.length > 200) return null;
  try {
    return new RegExp(s, 'i');
  } catch (_) {
    return null;
  }
}

<<<<<<< HEAD
/** Compare version numbers by first 4 segments */
=======
/** 版本号只取前四段数字比较，'36.4.9' vs '36.4.10' 不能按字符串比 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function versionParts(v) {
  return String(v || '')
    .split(/[^\d]+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(Number);
}

function cmpVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function inRange(value, range) {
  if (range === undefined || range === null) return true;
  const { min, max } = isObj(range) ? range : { min: range };
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  if (min !== undefined && n < Number(min)) return false;
  if (max !== undefined && n > Number(max)) return false;
  return true;
}

<<<<<<< HEAD
// ---------------- Validation ----------------
=======
// ---------------- 校验 ----------------
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

function validateMatch(match, errors) {
  if (match === undefined) return {};
  if (!isObj(match)) {
<<<<<<< HEAD
    errors.push('match must be an object');
    return {};
  }
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.has(k)) errors.push(`match.${k} is not a supported match condition`);
=======
    errors.push('match 必须是对象');
    return {};
  }
  for (const k of Object.keys(match)) {
    if (!MATCH_KEYS.has(k)) errors.push(`match.${k} 不是支持的匹配条件`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }
  const out = {};
  if (match.any !== undefined) out.any = !!match.any;
  if (match.platform !== undefined) out.platform = asArray(match.platform).map(String);
  if (match.arch !== undefined) out.arch = asArray(match.arch).map(String);
  if (match.gpuVendor !== undefined) out.gpuVendor = asArray(match.gpuVendor).map((v) => String(v).toLowerCase());
  if (match.cpuVendor !== undefined) out.cpuVendor = asArray(match.cpuVendor).map((v) => String(v).toLowerCase());
  if (match.accel !== undefined) out.accel = asArray(match.accel).map((v) => String(v).toLowerCase());
  if (match.gpuName !== undefined) {
<<<<<<< HEAD
    if (!safeRegex(match.gpuName)) errors.push('match.gpuName is not a valid regular expression (length must be <= 200)');
=======
    if (!safeRegex(match.gpuName)) errors.push('match.gpuName 不是合法正则（且长度需 ≤200）');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    else out.gpuName = String(match.gpuName);
  }
  for (const k of ['osBuild', 'totalMB', 'cores', 'emulatorVersion']) {
    if (match[k] === undefined) continue;
    if (!isObj(match[k]) && typeof match[k] !== 'number' && typeof match[k] !== 'string') {
<<<<<<< HEAD
      errors.push(`match.${k} must be a number or {min,max}`);
=======
      errors.push(`match.${k} 必须是数字或 {min,max}`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    if (isObj(match[k])) {
      const bad = ['min', 'max'].filter((x) => match[k][x] !== undefined && !Number.isFinite(Number(match[k][x])));
      if (bad.length) {
<<<<<<< HEAD
        errors.push(`match.${k}.${bad.join('/')} must be a number`);
=======
        errors.push(`match.${k}.${bad.join('/')} 必须是数字`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        continue;
      }
      out[k] = { min: match[k].min, max: match[k].max };
    } else {
      out[k] = { min: match[k] };
    }
  }
  return out;
}

function validateArgs(args, errors) {
  const out = [];
  if (args === undefined) return out;
  if (!Array.isArray(args)) {
<<<<<<< HEAD
    errors.push('effect.emulatorArgs must be a string array');
=======
    errors.push('effect.emulatorArgs 必须是字符串数组');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return out;
  }
  for (const raw of args) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    const flag = eq > 0 ? s.slice(0, eq) : s;
    const value = eq > 0 ? s.slice(eq + 1) : '';
    if (FORBIDDEN_ARGS[flag]) {
<<<<<<< HEAD
      errors.push(`emulatorArgs does not allow ${flag} (forbidden argument ${flag}): ${FORBIDDEN_ARGS[flag]}`);
      continue;
    }
    if (eq < 0) {
      if (!FLAG_ONLY.has(flag)) errors.push(`emulatorArgs does not support standalone parameter ${flag} (with value write ${flag}=value)`);
=======
      errors.push(`emulatorArgs 不允许 ${flag}：${FORBIDDEN_ARGS[flag]}`);
      continue;
    }
    if (eq < 0) {
      if (!FLAG_ONLY.has(flag)) errors.push(`emulatorArgs 不支持单独的参数 ${flag}（带值的请写成 ${flag}=值）`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      else out.push({ flag, value: '' });
      continue;
    }
    const rule = ARG_RULES[flag];
    if (!rule) {
<<<<<<< HEAD
      errors.push(`emulatorArgs does not support ${flag}`);
      continue;
    }
    if (!rule.test(value)) {
      errors.push(`emulatorArgs invalid value for ${flag}: ${value}`);
=======
      errors.push(`emulatorArgs 不支持 ${flag}`);
      continue;
    }
    if (!rule.test(value)) {
      errors.push(`emulatorArgs 的 ${flag} 取值不合法：${value}`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    out.push({ flag, value });
  }
  return out;
}

function validateIni(ini, errors) {
  const out = {};
  if (ini === undefined) return out;
  if (!isObj(ini)) {
<<<<<<< HEAD
    errors.push('effect.configIni must be an object');
=======
    errors.push('effect.configIni 必须是对象');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return out;
  }
  for (const [k, v] of Object.entries(ini)) {
    const rule = INI_RULES[k];
    if (!rule) {
<<<<<<< HEAD
      errors.push(`configIni does not support ${k} (keys modifying data partition or landing paths are rejected)`);
=======
      errors.push(`configIni 不支持 ${k}（会破坏数据分区 / 落点的键一律拒绝）`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    const s = String(v);
    if (!rule.test(s)) {
<<<<<<< HEAD
      errors.push(`configIni invalid value for ${k}: ${s}`);
=======
      errors.push(`configIni 的 ${k} 取值不合法：${s}`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    out[k] = s;
  }
  return out;
}

function validateEnv(env, errors) {
  const out = {};
  if (env === undefined) return out;
  if (!isObj(env)) {
<<<<<<< HEAD
    errors.push('effect.env must be an object');
=======
    errors.push('effect.env 必须是对象');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return out;
  }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RULES.some((re) => re.test(k))) {
<<<<<<< HEAD
      errors.push(`env does not allow setting ${k} (only ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefixes allowed)`);
=======
      errors.push(`env 不允许设置 ${k}（只放行 ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ 前缀）`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    const s = String(v);
    if (s.length > 200 || /[\r\n\0]/.test(s)) {
<<<<<<< HEAD
      errors.push(`env.${k} invalid value (length <= 200, no newlines)`);
=======
      errors.push(`env.${k} 的取值不合法（长度 ≤200，且不能含换行）`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    out[k] = s;
  }
  return out;
}

/**
<<<<<<< HEAD
 * Validate a driver object.
 * Returns all errors in a single pass.
 * @param {object} raw
 * @param {object} [opts] { file }
=======
 * 校验一份驱动（就是 JSON.parse 之后的对象）。
 * 返回 errors 是给人看的，能一次列全，不要「修一个报一个」。
 * @param {object} raw
 * @param {object} [opts] { file } 出错时带上文件名
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @returns {{ ok:boolean, errors:string[], driver:object|null }}
 */
function validateDriver(raw, { file = '' } = {}) {
  const errors = [];
  const where = file ? `${file}: ` : '';
<<<<<<< HEAD
  if (!isObj(raw)) return { ok: false, errors: [`${where}Driver must be a JSON object`], driver: null };

  if (raw.format !== DRIVER_FORMAT) {
    errors.push(`${where}format must be "${DRIVER_FORMAT}" (current ${JSON.stringify(raw.format)})`);
  }
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) {
    errors.push(`${where}id must consist of alphanumeric and . _ -, 3-64 characters (e.g. amd-igpu-swangle)`);
  }
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) errors.push(`${where}name is required and must not exceed 80 characters`);
  const version = String(raw.version || '').trim();
  if (!/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/.test(version)) errors.push(`${where}version must be like 1.0.0`);
  if (raw.priority !== undefined && (!Number.isFinite(Number(raw.priority)) || Math.abs(Number(raw.priority)) > 100)) {
    errors.push(`${where}priority must be a number between -100 and 100`);
=======
  if (!isObj(raw)) return { ok: false, errors: [`${where}驱动必须是 JSON 对象`], driver: null };

  if (raw.format !== DRIVER_FORMAT) {
    errors.push(`${where}format 必须是 "${DRIVER_FORMAT}"（当前 ${JSON.stringify(raw.format)}）`);
  }
  const id = String(raw.id || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(id)) {
    errors.push(`${where}id 必须由字母数字和 . _ - 组成，3~64 个字符（例如 amd-igpu-swangle）`);
  }
  const name = String(raw.name || '').trim();
  if (!name || name.length > 80) errors.push(`${where}name 必填，且不超过 80 字`);
  const version = String(raw.version || '').trim();
  if (!/^\d+(\.\d+){0,3}(-[A-Za-z0-9.]+)?$/.test(version)) errors.push(`${where}version 必须形如 1.0.0`);
  if (raw.priority !== undefined && (!Number.isFinite(Number(raw.priority)) || Math.abs(Number(raw.priority)) > 100)) {
    errors.push(`${where}priority 必须是 -100 ~ 100 的数字`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }

  const match = validateMatch(raw.match, errors);
  if (raw.match !== undefined && isObj(raw.match) && Object.keys(raw.match).length === 0) {
<<<<<<< HEAD
    errors.push(`${where}match cannot be an empty object; write {"any": true} to match all machines`);
  }
  const effectRaw = isObj(raw.effect) ? raw.effect : null;
  if (!effectRaw) errors.push(`${where}effect must be an object`);
=======
    errors.push(`${where}match 不能是空对象；如果要匹配所有机器请写 {"any": true}`);
  }
  const effectRaw = isObj(raw.effect) ? raw.effect : null;
  if (!effectRaw) errors.push(`${where}effect 必须是对象`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  let effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  if (effectRaw) {
    for (const k of Object.keys(effectRaw)) {
<<<<<<< HEAD
      if (!EFFECT_KEYS.has(k)) errors.push(`${where}effect.${k} is not a supported field`);
    }
    if (effectRaw.gpuMode !== undefined) {
      const v = String(effectRaw.gpuMode);
      if (!ARG_RULES['-gpu'].test(v)) errors.push(`${where}effect.gpuMode invalid value: ${v}`);
      else effect.gpuMode = v;
    }
    if (effectRaw.forceTcg !== undefined) {
      if (typeof effectRaw.forceTcg !== 'boolean') errors.push(`${where}effect.forceTcg must be true/false`);
=======
      if (!EFFECT_KEYS.has(k)) errors.push(`${where}effect.${k} 不是支持的字段`);
    }
    if (effectRaw.gpuMode !== undefined) {
      const v = String(effectRaw.gpuMode);
      if (!ARG_RULES['-gpu'].test(v)) errors.push(`${where}effect.gpuMode 取值不合法：${v}`);
      else effect.gpuMode = v;
    }
    if (effectRaw.forceTcg !== undefined) {
      if (typeof effectRaw.forceTcg !== 'boolean') errors.push(`${where}effect.forceTcg 必须是 true/false`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      else effect.forceTcg = effectRaw.forceTcg;
    }
    effect.args = validateArgs(effectRaw.emulatorArgs, errors);
    effect.ini = validateIni(effectRaw.configIni, errors);
    effect.env = validateEnv(effectRaw.env, errors);
    if (effectRaw.notes !== undefined) {
<<<<<<< HEAD
      if (!Array.isArray(effectRaw.notes)) errors.push(`${where}effect.notes must be a string array`);
=======
      if (!Array.isArray(effectRaw.notes)) errors.push(`${where}effect.notes 必须是字符串数组`);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      else {
        effect.notes = effectRaw.notes
          .map((n) => String(n).trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((n) => (n.length > 200 ? `${n.slice(0, 200)}…` : n));
      }
    }
  }

  if (errors.length) return { ok: false, errors, driver: null };
  return {
    ok: true,
    errors: [],
    driver: {
      format: DRIVER_FORMAT,
      id,
      name,
      version,
      author: String(raw.author || '').slice(0, 60),
      description: String(raw.description || '').slice(0, 400),
      homepage: String(raw.homepage || '').slice(0, 200),
      priority: Number(raw.priority || 0),
<<<<<<< HEAD
=======
      // 内置示例统一 disabled，用户自己的默认启用
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      enabled: raw.enabled !== false,
      match,
      effect,
      file,
    },
  };
}

<<<<<<< HEAD
// ---------------- Matching ----------------

/**
 * Assemble host profile to match against.
=======
// ---------------- 匹配 ----------------

/**
 * 组装「这台机器」的画像，喂给 match。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @param {object} o { info, gpuVendor, gpuName, osBuild, accel, emulatorVersion }
 */
function hostContext({ info = {}, gpuVendor = 'unknown', gpuName = '', osBuild = 0, accel = 'unknown', emulatorVersion = '' } = {}) {
  const rel = String(process.release && process.release.name === 'node' ? '' : '');
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB: toInt(info.totalMB),
    cores: toInt(info.cores) || 1,
    gpuVendor: String(gpuVendor || 'unknown').toLowerCase(),
    gpuName: String(gpuName || ''),
    cpuVendor: String((info.cpuVendor || '')).toLowerCase(),
    osBuild: toInt(osBuild),
    accel: String(accel || 'unknown').toLowerCase(),
    emulatorVersion: String(emulatorVersion || rel || ''),
  };
}

/**
<<<<<<< HEAD
 * Match host profile against driver match rules.
=======
 * 匹配结果里同时返回「命中了哪几条」，界面能解释「为什么这个驱动生效了」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @returns {{ ok:boolean, hits:string[] }}
 */
function matchHost(match, host) {
  if (!isObj(match) || !Object.keys(match).length) return { ok: false, hits: [] };
  const hits = [];
  if (match.any) hits.push('any');
  if (match.platform && !match.platform.includes(host.platform)) return { ok: false, hits: [] };
  if (match.platform) hits.push(`platform=${host.platform}`);
  if (match.arch && !match.arch.includes(host.arch)) return { ok: false, hits: [] };
  if (match.arch) hits.push(`arch=${host.arch}`);
  if (match.gpuVendor && !match.gpuVendor.includes(host.gpuVendor)) return { ok: false, hits: [] };
  if (match.gpuVendor) hits.push(`gpu=${host.gpuVendor}`);
  if (match.gpuName) {
    const re = safeRegex(match.gpuName);
    if (!re || !re.test(host.gpuName || '')) return { ok: false, hits: [] };
    hits.push(`gpuName≈${match.gpuName}`);
  }
  if (match.cpuVendor && !match.cpuVendor.includes(host.cpuVendor)) return { ok: false, hits: [] };
  if (match.cpuVendor) hits.push(`cpu=${host.cpuVendor}`);
  if (match.accel && !match.accel.includes(host.accel)) return { ok: false, hits: [] };
  if (match.accel) hits.push(`accel=${host.accel}`);
  if (match.osBuild !== undefined) {
    const b = host.osBuild;
    if (!b || !inRange(b, match.osBuild)) return { ok: false, hits: [] };
    hits.push(`osBuild=${b}`);
  }
  if (match.totalMB !== undefined) {
    if (!inRange(host.totalMB, match.totalMB)) return { ok: false, hits: [] };
    hits.push(`mem=${host.totalMB}MB`);
  }
  if (match.cores !== undefined) {
    if (!inRange(host.cores, match.cores)) return { ok: false, hits: [] };
    hits.push(`cores=${host.cores}`);
  }
  if (match.emulatorVersion !== undefined) {
    const v = host.emulatorVersion;
    if (!v) return { ok: false, hits: [] };
    if (match.emulatorVersion.min !== undefined && cmpVersion(v, match.emulatorVersion.min) < 0) return { ok: false, hits: [] };
    if (match.emulatorVersion.max !== undefined && cmpVersion(v, match.emulatorVersion.max) > 0) return { ok: false, hits: [] };
    hits.push(`emu=${v}`);
  }
  return { ok: hits.length > 0, hits };
}

<<<<<<< HEAD
/** Specificity count: more matching criteria = more specific */
=======
/** 匹配条件越多越"具体"：同等 priority 时，泛化驱动先应用，专门的驱动后应用（覆盖它） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function specificity(match) {
  return Object.keys(match || {}).filter((k) => k !== 'any').length;
}

/**
<<<<<<< HEAD
 * Merge matched drivers into composite effect in order: generic -> specific -> priority.
=======
 * 把命中的驱动按「泛化 → 具体 → priority」顺序叠成一份效果。
 * 后面的覆盖前面的：gpuMode/forceTcg 取最后一个，args 同 flag 取最后一个，ini/env 合并。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function mergeEffect(drivers) {
  const effect = {
    gpuMode: '', forceTcg: null, args: [], ini: {}, env: {}, notes: [],
  };
  const argIndex = new Map();
  for (const d of drivers) {
    const e = d.effect;
    if (e.gpuMode) effect.gpuMode = e.gpuMode;
    if (e.forceTcg !== null) effect.forceTcg = e.forceTcg;
    for (const a of e.args) {
      const key = a.flag;
      if (argIndex.has(key)) effect.args[argIndex.get(key)] = a;
      else {
        argIndex.set(key, effect.args.length);
        effect.args.push(a);
      }
    }
    Object.assign(effect.ini, e.ini);
    Object.assign(effect.env, e.env);
    for (const n of e.notes) effect.notes.push(`${d.name}：${n}`);
  }
  return effect;
}

/**
<<<<<<< HEAD
 * Filter and resolve effective drivers for this host.
=======
 * 从一堆（已校验的）驱动里挑出这台机器要用的，并合成最终效果。
 *
 * `state` 是用户在界面上做的显式开关（id → true/false），优先级高于文件里的
 * `enabled`：内置示例默认 `enabled:false`，用户点一下「启用」就写进 state，
 * 不需要去安装目录改 JSON（商店版目录是只读的，改不了）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 *
 * @param {object} o { drivers, host, state, disabled }
 * @returns {{ applied:Array, skipped:Array, effect:object }}
 */
function resolve({ drivers = [], host = {}, state = {}, disabled = [] } = {}) {
  const off = new Set((Array.isArray(disabled) ? disabled : []).map(String));
  const applied = [];
  const skipped = [];
  for (const d of drivers) {
    if (!d || !d.id) continue;
    const forced = state && typeof state[d.id] === 'boolean' ? state[d.id] : null;
    const on = forced !== null ? forced : (d.enabled !== false);
    if (!on || off.has(d.id)) {
      skipped.push({ id: d.id, name: d.name, reason: 'disabled' });
      continue;
    }
    const m = matchHost(d.match, host);
    if (!m.ok) {
      skipped.push({ id: d.id, name: d.name, reason: 'no-match' });
      continue;
    }
    applied.push({ ...d, hits: m.hits, matchCount: specificity(d.match) });
  }
  applied.sort((a, b) => (a.priority - b.priority)
    || (a.matchCount - b.matchCount)
    || String(a.id).localeCompare(String(b.id)));
  return { applied, skipped, effect: mergeEffect(applied) };
}

<<<<<<< HEAD
// ---------------- File IO ----------------

/** User drivers directory */
=======
// ---------------- 文件 IO ----------------

/** 用户驱动目录（与设置、日志同级，跟着数据目录走） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function userDir(store) {
  return path.join(store.DATA_DIR, 'drivers');
}

<<<<<<< HEAD
/** Bundled example drivers directory */
=======
/** 随包内置的示例驱动（只读；默认 enabled:false，作为模板给人抄） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function bundledDir(appRoot) {
  return path.join(appRoot || '.', 'src', 'drivers');
}

/**
<<<<<<< HEAD
 * Read all drivers from a directory. Bad files do not block others.
=======
 * 读一个目录里的全部驱动。坏文件不阻断其它驱动：
 * 报错收集起来交给界面显示，能用的照常用。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @returns {{ drivers:Array, errors:Array<{file:string, errors:string[]}>, dir:string }}
 */
function loadDir(dir) {
  const out = { drivers: [], errors: [], dir };
  if (!dir || !fs.existsSync(dir)) return out;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.json$/i.test(n));
  } catch (e) {
    out.errors.push({ file: dir, errors: [e.message] });
    return out;
  }
  names.sort();
  for (const n of names.slice(0, MAX_DRIVERS)) {
    const file = path.join(dir, n);
    let raw;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_DRIVER_BYTES) {
<<<<<<< HEAD
        out.errors.push({ file, errors: [`File is too large (${st.size} bytes, limit ${MAX_DRIVER_BYTES})`] });
=======
        out.errors.push({ file, errors: [`文件过大（${st.size} 字节，上限 ${MAX_DRIVER_BYTES}）`] });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        continue;
      }
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
<<<<<<< HEAD
      out.errors.push({ file, errors: [`Unable to read: ${e.message}`] });
=======
      out.errors.push({ file, errors: [`读不出来：${e.message}`] });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      continue;
    }
    const r = validateDriver(raw, { file });
    if (!r.ok) out.errors.push({ file, errors: r.errors });
    else out.drivers.push({ ...r.driver, dir });
  }
  return out;
}

<<<<<<< HEAD
/** Read multiple directories and deduplicate by id */
=======
/** 读多个目录并按 id 去重：用户目录优先（同 id 时覆盖内置） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function loadAll(dirs = []) {
  const all = [];
  const errors = [];
  for (const dir of dirs) {
    const r = loadDir(dir);
    errors.push(...r.errors);
    for (const d of r.drivers) {
      const i = all.findIndex((x) => x.id === d.id);
      if (i >= 0) all[i] = d;
      else all.push(d);
    }
  }
  return { drivers: all, errors };
}

/**
<<<<<<< HEAD
 * Import a driver: validates first, then saves as `<id>.json`.
=======
 * 导入一份驱动：先校验，再按 id 存成 `<id>.json`。
 * 文件名只由校验过的 id 决定，用户给的文件名不参与拼接（挡住 ../ 之类的路径穿越）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @returns {{ ok:boolean, file?:string, driver?:object, errors?:string[] }}
 */
function importDriver(srcFile, destDir) {
  let raw;
  try {
    const st = fs.statSync(srcFile);
<<<<<<< HEAD
    if (st.size > MAX_DRIVER_BYTES) return { ok: false, errors: ['File is too large (max 256 KB)'] };
    raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`Unable to read: ${e.message}`] };
=======
    if (st.size > MAX_DRIVER_BYTES) return { ok: false, errors: ['文件过大，驱动最多 256 KB'] };
    raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`读不出来：${e.message}`] };
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }
  const r = validateDriver(raw, { file: path.basename(srcFile) });
  if (!r.ok) return { ok: false, errors: r.errors };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `${r.driver.id}.json`);
    fs.writeFileSync(dest, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return { ok: true, file: dest, driver: r.driver };
  } catch (e) {
<<<<<<< HEAD
    return { ok: false, errors: [`Write failed: ${e.message}`] };
=======
    return { ok: false, errors: [`写入失败：${e.message}`] };
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }
}

/**
<<<<<<< HEAD
 * Export a template for current host.
 */
function templateFromHost(host = {}, { name = 'My Machine' } = {}) {
=======
 * 导出一份「本机模板」：把当前机器的画像填进 match，
 * 用户只要改 effect 就能做出「只对我这台机器生效」的驱动。
 */
function templateFromHost(host = {}, { name = '我的机器' } = {}) {
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const gpu = host.gpuVendor && host.gpuVendor !== 'unknown' ? host.gpuVendor : 'unknown';
  return {
    format: DRIVER_FORMAT,
    id: `my-${gpu}-${toInt(host.osBuild) || 'custom'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
<<<<<<< HEAD
    name: `${name} Compatibility Patch`,
    version: '1.0.0',
    author: '',
    description: 'Generated by ApkStart "Export Host Template": match is populated for this machine, edit effect as needed.',
=======
    name: `${name} 兼容补丁`,
    version: '1.0.0',
    author: '',
    description: '由 ApkStart「导出本机模板」生成：match 已经按这台机器填好，按需修改 effect 即可。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    priority: 0,
    match: {
      platform: host.platform || process.platform,
      arch: host.arch || process.arch,
      ...(gpu !== 'unknown' ? { gpuVendor: gpu } : {}),
      ...(host.totalMB ? { totalMB: { min: Math.max(2048, Math.round(host.totalMB * 0.9)) } } : {}),
    },
    effect: {
      gpuMode: 'swangle',
      forceTcg: false,
      emulatorArgs: [],
      configIni: {},
      env: {},
<<<<<<< HEAD
      notes: ['Example: try changing gpuMode to host / software or enable forceTcg'],
=======
      notes: ['示例：把 gpuMode 改成 host / software 或打开 forceTcg 试试'],
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    },
  };
}

<<<<<<< HEAD
/** Translate gpuMode to emulator -gpu argument */
=======
/** 把 gpuMode 翻译成 emulator 的 -gpu 值（auto 表示不改） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function gpuModeToArg(mode) {
  const v = String(mode || '').trim();
  return v && v !== 'auto' ? v : '';
}

module.exports = {
  DRIVER_FORMAT,
  ARG_RULES,
  FLAG_ONLY,
  FORBIDDEN_ARGS,
  INI_RULES,
  ENV_NAME_RULES,
  MATCH_KEYS,
  EFFECT_KEYS,
  MAX_DRIVER_BYTES,
  safeRegex,
  cmpVersion,
  validateDriver,
  hostContext,
  matchHost,
  specificity,
  mergeEffect,
  resolve,
  userDir,
  bundledDir,
  loadDir,
  loadAll,
  importDriver,
  templateFromHost,
  gpuModeToArg,
};
