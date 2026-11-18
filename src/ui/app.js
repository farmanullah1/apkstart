'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- Utilities ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

/**
 * Mini toast
 *
 * Deduplication and maximum display limit for notifications:
 * During install failures, runtime logs push continuous updates. Previously each created a new toast,
 * stacking duplicate error messages on screen.
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① Deduplication: same title + body within 4s updates existing toast instead of adding new
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② Limit: maximum 4 visible toasts, dismiss oldest when exceeded
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- Rendering ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'First time: Open Settings (top-right) → Runtime → One-Click Setup, then install apps.'
      : 'Tip: All apps share the same Android runtime, so subsequent app launches are near-instant.'
    grid.innerHTML = '';
    return;
  }

  // Append an 'Add App' dashed placeholder card at the end.
  // Fills empty space when few apps are installed and prompts user to drag APKs in.
  // Clearly visualizes the drag-and-drop feature.
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="Running"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'Running' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Bring to Front' : 'Open'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Drag APK file here or click to select">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Add App</div>
      <div class="meta">Drag & drop APK to install</div>
    </div>
  `;
}

/* ---------------- Data Refresh ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} ${n === 1 ? 'app' : 'apps'}` : 'No apps';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Runtime not deployed — Open Settings → Runtime → One-Click Setup';
      tag.textContent = 'Setup Required';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Runtime ready · Android ${s.android || '?'}${s.freeform ? ' · Freeform windows enabled' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Booting Android…';
      tag.textContent = 'Booting';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      // Explain how to fix directly on the status bar
      text.textContent = 'Hardware acceleration disabled: fell back to software emulation (slow). Click Health Check → Repair below';
      tag.textContent = 'Software Emulation';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Missing Android 14 system image — download in Settings → Runtime (~1.5GB, one-time)';
      tag.textContent = 'Download Needed';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'Runtime engine not installed — Open Settings → Runtime → One-Click Setup';
      tag.textContent = 'Setup Required';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Runtime ready — install APK or double-click shortcut to launch';
      tag.textContent = 'Ready';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Installer running — please complete installation in VM window';
      tag.textContent = 'Installing';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Runtime standby (auto-starts when launching or installing apps)'
        : 'Android OS not installed — open Settings → Runtime to continue';
      tag.textContent = s.installed ? 'Standby' : 'Needs Install';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // Network status: easily catches VM network issues visible directly on status bar.
    // Displayed directly on status bar for immediate visibility.
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Online ${s.network.ip || ''}`.trim() : 'VM Offline';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'Android VM is connected to network; online apps will load normally'
          : 'Android VM has no network connection. Fix via Settings → Repair Network';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Status check failed: ${e.message}`;
  }
}

/* ---------------- Runtime Deployment (Settings) ---------------- */

/**
 * Runtime/deployment/diagnostic panels are consolidated into Settings.
 * Retain showSetup for tray menu and ui:navigate to open Settings at Runtime group.
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    focusGroup($('runtimeGroup'));
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // Show installed apps on launch without wizard overlay,
  // status is reflected in Settings → Runtime and bottom status bar.
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Engine');
    if (!imgDone0) missing.push('System Image');
    stateText.textContent = s.deviceOnline
      ? `Ready · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Booting Android…'
        : allDone0
          ? 'Components ready · Standby (auto-starts on app launch)'
          : `Missing ${missing.join(', ')}${accelOk ? '' : ' (No hardware acceleration, software fallback)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // Single step: download, parameter adaptation, and booting chained in 'One-Click Setup', auto-running on first launch.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('adb tools');
  if (!emuDone) left.push('Android Runtime');
  if (!imgDone) left.push('System Image');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'All Ready' : 'One-Click Setup',
    tag: allDone ? 'Completed' : 'Auto',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} ready · Windows adapt to screen automatically`
      : booting
        ? 'Booting Android…'
        : allDone
          ? 'Components ready; double-click any APK or desktop shortcut to launch'
          : `Missing ${left.join(', ')}; click 'One-Click Setup' below to install and launch automatically`,;
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Stop Runtime</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparing…' : (allDone ? 'Ready · Re-check' : 'One-Click Setup');
  // Display persisted failure record: memory diagnosis is empty after restart.
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Last boot failed: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Last boot auto-diagnosis: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Automatic: no manual image, accel toggle, or memory tuning needed';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // Unified progress tracking across sub-steps on a single progress bar
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // Installs adb, engine, and system image in one go; manual trigger bypasses failure cooldown
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Setup failed', body: (r && r.error) || 'Please check network and try again', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Components ready, booting…', body: 'First launch takes 1-3 mins, subsequent launches take seconds.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Runtime ready', body: 'Drag APK into window or double-click shortcut to launch.', type: 'ok' }
      : { title: 'Boot incomplete', body: (started && started.error) || 'Export diagnostic report for details', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Setup failed', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Deployment task already in progress' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Installing hardware acceleration driver…',
        body: 'Please click Yes in the UAC prompt',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Hardware acceleration enabled', type: 'ok' });
      else t.update({ title: 'Acceleration not enabled', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Unknown step' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'Failed to start installation environment', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'VM window open', body: 'Follow the 6 steps to install; click "I have completed installation" when done.', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Installation complete, runtime active', body: 'You can now drag APKs in to install.', type: 'ok' });
}



/* ---------------- Installation ---------------- */

/** Translate installation errors to actionable suggestions */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Unknown error');
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|ENOSPC/i.test(s)) {
    return `${s}\nInsufficient storage in Android data partition: Settings → Performance & Resources → expand Data Partition.`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nPackage requires ARM libraries; switching to compatibility image and retrying.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nSignature mismatch for existing package. Right-click app card to Uninstall first, then retry.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nInstalled version is newer. Uninstall existing version before downgrading.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nPackage parsing failed due to memory or file limits. Ensure adequate RAM/disk space and avoid non-ASCII paths (e.g. use D:\\a.apk).`;
  }
  return s;
}

/* Active 'Installing...' sticky toast dismissed cleanly on install:error */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Installation in progress', body: 'Please wait for current installation to finish.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Installing ${name}`, body: 'Parsing APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Installing ${pr.meta.label}` : `Installing ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} Installed`, body: r.app.shortcutPath ? 'Desktop shortcut created; double-click to launch.' : 'Right-click app card to create desktop shortcut.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} Compatibility Warning`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // Dismiss active sticky toast; error notifications handled uniformly by install:error listener.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- App Actions ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Launching ${app ? app.label : pkg}`,
    body: 'Pre-warming runtime for first launch, please wait…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // App runs in independent window; main interface minimizes automatically
    t.update({ title: 'Launched', body: 'App is running in an independent window.', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Launch failed', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Desktop shortcut created', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Failed to create shortcut', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Uninstall "${app.label}"?\n\nApp data and desktop shortcuts will also be deleted.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Uninstalled', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Uninstall failed', body: e.message, type: 'error' });
  }
}

