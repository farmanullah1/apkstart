'use strict';
/**
<<<<<<< HEAD
 * Install / launch / uninstall orchestration layer
 * Pipes "parse APK → install into runtime → persist local metadata → generate Desktop shortcut" into one pipeline.
=======
 * 安装 / 启动 / 卸载 编排层
 * 把「解析 APK → 安装进运行时 → 落本地元数据 → 生成桌面快捷方式」串成一条流水线。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName, shortcutExt } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

<<<<<<< HEAD
/** APK only has ARM native libraries (as do the vast majority of domestic apps) */
=======
/** APK 只有 ARM 原生库（国产 App 绝大多数如此） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
<<<<<<< HEAD
 * Split install packages (.apks / .xapk): unpack the split APKs inside into a pure-ASCII temp directory.
 * Uses the file-mode ZIP reader + streaming fall-disk: split packages are often 2GB+, and reading the whole package into memory will fail.
 * Returns { meta, files, cleanup }; meta comes from the base APK that carries the AndroidManifest.
=======
 * 当前「正在运行的」安卓是否具备 ARM 转译能力。
 * 关键：镜像文件在不在磁盘上（playImageInfo().ok）与当前这台模拟器有没有开翻译层是两回事。
 * 复用旧版本 / 旧快照拉起的模拟器时，Play 镜像明明在，abilist 里却没有 arm —— 这时候装
 * ARM-only 应用必然 INSTALL_FAILED_NO_MATCHING_ABIS。返回 null 表示探测不到，交给安装失败
 * 后的重试兜底，绝不因为「探测不到」就挡住安装。
 */
async function runningHasArm(client) {
  try {
    const out = String(await client.shell('getprop ro.product.cpu.abilist', { timeout: 6000 }).catch(() => ''));
    if (!out.trim()) return null;
    return /arm/i.test(out);
  } catch (_) {
    return null;
  }
}

/**
 * 拆分安装包（.apks / .xapk）：解出里面的分片 APK 到纯 ASCII 临时目录。
 * 用文件版 ZIP 读取器 + 流式落盘：拆分包动辄 2GB+，整包读内存会失败。
 * 返回 { meta, files, cleanup }；meta 来自带 AndroidManifest 的 base APK。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
<<<<<<< HEAD
    if (!apkNames.length) throw new Error('No APK split found in this install package (possibly not .apks/.xapk)');
=======
    if (!apkNames.length) throw new Error('这个安装包里没有找到 APK 分片（可能不是 .apks/.xapk）');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
<<<<<<< HEAD
      // A single split can also be several hundred MB: stream the decompression, do not go through a Buffer
=======
      // 单个分片也可能是几百 MB：流式解压，不经过 Buffer
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
<<<<<<< HEAD
             try { meta = parseApk(f); break; } catch (_) { /* no manifest in this split */ }
    }
    if (!meta) throw new Error('Split package base APK parse failed');
=======
      try { meta = parseApk(f); break; } catch (_) { /* 分片里没有清单 */ }
    }
    if (!meta) throw new Error('拆分包的 base APK 解析失败');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}${shortcutExt()}`);
  }

<<<<<<< HEAD
     /**
    * Two copies: Desktop + Start menu.
    * Windows Search indexes the .lnk under "Start menu \ Programs"; putting it only on the Desktop would make it unfindable;
    * on some machines the Desktop is redirected by OneDrive, so the Start menu copy also guarantees the entry is not lost.
    *
    * On Linux (FydeOS) the equivalent is a freedesktop .desktop:
    * one on the Desktop, one in the application menu at ~/.local/share/applications.
    */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Keep shortcuts in their own subdirectory: Windows search still indexes it, and it never overwrites a third-party app's shortcut with the same name
      // (a real case: "Hongguo Free Drama" was already taken by another desktop helper)
=======
  /**
   * 桌面 + 开始菜单两份。
   * Windows 搜索索引的是「开始菜单 \ 程序」里的 .lnk，只放桌面会搜不到；
   * 有些机器的桌面被 OneDrive 重定向，开始菜单这份也保证入口不丢。
   *
   * Linux（FydeOS）那边对应的是 freedesktop 的 .desktop：
   * 桌面一份，应用菜单 ~/.local/share/applications 一份。
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // 放在独立子目录：既能被 Windows 搜索索引到，又不会覆盖同名第三方应用的快捷方式
      // （实测「红果免费短剧」在开始菜单里已被另一个桌面助手占用）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}${shortcutExt()}`));
    }
    return [...new Set(out)];
  }

