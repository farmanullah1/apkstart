module.exports = [
  {
    file: 'src/main.js',
    pairs: [
      [": (tip || '正在启动安卓运行时…'),", ": (tip || 'Starting the Android runtime...'),"],
      ["if (r && r.ok) send('toast', { type: 'ok', message: '运行时已自动准备完成' });",
       "if (r && r.ok) send('toast', { type: 'ok', message: 'Runtime is ready' });"],
    ],
  },
];
