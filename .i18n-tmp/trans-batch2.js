const fs = require('fs');

// 1. src/core/container.js
let container = fs.readFileSync('src/core/container.js', 'utf8');
container = container.replace(/\/\*\*[\s\S]*?应用级容器（纯计算层）[\s\S]*?\*\//,
  `/**
 * Application-level container (pure computation layer).
 * Manages cold-boot orchestration, background memory reclaiming, and process lifecycle.
 */`);
container = container.replace('/** 任何情况下都不能裁剪：动它们会直接导致界面黑屏或应用崩溃 */',
  '/** Must never be trimmed: modifying these causes black screens or crashes */');
container = container.replace('/** 只有「深度裁剪」才禁用：这些包只做后台更新/壁纸/打印，停掉不影响打开 App */',
  '/** Disabled only in deep trimming: background-only services (print, updater, screensaver) */');
container = container.replace('// Play 商店（后台更新扫描）', '// Play Store (background updates)');
container = container.replace('// 首次设置向导', '// Setup wizard');
container = container.replace('// 打印服务', '// Print spooler');
container = container.replace('// 屏保', '// Screensaver');
container = container.replace('/** 明显属于系统/框架的包：会话裁剪时跳过，避免误杀 */',
  '/** System/framework packages: excluded from session trimming */');
container = container.replace('/** 只有合法 Android 包名才允许拼进 shell 命令，防止清单被污染后注入 */',
  '/** Validates Android package names against shell injection */');
container = container.replace(/\/\*\*[\s\S]*?启动某个 App 时要执行的裁剪命令[\s\S]*?\*\//,
  `/**
 * Trimming plan executed when launching an app.
 * @param {string} o.pkg            Target package to launch
 * @param {string[]} o.installed    Installed user packages
 * @param {boolean} o.deep          Deep trimming (disable system background services)
 * @param {boolean} o.killBackground Clean cached background processes
 */`);
container = container.replace(/\/\/ 清掉系统缓存的后台进程[\s\S]*?而是真的把内存还回来。/,
  '// Clears cached background processes to free physical host memory.');
container = container.replace('// 计量网络下禁后台数据，避免商店/同步在后台持续唤醒',
  '// Restricts background data on metered networks');
container = container.replace(/\/\*\*[\s\S]*?关掉最后一个 App 后让容器「空转但不吃资源」[\s\S]*?\*\//,
  `/**
 * Puts container into idle state when the last app closes, saving CPU and memory.
 */`);
container = container.replace('/** 从深度裁剪恢复（用户关掉开关时调用，保证可回退） */',
  '/** Restores services disabled during deep trimming */');
container = container.replace(/\/\*\*[\s\S]*?会话状态机：判断一次 launch\/close 之后容器该处于什么状态[\s\S]*?\*\//,
  `/**
 * Session state machine: determines container state after launch/close actions.
 */`);
container = container.replace('/** 给日志/诊断用的一行摘要 */', '/** Diagnostic single-line summary for logging */');
container = container.replace("return '容器空闲（Android 常驻但已降优先级，0 个应用进程）';",
  "return 'Container idle (Android resident with lowered priority, 0 app processes)';");
container = container.replace("`容器活跃：${n} 个应用窗口${plan && plan.stopped && plan.stopped.length\n    ? `，已停掉 ${plan.stopped.length} 个后台应用` : ''}`",
  "`Container active: ${n} app window(s)${plan && plan.stopped && plan.stopped.length ? `, stopped ${plan.stopped.length} background app(s)` : ''}`");
container = container.replace(/\/\*\*[\s\S]*?多窗口（B 方案）下的会话状态机[\s\S]*?\*\//,
  `/**
 * Multi-window session state machine.
 * Distinguishes focused active apps from background apps, managing memory tombstone states.
 */`);
fs.writeFileSync('src/core/container.js', container, 'utf8');

// 2. src/core/shortcut.js
let shortcut = fs.readFileSync('src/core/shortcut.js', 'utf8');
shortcut = shortcut.replace(/\/\*\*[\s\S]*?跨平台桌面快捷方式创建[\s\S]*?\*\//,
  `/**
 * Cross-platform desktop shortcut creation:
 *  - Windows: PowerShell WScript.Shell (.lnk)
 *  - Linux: XDG Desktop Entry (.desktop)
 */`);
shortcut = shortcut.replace('// Windows 桌面 & 开始菜单', '// Windows Desktop & Start Menu');
shortcut = shortcut.replace('// Linux 桌面 & 应用菜单', '// Linux Desktop & Applications Menu');
shortcut = shortcut.replace('// Linux 下从环境变量取，兜底 ~/Desktop', '// Resolves Linux desktop directory from env vars');
shortcut = shortcut.replace('/** 转义 Windows 路径里可能的单双引号（PowerShell 里用双引号字面量） */',
  '/** Escapes quotes in paths for PowerShell */');