/* ---------------- Context Menu ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Open App', kbd: 'Enter' },
  // Visible only when app is actually running.
  { key: 'stop', label: 'Close App', onlyRunning: true },
  { key: 'shortcut', label: 'Create Desktop Shortcut' },
  { key: 'orientation', label: 'Landscape / Portrait' },
  { key: 'pin', label: 'Pin to Top' },
  { key: 'keymap', label: 'Keymapping…' },
  { divider: true },
  { key: 'reveal', label: 'Open APK Location' },
  { key: 'clear', label: 'Clear App Data' },
  { divider: true },
  { key: 'uninstall', label: 'Uninstall', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Unpin' : 'Pin to Top')
      : (it.key === 'orientation'
        ? (app && app.orientationOverride === 'landscape' ? 'Launch Portrait (Current: Landscape)'
          : (app && app.orientationOverride === 'portrait' ? 'Launch Landscape (Current: Portrait)' : 'Set to Launch Landscape'))
        : it.label);
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'Closed', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Failed to close', body: (r && r.error) || 'Unknown error', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Failed to close', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'orientation': {
      // Tri-state toggle: Follow App -> Landscape -> Portrait -> Follow App
      const cur = app.orientationOverride;
      const next = cur === 'landscape' ? 'portrait' : (cur === 'portrait' ? null : 'landscape');
      try {
        const r = await api.setAppOrientation(pkg, next);
        const txt = next === 'landscape' ? 'Launch Landscape' : (next === 'portrait' ? 'Launch Portrait' : 'Follow App');
        toast({ title: `Set to ${txt}`, body: 'Takes effect on next launch without restarting environment.', type: 'ok' });
        if (r && typeof r.landscape === 'boolean' && state.apps) {
          const rec = state.apps.find((a) => a.package === pkg);
          if (rec) rec.orientationOverride = next;
        }
      } catch (e) {
        toast({ title: 'Failed to set orientation', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'keymap': return showKeymapPicker(pkg, app.label);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Clear all data for "${app.label}"? This action cannot be undone.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Data cleared', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Failed to clear data', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/**
 * Keymapping preset selector.
 */
async function showKeymapPicker(pkg, label) {
  try {
    const presets = await api.keymap.getPresets();
    const current = await api.keymap.getMap(pkg);
    const hasCurrent = current && current.length > 0;
    const lines = presets.map((p, i) => `${i + 1}. ${p.label} — ${p.desc}`);
    if (hasCurrent) lines.unshift('0. Clear current mapping');
    const msg = `Select keymapping preset for "${label}":\n\n${lines.join('\n')}\n\nEnter preset number:`;
    const input = window.prompt(msg, hasCurrent ? '0' : '1');
    if (input === null) return; // Cancelled
    const idx = parseInt(input, 10);
    if (hasCurrent && idx === 0) {
      await api.keymap.setMap(pkg, []);
      toast({ title: 'Keymapping cleared', body: label, type: 'ok' });
      return;
    }
    const presetIdx = hasCurrent ? idx - 1 : idx;
    if (presetIdx < 1 || presetIdx > presets.length) {
      toast({ title: 'Invalid selection', type: 'error' });
      return;
    }
    const chosen = presets[presetIdx - 1];
    await api.keymap.applyPreset(pkg, chosen.id);
    toast({ title: `Applied "${chosen.label}"`, body: `${label} · Keyboard controls active in app`, type: 'ok' });
  } catch (e) {
    toast({ title: 'Failed to set keymap', body: e.message, type: 'error' });
  }
}

/* ---------------- Settings ---------------- */

