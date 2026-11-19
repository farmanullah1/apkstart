'use strict';
/**
<<<<<<< HEAD
 * Host preflight check + auto-configuration.
 *
 * Why this is needed: whether ApkStart can run after installation depends on 4 hardware/OS factors:
 *   1. CPU virtualization (VT-x / AMD-V) enabled in BIOS;
 *   2. Windows "Hypervisor Platform / Hyper-V" enabled (required by WHPX);
 *   3. GPU capabilities (vendor, VRAM, driver version, hardware rendering support);
 *   4. RAM / disk sufficiency to launch a 2-8GB Android virtual machine.
 *
 * Previously this was "startup fails → user checks log → user guesses". Now we inspect first, automatically
 * configure what can be changed (memory, cores, render size, GPU backend), provide a one-click button for what
 * requires elevation (enable features / install drivers), and clearly guide users on which keys to press in BIOS.
 *
 * Layers:
 *   - collect()   -- probe only (single PowerShell call on Windows to retrieve info), has fallback paths;
 *   - evaluate()  -- pure function: translates probe results into "preflight items + recommended config", unit-testable;
 *   - Application actions reside in main.js (save settings / invoke existing elevation APIs); this module does not touch privileges.
 *
 * Note: **We never pretend to enable BIOS virtualization for the user**. That step must be performed manually.
=======
 * 本机体检 + 自动配置。
 *
 * 为什么需要它：ApkStart 装完之后能不能跑，取决于四件和软件无关的事 ——
 *   1. CPU 虚拟化（VT-x / AMD-V）在 BIOS 里有没有开；
 *   2. Windows 的「虚拟机监控程序平台 / Hyper-V」有没有开（WHPX 靠它）；
 *   3. 显卡能撑到什么程度（厂商、显存、驱动版本，能不能走硬件渲染）；
 *   4. 内存 / 磁盘够不够开一台 2~8GB 的安卓虚拟机。
 *
 * 这些以前都是「启动失败 → 用户看日志 → 自己猜」。现在先查一遍，能自动改的直接改
 * （内存、核心、画质、渲染后端），必须提权的给出一个按钮（开功能 / 装驱动），
 * 只能在 BIOS 里做的说清楚按哪个键、改成什么。
 *
 * 分层：
 *   - collect()   —— 只做探测（Windows 上用一次 PowerShell 取全部信息），有降级路径；
 *   - evaluate()  —— 纯函数：把探测结果翻译成「体检项 + 建议配置」，可单测；
 *   - 应用动作在 main.js（保存设置 / 调已有的提权接口），本模块不碰权限。
 *
 * 注意：**不假装能替用户开 BIOS 虚拟化**。那一步只能人去改，我们只负责判断和指路。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

<<<<<<< HEAD
// ---------------- Probing ----------------

/**
 * Run a short PowerShell script to retrieve JSON; returns null on failure/timeout.
 * Uses async execFile rather than execFileSync to avoid freezing the main process.
=======
// ---------------- 探测 ----------------

/**
 * 跑一段快捷脚本（Windows 的 powershell.exe），取 JSON；失败/超时返回 null。
 *
 * 用异步 execFile 而不是 execFileSync：脚本启动 + 两条 CIM 查询要 1~2 秒，
 * 同步跑会把主进程（也就是整个界面）卡住，用户会以为点「体检」把程序点死了。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function psJson(script, timeout = 15000) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
      ], { encoding: 'utf8', windowsHide: true, timeout }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const t = String(stdout || '').trim();
        if (!t) { resolve(null); return; }
        try { resolve(JSON.parse(t)); } catch (_) { resolve(null); }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

const HW_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,VirtualizationFirmwareEnabled,VMMonitorModeExtensions,SecondLevelAddressTranslationExtensions;',
  '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 HypervisorPresent,TotalPhysicalMemory;',
  '$gpu = @(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,DriverDate,AdapterRAM,VideoProcessor,Status);',
<<<<<<< HEAD
  // AdapterRAM is truncated to 4294967295 when >4GB; real value is in registry qwMemorySize
=======
  // AdapterRAM 在 >4GB 时会被截成 4294967295；真实值在注册表 qwMemorySize（每个适配器一个 000N 子键）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  '$vram = 0;',
  'Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $v = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize";',
  '  if ($v -and $v -gt $vram) { $vram = $v }',
  '};',
  '[pscustomobject]@{ cpu = $cpu; cs = $cs; gpu = $gpu; vram = $vram } | ConvertTo-Json -Depth 6 -Compress',
].join(' ');

const FEATURE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$o = [ordered]@{};',
  'foreach ($n in @("HypervisorPlatform","VirtualMachinePlatform","Microsoft-Hyper-V-All")) {',
  '  try { $o[$n] = (Get-WindowsOptionalFeature -Online -FeatureName $n -ErrorAction Stop).State } catch { $o[$n] = "unknown" }',
  '}',
  '$o | ConvertTo-Json -Compress',
].join(' ');

<<<<<<< HEAD
/** Check file existence (probing WHPX API dll / AEHD driver / vm service) */
=======
/** 判断文件存在（探测 WHPX 的 API 库 / AEHD 驱动 / 虚拟机平台服务） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
<<<<<<< HEAD
  // PowerShell DateTime -> `/Date(1700000000000)/` or ISO string
=======
  // PowerShell 的 DateTime → `/Date(1700000000000)/` 或 ISO 字符串
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
<<<<<<< HEAD
 * Probe host hardware and virtualization status.
 * Returns null/0 if any item cannot be read; never let probe failure crash caller.
 *
 * @param {object} o { accel } passed from provisioner.emulatorAccel() to avoid duplicate emulator spawns
=======
 * 探测本机硬件与虚拟化状态。
 *
 * 任何一项查不到都返回 null/0，**绝不让探测失败拖垮调用方**：
 * 查不到就是「未知」，体检项里会写「读不到」，而不是编一个结论。
 *
 * @param {object} o { accel } accel 由 provisioner.emulatorAccel() 传入，避免重复拉起 emulator
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

<<<<<<< HEAD
  // Primary GPU selection: prefer non-Microsoft Basic Display / non-virtual adapter
=======
  // 选「主显卡」：优先非 Microsoft Basic Display / 非虚拟显示适配器
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
<<<<<<< HEAD
=======
  // AdapterRAM 是 32 位无符号，>4GB 会变成 4095MB，这种值不可信
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);
<<<<<<< HEAD

  // WMI caveat: when Hyper-V/VBS takes over VT, VMMonitorModeExtensions returns false even though acceleration works.
=======
  /**
   * 注意 WMI 这两个字段的坑（本机实测）：
   * Hyper-V / VBS 一旦接管 VT，`VMMonitorModeExtensions` 与
   * `SecondLevelAddressTranslationExtensions` 会返回 False —— 但机器明明能跑硬件加速。
   * 所以「False」只有在「没有 Hypervisor、加速也不可用」时才能当成「不支持」，
   * 否则一律当「未知」，别把能用的机器误判成不支持虚拟化。
   */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');