shortcut = shortcut.replace('/** 转义 Linux .desktop 文件里的 Exec 字段 */',
  '/** Escapes Exec field in Linux .desktop entries */');
shortcut = shortcut.replace('/** 转义 Linux 字符串（放到单引号内） */',
  '/** Escapes strings enclosed in single quotes on Linux */');
shortcut = shortcut.replace('// 桌面快捷方式', '// Desktop shortcut');
shortcut = shortcut.replace('// 开始菜单快捷方式', '// Start Menu shortcut');
shortcut = shortcut.replace('// 必须给 .desktop 加可执行权限，否则桌面管理器双击会报「未受信任的快捷方式」拒绝启动',
  '// .desktop files must have executable permissions to avoid untrusted launcher warnings');
fs.writeFileSync('src/core/shortcut.js', shortcut, 'utf8');

// 3. src/core/download.js
let download = fs.readFileSync('src/core/download.js', 'utf8');
download = download.replace(/\/\*\*[\s\S]*?HTTP\(S\) 文件下载器[\s\S]*?\*\//,
  `/**
 * HTTP(S) file downloader: supports redirects, progress callbacks, and atomic file creation.
 */`);
download = download.replace("throw new Error(`下载失败: HTTP ${res.statusCode}`);",
  "throw new Error(`Download failed: HTTP ${res.statusCode}`);");
download = download.replace('// 进度通知（限频 100ms）', '// Progress notification (throttled to 100ms)');
download = download.replace("return reject(new Error('下载超时，网络无响应'));",
  "return reject(new Error('Download timed out, network unresponsive'));");
download = download.replace('// 原子落盘：先写 .part，完整后再改名', '// Atomic save: write to .part first, rename upon completion');
fs.writeFileSync('src/core/download.js', download, 'utf8');

// 4. src/core/sharer.js
let sharer = fs.readFileSync('src/core/sharer.js', 'utf8');
sharer = sharer.replace(/\/\*\*[\s\S]*?双向文件共享与剪贴板同步[\s\S]*?\*\//,
  `/**
 * Bidirectional file sharing and clipboard synchronization:
 *   - Local <-> Guest /sdcard/Download folder sync
 *   - Windows <-> Android clipboard sync
 */`);
sharer = sharer.replace('/** 读本端状态（文件相对路径 → { size, mtime }） */',
  '/** Reads local file states (relative path -> { size, mtime }) */');
sharer = sharer.replace('// stat 失败说明设备没 toybox / 命令不可用，退回旧的仅大小判定',
  '// Falls back to size-only check if remote stat command is unsupported');
sharer = sharer.replace('// 删掉本端已被删但在远端还留着的临时文件',
  '// Cleans up remote files deleted locally');
fs.writeFileSync('src/core/sharer.js', sharer, 'utf8');

// 5. src/core/zip.js
let zip = fs.readFileSync('src/core/zip.js', 'utf8');
zip = zip.replace(/\/\*\*[\s\S]*?轻量级零依赖 ZIP 读取器[\s\S]*?\*\//,
  `/**
 * Lightweight, zero-dependency ZIP reader (supports standard ZIP and Zip64).
 */`);
zip = zip.replace('// read() 单条目上限：超过就要求调用方走 pipeTo（流式），避免整块进内存',
  '// Maximum single-entry read() limit: callers must use pipeTo (streaming) for larger entries');
zip = zip.replace('/** 把 BigInt 偏移安全地转成 Number（ZIP 不可能大过 2^53 字节） */',
  '/** Safely converts BigInt offset to Number (ZIP size cannot exceed 2^53 bytes) */');
zip = zip.replace(/\/\*\*[\s\S]*?解析 Zip64 扩展字段[\s\S]*?\*\//,
  '/** Parses Zip64 extra field (0x0001) */');
zip = zip.replace(/\/\*\*[\s\S]*?从 EOCD 位置解出条目数[\s\S]*?\*\//,
  '/** Parses entry count and central directory offset from EOCD, following Zip64 when present */');
zip = zip.replace('// Zip64 EOCD locator 固定紧挨在 EOCD 前面 20 字节',
  '// Zip64 EOCD locator is fixed 20 bytes preceding standard EOCD');
zip = zip.replace("throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');",
  "throw new Error('Not a valid ZIP/APK file (EOCD not found)');");
zip = zip.replace('throw new Error(`本地文件头越界: ${name}`);',
  'throw new Error(`Local file header out of bounds: ${name}`);');
zip = zip.replace('throw new Error(`本地文件头损坏: ${name}`);',
  'throw new Error(`Corrupted local file header: ${name}`);');
zip = zip.replace('throw new Error(`条目数据越界: ${name}`);',
  'throw new Error(`Entry data out of bounds: ${name}`);');
