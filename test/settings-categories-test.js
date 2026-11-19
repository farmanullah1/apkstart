'use strict';
/**
 * Settings page category navigation + search (0.6.0) structural tests
 *
 * The settings page is the most-touched UI; once categories and groups misalign, you get "a category
 * clicked is empty". Here we make source-level assertions: every group in the HTML must have data-cat,
 * nav items must match the categories used by groups, and the front-end category table must match the HTML.
 */

const fs = require('fs');
const path = require('path');

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
const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'src/ui/app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/ui/style.css'), 'utf8');

/** Grab the HTML fragment inside the settings body (settingsBody) */
const bodyMatch = html.match(/<div class="modal-body" id="settingsBody">([\s\S]*?)\n    <\/div>\n    <\/div>\n    <footer>/);
assert(bodyMatch, 'should be able to locate the settings body');

console.log('\n[settings categories - structure]');
test('settings panel has category nav and search box', () => {
  assert(html.includes('id="setNav"'), 'should have category nav container');
  assert(html.includes('id="setSearch"'), 'should have search box');
  assert(html.includes('id="btnClearSearch"'), 'should have clear search button');
  assert(html.includes('id="settingsBody"'), 'content area should have stable id (for locating and scrolling)');
});

test('nav items cover all 8 categories', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\\s\\S]*?<\/nav>/);
  assert(navMatch, 'should have nav');
  const items = navMatch[0].match(/data-cat="([a-z]+)"/g) || [];
  const ids = items.map((s) => s.replace(/data-cat="|"/g, ''));
  const expected = ['basic', 'display', 'input', 'perf', 'net', 'diag', 'files', 'about'];
  assert(ids.length === expected.length, `nav items should have ${expected.length}, actual ${ids.length}`);
  for (const e of expected) {
    assert(ids.includes(e), `nav missing category ${e}`);
  }
});

test('every settings group is categorized (no orphan groups)', () => {
  // Grab the start tags of all top-level groups inside the settings body
  const groups = bodyMatch[1].match(/<(div class="group"|details class="advanced-group")[^>]*>/g) || [];
  assert(groups.length >= 15, `settings groups should be no fewer than 15, actual ${groups.length}`);
  for (const g of groups) {
    assert(/data-cat="[a-z]+"/.test(g), `group missing data-cat: ${g}`);
  }
});

test('categories used by groups all appear in nav (no "clicked and empty")', () => {
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\\s\\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const used = (bodyMatch[1].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  const usedSet = Array.from(new Set(used));
  for (const u of usedSet) {
    assert(navIds.includes(u), `category ${u} has no corresponding nav item`);
  }
  // Each category should have at least one group; empty categories should be removed from nav
  for (const n of navIds) {
    assert(used.includes(n), `category ${n} has no groups, should not appear in nav`);
  }
});

test('key groups land in reasonable categories', () => {
  const expect = [
    ['id="runtimeGroup"', 'basic'],
    ['id="perfGroup"', 'perf'],
    ['id="preflightGroup"', 'diag'],
    ['id="driverGroup"', 'diag'],
    ['id="autodebugGroup"', 'diag'],
    ['id="downloadGroup"', 'net'],
    ['id="updateGroup"', 'about'],
    ['id="aboutGroup"', 'about'],
  ];
  for (const [marker, cat] of expect) {
    const idx = html.indexOf(marker);
    assert(idx > 0, `cannot find ${marker}`);
    const tail = html.slice(idx, idx + 120);
    assert(tail.includes(`data-cat="${cat}"`), `${marker} should be categorized as ${cat}`);
  }
});

test('front-end category table corresponds one-to-one with nav items', () => {
  const m = appJs.match(/const SETTINGS_CATS = \[([\s\S]*?)\];/);
  assert(m, 'app.js should have SETTINGS_CATS');
  const ids = (m[1].match(/id:\s*'([a-z]+)'/g) || []).map((s) => s.replace(/id:\s*'|'/g, ''));
  const navMatch = html.match(/<nav class="set-nav" id="setNav"[\\s\\S]*?<\/nav>/);
  const navIds = (navMatch[0].match(/data-cat="([a-z]+)"/g) || []).map((s) => s.replace(/data-cat="|"/g, ''));
  assert(ids.length === navIds.length, `front-end categories ${ids.length}, nav ${navIds.length}`);
  for (const n of navIds) {
    assert(ids.includes(n), `front-end missing category ${n}`);
  }
});

console.log('\n[settings categories - behavior]');
test('switching, filtering, and remembering are implemented', () => {
  assert(appJs.includes('function switchSettingsCat'), 'should have category switch function');
  assert(appJs.includes('function applySettingsFilter'), 'should have visibility filter function');
  assert(appJs.includes('function groupMatches'), 'should have search match function');
  assert(appJs.includes('function focusGroup'), 'should have function to locate group');
  assert(appJs.includes('apkstart.settings.cat'), 'should remember last-stayed category');
});

test('search is cross-category (otherwise found but not visible)', () => {
  // Filtering decides visibility by match, not only by current category
  const fn = appJs.match(/function applySettingsFilter\(\) \{[\s\S]*?\n\}/);
  assert(fn, 'should locate applySettingsFilter');
  assert(/g\.hidden = q ? !hit : !inCat/.test(fn[0]), 'search should show by match (cross-category)');
});

test('jump entries all changed to focusGroup (locate group after category switch)', () => {
  assert(appJs.includes("focusGroup($('runtimeGroup'))"), 'deploy guide should locate runtime group');
  assert(appJs.includes("focusGroup($('perfGroup'))"), 'data partition problem should locate performance group');
  // Old direct scrollIntoView locating should have been replaced by focusGroup
  const direct = appJs.match(/box\.scrollIntoView\(\{ block: 'start', behavior: 'smooth' \}\)/g) || [];
  assert(direct.length === 0, `should no longer have direct scrollIntoView locating (${direct.length} remaining)`);
});

test('auto-detection panel fix buttons reuse fixIssue', () => {
  assert(appJs.includes('data-code="${esc(it.code)}"'), 'detection items should carry code for fixing');
  assert(appJs.includes('fixIssue(issue)'), 'should reuse unified fix entry');
});

console.log('\n[settings categories - styles]');
test('has styles for nav, search, and detection panel', () => {
  for (const sel of ['.set-nav', '.set-nav-item', '.set-search', '.dbg-list', '.dbg-item', '.modal-main']) {
    assert(css.includes(sel), `style.css should have ${sel}`);
  }
});

test('popup widened but does not burst on small screens', () => {
  assert(/\.modal \{[^}]*width: 880px/.test(css), 'popup should be 880px');
  assert(css.includes('max-width: calc(100vw - 48px)'), 'should adapt on small screens');
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
