'use strict';
/**
 * Microsoft Store (MSIX) packaging.
 *
 * Why not electron-builder's appx target:
 *   - 26.x only has appx (no msix), and at build time it quietly downloads a whole Windows SDK
 *     toolset (windows-kits-bundle-10_0_26100_0.zip) as a black-box dependency;
 *   - we need to put our own things in the manifest (runFullTrust, file associations, the identity
 *     details matching the review notes), and a hand-written manifest is more controllable than patching theirs.
 * So this script assembles the stage and calls makeappx itself, depending only on two SDK executables.
 *
 * Usage:
 *   node build/msix.js                       # package dist/release/win-unpacked unsigned
 *   node build/msix.js --stage <dir>         # use an already-unpacked directory
 *   node build/msix.js --sign                # also create a self-signed certificate and sign (for local testing)
 *   node build/msix.js --identity Name --publisher "CN=..." --display name
 *
 * Environment variables work too: APKSTART_MSIX_IDENTITY / APKSTART_MSIX_PUBLISHER / APKSTART_MSIX_DISPLAY
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodePng, drawAppIcon } = require('../src/core/png');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// ---------------- Arguments ----------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const VERSION = String(pkg.version || '0.0.0');
// An MSIX Version must have four parts, and the fourth is fixed at 0 (Store requirement)
function msixVersion(v) {
  const p = String(v).split(/[.\-+]/).filter((x) => /^\d+$/.test(x)).slice(0, 3);
  while (p.length < 3) p.push('0');
  return `${p[0]}.${p[1]}.${p[2]}.0`;
}

// The two values confirmed under Partner Center -> Product management -> Product identity.
// Written in as defaults: the default used to be the placeholder `CN=farmanullah1`, so simply running
// `node build/msix.js` once would overwrite a good package with one the Store is bound to reject.
const PLACEHOLDER_PUBLISHER = 'CN=farmanullah1';
const CONFIRMED_IDENTITY = 'farmanullah1.ApkStart';
const CONFIRMED_PUBLISHER = 'CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D';
const IDENTITY = arg('identity') || process.env.APKSTART_MSIX_IDENTITY || CONFIRMED_IDENTITY;
const PUBLISHER = arg('publisher') || process.env.APKSTART_MSIX_PUBLISHER || CONFIRMED_PUBLISHER;
const PUBLISHER_DISPLAY = arg('publisherDisplay') || process.env.APKSTART_MSIX_PUBLISHER_DISPLAY || 'farmanullah1';
const DISPLAY = arg('display') || process.env.APKSTART_MSIX_DISPLAY || 'ApkStart';
const APP_ID = arg('appId') || 'ApkStart';
const DO_SIGN = !!arg('sign', false);

const STAGE = path.resolve(String(arg('stage')
  || path.join(ROOT, 'dist', 'release', 'win-unpacked')));
const OUT_DIR = path.resolve(String(arg('out') || path.join(ROOT, 'dist', 'store')));

/**
 * Choose the "payload directory": the ApkStart.exe + resources that go under `app\` in the MSIX.
 *
 * Two sources, preferring the offline one:
 *   A. dist/ApkStart-win64-portable -- the output of `node build/pack.js`, **needs no network**.
 *      It holds only the shell without the runtime, so build/runtime is copied in here as
 *      resources/runtime (exactly what electron-builder's extraResources does).
 *   B. dist/release/win-unpacked -- the output of `electron-builder --win dir`, which already has
 *      resources/runtime. But that step pulls the toolset from a CDN, and offline it half-extracts
 *      (only electron.exe, runtime never copied), so it is only the fallback.
 *
 * Use --payload to specify one explicitly.
 */
function resolvePayload() {
  const explicit = arg('payload');
  if (explicit) return { dir: path.resolve(String(explicit)), addRuntime: false };
  const portable = path.join(ROOT, 'dist', 'ApkStart-win64-portable');
  const runtime = path.join(ROOT, 'build', 'runtime');
  if (fs.existsSync(path.join(portable, 'ApkStart.exe'))) {
    const hasRuntime = fs.existsSync(path.join(portable, 'resources', 'runtime', 'emulator', 'emulator.exe'));
    return { dir: portable, addRuntime: !hasRuntime && fs.existsSync(runtime), runtime };
  }
  return { dir: STAGE, addRuntime: false };
}

