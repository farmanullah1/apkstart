'use strict';
/**
 * Runtime slimming: delete files inside the emulator that "our launch mode will never load".
 *
 * The justification is the fixed launch parameters in emulator.js:
 *   - only x86_64 images are used (API30 AOSP)   -> qemu-system-aarch64.exe never runs
 *   - -gpu software (swiftshader software rendering) -> the vulkan / gles_angle backends never run
 *   - the UI keeps only a 38px title bar          -> the emulator's own UI translations and WebEngine panel never run
 *
 * The networking pieces netsimd / netsim / nimble_bridge must stay:
 * they carry the wifi / Bluetooth data path, and without them apps have no network -- that is the floor for "it runs".
 *
 * Usage:
 *   node build/slim-runtime.js build/runtime          # safe profile (default)
 *   node build/slim-runtime.js build/runtime --aggressive   # also remove QtWebEngine (-169MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Safe profile: delete what is genuinely never loaded (~-190MB).
 * Boundaries verified by single-item rollback (important -- do not add to this casually):
 *   - Qt6WebEngineCoreAndroidEmu.dll is a hard dependency of emulator.exe (static import); deleting it stops the emulator starting -> keep
 *   - lib64/gles_angle provides vk_swiftshader, which swiftshader rendering needs -> keep
 *   - deleting lib64/vulkan only falls back to software rendering (boots and renders fine, measured), and it is not small -> delete for 103MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'arm64 QEMU binary (only x86_64 images ever ship)'],
  // Note: emulator/lib64/vulkan cannot be deleted wholesale -- vulkan-1.dll is the loader for -gpu host and
  // without it host rendering fails outright, leaving only software rendering (must keep on an AMD 780M, measured). Delete only the big items:
  ['emulator/lib64/vulkan/layers', 'Vulkan validation layers (unused by host rendering, -20MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'shader validator tool (unused at runtime, -7MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'lavapipe software Vulkan fallback (unused with a system GPU driver, -53MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'lavapipe ICD descriptor (-1KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (an identical copy lives in gles_angle, -23MB)'],
  ['emulator/lib64/qt/translations', 'emulator UI translations (only a 38px title bar is left)'],
  // Note: emulator-check.exe must stay -- emulator -accel-check uses it to detect AEHD/WHPX;
  // without it the emulator decides "no hardware acceleration" and falls back to TCG (boot went from 42s to 10+ minutes, measured).
  ['emulator/qsn.exe', 'QEMU snapshot notification helper (no reference from emulator.exe, proven with strings, -34MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'VR panorama environment map (unused by the app, -3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR panorama decoration map (-3.5MB)'],
  ['emulator/resources/Toren1BD.obj', 'VR panorama 3D model (-3.5MB)'],
  ['emulator/resources/macroPreviews', 'macro preview images (-2.7MB)'],
  ['emulator/resources/default360.mp4', '360-degree panorama default video (-2.4MB)'],
];

/** The aggressive profile is currently empty: WebEngine is a hard dependency and gles_angle is needed for software rendering */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* ignore */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a runtime directory (emulator/emulator.exe missing)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  skipping ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  removed ${rel} (${(n / 1048576).toFixed(0)} MB) -- ${why}`);
  }
  log(`${dryRun ? 'could free' : 'freed'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Slimming target: ${root} (${aggressive ? 'aggressive' : 'safe'} profile)`);
  slim(root, { aggressive, dryRun });
}
