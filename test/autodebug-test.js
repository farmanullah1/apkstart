'use strict';
/**
 * Auto-detection core (src/core/autodebug.js) unit tests
 *
 * Pure functions, no dependency on electron / adb / network — CI can run directly.
 * Two bottom lines are guarded:
 *   1) Detection failure must not become "there is a problem" (no false alarms);
 *   2) When a real problem occurs it must be reported, and with an executable fix action.
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

const ROOT = path.join(__dirname, '..');
const ad = require(path.join(ROOT, 'src/core/autodebug'));

const codes = (issues) => issues.map((i) => i.code);

console.log('\n[auto-detection · empty snapshot no false alarm]');
test('completely empty snapshot produces no problems', () => {
  const issues = ad.evaluate({});
  assert(issues.length === 0, `should have no problems, actual ${JSON.stringify(codes(issues))}`);
});

test('when only half the state is known, still no false alarm', () => {
  // Only knows "running", nothing else
  const issues = ad.evaluate({ runtime: { running: true } });
  assert(issues.length === 0, `should have no problems, actual ${JSON.stringify(codes(issues))}`);
});

test('when device not checked, do not report "device not seen"', () => {
  const issues = ad.evaluate({ runtime: { running: true }, device: { checked: false } });
  assert(!codes(issues).includes('device.missing'), 'should not report device missing');
});

console.log('\n[auto-detection · runtime]');
test('last boot failure is reported, with the real error', () => {
  const issues = ad.evaluate({ runtime: { error: 'FATAL: cannot lock AVD' } });
  const it = issues.find((i) => i.code === 'runtime.bootFailed');
  assert(it, 'should report boot failure');
  assert(it.severity === 'error', 'should be a serious problem');
  assert(it.detail.includes('cannot lock AVD'), 'should carry the real cause');
  assert(it.fix === 'restartRuntime', 'should give an executable fix action');
});

test('boot stuck over 2.5 minutes before prompting (just booted is not a problem)', () => {
  const soon = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 30000 } });
  assert(!codes(soon).includes('runtime.stuckBoot'), 'just booted should not prompt');
  const stuck = ad.evaluate({ runtime: { running: true, phase: 'booting', bootMs: 200000 } });
  assert(codes(stuck).includes('runtime.stuckBoot'), 'stuck for long should prompt');
});

test('leftover lock files and orphan processes each report one line', () => {
  const issues = ad.evaluate({ runtime: { locks: 2, orphans: 1 } });
  assert(codes(issues).includes('runtime.staleLocks'), 'should report leftover locks');
  assert(codes(issues).includes('runtime.orphanProcesses'), 'should report orphan processes');
});

test('snapshot empty shell is recognized', () => {
  const issues = ad.evaluate({ runtime: { snapshotStale: true } });
  assert(codes(issues).includes('runtime.saleSnapshot') === false, 'should not have misspelled code');
  assert(codes(issues).includes('runtime.staleSnapshot'), 'should report snapshot corruption');
});

console.log('\n[auto-detection · device connection]');
test('unauthorized is a serious problem (Android popped authorization dialog nobody clicked)', () => {
  const issues = ad.evaluate({ device: { checked: true, state: 'unauthorized' } });
  const it = issues.find((i) => i.code === 'device.unauthorized');
  assert(it, 'should report unauthorized');
  assert(it.severity === 'error', 'should be a serious problem');
  assert(it.category === 'device', 'should be categorized as device connection');
});

test('offline and no-device are distinguished, with different severity', () => {
  const off = ad.evaluate({ device: { checked: true, state: 'offline' } });
  assert(codes(off).includes('device.offline'), 'should report offline');
  const none = ad.evaluate({ runtime: { running: true }, device: { checked: true, state: 'no-device' } });
  assert(codes(none).includes('device.missing'), 'should report device missing');
});

console.log('\n[auto-detection · storage]');
test('disk under 2GB is a serious problem, under 8GB is a reminder', () => {
  const crit = ad.evaluate({ storage: { freeMB: 1024 } });
  const ci = crit.find((i) => i.code === 'storage.diskCritical');
  assert(ci && ci.severity === 'error', 'under 2GB should be a serious problem');
  const warn = ad.evaluate({ storage: { freeMB: 5000 } });
  const wi = warn.find((i) => i.code === 'storage.diskLow');
  assert(wi && wi.severity === 'warn', 'under 8GB should be a reminder');
});

test('data partition blocked by differential disk is reported truthfully', () => {
  const issues = ad.evaluate({ storage: { needsReset: true, configuredGB: 16, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataNeedsReset');
  assert(it, 'should report expansion not effective');
  assert(it.detail.includes('16') && it.detail.includes('6'), 'should carry configured value and actual value');
});

test('configured capacity greater than actual capacity is a serious problem', () => {
  const issues = ad.evaluate({ storage: { configuredGB: 24, actualGB: 6 } });
  const it = issues.find((i) => i.code === 'storage.dataMismatch');
  assert(it && it.severity === 'error', 'should be a serious problem');
});

test('unwritable shared folder is reported', () => {
  const issues = ad.evaluate({ storage: { sharedOk: false, sharedPath: 'D:\\share' } });
  const it = issues.find((i) => i.code === 'storage.sharedBroken');
  assert(it, 'should report shared folder abnormal');
  assert(it.detail.includes('share'), 'should carry the directory path');
});

console.log('\n[auto-detection · settings conflict]');
test('force portrait but panel is landscape — orientation conflict', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'portrait', landscape: true } });
  assert(codes(issues).includes('settings.orientationConflict'), 'should report orientation conflict');
});

test('force landscape but panel is portrait — orientation conflict', () => {
  const issues = ad.evaluate({ settings: { orientationMode: 'landscape', landscape: false } });
  assert(codes(issues).includes('settings.orientationConflict'), 'should report orientation conflict');
});

test('follow app + any panel orientation is not a conflict', () => {
  const a = ad.evaluate({ settings: { orientationMode: 'auto', landscape: true } });
  const b = ad.evaluate({ settings: { orientationMode: 'auto', landscape: false } });
  assert(!codes(a).includes('settings.orientationConflict'), 'auto should not report conflict');
  assert(!codes(b).includes('settings.orientationConflict'), 'auto should not report conflict');
});

console.log('\n[auto-detection · network and logs]');
test('Android no network is reported, with a fix action', () => {
  const issues = ad.evaluate({ network: { ok: false, reason: 'dns timeout' } });
  const it = issues.find((i) => i.code === 'network.guestDown');
  assert(it, 'should report Android no network');
  assert(it.fix === 'repairNetwork', 'should give a fix action');
});

test('unreachable download source is counted', () => {
  const issues = ad.evaluate({ network: { sources: [{ name: 'GitHub', ok: false }, { name: 'Gitee', ok: true }] } });
  const it = issues.find((i) => i.code === 'network.sourcesDown');
  assert(it, 'should report source unreachable');
  assert(it.detail.includes('GitHub'), 'should point out which source');
  assert(!it.detail.includes('Gitee'), 'healthy source should not be listed');
});

test('errors in logs are extracted', () => {
  const issues = ad.evaluate({ logs: { errors: ['2026-01-01 FATAL: cannot lock AVD'] } });
  const it = issues.find((i) => i.code === 'logs.errors');
  assert(it, 'should report log error');
  assert(it.detail.includes('cannot lock'), 'should carry the original error text');
});

console.log('\n[auto-detection · summary and diff]');
test('summary counts by severity and gives a health grade', () => {
  const s = ad.summarize(ad.evaluate({
    runtime: { error: 'boom' },
    storage: { freeMB: 1024 },
    device: { checked: true, state: 'unauthorized' },
  }));
  assert(s.total === 3, `should have 3 items, actual ${s.total}`);
  assert(s.errors === 3, `should have 3 serious problems, actual ${s.errors}`);
  assert(s.health === 'error', 'health grade should be error');
  assert(s.byCategory.length === 6, 'category count should be fixed at 6');
});

test('when no problems, health grade is ok', () => {
  const s = ad.summarize([]);
  assert(s.total === 0 && s.health === 'ok', 'should be empty and healthy');
});

test('multiple items with the same code keep only the last one', () => {
  const list = ad.dedupe([
    { code: 'x', severity: 'warn', title: 'old' },
    { code: 'x', severity: 'error', title: 'new' },
  ]);
  assert(list.length === 1, 'should remain one item');
  assert(list[0].title === 'new', 'should keep the last one');
});

test('diff can separate "newly appeared" and "resolved"', () => {
  const prev = [{ code: 'a', severity: 'error' }, { code: 'b', severity: 'warn' }];
  const next = [{ code: 'b', severity: 'warn' }, { code: 'c', severity: 'error' }];
  const d = ad.diff(prev, next);
  assert(d.added.length === 1 && d.added[0].code === 'c', 'should recognize new problem');
  assert(d.resolved.length === 1 && d.resolved[0].code === 'a', 'should recognize resolved');
});

test('severity change also counts as "newly appeared" (warn upgraded to error should re-prompt)', () => {
  const d = ad.diff([{ code: 'a', severity: 'warn' }], [{ code: 'a', severity: 'error' }]);
  assert(d.added.length === 1, 'severity upgrade should re-prompt');
});

console.log('\n[auto-detection · structural constraints]');
test('every problem has category, severity, title', () => {
  const issues = ad.evaluate({
    runtime: { error: 'x', locks: 1, orphans: 1, snapshotStale: true },
    device: { checked: true, state: 'offline' },
    storage: { freeMB: 100, needsReset: true, sharedOk: false },
    settings: { orientationMode: 'portrait', landscape: true },
    network: { ok: false },
    logs: { errors: ['err'] },
  });
  assert(issues.length > 0, 'should have several problems');
  for (const it of issues) {
    assert(it.code, 'must have code');
    assert(ad.CATEGORY_IDS.includes(it.category), `category must be valid: ${it.category}`);
    assert(['error', 'warn', 'info'].includes(it.severity), `severity must be valid: ${it.severity}`);
    assert(it.title, 'must have title');
    assert(typeof it.hint === 'string', 'must have description');
  }
});

test('category table is consistent between front-end and back-end (renderer DEBUG_CATS)', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
  const m = appJs.match(/const DEBUG_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js should have DEBUG_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  assert(ids.length === ad.CATEGORIES.length, `category count should match: front-end ${ids.length} / back-end ${ad.CATEGORIES.length}`);
  for (const c of ad.CATEGORIES) {
    assert(ids.includes(c.id), `front-end missing category ${c.id}`);
  }
});

console.log('\n[auto-detection · main process wiring]');
test('main process registered detection-related IPC', () => {
  const mainJs = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  for (const ch of ['autodebug:run', 'autodebug:state', 'autodebug:config', 'app:clearOrphans', 'app:clearSnapshot', 'runtime:restart']) {
    assert(mainJs.includes(`'${ch}'`), `main process should register ${ch}`);
  }
  assert(mainJs.includes('scheduleAutodebug()'), 'main process should schedule periodic detection');
});

test('preload exposed detection interfaces, and allowed the status event', () => {
  const p = fs.readFileSync(path.join(ROOT, 'src/preload.js'), 'utf8');
  for (const fn of ['autodebugRun', 'autodebugState', 'autodebugConfig', 'clearOrphans', 'clearSnapshot', 'restartRuntime']) {
    assert(p.includes(fn), `preload should expose ${fn}`);
  }
  assert(p.includes("'autodebug:state'"), 'preload should allow autodebug:state event');
});

test('settings items have auto-detection switch and button', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  for (const id of ['setAutodebugAuto', 'setAutodebugInterval', 'setAutodebugNotify', 'btnAutodebugRun', 'autodebugList']) {
    assert(html.includes(`id="${id}"`), `settings page should have ${id}`);
  }
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
