'use strict';
/** Zero-configuration adaptive / container-style slimming regression tests (plain Node, does not launch emulator)
 * Run: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js automatic parameters]');

  await test('GPU backend selected by emulator version (new version host priority + software rendering fallback, old version swiftshader_indirect)', () => {
    // gpuCandidates fine-tunes order per local GPU vendor (AMD puts swangle ahead),
    // so here only assert "candidate list contains key items" rather than a fixed first position.
    const c37 = doctor.gpuCandidates('37.3.8.0');
    assert(c37.includes('host'), '37.x candidates must include host');
    assert(c37.includes('swangle'), '37.x candidates must include swangle');
    assert(c37.includes('software'), 'new version must have software rendering fallback');
    // 37.x uploading swiftshader_indirect causes GL init failure; must absolutely not appear in candidates
    assert(!c37.includes('swiftshader_indirect'));
    // Old version still uses swiftshader_indirect
    const c35 = doctor.gpuCandidates('35.1.4.0');
    assert(c35.includes('host'));
    assert(c35.includes('swiftshader_indirect'));
    // detectGpuVendor should return a known value or unknown (not throw)
    const v = doctor.detectGpuVendor();
    assert(['nvidia', 'amd', 'intel', 'unknown'].includes(v), `detectGpuVendor returned unexpected value: ${v}`);
  });

  await test('low-memory machine auto-downgrades (no longer hard-coded 4GB / 4 cores)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\\\Users\\\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `memory should be 2048, actual ${p.memoryMB}`);
    assert(p.cores === 2, `cores should be 2, actual ${p.cores}`);
    assert(p.accel === 'off', 'no hardware acceleration should auto-fall back to software emulation');
    assert(p.bootTimeoutMs > 240000, 'software emulation should give longer boot timeout');
    assert(p.gpu === 'host' || p.gpu === 'swangle', `preferred render should be host or swangle (AMD machine swangle priority), actual ${p.gpu}`);
    // When accel is off, the last-resort parameters must be software rendering; otherwise under TCG no GPU is available
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'last-resort scheme must use software rendering');
    // Data partition defaults to 4/6/8GB by disk free (no longer hard-coded 16G), and can be overridden by settings
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `data partition should be 4~8GB, actual ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'data partition capacity in settings must take effect');
  });

  await test('high-memory machine does not eat memory infinitely', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `high config should also be capped: ${p.memoryMB}MB / ${p.cores} cores`);
    assert(p.accel === 'auto');
  });

  await test('retry matrix: from optimal to most conservative, includes software emulation and cold-boot fallback', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `retry count should be 3-4, actual ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'missing software emulation fallback');
    // Last rung only does "no snapshot load + minimal memory"; absolutely must not allow -wipe-data:
    // when disk is full every rung fails; with wipe it would clear the user's installed apps together (tripped in practice).
    assert(v[v.length - 1].snapshot === false, 'last rung must skip snapshot load');
    assert(v[v.length - 1].wipe === false, 'any automatic retry must not clear user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'last rung should drop to minimal memory');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'retry schemes should not repeat');
  });

  await test('image moving disks does not count as changing image: sysdir directory change should not clear user data', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'same image set path identity must be the same');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'after disk change snapshot should not be invalidated (otherwise wait a cold boot for nothing)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'truly changed image must be identifiable');
  });

  await test('snapshot fingerprint does not change with GPU/accel/memory retry (avoid clearing installed apps every retry)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\\\img2');
    assert(a === b && a !== c);
  });

  await test('log diagnosis can recognize GPU / acceleration / Chinese path / lock file issues', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('log diagnosis: emulator exiting with 0xC0000005 must be judged as rendering backend crash', () => {
    // Hands-on issue #20/#25: after printing Userspace boot properties, exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs usually also carry rendering init info: must prioritize judging crash, not GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'crash should take priority over ordinary rendering logs');
  });

  await test('idle port probe returns an even port pair', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `port abnormal: ${p}`);
  });

  await test('auto parameters shown on settings page match actual run parameters (37.x no longer shows deprecated backend)', () => {
    const common = {
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044,
      // Explicitly give host: memory/cores upper limit now follows host; without this test result drifts with CI machine specs
      // (GitHub runner only 4 cores; manually filling 6 cores is correctly converged to 3 cores, assertion would false-report)
      host: { totalMB: 32768, freeMB: 24000, cores: 12, home: 'C:\\\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false },
    };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host' || p.gpu === 'swangle', `should be host or swangle (AMD machine), actual ${p.gpu}`);
    assert(p.accelOk === true && text.includes('hardware accel'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('port 5562'), text);

    // Old engine still applies old backend; user manually filled advanced parameters still take effect
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js container-style slimming]');

  await test('inventory reclaimable items: non-x86_64 QEMU, old images, old AVDs, lock files, old snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'should list non-x86_64 QEMU');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'must not delete x86_64 QEMU');
    assert(paths.some((p) => p.includes('android-30')), 'should list old API30 image');
    assert(paths.some((p) => p.endsWith('.lock')), 'should list lock files');
    assert(paths.some((p) => p.includes('snapshots')), 'should list old snapshots');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'should list non-active AVD');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'must not delete active AVD config');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun should not delete any files');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'actual cleanup should release space');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'non-active AVD should be cleared');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'active AVD must be retained');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU must be retained');
  });

  console.log('\n[adb.js install/launch failure readability]');

  await test('Android 14 old targetSdk app failure has clear guidance', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('automatically'), s);
  });

  await test('ARM translation layer crash can give an executable English conclusion', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM translation layer') && s.includes('compatibility image'), s);
  });

  console.log('\n[sharer no longer shuttles back and forth (the culprit of full disk)]');

  await test('the same file is not pulled back from the device every round', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Use real path/state file, but point directory to temp directory
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Round 1: local new file → push up
    const firstPull = calls.pull;
    await sh.sync();          // Round 2
    await sh.sync();          // Round 3
    await sh.sync();          // Round 4
    assert(calls.push === 1, `should push only once, actual ${calls.push}`);
    assert(firstPull === 0, `file just pushed up should not be immediately pulled back, actual pull ${firstPull} times`);
    assert(calls.pull === firstPull, `subsequent rounds should not repeatedly pull, actual cumulative ${calls.pull} times`);
  });

  await test('super-large files are not pulled back to the local machine (local directory is not the device cache drain)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'files over 512MB should not be pulled back to local machine');
  });

  console.log('\n[adb/sharer file sharing]');

  await test('ls -l parsing is compatible with Android group / date format', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `should parse 3 lines, actual ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('remote file list can be fetched fully with find+stat at once (does not depend on ls date parsing)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `should return 2 files, actual ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js large package streaming decompression]');

  await test('ZipFile and ZipArchive parse results are consistent for the same zip (includes deflate and streaming pipeTo)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'entry names should match');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'stored entry content should match');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'deflate entry content should match');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo streaming output should be complete');
    } finally {
      file.close();
    }
  });
