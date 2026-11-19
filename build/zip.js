'use strict';
/**
 * Portable package compression (Windows zip).
 *
 * Why not PowerShell's `Compress-Archive`:
 * it uses .NET's built-in deflate (roughly zlib level 6) and turns the same 225MB directory into
 * 105,213,775 bytes, while 7-Zip's deflate (`-mx=9`) needs only 99,616,541 -- a 5.6MB difference.
 * Gitee caps a release attachment at 100MB (104,800,000 bytes uploaded fine in testing, while
 * 105,213,775 was split into part1/part2 and could not be extracted directly). Those 5MB decide whether
 * "users get a package they cannot extract, or have to download two files".
 *
 * So 7-Zip is used unconditionally, and Compress-Archive is only a loud fallback when it is absent.
 *
 * Usage:
 *   node build/zip.js <source dir> <output.zip> [--limit-mb 100]
 * Exit codes: 0 success / 1 failure / 2 over the size limit (CI treats that as failure; never ship split packages silently)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Find a standalone 7-Zip executable (7z.exe or 7za.exe) in the usual places */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // PATH (GitHub Actions' windows-latest ships 7-Zip on PATH)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // the 7zip cache electron-builder downloads (common on dev machines)
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* no cache directory */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Zip with 7-Zip: cwd is the source dir so paths inside stay relative and exclude the parent folder name */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip compression failed (${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Fallback: PowerShell Compress-Archive (5% bigger; only when 7-Zip is missing) */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive failed: ${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Verify the result: read it back with the app's own zip parser and compare entry count and total uncompressed bytes */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`entry count mismatch: ${names.length} in the archive, ${expect.files} in the source dir`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`total bytes mismatch: ${bytes} in the archive, ${expect.bytes} in the source dir`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('Usage: node build/zip.js <source dir> <output.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`Compressing ${srcDir} (${stats.files} files, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('Compressor:', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('WARNING: 7-Zip not found, falling back to Compress-Archive -- the artifact will be ~5% bigger and may exceed the Gitee single-file limit');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`Done: ${outZip}`);
  console.log(`  ${entries} entries, ${size} bytes (${(size / MIB).toFixed(2)} MiB), ratio ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`x Over the ${limitMiB} MiB limit (Gitee attachments are capped at 100MB). Slim the package down instead of splitting it.`);
    process.exit(2);
  }
  console.log(`  OK, within ${limitMiB} MiB (${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB to spare)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
