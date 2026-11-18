const fs = require('fs');

// 1. src/core/assoc.js
let assoc = fs.readFileSync('src/core/assoc.js', 'utf8');
assoc = assoc.replace(' * .apk 文件关联（仅写 HKCU，不需要管理员权限）\n * 双击 apk → apkstart.exe "%1" → 自动安装 → 自动建桌面快捷方式',
  ' * .apk file association (writes HKCU only, no administrator rights needed)\n * Double-click apk -> apkstart.exe "%1" -> auto-install -> auto-create desktop shortcut');
assoc = assoc.replace('// 关联前的「原默认程序」记在这里，卸载时原样还回去，别把用户的关联弄丢',
  '// Record original default handler before association so it can be restored on uninstall without breaking user settings');
assoc = assoc.replace('/** 读某个键的默认值（REG_SZ），读不到返回空串 */',
  '/** Reads default value (REG_SZ) of a registry key; returns empty string if not found */');
assoc = assoc.replace('/** 读我们记下的「关联前默认值」 */',
  '/** Reads saved pre-association default handler */');
assoc = assoc.replace('/* 通知失败不影响关联本身 */',
  '/* notification failure does not affect the association itself */');
assoc = assoc.replace('// 记住关联前 .apk 的默认程序：用户本来装了别的安卓工具时，卸载 ApkStart\n  // 之后应该还给他，而不是把 .apk 变成「没有默认程序」。',
  '// Remember the original .apk handler before association: if the user already had another Android tool,\n  // it should be restored upon uninstall rather than leaving .apk with no default handler.');
assoc = assoc.replace('/* 本来就没有 */', '/* did not exist initially */');
assoc = assoc.replace("'Android 应用包'", "'Android Application Package'");
assoc = assoc.replace("'Android 应用包'", "'Android Application Package'");
assoc = assoc.replace("'安装到 ApkStart'", "'Install with ApkStart'");
assoc = assoc.replace(/\/\*\*[\s\S]*?取消关联[\s\S]*?\*\//,
  '/**\n * Unregisters association.\n * Restores previous default if recorded; clears only if pointing to us; leaves untouched if another handler is active.\n */');
fs.writeFileSync('src/core/assoc.js', assoc, 'utf8');

// 2. src/core/android.js
let android = fs.readFileSync('src/core/android.js', 'utf8');
android = android.replace(/\/\*\*[\s\S]*?安卓系统设置[\s\S]*?\*\//,
  '/**\n * Android system settings: bridges common toggles directly into the ApkStart settings page via adb.\n * All commands utilize official shell interfaces without root dependency.\n */');
android = android.replace(/\/\*\*[\s\S]*?媒体流（STREAM_MUSIC = 3）[\s\S]*?\*\//,
  '/**\n * Volume command for media stream (STREAM_MUSIC = 3). Replaces deprecated `media` command with `cmd media_session volume` on Android 11+.\n */');
android = android.replace('/** 解析 `volume --get` 的输出，例如 `volume is 5 in range [0..15]` */',
  '/** Parses `volume --get` output, e.g. `volume is 5 in range [0..15]` */');
android = android.replace('/** 档位换算成界面用的百分比 */',
  '/** Converts volume level to UI percentage */');
android = android.replace("throw new Error(rt.error || '运行时未就绪');",
  "throw new Error(rt.error || 'Runtime not ready');");
android = android.replace('/** 读一批当前状态，供设置页显示 */',
  '/** Reads current states for the settings page */');
android = android.replace(/\/\*\*[\s\S]*?音量：界面给的是 0~100 的百分比[\s\S]*?\*\//,
  '/**\n   * Volume: Converts UI percentage (0-100) to device media stream step range (commonly 0-15).\n   */');
android = android.replace('/** 关闭系统动画 = 明显的「变快」体感，且几乎不损失功能 */',
  '/** Disabling system animations yields noticeably faster UI feel without losing functionality */');
android = android.replace('/** 显示大小：改 dpi，越大内容越大（相当于系统「显示大小」档位） */',
  '/** Display size: modifies dpi (higher value scales content up, matching system display size) */');
android = android.replace('/** 一键整理：关动画 + 关遥测类服务 + 电池白名单，让应用更跟手 */',
  '/** One-click optimization: disables animations, background telemetry, and whitelists battery */');
android = android.replace('/** 应用运行时权限一览 + 授权 */',
  '/** Inspects and grants app runtime permissions */');
fs.writeFileSync('src/core/android.js', android, 'utf8');

// 3. src/core/apk.js
let apk = fs.readFileSync('src/core/apk.js', 'utf8');
apk = apk.replace(/\/\*\*[\s\S]*?APK 元信息提取[\s\S]*?\*\//,
  '/**\n * APK metadata extraction: package / version / label / launch activity / icon / ABI.\n * Fully offline, no aapt or adb required.\n */');
apk = apk.replace('// 兜底：在 res/ 里找最大的、名字像图标的位图（png / webp / jpg 都认）',
  '// Fallback: finds largest icon-like bitmap in res/ (supports png / webp / jpg)');
apk = apk.replace(/\/\/ ---- 屏幕方向 ----[\s\S]*?被算成「方向未定」。/,
  '// ---- Screen Orientation ----\n// Maps explicit screenOrientation values. Non-locked sensor modes follow gravity and are skipped.');
