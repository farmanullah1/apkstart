'use strict';
/**
<<<<<<< HEAD
 * .apk file association (HKCU only, does not require administrator privileges)
 * Double click apk -> apkstart.exe "%1" -> auto install -> auto create desktop shortcut
=======
 * .apk 文件关联（仅写 HKCU，不需要管理员权限）
 * 双击 apk → apkstart.exe "%1" → 自动安装 → 自动建桌面快捷方式
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
<<<<<<< HEAD
// Store previous default application before association, restored upon uninstall
=======
// 关联前的「原默认程序」记在这里，卸载时原样还回去，别把用户的关联弄丢
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
const STORE_KEY = 'HKCU\\Software\\ApkStart';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

<<<<<<< HEAD
/** Read default value of a registry key (REG_SZ), returns empty string if unreadable */
=======
/** 读某个键的默认值（REG_SZ），读不到返回空串 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

<<<<<<< HEAD
/** Read recorded previous default value before association */
=======
/** 读我们记下的「关联前默认值」 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'ApkStart' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
<<<<<<< HEAD
  } catch (_) { /* Notification failure does not affect association itself */ }
}

/**
 * @param {string} exePath apkstart main executable path (electron.exe in dev mode)
 * @param {string} [iconPath] Optional ico path
 * @param {string} [extraArgs] Dev mode extra args, e.g., "\"C:\\path\\apkstart\""
=======
  } catch (_) { /* 通知失败不影响关联本身 */ }
}

/**
 * @param {string} exePath apkstart 主程序路径（开发模式下是 electron.exe）
 * @param {string} [iconPath] 可选 ico
 * @param {string} [extraArgs] 开发模式下需要先传应用目录，例如 "\"C:\\path\\apkstart\""
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

<<<<<<< HEAD
  // Remember previous default program before association: restore upon uninstall
=======
  // 记住关联前 .apk 的默认程序：用户本来装了别的安卓工具时，卸载 ApkStart
  // 之后应该还给他，而不是把 .apk 变成「没有默认程序」。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
<<<<<<< HEAD
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
=======
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* 本来就没有 */ }
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

<<<<<<< HEAD
  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Android Package', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Android Package', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Install to ApkStart', '/f']);
=======
  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Android 应用包', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Android 应用包', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', '安装到 ApkStart', '/f']);
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

/**
<<<<<<< HEAD
 * Unregister file association.
 *  1) If previous association exists -> restore;
 *  2) If no record and current default is still ours -> clear;
 *  3) If current default belongs to another app -> leave untouched.
=======
 * 取消关联。
 * 旧实现无条件把 .apk 的默认值清空（注释写了「仅当仍指向我们自己」，但代码没做），
 * 用户卸载 ApkStart 时会把原本的 .apk 关联一起抹掉。现在：
 *  1) 有关联前记录 → 原样还原；
 *  2) 没有记录且当前默认值仍是我们的 → 才清空；
 *  3) 当前默认值是别人的 → 一个字节都不动。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
