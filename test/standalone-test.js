'use strict';
/**
 * Standalone operation related pure Node tests: no Electron, no emulator, no network needed.
 *
 * Guards one product bottom line (upgraded to hard constraint since 0.5.6):
 *   **ApkStart on any machine, any settings, any residual configuration only runs the built-in runtime.**
 *
 * Three things to watch specifically:
 *   1. The code has no implementation files for third-party bases (MuMu / LDPlayer / BlueStacks / WSA / FydeOS) at all;
 *   2. Even if settings.json writes mode=mumu / fydeos / attach, only builtin is obtained;
 *   3. The packaged output must not contain any third-party emulator binary or directory.
 *
 * Run: node test/standalone-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findBundled, findForbiddenSource, assertStandalone } = require('../build/guard-standalone');
const backends = require('../src/core/backends');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  OK ${name}`); }
  catch (e) { failed++; console.error(`  FAIL ${name}\n    ${e.message}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));

function tmpDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `apkstart-${name}-`));
  return d;
}
function touch(dir, rel, bytes = 8) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

// The standalone guard reports each detected vendor using that vendor's own language. The test
// expectations below are written in ASCII-only transliterations of those vendor names. If the
// guard's live reported vendor strings change, update these transliterations (or switch them back
// to the guard's actual reported strings) so the tests continue to match reality.

const VENDOR_MUMU = 'MuMu simulator';
const VENDOR_LDPLAYER = 'LDPlayer simulator';
const VENDOR_BLUESTACKS = 'Bluestacks simulator';

(() => {
  console.log('\n[standalone - only one base]');

  const store = require('../src/core/store');
  const settings = store.getSettings();

  test('default engine is the built-in runtime', () => {
    assert.equal(settings.engine.mode, 'builtin', `default mode=${settings.engine.mode}`);
  });

  test('registry has only builtin, no second base', () => {
    assert.equal(backends.REGISTRY.length, 1, `registry has ${backends.REGISTRY.length} bases`);
    assert.deepEqual(backends.describe().map((d) => d.id), ['builtin']);
  });

  test('any residual mode only creates builtin (mumu / fydeos / attach / random fill)', () => {
    for (const mode of ['mumu', 'fydeos', 'attach', 'ldplayer', 'whatever', '']) {
      const made = backends.create({
        appRoot: ROOT, settings: { engine: { mode } }, store, log: () => {},
      });
      assert.equal(made.id, 'builtin', `mode=${mode} but created ${made.id}`);
      assert.equal(made.backend.constructor.id, 'builtin', 'instance type is not BuiltinBackend');
    }
  });

  test('explicitly passing another id cannot be forced through (fallback path does not recreate third-party base)', () => {
    const made = backends.create({
      appRoot: ROOT, settings: { engine: { mode: 'builtin' } }, store, log: () => {}, id: 'mumu',
    });
    assert.equal(made.id, 'builtin', 'explicit id=mumu still accepted');
  });

  test('auto selection no longer probes any external runtime', async () => {
    // Synchronous assertion: autoPick must "directly return builtin"; source must not contain probe()
    const src = read('src', 'core', 'backends', 'index.js');
    assert(!/\\.probe\(/.test(src), 'registry still probing external emulators');
    assert(!/mumu|fydeos|ldplayer|bluestacks/i.test(src.replace(/[\s\S]*?const REGISTRY[\s\S]*?\];\s*/, '')),
      'registry still has third-party bases');
  });

  console.log('\n[standalone - third-party base code deleted]');

  test('backends/ has only base / builtin / index', () => {
    const files = fs.readdirSync(path.join(ROOT, 'src', 'core', 'backends')).sort();
    assert.deepEqual(files, ['base.js', 'builtin.js', 'index.js'], `actual: ${files.join(', ')}`);
  });

  test('mumu / fydeos / mumu-compat / frame modules are all gone', () => {
    for (const rel of [
      ['src', 'core', 'backends', 'mumu.js'],
      ['src', 'core', 'backends', 'fydeos.js'],
      ['src', 'core', 'mumu-compat.js'],
      ['src', 'core', 'frame.js'],
    ]) {
      assert.equal(exists(...rel), false, `${rel.join('/')} still exists`);
    }
  });

  test('engine has no third-party-base-unavailable-to-fallback branch', () => {
    const src = read('src', 'core', 'engine.js');
    assert(!/_fallbackFrom/.test(src), 'still has third-party base fallback marker');
    assert(!/backend\.id !== 'builtin'/.test(src), 'still has logic branching by base id');
    assert(!/engine\.mode === 'attach'/.test(src), 'still has attach (connect existing runtime) branch');
    assert(!/ATTACH_ENDPOINTS/.test(src), 'still probing external emulator adb ports');
  });

  test('settings page has no engine mode dropdown, no MuMu / FydeOS fields', () => {
    const html = read('src', 'ui', 'index.html');
    assert(!/setEngineMode/.test(html), 'settings page still has engine mode dropdown');
    assert(!/value="mumu"|value="fydeos"|value="attach"/.test(html), 'settings page still has third-party options');
    assert(!/setMumuPath|setMumuMemGB|setMumuCores|setFydeosHost/.test(html), 'settings page still has third-party fields');
    assert(/id="setEngineLabel"/.test(html), 'settings page missing read-only runtime description');
  });

  test('persistence layer overwrites residual mode / mumu* fields in place', () => {
    const src = read('src', 'core', 'store.js');
    assert(/s\.engine\.mode = 'builtin'/.test(src), 'getSettings not forcibly mode=builtin');
    assert(/mumuPath/.test(src) && /delete s\.engine\[k\]/.test(src), 'not cleaning residual third-party fields');
  });

  test('adb candidate paths do not include third-party emulator own adb', () => {
    const src = read('src', 'core', 'adb.js');
    const block = src.slice(src.indexOf('const COMMON_ADB_PATHS'), src.indexOf('];', src.indexOf('const COMMON_ADB_PATHS')));
    assert(!/mumu|ldplayer|bluestacks|hd-adb/i.test(block), 'still borrowing third-party emulator adb');
  });

  console.log('\n[standalone - no other emulator allowed in package]');

  test('guard can recognize MuMu binary', () => {
    const d = tmpDir('guard-hit');
    touch(d, 'runtime/MuMuManager.exe');
    const hits = findBundled(d);
    assert.equal(hits.length, 1, `hit count ${hits.length}`);
    assert.equal(hits[0].vendor, VENDOR_MUMU);
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('guard can recognize MuMu directories (nx_main / nx_device / nemu)', () => {
    for (const dirName of ['nx_main', 'nx_device', 'nemu']) {
      const d = tmpDir('guard-dir');
      fs.mkdirSync(path.join(d, dirName), { recursive: true });
      touch(d, path.join(dirName, 'whatever.bin'));
      assert.equal(findBundled(d).length, 1, `${dirName} not blocked`);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test('guard also recognizes LDPlayer / BlueStacks', () => {
    const d = tmpDir('guard-others');
    touch(d, 'runtime/LDPlayer.exe');
    touch(d, 'runtime/Bluestacks.exe');
    const vendors = new Set(findBundled(d).map((h) => h.vendor));
    assert.ok(vendors.has(VENDOR_LDPLAYER), 'LDPlayer not blocked');
    assert.ok(vendors.has(VENDOR_BLUESTACKS), 'BlueStacks not blocked');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('guard does not harm our own runtime', () => {
    const d = tmpDir('guard-src');
    touch(d, 'app/src/core/backends/builtin.js', 64);
    touch(d, 'app/src/core/resources.js', 64);
    assert.equal(findBundled(d).length, 0, 'our own source treated as emulator body');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('guard blocks third-party base adapter source code (prevent growing back)', () => {
    const d = tmpDir('guard-adapter');
    touch(d, 'app/src/core/backends/mumu.js', 64);
    touch(d, 'app/src/core/backends/fydeos.js', 64);
    touch(d, 'app/src/core/mumu-compat.js', 64);
    const hits = findForbiddenSource(d);
    assert.equal(hits.length, 3, `hit count ${hits.length} (should be 3)`);
    const r = assertStandalone(d, { label: 'test', exit: false });
    assert.equal(r.ok, false, 'adapter source did not make guard fail');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('guard does not treat ordinary frame.js / business js as third-party base', () => {
    const d = tmpDir('guard-other-js');
    touch(d, 'app/src/render/frame.js', 64);
    touch(d, 'app/src/core/backends/builtin.js', 64);
    assert.equal(findForbiddenSource(d).length, 0, 'frame.js / builtin.js outside core should not be misjudged');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('clean runtime directory does not error', () => {
    const d = tmpDir('guard-clean');
    touch(d, 'runtime/emulator/emulator.exe', 64);
    touch(d, 'runtime/platform-tools/adb.exe', 64);
    const r = assertStandalone(d, { label: 'test', exit: false });
    assert.equal(r.ok, true, JSON.stringify(r.hits));
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('when directory does not exist, skip check rather than crash', () => {
    const r = assertStandalone(path.join(os.tmpdir(), 'apkstart-not-exist-xyz'), { exit: false });
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
  });

  console.log('\n[standalone - build chain has guard integrated]');

  test('portable packaging scans resources', () => {
    const src = read('build', 'pack.js');
    assert(/assertStandalone\(path\.join\(OUT, 'resources'\)\)/.test(src), 'pack.js not integrated with guard');
  });

  test('MSIX packaging scans payload app/', () => {
    const src = read('build', 'msix.js');
    assert(/assertStandalone\(appDir/.test(src), 'msix.js not integrated with guard');
  });

  test('packaging only carries build/runtime (Google runtime), no other emulator directories', () => {
    const yml = read('electron-builder.yml');
    const block = yml.slice(yml.indexOf('extraResources:'));
    const head = block.slice(0, block.indexOf('win:'));
    assert(!/mumu|ldplayer|bluestacks/i.test(head), 'extraResources has third-party emulator');
    assert(/build\/runtime/.test(head), 'extraResources missing built-in runtime');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
