const fs = require('fs');

// 1. backends/base.js
let base = fs.readFileSync('src/core/backends/base.js', 'utf8');
base = base.replace(/\/\*\*[\s\S]*?后端适配层（backend driver）[\s\S]*?\*\//,
  `/**
 * Backend driver layer: abstracts runtime provider implementation details.
 * Sole supported implementation: builtin (bundled Google Android Emulator / QEMU).
 */`);
base = base.replace('/** 能自己下载/部署运行时（镜像、emulator、adb） */', '/** Supports automatic download/deployment of runtime components */');
base = base.replace('/** 能保存快速启动快照（二次开机秒进） */', '/** Supports snapshot saves for instantaneous subsequent boots */');
base = base.replace('/** 能调整数据分区大小 */', '/** Supports userdata partition resizing */');
base = base.replace('/** 能彻底重置安卓数据（/data） */', '/** Supports factory data reset (/data) */');
base = base.replace('/** 能改物理面板方向（真横屏，靠重启实现） */', '/** Supports hardware display orientation modification */');
base = base.replace('/** 能调进程优先级（把虚拟机让给前台应用） */', '/** Supports VM process priority adjustments */');
base = base.replace('/** 能彻底关掉自己（卸载/退出时调用） */', '/** Supports clean full termination */');
base = base.replace('/** 画面窗口由第三方软件创建，不能过多「借」它的窗口（避免抢走用户自己的模拟器） */', '/** Window created by external software */');
base = base.replace('/** adb serial（例如 emulator-5554 / 127.0.0.1:16384） */', '/** adb serial (e.g. emulator-5554 / 127.0.0.1:16384) */');
base = base.replace('/** adb.exe 的绝对路径 */', '/** Absolute path to adb.exe */');
base = base.replace('/** 最近一次错误，供诊断用 */', '/** Last diagnostic error */');
base = base.replace('/** 底座的稳定 id（写入设置，不能随意改） */', '/** Stable backend identifier stored in settings */');
base = base.replace('/** 界面上显示的名字 */', '/** Display label */');
base = base.replace("static get label() { return '未命名后端'; }", "static get label() { return 'Unnamed Backend'; }");
base = base.replace('/** 一句话说明，设置页用它解释这个底座是什么 */', '/** Backend description */');
base = base.replace('/** 这个底座是否满足「嵌入式窗口」要求（不满足的只能当 attach 用） */', '/** Meets embedded window criteria */');
base = base.replace('/** 能力位集合，见 CAPS */', '/** Capability flag set (see CAPS) */');
base = base.replace('/** 当前底座是否已经在跑（不要求已连上 adb） */', '/** Whether runtime process is currently running */');
base = base.replace(/\/\*\*[\s\S]*?探测：机器上有没有这个底座[\s\S]*?\*\//, '/** Probes for backend availability */');
base = base.replace(/\/\*\*[\s\S]*?就绪检查：用户能不能现在就用它装应用[\s\S]*?\*\//, '/** Verifies if backend is immediately usable */');
base = base.replace("async check() { return { ok: false, reason: '未实现' }; }", "async check() { return { ok: false, reason: 'Not implemented' }; }");
base = base.replace('/** 解析可用的 adb 路径（优先自带，其次底座自带的，最后系统 PATH） */', '/** Resolves available adb path */');
base = base.replace(/\/\*\*[\s\S]*?确保运行时可用[\s\S]*?\*\//, '/** Ensures runtime is online and connected */');
base = base.replace("async ensure(o = {}) { return { ok: false, error: '未实现' }; }", "async ensure(o = {}) { return { ok: false, error: 'Not implemented' }; }");
base = base.replace(/\/\*\*[\s\S]*?安卓画面窗口的候选 HWND[\s\S]*?\*\//, '/** Returns candidate HWNDs for display window */');
base = base.replace('/** 取最近一次启动生成的快照信息（时间、是否可用、大小） */', '/** Retrieves last snapshot metadata */');
base = base.replace('/** 重命名快照标签（保留快照但下次冷启动，方便诊断） */', '/** Renames snapshot tag for diagnostics */');
base = base.replace('/** 扩容数据分区到 targetGB（就地或重建，由各底座自己定） */', '/** Resizes userdata partition */');
base = base.replace('/** 重置用户数据（抹掉所有已装应用，回到出厂状态） */', '/** Resets userdata to factory state */');
base = base.replace('/** 重启底座（改面板方向、重置数据后需要） */', '/** Reboots backend */');
base = base.replace('/** 停止底座（退出程序、切底座时调用） */', '/** Stops backend */');
base = base.replace('/** 资源配额与当前用量（设置页显示用） */', '/** Returns resource limits and current allocations */');
base = base.replace('/** 切换物理面板方向（真横屏）：默认实现是写设置并重启 */', '/** Modifies hardware panel orientation */');
base = base.replace('/** 进入 / 退出后台低优先级状态 */', '/** Toggles background low-priority mode */');
base = base.replace('/** 组件更新检查：返回组件名 → { hasUpdate, current, latest, url } */', '/** Checks for component updates */');
base = base.replace('/** 下载并应用某个组件的更新 */', '/** Downloads and applies component update */');
base = base.replace('/** 安装大包前的专属预检（除了通用磁盘空间，有些底座还要看自己的分区） */', '/** Backend-specific preflight check */');
fs.writeFileSync('src/core/backends/base.js', base, 'utf8');

// 2. backends/index.js
let index = fs.readFileSync('src/core/backends/index.js', 'utf8');
index = index.replace(/\/\*\*[\s\S]*?底座注册表[\s\S]*?\*\//,
  `/**
 * Backend Registry.
 * Exclusively provides the builtin Google Android Emulator runtime.
 */`);
index = index.replace('/** 唯一底座。保留这个常量，是给「以后真要加底座」的地方留个明确落点。 */',
  '/** Primary backend identifier constant */');
index = index.replace('/** 给界面用的描述清单（只留静态信息，能安全序列化） */',
  '/** Serialized description list for UI consumption */');
index = index.replace(/\/\*\*[\s\S]*?按设置创建一个底座实例[\s\S]*?\*\//,
  `/**
 * Instantiates the backend based on settings (always returns builtin).
 */`);
index = index.replace('// 显式传了别的 id（旧代码的回退路径）也一律落到 builtin',
  '// Enforce builtin backend regardless of legacy config values');
index = index.replace(/\/\*\*[\s\S]*?自动挑选底座[\s\S]*?\*\//,
  `/**
 * Auto-selects active backend (always builtin).
 */`);
fs.writeFileSync('src/core/backends/index.js', index, 'utf8');

// 3. backends/builtin.js
let builtin = fs.readFileSync('src/core/backends/builtin.js', 'utf8');
builtin = builtin.replace(/\/\*\*[\s\S]*?自带运行时底座（Builtin）[\s\S]*?\*\//,
  `/**
 * Builtin Android Runtime backend:
 * Bundles Google Android Emulator (QEMU), platform-tools (adb), and system image.
 */`);
builtin = builtin.replace("static get label() { return '自带运行时（推荐）'; }",
  "static get label() { return 'Built-in Runtime (Recommended)'; }");
builtin = builtin.replace("static get description() {\n    return '随包内置的 Google Android 模拟器，免安装、零污染、纯独立运行。';\n  }",
  "static get description() {\n    return 'Bundled Google Android Emulator: zero setup, self-contained, and isolated.';\n  }");
builtin = builtin.replace('// 缺关键依赖时不能当成「可用」', '// Cannot report usable if core dependencies are missing');
builtin = builtin.replace('// 不抛出：让 check() 返回可读原因，比未捕获异常对用户更友好',
  '// Return readable reason instead of unhandled exception');
builtin = builtin.replace('// 运行时组件不齐：直接给下载入口', '// Incomplete components: prompt download');
builtin = builtin.replace('// 运行时就绪但没在跑：可以正常点开（会秒级开机）', '// Ready to launch');
builtin = builtin.replace('// 已在跑：随时能用', '// Already running and available');
builtin = builtin.replace('// 状态由 engine.ensure 内部自愈，这里只负责在就绪后触发一次状态广播',
  '// State transitions are managed by engine.ensure');
builtin = builtin.replace('// 运行时就绪：发事件通知界面把「连接中…」换成「已就绪」',
  '// Notify UI that runtime is online and ready');
builtin = builtin.replace('// 第一次装完镜像立即点开时，旧连接可能只看到 unauthorized，连上后重同步一次',
  '// Re-sync guest settings upon first connection');
builtin = builtin.replace(/\/\*\*[\s\S]*?自带 emulator 的画面窗口不给候选句柄[\s\S]*?\*\//,
  `/**
 * Builtin emulator window handle lookup is delegated to WinAgent's FindEmulator().
 */`);
builtin = builtin.replace(/\/\*\*[\s\S]*?画面窗口是否已经嵌进宿主[\s\S]*?\*\//,
  `/**
 * Checks if emulator window is embedded into host window.
 */`);
builtin = builtin.replace("if (!this.rt) return { ok: false, error: '运行时未初始化' };",
  "if (!this.rt) return { ok: false, error: 'Runtime not initialized' };");
builtin = builtin.replace("if (!this.rt) return { ok: false, error: '运行时未初始化' };",
  "if (!this.rt) return { ok: false, error: 'Runtime not initialized' };");
builtin = builtin.replace('default: return { ok: false, error: `未知组件 ${component}` };',
  'default: return { ok: false, error: `Unknown component ${component}` };');
builtin = builtin.replace(/\/\*\*[\s\S]*?设置页展示用：宿主上限 \+ 当前分配[\s\S]*?\*\//,
  `/**
 * Resource quota and allocation limits for the settings page.
 */`);
builtin = builtin.replace("note: '自带运行时的内存/CPU 下次启动安卓生效；数据分区改大后点「立即扩容」——'\n        + '能就地扩就保留已装应用，安卓正在用快速启动差量盘时会提示你重置后按新容量重建。',",
  "note: 'Memory and CPU changes take effect on next boot. Data partition capacity can be resized in place.',");
builtin = builtin.replace(/\/\*\*[\s\S]*?大包预检：除了物理磁盘，还要看 \/data 分区本身够不够[\s\S]*?\*\//,
  `/**
 * Storage preflight check: verifies physical disk and /data partition capacity before installing large apps.
 */`);
builtin = builtin.replace("message: `安卓数据分区不足：当前 ${capGB} GB，这个游戏建议至少 ${Math.ceil(need / 1024)} GB。`\n          + '请在设置 → 引擎里把「数据分区容量」调大后重启安卓（会就地扩容，不丢已装应用）。',",
  "message: `Android data partition insufficient: currently ${capGB} GB, recommended at least ${Math.ceil(need / 1024)} GB. Increase partition size in Settings -> Engine.`,");
builtin = builtin.replace('// 交给 Runtime.dispose()：它会保留 qemu 进程，下次启动可以直接接管',
  '// Delegated to Runtime.dispose() to preserve running process for fast reconnect');
fs.writeFileSync('src/core/backends/builtin.js', builtin, 'utf8');

console.log('All backend files translated successfully');
