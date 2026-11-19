'use strict';
/**
<<<<<<< HEAD
 * Screen orientation resolution (pure functions, no Electron / adb / network dependencies, testable in CI).
 *
 * Centralizes orientation logic across the application (auto, title bar rotate, tray rotate)
 * to maintain a single source of truth and predictable panel behavior.
=======
 * 屏幕方向决策（纯函数，不依赖 Electron / adb / 网络，CI 可直接 require）。
 *
 * 之所以把它单独抽出来：以前这条判断散落在 main.js 的三处（wantLandscapeFor、
 * 标题栏旋转按钮、托盘旋转菜单），三处各算各的「下一个方向」，基准还不一样
 * （有的看 display.landscape，有的看 appWin.state.landscape）。结果是
 * 用户点一次旋转，写进 apps.json 的覆盖值和真正切过去的面板方向相反，
 * 下次打开应用又被 wantLandscapeFor 翻回去 —— 表现就是「红果怎么都横不过来」。
 * 现在所有入口都走本模块，只有一个基准、一个结果。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */

const ORIENTATION_MODES = ['auto', 'landscape', 'portrait'];

/**
<<<<<<< HEAD
 * Determines whether an application should run in landscape or portrait.
 *
 * Precedence (high → low):
 *   1. Settings forced mode ('landscape' / 'portrait')
 *   2. Per-app manual override ('orientationOverride', toggled via rotate button / context menu)
 *   3. Native orientation parsed from APK manifest ('orientation')
 *   4. Current panel orientation (preserves current state when set to sensor-driven)
=======
 * 某个应用应该用横屏面板还是竖屏面板。
 *
 * 优先级（高 → 低）：
 *   1. 设置里的强制模式（landscape / portrait）
 *   2. 单个应用的手动覆盖（orientationOverride，由旋转按钮 / 右键菜单写入）
 *   3. APK 清单解析出的天然方向（orientation）
 *   4. 当前面板方向（声明跟随重力时不折腾重启）
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function resolveLandscape({ mode = 'auto', orientation = null, orientationOverride = null, panelLandscape = false } = {}) {
  if (mode === 'landscape') return true;
  if (mode === 'portrait') return false;
  if (orientationOverride === 'landscape') return true;
  if (orientationOverride === 'portrait') return false;
  if (orientation === 'landscape') return true;
  if (orientation === 'portrait') return false;
  return !!panelLandscape;
}

<<<<<<< HEAD
/** Inverts orientation for rotation button: landscape ↔ portrait */
=======
/** 取反方向，用于旋转按钮：横 → 竖、竖 → 横 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function flipLandscape(current) {
  return !current;
}

<<<<<<< HEAD
/** Override text format: true → 'landscape', false → 'portrait' (persisted in apps.json) */
=======
/** 覆盖值文本：true → 'landscape'，false → 'portrait'（写进 apps.json 的格式） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function overrideValue(landscape) {
  return landscape ? 'landscape' : 'portrait';
}

<<<<<<< HEAD
/** Parses stored override string; returns null if unset or invalid */
=======
/** 从覆盖值文本读回方向；无效值返回 null（= 没有覆盖） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function parseOverride(value) {
  if (value === 'landscape') return true;
  if (value === 'portrait') return false;
  return null;
}

/**
<<<<<<< HEAD
 * Default value for in-guest "Auto-rotate" toggle.
 * Returns '0' or '1' string for Settings.System.ACCELEROMETER_ROTATION.
=======
 * 镜像内「自动旋转」开关默认值。
 * 虚拟机没有真实重力传感器，早先写死 accelerometer_rotation 0 让系统设置里
 * 的「自动旋转」永远是关的。现在默认打开这个开关（面板方向仍由
 * wm user-rotation lock + set-ignore-orientation-request 决定，不会被传感器带歪），
 * 这样应用自己读 Settings.System.ACCELEROMETER_ROTATION 时看到的是「开」。
 * 返回要写进 guest 的 0/1 字符串。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function autoRotateSetting(settings) {
  const d = (settings && settings.display) || {};
  return d.autoRotate === false ? '0' : '1';
}

module.exports = {
  ORIENTATION_MODES,
  resolveLandscape,
  flipLandscape,
  overrideValue,
  parseOverride,
  autoRotateSetting,
};