<<<<<<< HEAD

=======
  // BIOS 侧：同理，Hypervisor 在跑时 firmware 字段也可能不可信
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  let vtFirmware = null;
  if (cpu.VirtualizationFirmwareEnabled === true) vtFirmware = true;
  else if (cpu.VirtualizationFirmwareEnabled === false && !hypervisor && !accelOk) vtFirmware = false;
  const winHv = fileExists('System32\\WinHvPlatform.dll');
  const vmCompute = fileExists('System32\\vmcompute.exe');
  const aehd = fileExists('System32\\drivers\\aehd.sys');

  const state = (k) => {
    const v = feats && feats[k];
    return v ? String(v).toLowerCase() : 'unknown';
  };

  return {
    platform: process.platform,
    arch: process.arch,
    osBuild: (() => {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      return m ? Number(m[1]) : 0;
    })(),
    cpu: {
      name: String(cpu.Name || '').trim(),
      cores: Number(cpu.NumberOfCores) || 0,
      threads: Number(cpu.NumberOfLogicalProcessors) || 0,
      vtSupported,
      vtFirmware,
      slat,
    },
    memory: {
      totalMB: Math.round((Number(cs.TotalPhysicalMemory) || os.totalmem()) / 1048576),
      freeMB: Math.round(os.freemem() / 1048576),
    },
    gpu: {
      name,
      vendor,
      vramMB,
      driverVersion: String(gpu.DriverVersion || ''),
      driverDate: dateToISO(gpu.DriverDate),
      status: String(gpu.Status || ''),
    },
    virtualization: {
      hypervisorPresent: hypervisor,
      hypervisorPlatform: state('HypervisorPlatform'),
      vmPlatform: state('VirtualMachinePlatform'),
      hyperV: state('Microsoft-Hyper-V-All'),
      winHvApi: winHv,
      vmCompute,
      aehdInstalled: aehd,
      accelOk,
      accelKind: accel && accel.ok ? String(accel.kind || 'whpx') : 'none',
    },
  };
}

