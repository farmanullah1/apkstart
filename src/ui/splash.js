'use strict';
/* ApkStart splash screen script: receives main process progress updates, controls fade out */

const api = window.apkstartSplash;
if (!api) { /* Silent exit if preload not injected */ }

const $ = (id) => document.getElementById(id);

// Version number
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// First run flag + whether components are bundled with installer
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
  // Bundled runtime (Full installer / Microsoft Store MSIX): do not mention "download".
  // Extracting the bundled compressed image to user directory does not require internet.
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = 'First Launch · Preparing locally (offline)';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>Runtime components are bundled, no downloads required</li>',
        '<li>Extracting system image to user directory (~1 min, one-time)</li>',
        '<li>Preparing hardware acceleration and input methods</li>',
        '<li>Launch apps instantly by double-clicking APKs or shortcuts</li>',
      ].join('');
    }
  }
}).catch(() => {});

// Progress update
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

// Complete → Fade out
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
