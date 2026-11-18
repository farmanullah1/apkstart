const fs = require('fs');

// 1. src/core/container.js
let container = fs.readFileSync('src/core/container.js', 'utf8');
container = container.replace(/\/\*\*[\s\S]*?决定哪些后台应用该被墓碑化[\s\S]*?\*\//,
  `/**
 * Decides which background apps should be tombstoned (force-stopped to reclaim memory).
 * Policy: never touches foreground; skips system packages; keeps recent N apps; tombstones the rest.
 */`);
container = container.replace('// background 末尾是最近的，保留最后 keepRecent 个，其余进墓碑',
  '// background array ends with most recent; keep last keepRecent apps, tombstone the rest');
container = container.replace('/** 生成墓碑命令：force-stop 指定后台包，回收其内存但保留数据/登录态 */',
  '/** Generates tombstone command: force-stops background package to free memory while preserving app state */');
fs.writeFileSync('src/core/container.js', container, 'utf8');

// 2. src/core/download.js
let download = fs.readFileSync('src/core/download.js', 'utf8');
download = download.replace(/\/\*\*[\s\S]*?下载器：支持重定向[\s\S]*?\*\//,
  `/**
 * Downloader: supports redirects, resume, progress callbacks, and SHA-256 verification.
 */`);
download = download.replace(/\/\*\*[\s\S]*?校验服务器返回的 Content-Range[\s\S]*?\*\//,
  `/** Validates Content-Range header against current byte offset */`);
download = download.replace("if (redirects > 6) return reject(new Error('重定向次数过多'));",
  "if (redirects > 6) return reject(new Error('Too many redirects'));");
download = download.replace("req.on('timeout', () => { req.destroy(new Error('连接超时')); });",
  "req.on('timeout', () => { req.destroy(new Error('Connection timed out')); });");
download = download.replace(/\/\*\*[\s\S]*?丢弃一次失败下载留下的所有残余[\s\S]*?\*\//,
  `/** Cleans up partial fragments and chunk metadata from failed downloads */`);
download = download.replace('/* 被占用就算了 */', '/* ignore if locked */');
download = download.replace(/\/\*\*[\s\S]*?下载到本地文件（自动续传）[\s\S]*?\*\//,
  `/** Downloads to local file with automatic resume */`);
download = download.replace(/\/\/ 416 有两种可能[\s\S]*?重试用尽仍未成功则报错。/,
  '// 416 range not satisfiable: restart cleanly if retries remain');
download = download.replace("throw new Error('无法验证续传文件，服务器返回 HTTP 416');",
  "throw new Error('Cannot verify resumed download, server returned HTTP 416');");
download = download.replace('// 重试耗尽：别把坏文件留给下次续传', '// Retries exhausted: discard partial file');
download = download.replace('throw new Error(`下载失败 HTTP ${res.statusCode}: ${url}`);',
  'throw new Error(`Download failed HTTP ${res.statusCode}: ${url}`);');
download = download.replace("throw new Error('服务器返回了不匹配的续传范围');",
  "throw new Error('Server returned mismatched range');");
download = download.replace('// 服务器不支持续传，重头写', '// Server does not support resume, restarting download');
download = download.replace(/\/\/ 和分块下载一样：必须保证 promise 一定会 settle[\s\S]*?也没有报错。/,
  '// Ensure promise settles even if connection stalls silently');
download = download.replace("finish(new Error('连接停滞（长时间无数据）'));",
  "finish(new Error('Connection stalled (no data received)'));");
download = download.replace("const onAbort = () => { res.destroy(new Error('已取消')); };",
  "const onAbort = () => { res.destroy(new Error('Cancelled')); };");
download = download.replace("res.on('close', () => { if (!res.complete) finish(new Error('连接被中断')); });",
  "res.on('close', () => { if (!res.complete) finish(new Error('Connection interrupted')); });");
download = download.replace('// 中断 / 超时 / 写盘失败：半截文件留着只会让下次续传继续失败',
  '// Discard partial file on interrupt or disk error to prevent corrupt resume next time');
download = download.replace('// 收尾：确保进度条走到 100%', '// Ensure progress reaches 100% on complete');
download = download.replace('throw new Error(`校验失败：期望 ${expectSha256.slice(0, 12)}… 实际 ${actual.slice(0, 12)}…`);',
  'throw new Error(`Verification failed: expected ${expectSha256.slice(0, 12)}... actual ${actual.slice(0, 12)}...`);');
download = download.replace('// openStream 直接 reject（连接被拒 / DNS 失败 / 超时）时不会进入写流那段\n    // try/catch —— 以前这里什么都不清，半截文件留着只会让下次续传继续失败',
  '// Clean up partials if openStream rejects directly');
fs.writeFileSync('src/core/download.js', download, 'utf8');

// 3. src/core/sharer.js
let sharer = fs.readFileSync('src/core/sharer.js', 'utf8');
sharer = sharer.replace("if (!(await client.isOnline())) throw new Error('运行时未连接');",
  "if (!(await client.isOnline())) throw new Error('Runtime not connected');");
sharer = sharer.replace(/\/\/ --- 本机 → 设备 ---[\s\S]*?空间越用越少」。/,
  '// --- Host -> Guest ---\n      // Tracks both host mtime and guest mtime to prevent infinite sync loops.');
sharer = sharer.replace('// --- 设备 → 本机 ---\n      // 优先用 toybox stat 拿真实 mtime；拿不到才退回 ls 解析（此时只能按大小判断）',
  '// --- Guest -> Host ---\n      // Uses toybox stat for real mtime; falls back to size-only check via ls');