<<<<<<< HEAD
// ---------------- Evaluation (Pure Functions) ----------------

/** Recommended hardware allocation: memory / cores / render size. Conservative rules. */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // VM gets at most half of host RAM, leaving 1 core for Windows
=======
// ---------------- 评估（纯函数） ----------------

/** 硬件推荐档位：内存 / 核心 / 画质。规则保守，宁可少给不可给多。 */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // 虚拟机最多吃宿主的一半，且留 1 核给 Windows；再按绝对区间收一次
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  let memoryMB = 2048;
  if (mem >= 32768) memoryMB = 8192;
  else if (mem >= 16384) memoryMB = 6144;
  else if (mem >= 12288) memoryMB = 4096;
  else if (mem >= 8192) memoryMB = 3072;
  else memoryMB = 2048;
  if (mem && memoryMB > Math.floor(mem * 0.5 / 512) * 512) {
    memoryMB = Math.max(2048, Math.floor(mem * 0.5 / 512) * 512);
  }
  const wantCores = n >= 8 ? 4 : n >= 4 ? Math.max(2, n - 2) : 2;
  const c = Math.max(1, Math.min(wantCores, n - 1));
<<<<<<< HEAD
  // Software simulation or low VRAM: downscale to 540p, prioritize framerate
=======
  // 软件模拟 + 小显存：分辨率降到 540p，帧率优先（画面面积只有 56%）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

<<<<<<< HEAD
/** Recommended rendering backend */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: 'No hardware acceleration available; using software rendering first to ensure display' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: 'GPU model unknown; letting auto fallback chain handle it' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: 'VRAM is small (or unreadable); swangle is more stable' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'NVIDIA driver is mature; host passthrough is usually fastest' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'AMD integrated graphics or older drivers may crash on host; swangle is more stable' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'Intel integrated graphics GLES support varies; swangle is more stable' };
  return { gpuMode: 'auto', why: 'GPU model unknown; letting auto fallback chain handle it' };
}

/**
 * Translate probe results into a preflight report.
=======
/** 渲染后端建议：按厂商 + 加速状态 + 显存给一个「先试这个」的档位 */
function recommendGpu({ vendor = 'unknown', accelOk = false, vramMB = 0 } = {}) {
  if (!accelOk) return { gpuMode: 'software', why: '没有可用的硬件加速，先用软件渲染保证画面能出来' };
  if (vendor === 'unknown') return { gpuMode: 'auto', why: '显卡型号读不到，交给自动降级链去试' };
  if (!vramMB || vramMB < 512) return { gpuMode: 'swangle', why: '显存很小（或读不到），用 swangle 更稳' };
  if (vendor === 'nvidia') return { gpuMode: 'host', why: 'NVIDIA 驱动成熟，host 直通通常最快' };
  if (vendor === 'amd') return { gpuMode: 'swangle', why: 'AMD 核显/老驱动下 host 可能起来后崩，swangle 更稳' };
  if (vendor === 'intel') return { gpuMode: 'swangle', why: 'Intel 核显对 GLES 支持参差，swangle 更稳' };
  return { gpuMode: 'auto', why: '显卡型号读不到，交给自动降级链去试' };
}

