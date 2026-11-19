'use strict';
/**
 * Drivers (compatibility patches) extension pure Node tests: no Electron, no emulator, no network needed.
 *
 * This guards the bottom line that "no matter how wild the JSON the user writes, it can only change parameters
 * in the whitelist, cannot execute code on this machine, cannot delete data", plus matching / stacking /
 * import-export behavior.
 *
 * Run: node test/drivers-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const drivers = require('../src/core/drivers');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-drv-${name}-`));
}

const HOST = {
  platform: 'win32',
  arch: 'x64',
  totalMB: 16384,
  cores: 8,
  gpuVendor: 'amd',
  gpuName: 'AMD Radeon 780M',
  cpuVendor: 'amd',
  osBuild: 22631,
  accel: 'whpx',
  emulatorVersion: '36.4.9',
};

const base = () => ({
  format: drivers.DRIVER_FORMAT,
  id: 'test-driver',
  name: 'Test driver',
  version: '1.0.0',
  match: { any: true },
  effect: { gpuMode: 'swangle' },
});

(() => {
  console.log('\n[drivers · validation]');

  test('all built-in examples pass validation (otherwise users copying them get it wrong)', () => {
    const dir = path.join(ROOT, 'src', 'drivers');
    const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    assert.ok(files.length >= 3, `only ${files.length} built-in examples`);
    for (const f of files) {
      const r = drivers.validateDriver(readJSON(path.join(dir, f)), { file: f });
      assert.equal(r.ok, true, `${f}: ${r.errors.join('; ')}`);
    }
  });

  test('wrong format is directly rejected', () => {
    const d = { ...base(), format: 'something-else' };
    const r = drivers.validateDriver(d);
    assert.equal(r.ok, false);
    assert.ok(/format/.test(r.errors.join('')));
  });

  test('id containing path traversal / spaces is rejected (id is used as filename on import)', () => {
    for (const id of ['../evil', 'a b', 'x', 'name/../../etc/passwd']) {
      const r = drivers.validateDriver({ ...base(), id });
      assert.equal(r.ok, false, `id=${id} somehow passed`);
    }
  });

  test('wrong key name in match reports error, instead of silently not taking effect', () => {
    const r = drivers.validateDriver({ ...base(), match: { gpu: 'amd' } });
    assert.equal(r.ok, false);
    assert.ok(/match\.gpu/.test(r.errors.join('')));
  });

  test('wrong field in effect reports error', () => {
    const r = drivers.validateDriver({ ...base(), effect: { gpu: 'swangle' } });
    assert.equal(r.ok, false);
    assert.ok(/effect\.gpu/.test(r.errors.join('')));
  });

  console.log('\n[drivers · whitelist (must not delete data / must not execute code)]');

  test('rejects -wipe-data (it would erase user apps and saves)', () => {
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } });
    assert.equal(r.ok, false);
    assert.ok(/does not allow -wipe-data/.test(r.errors.join('')), r.errors.join('; '));
  });

  test('rejects -partition-size / -datadir / -sysdir', () => {
    for (const a of ['-partition-size=8192', '-datadir=D:/x', '-sysdir=D:/y']) {
      const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: [a] } });
      assert.equal(r.ok, false, `${a} somehow passed`);
    }
  });

  test('-gpu only accepts known backends', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=host'] } }).ok, true);
    const r = drivers.validateDriver({ ...base(), effect: { emulatorArgs: ['-gpu=../evil'] } });
    assert.equal(r.ok, false);
  });

  test('config.ini only allows whitelist keys (changing data partition / location is not allowed)', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle' } } }).ok, true);
    for (const k of ['disk.dataPartition.size', 'image.sysdir.1', 'hw.ramSize', 'hw.cpu.arch']) {
      const r = drivers.validateDriver({ ...base(), effect: { configIni: { [k]: '1' } } });
      assert.equal(r.ok, false, `${k} somehow passed`);
    }
  });

  test('config.ini / env values must not contain newlines (prevent injecting new lines)', () => {
    const a = drivers.validateDriver({ ...base(), effect: { configIni: { 'hw.gpu.mode': 'swangle\nhw.ramSize=99999' } } });
    assert.equal(a.ok, false);
    const b = drivers.validateDriver({ ...base(), effect: { env: { ANDROID_X: 'a\nb' } } });
    assert.equal(b.ok, false);
  });

  test('env only allows ANDROID_/QEMU_/LIBGL_/MESA_/EMUGL_ prefixes', () => {
    assert.equal(drivers.validateDriver({ ...base(), effect: { env: { ANDROID_EMU_BACKEND: 'x' } } }).ok, true);
    for (const k of ['PATH', 'SystemRoot', 'NODE_OPTIONS', 'LD_PRELOAD']) {
      const r = drivers.validateDriver({ ...base(), effect: { env: { [k]: 'x' } } });
      assert.equal(r.ok, false, `${k} somehow passed`);
    }
  });

  test('driver module contains no eval / new Function / dynamic require of user files', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'drivers.js'), 'utf8');
    assert(!/\beval\s*\(/.test(src), 'found eval');
    assert(!/new\s+Function\s*\(/.test(src), 'found new Function');
    assert(!/require\s*\(\s*(raw|d\.|driver)/.test(src), 'found require based on driver content');
  });

  console.log('\n[drivers · matching]');

  test('gpuVendor match / no match', () => {
    assert.equal(drivers.matchHost({ gpuVendor: ['amd'] }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuVendor: ['nvidia'] }, HOST).ok, false);
  });

  test('gpuName uses regex (case-insensitive)', () => {
    assert.equal(drivers.matchHost({ gpuName: 'radeon\\s+780m' }, HOST).ok, true);
    assert.equal(drivers.matchHost({ gpuName: 'geforce' }, HOST).ok, false);
  });

  test('memory / cores / system version match by range', () => {
    assert.equal(drivers.matchHost({ totalMB: { min: 8192 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ totalMB: { max: 8192 } }, HOST).ok, false);
    assert.equal(drivers.matchHost({ cores: { min: 8 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 22000 } }, HOST).ok, true);
    assert.equal(drivers.matchHost({ osBuild: { min: 30000 } }, HOST).ok, false);
  });

  test('emulator version compared numerically, not as string (36.4.9 < 36.4.10)', () => {
    const host = { ...HOST, emulatorVersion: '36.4.9' };
    assert.equal(drivers.matchHost({ emulatorVersion: { max: '36.4.10' } }, host).ok, true);
    assert.equal(drivers.matchHost({ emulatorVersion: { min: '36.4.10' } }, host).ok, false);
  });

  test('accel matching: machines without hardware acceleration only take tcg patches', () => {
    const noHv = { ...HOST, accel: 'none' };
    assert.equal(drivers.matchHost({ accel: ['none'] }, noHv).ok, true);
    assert.equal(drivers.matchHost({ accel: ['none'] }, HOST).ok, false);
  });

  test('empty match / no match does not "default to matching"', () => {
    assert.equal(drivers.matchHost({}, HOST).ok, false);
    assert.equal(drivers.matchHost(null, HOST).ok, false);
  });

  console.log('\n[drivers · stacking and switch]');

  test('built-in examples do not take effect by default (enabled:false); only take effect when user opens in UI', () => {
    const d = { ...drivers.validateDriver(readJSON(path.join(ROOT, 'src', 'drivers', 'example-amd-igpu-swangle.json'))).driver };
    const off = drivers.resolve({ drivers: [d], host: HOST });
    assert.equal(off.applied.length, 0, 'built-in example took effect by default');
    const on = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: true } });
    assert.equal(on.applied.length, 1);
    assert.equal(on.effect.gpuMode, 'swangle');
  });

  test('state=false can override enabled:true in file', () => {
    const d = drivers.validateDriver({ ...base(), enabled: true }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST, state: { [d.id]: false } });
    assert.equal(r.applied.length, 0);
  });

  test('larger priority applies later (overrides earlier gpuMode / same-name parameters)', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', priority: 0, effect: { gpuMode: 'software', emulatorArgs: ['-gpu=software'] } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', priority: 10, effect: { gpuMode: 'swangle', emulatorArgs: ['-gpu=swangle'] } }).driver;
    const r = drivers.resolve({ drivers: [b, a], host: HOST });
    assert.equal(r.effect.gpuMode, 'swangle');
    const gpus = r.effect.args.filter((x) => x.flag === '-gpu');
    assert.equal(gpus.length, 1, '-gpu stacked twice');
    assert.equal(gpus[0].value, 'swangle');
  });

  test('ini / env are merged rather than overwriting each other\'s whole object', () => {
    const a = drivers.validateDriver({ ...base(), id: 'aaa', effect: { configIni: { 'hw.gpu.mode': 'swangle' }, env: { ANDROID_AA: '1' } } }).driver;
    const b = drivers.validateDriver({ ...base(), id: 'bbb', effect: { configIni: { 'hw.keyboard': 'no' }, env: { ANDROID_BB: '2' } } }).driver;
    const r = drivers.resolve({ drivers: [a, b], host: HOST });
    assert.deepEqual(r.effect.ini, { 'hw.gpu.mode': 'swangle', 'hw.keyboard': 'no' });
    assert.deepEqual(r.effect.env, { ANDROID_AA: '1', ANDROID_BB: '2' });
  });

  test('notes carry the driver name so the UI can explain who made the change', () => {
    const d = drivers.validateDriver({ ...base(), name: 'Old GPU patch', effect: { notes: ['Turn off hardware rendering'] } }).driver;
    const r = drivers.resolve({ drivers: [d], host: HOST });
    assert.deepEqual(r.effect.notes, ['Old GPU patch: Turn off hardware rendering']);
  });

  console.log('\n[drivers · read disk / import / export]');

  test('bad file only records error, does not affect other drivers in the same directory', () => {
    const dir = tmpDir('load');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(base()));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 1);
    assert.equal(r.errors.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('files over 256KB are not read as drivers', () => {
    const dir = tmpDir('big');
    fs.writeFileSync(path.join(dir, 'big.json'), `{\"pad\":\"${'x'.repeat(300 * 1024)}\"}`);
    const r = drivers.loadDir(dir);
    assert.equal(r.drivers.length, 0);
    assert.ok(/File is too large/.test(JSON.stringify(r.errors)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('import: after validation passes, saved as <id>.json (filename not from user input)', () => {
    const src = tmpDir('src');
    const dst = tmpDir('dst');
    const f = path.join(src, 'whatever.json');
    fs.writeFileSync(f, JSON.stringify(base()));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(path.basename(r.file), 'test-driver.json');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('import: validation failure does not write to disk', () => {
    const src = tmpDir('src2');
    const dst = tmpDir('dst2');
    const f = path.join(src, 'bad.json');
    fs.writeFileSync(f, JSON.stringify({ ...base(), effect: { emulatorArgs: ['-wipe-data'] } }));
    const r = drivers.importDriver(f, dst);
    assert.equal(r.ok, false);
    assert.equal(fs.readdirSync(dst).length, 0, 'bad driver was written in');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });

  test('exported current-machine template itself must be a valid driver', () => {
    const tpl = drivers.templateFromHost(HOST);
    const r = drivers.validateDriver(tpl);
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.deepEqual(r.driver.match.gpuVendor, ['amd']);
  });

  console.log('\n[drivers · integrated into boot chain]');

  test('buildArgs / env / config.ini all use the driver effect', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(ROOT);
    emu._driverEffect = {
      gpuMode: 'swangle',
      forceTcg: true,
      args: [{ flag: '-feature', value: 'Vulkan' }, { flag: '-gpu', value: 'host' }],
      ini: { 'hw.gpu.mode': 'swangle', 'hw.audioInput': 'yes' },
      env: { ANDROID_EMU_TEST: '1' },
      notes: [],
    };
    const args = emu.buildArgs({ gpu: 'host', accel: 'auto', memoryMB: 4096, cores: 4 });
    const at = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(at('-gpu'), 'swangle', 'driver did not cover -gpu');
    assert.equal(at('-accel'), 'off', 'forceTcg did not become -accel off');
    assert.equal(args.filter((a) => a === '-gpu').length, 1, '-gpu appears twice (the one in driver not skipped)');
    assert.equal(at('-feature'), 'Vulkan');
    const env = emu.env(ROOT, { accel: 'off' });
    assert.equal(env.ANDROID_EMU_TEST, '1');
    const ini = emu._iniWithDrivers('hw.gpu.mode=host\nhw.keyboard=yes\n');
    assert(/hw\.gpu\.mode=swangle/.test(ini), 'ini not overwritten');
    assert(/hw\.audioInput=yes/.test(ini), 'ini new key not appended');
    assert.equal((ini.match(/hw\.gpu\.mode=/g) || []).length, 1, 'ini has duplicate key');
    emu._driverEffect = null;
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