sharer = sharer.replace('// 超大文件（视频/游戏数据包）不往回拉：本地目录不该成为设备缓存的下水道',
  '// Skip giant files (videos/game caches) to protect host storage');
sharer = sharer.replace(/\/\/ 大小一致，且要么设备时间没变[\s\S]*?绝不重复下载/,
  '// Same size and un-modified: record remote mtime and finish without re-downloading');
sharer = sharer.replace('if (prev && sizeSame && !r.mtime) continue;   // 拿不到设备时间且大小相同 → 视为一致',
  'if (prev && sizeSame && !r.mtime) continue;   // Fallback to size-only equality if remote mtime unavailable');
sharer = sharer.replace('// 优先一次 find + stat 拿全量（比逐目录 ls -l 快，也不受日期格式差异影响）',
  '// Single find + stat command to enumerate remote tree efficiently');
sharer = sharer.replace('/* 落到 ls 解析 */', '/* fall back to ls */');
fs.writeFileSync('src/core/sharer.js', sharer, 'utf8');

// 4. src/core/shortcut.js
let shortcut = fs.readFileSync('src/core/shortcut.js', 'utf8');
shortcut = shortcut.replace(/\/\*\*[\s\S]*?桌面快捷方式 \+ 多尺寸 ICO 生成[\s\S]*?\*\//,
  `/**
 * Desktop shortcut and multi-size ICO generator.
 * Uses nativeImage to build native DIB containers without external dependencies.
 */`);
shortcut = shortcut.replace('// XOR 位图：自下而上，行内 BGRA', '// XOR bitmap: bottom-up, BGRA order');
shortcut = shortcut.replace('// AND 掩码：1bpp，行按 4 字节对齐，全 0（交给 alpha 通道）',
  '// AND mask: 1bpp, 4-byte aligned rows, zeroed for alpha');
shortcut = shortcut.replace('* @param {Buffer} pngBuffer 任意尺寸的 PNG', '* @param {Buffer} pngBuffer PNG buffer of arbitrary size');
shortcut = shortcut.replace('* @returns {Buffer|null} ICO 文件内容', '* @returns {Buffer|null} ICO file buffer');
shortcut = shortcut.replace(": base.resize({ width: s, height: s, quality: 'best' }); // 小图放大也比缺尺寸好",
  ": base.resize({ width: s, height: s, quality: 'best' }); // Upscaling is preferable to missing icon sizes");
shortcut = shortcut.replace(/\/\*\*[\s\S]*?PNG-in-ICO：Vista 起 ICO 条目允许直接内嵌 PNG[\s\S]*?\*\//,
  `/**
 * PNG-in-ICO: Vista+ allows embedding raw PNGs directly inside ICO containers.
 */`);
shortcut = shortcut.replace(/\/\*\*[\s\S]*?任意 APK 图标 → ICO。三级兜底[\s\S]*?\*\//,
  `/**
 * Converts arbitrary APK icons to ICO with 3-tier fallback to ensure an icon is always generated.
 */`);
shortcut = shortcut.replace('/* 非 PNG/JPEG，走下一级 */', '/* non-standard format, try next level */');
shortcut = shortcut.replace(/\/\*\*[\s\S]*?快捷方式的扩展名：Windows 是 \.lnk[\s\S]*?\*\//,
  `/**
 * Shortcut extension: .lnk on Windows, .desktop on Linux/freedesktop.
 */`);
shortcut = shortcut.replace(/\/\*\*[\s\S]*?写一个 freedesktop \.desktop 启动项[\s\S]*?\*\//,
  `/**
 * Writes freedesktop .desktop launcher entry.
 */`);
shortcut = shortcut.replace('throw new Error(`快捷方式目录不可写：${dir}（${e.message}）`);',
  'throw new Error(`Shortcut directory is not writable: ${dir} (${e.message})`);');
shortcut = shortcut.replace('// args 是按 shell 习惯拼好的字符串，这里拆成单个参数再各自加引号',
  '// Splits argument string into individual parameters and quotes them');
shortcut = shortcut.replace('/* 某些文件系统不支持，忽略 */', '/* ignore if unsupported by filesystem */');
shortcut = shortcut.replace('throw new Error(`快捷方式未落盘：${opt.shortcutPath}`);',
  'throw new Error(`Shortcut was not saved to disk: ${opt.shortcutPath}`);');
shortcut = shortcut.replace(/\/\*\*[\s\S]*?生成桌面快捷方式[\s\S]*?\*\//,
  `/**
 * Creates desktop and start menu shortcuts with verification.
 */`);
shortcut = shortcut.replace('// Linux / FydeOS：走 .desktop，不用 Windows 的 COM 接口',
  '// Linux / FydeOS: uses .desktop entries instead of Windows COM interface');
shortcut = shortcut.replace('throw new Error(`快捷方式目录不可写：${dir}（${e.message}）`);',
  'throw new Error(`Shortcut directory is not writable: ${dir} (${e.message})`);');
shortcut = shortcut.replace("if (!ok) throw new Error('创建快捷方式失败（writeShortcutLink 返回 false）');",
  "if (!ok) throw new Error('Failed to create shortcut (writeShortcutLink returned false)');");
shortcut = shortcut.replace('throw new Error(`快捷方式未落盘：${opt.shortcutPath}`);',
  'throw new Error(`Shortcut was not saved to disk: ${opt.shortcutPath}`);');
fs.writeFileSync('src/core/shortcut.js', shortcut, 'utf8');

console.log('Batch 2 completed successfully');