/**
 * 把探测结果翻译成体检报告。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 *
 * @param {object} o { hw, settings, edition } edition: 'store' | 'installer'
 * @returns {{ level:string, items:Array, patch:object|null, driver:object|null, summary:string }}
 */
function evaluate({ hw = {}, settings = {}, edition = 'installer' } = {}) {
  const v = hw.virtualization || {};
  const cpu = hw.cpu || {};
  const gpu = hw.gpu || {};
  const mem = hw.memory || {};
  const items = [];

  const add = (item) => items.push(item);

<<<<<<< HEAD
  // ---- 1. CPU Virtualization (BIOS) ----
=======
  // ---- 1. CPU 虚拟化（BIOS） ----
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
<<<<<<< HEAD
      title: 'This CPU does not support hardware virtualization',
      detail: 'Can only run via software simulation, which is 5-10x slower. Lightweight apps may work, but large games are not recommended.',
=======
      title: '这颗 CPU 不支持硬件虚拟化',
      detail: '只能走软件模拟，速度会慢 5~10 倍。轻量应用还能用，大型游戏不建议。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
<<<<<<< HEAD
      title: 'CPU virtualization is disabled in BIOS',
      detail: 'Restart into BIOS/UEFI, set Intel VT-x (Intel) or SVM Mode (AMD) to Enabled, save and rerun check.'
        + ' Lenovo/Dell/ASUS are usually in Advanced → CPU Configuration; OEMs may name it Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Requires restarting into BIOS, cannot be automated' },
=======
      title: 'CPU 虚拟化在 BIOS 里没开',
      detail: '重启进 BIOS/UEFI，把 Intel VT-x（Intel）或 SVM Mode（AMD）设为 Enabled，保存后回来重新体检。'
        + '联想/戴尔/华硕一般在 Advanced → CPU Configuration 里；品牌机可能叫 Virtualization Technology。',
      action: { kind: 'manual', id: 'bios', label: '需要重启进 BIOS，无法自动完成' },
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
<<<<<<< HEAD
      title: 'CPU virtualization is enabled in BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} cores / ${cpu.threads || '?'} threads` : '',
