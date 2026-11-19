// Probe entry: minimal Electron init, then hand over to ../embed-probe.js
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const LOG = path.join(__dirname, '..', '..', '..', '.probe', 'boot.txt');
function mark(m) { try { fs.appendFileSync(LOG, m + ' ' + new Date().toISOString() + '\n'); } catch (_) {} }
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, ''); } catch (_) {}
mark('module-loaded');

// Child processes run this file too (--type=renderer/gpu/...), so they never take part in the main flow
if (process.argv.some((a) => a.startsWith('--type='))) {
  module.exports = {};
} else {
  process.on('uncaughtException', (e) => { mark('UNCAUGHT ' + (e && e.stack || e)); });

  mark('before-whenReady');
  app.whenReady().then(async () => {
    mark('ready');
    try {
      const { run } = require('../embed-probe.js');
      await run(path.join(__dirname, '..', '..'));
      mark('done');
      app.exit(0);
    } catch (e) {
      mark('ERR ' + (e && e.stack || e));
      app.exit(1);
    }
  });
  app.on('window-all-closed', () => {});
}
