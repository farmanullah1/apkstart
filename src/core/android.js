'use strict';
/**
<<<<<<< HEAD
 * Android system settings: bridges common toggles directly into the ApkStart settings page via adb.
 * All commands utilize official shell interfaces without root dependency.
=======
 * 安卓系统设置：不需要进安卓桌面，也不用装第三方工具，
 * 直接通过 adb 把常用的系统开关做成 ApkStart 设置页里的按钮。
 * 所有命令都是官方 shell 接口，不依赖 root。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
const ACTIONS = {
  settings: 'android.settings.SETTINGS',
  wifi: 'android.settings.WIFI_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  locale: 'android.settings.LOCALE_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  battery: 'android.settings.BATTERY_SAVER_SETTINGS',
  cast: 'android.settings.CAST_SETTINGS',
  dev: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
};

/**
<<<<<<< HEAD
 * Volume command for media stream (STREAM_MUSIC = 3). Replaces deprecated `media` command with `cmd media_session volume` on Android 11+.
=======
 * 媒体流（STREAM_MUSIC = 3）的音量命令。Android 11 起系统去掉了 `media` 工具
 * （报 media: inaccessible or not found），同样的功能在 `cmd media_session volume` 里；
 * 旧镜像上没有它时再退回 `media volume`。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
 */
function volumeCmd(args) {
  return `(cmd media_session volume --stream 3 ${args} || media volume --stream 3 ${args})`;
}

<<<<<<< HEAD
/** Parses `volume --get` output, e.g. `volume is 5 in range [0..15]` */
=======
/** 解析 `volume --get` 的输出，例如 `volume is 5 in range [0..15]` */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function parseVolume(out) {
  const m = /volume is (\d+) in range \[(\d+)\.\.(\d+)\]/.exec(String(out || ''));
  if (!m) return null;
  return { index: Number(m[1]), min: Number(m[2]), max: Number(m[3]) };
}

<<<<<<< HEAD
/** Converts volume level to UI percentage */
=======
/** 档位换算成界面用的百分比 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
function volumePercent(v) {
  if (!v || v.max <= v.min) return 0;
  return Math.round(((v.index - v.min) / (v.max - v.min)) * 100);
}

class AndroidSettings {
  constructor(runtime) { this.runtime = runtime; }

  async client() {
    const rt = await this.runtime.ensure();
<<<<<<< HEAD
    if (!rt.ok) throw new Error(rt.error || 'Runtime not ready');
=======
    if (!rt.ok) throw new Error(rt.error || '运行时未就绪');
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
    return rt.client;
  }

  async _sh(commands) {
    const c = await this.client();
    const script = commands.map((x) => `${x}; `).join('');
    return c.shell(script, { timeout: 20000 });
  }

<<<<<<< HEAD
  /** Reads current states for the settings page */
=======
  /** 读一批当前状态，供设置页显示 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async status() {
    const out = await this._sh([
      'echo "wifi=$(settings get global wifi_on)"',
      'echo "air=$(settings get global airplane_mode_on)"',
      'echo "font=$(settings get system font_scale)"',
      'echo "density=$(wm density | tail -n1 | tr -dc \'0-9\')"',
      'echo "animw=$(settings get global window_animation_scale)"',
      'echo "sdk=$(getprop ro.build.version.sdk)"',
      `echo "vol=$(${volumeCmd('--get')} 2>/dev/null | grep -m1 'volume is')"`,
    ]);
    const get = (k) => {
      const m = new RegExp(`${k}=([^\\r\\n]*)`).exec(String(out));
      return m ? m[1].trim() : '';
    };
    const anim = get('animw');
    return {
      wifi: get('wifi') === '1',
      airplane: get('air') === '1',
      fontScale: Number(get('font')) || 1,
      density: Number(get('density')) || 0,
      volume: volumePercent(parseVolume(get('vol'))),
      animationsOff: anim === '0.0' || anim === '0',
      sdk: Number(get('sdk')) || 0,
    };
  }

  async setWifi(on) {
    await this._sh([`svc wifi ${on ? 'enable' : 'disable'}`]);
    return { ok: true };
  }

  async setAirplane(on) {
    const v = on ? 1 : 0;
    await this._sh([
      `settings put global airplane_mode_on ${v}`,
      `am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${on ? 'true' : 'false'}`,
      `svc wifi ${on ? 'disable' : 'enable'}`,
      `svc data ${on ? 'disable' : 'enable'}`,
    ]);
    return { ok: true };
  }

  /**
<<<<<<< HEAD
   * Volume: Converts UI percentage (0-100) to device media stream step range (commonly 0-15).
=======
   * 音量：界面给的是 0~100 的百分比，系统要的是媒体流的档位（常见 0~15，各镜像不同），
   * 所以先读出档位范围再换算。
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
   */
  async setVolume(percent) {
    const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const range = parseVolume(await this._sh([`${volumeCmd('--get')} 2>/dev/null`])) || { min: 0, max: 15 };
    const index = Math.round(range.min + ((range.max - range.min) * p) / 100);
    await this._sh([volumeCmd(`--set ${index}`)]);
    return { ok: true, volume: volumePercent({ ...range, index }) };
  }