// ---------------- Asset icons ----------------
// The manifest lists only the five 100% images. As soon as .scale-* / .targetsize-* files appear in the
// folder, resources.pri (makepri) has to be generated too and the complexity explodes -- v1 avoids that.
const ASSETS = [
  { file: 'StoreLogo.png', w: 50, h: 50 },
  { file: 'Square44x44Logo.png', w: 44, h: 44 },
  { file: 'Square71x71Logo.png', w: 71, h: 71 },
  { file: 'Square150x150Logo.png', w: 150, h: 150 },
  { file: 'Square310x310Logo.png', w: 310, h: 310 },
  { file: 'Wide310x150Logo.png', w: 310, h: 150 },
  { file: 'SplashScreen.png', w: 620, h: 300 },
];

const BG = [20, 22, 27];        // #14161b dark base
const ACCENT = [61, 220, 132];  // #3ddc84 Android green

/** Rounded-rect hit test (used to draw the brand icon on a non-square canvas) */
function inRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/** Draw the brand icon (rounded dark block + green play triangle) at the centre of a w x h canvas */
function composeIcon(w, h, side) {
  const rgba = new Uint8Array(w * h * 4);
  const ox = (w - side) / 2;
  const oy = (h - side) / 2;
  const pad = side * 0.06;
  const box = { x: ox + pad, y: oy + pad, w: side - pad * 2, h: side - pad * 2, r: side * 0.24 };
  const tW = side * 0.30;
  const tH = side * 0.34;
  const tcx = ox + side * 0.5 + side * 0.02;
  const tcy = oy + side * 0.5;
  const ax = tcx - tW * 0.38;
  const ay = tcy - tH / 2;
  const bx = tcx - tW * 0.38;
  const by = tcy + tH / 2;
  const cx2 = tcx + tW * 0.62;
  const cy2 = tcy;
  const inTri = (px, py) => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx2) * (by - cy2) - (bx - cx2) * (py - cy2);
    const d3 = (px - ax) * (cy2 - ay) - (cx2 - ax) * (py - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Backplate: the whole surface is dark (tiles and splash screens are full-bleed backgrounds)
      let r = BG[0];
      let g = BG[1];
      let b = BG[2];
      let a = 255;
      const px = x + 0.5;
      const py = y + 0.5;
      if (inRoundRect(px, py, box.x, box.y, box.w, box.h, box.r)) {
        const t = (x / w) * 0.6 + (y / h) * 0.4;
        r = Math.round(20 + t * 14);
        g = Math.round(26 + t * 18);
        b = Math.round(33 + t * 24);
        if (inTri(px, py)) { r = ACCENT[0]; g = ACCENT[1]; b = ACCENT[2]; }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  return encodePng(w, h, rgba);
}

/** Pre-rendered assets: the main mark and the small-size simplified mark produced by build/build-icons.js */
const STORE_ASSETS = path.join(ROOT, 'build', 'store-assets');

function writeAssets(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const made = [];
  for (const a of ASSETS) {
    const pre = path.join(STORE_ASSETS, a.file);
    let buf = null;
    if (fs.existsSync(pre)) {
      buf = fs.readFileSync(pre);
    } else {
      // Fallback: still builds when build-icons never ran, but icons may not stay consistent across sizes
      buf = (a.w === a.h)
        ? drawAppIcon(a.w)
        : composeIcon(a.w, a.h, Math.min(a.h * 0.72, a.w * 0.42));
      console.warn(`  [fallback] ${a.file} not found in build/store-assets, drawing it procedurally instead`);
    }
    fs.writeFileSync(path.join(dir, a.file), buf);
    made.push(`${a.file} ${a.w}x${a.h}`);
  }
  return made;
}

// ---------------- Manifest ----------------

function manifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!--
  ApkStart · Microsoft Store (MSIX) manifest
  Generated by build/msix.js -- do not edit by hand; change the generator instead.

  Two fields that must match Partner Center character for character:
    Identity/@Name          ← Product identity → Package/Identity/Name
    Identity/@Publisher     ← Product identity → Package/Identity/Publisher
  For local self-signed testing, Publisher must equal the subject of the self-signed certificate.
-->
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">

  <Identity
    Name="${IDENTITY}"
    Publisher="${PUBLISHER}"
    Version="${msixVersion(VERSION)}"
    ProcessorArchitecture="x64" />

  <Properties>
    <DisplayName>${DISPLAY}</DisplayName>
    <PublisherDisplayName>${PUBLISHER_DISPLAY}</PublisherDisplayName>
    <Description>${pkg.description || DISPLAY}</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>

  <Resources>
    <Resource Language="en-US" />
    <Resource Language="zh-CN" />
  </Resources>

  <Capabilities>
    <!-- The only capability a fully trusted desktop app (Desktop Bridge) needs. -->
    <rescap:Capability Name="runFullTrust" />
    <!--
      unvirtualizedResources / broadFileSystemAccess are deliberately not declared:
      the former is only granted to PC games shipped by Microsoft and its partners and the Store rarely approves it;
      the latter exists so AppContainer apps can leave the sandbox, while full-trust apps already run as the user.
      To avoid the AppData write redirection the data directory lives at %USERPROFILE%\\ApkStart,
      entirely outside the virtualized scope (see STORE_BUILD in src/core/store.js).
    -->
  </Capabilities>

  <Applications>
    <Application Id="${APP_ID}" Executable="app\\ApkStart.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${DISPLAY}"
        Description="${pkg.description || DISPLAY}"
        BackgroundColor="#14161B"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <!--
          Small/large tile logos can only hang off uap:DefaultTile and must not be written as
          uap:VisualElements attributes -- in the wrong place MakeAppx rejects the whole package:
          "?? DTD/??????? 'VisualElements' ??? 'Square71x71Logo'?"
          （0x80080204 The package manifest is not valid）
        -->
        <uap:DefaultTile Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square71x71Logo="Assets\\Square71x71Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png" />
        <uap:SplashScreen Image="Assets\\SplashScreen.png" BackgroundColor="#14161B" />
      </uap:VisualElements>
    </Application>
  </Applications>
</Package>
`;
}

// ---------------- Locate makeappx / signtool ----------------

function which(exe) {
  const cands = [];
  const push = (p) => { if (p) cands.push(p); };
  // 1) PATH
  const envPath = process.env.PATH || '';
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
  }
  // 2) Windows SDK (any 10.0.x version, x64 preferred)
  const kits = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Windows Kits', '10', 'bin'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'App Certification Kit'),
  ];
  for (const k of kits) {
    let versions = [];
    try { versions = fs.readdirSync(k); } catch (_) { continue; }
    for (const v of versions) {
      for (const arch of ['x64', 'x86', '']) {
        const p = arch ? path.join(k, v, arch, exe) : path.join(k, v, exe);
        try { if (fs.statSync(p).isFile()) push(p); } catch (_) { /* next */ }
      }
    }
  }
  // 3) the tool cache electron-builder downloaded itself (present after one --win appx run)
  const cacheRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const stack = [cacheRoot];
  let guard = 0;
  while (stack.length && guard < 6000) {
    const dir = stack.pop();
    guard += 1;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === exe.toLowerCase()) push(p);
    }
  }
  if (!cands.length) return null;

  /**
   * Pick the newest toolset.
   *
   * This step matters: the winCodeSign toolset contains three generations of signtool.exe --
   * windows-6 / windows-8 / windows-10. The windows-6 build fails signing MSIX with
   * `0x80080209 (SignerSign failed)` -- it does not understand the MSIX SIP structure yet.
   * So windows-10\x64 must be preferred explicitly instead of "use whichever turns up first".
   */
  const score = (p) => {
    const l = p.toLowerCase();
    let s = 0;
    if (/\\windows-10\\x64\\/.test(l)) s += 100;
    else if (/\\windows-10\\/.test(l)) s += 60;
    if (/\\windows-1[01]\\x64\\/.test(l)) s += 40;
    if (/\\x64\\/.test(l)) s += 10;
    if (/\\windows-6\\|\\windows-8\\|\\darwin\\|\\linux\\/.test(l)) s -= 200;
    return s;
  };
  cands.sort((a, b) => (score(b) - score(a)) || b.localeCompare(a, 'en'));
  return cands[0];
}

function run(exe, args, opts = {}) {
  return execFileSync(exe, args, { stdio: 'inherit', windowsHide: true, ...opts });
}

// Standalone guard: no MuMu or other third-party emulator may appear in the MSIX (the bundled runtime is the only dependency)
const { assertStandalone } = require('./guard-standalone');

// ---------------- Main flow ----------------

function stagePackage() {
  const pick = resolvePayload();
  const appSrc = pick.dir;
  if (!fs.existsSync(path.join(appSrc, 'ApkStart.exe'))) {
    console.error(`\nCould not find ${path.join(appSrc, 'ApkStart.exe')}.`);
    console.error('Two ways forward:');
    console.error('  A) node build/pack.js          (offline, recommended; this script copies build/runtime in for you)');
    console.error('  B) npx electron-builder --win dir --x64 --config electron-builder.yml');
    console.error('     -- that step pulls the toolset from a CDN, half-extracts offline, and leaves win-unpacked incomplete.\n');
    process.exit(1);
  }
  const work = path.join(OUT_DIR, '.stage');
  fs.rmSync(work, { recursive: true, force: true });
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  console.log(`Copying the app payload (source ${appSrc})...`);
  fs.cpSync(appSrc, appDir, { recursive: true });
  // Electron/electron-builder intermediates that must not ship
  for (const junk of ['builder-debug.yml', 'builder-effective-config.yaml', '.icon-ico', 'VERSION.txt']) {
    fs.rmSync(path.join(appDir, junk), { force: true, recursive: true });
  }
  // The portable build has no runtime: copy build/runtime in (the equivalent of extraResources)
  if (pick.addRuntime) {
    console.log(`Bundled runtime ${pick.runtime} -> app/resources/runtime (~1 GB, this takes a moment)...`);
    fs.cpSync(pick.runtime, path.join(appDir, 'resources', 'runtime'), { recursive: true });
  }
  const rtExe = path.join(appDir, 'resources', 'runtime', 'emulator', 'emulator.exe');
  if (!fs.existsSync(rtExe)) {
    console.error(`\nWarning: ${rtExe} does not exist -- the packaged app will still download the runtime online.`);
    console.error('Run node build/prepare-runtime.js to generate build/runtime first.\n');
  } else {
    console.log('Runtime bundled (emulator / platform-tools / system-images)');
  }
  // Guard right after assembling the payload: a Store package must bundle its runtime, run standalone, and carry no third-party emulator
  assertStandalone(appDir, { label: 'MSIX payload app/' });
  console.log('Generating Store icons...');
  const made = writeAssets(path.join(work, 'Assets'));
  for (const m of made) console.log(`  ${m}`);
  fs.writeFileSync(path.join(work, 'AppxManifest.xml'), manifest(), 'utf8');
  console.log(`Manifest: Identity=${IDENTITY} Publisher=${PUBLISHER} Version=${msixVersion(VERSION)}`);
  return work;
}

function main() {
  console.log(`ApkStart MSIX packaging  version ${VERSION} -> ${msixVersion(VERSION)}`);
  // Identity guard: a package built with the placeholder Publisher is always rejected (0x800B0109 / identity mismatch).
  // Documentation alone never helped -- the default used to be the placeholder, and one casual rebuild overwrote a good package.
  if (!String(PUBLISHER).toUpperCase().includes('58CA1DED') && !process.argv.includes('--allow-placeholder')) {
    console.error(`\nPublisher is not the value confirmed by Partner Center: ${PUBLISHER}`);
    console.error(`Confirmed value is ${CONFIRMED_PUBLISHER} (Identity ${CONFIRMED_IDENTITY}).`);
    console.error('A package built with the placeholder Publisher is rejected on upload.');
    console.error('If you really want the placeholder build (local experiments only, never shipped) add --allow-placeholder.\n');
    process.exit(3);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = stagePackage();

  const makeappx = which('makeappx.exe');
  if (!makeappx) {
    console.error('\nmakeappx.exe not found. Either:');
    console.error('  A. Install the Windows SDK (only the SDK is needed, not Visual Studio):');
    console.error('     https://developer.microsoft.com/windows/downloads/windows-sdk/');
    console.error('  B. Run npx electron-builder --win appx once so windows-kits-bundle lands in the cache,');
    console.error('     and this script will find it in the electron-builder cache.');
    console.error(`\nThe stage directory is ready; package it by hand:\n  "${'<makeappx.exe>'}" pack /d "${work}" /p "${path.join(OUT_DIR, artifactName())}" /o\n`);
    process.exit(2);
  }
  const out = path.join(OUT_DIR, artifactName());
  console.log(`\nPackaging with ${makeappx}...`);
  fs.rmSync(out, { force: true });
  run(makeappx, ['pack', '/d', work, '/p', out, '/o', '/v']);

  const mb = fs.statSync(out).size / 1048576;
  console.log(`\nDone: ${out}  (${mb.toFixed(0)} MB)`);

  // Self-check with .NET's ZipFile: the package must contain a manifest, block map and content types
  try {
    const { execFileSync: ex } = require('child_process');
    const ps = [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;`
      + `$z=[IO.Compression.ZipFile]::OpenRead('${out.replace(/'/g, "''")}');`
      + `$n=$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose();`
      + `foreach($k in @('AppxManifest.xml','AppxBlockMap.xml','[Content_Types].xml')){`
      + ` if($n -contains $k){ "OK   $k" } else { "MISS $k" } }`
      + `"entries: " + $n.Count`,
    ];
    ex('powershell.exe', ps, { stdio: 'inherit', windowsHide: true });
  } catch (_) { /* a failed self-check does not affect the artifact */ }

  if (DO_SIGN) sign(out);
  else {
    console.log('\nUnsigned (the Store re-signs with its own certificate, so no signature is needed for submission).');
    console.log('To install locally, add --sign to create a self-signed certificate and sign it.');
  }
  // stage is a 1.3 GB intermediate: keeping it is useless and makes people think the package holds two copies,
  // so it is removed after a successful build (use --keep-stage to investigate instead).
  if (!process.argv.includes('--keep-stage')) {
    try {
      fs.rmSync(work, { recursive: true, force: true });
      console.log('Removed the intermediate dist/store/.stage');
    } catch (_) { /* leave it if locked; the artifact is unaffected */ }
  }
  console.log(`\nRead docs/store-msix.md before submitting.`);
}