<<<<<<< HEAD
  /** The compatibility image is downloaded on demand the first time an ARM app appears, and is shared as a read-only base layer (downloaded once) */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'First ARM app: downloading the compatibility image (~1.5GB, one time only)...' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Compatibility image download failed; check your network and retry');
    return true;
  }

  /** Switching images requires a runtime restart; afterwards installed apps are reinstalled from the local APK backups */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Switching to the compatibility image and restarting the runtime...' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Wait for the old device to disappear from the adb list so ensure() does not treat it as reusable
=======
  /** 兼容镜像按「首次遇到 ARM 应用」按需下载，作为共享只读基础层只下一次 */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: '首次安装 ARM 应用：正在下载兼容镜像（约 1.5GB，只需一次）…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('兼容镜像下载失败，请检查网络后重试');
    return true;
  }

  /** 切换镜像必须重启运行时；重启后把已装应用从本地 APK 备份重新灌回去 */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: '正在切换到兼容镜像并重启运行时…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // 等旧设备从 adb 列表里消失，避免被 ensure() 当成可复用实例
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
<<<<<<< HEAD
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable after switching to the compatibility image');
=======
    // 关键：必须作废旧快照。快照里存着「无翻译层」时的内存与磁盘状态，
    // 不清掉，ensure() 会直接从快照恢复 —— 镜像换了翻译层却根本没生效，
    // 于是重装还是 NO_MATCHING_ABIS，用户看到「切换了还是不行」。
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || '切换兼容镜像后运行时不可用');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
<<<<<<< HEAD
        onProgress({ stage: 'runtime', message: `Restoring installed app ${app.label}...` });
      } catch (_) { /* a single app failing to restore must not block the rest */ }
=======
        onProgress({ stage: 'runtime', message: `正在恢复已装应用 ${app.label}…` });
      } catch (_) { /* 单个应用恢复失败不阻塞 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
<<<<<<< HEAD
    onProgress({ stage: 'parse', message: 'Parsing APK...' });
=======
    onProgress({ stage: 'parse', message: '正在解析 APK…' });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
<<<<<<< HEAD
      message: `Detected ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // 50GB games: check the emulator data partition's free space up front instead of failing halfway
    // with INSTALL_INSUFFICIENT_STORAGE (which users experience as "it installed for ages and then failed").
=======
      message: `已识别 ${meta.label}（${meta.package}）`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    // 50GB 级游戏：先核对模拟器数据盘剩余空间，而不是装到一半才报
    // INSTALL_INSUFFICIENT_STORAGE（用户看到的是「装了很久然后失败」）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    try {
      const backend = this.runtime && this.runtime.backend;
      if (backend && typeof backend.checkDiskFor === 'function') {
        let bytes = 0;
        if (bundle && bundle.files) {
          for (const f of bundle.files) {
<<<<<<< HEAD
            try { bytes += fs.statSync(f).size; } catch (_) { /* skip temp files */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* fall back to 0 */ }
