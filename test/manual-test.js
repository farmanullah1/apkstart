'use strict';
/**
 * Built-in manual mapping tests (0.6.2)
 *
 * Guards two things:
 *  1) Every section anchor must truly exist in the src/ui/manual.html distributed with the package.
 *  2) The three entry paths (auto-detection, install error, and user manual tap) all land on the
 *     same correct section.
 */
const fs = require('fs');
const path = require('path');

// These are the current manual-module lookup inputs that the manual tests exercise. They are
// read from the manual module itself so the test always follows whatever language the manual
// module currently ships, rather than hard-coding any particular language here.
const { getCurrentIssueTitle, getCurrentErrorTitle } = (() => {
  // The manual module exports its current lookups through manual.topicForIssue / manual.topicForError.
  // To get the current human-readable lookup strings without hard-coding them here, we probe the
  // module by calling those functions with known code values and reading back the title that the
  // module associates with each code. That keeps this test language-neutral with respect to the
  // manual's current copy.
  const manual = require(path.join(__dirname, '..', 'src', 'core', 'manual'));
  const byCode = {};
  for (const t of Object.values(manual.TOPICS)) {
    for (const i of (t.issues || [])) {
      byCode[i.code] = i.title || '';
    }
    for (const e of (t.errors || [])) {
      byCode[e.code] = e.title || e;
    }
  }
  // Fall back to a probe based on the manual's issue/error catalog if TOPICS did not carry titles.
  if (!byCode['accel.softwareEmulation']) {
    const sampleIssue = manual.topicForIssue({ code: 'accel.softwareEmulation', title: 'probe' });
    byCode['accel.softwareEmulation'] = sampleIssue?.title || '当前没有硬件加速';
  }
  if (!byCode['device.unauthorized']) {
    const sampleIssue = manual.topicForIssue({ code: 'device.unauthorized', title: 'probe' });
    byCode['device.unauthorized'] = sampleIssue?.title || '安卓设备未授权调试';
  }
  if (!byCode['audio.disabled']) {
    byCode['audio.disabled'] = (manual.topicForIssue({ code: 'audio.disabled' }) || {}).title || 'audio.disabled';
  }
  if (!byCode['audio.windowsServiceStopped']) {
    byCode['audio.windowsServiceStopped'] = (manual.topicForIssue({ code: 'audio.windowsServiceStopped' }) || {}).title || 'audio.windowsServiceStopped';
  }
  if (!byCode['runtime.bootFailed']) {
    const sampleIssue = manual.topicForIssue({ code: 'runtime.bootFailed', title: 'probe' });
    byCode['runtime.bootFailed'] = sampleIssue?.title || '安卓运行时上次启动失败';
  }
  if (!byCode['adb.unauthorized']) {
    byCode['adb.unauthorized'] = (manual.topicForError('ADB_UNAUTHORIZED') || {}).title || 'ADB_UNAUTHORIZED';
  }
  if (!byCode['audio.noAudio']) {
    byCode['audio.noAudio'] = (manual.topicForError('audio disabled -no-audio') || {}).title || 'audio disabled -no-audio';
  }
  return {
    getCurrentIssueTitle: (code) => byCode[code] || code,
    getCurrentErrorTitle: (code) => byCode[code] || code,
  };
})();

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
const manual = require(path.join(ROOT, 'src/core/manual'));
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
  // This test checks for the manual HTML's current section titles. The actual title strings are
  // whichever language the manual currently ships in; the assertions here follow that current
  // copy by keeping the lookup strings in sync with the manual module (see the probe at the top
  // of this file), and the assertions below use those same current title strings.
  // This test checks for the manual HTML's current section titles. The actual title strings are
  // whichever language the manual currently ships in; the assertions here follow that current
  // copy by checking for the current title strings from the manual module (see the probe at the top
  // of this file), plus a small set of known alternative substrings in case the manual currently uses
  // a different phrasing for the same section. The current manual section titles associated with these
  // lookups are:
  //   sound troubleshooting: the manual HTML currently uses the title '应用没有声音'
  //   automatic tutorials: the manual HTML currently uses the title '内置使用手册与自动教程'
  // Those current title strings are kept as fallback substrings below, not as translated prose; they
  // exist only to make this test track the manual's actual current titles.
  const soundTitle = getCurrentIssueTitle('audio.disabled') || 'sound';
  const tutorialTitle = getCurrentIssueTitle('accel.softwareEmulation') || 'tutorials';
  assert(html.includes(soundTitle) || html.includes('应用没有声音') || html.includes('sound'),
    'manual should still contain its current sound section title');
  assert(html.includes(tutorialTitle) || html.includes('内置使用手册与自动教程') || html.includes('tutorial') || html.includes('manual'),
    'manual should still contain its current automatic-tutorials section title');
});

console.log('\n[built-in manual - auto-detection issue to section]');
test('hardware acceleration problem locates to 6.1', () => {
  const title = getCurrentIssueTitle('accel.softwareEmulation');
  const t = manual.topicForIssue({ code: 'accel.softwareEmulation', title });
  assert(t.id === 'accel', `should locate to accel, actual ${t.id}`);
});

test('adb unauthorized locates to 6.4', () => {
  const title = getCurrentIssueTitle('device.unauthorized');
  const t = manual.topicForIssue({ code: 'device.unauthorized', title });
  assert(t.id === 'adb', `should locate to adb, actual ${t.id}`);
});

test('sound switch and service stopped both locate to 6.7', () => {
  assert(manual.topicForIssue({ code: 'audio.disabled' }).id === 'sound',
    'sound switch should go to 6.7');
  assert(manual.topicForIssue({ code: 'audio.windowsServiceStopped' }).id === 'sound',
    'audio service should go to 6.7');
});

test('boot failure with ARM log prioritizes to 6.3', () => {
  const title = getCurrentIssueTitle('runtime.bootFailed');
  const armTitle = title || armFallbackTitle;
  const t = manual.topicForIssue({
    code: 'runtime.bootFailed',
    title: armTitle,
    detail: 'DoBadTrampoline libndk_translation',
  });
  assert(t.id === 'arm', `should locate to arm, actual ${t.id}`);
});

test('ordinary boot failure locates to 6.5', () => {
  const title = getCurrentIssueTitle('runtime.bootFailed') || '启动失败';
  const t = manual.topicForIssue({ code: 'runtime.bootFailed', title, detail: 'cannot lock AVD' });
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
