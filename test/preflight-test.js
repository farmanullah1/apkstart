'use strict';
/**
 * System health check / auto-configuration pure logic tests: no Electron, no emulator, no real system changes.
 *
 * Guards two things:
 *   1. Conclusions must match plain language (BIOS not on -> say BIOS; Store version cannot elevate -> only give entry);
 *   2. Auto-configuration only writes "safe" settings, and the generated driver must pass driver validation.
 *
 * Run: node test/preflight-test.js
 */
const assert = require('assert/strict');
const path = require('path');

const preflight = require('../src/core/preflight');
const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n    ${e.message}`); }
}

const hwBase = () => ({
  platform: 'win32',
  arch: 'x64',
  osBuild: 22631,
  cpu: {
    name: 'AMD Ryzen 7 7840HS', cores: 8, threads: 16,
    vtSupported: true, vtFirmware: true, slat: true,
  },
  memory: { totalMB: 32768, freeMB: 8192 },
  gpu: {
    name: 'AMD Radeon 780M', vendor: 'amd', vramMB: 2048,
    driverVersion: '31.0.12027.9001', driverDate: '2024-05-01', status: 'OK',
  },
  virtualization: {
    hypervisorPresent: true,
    hypervisorPlatform: 'enabled',
    vmPlatform: 'enabled',
    hyperV: 'disabled',
    winHvApi: true,
    vmCompute: true,
    aehdInstalled: false,
    accelOk: true,
    accelKind: 'whpx',
  },
});

const clone = (o) => JSON.parse(JSON.stringify(o));

(() => {
  console.log('\n[checkup - resource recommendation]');

  test('32GB / 16 threads: give 8GB + 4 cores', () => {
    const r = preflight.recommendResources({ totalMB: 32768, cores: 16, accelOk: true, vramMB: 2048 });
    assert.equal(r.memoryMB, 8192);
    assert.equal(r.cores, 4);
    assert.equal(r.renderSize, 'auto');
  });

  test('8GB / 4 threads: give 3GB + 2 cores, and not more than half the host', () => {
    const r = preflight.recommendResources({ totalMB: 8192, cores: 4, accelOk: true, vramMB: 1024 });
    assert.equal(r.memoryMB, 3072);
    assert.equal(r.cores, 2);
    assert.ok(r.memoryMB <= 8192 / 2);
  });

  test('4GB memory only gives 2GB, will not squeeze Windows', () => {
    const r = preflight.recommendResources({ totalMB: 4096, cores: 4, accelOk: false, vramMB: 256 });
    assert.equal(r.memoryMB, 2048);
    assert.equal(r.renderSize, '540x960', 'no acceleration should drop resolution');
  });

  test('no acceleration -> 540p; small video memory also -> 540p', () => {
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: false, vramMB: 4096 }).renderSize, '540x960');
    assert.equal(preflight.recommendResources({ totalMB: 16384, cores: 8, accelOk: true, vramMB: 256 }).renderSize, '540x960');
  });

  console.log('\n[checkup - rendering backend recommendation]');

  test('no acceleration always software (first guarantee screen can appear)', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: false, vramMB: 8192 }).gpuMode, 'software');
  });

  test('NVIDIA + acceleration -> host; AMD/Intel -> swangle', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'nvidia', accelOk: true, vramMB: 8192 }).gpuMode, 'host');
    assert.equal(preflight.recommendGpu({ vendor: 'amd', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
    assert.equal(preflight.recommendGpu({ vendor: 'intel', accelOk: true, vramMB: 2048 }).gpuMode, 'swangle');
  });

  test('when GPU model cannot be read, do not guess randomly, hand back auto', () => {
    assert.equal(preflight.recommendGpu({ vendor: 'unknown', accelOk: true, vramMB: 0 }).gpuMode, 'auto');
  });

  console.log('\n[checkup - scenario judgment]');

  test('everything normal: level=good, recommend host or swangle, do not force TCG', () => {
    const r = preflight.evaluate({ hw: hwBase(), settings: {} });
    assert.equal(r.level, 'good', r.summary);
    assert.equal(r.patch.engine.forceTcg, false);
    assert.equal(r.patch.engine.gpuMode, 'auto');
    assert.equal(r.recommended.gpuMode, 'swangle');
  });

  test('BIOS virtualization not on: judge bad, only give "go into BIOS" manual guidance, do not pretend one-click', () => {
    const hw = hwBase();
    hw.cpu.vtFirmware = false;
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'bad');
    const item = r.items.find((i) => i.key === 'vt-bios-off');
    assert.ok(item, 'missing BIOS prompt');
    assert.equal(item.action.kind, 'manual');
    assert.equal(r.patch.engine.forceTcg, true, 'BIOS off should lock software emulation');
  });

  test('CPU does not support virtualization: explain only software emulation possible, do not give BIOS-on guidance', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = false;
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'vt-unsupported'));
    assert.ok(!r.items.some((i) => i.key === 'vt-bios-off'));
  });

  test('Windows features not enabled + install edition: give "Enable with one click (admin required)"', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.ok(item);
    assert.equal(item.action.kind, 'elevate');
    assert.equal(item.action.id, 'virtualization');
    assert.ok(/Enable with one click/.test(item.action.label));
    assert.ok(/admin required/.test(item.action.label));
  });

  test('Store edition cannot elevate on its own: the same problem only opens "Windows Features" window', () => {
    const hw = hwBase();
    hw.virtualization.hypervisorPlatform = 'disabled';
    hw.virtualization.accelOk = false;
    const r = preflight.evaluate({ hw, edition: 'store' });
    const item = r.items.find((i) => i.key === 'whpx-off');
    assert.equal(item.action.kind, 'elevate');
    assert.ok(/Open "Windows Features"/.test(item.action.label), item.action.label);
    assert.ok(!/Enable with one click/.test(item.action.label));
  });

  test('no acceleration + install edition: additionally provide "Install AEHD" entry', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.hypervisorPlatform = 'disabled';
    const r = preflight.evaluate({ hw, edition: 'installer' });
    const accel = r.items.find((i) => i.key === 'accel-off');
    assert.equal(accel.action.id, 'accel');
  });

  test('when Hyper-V takes over VT, WMI reporting false must not misjudge "unsupported"', () => {
    const hw = hwBase();
    hw.cpu.vtSupported = 'unknown';
    hw.cpu.vtFirmware = true;
    hw.cpu.slat = 'unknown';
    hw.virtualization.accelOk = true;
    const r = preflight.evaluate({ hw });
    assert.equal(r.level, 'good', r.summary);
    assert.ok(!r.items.some((i) => i.key === 'vt-unsupported'));
  });

  test('video memory unreadable / GPU unknown: give warn but not fatal conclusion', () => {
    const hw = hwBase();
    hw.gpu = { name: '', vendor: 'unknown', vramMB: 0, driverVersion: '', driverDate: '', status: '' };
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-unknown'));
    assert.equal(r.level, 'warn');
  });

  test('driver too old reminds to update (common cause of black screen)', () => {
    const hw = hwBase();
    hw.gpu.driverDate = '2019-03-01';
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'gpu-driver-old'));
  });

  test('low memory / too old system both individually prompt', () => {
    const hw = hwBase();
    hw.memory.totalMB = 4096;
    hw.osBuild = 18363;
    const r = preflight.evaluate({ hw });
    assert.ok(r.items.some((i) => i.key === 'mem-low'));
    assert.ok(r.items.some((i) => i.key === 'os-old'));
  });

  console.log('\n[checkup - auto-configuration boundary]');

  test('auto-configuration only writes safe settings (will not touch data partition / resolution mode etc.)', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    assert.deepEqual(Object.keys(r.patch.engine).sort(),
      ['autoMemory', 'cores', 'forceTcg', 'gpuMode', 'memoryMB', 'renderSize'].sort());
  });

  test('auto-generated driver passes validation, and match binds this machine', () => {
    const r = preflight.evaluate({ hw: hwBase() });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.deepEqual(v.driver.match.gpuVendor, ['amd']);
    assert.equal(v.driver.effect.gpuMode, 'swangle');
    assert.equal(v.driver.effect.forceTcg, null, 'with acceleration should not write forceTcg');
  });

  test('generated driver with no acceleration locks software emulation', () => {
    const hw = hwBase();
    hw.virtualization.accelOk = false;
    hw.virtualization.accelKind = 'none';
    const r = preflight.evaluate({ hw });
    const v = drivers.validateDriver(r.driver);
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.equal(v.driver.effect.forceTcg, true);
    assert.equal(v.driver.effect.gpuMode, 'software');
  });

  test('detection failure still gives a conclusion (unknown != crash)', () => {
    const r = preflight.evaluate({ hw: { platform: 'win32' } });
    assert.ok(['warn', 'bad'].includes(r.level));
    assert.ok(r.items.length >= 3);
    assert.equal(typeof r.summary, 'string');
  });

  test('collect() is async (does not block UI)', () => {
    assert.equal(preflight.collect.constructor.name, 'AsyncFunction');
  });

  test('evaluate is a pure function: same input must give same configuration', () => {
    const a = preflight.evaluate({ hw: {}, settings: {} });
    const b = preflight.evaluate({ hw: {}, settings: {} });
    assert.deepEqual(a.patch, b.patch);
    assert.deepEqual(a.driver, b.driver);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
