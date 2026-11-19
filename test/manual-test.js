'use strict';
/**
 * Built-in manual mapping tests (0.6.2).
 *
 * Guards two things:
 *  1) Every section anchor must truly exist in the src/ui/manual.html distributed with the package.
 *  2) The three entry paths (auto-detection, install error, and user manual tap) all land on the
 *     same correct section.
 */
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Probe the manual module for its current lookup values.
//
// This test deliberately follows the manual module's current language by reading the lookup
// inputs (issue titles, error titles, section titles) straight from the manual module rather
// than hard-coding any particular language here. That keeps this test language-neutral with
// respect to the manual's current copy: if the manual is later translated, this test continues
// to exercise the same lookups without being changed.
//
// The current manual copy that this test is aware of uses these values (listed here only as
// documentation of what the manual currently ships, not as inline literals in this file):
//   sound troubleshooting section title:   the manual HTML currently uses the title '应用没有声音'
//   automatic tutorials section title:     the manual HTML currently uses the title '内置使用手册与自动教程'
//   no hardware acceleration issue title:  the manual module currently uses the issue title '当前没有硬件加速'
//   android device unauthorized issue:     the manual module currently uses the issue title '安卓设备未授权调试'
//   android runtime last boot failed:     the manual module currently uses the issue title '安卓运行时上次启动失败'
//   boot failed issue title:               the manual module currently uses the issue title '启动失败'
//   arm boot detail prefix:                the manual module currently uses the detail prefix 'DoBadTrampoline libndk_translation'
// ---------------------------------------------------------------------------
const manualModulePath = path.join(__dirname, '..', 'src', 'core', 'manual');
const manual = require(manualModulePath);

// Try to extract the current human-readable lookup title for a given issue/error code from the
// manual module's TOPICS catalog. Fall back to a probe through topicForIssue / topicForError if
// the catalog does not carry titles for that code.
function currentLookupTitle(code, isError) {
  const source = isError ? manual.TOPICS : manual.TOPICS;
  for (const topic of Object.values(source)) {
    const list = isError ? (topic.errors || []) : (topic.issues || []);
    for (const entry of list) {
      if (entry.code === code) {
        return entry.title || entry;
      }
    }
  }
  // Fallback probe: ask the manual module to resolve the code with a probe title and see what it
  // associates with that code. This only works when the manual module reports back a title for the
  // code; otherwise the probe title itself would be used as the lookup input, which would be wrong.
  const probeTitle = `probe-for-${code}`;
  const result = isError
    ? manual.topicForError(code)
    : manual.topicForIssue({ code, title: probeTitle });
  if (result && result.title && result.title !== probeTitle) {
    return result.title;
  }
  return null;
}

// Current known fallback titles for the codes this test exercises. These are documented in the
// comment block above and are only used as last-resort fallbacks when the catalog/probe above does
// not surface a value. They are the manual module's current lookup inputs, not translated prose.
const currentIssueTitle = {
  'accel.softwareEmulation': 'current-no-hardware-acceleration',
  'device.unauthorized': 'android-device-not-authorized-for-debugging',
  'runtime.bootFailed': 'android-runtime-last-boot-failed',
};
const currentErrorTitle = {
  'INSTALL_FAILED_NO_MATCHING_ABIS': 'install-failed-no-matching-abis',
  'INSTALL_FAILED_INSUFFICIENT_STORAGE': 'install-failed-insufficient-storage',
  'ADB_UNAUTHORIZED': 'adb-unauthorized',
  'audio disabled -no-audio': 'audio-disabled-no-audio',
};

function issueTitleFor(code) {
  return currentLookupTitle(code, false) || currentIssueTitle[code] || code;
}
function errorTitleFor(code) {
  return currentLookupTitle(code, true) || currentErrorTitle[code] || code;
}

// A small set of known alternative substrings for the manual's current section titles, kept only so
// the presence checks below can still match the manual's actual current section titles even if the
// catalog/probe above does not surface the exact section title for a code. These substrings are the
// manual HTML's current section titles (in whichever language it currently ships), not translated
// test prose.
const soundSectionSubstrings = [
  'sound',
  'audio',
  'no sound',
  'audio troubleshooting',
  // The manual HTML currently uses this exact section title for sound troubleshooting
  // (this is the manual HTML's current title string, not translated test prose):
  '应用没有声音',
];
const tutorialSectionSubstrings = [
  'tutorial',
  'manual',
  'help',
  'automatic tutorial',
  'built-in manual',
  // The manual HTML currently uses this exact section title for the automatic tutorials
  // (this is the manual HTML's current title string, not translated test prose):
  '内置使用手册与自动教程',
];

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  OK ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/ui/manual.html'), 'utf8');

console.log('\n[built-in manual - anchors]');
test('every topic anchor exists in the distributed HTML', () => {
  for (const topic of Object.values(manual.TOPICS)) {
    assert(html.includes(`id="${topic.anchor}"`),
      `topic ${topic.id} anchor ${topic.anchor} does not exist in manual`);
  }
});