zip = zip.replace('throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);',
  'throw new Error(`Unsupported compression method ${e.method}: ${name}`);');
zip = zip.replace('/** 列出匹配某个前缀/正则的条目名 */',
  '/** Lists entry names matching a prefix or regex */');
zip = zip.replace(/\/\*\*[\s\S]*?流式解压单个条目到可写流[\s\S]*?\*\//,
  '/** Streams decompression of a single entry into a writable stream */');
zip = zip.replace('if (!e) return Promise.reject(new Error(`条目不存在: ${name}`));',
  'if (!e) return Promise.reject(new Error(`Entry does not exist: ${name}`));');
zip = zip.replace('return Promise.reject(new Error(`本地文件头损坏: ${name}`));',
  'return Promise.reject(new Error(`Corrupted local file header: ${name}`));');
zip = zip.replace('if (e.method !== 8) return done(new Error(`不支持的压缩方式 ${e.method}: ${name}`));',
  'if (e.method !== 8) return done(new Error(`Unsupported compression method ${e.method}: ${name}`));');
zip = zip.replace('// 分片喂入，避免一次性把 GB 数据塞进 zlib 缓冲区',
  '// Chunks input to prevent saturating zlib memory buffers');
zip = zip.replace(/\/\*\*[\s\S]*?文件版 ZIP 读取器[\s\S]*?\*\//,
  '/** File-backed ZIP reader: streams central directory and entries on-demand from disk. */');
zip = zip.replace('// readSync 可能短读（尤其大块），必须循环到读满',
  '// readSync may return short reads; loop until fully read');
zip = zip.replace("if (this.size < 22) throw new Error('不是有效的 ZIP/APK 文件（文件过小）');",
  "if (this.size < 22) throw new Error('Not a valid ZIP/APK file (file too small)');");
zip = zip.replace("if (eocd < 0) throw new Error('不是有效的 ZIP/APK 文件（未找到 EOCD）');",
  "if (eocd < 0) throw new Error('Not a valid ZIP/APK file (EOCD not found)');");
zip = zip.replace("throw new Error('ZIP 中央目录偏移异常');",
  "throw new Error('Abnormal ZIP central directory offset');");
zip = zip.replace('// 中央目录不在尾部缓冲里（超大注释 / 多分卷），按声明大小精确读一段',
  '// Central directory outside trailing buffer; read exact segment');
zip = zip.replace("if (len <= 0) throw new Error('ZIP 中央目录偏移异常');",
  "if (len <= 0) throw new Error('Abnormal ZIP central directory offset');");
zip = zip.replace('if (!e) throw new Error(`条目不存在: ${name}`);',
  'if (!e) throw new Error(`Entry does not exist: ${name}`);');
zip = zip.replace('if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`本地文件头损坏: ${name}`);',
  'if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Corrupted local file header: ${name}`);');
zip = zip.replace(/\/\/ read\(\) 会把整个条目解到内存[\s\S]*?大包必炸」的形态）。/,
  '// Sets safe upper bound on read() to prevent OOM when loading large images');
zip = zip.replace('throw new Error(`条目过大（${(e.compSize / 1048576).toFixed(0)}MB），请改用 pipeTo: ${name}`);',
  'throw new Error(`Entry too large (${(e.compSize / 1048576).toFixed(0)}MB), please use pipeTo: ${name}`);');
zip = zip.replace('if (raw.length < e.compSize) throw new Error(`条目数据被截断: ${name}`);',
  'if (raw.length < e.compSize) throw new Error(`Entry data truncated: ${name}`);');
zip = zip.replace('throw new Error(`不支持的压缩方式 ${e.method}: ${name}`);',
  'throw new Error(`Unsupported compression method ${e.method}: ${name}`);');
zip = zip.replace('if (e.method !== 0 && e.method !== 8) return done(new Error(`不支持的压缩方式 ${e.method}: ${name}`));',
  'if (e.method !== 0 && e.method !== 8) return done(new Error(`Unsupported compression method ${e.method}: ${name}`));');
zip = zip.replace(/\/\*\*[\s\S]*?把 ZIP 条目名安全解析到 destDir 下[\s\S]*?\*\//,
  '/** Safely resolves ZIP entry paths to destination directory to prevent Zip Slip vulnerabilities */');
zip = zip.replace('// 统一正斜杠后判断：反斜杠在 Windows 上同样是路径分隔符',
  '// Normalize slashes before validating paths');
zip = zip.replace('// path.resolve 可能因为盘符/挂载点把目标甩到根目录外，最后再核一次前缀边界',
  '// Verify target remains within boundary prefix after path.resolve');
fs.writeFileSync('src/core/zip.js', zip, 'utf8');

console.log('Batch 2 translated successfully');
