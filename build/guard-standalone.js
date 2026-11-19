'use strict';
/**
 * Standalone guard: **no third-party emulator file** may appear in an installer.
 *
 * Why a build-time check is necessary:
 *   ApkStart installers (NSIS / portable / MSIX) must work out of the box -- they carry emulator +
 *   platform-tools + the system image, so the app runs right after install without asking users to install MuMu / LDPlayer / BlueStacks.
 *   Since 0.5.6 it goes further: **the code has no third-party backend at all** -- it is not "bundled runtime + optional
 *   reuse" but "bundled runtime only". So besides binaries, this also blocks the backend adapter sources
 *   (backends/mumu.js / backends/fydeos.js / mumu-compat.js) -- if anyone adds them back, the build fails
 *   outright, so a path that takes over someone else's emulator cannot quietly return.
 *
 *   This constraint is easy to break silently: someone copies a MuMu directory into build/runtime as the runtime,
 *   or drops an emulator directory into resources before packaging. The app still works on the dev machine,
 *   but users end up having to install another emulator -- a problem that only shows up on someone else's PC.
 *   Hence a filename scan before packaging that fails the build on any hit.
 */

const fs = require('fs');
const path = require('path');

/**
 * Once these names appear in build output, someone's emulator has been bundled.
 * Match only each emulator's own signature filenames, never broad patterns like /android/, to avoid false positives.
 */
const BANNED = [
  { re: /^mumu/i, vendor: 'MuMu emulator' },          // MuMuManager.exe / MuMuPlayer.exe / MuMuVMMVbox
  { re: /\.nemu$/i, vendor: 'MuMu emulator' },        // instance descriptor MuMuPlayer-12.0-0.nemu
  { re: /^nemu$/i, vendor: 'MuMu emulator' },         // MuMu's nemu directory
  { re: /^nx_main$/i, vendor: 'MuMu emulator' },      // MuMu's nx_main / nx_device directories
  { re: /^nx_device$/i, vendor: 'MuMu emulator' },
  { re: /^ldplayer/i, vendor: 'LDPlayer emulator' },
  { re: /^dnplayer/i, vendor: 'LDPlayer emulator' },
  { re: /^bluestacks/i, vendor: 'BlueStacks emulator' },
  { re: /^hd-player/i, vendor: 'BlueStacks emulator' },
  { re: /^mgalaxy/i, vendor: 'MEmu emulator' },
];

/** Only these extensions count as "the emulator itself"; .js/.md/.json are source and config, out of scope */
const BINARY_EXT = /\.(exe|dll|sys|nemu|vdi|vmdk|vbox|iso|msi|bin|dat|db|img)$/i;

/**
 * Recursively find matching files and directories.
 * @param {string} dir root to scan (usually the packaged resources/runtime or app directory)
 * @param {object} [opts] { limit } stop after this many hits (default 20, enough to explain the problem)
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findBundled(dir, { limit = 20 } = {}) {
  const hits = [];
  const walk = (d) => {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return; // no permission / does not exist: treat it as empty
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const hit = BANNED.find((b) => b.re.test(e.name));
      // Directories count immediately; files must look like binaries (otherwise backends/mumu.js in source is mistaken for MuMu itself)
      if (hit && (e.isDirectory() || BINARY_EXT.test(e.name))) {
        hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.vendor });
        continue; // once a directory matched, do not descend -- reporting it is more useful
      }
      if (e.isDirectory()) walk(path.join(d, e.name));
    }
  };
  walk(dir);
  return hits;
}

/**
 * Third-party backend adapter sources (their presence means the ability to reuse someone else's emulator came back).
 * These are .js, not covered by BINARY_EXT, so they are checked separately.
 */
const BANNED_SOURCE = [
  { re: /^mumu\.js$/i, what: 'MuMu backend adapter' },
  { re: /^fydeos\.js$/i, what: 'FydeOS backend adapter' },
  { re: /^mumu-compat\.js$/i, what: 'MuMu compatibility policy' },
  { re: /^frame\.js$/i, what: 'MuMu frame check' },
];

/**
 * Find third-party backend sources in build output.
 * Only "backends/xxx.js" or those exact names directly under src/core count, so an unrelated frame.js is left alone.
 * @param {string} dir
 * @returns {Array<{path: string, name: string, vendor: string}>}
 */
function findForbiddenSource(dir) {
  const hits = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    const dirName = path.basename(d);
    for (const e of entries) {
      if (e.isDirectory()) { walk(path.join(d, e.name)); continue; }
      const hit = BANNED_SOURCE.find((b) => b.re.test(e.name));
      if (!hit) continue;
      // Only these exact locations: mumu|fydeos under backends/, mumu-compat / frame under core/.
      // Same-named files elsewhere (the renderer's frame.js, for instance) are ignored to avoid false positives.
      const suspicious = dirName === 'backends' || (dirName === 'core' && !/^builtin\.js$/i.test(e.name));
      if (suspicious) hits.push({ path: path.join(d, e.name), name: e.name, vendor: hit.what });
    }
  };
  walk(dir);
  return hits;
}

/**
 * Assert that a directory contains no third-party emulator.
 * @param {string} dir
 * @param {object} [opts] { label, exit } label appears in messages; exit=false returns the result without killing the process
 * @returns {{ok: boolean, skipped?: boolean, hits: Array}}
 */
function assertStandalone(dir, { label = 'build output', exit = true } = {}) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, skipped: true, hits: [] };
  const hits = findBundled(dir).concat(findForbiddenSource(dir));
  if (!hits.length) return { ok: true, hits: [] };

  const vendors = [...new Set(hits.map((h) => h.vendor))].join(' / ');
  console.error(`\n[guard] ${label} contains third-party emulator files (${vendors}):`);
  for (const h of hits) console.error(`  - ${h.path}`);
  console.error('');
  console.error('An ApkStart installer must bundle its runtime and run standalone: it may not depend on or bundle another emulator,');
  console.error('and the adapter sources that take over someone else\'s emulator must not come back.');
  console.error('Delete those paths from the packaged directory and try again.\n');
  if (exit) process.exit(4);
  return { ok: false, hits };
}

module.exports = { BANNED, BANNED_SOURCE, findBundled, findForbiddenSource, assertStandalone };
