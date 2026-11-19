'use strict';
/**
 * Boot authorization / install verification pure Node tests (no real emulator, no network needed).
 *
 * Covers the root-cause fixes for two real failures from 0.5.3:
 *  1) Snapshot taken before "Allow USB debugging" dialog confirmed → every restore is device unauthorized →
 *     probe blindly waits 240s×4 and gets misdiagnosed as a GPU problem. Fix: recognize unauthorized,
 *     invalidate old snapshot and cold-boot, only save snapshot when healthy.
 *  2) PackageManager reports installed=true, but /data/app files were lost by snapshot/data inconsistency →
 *     am start fails. Fix: isInstalled checks each APK file actually exists.
 *
 * Run: node test/boot-auth-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  AdbClient, parseDeviceState, isUnauthorizedError, parsePmPaths,
} = require('../src/core/adb');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const adbDevices = (line) => `List of devices attached\n${line}\n`;

(async () => {
  console.log('\n[adb device state parsing]');
  test('unauthorized and authorized must be distinguishable (get-state cannot tell them apart)', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tunauthorized'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tdevice'), 'emulator-5554'), 'device');
  });
  test('offline / no permissions / no device must each report truthfully', () => {
    assert.equal(parseDeviceState(adbDevices('emulator-5554\toffline'), 'emulator-5554'), 'offline');
    assert.equal(parseDeviceState(adbDevices('emulator-5554\tno permissions'), 'emulator-5554'), 'unauthorized');
    assert.equal(parseDeviceState(adbDevices(''), 'emulator-5554'), 'no-device');
  });
  test('only recognize the status line of this serial, not disturbed by other devices', () => {
    const out = adbDevices('emulator-5556\tdevice\nemulator-5554\tunauthorized');
    assert.equal(parseDeviceState(out, 'emulator-5554'), 'unauthorized');
  });
  test('error text matching unauthorized (including official ADB_VENDOR_KEYS hint)', () => {
    assert.equal(isUnauthorizedError('error: device unauthorized.'), true);
    assert.equal(isUnauthorizedError("This adb server's $ADB_VENDOR_KEYS is not set. error: device unauthorized"), true);
    assert.equal(isUnauthorizedError('error: device offline'), false);
    assert.equal(isUnauthorizedError('error: no devices/emulators found'), false);
  });

  console.log('\n[pm path parsing + file reality verification]');
  test('pm path must parse all splits (split APK) completely', () => {
    const out = 'package:/data/app/~~x/com.foo-1/base.apk\npackage:/data/app/~~x/com.foo-1/split_arm64.apk\n';
    assert.deepEqual(parsePmPaths(out), [
      '/data/app/~~x/com.foo-1/base.apk',
      '/data/app/~~x/com.foo-1/split_arm64.apk',
    ]);
  });
  test('pm path empty output = not installed', () => {
    assert.deepEqual(parsePmPaths(''), []);
    assert.deepEqual(parsePmPaths('Error: package not found'), []);
  });

  await atest('PM says installed but APK file is gone → isInstalled returns false', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      // file verification command: file is gone, no PRESENT echoed back
      return '';
    };
    assert.equal(await c.isInstalled('com.foo'), false);
  });
  await atest('APK file truly exists → isInstalled returns true', async () => {
    const c = Object.create(AdbClient.prototype);
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) return 'package:/data/app/~~x/com.foo-1/base.apk';
      return '__APKSTART_PRESENT__';
    };
    assert.equal(await c.isInstalled('com.foo'), true);
  });
  await atest('one split missing → judged not installed (cannot launch)', async () => {
    const c = Object.create(AdbClient.prototype);
    const seen = [];
    c.shell = async (cmd) => {
      if (cmd.startsWith('pm path')) {
        return 'package:/data/app/~~x/com.foo/base.apk\npackage:/data/app/~~x/com.foo/split.apk';
      }
      seen.push(cmd);
      return ''; // both [ -s ] fail
    };
    assert.equal(await c.isInstalled('com.foo'), false);
    assert.ok(seen.some((s) => s.includes('/data/app/~~x/com.foo/split.apk')), 'verification command must cover each split');
  });

  console.log('\n[snapshot save guard]');
  await atest('adb unauthorized → do not save snapshot', async () => {
    const emu = Object.create(require('../src/core/emulator').EmulatorEngine.prototype);
    emu.port = 5554; // serial is a getter: emulator-${port}
    emu._log = [];   // log() pushes into it
    emu._adbGuestHealthy = async () => false;
    const ok = await emu._saveViaAdb('adb');
    assert.equal(ok, false, 'should not allow save when unhealthy');
  });
  await atest('source-level: snapshot save path must first pass the health guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'emulator.js'), 'utf8');
    const fn = src.slice(src.indexOf('async _saveViaAdb('), src.indexOf('async _saveViaAdb(') + 700);
    assert.ok(/_adbGuestHealthy/.test(fn), '_saveViaAdb must first judge guest health');
    const stopFn = src.slice(src.indexOf('async stop('), src.indexOf('async stop(') + 5000);
    assert.ok(/_adbGuestHealthy/.test(stopFn), 'stop() must also judge health before shutdown');
    assert.ok(/invalidateSnapshot\(\)/.test(stopFn), 'unhealthy shutdown must invalidate snapshot');
  });
  await atest('source-level: boot probe must recognize unauthorized and cold-boot self-heal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    const boot = src.slice(src.indexOf('async bootEmulator('), src.indexOf('async bootEmulator(') + 6000);
    assert.ok(/isUnauthorizedError/.test(boot), 'probe must recognize unauthorized by error text');
    assert.ok(/deviceState\(\)/.test(boot), 'probe must double-confirm by devices state');
    assert.ok(/invalidateSnapshot\(\)/.test(boot), 'authorization stuck must invalidate old snapshot');
    assert.ok(/_coldBoot = true/.test(boot), 'must force cold boot to re-inject adb public key');
    assert.ok(/ADB_UNAUTHORIZED/.test(boot), 'must give accurate diagnosis, no longer mislead as GPU problem');
  });
  await atest('adb server injects ADB_VENDOR_KEYS to align host/guest keys', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    assert.ok(/ADB_VENDOR_KEYS/.test(src), 'must explicitly specify adb public key directory');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Exception:', e.stack || e.message);
  process.exit(1);
});