=======
            try { bytes += fs.statSync(f).size; } catch (_) { /* 忽略临时文件 */ }
          }
        } else {
          try { bytes = fs.statSync(filePath).size; } catch (_) { /* 用 0 兜底 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        }
        const verdict = backend.checkDiskFor(bytes);
        if (!verdict.ok) {
          onProgress({ stage: 'error', message: verdict.message });
          const err = new Error(verdict.message);
          err.needsSetup = 'disk';
          throw err;
        }
      }
    } catch (e) {
      if (e && e.needsSetup === 'disk') throw e;
<<<<<<< HEAD
      // A failed size probe must not block the install
    }

    try {
      // Zero config: apps with only ARM libraries automatically get an image with the ARM translation layer; no toggle needed
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Preparing the Android runtime...' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime unavailable');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
=======
      // 容量探测失败不能挡住安装
    }

    try {
      onProgress({ stage: 'runtime', message: '正在准备安卓运行时…' });
      let rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || '运行时不可用');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }

      // 零配置 ARM 兼容：先看「当前这台运行时」有没有翻译能力，而不是看镜像文件在不在磁盘上。
      // 复用了旧版本/旧快照拉起、没开翻译层的模拟器时，playImageInfo().ok 也是 true，
      // 光靠它会漏掉，于是装到一半才报 NO_MATCHING_ABIS。这里提前切一次，省掉那段白等。
      if (isArmOnly(meta) && await runningHasArm(rt.client) === false) {
        onProgress({ stage: 'runtime', message: '这个应用只有 ARM 库，正在切换到兼容镜像…' });
        await this.ensureCompatImage(onProgress);
        rt = await this.switchToCompat(onProgress);
      }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

<<<<<<< HEAD
  /** Install the app itself + persist metadata + create the shortcut; on failure retry once with auto-repair */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // After installing, the old quickboot snapshot's disk state is stale; keeping it would make "the app I installed vanishes after a restart"
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Updating app...' : 'Installing app...' });
=======
  /** 安装本体 + 落盘元数据 + 快捷方式；失败时带一次自动修复重试 */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // 装完之后旧 quickboot 快照里的磁盘状态就过期了，留着会导致「装好的应用重启后又不见了」
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? '正在更新应用…' : '正在安装应用…' });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
<<<<<<< HEAD
      // An ABI mismatch reported at this point means the current runtime is an AOSP image; switch to the compatibility image and install again
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Switched to the compatibility image; reinstalling...' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
=======
      // 到了这一步报 ABI 不匹配，就是「当前这台运行时没有 ARM 翻译层」的铁证 —— 不需要
      // 再去猜 playImageInfo()。以前用 `!playImageInfo().ok` 当开关，镜像文件明明在磁盘上
      // 却复用了无翻译的旧模拟器时，重试被跳过、直接抛错，可界面还照旧显示
      // 「正在自动切换兼容镜像后重试」，于是出现「红色安装失败 + 文案说正在重试」的怪事。
      // 现在无条件切一次：错误本身就是重试理由。
      if (e.code === 'NO_MATCHING_ABIS') {
        onProgress({ stage: 'runtime', message: '这个应用只有 ARM 库，正在切换到兼容镜像后重装…' });
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: '已切换兼容镜像，正在重新安装…' });
        try {
          if (bundle) await rt2.client.installMultiple(bundle.files);
          else await rt2.client.install(filePath);
        } catch (e2) {
          // 已经切到兼容镜像仍失败：这次必须说实话，别再说「正在重试」。
          const raw2 = (e2 && e2.message) || String(e2 || '');
          const err = new Error(
            `已切换到 Android 14 兼容镜像并重启运行时，但 ${meta.label} 仍然安装失败（${raw2}）。`
            + '请检查磁盘空间与网络后重试；若一直失败，到「设置 → 诊断与修复」导出诊断报告反馈。',
          );
          err.code = e2 && e2.code ? e2.code : 'NO_MATCHING_ABIS';
          err.abiRetried = true;
          throw err;
        }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      } else {
        throw e;
      }
    }
    this.runtime.touch();

<<<<<<< HEAD
    // Write the icon to disk. Many APK icons are WebP, which nativeImage cannot decode, so decoding is left to the renderer plus
    // a branded placeholder fallback, guaranteeing the .lnk always has an icon (icoPath used to be null).
    // iconFallback records "the real icon could not be decoded, a placeholder was used" - surface that as a soft warning,
    // otherwise the desktop shows a generic green triangle and users think ApkStart picked the wrong icon.
=======
    // 图标落盘。APK 图标大量是 WebP，nativeImage 解不了，交给渲染进程解码 +
    // 品牌占位图兜底，保证 .lnk 一定带图标（之前 icoPath 一直是 null）。
    // iconFallback 记录「真实图标解不出来、用了占位图」——这种要作为软警告告诉用户，
    // 否则桌面上只有一片绿色三角，用户会以为是 ApkStart 弄错了图标。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
<<<<<<< HEAD
      } catch (_) { /* an icon failure must not block the install */ }
    }

    // Back up the APK so the app can be reinstalled or recovered later