apk = apk.replace(/\/\*\*[\s\S]*?判断一个应用「天然」是竖屏还是横屏[\s\S]*?\*\//,
  '/**\n * Detects whether an app naturally runs in portrait or landscape.\n * Pre-calculating this prevents letterboxing caused by mismatches between emulator hw.lcd and app orientation.\n * @returns {\'portrait\'|\'landscape\'|null} null = follows sensor / unspecified, deferred to user settings\n */');
apk = apk.replace('/** 取节点上的 drawable / src 引用，还原成 APK 内的文件路径 */',
  '/** Resolves drawable / src references into APK internal file paths */');
apk = apk.replace(/\/\*\*[\s\S]*?在图标 XML 的节点树里找可用位图[\s\S]*?\*\//,
  '/**\n * Finds usable bitmap in icon XML trees (depth-first search up to 3 levels for adaptive-icon/layer-list).\n */');
apk = apk.replace('/** 从自适应图标 / layer-list 的 XML 里找出可用的前景/背景位图 */',
  '/** Finds usable foreground/background bitmap from adaptive-icon or layer-list XML */');
apk = apk.replace('// 先按规范顺序找 foreground → background → monochrome',
  '// Search in standard priority: foreground -> background -> monochrome');
apk = apk.replace('// 再整棵树扫一遍（layer-list / bitmap / inset 这类没有固定子节点名的）',
  '// Scan full tree for layer-list / bitmap / inset');
apk = apk.replace(/\/\*\*[\s\S]*?解析一个 APK 的元信息[\s\S]*?\*\//,
  '/**\n * Parses APK metadata using file-backed ZIP streaming without buffering the entire APK into memory.\n */');
apk = apk.replace("throw new Error('文件过小，不是有效的 APK');",
  "throw new Error('File too small to be a valid APK');");
apk = apk.replace('/** parseApk 的主体：调用方负责关闭 zip */',
  '/** Main implementation of parseApk; caller is responsible for closing the zip */');
apk = apk.replace("throw new Error('缺少 AndroidManifest.xml：这不是单个 APK（可能是 .apks/.xapk 拆分包）');",
  "throw new Error('Missing AndroidManifest.xml: not a standalone APK (may be a split .apks/.xapk bundle)');");
apk = apk.replace(/\/\/ package 是 manifest 上的\*\*非命名空间\*\*属性[\s\S]*?传 null 表示不限定命名空间。/,
  '// package is a non-namespaced attribute on manifest; pass null to accept any namespace');
apk = apk.replace("if (!packageName) throw new Error('清单中未找到 package 名');",
  "if (!packageName) throw new Error('Package name not found in manifest');");
apk = apk.replace(/\/\/ package 会一路流到路径拼接和 adb shell[\s\S]*?在这里就拦下（issue #2 P0-1）。/,
  '// Validates package name against injection attacks and malformed paths');
apk = apk.replace('throw new Error(`清单中的 package 名不合法：${JSON.stringify(String(packageName).slice(0, 80))}`);',
  'throw new Error(`Invalid package name in manifest: ${JSON.stringify(String(packageName).slice(0, 80))}`);');
apk = apk.replace('// ---- 资源表（用于解析 @0x7f 引用）----', '// ---- Resource table (resolves @0x7f references) ----');
apk = apk.replace('// ---- 应用名 ----', '// ---- App Label ----');
apk = apk.replace('// ---- 启动 Activity ----', '// ---- Launch Activity ----');
apk = apk.replace('// ---- 屏幕方向（决定模拟器物理面板该用横屏还是竖屏，见 detectOrientation）----',
  '// ---- Screen Orientation (governs emulator physical panel orientation) ----');
apk = apk.replace('// ---- 图标 ----', '// ---- Icon ----');
apk = apk.replace('// ---- ABI（判断 x86 运行时能否直接跑 ARM 原生库）----',
  '// ---- ABI (determines whether x86 runtime can run ARM native libraries) ----');
apk = apk.replace('/** 轻量校验：只看头部是不是 PK\\x03\\x04 */', '/** Lightweight check: verifies PK\\x03\\x04 header */');
fs.writeFileSync('src/core/apk.js', apk, 'utf8');

// 4. src/core/display.js
let display = fs.readFileSync('src/core/display.js', 'utf8');
display = display.replace(/\/\*\*[\s\S]*?显示适配的纯计算部分[\s\S]*?\*\//,
  '/**\n * Display calculation utilities (unit-testable, independent of Electron/adb).\n *  - Fullscreen: matches workspace dimensions;\n *  - Windowed: preserves portrait preset with auto-scaling.\n */');
display = display.replace(/\/\*\*[\s\S]*?全屏 = 铺满屏幕高度并水平居中[\s\S]*?\*\//,
  '/**\n * Fullscreen calculation: centers horizontally while matching full screen height.\n */');
display = display.replace(/\/\*\*[\s\S]*?Android 侧分辨率：两种模式都保持竖屏预设[\s\S]*?\*\//,
  '/**\n * Android resolution: both modes maintain portrait preset to avoid aspect distortion.\n */');
fs.writeFileSync('src/core/display.js', display, 'utf8');

console.log('Batch 1 translated cleanly');
