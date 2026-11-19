'use strict';
/**
 * Two-source self-check: one command showing each source's latest version and the measured speed of every download URL.
 *
 *   node tools/check-sources.js            # check update packages
 *   node tools/check-sources.js runtime    # check the full runtime package
 *
 * It really downloads 256KB, so it uses a little traffic; the point is to confirm, before touching code,
 * "which source this machine should actually use right now".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sources-'));
process.env.APPDATA = TMP;

const { Sources } = require('../src/core/sources');
const store = require('../src/core/store');
const { Provisioner } = require('../src/core/provision');

const mb = (n) => (n / 1048576).toFixed(2);
const host = (u) => { try { return new URL(u).host; } catch (_) { return u.slice(0, 40); } };

(async () => {
  const which = (process.argv[2] || 'update').toLowerCase();
  const sources = new Sources(() => store.getSettings());

  console.log('=== 1) Release info from both sources ===');
  const rels = await sources.fetchReleases();
  for (const r of rels) {
    if (r.rel) {
      const assets = (r.rel.assets || []).length;
      console.log(`  ${r.name.padEnd(7)} ${String(r.rel.tag_name || r.rel.name || '').padEnd(10)} ${assets} assets`);
    } else {
      console.log(`  ${r.name.padEnd(7)} unreachable: ${r.error}`);
    }
  }

  console.log('\n=== 2) Merged result ===');
  const merged = await sources.latest();
  console.log(`  Highest version ${merged.tag} (${merged.assets.length} assets)`);
  for (const a of merged.assets) {
    console.log(`    · ${a.name}  ${(a.size / 1048576).toFixed(0)}MB  [${a.source}]`);
  }

  console.log('\n=== 3) Measured speed of every download URL ===');
  let target = null;
  if (which === 'runtime') {
    const p = new Provisioner(path.resolve(__dirname, '..'));
    const pack = await p.resolveRuntimePack().catch((e) => { console.log('  resolve failed:', e.message); return null; });
    if (pack) {
      console.log(`  Runtime package ${pack.name} (${pack.tag} - ${pack.from || '?'})`);
      target = pack.url;
    }
  } else {
    const pick = merged.assets.find((a) => /portable.*\.zip$/i.test(a.name)) || merged.assets[0];
    if (pick) {
      console.log(`  Update package ${pick.name}`);
      target = pick.url;
    }
  }
  if (!target) {
    console.log('  no assets to test');
  } else {
    const cands = sources.candidates(target);
    for (const c of cands) console.log(`  ${host(c).padEnd(22)} ${c === target ? '(direct)' : '(mirror)'}`);
    const t0 = Date.now();
    const ranked = await sources.rank(cands, { onProgress: (p) => console.log('  ·', p.message) });
    console.log(`  Probe took ${Date.now() - t0}ms, final order:`);
    ranked.forEach((u, i) => {
      const c = sources._rankCache.get(u) || {};
      console.log(`    ${i + 1}. ${host(u).padEnd(22)} ${c.ok ? `${mb(c.speed)} MB/s` : 'unavailable'}`);
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => {
  console.error('failed:', e.message);
  process.exit(1);
});