=======
      title: 'CPU 虚拟化已在 BIOS 开启',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} 核 / ${cpu.threads || '?'} 线程` : '',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
<<<<<<< HEAD
      title: 'Unable to read CPU virtualization status',
      detail: 'May be restricted by motherboard or permissions. If launch reports missing hardware acceleration, please manually check VT-x / SVM in BIOS.',
      action: { kind: 'manual', id: 'bios', label: 'Manual check' },
    });
  }

  // ---- 2. Windows Side: WHPX / Hyper-V ----
=======
      title: '读不到 CPU 虚拟化状态',
      detail: '可能是主板/权限限制。若启动时提示没有硬件加速，请手动进 BIOS 确认 VT-x / SVM 已开启。',
      action: { kind: 'manual', id: 'bios', label: '手动确认' },
    });
  }

  // ---- 2. Windows 侧：WHPX / Hyper-V ----
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
<<<<<<< HEAD
      title: 'Windows Hypervisor Platform is enabled',
      detail: v.hypervisorPresent
        ? 'Hypervisor is running; WHPX is available.'
        : 'Feature is enabled; if acceleration is still unavailable, restart once to start Hypervisor.',
=======
      title: 'Windows 虚拟机监控程序平台已启用',
      detail: v.hypervisorPresent
        ? 'Hypervisor 正在运行，WHPX 可用。'
        : '功能已启用；如果加速仍不可用，重启一次让 Hypervisor 起来。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
<<<<<<< HEAD
      title: '"Hypervisor Platform" is not enabled',
      detail: 'Store edition cannot modify system features automatically. Press Win+R → enter optionalfeatures → check "Windows Hypervisor Platform" (HypervisorPlatform) and "Virtual Machine Platform" → OK → Restart.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Open "Windows Features" dialog' },
=======
      title: '「虚拟机监控程序平台」没有启用',
      detail: '商店版不能自行改系统功能。按 Win+R → 输入 optionalfeatures → 勾选「Windows 虚拟机监控程序平台」'
        + '（HypervisorPlatform）与「虚拟机平台」→ 确定 → 重启。',
      action: { kind: 'elevate', id: 'virtualization', label: '打开「Windows 功能」窗口' },
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
<<<<<<< HEAD
      title: '"Hypervisor Platform" is not enabled',
      detail: 'Clicking the button below will automatically enable HypervisorPlatform + VirtualMachinePlatform (requires administrator confirmation), then restart your computer.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Enable with one click (admin required)' },
    });
  }

  // ---- 3. Hardware acceleration availability ----
=======
      title: '「虚拟机监控程序平台」没有启用',
      detail: '点下面的按钮会自动开启 HypervisorPlatform + VirtualMachinePlatform（需要管理员确认），完成后重启电脑。',
      action: { kind: 'elevate', id: 'virtualization', label: '一键开启（需管理员）' },
    });
  }

  // ---- 3. 硬件加速当前是否真的能用 ----
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
<<<<<<< HEAD
      title: `Hardware acceleration available (${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'})`,
      detail: 'Launch will use hardware acceleration; configuration below is recommended based on this machine\'s GPU and RAM.',
=======
      title: `硬件加速可用（${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'}）`,
      detail: '启动会走硬件加速；下面的配置按这台机器的显卡与内存推荐。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
<<<<<<< HEAD
      title: 'No hardware acceleration currently available',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'You can install the AEHD driver (requires admin) or enable "Hypervisor Platform" and restart; otherwise software simulation will be used.'
        : 'Software simulation will be used to ensure launch; speed is 5-10x slower than hardware acceleration.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Install AEHD driver (requires admin)' }
=======
      title: '当前没有可用的硬件加速',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? '可以装 AEHD 驱动（需管理员），或先开「虚拟机监控程序平台」后重启；两者都不行就只能软件模拟。'
        : '会先用软件模拟保证能跑；速度比硬件加速慢 5~10 倍。',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: '安装 AEHD 驱动（需管理员）' }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        : null,
    });
  }

<<<<<<< HEAD
  // ---- 4. GPU ----
=======
  // ---- 4. 显卡 ----
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
<<<<<<< HEAD
      title: 'Unable to read GPU information',
      detail: 'May be Remote Desktop / VM / driver issue. Rendering backend is delegated to auto fallback chain.',
=======
      title: '读不到显卡信息',
      detail: '可能是远程桌面 / 虚拟机 / 驱动异常。渲染后端交给自动降级链处理。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
<<<<<<< HEAD
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB VRAM${integrated ? ' (Integrated graphics, rest uses shared memory)' : ''}`
      : 'VRAM unknown';
=======
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB 显存${integrated ? '（核显，其余走共享内存）' : ''}`
      : '显存未知';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
<<<<<<< HEAD
      detail: `${vram}${gpu.driverVersion ? ` · Driver ${gpu.driverVersion}` : ''}${gpu.driverDate ? ` (${gpu.driverDate})` : ''}`,
=======
      detail: `${vram}${gpu.driverVersion ? ` · 驱动 ${gpu.driverVersion}` : ''}${gpu.driverDate ? `（${gpu.driverDate}）` : ''}`,
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
<<<<<<< HEAD
        title: 'GPU driver is outdated',
        detail: `Driver date ${gpu.driverDate} (~${Math.floor(old)} years ago). Old drivers commonly cause black/corrupted screen after startup; updating via manufacturer website is recommended.`,
=======
        title: '显卡驱动比较旧',
        detail: `驱动日期 ${gpu.driverDate}（约 ${Math.floor(old)} 年前）。老驱动是「起来后黑屏 / 花屏」的常见原因，建议去厂商官网更新。`,
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        action: null,
      });
    }
  }

