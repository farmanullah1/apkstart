'use strict';
<<<<<<< HEAD
/* ApkStart splash screen script: receives main process progress updates, controls fade out */

const api = window.apkstartSplash;
if (!api) { /* Silent exit if preload not injected */ }

const $ = (id) => document.getElementById(id);

// Version number
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// First run flag + whether components are bundled with installer
=======
/* ApkStart 开机动画脚本：接收主进程的进度更新，控制淡出 */

const api = window.apkstartSplash;
if (!api) { /* preload 未注入时静默退出 */ }

const $ = (id) => document.getElementById(id);

// 版本号
api?.version?.().then((v) => { if ($('ver')) $('ver').textContent = v || ''; }).catch(() => {});

// 首次安装标记 + 组件是否随包自带
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
Promise.all([
  api?.isFirstRun?.().catch(() => false),
  api?.bundled?.().catch(() => false),
]).then(([first, bundled]) => {
  if (!first || !$('firstRun')) return;
  $('firstRun').hidden = false;
<<<<<<< HEAD
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
=======
  // 内置运行时（完整版安装包 / 微软商店 MSIX 版）：一个字都不该提「下载」。
  // 用户抱怨的就是「装了 850MB 还在下镜像」，实际那只是把包里的压缩镜像
  // 展开到用户目录，不需要联网。
  if (bundled) {
    if ($('firstRunTitle')) $('firstRunTitle').textContent = '首次启动 · 本地准备中（无需联网）';
    if ($('firstRunList')) {
      $('firstRunList').innerHTML = [
        '<li>运行时组件已随安装包内置，不再下载任何东西</li>',
        '<li>把系统镜像展开到用户目录（约 1 分钟，只需一次）</li>',
        '<li>准备硬件加速与中文输入法</li>',
        '<li>完成后双击 APK 或桌面图标即可秒开应用</li>',
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      ].join('');
    }
  }
}).catch(() => {});

<<<<<<< HEAD
// Progress update
=======
// 进度更新
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
api?.onProgress?.((p) => {
  if (!p) return;
  if (p.percent != null && $('progressBar')) {
    $('progressBar').style.width = Math.min(100, Math.max(0, p.percent)) + '%';
  }
  if (p.message && $('status')) {
    $('status').textContent = p.message;
  }
});

<<<<<<< HEAD
// Complete → Fade out
=======
// 完成 → 淡出
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
api?.onDone?.(() => {
  const splash = $('splash');
  if (splash) {
    splash.classList.add('out');
    setTimeout(() => { api?.close?.(); }, 520);
  }
});
