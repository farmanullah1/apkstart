'use strict';
/**
 * Real boot test (skipped by default; run manually with `npm run test:boot`)
 *
 * Uses a 61MB Alpine virt ISO to walk the product's real launch parameters:
 *   create qcow2 virtual disk → boot from optical drive → confirm entry to userland via serial → graceful shutdown
 *
 * Purpose: the easiest place for the engine layer to go wrong is "parameters look right, but the real machine
 * will not start" (machine type, accel, boot order, virtio disk, ACPI shutdown). Here a real QEMU + real guest
 * nails it down. No Android image needed, no hardware acceleration needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Isolated data directory: must never write test image/disk paths into real user settings
process.env.APPDATA = path.join(os.tmpdir(), `apkstart-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'apkstart-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('Downloading Alpine virt ISO (about 61MB)...');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[real boot test]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  Skipped: QEMU not installed');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) qemu-img create disk (also verifies the product's createDisk toolchain)
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`Virtual disk ${(fs.statSync(DISK).size / 1024).toFixed(0)}KB (sparse)`);

  // 2) Use the product's real launch parameters
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`Launching: ${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} …`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) Wait for guest to enter userland (serial prompt for login means boot succeeded)
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(no serial output)';
    console.error(`  ✗ Boot failed (${elapsed}s):\n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`✓ guest entered userland (${elapsed}s)`);

  // 4) Graceful shutdown: first system_powerdown, then quit on timeout (exactly the product stop() behavior)
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('guest did not respond to ACPI shutdown, fall back to quit (product does the same)…');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`monitor exception: ${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `✓ VM closed (${graceful ? 'ACPI graceful shutdown' : 'quit fallback'})` : '✗ VM close failed');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\nResult: ${exited ? 'passed' : 'failed'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  Exception:', e.message);
  process.exit(1);
});