<<<<<<< HEAD
  /** Disabling system animations yields noticeably faster UI feel without losing functionality */
=======
  /** 关闭系统动画 = 明显的「变快」体感，且几乎不损失功能 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async setAnimations(on) {
    const v = on ? '1' : '0';
    await this._sh([
      `settings put global window_animation_scale ${v}`,
      `settings put global transition_animation_scale ${v}`,
      `settings put global animator_duration_scale ${v}`,
    ]);
    return { ok: true, animationsOff: !on };
  }

  async setFontScale(scale) {
    const v = Math.max(0.85, Math.min(1.3, Number(scale) || 1)).toFixed(2);
    await this._sh([`settings put system font_scale ${v}`]);
    return { ok: true, fontScale: Number(v) };
  }

<<<<<<< HEAD
  /** Display size: modifies dpi (higher value scales content up, matching system display size) */
=======
  /** 显示大小：改 dpi，越大内容越大（相当于系统「显示大小」档位） */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async setDensity(dpi) {
    const v = Math.max(120, Math.min(640, Math.round(Number(dpi) || 0)));
    if (!v) return { ok: false };
    await this._sh([`wm density ${v}`]);
    return { ok: true, density: v };
  }

<<<<<<< HEAD
  /** One-click optimization: disables animations, background telemetry, and whitelists battery */
=======
  /** 一键整理：关动画 + 关遥测类服务 + 电池白名单，让应用更跟手 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async tune({ pkg } = {}) {
    const cmds = [
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put global activity_manager_constants max_cached_processes=32',
    ];
    if (pkg) cmds.push(`dumpsys deviceidle whitelist +${pkg}`);
    await this._sh(cmds);
    return { ok: true };
  }

  async open(action) {
    const a = ACTIONS[action] || ACTIONS.settings;
    const c = await this.client();
    await c.shell(`am start -a ${a}`, { timeout: 15000 });
    return { ok: true };
  }

<<<<<<< HEAD
  /** Inspects and grants app runtime permissions */
=======
  /** 应用运行时权限一览 + 授权 */
>>>>>>> 0dc0485ed33e53047ad93d2cdcd985cc80d60c93
  async permissions(pkg) {
    const c = await this.client();
    const dump = await c.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const rows = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break;
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m) rows.push({ name: m[1], granted: m[2] === 'true' });
    }
    return rows;
  }

  async grantAll(pkg) {
    const c = await this.client();
    const rows = await this.permissions(pkg);
    const denied = rows.filter((r) => !r.granted).map((r) => r.name);
    for (const p of denied) {
      // eslint-disable-next-line no-await-in-loop
      await c.shell(`pm grant ${pkg} ${p}`, { timeout: 8000 }).catch(() => {});
    }
    return { ok: true, granted: denied.length };
  }
}

module.exports = { AndroidSettings, ACTIONS, volumeCmd, parseVolume, volumePercent };
