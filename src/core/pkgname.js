'use strict';
/**
 * Android package name validation.
 *
 * Package names originate from AndroidManifest.xml within an APK (untrusted input)
 * and are used in local filesystem paths (store.iconPath / apkPath) and adb shell commands
 * (pm path / pidof / am start…).
 * Without validation, directory traversals ("../"), drive letters, or shell metacharacters
 * could cause arbitrary writes or command injection.
 *
 * Practical Android package name constraints: dot-separated identifiers starting with
 * a letter/underscore followed by letters/digits/underscores. Strictly validated via ASCII
 * to prevent any path separators or shell metacharacters.
 */
const RE_PKG = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function validPackageName(pkg) {
  return typeof pkg === 'string' && RE_PKG.test(pkg);
}

/** Rewrites invalid package names into safe filenames (for logging/fallback display only, not installation) */
function safeFilePart(pkg) {
  if (validPackageName(pkg)) return pkg;
  return `invalid-${String(pkg || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
}

module.exports = { validPackageName, safeFilePart, RE_PKG };