// ---------------- Android System Settings ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Loading…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Runtime not ready (${String(r.error).slice(0, 36)})` : 'Runtime not running';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · Wi-Fi ${r.wifi ? 'On' : 'Off'}` +
    `${r.airplane ? ' · Airplane Mode' : ''} · Volume ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Applied') : `Failed: ${(r && r.error) || 'Runtime not ready'}`,;
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi enabled' : 'Wi-Fi disabled'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Airplane mode enabled' : 'Airplane mode disabled'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Animations enabled' : 'Animations disabled (faster UI)'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Font size updated'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Display scaling updated'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Volume updated'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Optimized: animations off, background relaxed, battery whitelisted' : 'Optimization failed, runtime may not be running' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Please open an app first to start the runtime' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** Sync settings fields */
function syncBackendFields() {
  const perf = $('perfGroup');
  if (perf) perf.hidden = false;
  refreshResources();
}

/** Host resource limits and allocation note */
async function refreshResources() {
  const bNote = $('builtinResNote');
  if (!bNote) return;
  const gb = (mb) => (Number(mb) > 0 ? `${Math.round(Number(mb) / 1024)} GB` : 'Unknown');
  const r = await api.resources().catch(() => null);
  if (!r || r.ok === false) {
    bNote.textContent = (r && (r.note || r.error)) || 'Unable to retrieve resource allocation info';
    return;
  }
  const host = r.host || {};
  const lim = r.limits || {};
  const free = Number(r.freeMB) || Number((r.current && r.current.freeMB) || 0);
  bNote.textContent = `Host: ${gb(host.totalMB)} RAM / ${host.cores} cores. `
    + `Max assignable: ${gb(lim.maxMB)} RAM, ${Math.max(1, (host.cores || 1) - 1)} cores (reserves 25% RAM & 1 core for Windows). `
    + `Data partition limit: ${lim.maxGB || 0} GB${free ? ` (${(free / 1024).toFixed(1)} GB free on disk)` : ''}.`
    + (r.verdict && r.verdict.note ? ` ${r.verdict.note}` : '');
}

/** Preflight report renderer */
function renderPreflight(res) {
  const list = $('preflightList');
  const sum = $('preflightSummary');
  const applyBtn = $('btnPreflightApply');
  if (!list) return;
  list.textContent = '';
  if (!res || !res.report) {
    if (sum) sum.textContent = (res && res.error) || 'Preflight returned no result, please retry';
    return;
  }
  const { report, edition } = res;
  for (const it of report.items) {
    const item = document.createElement('div');
    item.className = 'pf-item';
    const head = document.createElement('div');
    head.className = 'pf-head';
    const dot = document.createElement('span');
    dot.className = `pf-dot ${it.level}`;
    const title = document.createElement('span');
    title.className = 'pf-title';
    title.textContent = it.title;
    head.append(dot, title);
    item.append(head);
    if (it.detail) {
      const d = document.createElement('div');
      d.className = 'pf-detail';
      d.textContent = it.detail;
      item.append(d);
    }
    if (it.action && it.action.kind === 'elevate') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action';
      const btn = document.createElement('button');
      btn.className = 'btn ghost sm';
      btn.textContent = it.action.label;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = 'Processing…';
        let r = null;
        if (it.action.id === 'accel') r = await api.enableAccel().catch(() => null);
        else r = await api.enableVirtualization().catch(() => null);
        btn.disabled = false;
        btn.textContent = old;
        if (!r) { toast({ type: 'error', title: 'Operation incomplete', body: 'Retry later or follow manual steps' }); return; }
        if (r.cancelled) toast({ type: 'warn', title: 'Cancelled', body: 'No system settings modified' });
        else if (r.ok || r.already) {
          const reboot = r.restartNeeded === true;
          toast({
            type: 'ok',
            title: r.already ? 'Hardware acceleration already active' : (reboot ? 'Applied, restart required' : 'Applied'),
            body: r.already ? '' : (reboot ? 'Hardware acceleration takes effect after PC restart; run Preflight to confirm' : 'Click Run Preflight to verify results'),
          });
          if (r.already || !reboot) setTimeout(() => runPreflight().catch(() => {}), 1200);
        } else {
          toast({ type: 'error', title: 'Automatic setup incomplete', body: (r.error || r.note || 'Follow manual steps') });
        }
      });
      wrap.append(btn);
      item.append(wrap);
    } else if (it.action && it.action.kind === 'manual') {
      const wrap = document.createElement('div');
      wrap.className = 'pf-action pf-detail';
      wrap.textContent = `⚠ ${it.action.label}`;
      item.append(wrap);
    }
    list.append(item);
  }
  const rec = report.recommended || {};
  if (sum) {
    sum.textContent = `${report.summary}. Recommended: ${Math.round((rec.memoryMB || 0) / 1024)} GB RAM / `
      + `${rec.cores || 2} cores / ${rec.renderSize || 'auto'} · Renderer ${rec.gpuMode || 'auto'}`
      + (edition === 'store' ? ' (Store edition: enable virtualization features in Windows Features)' : '');
  }
  if (applyBtn) applyBtn.hidden = false;
}

async function runPreflight() {
  const btn = $('btnPreflight');
  const sum = $('preflightSummary');
  if (!btn) return null;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running Preflight…';
  if (sum) sum.textContent = 'Checking virtualization, GPU, and RAM… (~2-3s on first run)';
  let r = null;
  try {
    r = await api.preflightRun();
  } catch (e) {
    r = { error: e.message || 'Preflight failed' };
  }
  btn.disabled = false;
  btn.textContent = old;
  renderPreflight(r);
  return r;
}

/** Drivers: render list and match status */
function renderDrivers(r) {
  const list = $('drvList');
  const sum = $('drvSummary');
  if (!list) return;
  const host = (r && r.host) || {};
  const drivers = (r && r.drivers) || [];
  const errors = (r && r.errors) || [];
  const onCount = drivers.filter((d) => d.enabled && d.matched).length;
  if (sum) {
    const accel = host.accel === 'none' ? 'No Accel' : (host.accel || 'Unknown');
    sum.textContent = `Host: ${host.platform || ''}/${host.arch || ''} · GPU: ${host.gpuVendor || 'Unknown'} · ${accel}`
      + ` · Emulator: ${host.emulatorVersion || 'Unknown'}; ${drivers.length} drivers, ${onCount} active on this machine.`
      + (errors.length ? ` ${errors.length} files failed to load (see below).` : '');
  }
  list.textContent = '';
  for (const d of drivers) {
    const item = document.createElement('div');
    item.className = d.enabled ? 'drv-item on' : 'drv-item';

    const head = document.createElement('div');
    head.className = 'drv-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!d.enabled;
    cb.addEventListener('change', async () => {
      const res = await api.driversSetEnabled(d.id, cb.checked).catch(() => null);
      if (res && res.ok && res.overview) renderDrivers(res.overview);
      else { cb.checked = !cb.checked; toast({ type: 'error', title: 'Save failed', body: (res && res.error) || 'Please try again later' }); }
    });
    const name = document.createElement('span');
    name.className = 'drv-name';
    name.textContent = d.name;
    head.append(cb, name);

    if (d.matched && d.enabled) {
      const b = document.createElement('span');
      b.className = 'drv-badge hit';
      b.textContent = 'Active';
      head.append(b);
    }
    if (d.builtin) {
      const b = document.createElement('span');
      b.className = 'drv-badge';
      b.textContent = 'Built-in Example';
      head.append(b);
    }
    item.append(head);

    const meta = document.createElement('div');
    meta.className = 'drv-meta';
    meta.textContent = `v${d.version || '?'}`
      + (d.author ? ` · ${d.author}` : '')
      + ` · priority ${d.priority}`
      + (d.hits && d.hits.length ? ` · Matched: ${d.hits.join(' / ')}` : ' · Not matched on host');
    item.append(meta);

    if (d.description) {
      const desc = document.createElement('div');
      desc.className = 'drv-meta';
      desc.textContent = d.description;
      item.append(desc);
    }
    list.append(item);
  }
  for (const e of errors) {
    const err = document.createElement('div');
    err.className = 'drv-err';
    err.textContent = `${String(e.file || '').split(/[\\/]/).pop()}：${(e.errors || []).join('；')}`;
    list.append(err);
  }
  if (!drivers.length && !errors.length) {
    const empty = document.createElement('div');
    empty.className = 'drv-meta';
    empty.textContent = 'No drivers installed. Click "Export Host Template" to create one, or import a JSON driver.';
    list.append(empty);
  }
}

async function refreshDrivers() {
  if (!$('drvList')) return;
  const r = await api.driversList().catch(() => null);
  if (!r) {
    if ($('drvSummary')) $('drvSummary').textContent = 'Cannot read drivers list (runtime may not be deployed)';
    return;
  }
  renderDrivers(r);
}

function fillSettings(s) {
  syncBackendFields();
  refreshDrivers().catch(() => {});
  $('setAdbPath').value = s.adbPath || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setLocale')) $('setLocale').value = eng.locale || 'zh-CN';
  if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
  if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
  if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
  $('setPortrait').value = d.portrait || '900x1600';
  // Default to native window; true indicates embedded mode
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** Data partition actual size and free disk space */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Failed to read data partition info'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  // Display note when quickboot overlay is active
  const img = info.overlay
    ? 'Quickboot diff disk (actual capacity governed by runtime /data)'
    : (info.fsGB ? `Filesystem: ${info.fsGB} GB` : (info.imageGB ? `${info.imageGB} GB` : 'Not created'));
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Unknown';
  const pending = Number(info.pendingGB) > 0
    ? ` Target ${info.configuredGB} GB not yet active: Android is using quickboot overlay; requires 'Reset Android Data' to rebuild at new size (wipes installed apps).`
    : '';
  el.textContent = `Current data partition: ${img}${auto ? ' (Auto)' : ''} · ${free} free on disk. ${pending}`
    + 'If games report insufficient storage, increase capacity here and click "Expand Now" (in-place expansion preserves data).';
}

/* ---------------- Settings: Category Nav + Search ---------------- */

/**
 * Settings category navigation (8 categories on left).
 * Must match data-cat in index.html, validated by test/settings-categories-test.js.
 */
const SETTINGS_CATS = [
  { id: 'basic', name: 'General & Setup' },
  { id: 'display', name: 'Display & Window' },
  { id: 'input', name: 'Controls & Input' },
  { id: 'perf', name: 'Performance & Resources' },
  { id: 'net', name: 'Network & Downloads' },
  { id: 'diag', name: 'Diagnostics & Repair' },
  { id: 'files', name: 'Integration & Files' },
  { id: 'about', name: 'Updates & About' },
];

const settingsCatState = { cat: 'basic', query: '' };

/** All settings groups with category tags */
function settingsGroups() {
  return Array.from(document.querySelectorAll('#settingsBody [data-cat]'));
}

/** Check if group matches search query */
function groupMatches(group, q) {
  if (!q) return true;
  const text = (group.textContent || '').toLowerCase();
  if (text.includes(q)) return true;
  const title = group.querySelector('.group-title');
  return !!title && title.textContent.toLowerCase().includes(q);
}

/** Switch active category */
function switchSettingsCat(cat, { keepQuery = false } = {}) {
  const target = SETTINGS_CATS.some((c) => c.id === cat) ? cat : 'basic';
  settingsCatState.cat = target;
  if (!keepQuery) settingsCatState.query = '';
  try { localStorage.setItem('apkstart.settings.cat', target); } catch (_) { /* ignore */ }
  const search = $('setSearch');
  if (search && !keepQuery) search.value = '';
  const clear = $('btnClearSearch');
  if (clear) clear.hidden = !settingsCatState.query;
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    b.classList.toggle('on', b.dataset.cat === target);
  });
  applySettingsFilter();
}

/**
 * Cross-category search matching.
 */
function applySettingsFilter() {
  const q = settingsCatState.query.trim().toLowerCase();
  const groups = settingsGroups();
  const hitPerCat = {};
  for (const g of groups) {
    const hit = groupMatches(g, q);
    const inCat = g.dataset.cat === settingsCatState.cat;
    g.hidden = q ? !hit : !inCat;
    if (hit) hitPerCat[g.dataset.cat] = (hitPerCat[g.dataset.cat] || 0) + 1;
  }
  // Highlight categories with matches during search
  document.querySelectorAll('#setNav .set-nav-item').forEach((b) => {
    const n = hitPerCat[b.dataset.cat] || 0;
    b.classList.toggle('dim', !!q && n === 0);
    b.title = q ? `${n} matched` : '';
  });
  // Hide divider on last visible group
  const visible = groups.filter((g) => !g.hidden);
  visible.forEach((g) => g.classList.remove('last-visible'));
  if (visible.length) visible[visible.length - 1].classList.add('last-visible');
  updateCatBadges();
}

/** Focus specific settings group */
function focusGroup(el) {
  if (!el) return;
  const cat = el.dataset && el.dataset.cat;
  if (cat) switchSettingsCat(cat);
  const body = $('settingsBody');
  if (body) body.scrollTop = 0;
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function bindSettingsCategory() {
  const nav = $('setNav');
  if (nav) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.set-nav-item');
      if (!btn) return;
      switchSettingsCat(btn.dataset.cat);
      const body = $('settingsBody');
      if (body) body.scrollTop = 0;
    });
  }

  const search = $('setSearch');
  const clear = $('btnClearSearch');
  if (search) {
    search.addEventListener('input', () => {
      settingsCatState.query = search.value || '';
      if (clear) clear.hidden = !settingsCatState.query;
      applySettingsFilter();
    });
    // Enter: jump to first matching group
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const hit = settingsGroups().find((g) => !g.hidden);
      if (hit) focusGroup(hit);
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      settingsCatState.query = '';
      if (search) search.value = '';
      clear.hidden = true;
      applySettingsFilter();
    });
  }

  // Persist active category
  try {
    const last = localStorage.getItem('apkstart.settings.cat');
    if (last && SETTINGS_CATS.some((c) => c.id === last)) settingsCatState.cat = last;
  } catch (_) { /* ignore */ }
  switchSettingsCat(settingsCatState.cat);
}

/* ---------------- Auto-Diagnostics (Auto-Debug) ---------------- */

/** Auto-diagnostics category names */
const DEBUG_CATS = [
  { id: 'runtime', name: 'Runtime' },
  { id: 'device', name: 'Device Connection' },
  { id: 'storage', name: 'Storage' },
  { id: 'settings', name: 'Settings' },
  { id: 'network', name: 'Network' },
  { id: 'logs', name: 'Logs' },
];

let autodebugLast = null;

function renderAutodebug(res) {
  const list = $('autodebugList');
  const txt = $('autodebugStateText');
  if (!list) return;
  autodebugLast = res || null;
  const issues = (res && res.issues) || [];
  const at = res && res.at;

  if (txt) {
    if (res && res.running) txt.textContent = 'Diagnosing…';
    else if (!at) txt.textContent = 'Not yet diagnosed';
    else if (!issues.length) txt.textContent = `Last check ${relTime(at)} · All systems operational`;
    else txt.textContent = `Last check ${relTime(at)} · ${issues.length} issue(s) found`;
  }

  if (!issues.length) {
    list.innerHTML = `<div class="dbg-ok">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      <span>No operational issues detected. Runtime, adb auth, disk, storage, snapshots, and settings verified.</span>
    </div>`;
    updateCatBadges();
    return;
  }

  const byCat = new Map();
  for (const it of issues) {
    const key = it.category || 'runtime';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  const order = DEBUG_CATS.map((c) => c.id);
  const keys = Array.from(byCat.keys()).sort((a, b) => {
    const ia = order.indexOf(a); const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  list.innerHTML = keys.map((key) => {
    const name = (DEBUG_CATS.find((c) => c.id === key) || {}).name || key;
    const items = byCat.get(key);
    return `<div class="dbg-group">
      <div class="dbg-group-title">${esc(name)}<span class="dbg-count">${items.length}</span></div>
      ${items.map((it) => `
        <div class="dbg-item ${esc(it.severity || 'info')}">
          <span class="dbg-sev"></span>
          <div class="dbg-body">
            <div class="dbg-name">${esc(it.title || '')}</div>
            <div class="dbg-hint">${esc(it.hint || '')}</div>
            ${it.detail ? `<div class="dbg-detail">${esc(it.detail)}</div>` : ''}
          </div>
          ${it.fix ? `<button class="dbg-fix" data-code="${esc(it.code)}">Fix</button>` : ''}
        </div>`).join('')}
    </div>`;
  }).join('');

  list.querySelectorAll('.dbg-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });

  updateCatBadges();
}

/** Issue count badge on category buttons */
function updateCatBadges() {
  const issues = (autodebugLast && autodebugLast.issues) || [];
  document.querySelectorAll('#setNav .set-nav-badge').forEach((el) => {
    const cat = el.dataset.badge;
    // Tag issues relevant to diagnostics & repair
    const n = cat === 'diag' ? issues.filter((i) => i.severity === 'error').length : 0;
    el.hidden = n === 0;
    el.textContent = n ? String(n) : '';
    el.classList.toggle('warn', false);
  });
}

function bindAutodebug() {
  const btn = $('btnAutodebugRun');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = 'Diagnosing…';
      try {
        const r = await api.autodebugRun().catch(() => null);
        if (r) renderAutodebug(r);
        else toast({ title: 'Diagnostic failed', body: 'Error collecting system state, retry later', type: 'error' });
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    });
  }

  const report = $('btnAutodebugReport');
  if (report) {
    report.addEventListener('click', async () => {
      const r = await api.doctorReport().catch(() => null);
      if (r && r.ok !== false) toast({ title: 'Diagnostic report exported', body: 'Report saved successfully', type: 'ok' });
      else toast({ title: 'Export failed', body: (r && r.error) || 'Please retry', type: 'error' });
    });
  }

  const auto = $('setAutodebugAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ auto: auto.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({
        title: auto.checked ? 'Auto-diagnostics enabled' : 'Auto-diagnostics disabled',
        body: auto.checked ? 'Checks periodically in background, alerts on new issues' : 'Run anytime manually with "Run Diagnostics Now"',
        type: 'info',
      });
    });
  }

  const interval = $('setAutodebugInterval');
  if (interval) {
    interval.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ intervalMin: Number(interval.value) }).catch(() => null);
      if (r) fillAutodebugSettings(r);
      toast({ title: 'Diagnostic interval updated', body: `Every ${r ? r.intervalMin : interval.value} minutes`, type: 'ok' });
    });
  }

  const notify = $('setAutodebugNotify');
  if (notify) {
    notify.addEventListener('change', async () => {
      const r = await api.autodebugConfig({ notify: notify.checked }).catch(() => null);
      if (r) fillAutodebugSettings(r);
    });
  }
}

function fillAutodebugSettings(cfg) {
  if (!cfg) return;
  const auto = $('setAutodebugAuto');
  if (auto) auto.checked = cfg.auto !== false;
  const interval = $('setAutodebugInterval');
  if (interval) interval.value = String(cfg.intervalMin || 10);
  const notify = $('setAutodebugNotify');
  if (notify) notify.checked = cfg.notify !== false;
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  fillAutodebugSettings((state.settings && state.settings.debug) || {});
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Associated · Click to Unregister' : 'Not Associated · Click to Register';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Auto Mode'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · Reclaimable: ${u.reclaimableText} (${u.count} items)` : ' · Clean'}`
      : 'Usage unavailable';
  }).catch(() => { $('usageText').textContent = 'Usage unavailable'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
  applySettingsFilter();
  // Display cached diagnostic results before background refresh
  api.autodebugState().then((r) => { if (r) renderAutodebug(r); }).catch(() => {});
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- Software Updates ---------------- */

let lastUpdate = null;

/** Render update check results */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Check failed: ${info.error || 'Network unreachable'}`;
    // Provide fallback link to release page on check failure
    showUpdateBtn(true);
    btn.textContent = 'Open Download Page';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // Indicate update source and unreachable endpoints
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join('、');
    const stale = info.stale ? ' (Cached offline)' : '';
    st.textContent = `New version available: ${info.tag}${src ? ` (${src})` : ''}${bad ? `; ${bad} unreachable` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Update Now' : 'Open Download Page';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Changelog:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? ' (Cached)' : '';
    st.textContent = `Up to date (v${info.current})${src ? ` · via ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** Override inline-flex on .btn */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Update failed: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Update failed', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Updating…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Checking…';
      $('updateState').textContent = 'Connecting to GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `New version ${info.tag} found`, body: 'Click "Update Now" to install', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Up to date', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Check failed: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Updating…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Update Now';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Update failed: ${r.error}`;
        toast({ title: 'Update failed', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Downloaded v${r.version}, restarting to complete installation…`;
    }
  });

  // Check for updates silently in background when settings open
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  if ($('btnPreflight')) $('btnPreflight').addEventListener('click', () => runPreflight());
  if ($('btnPreflightApply')) {
    $('btnPreflightApply').addEventListener('click', async () => {
      const btn = $('btnPreflightApply');
      btn.disabled = true;
      const r = await api.preflightApply().catch(() => null);
      btn.disabled = false;
      if (!r || !r.ok) {
        toast({ type: 'error', title: 'Apply failed', body: (r && r.error) || 'Please try again later' });
        return;
      }
      state.settings = r.settings;
      toast({
        type: 'ok',
        title: 'Configured for host system',
        body: `RAM: ${Math.round((r.recommended.memoryMB || 0) / 1024)} GB / ${r.recommended.cores} cores / ${r.recommended.renderSize}`
          + (r.driverFile ? '; Driver generated, active on next launch' : ''),
      });
      if (r.driverError) toast({ type: 'warn', title: 'Failed to write driver', body: r.driverError });
      fillSettings(r.settings);
      refreshStatus();
    });
  }
  if ($('btnDrvReload')) $('btnDrvReload').addEventListener('click', () => refreshDrivers());
  if ($('btnDrvFolder')) {
    $('btnDrvFolder').addEventListener('click', async () => {
      const r = await api.driversOpenFolder().catch(() => null);
      if (!r || !r.ok) toast({ type: 'error', title: 'Cannot open drivers folder' });
    });
  }
  if ($('btnDrvImport')) {
    $('btnDrvImport').addEventListener('click', async () => {
      const r = await api.driversImport().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) {
        toast({ type: 'error', title: 'Import failed', body: (r.errors || []).slice(0, 3).join('; ') });
        return;
      }
      toast({ type: 'ok', title: 'Driver imported and enabled', body: `${r.driver.name} v${r.driver.version}` });
      if (r.overview) renderDrivers(r.overview);
    });
  }
  if ($('btnDrvExport')) {
    $('btnDrvExport').addEventListener('click', async () => {
      const r = await api.driversExportTemplate().catch(() => null);
      if (!r || r.canceled) return;
      if (!r.ok) { toast({ type: 'error', title: 'Export failed' }); return; }
      toast({ type: 'ok', title: 'Template exported', body: 'Edit effect, place in drivers folder, and click Refresh' });
      refreshDrivers();
    });
  }

  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // RAM / Cores: explicit values disable autoMemory; 0 re-enables auto.
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // Resource policy updates liteMode, priorityMode, and renderSize
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Resource policy updated', body: 'Takes effect on next app launch', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setLocale')) {
    $('setLocale').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { locale: e.target.value } });
      toast({ title: 'System language updated', body: 'Takes effect on next runtime restart', type: 'ok' });
    });
  }
  if ($('setChineseIme')) {
    $('setChineseIme').addEventListener('change', async (e) => {
      state.settings = await api.setSettings({ engine: { chineseIme: e.target.checked } });
      toast({
        title: e.target.checked ? 'Chinese IME enabled' : 'Chinese IME disabled',
        body: 'Takes effect on next runtime restart',
        type: 'ok',
      });
    });
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Select capacity', body: 'Auto determines size based on free disk space', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: 'Expand Android data partition now?',
        message: `Adjusts /data partition to ${gb} GB (in-place expansion preserves installed apps and data).`,;
        detail: 'Requires stopping active apps. Next app launch will take ~15s longer to complete setup.',
        okLabel: 'Start Expansion',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Expanding…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      if (r && !r.ok && r.needsReset) {
        // Prompt confirmation before rebuild when quickboot overlay is active
        const again = await api.confirm({
          title: 'Reset required to resize data partition',
          message: `Quickboot overlay prevents in-place resizing. To allocate ${gb} GB, /data must be rebuilt at new size.`,;
          detail: 'Rebuilding wipes installed apps and user data (system image remains intact). Continue?',
          okLabel: 'Reset & Rebuild',
        });
        if (again.response !== 1) { refreshDataInfo(); return; }
        $('btnGrowData').disabled = true;
        $('btnGrowData').textContent = 'Rebuilding…';
        const rr = await api.resetAndResize(gb).catch((e) => ({ ok: false, error: e.message }));
        $('btnGrowData').disabled = false;
        $('btnGrowData').textContent = old;
        toast({
          type: rr && rr.ok ? 'ok' : 'error',
          title: rr && rr.ok ? 'Rebuilt at new capacity' : 'Rebuild failed',
          body: rr && rr.ok
            ? `Next launch will initialize /data at ${gb} GB (~30s longer on first boot)`
            : (rr && rr.error) || 'Unknown error',
        });
        refreshDataInfo();
        return;
      }
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Data partition expanded' : 'Expansion failed',
        body: r && r.ok ? `Approximately ${r.fsGB || r.imageGB || gb} GB available` : (r && r.error) || 'Unknown error',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // Reinstall or remove hooks based on window focus immediately
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  if ($('setKeymapEnabled')) {
    $('setKeymapEnabled').addEventListener('change', async (e) => {
      await api.keymap.setEnabled(e.target.checked);
      toast({ title: e.target.checked ? 'Keymapping enabled' : 'Keymapping disabled', type: 'ok' });
    });
  }
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // Re-enable disabled packages when trim background services is turned off
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'System components restored', body: 'Background services restoring', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM compatibility enabled', body: 'Requires Google Play compatible image (~1.5GB), click button below to download', type: 'info' });
    else if (on) toast({ title: 'ARM compatibility enabled', body: 'Takes effect after runtime restart', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Switched to Fullscreen' : 'Switched to Windowed', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Auto-fullscreen enabled' : 'Auto-fullscreen disabled', body: 'Takes effect on next launch', type: 'ok' });
    });
  }
  if ($('setOrientationMode')) {
    $('setOrientationMode').addEventListener('change', async (e) => {
      const mode = e.target.value;
      state.settings = await api.setSettings({ display: { orientationMode: mode } });
      toast({
        title: mode === 'auto' ? 'Orientation: Follow App' : (mode === 'landscape' ? 'Orientation: Force Landscape' : 'Orientation: Force Portrait'),
        body: mode === 'auto'
          ? 'Panel dynamically matches app orientation; restarts runtime once if an orientation switch is required.'
          : 'Restarts runtime once on next launch to switch panel orientation.'
        type: 'ok',
      });
    });
  }
  if ($('setAutoRotate')) {
    $('setAutoRotate').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoRotate: on } });
      toast({
        title: on ? 'Image auto-rotate enabled' : 'Image auto-rotate disabled',
        body: 'Injected into Android on next launch. Orientation policy takes precedence.',
        type: 'ok',
      });
    });
  }
  if ($('setTabletMode')) {
    $('setTabletMode').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { tabletMode: on } });
      toast({
        title: on ? 'Tablet layout enabled' : 'Tablet layout disabled',
        body: 'Takes effect on next launch (restarts runtime once to adjust display density).',
        type: 'ok',
      });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'Panel set to Landscape' : 'Panel set to Portrait',
        body: 'Restarts runtime once on next launch to switch panel orientation (~15s).',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Resolution updated', body: 'Takes effect on next app launch', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    // windowEmbedChosen flag records user explicit choice
    state.settings = await api.setSettings({
      display: { windowEmbed: embed, windowEmbedChosen: true },
    });
    toast({
      title: embed ? 'Switched to Embedded Mode' : 'Switched to Native Window',
      body: embed
        ? 'Takes effect on next launch. Embedded mode integrates into ApkStart frame with rotate controls.'
        : 'Takes effect on next launch. Native window delivers optimal FPS and fluid resizing.'
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Shortcuts restored' : 'Shortcuts up to date',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : 'Desktop and Start Menu shortcuts are valid',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Diagnostic report exported', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Export failed', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Clean', body: 'No reclaimable images or snapshots found.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Cleanup complete',
        body: `Reclaimed ~${(r.saved / 1048576).toFixed(0)} MB (${r.removed.length} items); installed apps preserved.`,;
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total: ${u.totalText} · Reclaimable: ${u.reclaimableText} (${u.count} items)`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Reset Android data: 2-step confirmation
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: 'Reset Android data?',
        message: 'This restores the Android system to a fresh install state:',
        detail: '• Deletes all installed user apps, saved data, and logins\n'
          + '• Deletes current AVD quickboot snapshot\n'
          + '• System images are preserved; next launch performs a clean cold boot\n\n'
          + 'This action cannot be undone. Continue?',
        buttons: ['Cancel', 'Continue'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirm Reset',
        message: 'All installed apps and user data will be permanently removed. Proceed?',
        detail: 'System images, other AVDs, local APK files, and shortcuts will not be affected.',
        buttons: ['Cancel', 'Confirm Reset'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Reset failed', body: (r && r.error) || 'Please retry', type: 'error' });
        return;
      }
      toast({
        title: 'Android data reset',
        body: `Reclaimed ~${r.reclaimedMB} MB; app records cleared.`,;
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total: ${u.totalText} · Reclaimable: ${u.reclaimableText} (${u.count} items)`;
    } catch (e) {
      toast({ title: 'Reset failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Network repair for Android VM
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: 'Repair VM network?',
        message: 'Endless loading or connection errors usually indicate Android VM network issues.',
        detail: 'Repair steps executed in sequence:\n\n'
          + '1. Cold-boots VM (bypassing snapshot) to reconnect — preserves all data\n'
          + '2. If unsuccessful, resets Android data — app list is preserved and reinstalled on launch\n\n'
          + 'Affects current AVD only; system images and APK cache preserved. Takes 1-5 mins. Proceed?',
        buttons: ['Cancel', 'Start Repair'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'Network still offline',
          body: (r && r.error) || 'VM remains offline. Please check host network and firewall settings.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Network restored',
        body: `${(r.network && r.network.ip) || 'Connected'}${r.wiped ? ' (Android data reset for network repair; apps will reinstall on launch)' : ' (All user data preserved)'}`,;
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Repair failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Clean leftovers from previous versions
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Scan failed', body: (r && r.error) || 'Please retry', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Clean', body: 'No leftover files from previous versions found.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}：${x.path}`);
      if (items.length > 8) lines.push(`…and ${items.length - 8} more`);
      const ok = await api.confirm({
        type: 'warning',
        title: 'Clean leftover files from previous versions?',
        message: `Found ${items.length} leftover items (~${mb} MB):`,;
        detail: `${lines.join('\n')}\n\nDeletes obsolete directories, broken uninstall entries, and update caches.\nActive installation and app data will not be touched.`,;
        buttons: ['Cancel', 'Start Cleanup'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Cleanup failed', body: (c && c.error) || 'Please retry', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} items in use skipped` : '';
      toast({
        title: 'Leftover files cleaned',
        body: `Removed ${c.removed.length} items, freed ${c.freedMB || 0} MB${failNote}.`,;
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total: ${u.totalText} · Reclaimable: ${u.reclaimableText} (${u.count} items)`;
    } catch (e) {
      toast({ title: 'Cleanup failed', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Rebuild desktop and start menu shortcuts
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Shortcuts rebuilt', body: fixed.join(', '), type: 'ok' }
        : { title: 'Shortcuts up to date', body: 'No missing shortcuts found', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Shared folder migration
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Directory selected', body: 'Click "Save & Migrate" to transfer existing files', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Please enter or browse to a directory', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Shared folder updated', body: moved ? 'Files migrated to new folder' : 'Saved', type: 'ok' });
    } else {
      toast({ title: 'Save failed', body: r.error, type: 'error' });
    }
  });

  // Uninstall ApkStart
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('Uninstall ApkStart?\n\nRemoves .apk file associations and program files. This action cannot be undone.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'Portable version cannot auto-uninstall',
        body: `Please manually delete program directory (${r.exeDir}) and data directory (${r.dataDir})`,;
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Uninstall failed', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Uninstalling…', body: 'Uninstaller started, ApkStart will now exit', type: 'ok', sticky: true });
  });

  // ARM compatibility image download with progress toast
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Downloading ARM compatibility image', body: 'Preparing…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Downloading ARM compatibility image', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM compatibility image ready', body: 'Takes effect after runtime restart', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Download failed', body: (r && r.error) || 'Unknown error', progress: null });
        t.dismiss();
        toast({ title: 'Download failed', body: (r && r.error) || 'Unknown error', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Download failed', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Compatibility image status display
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Ready (${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'Not downloaded';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Data directory updated', body: 'Please restart ApkStart for changes to take effect', type: 'ok', sticky: true });
  });

  // Android AVD and snapshot directory configuration
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Android data directory updated',
        body: 'Please restart ApkStart for changes to take effect. Move existing apkstart.avd to new directory.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Starting…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Ready: ${r.engine}` : `Start failed: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Built-in VM stopped';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Not Associated · Click to Register';
      btn.dataset.on = '0';
      toast({ title: '.apk file association removed' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Associated · Click to Unregister';
      btn.dataset.on = '1';
      toast({ title: '.apk association enabled', body: r.ok ? 'Double-clicking APKs will now install into ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- Event Listeners ---------------- */

function bindEvents() {
  // Open links in system browser
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // Status tag click navigates to Settings -> Runtime
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Runtime deployment buttons inside settings
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // Diagnostic count badge opens Settings -> Runtime
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) focusGroup(box);
      else focusGroup($('runtimeGroup'));
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Operation failed', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'System image imported', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Virtual disk imported', body: 'Runtime ready to start', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Import failed', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Starting runtime…', body: 'Booting Android OS', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Runtime ready', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Launch failed', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'Runtime session ended' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // Shared folder controls in Integration & Files group
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Shared folder synced', type: 'ok' });
    } catch (_) {
      toast({ title: 'Sync failed', body: 'Sync skipped when runtime is not ready', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // Add App card delegates to Install APK button file picker
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // Drag-and-drop installation
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Only .apk files are supported', type: 'error' });
  });

  // Main process events
  api.on('install:error', (p) => {
    // Clear sticky installation toast on failure
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Installation failed: ${name}` : 'Installation failed',
      body: friendlyInstallErrorText((p && p.message) || 'Unknown error'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // Update running badge when app terminates
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // Update welcome card with update alert after delayed check
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
  // Auto-diagnostics: refresh settings panel on background push
  api.on('autodebug:state', (r) => {
    if (r && r.running) {
      const txt = $('autodebugStateText');
      if (txt) txt.textContent = 'Diagnosing…';
      return;
    }
    renderAutodebug(r);
  });
}

/* ---------------- Startup ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindSettingsCategory();
  bindAutodebug();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- Welcome Card ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Good night';
  if (h < 11) return 'Good morning';
  if (h < 13) return 'Good afternoon';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** Welcome card display policy */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // Suppress welcome card in screenshot tests
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, welcome back`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? 'Runtime ready' : 'Runtime prepares automatically on demand'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Installed Apps' },
    { k: ready ? 'Ready' : 'Standby', v: 'Android Runtime' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Device / Port' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** Render welcome tips section */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`New version <b>${esc(lastUpdate.tag || '')}</b> available; update in Settings → Software Updates`);
  }
  if (!apps) {
    tips.push('Drag and drop APK files to install; desktop shortcuts are created automatically');
  } else {
    tips.push('Double-click app card to run in standalone window; controls in top-right bar');
  }
  tips.push('Closing window exits app while runtime remains ready for instant subsequent launch');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- Health Check ---------------- */

let envBusy = false;

/** System health check renderer */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* Health check failure does not block UI */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // Component missing already handled by One-Click Setup
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // Health check count in status bar opens Diagnostics panel
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} issue(s)` : `${issues.length} note(s)`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('；');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>System preflight passed; no runtime issues detected.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Re-check</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">System Health</span>
      ${errs ? `<span class="ec-count">${errs} critical</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} warning(s)</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Re-check</button>
      <button class="btn primary sm" id="btnEnvFixAll">Fix All</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Fix</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'Installer not bundled', body: 'Opening official Microsoft download page; please download x64 version', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'VC++ Runtime installed', type: 'ok' }
        : { title: 'Installation incomplete', body: r.error || 'Please retry', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Enabling hardware acceleration…', body: 'Please click Yes in the prompt', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Hardware acceleration enabled', body: r.restartNeeded ? 'Please restart PC for optimal performance' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else if (r.manual) {
        // Store MSIX edition: guide user to enable Windows Hypervisor Platform manually
        t.dismiss();
        await api.openWindowsFeatures?.().catch(() => null);
        toast({
          title: 'Manual configuration required (one-time)',
          body: r.note || 'Check "Windows Hypervisor Platform" in the opened window, click OK, and restart PC.',
          type: 'info',
          sticky: true,
        });
      } else if (r.cancelled) {
        t.update({ title: 'Cancelled', body: r.error || 'Admin authorization cancelled; no changes made.', type: 'info', spinner: false });
        setTimeout(t.dismiss, 4200);
      } else {
        t.update({ title: 'Failed to enable', body: r.error || r.note || 'Please retry', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // Main process shows native confirmation dialog with space preview
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Cleanup failed', body: 'Please retry', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Cleanup complete', body: `Freed ~${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'ASCII path recommended', body: 'Update Runtime Data Directory in Settings → Integration, then restart ApkStart.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Restoring missing runtime components…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Stale lock files cleaned', type: 'ok' } : { title: 'Cleanup failed', body: r.error, type: 'error' });
      break;
    }
    // ---- Auto-diagnostics fix actions ----
    case 'restartRuntime': {
      // Self-healing action: restart runtime
      const t = toast({ title: 'Restarting Android runtime…', body: 'Rebooting environment (~15s)', type: 'info', sticky: true, spinner: true });
      const r = await api.restartRuntime().catch(() => ({ ok: false }));
      if (r && r.ok) {
        t.update({ title: 'Android runtime restarted', body: 'Click Allow on USB debugging prompts', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: 'Restart failed', body: (r && r.error) || 'See diagnostic report', type: 'error' });
      }
      break;
    }
    case 'orphans': {
      const r = await api.clearOrphans().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'Orphaned emulator processes cleaned', type: 'ok' }
        : { title: 'Cleanup failed', body: (r && r.error) || 'Please retry', type: 'error' });
      break;
    }
    case 'snapshots': {
      const r = await api.clearSnapshot().catch(() => ({ ok: false }));
      toast(r && r.ok
        ? { title: 'Quickboot snapshot discarded', body: 'Next app launch will perform clean cold boot', type: 'ok' }
        : { title: 'Action failed', body: (r && r.error) || 'Please retry', type: 'error' });
      break;
    }
    case 'dataReset': {
      // Rebuild data partition when quickboot overlay is active
      toast({
        title: 'Android data partition rebuild required',
        body: 'Go to Settings → Performance & Resources and click Expand Now; confirm when prompted.',
        type: 'info',
        sticky: true,
      });
      openSettings().then(() => focusGroup($('perfGroup'))).catch(() => {});
      break;
    }
    case 'orientation': {
      // Match physical panel orientation to active policy
      const s = (state.settings && state.settings.display) || {};
      const mode = s.orientationMode || 'auto';
      if (mode === 'auto') {
        toast({ title: 'Active policy: Follow App', body: 'Panel orientation switches automatically per app.', type: 'info' });
        break;
      }
      const wantLandscape = mode === 'landscape';
      state.settings = await api.setSettings({ display: { landscape: wantLandscape } });
      fillSettings(state.settings);
      toast({
        title: wantLandscape ? 'Panel switched to Landscape' : 'Panel switched to Portrait',
        body: 'Takes effect on next launch',
        type: 'ok',
      });
      break;
    }
    case 'shared': {
      toast({ title: 'Check shared folder', body: 'Verify host shared folder in Settings → Integration & Files is writable.', type: 'info', sticky: true });
      openSettings().then(() => focusGroup(document.querySelector('#settingsBody [data-cat="files"]'))).catch(() => {});
      break;
    }
    case 'repairNetwork': {
      const t = toast({ title: 'Resetting Android network…', body: 'App list preserved', type: 'info', sticky: true, spinner: true });
      const r = await api.runtimeRepairNetwork().catch(() => ({ ok: false }));
      if (r && r.ok !== false) {
        t.update({ title: 'Android network reset', body: 'VM will reconnect on next launch', type: 'ok' });
        setTimeout(t.dismiss, 3000);
      } else {
        t.update({ title: 'Reset failed', body: (r && r.error) || 'Please retry', type: 'error' });
      }
      break;
    }
    case 'report': {
      const r = await api.doctorReport().catch(() => null);
      toast(r && r.ok !== false
        ? { title: 'Diagnostic report exported', body: 'Report saved successfully', type: 'ok' }
        : { title: 'Export failed', body: (r && r.error) || 'Please retry', type: 'error' });
      break;
    }
    case 'settings': {
      openSettings();
      break;
    }
    default:
      toast({ title: 'Auto-fix unavailable', body: issue.hint || '', type: 'info' });
  }
  // Re-run health check after fixes
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Initialization failed', body: e.message, type: 'error', sticky: true });
});
