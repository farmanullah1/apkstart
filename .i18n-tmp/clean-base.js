const fs = require('fs');

let base = fs.readFileSync('src/core/backends/base.js', 'utf8');

const pairs = [
  ['* 画面窗口是否已经就绪（可以停止隐藏/开始嵌入）。\n   * 默认：拿得到候选窗口就算就绪。自带 emulator 的窗口是我们自己拉起来的，\n   * 默认实现就够用；保留这个钩子是为了将来换运行时时有地方等画面。',
   '* Checks if display window is ready for embedding.'],
  ['* 把画面窗口藏起来（开机 / 预热阶段，用户不该看到模拟器）。\n   * 拿不到窗口时静默返回 null。\n   * @returns {Promise<string|null>} 藏起来的 HWND',
   '* Hides display window during boot/warmup.\n   * @returns {Promise<string|null>} Hidden HWND'],
  ['/** 停止运行时 */', '/** Stops runtime */'],
  ["async stop(o = {}) { return { ok: false, error: '未实现' }; }",
   "async stop(o = {}) { return { ok: false, error: 'Not implemented' }; }"],
  ['/** 下载/部署缺失组件（只有带 CAPS.provision 的底座需要实现） */',
   '/** Deploys missing components (only required for backends with CAPS.provision) */'],
  ["async install(component, onProgress) { return { ok: false, error: '该后端不支持自动部署' }; }",
   "async install(component, onProgress) { return { ok: false, error: 'Backend does not support auto-provisioning' }; }"],
  ['/** 占用统计（设置页「运行时占用」） */', '/** Storage usage breakdown for settings */'],
  ['/** 数据分区信息 */', '/** Data partition metadata */'],
  ['/** 调整数据分区 */', '/** Resizes data partition */'],
  ["async resizeData(mb) { return { ok: false, error: '该后端不支持调整数据分区' }; }",
   "async resizeData(mb) { return { ok: false, error: 'Backend does not support resizing data partition' }; }"],
  ['/** 彻底重置安卓数据 */', '/** Factory resets Android user data */'],
  ["async resetData() { return { ok: false, error: '该后端不支持重置数据' }; }",
   "async resetData() { return { ok: false, error: 'Backend does not support resetting data' }; }"],
  ['/** 释放资源（ApkStart 退出时调用；默认什么都不做） */', '/** Releases resources on quit */'],
  ['/** 诊断信息（写进问题报告） */', '/** Diagnostic info for bug reports */'],
];

for (const [f, r] of pairs) {
  base = base.replace(f, r);
}

fs.writeFileSync('src/core/backends/base.js', base, 'utf8');
console.log('base.js fully cleaned');
