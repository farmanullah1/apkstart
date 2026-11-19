'use strict';
/**
 * Resource allocation (memory / CPU / storage) pure Node tests: no Electron, no emulator needed.
 *
 * The value of this layer is "filling wrong does not cause trouble": no matter how randomly the user
 * fills 32GB of memory or a 128GB partition, before saving everything must be converged to a range the
 * host can actually give; otherwise the manifestation is a boot black screen or a failure halfway
 * through installation, and the user cannot figure out what went wrong.
 *
 * Run: node test/resources-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  hostProfile, memoryLimits, clampMemoryMB, clampCores, memVerdict,
  diskRequiredMB, diskVerdict, diskLimits, clampDataGB, storageVerdict,
} = require('../src/core/resources');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n    ${e.message}`); }
}

const GB = 1024 * 1024 * 1024;

(() => {
  console.log('\n[resource allocation - host capability]');

  test('hostProfile accepts injected values (test environment does not touch real machine)', () => {
    const h = hostProfile({ totalMB: 32768, cores: 16 });
    assert.equal(h.totalMB, 32768);
    assert.equal(h.cores, 16);
  });

  test('hostProfile with no values given does not return 0 cores or NaN', () => {
    const h = hostProfile({});
    assert.ok(h.cores >= 1);
    assert.ok(Number.isFinite(h.totalMB));
  });

  test('memory upper limit leaves 25% for host', () => {
    const lim = memoryLimits(32768);
    assert.equal(lim.maxMB, 24576, `32GB host max allocates 24GB, actual ${lim.maxMB}`);
    assert.equal(lim.stepMB, 512);
    assert.equal(lim.minMB, 1024);
  });

  test('when host memory cannot be read, still give a conservative upper limit', () => {
    const lim = memoryLimits(0);
    assert.ok(lim.maxMB >= 4096 && lim.maxMB <= 16384);
  });

  console.log('\n[resource allocation - memory convergence]');

  test('0 means auto, returned as-is 0', () => {
    const r = clampMemoryMB(0, 32768);
    assert.equal(r.mb, 0);
    assert.equal(r.reason, 'auto');
  });

  test('filling 3GB aligned to 512MB steps to 3072', () => {
    const r = clampMemoryMB(3000, 32768);
    assert.equal(r.mb, 3072);
    assert.equal(r.capped, true);
  });

  test('filling 64GB pressed to host upper limit with reason given', () => {
    const r = clampMemoryMB(64 * 1024, 32768);
    assert.equal(r.mb, 24576);
    assert.equal(r.capped, true);
    assert.ok(/can allocate at most 24 GB/.test(r.reason), r.reason);
  });

  test('filling 128MB raised to minimum bootable value', () => {
    const r = clampMemoryMB(128, 32768);
    assert.equal(r.mb, 1024);
    assert.equal(r.capped, true);
  });

  test('low-memory machine (4GB) does not give 4GB all to Android', () => {
    const r = clampMemoryMB(4096, 4096);
    assert.equal(r.mb, 3072);
  });

  console.log('\n[resource allocation - CPU convergence]');

  test('16-core machine maxes at 15 cores', () => {
    assert.equal(clampCores(16, 16).cores, 15);
  });

  test('single-core machine still gives 1 core', () => {
    assert.equal(clampCores(8, 1).cores, 1);
  });

  test('0 = auto', () => {
    assert.equal(clampCores(0, 8).cores, 0);
  });

  console.log('\n[resource allocation - memory ratio prompt]');

  test('allocating too full prompts Windows paging', () => {
    const v = memVerdict(28672, 32768);
    assert.equal(v.level, 'insufficient');
    assert.ok(/paging/.test(v.note), v.note);
  });

  test('normal range does not disturb the user', () => {
    assert.equal(memVerdict(8192, 32768).level, 'ok');
    assert.equal(memVerdict(8192, 32768).note, '');
  });

  test('under 768MB judged unable to start', () => {
    assert.equal(memVerdict(512, 32768).level, 'insufficient');
  });

  console.log('\n[resource allocation - storage]');

  test('50GB game estimated at 1.8x + 2GB reserved', () => {
    const need = diskRequiredMB(50 * GB);
    assert.equal(need, Math.ceil(50 * 1024 * 1.8) + 2048);
  });

  test('data partition upper limit takes 80% of the disk it is on', () => {
    assert.equal(diskLimits(100 * 1024).maxGB, 80);
  });

  test('when only 20GB disk remains, 64GB partition not allowed', () => {
    const r = clampDataGB(64, 20 * 1024);
    assert.equal(r.gb, 16);
    assert.equal(r.capped, true);
    assert.ok(/only has 20\.0 GB/.test(r.reason), r.reason);
  });

  test('when disk is ample, 64GB partition allowed', () => {
    const r = clampDataGB(64, 200 * 1024);
    assert.equal(r.gb, 64);
    assert.equal(r.capped, false);
  });

  test('when space insufficient, storageVerdict gives how much still needed', () => {
    const v = storageVerdict(30 * 1024, 50 * GB);
    assert.equal(v.ok, false);
    assert.ok(v.shortMB > 0);
    assert.ok(/deficit/.test(v.note), v.note);
  });

  test('when disk remaining cannot be read, skip pre-check rather than blocking', () => {
    assert.equal(storageVerdict(0, 50 * GB).ok, true);
  });

  console.log('\n[resource allocation - disk pre-check]');

  test('diskVerdict allows when space is sufficient', () => {
    const v = diskVerdict(200 * 1024, 100 * 1024);
    assert.equal(v.ok, true);
    assert.equal(v.message, '');
  });

  test('diskVerdict when space insufficient gives how much deficit (prompts the disk holding the runtime)', () => {
    const v = diskVerdict(10 * 1024, 60 * 1024);
    assert.equal(v.ok, false);
    assert.ok(/Insufficient disk space/.test(v.message), v.message);
    assert.ok(/disk holding the ApkStart runtime/.test(v.message), v.message);
  });

  test('diskVerdict does not block when remaining space cannot be read', () => {
    assert.equal(diskVerdict(0, 60 * 1024).ok, true);
  });

  test('50GB-class install package pre-check space estimated at 1.8x + 2GB', () => {
    const need = diskRequiredMB(50 * GB);
    assert.ok(need > 85 * 1024 && need < 95 * 1024, `needs ${need} MB`);
  });

  console.log('\n[resource allocation - wiring check]');

  const builtinSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'backends', 'builtin.js'), 'utf8');
  test('built-in base also provides resources()', () => {
    assert(/resources\(\) \{/.test(builtinSrc), 'builtin missing resources()');
  });

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  test('main process converges out-of-bounds values and exposes resource overview', () => {
    assert(/sanitizeResourcePatch/.test(mainSrc), 'saving settings does not converge resource values');
    assert(/engine:resources/.test(mainSrc), 'missing engine:resources IPC');
    assert(/runtime:resetAndResize/.test(mainSrc), 'missing reset+rebuild-at-new-capacity channel');
    assert(!/mumuMemoryGB|mumuCores/.test(mainSrc), 'main process still has residual third-party base memory convergence logic');
  });

  const emulatorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
  test('quickboot differential disk blocking in-place expansion reports error truthfully, not fake success', () => {
    assert(/_hasDataOverlay/.test(emulatorSrc), 'qcow2 differential disk not detected');
    assert(/needsReset: true/.test(emulatorSrc), 'expansion failure not marked needsReset');
    assert(/fsGB/.test(emulatorSrc), 'dataInfo not exposing actual filesystem size');
  });

  const doctorSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
  test('auto-tier memory/cores upper limit follows host, no longer hard-coded 8GB/8 cores', () => {
    assert(/memoryLimits\(host\.totalMB\)/.test(doctorSrc), 'doctor not converging memory by host');
    assert(!/1536, 8192/.test(doctorSrc), 'doctor still hard-coding 8192 upper limit');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