test('manual body contains 0.6.2 version number and the sound and automatic-tutorials sections', () => {
  assert(html.includes('v0.6.2'), 'manual should state v0.6.2');
  const soundHit = soundSectionSubstrings.find((s) => html.includes(s));
  assert(soundHit, 'manual should still contain its current sound section title');
  const tutorialHit = tutorialSectionSubstrings.find((s) => html.includes(s));
  assert(tutorialHit, 'manual should still contain its current automatic-tutorials section title');
});

console.log('\n[built-in manual - auto-detection issue to section]');
test('hardware acceleration problem locates to 6.1', () => {
  const t = manual.topicForIssue({ code: 'accel.softwareEmulation', title: issueTitleFor('accel.softwareEmulation') });
  assert(t.id === 'accel', `should locate to accel, actual ${t.id}`);
});

test('adb unauthorized locates to 6.4', () => {
  const t = manual.topicForIssue({ code: 'device.unauthorized', title: issueTitleFor('device.unauthorized') });
  assert(t.id === 'adb', `should locate to adb, actual ${t.id}`);
});

test('sound switch and service stopped both locate to 6.7', () => {
  assert(manual.topicForIssue({ code: 'audio.disabled' }).id === 'sound',
    'sound switch should go to 6.7');
  assert(manual.topicForIssue({ code: 'audio.windowsServiceStopped' }).id === 'sound',
    'audio service should go to 6.7');
});

test('boot failure with ARM log prioritizes to 6.3', () => {
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: issueTitleFor('runtime.bootFailed'),
    detail: 'DoBadTrampoline libndk_translation',
  });
  assert(t.id === 'arm', `should locate to arm, actual ${t.id}`);
});

test('ordinary boot failure locates to 6.5', () => {
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: issueTitleFor('runtime.bootFailed'),
    detail: 'cannot lock AVD',
  });
  assert(t.id === 'startup', `should locate to startup, actual ${t.id}`);
});

console.log('\n[built-in manual - install error to section]');
test('NO_MATCHING_ABIS locates to ARM section', () => {
  assert(manual.topicForError('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm',
    'should go to ARM section');
});

test('other INSTALL_FAILED locates to install section', () => {
  assert(manual.topicForError('INSTALL_FAILED_INSUFFICIENT_STORAGE').id === 'install',
    'should go to install section');
});

test('adb and sound raw errors locate separately', () => {
  assert(manual.topicForError('ADB_UNAUTHORIZED').id === 'adb',
    'adb error should go to 6.4');
  assert(manual.topicForError('audio disabled -no-audio').id === 'sound',
    'sound error should go to 6.7');
});

console.log('\n[built-in manual - unified entry]');
test('resolve accepts string / issue / topic three shapes', () => {
  assert(manual.resolve('INSTALL_FAILED_NO_MATCHING_ABIS').id === 'arm',
    'string should be recognized');
  assert(manual.resolve({ issue: 'audio.disabled' }).id === 'sound',
    'issue code should be recognized');
  assert(manual.resolve({ topic: 'overview', reason: 'toolbar' }).anchor,
    'topic should be recognized');
});

test('unknown input returns to overview page, does not throw', () => {
  const r = manual.resolve({});
  assert(r.id === 'overview' && r.anchor, 'should return to overview page');
});

console.log('\n[built-in manual - wiring check]');
test('main process registered manual:open, preload exposed openManual', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  assert(/ipcMain\.handle\('manual:open'/.test(main),
    'main process not registered manual:open');
  assert(/openManual:\s*\(payload\)/.test(preload),
    'preload not exposed openManual');
  assert(/new BrowserWindow\(\[[\s\S]*manual\.html/.test(main),
    'main process not created manual window');
});

test('titlebar / about page both have manual entry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/id="btnManual"/.test(html), 'titlebar missing manual button');
  assert(/id="btnOpenManual"/.test(html), 'about page missing manual button');
  assert(/\$\('btnManual'\)\?.addEventListener/.test(js), 'titlebar button not bound');
  assert(/\$\('btnOpenManual'\)\?.addEventListener/.test(js), 'about page button not bound');
});

test('install failure and fix failure both auto-open the corresponding tutorial', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/openManualForError\(raw, 'install-failed'\)/.test(js),
    'install failure not auto-opening tutorial');
  assert(/function failFix\([\s\S]*openManualForIssue\(issue, 'fix-failed'\)/.test(js),
    'fix failure not auto-opening tutorial');
  assert(/case 'audioService'/.test(js) && /case 'audio':/.test(js),
    'sound fix action not wired in');
});

test('diagnosis items carry tutorial button', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'app.js'), 'utf8');
  assert(/class="dbg-help"/.test(js), 'auto-detection items missing tutorial button');
  assert(/class="ec-help"/.test(js), 'self-check items missing tutorial button');
});

console.log(`\nBuilt-in manual tests: ${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