<<<<<<< HEAD
  // ---- 5. Memory / Disk / OS version ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'Unable to read physical memory', detail: '', action: null });
=======
  // ---- 5. 内存 / 磁盘 / 系统版本 ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: '读不到物理内存', detail: '', action: null });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
<<<<<<< HEAD
      title: `Low memory (${(total / 1024).toFixed(1)} GB)`,
      detail: 'Android VM can only be allocated 2 GB, 2 cores with resolution reduced to 540x960; closing browser tabs before launching apps is recommended.',
=======
      title: `内存偏小（${(total / 1024).toFixed(1)} GB）`,
      detail: '安卓虚拟机最多只能分 2 GB、2 核，画质降到 540×960，并建议关掉浏览器标签页再开应用。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
<<<<<<< HEAD
      title: `Physical memory ${(total / 1024).toFixed(0)} GB`,
=======
      title: `物理内存 ${(total / 1024).toFixed(0)} GB`,
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
<<<<<<< HEAD
      title: `Windows version is outdated (build ${build})`,
      detail: 'ApkStart requires at least Windows 10 2004 (build 19041). Emulator may exit immediately on older OS versions.',
=======
      title: `Windows 版本较旧（build ${build}）`,
      detail: 'ApkStart 最低支持 Windows 10 2004（build 19041）。更旧的系统上 emulator 可能直接退出。',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      action: null,
    });
  }

<<<<<<< HEAD
  // ---- Recommended Config ----
=======
  // ---- 建议配置 ----
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
<<<<<<< HEAD
=======
      // 加速不可用 → 直接锁定软件模拟，省掉两轮白等；可用则交回 auto 让降级链工作
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

<<<<<<< HEAD
  // Generate a driver for this host
=======
  // 给这台机器生成一份驱动：以后每次开机都按它来，不用重复体检
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'apkstart-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
<<<<<<< HEAD
    name: `Local Auto Config (${gpu.name || vendor})`,
    version: '1.0.0',
    author: 'ApkStart Preflight',
    description: `Generated by Local Preflight & Auto-Config: ${gpuRec.why}. ${v.accelOk ? 'Hardware acceleration available.' : 'No hardware acceleration currently.'}`,
=======
    name: `本机自动配置（${gpu.name || vendor}）`,
    version: '1.0.0',
    author: 'ApkStart 体检',
    description: `由「本机体检 · 自动配置」生成：${gpuRec.why}。${v.accelOk ? '硬件加速可用。' : '当前无硬件加速。'}`,
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    priority: 5,
    match: {
      platform: [hw.platform || process.platform],
      arch: [hw.arch || process.arch],
      ...(vendor !== 'unknown' ? { gpuVendor: [vendor] } : {}),
      ...(build ? { osBuild: { min: build - 2000, max: build + 2000 } } : {}),
    },
    effect: {
      gpuMode: gpuRec.gpuMode,
      ...(v.accelOk ? {} : { forceTcg: true }),
      notes: [gpuRec.why],
    },
  };

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  const level = bad ? 'bad' : warn ? 'warn' : 'good';
  const summary = bad
<<<<<<< HEAD
    ? `Found ${bad} issue(s) that must be resolved first (${items.filter((i) => i.level === 'bad').map((i) => i.title).join(', ')})`
    : warn
      ? `Found ${warn} recommendation(s) for optimization (${items.filter((i) => i.level === 'warn').map((i) => i.title).join(', ')})`
      : 'Hardware acceleration is ready to run, configuration is optimal';
=======
    ? `发现 ${bad} 项必须先处理（${items.filter((i) => i.level === 'bad').map((i) => i.title).join('、')}）`
    : warn
      ? `有 ${warn} 项建议优化（${items.filter((i) => i.level === 'warn').map((i) => i.title).join('、')}）`
      : '这台机器可以直接跑硬件加速，配置已经是最优';
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

  return {
    level,
    items,
    patch,
    driver,
    recommended: { ...rec, ...gpuRec },
    summary,
  };
}

module.exports = {
  collect,
  evaluate,
  recommendResources,
  recommendGpu,
  psJson,
};
