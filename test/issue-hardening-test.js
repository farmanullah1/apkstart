'use strict';
/**
 * Issue feedback hardening pure Node tests (no emulator / network / registry needed).
 *
 * Covers 5 items landed after summarizing GitHub issues this round:
 *  - #2 P0-1: APK package name not validated → arbitrary path write / adb command injection
 *  - #2 P0-4: provision/updater decompression without zip-slip protection
 *  - #2 P1-1: _fetchText after over-limit never settles the Promise
 *  - #51: installer version one-click uninstall misjudged as portable (uninstaller naming inconsistency in two places)
 *  - #98: portable version update download does not restart → infinite loop (copy verification false positive + payload deleted)
 *
 * Run: node test/issue-hardening-test.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { validPackageName, safeFilePart } = require('../src/core/pkgname');
const { resolveZipEntry } = require('../src/core/zip');
const store = require('../src/core/store');
const { findUninstaller, Updater } = require('../src/core/updater');
const { Provisioner } = require('../src/core/provision');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-hardening-'));

(async () => {
  console.log('\n[issue #2 P0-1 · package name validation]');
  test('legal Android package names pass', () => {
    for (const p of ['com.github.tvbox.osc', 'com.tencent.mm', 'org.example.app_2']) {
      assert.equal(validPackageName(p), true, `${p} should be legal`);
    }
  });
  test('path traversal / drive letter / shell metacharacters / spaces all rejected', () => {
    for (const p of ['../evil', 'com..x', '.com.x', 'com/x', 'com\\x', 'C:evil', 'a;rm -rf', 'a|b',
      'a b', 'a$(id)', 'a`id`', '', 'com.x.', '1com.x', 'com.x-y']) {
      assert.equal(validPackageName(p), false, `${JSON.stringify(p)} should be rejected`);
    }
  });
  test('illegal package name rewritten to a safe filename', () => {
    const safe = safeFilePart('../evil');
    assert.ok(!safe.includes('/') && !safe.includes('\\') && !safe.includes('..'), `after rewrite must have no path characters: ${safe}`);
    assert.equal(safeFilePart('com.ok.pkg'), 'com.ok.pkg');
  });
  test('store icon/APK paths cannot escape the data directory', () => {
    const icon = store.iconPath('../../Windows/System32/drivers/etc/hosts');
    const apk = store.apkPath('../../evil', '../../x');
    assert.ok(!icon.includes('..'), `icon path should not contain ..: ${icon}`);
    assert.ok(!apk.includes('..'), `APK path should not contain ..: ${apk}`);
    assert.match(path.basename(apk), /\.apk$/);
  });

  console.log('\n[issue #2 P0-4 · zip-slip]');
  test('normal relative paths are allowed', () => {
    const root = path.join(TMP, 'zip-ok');
    assert.equal(resolveZipEntry(root, 'emulator/qemu.exe'), path.join(root, 'emulator', 'qemu.exe'));
    assert.equal(resolveZipEntry(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
  });
  test('../ / absolute path / drive letter / backslash traversal / UNC all rejected', () => {
    const root = path.join(TMP, 'zip-root');
    for (const n of ['../evil', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/Windows/x',
      'a\\..\\..\\evil', '\\\\server\\share\\x', 'a/../b']) {
      assert.equal(resolveZipEntry(root, n), null, `${JSON.stringify(n)} should be rejected`);
    }
  });
  test('provision and updater source both have zip-slip guard attached', () => {
    const prov = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    const upd = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'updater.js'), 'utf8');
    assert.ok(/resolveZipEntry\(/.test(prov), 'provision.extractZip must validate entry name');
    assert.ok(/resolveZipEntry\(/.test(upd), 'updater._extract must validate entry name');
  });

  console.log('\n[issue #2 P1-1 · _fetchText no longer hangs]');
  await atest('when over limit, Promise can settle, no longer never settles', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(64 * 1024) });
      res.end(Buffer.alloc(64 * 1024, 0x61));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/index.xml`;
    try {
      const p = new Provisioner({});
      const out = await Promise.race([
        p._fetchText(url, 1024),
        new Promise((_, rej) => setTimeout(() => rej(new Error('_fetchText hung, did not settle')), 5000)),
      ]);
      assert.equal(out, '', 'over-limit content must be discarded, not treated as complete halfway');
    } finally {
      srv.close();
    }
  });
  test('_fetchText source contains a one-time settle gate and hard timeout', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'provision.js'), 'utf8');
    assert.ok(/let done = false/.test(src) && /const finish = \(\) =>/.test(src), 'must have a one-time settle gate');
    assert.ok(/setTimeout/.test(src), 'must have a hard timeout fallback');
  });

  console.log('\n[issue #51 · uninstaller recognition]');
  test('electron-builder Uninstall X.exe recognized as installer version', () => {
    const dir = path.join(TMP, 'uninst-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert.equal(findUninstaller(dir), 'Uninstall ApkStart.exe');
  });
  test('old-style uninstaller.exe also recognized', () => {
    const dir = path.join(TMP, 'uninst-b');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'uninstaller.exe'), 'x');
    assert.equal(findUninstaller(dir), 'uninstaller.exe');
  });
  test('portable version (no uninstaller) returns null', () => {
    const dir = path.join(TMP, 'uninst-c');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(findUninstaller(dir), null);
  });

  console.log('\n[issue #98 · update not-restart infinite loop]');
  await atest('ready payload can be found and resumed; version mismatch / missing exe makes it unusable', async () => {
    const dataDir = path.join(TMP, 'upd-resume');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'x');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });

    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new');
    assert.equal(u.findResumableJob(), null, 'no ready marker should not be reused');
    u._markPayloadReady(payload, '0.5.4');
    const job = u.findResumableJob();
    assert.ok(job && job.version === '0.5.4', 'should recover the 0.5.4 resume task');

    // version older than current → do not reuse
    const cur = new Updater({ currentVersion: '0.5.4', exePath: exe, isPackaged: true, dataDir });
    assert.equal(cur.findResumableJob(), null, 'payload not >= current version cannot be resumed');
    // marker version mismatch → do not reuse
    fs.writeFileSync(u._readyFile(payload), JSON.stringify({ version: '0.5.2' }));
    assert.equal(u.findResumableJob(), null, 'marker version mismatch cannot be reused');
  });
  test('apply script validates replacement by byte count, keeps failed payload, and has dual-path restart', () => {
    const dataDir = path.join(TMP, 'upd-apply');
    const exe = path.join(dataDir, 'ApkStart.exe');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(exe, 'old');
    const u = new Updater({ currentVersion: '0.5.3', exePath: exe, isPackaged: true, dataDir });
    const payload = path.join(dataDir, 'update', '0.5.4', 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new-version-bytes');
    const script = u.apply({ mode: 'zip', payload, version: '0.5.4' }, { spawn: false });
    assert.ok(/\\(Get-Item \$target\)\\.Length -eq \$expected/.test(script), 'must validate new exe by byte count');
    assert.ok(/keeping payload for next launch/.test(script), 'copy failure must keep payload for resume');
    assert.ok(/Start-Process -FilePath/.test(script) && /cmd\.exe/.test(script), 'restart must have a fallback path');
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('  Exception:', e.stack || e.message);
  process.exit(1);
});
