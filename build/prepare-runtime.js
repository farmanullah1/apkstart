'use strict';
/**
 * Turn engine/ into a runtime that can ship with the package: build/runtime/
 *
 * The key step is compressing system.img. AOSP's system.img is a 3.1GB sparse image that is
 * almost entirely zeros, which gzip shrinks to ~580MB. A single-file release is essentially all of this.
 * Add emulator (~340MB after slimming) + Electron + platform-tools and the whole package is ~1.0-1.1GB.
 * Uncompressed, the release would have to be 1.4GB or more.
 * The cost is 1-2 minutes on first launch to extract it into the user directory (once);
 * the extraction lives in materializeImages() in src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Prebuilt /data seed template (formatted ext4, xz-compressed). See the userdata.img notes below.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Large images use XZ (LZMA2): about 25% smaller than gzip -6 (system.img 1.5GB -> ~1.1GB).
 *  Defaults to the extreme 9e preset; a two-core CI can set XZ_PRESET=6 to cut the time to a third (+3% size).
 *
 *  Implementation notes (lessons learned):
 *   - Use Python's lzma (single-threaded, stable). @napi-rs/lzma's createCompressStream hangs
 *     producing zero bytes in some environments (18 minutes with no output, measured), so it is only a last resort, with a timeout.
 *   - [The real reason CI once hung for three hours] The source file must be piped into the child's stdin and closed afterwards.
 *     Python does `shutil.copyfileobj(sys.stdin.buffer, z)`, so without EOF it waits for input forever,
 *     writes not a single byte to stdout and never exits. Only p.stdout was wired up at the time, and locally an
 *     existing .xz hid it behind "skip duplicate compression", while a fresh CI directory always hit it.
 *   - Add a watchdog too: whatever the compressor does, it is killed and gzip takes over, so packaging never hangs forever.
 *   - No python / compression fails -> gzip -9 (slightly bigger but can never hang);
 *     materializeImages picks the extractor by extension, so both outputs work.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* try the next one */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Two hours by default (3GB / 2 cores / preset 6 measured ~40min); on timeout kill it and fall back to gzip.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Attach listeners first, so a child that exits before we await does not lose its close event.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (xz compression exceeded ${Math.round(timeoutMs / 60000)} minutes, aborting and switching to gzip -9)`);
      try { p.kill(); } catch (_) { /* already exited */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Key: stdin is the compressor's input. pipeline ends(p.stdin) after reading src,
      // so Python sees EOF, flushes the XZ tail block and exits normally.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Kill the child at once on any stream error (EPIPE / write failure); do not wait for the watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // A half-written .xz would poison the artifact, so delete it before falling back.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} compression failed, switching to gzip -9)`);
  } else {
    console.log('  (python not found, switching to gzip -9 (slightly bigger but reliable))');
  }
  // Fallback: gzip -9 (not xz; materializeImages picks the extractor by extension)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime is up to date (add --force to rebuild)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('engine/ is missing, cannot prepare the runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy emulator / platform-tools directly (without historical leftovers)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Copying ${dir}...`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Slimming: delete files that never load under our fixed launch parameters (~-400MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('Slimming the runtime...');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. System images: large ones are compressed to .xz (materializeImages streams the extraction at runtime), the rest are copied as-is
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt is the GMS licence text (~20MB) and is not needed to run
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img uses the prebuilt ext4 template (seed) from the repo:
            // the one in the official sys-img is 1MB of zeros, so e2fsck always returns code=8 when the emulator grows it,
            // the partition stays at 1MB -> guest invalid magic -> /data read-only -> a fresh install can never boot.
            // The template is generated once at build time (mke2fs) and then versioned with the code, so CI needs no extra toolchain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img uses the prebuilt ext4 template (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Large images are compressed and the original never ships; skip recompression when a compressed artifact already exists (and looks sane)
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // The gzip fallback produces .gz, which must be accepted too, or every rebuild recompresses 3GB.
              // The threshold is >1MB rather than a compression ratio: vendor.img.gz is only ~21MB and userdata.img is nearly all zeros,
              // so a fixed large threshold or a "compression ratio" test would wrongly recompress these valid artifacts.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Skipping ${f} (already has ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Compressing ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) -> XZ 9e (slow, one-off)...`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Done: build/runtime (${(total / 1073741824).toFixed(2)} GB, compressed ${gzCount} large images)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Callable directly from regression tests (without running main's full preparation)
module.exports = { xzFile, gzipFile, findPython };
