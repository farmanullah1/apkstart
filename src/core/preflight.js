'use strict';
/**
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
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// ---------------- Probing ----------------

/**
 * Run a short PowerShell script to retrieve JSON; returns null on failure/timeout.
 * Uses async execFile rather than execFileSync to avoid freezing the main process.
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
  // AdapterRAM is truncated to 4294967295 when >4GB; real value is in registry qwMemorySize
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

/** Check file existence (probing WHPX API dll / AEHD driver / vm service) */
function fileExists(rel) {
  try {
    return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', rel));
  } catch (_) {
    return false;
  }
}

function dateToISO(v) {
  if (!v) return '';
  // PowerShell DateTime -> `/Date(1700000000000)/` or ISO string
  const m = /\/Date\((\d+)\)\//.exec(String(v));
  if (m) {
    try { return new Date(Number(m[1])).toISOString().slice(0, 10); } catch (_) { return ''; }
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

/**
 * Probe host hardware and virtualization status.
 * Returns null/0 if any item cannot be read; never let probe failure crash caller.
 *
 * @param {object} o { accel } passed from provisioner.emulatorAccel() to avoid duplicate emulator spawns
 * @returns {object} hw
 */
async function collect({ accel = null } = {}) {
  const [raw, feats] = process.platform === 'win32'
    ? await Promise.all([psJson(HW_SCRIPT), psJson(FEATURE_SCRIPT)])
    : [null, null];
  const cpu = (raw && raw.cpu) || {};
  const cs = (raw && raw.cs) || {};
  const gpus = Array.isArray(raw && raw.gpu) ? raw.gpu : (raw && raw.gpu ? [raw.gpu] : []);

  // Primary GPU selection: prefer non-Microsoft Basic Display / non-virtual adapter
  const usable = gpus.filter((g) => g && g.Name && !/microsoft basic|remote display|virtual display/i.test(g.Name));
  const gpu = (usable[0] || gpus[0]) || {};
  const name = String(gpu.Name || '');
  let vendor = 'unknown';
  if (/nvidia|geforce|rtx\s|gtx\s|quadro/i.test(name)) vendor = 'nvidia';
  else if (/(?<!virtual\s)(amd|radeon|rx\s\d)/i.test(name)) vendor = 'amd';
  else if (/intel|uhd\s|iris|arc\s/i.test(name)) vendor = 'intel';

  const ramBytes = Number(gpu.AdapterRAM) || 0;
  const qw = Number((raw && raw.vram) || 0);
  const vramMB = Math.round((qw > 0 ? qw : (ramBytes > 0 && ramBytes < 4096 * 1024 * 1024 ? ramBytes : 0)) / 1048576);

  const hypervisor = cs.HypervisorPresent === true;
  const accelOk = !!(accel && accel.ok);

  // WMI caveat: when Hyper-V/VBS takes over VT, VMMonitorModeExtensions returns false even though acceleration works.
  const vmExt = cpu.VMMonitorModeExtensions;
  const slatRaw = cpu.SecondLevelAddressTranslationExtensions;
  let vtSupported = true;
  if (vmExt === false && !hypervisor && !accelOk) vtSupported = false;
  else if (vmExt !== true) vtSupported = 'unknown';
  const slat = slatRaw === true ? true : (slatRaw === false && !hypervisor && !accelOk ? false : 'unknown');

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

// ---------------- Evaluation (Pure Functions) ----------------

/** Recommended hardware allocation: memory / cores / render size. Conservative rules. */
function recommendResources({ totalMB = 0, cores = 0, accelOk = false, vramMB = 0 } = {}) {
  const mem = Number(totalMB) || 0;
  const n = Number(cores) || 1;
  // VM gets at most half of host RAM, leaving 1 core for Windows
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
  // Software simulation or low VRAM: downscale to 540p, prioritize framerate
  const renderSize = (!accelOk || (vramMB > 0 && vramMB < 512)) ? '540x960' : 'auto';
  return { memoryMB, cores: c, renderSize };
}

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

  // ---- 1. CPU Virtualization (BIOS) ----
  if (cpu.vtSupported === false) {
    add({
      key: 'vt-unsupported',
      level: 'bad',
      title: 'This CPU does not support hardware virtualization',
      detail: 'Can only run via software simulation, which is 5-10x slower. Lightweight apps may work, but large games are not recommended.',
      action: null,
    });
  } else if (cpu.vtFirmware === false) {
    add({
      key: 'vt-bios-off',
      level: 'bad',
      title: 'CPU virtualization is disabled in BIOS',
      detail: 'Restart into BIOS/UEFI, set Intel VT-x (Intel) or SVM Mode (AMD) to Enabled, save and rerun check.'
        + ' Lenovo/Dell/ASUS are usually in Advanced → CPU Configuration; OEMs may name it Virtualization Technology.',
      action: { kind: 'manual', id: 'bios', label: 'Requires restarting into BIOS, cannot be automated' },
    });
  } else if (cpu.vtFirmware === true) {
    add({
      key: 'vt-ok',
      level: 'ok',
      title: 'CPU virtualization is enabled in BIOS',
      detail: cpu.name ? `${cpu.name} · ${cpu.cores || '?'} cores / ${cpu.threads || '?'} threads` : '',
      action: null,
    });
  } else {
    add({
      key: 'vt-unknown',
      level: 'warn',
      title: 'Unable to read CPU virtualization status',
      detail: 'May be restricted by motherboard or permissions. If launch reports missing hardware acceleration, please manually check VT-x / SVM in BIOS.',
      action: { kind: 'manual', id: 'bios', label: 'Manual check' },
    });
  }

  // ---- 2. Windows Side: WHPX / Hyper-V ----
  const hp = String(v.hypervisorPlatform || 'unknown');
  const hpxOn = hp === 'enabled' || (hp === 'unknown' && v.winHvApi && v.hypervisorPresent);
  if (hpxOn) {
    add({
      key: 'whpx-ok',
      level: 'ok',
      title: 'Windows Hypervisor Platform is enabled',
      detail: v.hypervisorPresent
        ? 'Hypervisor is running; WHPX is available.'
        : 'Feature is enabled; if acceleration is still unavailable, restart once to start Hypervisor.',
      action: null,
    });
  } else if (edition === 'store') {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '"Hypervisor Platform" is not enabled',
      detail: 'Store edition cannot modify system features automatically. Press Win+R → enter optionalfeatures → check "Windows Hypervisor Platform" (HypervisorPlatform) and "Virtual Machine Platform" → OK → Restart.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Open "Windows Features" dialog' },
    });
  } else {
    add({
      key: 'whpx-off',
      level: 'bad',
      title: '"Hypervisor Platform" is not enabled',
      detail: 'Clicking the button below will automatically enable HypervisorPlatform + VirtualMachinePlatform (requires administrator confirmation), then restart your computer.',
      action: { kind: 'elevate', id: 'virtualization', label: 'Enable with one click (admin required)' },
    });
  }

  // ---- 3. Hardware acceleration availability ----
  if (v.accelOk) {
    add({
      key: 'accel-ok',
      level: 'ok',
      title: `Hardware acceleration available (${v.accelKind === 'aehd' ? 'AEHD' : 'WHPX'})`,
      detail: 'Launch will use hardware acceleration; configuration below is recommended based on this machine\'s GPU and RAM.',
      action: null,
    });
  } else {
    add({
      key: 'accel-off',
      level: 'warn',
      title: 'No hardware acceleration currently available',
      detail: edition === 'installer' && v.vtFirmware !== false
        ? 'You can install the AEHD driver (requires admin) or enable "Hypervisor Platform" and restart; otherwise software simulation will be used.'
        : 'Software simulation will be used to ensure launch; speed is 5-10x slower than hardware acceleration.',
      action: edition === 'installer' && v.vtFirmware !== false
        ? { kind: 'elevate', id: 'accel', label: 'Install AEHD driver (requires admin)' }
        : null,
    });
  }

  // ---- 4. GPU ----
  if (!gpu.name) {
    add({
      key: 'gpu-unknown',
      level: 'warn',
      title: 'Unable to read GPU information',
      detail: 'May be Remote Desktop / VM / driver issue. Rendering backend is delegated to auto fallback chain.',
      action: null,
    });
  } else {
    const integrated = /radeon\s+(graphics|vega)|uhd|iris|hd\s+graphics|vega/i.test(gpu.name);
    const vram = gpu.vramMB
      ? `${(gpu.vramMB / 1024).toFixed(1)} GB VRAM${integrated ? ' (Integrated graphics, rest uses shared memory)' : ''}`
      : 'VRAM unknown';
    add({
      key: 'gpu-info',
      level: 'ok',
      title: `${gpu.name}`,
      detail: `${vram}${gpu.driverVersion ? ` · Driver ${gpu.driverVersion}` : ''}${gpu.driverDate ? ` (${gpu.driverDate})` : ''}`,
      action: null,
    });
    const old = /^(19|20)\d{2}-\d{2}-\d{2}$/.test(gpu.driverDate || '')
      ? (Date.now() - new Date(gpu.driverDate).getTime()) / 31536000000 : 0;
    if (old > 3) {
      add({
        key: 'gpu-driver-old',
        level: 'warn',
        title: 'GPU driver is outdated',
        detail: `Driver date ${gpu.driverDate} (~${Math.floor(old)} years ago). Old drivers commonly cause black/corrupted screen after startup; updating via manufacturer website is recommended.`,
        action: null,
      });
    }
  }

  // ---- 5. Memory / Disk / OS version ----
  const total = Number(mem.totalMB) || 0;
  if (!total) {
    add({ key: 'mem-unknown', level: 'warn', title: 'Unable to read physical memory', detail: '', action: null });
  } else if (total < 6144) {
    add({
      key: 'mem-low',
      level: 'warn',
      title: `Low memory (${(total / 1024).toFixed(1)} GB)`,
      detail: 'Android VM can only be allocated 2 GB, 2 cores with resolution reduced to 540x960; closing browser tabs before launching apps is recommended.',
      action: null,
    });
  } else {
    add({
      key: 'mem-ok',
      level: 'ok',
      title: `Physical memory ${(total / 1024).toFixed(0)} GB`,
      detail: '',
      action: null,
    });
  }

  const build = Number(hw.osBuild) || 0;
  if (build && build < 19041) {
    add({
      key: 'os-old',
      level: 'warn',
      title: `Windows version is outdated (build ${build})`,
      detail: 'ApkStart requires at least Windows 10 2004 (build 19041). Emulator may exit immediately on older OS versions.',
      action: null,
    });
  }

  // ---- Recommended Config ----
  const rec = recommendResources({ totalMB: total, cores: cpu.threads || cpu.cores, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const gpuRec = recommendGpu({ vendor: gpu.vendor, accelOk: !!v.accelOk, vramMB: gpu.vramMB });
  const patch = {
    engine: {
      autoMemory: false,
      memoryMB: rec.memoryMB,
      cores: rec.cores,
      renderSize: rec.renderSize,
      gpuMode: v.accelOk ? 'auto' : 'software',
      forceTcg: !v.accelOk,
    },
  };

  // Generate a driver for this host
  const vendor = gpu.vendor && gpu.vendor !== 'unknown' ? gpu.vendor : 'unknown';
  const driver = {
    format: 'apkstart-driver/1',
    id: `auto-${vendor}-${build || 'x'}`.toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    name: `Local Auto Config (${gpu.name || vendor})`,
    version: '1.0.0',
    author: 'ApkStart Preflight',
    description: `Generated by Local Preflight & Auto-Config: ${gpuRec.why}. ${v.accelOk ? 'Hardware acceleration available.' : 'No hardware acceleration currently.'}`,
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
    ? `Found ${bad} issue(s) that must be resolved first (${items.filter((i) => i.level === 'bad').map((i) => i.title).join(', ')})`
    : warn
      ? `Found ${warn} recommendation(s) for optimization (${items.filter((i) => i.level === 'warn').map((i) => i.title).join(', ')})`
      : 'Hardware acceleration is ready to run, configuration is optimal';

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
