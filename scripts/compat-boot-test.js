'use strict';
/* Compatibility-mode end-to-end check: boot through the product code path (API 34 Play image) -> abilist -> install an ARM APK -> launch */
process.env.ANDROID_ADB_SERVER_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5038';
const fs = require('fs');
const path = require('path');
const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');

const ROOT = path.join(__dirname, '..');
const APK = process.argv[2] || 'D:\\红果免费短剧.apk';

(async () => {
  store.saveSettings({ runtime: { compatImage: true } });
  const rt = new Runtime(ROOT);

  console.log('[1] ensure() (compatibility mode -> should boot the Google Play / API 34 image)');
  const r = await rt.ensure({
    onLog: (m) => console.log('    [boot]', m),
  });
  if (!r.ok) { console.error('    ensure failed:', r.error || JSON.stringify(r).slice(0, 300)); process.exit(1); }
  console.log('    engine =', r.engine, r.reused ? '(reusing an existing instance)' : '');

  const c = rt.client();
  console.log('[2] release =', await c.shell('getprop ro.build.version.release'));
  console.log('    sdk     =', await c.shell('getprop ro.build.version.sdk'));
  console.log('    abilist =', await c.shell('getprop ro.product.cpu.abilist'));
  console.log('    tag     =', await c.shell('getprop ro.build.tags'));

  if (APK && fs.existsSync(APK)) {
    console.log('[3] Installing the ARM APK (Hongguo Drama)...');
    const ins = await c.install(APK);
    console.log('    install =', JSON.stringify(ins).slice(0, 160));
    await c.shell('am start -n com.phoenix.read/com.dragon.read.pages.splash.SplashActivity');
    await new Promise((res) => setTimeout(res, 20000));
    const ps = await c.shell('ps -A | grep phoenix');
    console.log('[4] Process 20s after launch:', ps ? 'alive ✓' : 'gone ✗');
  } else {
    console.log('[3] Skipping the APK install (not found', APK, ')');
  }

  console.log('[5] Restoring normal-mode settings');
  store.saveSettings({ runtime: { compatImage: false } });
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
