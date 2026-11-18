'use strict';
/**
 * Clean up legacy version leftovers.
 *
 * When users upgrade ApkStart, residual files frequently accumulate: portable versions create a new
 * ApkStart-vX.Y.Z-win64-portable directory for each release; NSIS installer upgrades may leave behind
 * uninstall entries pointing to deleted directories; update processes leave temporary packages in data dirs.
 *
 * This module performs ONLY **provably safe** cleanups:
 *   - Only matches directories that genuinely contain ApkStart.exe, and NEVER touches the currently running one;
 *   - Only deletes registry uninstall entries whose InstallLocation no longer exists (dead entries);
 *   - Only deletes its own update cache temporary files and shortcuts pointing to non-existent targets.
 * If unsure at any step, skip it and report the reason accurately to the UI.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* In use or permission denied, skip */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Find legacy version directories in several common candidate directories.
 *
 * Scans multiple discovery paths:
 *   - Common installation locations;
 *   - Shallow root directories of all local drives (many portable releases are placed directly at D:\ApkStart-...);
 *   - Real exe directories pointed to by existing shortcuts in Desktop and Start Menu.
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  // High-frequency locations in user home directory
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  // Root of each local drive (portable editions are often extracted directly to drive root)
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * Reverse lookup the real ApkStart.exe directory from shortcuts (.lnk / .desktop).
 * Most reliable discovery method: as long as user created a desktop or start menu shortcut,
 * target path is embedded inside.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk is binary, but target path is embedded in readable form; scan bytes for ApkStart*.exe
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* Skip unreadable */ }
    }
  }
  return [...dirs];
}

/** Legacy version directory: named like ApkStart*, contains ApkStart.exe, and is not current install directory */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Must genuinely be an ApkStart directory to avoid deleting similarly named folders
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'Legacy program directory (contains ' + EXE + ')',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // Directories found via shortcuts
  for (const d of rootsFromShortcuts()) {
    if (/^ApkStart/i.test(path.basename(d))) consider(d);
    // Also inspect sibling directories
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Registry uninstall entries pointing to non-existent directories */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // Split reg query output by blocks
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Only process dead entries whose targets are missing
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Invalid uninstall entry${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** Update cache / temporary packages */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'Temporary download files from updates' });
    }
  }
  return out;
}

/** Legacy / abandoned quickboot snapshots: default_boot was left by earlier versions (~3GB ram.img),
 *  *.stale-* are remnants from failed deletes renamed. Active snapshot is apkstart, never touch. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // Current active snapshot
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'Legacy quickboot snapshot' : 'Abandoned snapshot remnants',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Double-check: never delete currently running directory
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'This is the currently running version' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'Directory does not contain ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File is in use (another window may still be open)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File is in use' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Deletion failed' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
