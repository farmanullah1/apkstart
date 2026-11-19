'use strict';
/**
 * Assemble the "full build" bundled runtime:
 *   node build/fetch-runtime.js <output dir>
 * Produces <output dir>/runtime/:
 *   emulator/ + platform-tools/ + aehd/ + system-images/android-34/google_apis_playstore/x86_64/
 * Everything is downloaded and verified through the Provisioner's official channels, identical to the online build.
 */
const path = require('path');
const fs = require('fs');

const outRoot = path.resolve(process.argv[2] || '');
if (!outRoot) {
  console.error('usage: node build/fetch-runtime.js <output-runtime-dir>');
  process.exit(1);
}
fs.mkdirSync(outRoot, { recursive: true });

// The Provisioner takes its root from settings.runtime.dir:
// point APPDATA at a separate directory so the real user profile is left untouched
process.env.APPDATA = path.join(outRoot, '_appdata');
const store = require('../src/core/store');
store.saveSettings({ runtime: { dir: outRoot } });

const { Provisioner } = require('../src/core/provision');
const prov = new Provisioner(path.resolve(__dirname, '..'));

const log = (p) => console.log(`[${p.stage}] ${p.message} ${p.percent != null ? p.percent + '%' : ''}`);

(async () => {
  await prov.installAehd(log);
  await prov.installAdb(log);
  await prov.installEmulator(log);
  await prov.installPlayImage(log);

  const ok =
    fs.existsSync(path.join(outRoot, 'emulator', 'emulator.exe')) &&
    fs.existsSync(path.join(outRoot, 'platform-tools', 'adb.exe')) &&
    fs.existsSync(path.join(outRoot, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'));
  if (!ok) throw new Error('runtime verification failed after assembly');

  // Container-style slimming: keep only x86_64 QEMU and what headless running needs.
  // Non-x86_64 qemu-system-*.exe (~400MB), QtWebEngine, netsim and friends are useless with -no-window.
  const layers = require('../src/core/layers');
  const pruned = layers.prune(outRoot, { apply: true, aggressive: true });
  const before = layers.analyze(outRoot).total + pruned.saved;
  console.log(`slim: ${(pruned.saved / 1048576).toFixed(0)} MB removed, `
    + `${(before / 1073741824).toFixed(2)} GB -> ${(pruned.after / 1073741824).toFixed(2)} GB`);

  fs.rmSync(path.join(outRoot, '_appdata'), { recursive: true, force: true });
  fs.rmSync(path.join(outRoot, '_tmp'), { recursive: true, force: true });
  console.log('runtime-ready:', outRoot);
})().catch((e) => {
  console.error('fetch-runtime failed:', e.message);
  process.exit(1);
});
