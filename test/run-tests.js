'use strict';
/** Pure Node unit tests (no Electron / adb / network dependency)
 * Run: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('can parse the package.json zip structure of the project it is in', () => {
  // Verify parsing with a minimal zip (stored mode) constructed in memory
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // central directory total size
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // central directory offset

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'should be able to find hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', 'content should match');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('PNG encoder outputs legal signature and IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG signature');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'reasonable length');
});
test('app icon can be drawn at any size', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `width should be ${s}, actual ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Test fixture: prefer the APKSTART_TEST_APK env var first,
// otherwise try common local APK locations (read-only, do not copy)
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (fixture: ${fixture})`);
  test('quickCheck recognizes PK header', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('parses out package name / version / launch Activity', () => {
    assert(/^[\\w.]+$/.test(meta.package), `package name abnormal: ${meta.package}`);
    assert(meta.versionName, 'missing versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `launch Activity abnormal: ${meta.launchActivity}`);
  });
  test('parses out a usable icon', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'icon is empty or too small');
    assert(meta.label, 'app name is empty');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('AXML root node is manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc can be parsed', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'should have at least one package');
    }
  });
} else {
  console.log('  (skipped: no APK fixture found; set APKSTART_TEST_APK)');
}

// The synthetic APK constructor is in test/lib/make-apk.js: covers the parsing stack
// even when real fixtures are missing, and run-tests / auto-test share the same one
// (avoiding two separate byte-assembly copies).
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[Synthetic APK: axml + apk full chain]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('attrValue namespace semantics: passing null = no restriction, default only recognizes android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: 'Test' },
      ],
    };
    // Non-namespace attributes (like package) must pass null to retrieve; this is parseApk's key premise
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package needs ns=null');
    assert(attrValue(node, 'package') === null, 'default only recognizes android namespace');
    assert(attrValue(node, 'label') === 'Test', 'android attribute walks default namespace');
    assert(attrValue(node, 'label', null) === 'Test', 'ns=null should be able to find android attribute');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('package name: package on manifest is a non-namespace attribute', () => {
      assert(meta.package === 'com.example.test', `actual ${meta.package}`);
    });
    test('app name / version / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('launch Activity parsed from intent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('ABI directory and icon resource', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'icon should be PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'file size should be backfilled');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

{
  const { detectOrientation } = require('../src/core/apk');
  const { ANDROID_NS } = require('../src/core/axml');
  const act = (name, ori) => ({
    name: 'activity',
    attrs: [
      { ns: ANDROID_NS, name: 'name', typed: name },
      ...(ori == null ? [] : [{ ns: ANDROID_NS, name: 'screenOrientation', typed: ori }]),
    ],
  });
  test('screen orientation: statistically determine the app native orientation from Activity declarations', () => {
    // Hongguo-style "dozens of portrait + one sensor launch page" → portrait
    const hongguo = [
      act('SplashActivity', 3), act('MainActivity', 1), act('ReaderActivity', 3),
      act('WebActivity', 1), act('DetailActivity', 1),
    ];
    assert(detectOrientation(hongguo, hongguo[0]) === 'portrait', 'majority portrait declarations should judge as portrait');
    // MoreRead-style single Activity explicitly landscape
    const modu = [act('MainActivity', 2)];
    assert(detectOrientation(modu, modu[0]) === 'landscape', 'single landscape activity should judge as landscape');
    // All sensor / all unspecified → cannot judge, leave to settings
    const sensorOnly = [act('A', 3), act('B', 11), act('C', 0), act('D', 14)];
    assert(detectOrientation(sensorOnly, sensorOnly[0]) === null, 'all follow gravity should return null');
    assert(detectOrientation([act('A', null)], null) === null, 'no orientation declared should return null');
    // Launch activity weighting: it decides the first screen the user sees
    const launcherWins = [act('Launcher', 2), act('P1', 1), act('P2', 1), act('P3', 1)];
    assert(detectOrientation(launcherWins, launcherWins[0]) === 'landscape', 'launch activity orientation should be weighted');
    // reversePortrait / userLandscape etc. should also be归到 the correct side
    assert(detectOrientation([act('A', 7)], null) === 'portrait', 'reversePortrait belongs to portrait');
    assert(detectOrientation([act('A', 12)], null) === 'landscape', 'userLandscape belongs to landscape');
  });
}

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
