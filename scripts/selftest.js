'use strict';
/**
 * Runtime self-check (no UI needed)
 *
 *   npm run selftest                 # only check the existing runtime
 *   npm run selftest -- --apk a.apk  # additionally walk install → launch → screenshot → shared directory
 *
 * Purpose: after Android is installed, use one command to confirm that the chain
 * "double-click to install an app, standalone window, data sharing" really holds on the current machine,
 * and when something goes wrong, localize it to a specific stage.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Empty = take the product path: auto-launch the built-in runtime with a dynamic serial; only when specified connect to an external device
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nApkStart runtime self-check');
  console.log(`Device: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Components]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb available', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('adb not installed — run "one-click deploy" first');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator ready', async () => {
    if (!env.emulator.ok) throw new Error('runtime engine not installed — run "one-click deploy" first');
    return `v${env.emulator.version}`;
  });
  await step('System image complete', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'image missing');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('Hardware acceleration', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'auto-fallback to software emulation (runs, but noticeably slow)');

  console.log('\n[Device]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime ready', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`External device not online: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'runtime unavailable');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nDevice not ready, skipping the remaining items.');
  } else {
    await step('Android version', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('could not read the system version');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Screen resolution', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size returned nothing');
      return `${s.width}×${s.height}`;
    });
    await step('freeform detached windows', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('could not enable freeform (the system may not support multi-window)');
      return 'enabled';
    });

    console.log('\n[Shared folder]');
    await step('two-way sync', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('host -> device did not sync');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('device -> host did not sync');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'upload + download both OK';
    });

    if (APK) {
      console.log('\n[App pipeline]');
      let meta = null;
      await step('parse the APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('install on the device', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path found no package');
          return 'pm path check passed';
        });
        await step('launch in a detached window', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('the app is not in the foreground');
          return meta.package;
        });
        await step('screenshot', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('screenshot content looks wrong');
          return file;
        });
      }
    } else {
      console.log('\n[App pipeline] no --apk given, skipped');
    }
  }

  // Stop any runtime this self-test started: otherwise the emulator child's stdio pipes
  // keep the Node event loop alive and the command looks "stuck"
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Result: ${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, `
    + `${results.filter((r) => r.ok === null).length} skipped`);
  if (failed.length) {
    console.log('Failed items:');
    failed.forEach((f) => console.log(`  · ${f.name}：${f.detail}`));
    process.exit(1);
  }
  console.log('All checks passed ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nSelf-test aborted:', e.message);
  process.exit(1);
});
