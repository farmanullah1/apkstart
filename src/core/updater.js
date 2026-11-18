'use strict';
/**
 * Online updater: fetches latest release from GitHub Releases (farmanullah1/APK-START-English), downloads and replaces in place.
 *
 * Handles three distribution flavors:
 *   - Setup installer (NSIS): downloads `ApkStart-x.y.z-Setup.exe`, silent install (/S);
 *   - Portable zip: downloads `ApkStart-vX-win64-portable.zip`, unpacks and overwrites app folder;
 *   - Full portable (bundled runtime): same as portable zip, with runtime included.
 *
 * Replacement cannot happen inside this process (exe is locked), so a PowerShell script is generated
 * and handed to an independent process via EncodedCommand: waits for this process to exit -> copies files -> relaunches.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'farmanullah1';
const REPO = 'APK-START-English';

/** PowerShell single-quoted string: escape internal ' as '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Search for file in directory top level (case-insensitive), returns actual name or null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Find NSIS uninstaller in install directory, returns null if not found.
 * electron-builder defaults to `Uninstall <productName>.exe`, legacy packaging used `uninstaller.exe`.
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() used by sources: chooses GitHub/Gitee and mirror prefixes
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Installation flavor: setup installer (has uninstaller) or portable package */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Check for updates: queries GitHub and Gitee concurrently, taking higher version with union of assets.
   * Concrete download URLs undergo real-time speed ranking in prepare().
   * @param {{force?:boolean}} [opts] force=true skips 10-minute version cache
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // Exclude runtime bundles (ApkStart-runtime-*.zip) from fallback .zip matching.
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Preserve parts: Gitee chunked assets have no single URL
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // If asset exists on both GitHub and Gitee, keep both URLs for speed ranking in prepare().
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // Record which source was used and unreachable sources
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Download and prepare payload: portable extracts to update/<ver>/payload, installer keeps Setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('This release has no automatically installable package, please download manually from the GitHub releases page');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Gitee has a 100MB per-file upload limit, splitting packages into .part1/.part2.
    // Each part is speed-tested and downloaded, then assembled in order.
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Downloading ${it.asset.name}...` });
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti: concurrent chunked download from direct and mirror connections.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Downloading ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      // If previous download + extract succeeded, reuse payload directly (avoids update loop).
      if (this._payloadReady(out, it.version)) {
        this.onProgress({ stage: 'ready', percent: 100, message: 'Existing downloaded update package found, reusing directly' });
        return { mode: 'zip', payload: out, version: it.version };
      }
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Update package extracted successfully' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Installer package downloaded successfully' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Download and assemble chunked package parts.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Downloading ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (part ${part.index}/${asset.parts.length})${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Part ${part.index} size mismatch (${buf.length} ≠ ${part.size}), aborted, retry available`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Assembled update package size mismatch (${doneBytes} ≠ ${total}), aborted, retry available`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // Prevent zip-slip: route through zip.js guards
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Extracting ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** Payload ready marker file: written only after complete extraction */
  _readyFile(payload) { return path.join(payload, '.apkstart-ready'); }

  _markPayloadReady(payload, version) {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ version, at: Date.now() }), 'utf8');
    } catch (_) { /* Failure to write marker is non-fatal */ }
  }

  _payloadReady(payload, version) {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      // Version mismatch: cannot reuse
      if (m.version !== version) return false;
      // Critical: main application executable must exist inside payload
      const exeName = path.basename(this.exePath || 'ApkStart.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Called on startup: find previously extracted update jobs where restart failed.
   * Directly uses local payload without re-downloading.
   * @returns {{mode:'zip', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => cmpVer(n, this.current) > 0)   // Only newer versions
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * Generate and launch replace-and-restart script, caller is responsible for exiting app.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts]
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // Wait for process to exit (up to 90s), otherwise exe/dll remains locked
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // Rename target exe to .old before copying, verify new exe on disk; rollback on failure
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // Clean payload and ready marker only after successful copy
        `  try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // Relaunch via Start-Process with fallback to cmd /c start
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // On copy failure retain version directory for next startup resume
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand with UTF-16LE base64 prevents character encoding issues
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Use regular child process with unref rather than detached to avoid security software blocking
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Open releases page in browser when UI cannot open or no automated asset is available */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