function artifactName() {
  return `ApkStart_${msixVersion(VERSION)}_x64.msix`;
}

function sign(file) {
  const signtool = which('signtool.exe');
  if (!signtool) {
    console.error('\nsigntool.exe not found, skipping signing.');
    return;
  }
  const pfx = path.join(OUT_DIR, 'ApkStart-test.pfx');
  const pwd = process.env.APKSTART_MSIX_PFX_PASSWORD || 'ApkStart!test';
  const subject = PUBLISHER;   // must match the manifest Publisher character for character
  if (!fs.existsSync(pfx)) {
    console.log(`\nCreating a self-signed certificate (Subject=${subject})...`);
    const ps = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `$c = New-SelfSignedCertificate -Type Custom -KeyUsage DigitalSignature`
      + ` -CertStoreLocation 'Cert:\\CurrentUser\\My'`
      + ` -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')`
      + ` -Subject '${subject}' -FriendlyName 'ApkStart MSIX Test';`
      + `$p = ConvertTo-SecureString -String '${pwd}' -Force -AsPlainText;`
      + `Export-PfxCertificate -Cert ("Cert:\\CurrentUser\\My\\" + $c.Thumbprint) -FilePath '${pfx}' -Password $p | Out-Null;`
      + `"thumbprint=" + $c.Thumbprint`,
    ];
    try { run('powershell.exe', ps); } catch (e) { console.error(`certificate creation failed: ${e.message}`); return; }
  }
  console.log('Signing...');
  try {
    run(signtool, ['sign', '/a', '/v', '/fd', 'SHA256', '/f', pfx, '/p', pwd, file]);
  } catch (e) {
    console.error(`signing failed: ${e.message}`);
    console.error('\nNote: the winCodeSign toolset in the electron-builder cache is trimmed down;');
    console.error('its signtool.exe fails on MSIX with "A required function is not present"');
    console.error('(the MSIX SIP provider is not registered). To test-install locally use the signtool from a full Windows SDK:');
    console.error('  "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe" \\');
    console.error(`    sign /fd SHA256 /a /f "${pfx}" /p "${pwd}" "${file}"`);
    console.error('\n**No local signature is needed for publishing**: the Microsoft Store re-signs your package with its own certificate.');
    return;
  }
  console.log('\nTrust the certificate (run once in an administrator PowerShell before Add-AppxPackage):');
  console.log(`  Import-PfxCertificate -CertStoreLocation 'Cert:\\LocalMachine\\TrustedPeople' -FilePath '${pfx}' -Password (ConvertTo-SecureString '${pwd}' -Force -AsPlainText)`);
  console.log(`  Add-AppxPackage -Path '${file}'`);
}

if (require.main === module) main();

module.exports = { msixVersion, manifest, composeIcon, which, ASSETS };