=======
      } catch (_) { /* 图标失败不影响安装 */ }
    }

    // 备份 APK，便于日后重装/找回
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

<<<<<<< HEAD
    // Launch entry comes from the system's own resolution: the "main Activity" parsed from the APK is often not
    // the real LAUNCHER entry, and starting it skips the app's initialization screen and crashes.
=======
    // 启动入口以系统解析结果为准：APK 里解析到的「主 Activity」经常不是
    // 真正的 LAUNCHER 入口，直接用它启动会跳过应用的初始化页导致闪退。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
<<<<<<< HEAD
    } catch (_) { /* keep the APK-parsed result */ }
=======
    } catch (_) { /* 保留 APK 解析结果 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
<<<<<<< HEAD
      // The app's natural orientation (computed offline from the APK manifest):
      // decides which orientation the emulator's physical panel uses; matching orientations fill the window with no black bars.
      // If the user set orientationOverride manually, theirs wins; this is only the default.
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
      // A reinstall may reset the permission table, so drop the "already granted" cache and re-check on the next launch
=======
      // 应用天然的横竖屏（离线从 APK 清单算出来）：
      // 决定模拟器物理面板用哪个方向，方向一致画面才能铺满窗口不留黑边。
      // 用户手动设过 orientationOverride 时以用户的为准，这里只是「默认值」。
      orientation: meta.orientation || (existing ? existing.orientation || null : null),
      pinned: existing ? !!existing.pinned : false,
      // 重新装过 = 权限表可能被重置，清掉「已授过」缓存，下次启动重新核一遍
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      permGranted: false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
<<<<<<< HEAD
      onProgress({ stage: 'shortcut', message: 'Creating desktop shortcut...' });
=======
      onProgress({ stage: 'shortcut', message: '正在创建桌面快捷方式…' });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
<<<<<<< HEAD
        onProgress({ stage: 'shortcut-warn', message: `Shortcut creation failed: ${e.message}` });
      }
    }

    // Compatibility warning: with only ARM native libraries an x86 runtime needs the translation layer
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`This app requires Android ${meta.minSdk}+, newer than the current runtime; it may not run correctly.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('The app icon could not be parsed (possibly an unusual adaptive icon format); the shortcut uses a placeholder icon for now.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('The app icon (WebP) failed to decode; the shortcut uses a placeholder icon for now.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Installing invalidated the old snapshot, so schedule one here: persist the "new app installed" state while idle,
    // otherwise the next boot has to cold-start again (20+ seconds).
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} installed`, app });
=======
        onProgress({ stage: 'shortcut-warn', message: `快捷方式创建失败：${e.message}` });
      }
    }

    // 兼容性提示：只有 ARM 原生库时，x86 运行时需要转译层
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`此应用要求 Android ${meta.minSdk}+，高于当前运行时，可能无法正常运行。`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('应用图标无法解析（可能是特殊格式的自适应图标），快捷方式暂时使用占位图标。');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('应用图标（WebP）解码失败，快捷方式暂时使用占位图标。');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // 装应用时作废了旧快照，这里补排一次：空闲时把「已装好新应用」的状态存下来，
    // 否则下次开机要重新冷启动（20 多秒）。
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `${app.label} 安装完成`, app });
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
<<<<<<< HEAD
    // Linux .desktop files only accept absolute PNG/SVG paths, ICO is invalid - so pass both paths down and let
    // writeShortcut pick per platform (ICO on Windows, PNG on FydeOS).
=======
    // Linux 的 .desktop 只认 PNG/SVG 绝对路径，ICO 无效 —— 所以两条路径都传下去，
    // 由 writeShortcut 按平台挑。（Windows 用 ico，FydeOS 用 png）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const png = app.iconPath && fs.existsSync(app.iconPath) ? app.iconPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      iconPngPath: png,
<<<<<<< HEAD
      description: `${app.label} - run by ApkStart`,
      cwd: this.ctx.cwd,
      // One AUMID per app: the taskbar groups by app instead of bunching everything under ApkStart
      appUserModelId: `farmanullah1.ApkStart.${app.package}`.slice(0, 128),
=======
      description: `${app.label} — 由 ApkStart 运行`,
      cwd: this.ctx.cwd,
      // 每个应用一个 AUMID：任务栏上按应用分组，不会全挤到 ApkStart 里
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

<<<<<<< HEAD
    // Every primary path failed (custom shortcut directory not writable / blocked by security software):
    // fall back to the desktop and try once more - users need an icon on the desktop to find the app.
=======
    // 主路径全失败（自定义快捷方式目录不可写 / 被安全软件拦截）：
    // 退回桌面再试一次——桌面上有图标，用户才找得到应用。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}${shortcutExt()}`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
<<<<<<< HEAD
    if (!first) throw new Error(errors.join('; ') || 'Failed to create shortcut');
    // Keep the Start menu path too, so uninstalling removes it as well
=======
    if (!first) throw new Error(errors.join('; ') || '创建快捷方式失败');
    // 开始菜单那份的路径也存下来，卸载时一起删
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

<<<<<<< HEAD
  /** Fill in missing shortcuts and icons: old versions only created the desktop one, and WebP icons did not convert back then */
  async ensureShortcuts() {
    const made = [];
    // Do not invent entries when the user turned off "create automatically after install" and this app never had any:
    // otherwise the switch cannot stop them from being recreated at startup.
=======
  /** 补全缺失的快捷方式与图标：老版本只建了桌面那份，且 WebP 图标当时没转成功 */
  async ensureShortcuts() {
    const made = [];
    // 用户明确关掉「安装后自动创建」、且这个应用本来就没有任何入口时不要擅自补，
    // 否则开关关掉了也挡不住启动时被重建。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
<<<<<<< HEAD
        } catch (_) { /* an icon rebuild failing must not block the entry */ }
=======
        } catch (_) { /* 图标补建失败不影响入口 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
<<<<<<< HEAD
        // When the icon was just rebuilt, recreate even an existing .lnk so the shortcut picks up the real app icon
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* a single failure must not block startup */ }
=======
        // 图标刚补出来时，即使 .lnk 存在也要重建，让快捷方式换上真实应用图标
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* 单个失败不阻塞启动 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {}, onAppUp = null } = {}) {
    const app = store.getApp(pkg);
<<<<<<< HEAD
    // let, not const: beforeStart may restart the runtime when "panel orientation and app orientation disagree" and
    // return a new rt (the old client died with stop). This used to be const, so hitting the restart branch threw
    // "Assignment to constant variable." and aborted the whole launch -
    // showing up as "tapping the app right after switching orientation just fails".
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime unavailable');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Resolution must change before the app starts, or wm size triggers a configuration change that recreates the just-started Activity
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`Display adaptation skipped: ${e.message}`); return null; });
      // beforeStart may return a new rt (after a runtime restart the old client is dead),
      // so everything below uses the new one. When it returns nothing, keep the old.
      if (replaced && replaced.client) rt = replaced;
    }
    // Clear the wm size / density overrides and auto-rotate settings older versions may have left in /data.
    // Those overrides persist; without clearing them every launch comes up rotated 90 degrees with black bars
    // and taps no longer line up (the reported "rotated with black bars / not filling / cannot tap Agree").
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // A network check right after a cold boot: if there is no network, say so plainly. Otherwise users only see "this app is stuck on a black screen"
    // and never suspect the VM has no network (a network page with no data is just a black block).
    // Key fix: Wi-Fi association often lags sys.boot_completed by tens of seconds, and apps fetch their home feed immediately,
    // so without a network the home page renders as a black block - that is the real cause of "stuck on black after tapping Agree and continue".
    // So wait for the network before starting the app (up to 90 seconds); better to wait a few seconds than to hand the user a black screen.
    // Look at the network first: **only wait, never restart**.
    // This used to call ensureNetwork(), which on a slow network does "stop the VM -> cold boot",
    // so the adb device vanished mid-install and the result was "the app will not open".
    // The launch path must never do anything destructive; if the wait times out, start anyway and let pages load slowly.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`VM network ready (${net.ip || ''})`);
      } else {
        // When the network never comes up, do a **non-destructive** rescue: tap the saved
        // AndroidWifi network that does not auto-connect. It restarts nothing and touches no user data, it just opens the settings page
        // and taps a saved hotspot, which is safe on the launch path.
        // On real machines "the VM never has a network" is almost always this (see emulator.repairWifi).
        onLog('The VM cannot reach Wi-Fi; trying to reconnect...');
        try {
          // Note: repairWifi lives on engine (this.runtime), not on rt.
          // rt is ensure()'s result { ok, client, engine, ... } and only carries client;
          // rt.repairWifi would be undefined, throw a TypeError and be swallowed by catch -
          // which looks like "the log says reconnecting, but a millisecond later it still has no network".
=======
    // 用 let：beforeStart 可能因为「面板方向和应用方向不一致」而重启运行时并
    // 返回一个新的 rt（旧 client 已随 stop 失效）。以前这里是 const，一旦真的
    // 走了重启分支就抛 "Assignment to constant variable."，把整个启动打断 ——
    // 表现为「切横屏/竖屏后点应用直接失败」。
    let rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || '运行时不可用');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // 分辨率要在拉起应用之前改，避免 wm size 触发配置变更把刚启动的 Activity 重建
    if (beforeStart) {
      const replaced = await beforeStart(rt).catch((e) => { onLog(`显示适配跳过：${e.message}`); return null; });
      // beforeStart 可以返回一个新的 rt（重启运行时后旧 client 已失效），
      // 后续全部用新的。不返回就继续用原来的。
      if (replaced && replaced.client) rt = replaced;
    }
    // 清掉旧版本可能残留在 /data 里的 wm size / density 覆盖与自动旋转设置。
    // 这些覆盖是持久化的，不清理的话每次启动画面都会被转 90° 躺倒、留黑边、
    // 鼠标点击也无法对应（用户反馈的「旋转黑边 / 未填满 / 点不动同意」）。
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // 冷启动时顺手做过网络体检：没网就直接说清楚。否则用户只会看到「这个应用一直黑屏」，
    // 完全想不到是虚拟机没网（联网页面拿不到数据就是一块黑底）。
    // 关键修复：Wi-Fi 关联往往比 sys.boot_completed 晚几十秒，红果一进去就拉首页数据，
    // 没网时首页渲染成整块黑底 —— 这就是「点同意并继续后一直黑屏」的真正原因。
    // 所以拉起应用前先等网络就绪（最多 90 秒），宁可多等几秒也不要给用户一块黑屏。
    // 拉起来之前先看一眼网络：**只等，不重启**。
    // 之前这里调的是 ensureNetwork()，网络慢时会「停掉虚拟机 → 冷启动」，
    // 结果 adb 设备在安装途中消失，直接变成「红果打不开」。
    // 启动路径上绝不能做这种破坏性动作，等不到就先启动，大不了页面暂时加载慢。
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      let net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`虚拟机网络就绪（${net.ip || ''}）`);
      } else {
        // 等不到网络时，做一次**非破坏性**的补救：把「已保存但不会自动连」
        // 的 AndroidWifi 点一下。它不重启虚拟机、不碰用户数据，只是拉起设置页
        // 点一条已保存的热点，所以放在启动路径上是安全的。
        // 实机上「虚拟机一直没网」绝大多数就是这个原因（见 emulator.repairWifi）。
        onLog('虚拟机连不上 Wi-Fi，正在尝试重新连接…');
        try {
          // 注意：repairWifi 挂在 engine（this.runtime）上，不在 rt 上。
          // rt 是 ensure() 的返回对象 { ok, client, engine, ... }，里面只有 client；
          // 写成 rt.repairWifi 会是 undefined，一调就抛 TypeError 被 catch 吞掉，
          // 表现就是「日志打了正在重连，但 1 毫秒后就说还是没网」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
          const fixed = await this.runtime.repairWifi().catch(() => false);
          if (fixed) {
            net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 15000 }).catch(() => null);
            if (net && net.ok) {
<<<<<<< HEAD
              onLog(`VM network restored (${net.ip || ''})`);
              // Important: persist the "network is up" state into the snapshot immediately.
              // Otherwise the next boot restores the old "no network" snapshot and spends another ten seconds reconnecting.
              // forceSnapshotSave is used because the app is about to launch and there will never be an idle moment.
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* failing to save must not block the launch */ }
            }
          }
        } catch (e) {
          // Do not swallow the exception silently: this log is the only evidence of whether the reconnect ran.
          onLog(`Automatic Wi-Fi reconnect failed: ${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('The VM network is not ready yet; starting the app anyway (network pages may load a little later)');
=======
              onLog(`虚拟机网络已恢复（${net.ip || ''}）`);
              // 关键：把「网络已连上」这个状态立刻存进快照。
              // 不存的话下次开机还是从「没网」的旧快照恢复，每次都要再花十几秒重连。
              // 用 forceSnapshotSave 是因为马上要启动应用，永远等不到「空闲」。
              try { this.runtime.forceSnapshotSave?.(3000); } catch (_) { /* 存不下不影响启动 */ }
            }
          }
        } catch (e) {
          // 不要把异常吞得无声无息：这条日志就是「重连到底跑没跑」的唯一证据。
          onLog(`自动重连 Wi-Fi 失败：${e.message}`);
        }
        if (!net || !net.ok) {
          onLog('虚拟机网络还没就绪，先启动应用（联网页面可能稍后才加载出来）');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        }
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
<<<<<<< HEAD
    // The app may not be installed in the current runtime (image rebuilt / data cleared / first run), and starting it
    // would report "Invalid packageName". Install it from the local cache first so "open the app" always works without
    // a manual install - exactly the "tap an installed app and go straight in" experience.
    // Important: use isInstalled() (pm path plus checking every APK file really exists), not
    // `pm list packages`. When the snapshot and data partition disagree PackageManager still reports installed=true,
    // but the files under /data/app were rolled back - am start then always fails. Reinstall when the file check fails.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* treat as not installed and reinstall */ }
      if (!installed) {
        onLog('App files missing (snapshot and data disagree); reinstalling from the local backup...');
        // Drop the snapshot before reinstalling, or the old snapshot's packages.xml still claims it is installed and the next run breaks again
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`Automatic install failed: ${e.message}`));
      }
    }
    // Watch for 25 seconds and require "alive for 5 consecutive seconds" before calling it a successful launch.
    // Important: "the process has not appeared yet" and "it appeared and vanished" must be distinguished. It used to fail on the first empty pidof,
    // so large apps (whose first launch takes ten-plus seconds) were force-stopped and restarted mid-load,
    // taking three attempts, which users experience as "tapping it means waiting a minute".
=======
    // 应用可能还没装进当前运行时（镜像重建 / 清过数据 / 首次），直接拉起会报
    // "Invalid packageName"。先在本地缓存里把它装上再启动，这样「点开应用」永远能进，
    // 不用先手动装一遍——这正是「点击已安装应用直接进入系统」想要的体验。
    // 关键：用 isInstalled()（pm path + 逐个核对 APK 文件真实存在）而不是
    // `pm list packages`。快照与数据分区不一致时 PackageManager 仍报 installed=true，
    // 但 /data/app 下文件已被回滚掉 —— 这时 am start 必然失败。文件校验不通过就重装。
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      let installed = false;
      try { installed = await rt.client.isInstalled(pkg); } catch (_) { /* 当作未安装，走重装 */ }
      if (!installed) {
        onLog('应用文件缺失（快照与数据不一致），正在用本地备份自动重装…');
        // 重装前作废快照：否则旧快照的 packages.xml 仍说「已装」，下次又不对
        try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
        await rt.client.install(app.apkPath).catch((e) => onLog(`自动安装失败：${e.message}`));
      }
    }
    // 观察 25 秒并要求「连续存活 5 秒」才算启动成功。
    // 关键：进程"还没起来"和"起来过又没了"必须分开看。以前一看到 pidof 为空就判失败，
    // 结果大型应用（红果这种首启要十几秒的）在加载途中就被 force-stop 重启，
    // 反复三轮才勉强起来，用户感知就是"点了要等一分钟"。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
<<<<<<< HEAD
        // Check first, then sleep: in a warm container the process usually shows up within a second,
        // so sleeping first would slow the fastest path down by a whole second.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // appeared then vanished = a real crash
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // As soon as the process appears, attach the picture (do not wait out the 4-second window).
            // Those 4 seconds confirm "it will not crash immediately", but users see "tapping did nothing";
            // showing them the app loading looks far better than hiding it for 4 seconds.
            // The callback is fire-and-forget: its failure does not affect the liveness check below.
=======
        // 先查再睡：常驻容器里热启动往往 1 秒内就能看到进程，
        // 先 sleep 1 秒等于把最快的那条路径硬生生拖慢一秒。
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // 起来过又消失 = 真的崩了
        } else {
          if (!seen && typeof onAppUp === 'function') {
            // 进程刚出现就把画面接上去（不等那 4 秒观察期）。
            // 这 4 秒是在等「确认不会马上崩」，但用户看到的是「点了没反应」；
            // 先让他看到应用在加载，观感比藏 4 秒好得多。
            // 回调是 fire-and-forget：它失败了也不影响后面的存活判定。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
            try { onAppUp(); } catch (_) { /* ignore */ }
          }
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
<<<<<<< HEAD
      return seen; // failure only when the process was never seen
    };
    try {
      // Make sure runtime permissions are granted first: the install-time -g flags may have been lost after clearing data,
      // and without permissions the app is blocked behind the system grant dialog, which users see as "tapping does nothing / will not open".
=======
      return seen; // 一直没见过进程才算失败
    };
    try {
      // 先确保运行时权限齐备：安装时的 -g 在清过数据后可能失效，
      // 缺权限时应用会被系统授权框挡住，用户看到的就是「点了没反应/打不开」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
<<<<<<< HEAD
          // With the grant dialog in front the app looks "unopenable"; grant first, then dismiss the dialog
=======
          // 授权框挡在最前面时，应用看起来就是「打不开」；先补授权再收掉弹窗
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
<<<<<<< HEAD
          // Hand a clear crash log to the caller (it may need to switch to the compatibility image); without evidence it is usually just slow and a retry is enough
=======
          // 有明确崩溃日志才交给外层（可能要切兼容镜像）；没有证据多半只是启动慢，重试即可
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
<<<<<<< HEAD
        // Lock the orientation right after the Activity starts. This lives here because the launch itself triggers
        // configuration changes (Activity recreation), and a user-rotation set before launching may be reset to 0 -
        // and at 0 the picture on a landscape panel falls over 90 degrees (reported as "it will not turn upright").
=======
        // Activity 起来后立刻把方向锁死。放在这里是因为应用启动过程本身会触发
        // 配置变更（Activity 重建），启动前设的 user-rotation 可能被系统重置回 0 ——
        // 一旦回 0，横屏面板上的画面就会躺倒 90°（用户看到的就是「转不正」）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
<<<<<<< HEAD
        if (!ok && attempt < 3) onLog(`App exited after launch (attempt ${attempt}); retrying automatically...`);
      }
      if (!ok) {
        // Last resort: an abnormal exit leaves half-initialized data that makes every later launch crash.
        // Clearing app data once and relaunching has the best success rate (users should not have to clear the cache themselves).
        onLog('The app keeps exiting; resetting app data and retrying...');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear also wipes runtime permissions, so they must be granted again or the app sticks at the system dialog
=======
        if (!ok && attempt < 3) onLog(`应用启动后退出（第 ${attempt} 次），正在自动重试…`);
      }
      if (!ok) {
        // 兜底：异常退出会留下「半初始化」的数据，导致之后每次都崩。
        // 清一次应用数据再拉起来，成功率最高（用户不必自己去设置里清缓存）。
        onLog('应用连续退出，正在重置应用数据后重试…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear 会把运行时权限一并清掉，必须重新授，否则会卡在系统授权框
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
<<<<<<< HEAD
        const err = new Error('The app exits right after launch; automatic retries and an app data reset did not help');
=======
        const err = new Error('应用启动后立即退出，已自动重试并重置应用数据仍未成功');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
<<<<<<< HEAD
        // The crash comes from the ARM translation layer: switch images, reinstall the backup APK and launch once more
        onLog('ARM translation layer crash detected; switching to the compatibility image automatically...');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* keep the existing package */ }
=======
        // 崩溃来自 ARM 翻译层：自动切镜像、重装备份 APK、再启动一次
        onLog('检测到 ARM 翻译层崩溃，正在自动切换兼容镜像…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* 保留原包 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
