'use strict';
/**
<<<<<<< HEAD
 * Local persistence: app catalog + settings
 * Data directory: %APPDATA%\apkstart (see STORE_BUILD explanation below for MSIX/Store edition)
=======
 * 本地持久化：应用清单 + 设置
 * 数据目录：%APPDATA%\apkstart（MSIX/商店版见下面的 STORE_BUILD 说明）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilePart } = require('./pkgname');

/**
<<<<<<< HEAD
 * Is this a Microsoft Store (MSIX / APPX) packaged build?
 *
 * Full-trust MSIX apps redirect writes under `%APPDATA%` / `%LOCALAPPDATA%`
 * to `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`,
 * but environment variables and APIs still return the pre-redirected real paths.
 * This leads to two categories of issues:
 *   1. emulator/adb/qemu spawned from %APPDATA%\apkstart without package identity
 *      will see "file not found" when looking for real paths;
 *   2. User clicking "Open Data Directory" sees an empty directory.
 * Therefore, Store builds place data directories outside AppData (%USERPROFILE%\ApkStart),
 * completely bypassing virtualization so parent and child processes access the same physical files.
 *
 * process.windowsStore is injected by Electron in MSIX/APPX environments (undefined in regular node).
=======
 * 是不是 Microsoft Store（MSIX / APPX）打包版？
 *
 * MSIX 的 full-trust 应用会把 `%APPDATA%` / `%LOCALAPPDATA%` 下的**写入**
 * 重定向到 `%LOCALAPPDATA%\Packages\<PackageFamilyName>\LocalCache\...`，
 * 但环境变量和 API 返回的仍然是被重定向前的「真路径」。这会造成两类事故：
 *   1. 我们从 %APPDATA%\apkstart 里 spawn 出来的 emulator/adb/qemu 若没有包身份，
 *      按真路径去找文件会「文件不存在」；
 *   2. 用户点「打开数据目录」看到的是空目录。
 * 所以商店版直接把数据目录放到 AppData **之外**（%USERPROFILE%\ApkStart），
 * 完全不进虚拟化范围，父子进程看到的是同一份真实文件。
 *
 * process.windowsStore 由 Electron 在 MSIX/APPX 环境下注入（普通 node 下是 undefined）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const STORE_BUILD = (() => {
  try { return !!require('electron').app?.isPackaged && !!process.windowsStore; } catch (_) { return false; }
})();

const DATA_DIR = STORE_BUILD
  ? path.join(os.homedir(), 'ApkStart', 'data')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  /**
<<<<<<< HEAD
   * Driver (compatibility patch) extensions: user-authored JSON patches in drivers/ under data dir.
   * Only stores user-disabled IDs here -- all enabled by default; can be disabled with one click without deleting files.
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // Only one runtime: built-in runtime (builtin). Field kept for merging legacy settings.json;
    // forced back to 'builtin' during settings read (see getSettings migration).
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = automatically decided by doctor based on machine RAM
    cores: 0,                // 0 = automatic
    autoMemory: true,        // Zero-config: automatically derive RAM/cores/disk/rendering parameters
    idleShutdownMinutes: 15,
    startVisible: true,
    // Windowed mode required: SurfaceFlinger does not emit VSYNC in headless mode;
    // emulator with window delivers native 60fps + native mouse/keyboard, ApkStart frames it as an app window.
    headless: false,
    gpuMode: 'auto',         // auto = select backend based on emulator version and fallback progressively
    // Last crash-on-start rendering backend (format: `<emulator_version>|<gpu>`); auto mode moves it to last
    // to avoid waiting 20s before falling back to software rendering on every launch. Invalidated on runtime update.
    badGpu: '',
    forceTcg: false,         // Kept for advanced troubleshooting; normal flow automatically rolled back by doctor
    audio: true,             // Android app audio (notifications/video). Disable to save slight CPU
    // ---- Lightweight container (all enabled by default to save resources, toggleable by user) ----
    liteMode: true,          // Restrict vCPU quota to prevent qemu from pegging physical cores and slowing Windows
    // Strategy preset: save / balanced / smooth (video/games prioritized).
    // Single option exposed in UI, translated to liteMode / priorityMode / renderSize upon save,
    // with fine-grained switches preserved at the bottom for advanced users.
    resourceMode: 'balanced',
    // Data partition capacity (GB): apps, game caches, and update packages are installed here.
    // 0 = auto (6/8GB based on free disk space). Expanding it performs an in-place expansion on next start without data loss.
    dataPartitionGB: 0,
    // Rendering resolution: lower resolution is smoother and saves battery; auto = 720x1280 or 540x960 based on accel
    renderSize: 'auto',
    // Network acceleration: specify public DNS for emulator. Android default 10.0.2.3 routes through host DNS,
    // which can add hundreds of ms latency on VPN / corporate networks / certain ISPs.
    fastDns: true,
    // System locale: injected via emulator -prop at startup (guest setprop is blocked by SELinux).
    // Defaults to en-US; set to zh-CN or off to return to stock image Chinese.
    locale: 'en-US',
    // Chinese IME: bundled AOSP Google Pinyin IME, silently installed and enabled at startup when needed.
    // System image only includes LatinIME (English keyboard); without this Chinese input is unavailable.
    chineseIme: false,
    chineseImeDefault: false,
    // Snapshot: quickboot RAM snapshot enables secondary boots in seconds at the cost of ~2-3GB ram.bin.
    // Can be disabled under disk pressure (only affects boot speed, not app data).
    keepSnapshot: true,
    // Log file limit (KB): rolls over once exceeded to prevent filling disk over long-term use
    logLimitKB: 2048,
    // Mouse key mappings: left click natively mapped by emulator to confirm/tap.
    // Right click back and smooth wheel require low-level hooks, only installed when app window is focused.
    mouseRightBack: true,    // Right click = Android Back (intercepts Qt default "right click as tap" misclicks)
    mouseWheelMode: 'smooth', // smooth = throttle and inject swipe | native = Qt native | off = unhandled
    mouseSideButtons: false, // Side buttons Back/Forward: disabled by default
    deepTrim: false,         // Deep trim background system packages (Play Store / setup wizard), off by default
    // balanced = yield foreground | performance = qemu Normal | game = qemu High + low latency input
    priorityMode: 'balanced',
    // Prewarm: boots Android environment in background after ApkStart starts so first app launch is instant.
    // Costs ~1GB resident RAM (same tradeoff as WSA), can be turned off anytime.
    prewarm: true,
    // Multi-window: allows opening multiple apps concurrently with independent windows. Off by default,
    // preserving single-window behavior; when enabled, uses tombstoning to recycle background apps.
    multiWindow: false,
    // Number of recent background apps kept from tombstoning in multi-window mode.
    // 0 = maximum memory savings (foreground only), default 1.
    keepBackground: 1,
    // Keymapping (keyboard -> touchscreen): enabled by default, user-configurable in settings
    keymapEnabled: true,
    // Per-app keymap table: { "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // Empty = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // Manual QEMU package URL override
    isoUrl: '',              // Manual system image URL override
    isoPath: '',             // System image (ISO) path
    diskPath: '',            // Virtual disk for installed system
    diskSizeGB: 24,
    headless: false,         // Hide VM window (debug only)
    installMode: 'guided',   // guided (guided manual install) | auto (experimental auto install)
    emulatorUrl: '',         // Manual emulator package URL (empty = auto-resolved from SDK index)
    sysimgUrl: '',           // Manual system image package URL
    compatImage: false,      // ARM compatibility mode: uses Google Play image (native bridge for ARM-only apps)
    deployFailedAt: 0,       // Timestamp of last failed auto-deploy (0 = no failure). Prevents retry within 30 min
    // Lightweight runtime bundle: downloaded from GitHub Release by default,
    // falls back to dl.google.com component downloads.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub accelerator mirror prefix (optional, e.g. https://ghfast.top/).
    // Empty = direct connection.
    mirrorPrefix: '',
    // Download concurrency: number of connections for chunked download. Default 8, adjustable to 16.
    downloadConnections: 8,
    // Source preference: auto = benchmark GitHub and Gitee with 128KB test, use fastest; or force single source.
    sourcePreference: 'auto',
    // Automatically try public GitHub acceleration mirrors (ghfast / gh-proxy).
    autoMirror: true,
    // Gitee releases API requires access_token; empty uses GitHub + mirror.
=======
   * 驱动（兼容补丁）扩展：用户自己写的 JSON 补丁放在数据目录的 drivers/ 下。
   * 这里只记「被用户关掉的 id」——默认全开，坏了能一键关，不用删文件。
   */
  drivers: { state: {}, disabled: [] },
  engine: {
    // 只有一个运行时：自带运行时（builtin）。字段保留是为了兼容老 settings.json 的合并，
    // 读设置时会被强制写回 'builtin'（见 getSettings 的迁移）。
    mode: 'builtin',
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = 由 doctor 按机器内存自动决定
    cores: 0,                // 0 = 自动
    autoMemory: true,        // 零配置：自动推导内存/核心/磁盘/渲染参数
    idleShutdownMinutes: 15,
    startVisible: true,
    // 必须带窗口：无头模式 SurfaceFlinger 不出 VSYNC，应用进程活着但屏幕上什么都没有。
    // 带窗口的模拟器是原生 60fps + 原生鼠标键盘，ApkStart 只负责把它打扮成应用窗口。
    headless: false,
    gpuMode: 'auto',         // auto = 按 emulator 版本自动挑后端并逐级降级
    // 上次「拉起就崩」的渲染后端（格式 `<emulator版本>|<gpu>`）；auto 模式下下次把它排到最后，
    // 免得每次开机都先白等 20 多秒再退到软件渲染。升级运行时会自动失效。
    badGpu: '',
    forceTcg: false,         // 保留给高级排障；正常路径已由 doctor 自动回退
    audio: true,             // 安卓应用的声音（提示音/视频）。关闭可省一点 CPU
    // ---- 轻量容器（默认全开省资源，用户可逐项关掉）----
    liteMode: true,          // 收敛 vCPU 配额，避免 qemu 占满物理核拖慢 Windows
    // 一句话策略：save（省资源）/ balanced（均衡）/ smooth（流畅，视频·游戏优先）。
    // 界面上只暴露这一个选项，保存时自动翻译成 liteMode / priorityMode / renderSize，
    // 底部仍然保留细项开关给高级用户。
    resourceMode: 'balanced',
    // 数据分区容量（GB）：应用、游戏缓存和它们的更新包都装在这里。
    // 0 = 自动（按磁盘剩余给 6/8GB）。改大后在下次开安卓时**就地扩容**，不丢已装应用。
    dataPartitionGB: 0,
    // 渲染分辨率：越低越流畅、越省电；auto = 按加速状态选 720x1280 / 540x960
    renderSize: 'auto',
    // 网络加速：给模拟器指定国内公共 DNS。安卓默认的 10.0.2.3 要走主机 DNS，
    // VPN / 公司网 / 某些运营商下解析会拖到几百毫秒，视频类应用首屏会明显发卡。
    fastDns: true,
    // 系统语言：开机时由 emulator -prop 注入（guest 里 setprop 会被 SELinux 拒绝）。
    // 默认简体中文。设成 en-US 或 off 就回到镜像原生英文。
    locale: 'zh-CN',
    // 中文输入法：随包带 AOSP 谷歌拼音输入法，开机后静默安装并启用。
    // 系统镜像只带 LatinIME（英文键盘），不装就打不了中文。
    chineseIme: true,
    chineseImeDefault: true,
    // 快照：quickboot 内存快照让二次启动只要几秒，代价是磁盘上多一份约 2~3GB 的
    // ram.bin。磁盘紧张时可以关掉（只影响启动速度，不影响应用数据）。
    keepSnapshot: true,
    // 日志上限（KB）：超过就滚动备份一份，避免长期使用把磁盘写满
    logLimitKB: 2048,
    // 鼠标键位：左键由模拟器原生映射为「确认/点击」，无需开关。
    // 右键返回与平滑滚轮需要低级钩子，但只在应用窗口前台时装，失焦即卸载。
    mouseRightBack: true,    // 右键 = 安卓返回（拦下 Qt 默认的「右键也当点击」误触）
    mouseWheelMode: 'smooth', // smooth = 合并后注入一次滑动 | native = 交给 Qt | off = 不处理
    mouseSideButtons: false, // 侧键返回/前进：默认关闭，开启才多装一项映射
    deepTrim: false,         // 深度裁剪系统后台包（Play 商店/向导等），默认不动系统
    // balanced=让出前台 | performance=qemu Normal | game=qemu High + 低延迟输入
  priorityMode: 'balanced',
    // 预热：启动 ApkStart 后在后台把安卓环境引导好，第一次点应用几乎不用等。
    // 代价是常驻约 1GB 内存（和 WSA / 应用宝电脑版一样的取舍），可随时关掉。
    prewarm: true,
    // 多窗口（B 方案）：允许同时打开多个应用、各自独立窗口。默认关闭，
    // 保持「开新停旧」的单窗口行为；开启后靠墓碑机制回收后台，资源可控。
    multiWindow: false,
    // 多窗口时保留最近几个后台应用不墓碑化（便于秒切回、不掉登录态）。
    // 0 = 最省内存（只留前台），默认 1。
    keepBackground: 1,
    // 按键映射（游戏键盘→触屏）：默认开启，用户可在设置里关
    keymapEnabled: true,
    // 每应用的按键映射表：{ "com.example.game": [{key:'w',action:'tap',x:0.15,y:0.75}, ...] }
    keymaps: {},
  },
  runtime: {
    dir: '',                 // 空 = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // 手动指定 QEMU 安装包地址
    isoUrl: '',              // 手动指定系统镜像地址
    isoPath: '',             // 系统镜像（ISO）路径
    diskPath: '',            // 安装系统的虚拟磁盘
    diskSizeGB: 24,
    headless: false,         // 不显示虚拟机窗口（仅调试）
    installMode: 'guided',   // guided（引导手动安装） | auto（实验性自动安装）
    emulatorUrl: '',         // 手动指定 emulator 包地址（空 = 自动从 SDK 索引解析最新版）
    sysimgUrl: '',           // 手动指定系统镜像包地址
    compatImage: false,      // ARM 兼容模式：改用 Google Play 镜像（内置 native bridge，可装 ARM-only 应用）
    deployFailedAt: 0,       // 上次自动部署失败的时间戳（0=无失败）。失败后 30 分钟内不再自动重下
    // 轻量版的运行时整包：默认从本项目 GitHub Release 下载（与「软件更新」同源），
    // 拿不到时自动退回 dl.google.com 分组件下载。可在这里换成自建镜像地址。
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // GitHub 加速镜像前缀（可选）。国内直连 GitHub Releases 经常只有几十 KB/s，
    // 填成 https://ghfast.top/ 之类的镜像前缀即可把 downloads 请求转过去。
    // 留空 = 直连（也会先用 8 线程分块试，能跑满带宽）。
    mirrorPrefix: '',
    // 下载并发数：分块下载的连接数。默认 8，弱网/被限速时可调到 16。
    downloadConnections: 8,
    // 更新/下载的源选择。auto = 同时问 GitHub 与 Gitee、并对每个下载地址实测
    // 128KB 速度，谁快用谁；也可以强制只走某一边（企业网络只放行一个域名时有用）。
    sourcePreference: 'auto',
    // 自动尝试公共 GitHub 加速镜像（ghfast / gh-proxy）。关掉后只用直连 + 自定义前缀。
    // 这两个是第三方服务，只是转发公开的 release 文件，不涉及账号信息。
    autoMirror: true,
    // Gitee 的 releases 接口对公开仓库也要求 access_token（无 token 直接 404），
    // 想用 Gitee 作为更新源就在这里填一个只读 token；留空则只用 GitHub + 镜像。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
<<<<<<< HEAD
  createStartMenuShortcut: true, // Start menu shortcut = allows Windows Search to discover apps
  shortcutDir: '',           // Empty = Desktop
  freeform: false,           // Shared single runtime window, no Android freeform mini-windows
  hideAfterLaunch: false,    // Main process must remain resident to keep Android runtime alive
  notifyOnInstall: true,
  autoStart: true,           // Auto-start on boot, enabled by default
  autoDeploy: true,          // Auto-completes all deployment steps on first run
  // Welcome card: lastDate records last auto-display date; disabled = user checked "Do not show again".
  welcome: { lastDate: '', disabled: false },
  /**
   * Automatic diagnostics: periodically inspects machine health and pushes issue list to UI.
   * auto = whether to run periodically; intervalMin = interval (minutes);
   * notify = show notification on new critical issues.
   */
  debug: { auto: true, intervalMin: 10, notify: true },
  display: {
    mode: 'window',          // window (portrait window, resizable) | fullscreen (auto-fit screen)
    portrait: '900x1600',    // Portrait resolution for windowed mode
    density: 0,              // 0 = auto-derived from resolution
    rememberBounds: true,    // Remember window position and size for each app
    autoFullscreenOnLaunch: false,
    // Landscape = switch AVD physical panel to 1280x720 and restart.
    // Persisted here so ApkStart boots in this orientation on next restart.
    landscape: false,
    // Screen orientation policy:
    //   auto      = automatically switch physical panel according to app manifest (recommended)
    //   landscape = force landscape panel
    //   portrait  = force portrait panel
    // In auto mode, landscape field degrades to recording actual current panel orientation.
    orientationMode: 'auto',
    // Tablet layout: override guest logical density to 190dpi (720 width -> sw606dp >= 600dp, crossing tablet breakpoint).
    tabletMode: true,
    // Window hosting mode: false = emulator native window (Qt direct rendering);
    // true = embed Android surface into ApkStart shell window via SetParent.
    // Default native window since 0.6.0.
    windowEmbed: false,
    // In-image auto-rotate toggle: enabled by default (writes guest accelerometer_rotation=1).
    // Panel orientation is still locked by wm user-rotation lock + set-ignore-orientation-request,
    // so it will not be skewed by sensors. Disabling it restores legacy strict lock behavior.
=======
  createStartMenuShortcut: true, // 开始菜单快捷方式 = 让 Windows 搜索能搜到应用
  shortcutDir: '',           // 空 = 桌面
  freeform: false,           // 共享一个运行时窗口，不再用 Android freeform 小窗
  hideAfterLaunch: false,    // 主进程必须常驻，否则一退出就把 Android 运行时杀掉了
  notifyOnInstall: true,
  autoStart: true,           // 开机自启，默认开启，用户无需设置
  autoDeploy: true,          // 首次运行自动完成全部部署，不再分 1~5 步
  // 启动欢迎卡：lastDate 记录上次自动弹出的日期（手动打开时一天最多一次），
  // disabled = 用户勾了「不再自动弹出」。
  welcome: { lastDate: '', disabled: false },
  /**
   * 自动检测（自动 debug）：定时把机器状态采一遍，把问题清单推给界面。
   * auto = 是否定时跑；intervalMin = 间隔（分钟）；
   * notify = 出现「新的严重问题」时弹系统通知（老问题不重复打扰）。
   */
  debug: { auto: true, intervalMin: 10, notify: true },
  display: {
    mode: 'window',          // window（竖屏窗口，可自由拉伸） | fullscreen（自动适配屏幕）
    portrait: '900x1600',    // 窗口模式的竖屏分辨率，可在设置里调大小
    density: 0,              // 0 = 按分辨率自动推导
    rememberBounds: true,    // 记住每个应用的窗口位置/大小
    autoFullscreenOnLaunch: false,
    // 横屏 = 把 AVD 物理面板换成 1280x720 并重启（唯一能得到正立+铺满的方式）。
    // 持久化在这里，重启 ApkStart 后仍按这个方向开机。
    landscape: false,
    // 屏幕方向策略：
    //   auto      = 按应用自己声明的方向自动换物理面板（推荐，只有这样画面才能铺满窗口）
    //   landscape = 强制横屏面板
    //   portrait  = 强制竖屏面板
    // 上面的 landscape 字段在 auto 模式下退化成「当前面板实际方向」这个事实，
    // 由 restartForOrientation 写入，不再当偏好去覆盖应用自己的方向。
    orientationMode: 'auto',
    // 平板排版：把 guest 的逻辑密度覆盖成 190dpi（720 宽 → sw606dp ≥ 600dp，
    // 越过 Android 的平板断点）。红果短剧这类应用只有在平板排版下才有双列剧集页，
    // 也是用户要的「平板模式」。关掉就回到镜像默认密度（手机排版）。
    tabletMode: true,
    // 窗口承载方式：false=让模拟器开自己的原生窗口（Qt 直接渲染，方向/缩放/输入
    // 全由它自己管，帧率和拖动都跟手）；
    // true=把安卓画面用 SetParent 塞进 ApkStart 的壳窗口（观感统一，标题栏带
    // 旋转/最小化/最大化/关闭按钮）。
    // 0.6.0 起默认原生窗口：嵌入模式要把别人的窗口重新布局进自己客户区，
    // 在缩放、旋转、切换应用时会掉帧，还常伴随黑边/坐标错位/铺不满 ——
    // 这类问题在嵌入方式下无法根治，原生窗口从根上绕开。
    // 两种模式仍然都能在设置里选（display.windowEmbed）。
    windowEmbed: false,
    // 镜像内「自动旋转」开关：默认打开（写 guest 的 accelerometer_rotation=1），
    // 面板方向仍由 wm user-rotation lock + set-ignore-orientation-request 决定，
    // 不会被传感器带歪。关掉可回到旧的强制锁定行为。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    autoRotate: true,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
<<<<<<< HEAD
    // Strip potential UTF-8 BOM. When present, JSON.parse throws directly and config falls back to default.
=======
    // 去掉可能的 UTF-8 BOM。带 BOM 时 JSON.parse 会直接抛错，于是整个配置
    // 静默回落到默认值 —— 用户会看到「设置全丢了」，却完全不知道为什么。
    // 这个文件会被设置页、同步工具、甚至用户手工编辑，必须容忍 BOM。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
<<<<<<< HEAD
 * Resource policy -> specific flags.
 *   save     : 2 vCPU + low priority + 540x960, for older laptops / idling;
 *   balanced : vCPU = half of physical cores (2-4) + yield foreground + 720x1280;
 *   smooth   : unrestricted vCPU + foreground priority + 720x1280, video/game priority.
=======
 * 资源策略 → 具体开关。
 *   save     ：2 vCPU + 低优先级 + 540x960，老笔记本 / 挂机用；
 *   balanced ：vCPU 取物理核的一半（2~4）+ 让出前台 + 720x1280；
 *   smooth   ：不限制 vCPU + 与前台同优先级 + 720x1280，视频与游戏优先。
 * 分辨率先不动 1080p：quickboot 快照指纹与它绑定，改一次就要重冷启动，而 720p
 * 在手机比例的窗口里已经看不出区别，性能却差一档。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,
<<<<<<< HEAD
  // Store (MSIX) packaged build flag: disables auto-updater and admin driver install
=======
  // 商店（MSIX）打包版标记：main.js 据此关掉自更新、跳过需要管理员权限的内核驱动安装
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  STORE_BUILD,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    /**
<<<<<<< HEAD
     * Legacy third-party runtime migration: mode=mumu / fydeos / attach cleaned up and normalized to builtin.
=======
     * 0.5.6 起没有第三方底座了：老配置里的 mode=mumu / fydeos / attach，
     * 或者手改出来的任何其它值，一律当 builtin 处理，并把残留的第三方字段删掉。
     *
     * 只在读的时候改内存里的对象，不立刻回写磁盘：设置文件是用户的，等他下次
     * 保存设置时自然落盘；这样「打开一次 ApkStart 就改了他的 settings.json」不会发生。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
     */
    s.engine.mode = 'builtin';
    for (const k of ['mumuPath', 'mumuIndex', 'mumuRenderProfile', 'mumuMemoryGB', 'mumuCores', 'fydeosHost']) {
      delete s.engine[k];
    }
<<<<<<< HEAD
    // Legacy default was headless; migrate unconditionally to windowed mode
    s.engine.headless = false;
    // Legacy shell exit killed Android runtime; keep alive
    s.hideAfterLaunch = false;
    // Legacy used Android freeform mini-windows; now full window
    s.freeform = false;

    /**
     * Final verdict on window hosting: **default must be emulator native window**.
     * Corrects legacy windowEmbed to false unless user explicitly selected it in settings page.
=======
    // 旧版本默认无头运行：应用进程能起来但屏幕上没有窗口，等效于「打不开」。
    // 无条件迁移到带窗口模式，且不再允许通过旧配置把它关掉。
    s.engine.headless = false;
    // 旧版本退出壳层时会杀掉整个 Android 运行时，导致桌面图标点开闪一下就没了。
    s.hideAfterLaunch = false;
    // 旧版本用 Android freeform 小窗，现在整个模拟器窗口就是应用窗口，
    // 应用必须铺满这块屏幕，否则会出现「窗口里再套一个小窗」。
    s.freeform = false;

    /**
     * 窗口承载方式的最终裁决：**默认必须是模拟器原生窗口**。
     *
     * 0.5.9 曾把所有人强制迁到嵌入模式，结果嵌入方式（SetParent + 反复
     * SetWindowPos 重排别人的窗口）在缩放/旋转/切应用时掉帧，并伴随黑边、
     * 坐标错位、铺不满，是用户反馈最集中的一类问题。原生窗口由模拟器自己
     * 渲染和排布，这些问题不存在，所以默认改回它。
     *
     * 这里不再只看「迁移标记」：只要用户**没有在设置页主动选过**
     * （windowEmbedChosen 由设置页写入），读到的值一律纠正为原生，并存回磁盘。
     * 之前的写法只要 windowEmbedMigrated2 已经是 true 就放手不管，于是老配置里
     * 那句 windowEmbed:true 会一直生效 —— 用户升级后启动看到的仍是美化壳窗口，
     * 却以为「默认设置没改」。判定基准只认「有没有主动选过」，其它标记都不算数。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
     */
    try {
      const raw = readJson(SETTINGS_FILE, {});
      const d = (raw && raw.display) || {};
      if (d.windowEmbedChosen !== true && d.windowEmbed !== false) {
        s.display.windowEmbed = false;
        s.display.windowEmbedMigrated2 = true;
<<<<<<< HEAD
        // Write back immediately to ensure config file also reverts to native
=======
        // 立刻回写，保证配置文件本身也回到原生；用户其它字段原样保留。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
        writeJson(SETTINGS_FILE, {
          ...raw,
          display: { ...d, windowEmbed: false, windowEmbedMigrated2: true },
        });
      }
<<<<<<< HEAD
    } catch (_) { /* Migration failure does not block boot */ }
=======
    } catch (_) { /* 迁移失败不影响启动，保持读到的值 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93

    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
<<<<<<< HEAD
    // Translate resourceMode preset to 3 concrete flags
=======
    // 只改了「资源策略」时，把它翻译成具体的三个开关，避免两套配置各说各话
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  iconPath(pkg) {
<<<<<<< HEAD
    // Defense-in-depth: lock package name strictly inside ICON_DIR
=======
    // 第二层防御：pkg 来自外部解析的 APK / apps.json，必须锁在数据目录内。
    // 即使有旧版本写入的坏记录，也不能让它拼出 ICON_DIR 之外的路径（issue #2 P0-1）。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return path.join(ICON_DIR, `${safeFilePart(pkg)}.png`);
  },

  apkPath(pkg, version = 'cur') {
    const v = /^[A-Za-z0-9_-]+$/.test(String(version)) ? version : 'cur';
    return path.join(APK_DIR, `${safeFilePart(pkg)}-${v}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
