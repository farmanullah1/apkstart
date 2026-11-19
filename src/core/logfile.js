'use strict';
/**
<<<<<<< HEAD
 * Lightweight log writer + rotation.
 *
 * Previously app.log / emulator.log were append-only and grew continuously.
 * Rotates based on file size, keeping a single .1.log backup up to the configured limit.
=======
 * 轻量日志写入 + 滚动。
 *
 * 以前 app.log / emulator.log 是纯 append，长期使用会一直长：
 * emulator 每次开机的内核日志就有几十 KB，一天开关十几次、再加上 qemu 的
 * verbose 输出，几个月就是几百 MB —— 磁盘就是这么被悄悄吃掉的。
 * 这里按大小滚动，只保留一份 .1.log 备份，上限由设置里的「日志上限」控制。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
<<<<<<< HEAD
    // If filename does not end in .log, bak equals original file.
    // Explicitly bypass to prevent accidental deletion of logs.
=======
    // 文件名不以 .log 结尾时 bak 会等于原文件：先删后 rename 就把日志删没了。
    // 显式跳过这种边界，宁可日志大一点也不能丢。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
<<<<<<< HEAD
 * @param {string} file Target log file
 * @param {string} line Content to append (automatically adds newline)
 * @param {number} [limitKB] File size limit for rotation
=======
 * @param {string} file 目标日志
 * @param {string} line 一行内容（自动补换行）
 * @param {number} [limitKB] 超过这个大小就滚动
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
<<<<<<< HEAD
    // Check once at process startup, then every 200 lines
=======
    // 每次进程启动检查一次，之后每 200 行检查一次（statSync 很便宜，但没必要每行都做）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

<<<<<<< HEAD
/** Startup cleanup: rotates oversized logs immediately */
=======
/** 启动时清理：把过大的日志先滚掉（不看计数器） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
