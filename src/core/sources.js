'use strict';
/**
 * Unified download source management for dual sources (GitHub / Gitee) + mirror prefixes.
 *
 * Directly connecting to GitHub in some regions has two issues:
 *   1. api.github.com frequently takes tens of seconds to respond or times out;
 *   2. Asset downloads can be throttled on single connections.
 * This module measures real throughput dynamically:
 *   - Release metadata: query GitHub and Gitee concurrently;
 *   - Download URLs: list direct links, mirrors, and Gitee assets, test with real bytes, and sort by measured speed.
 * Speed test results are cached in memory for 30 minutes.
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'farmanullah1';
const OWNER_GITEE = 'daily-miku';
const REPO = 'APK-START-English';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** Known working GitHub acceleration prefixes. Used only when autoMirror is enabled and no custom prefix is set. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * Sample size for speed testing in bytes.
 * 256KB separates TLS handshake overhead from actual bandwidth.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Invalid URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Fetch a small piece of JSON (with redirect, timeout, size limit) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Download a sample slice of bytes to measure speed.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Throughput calculation starts after first byte is received to exclude TLS/DNS overhead
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // If asset is smaller than sample size, EOF counts as success
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Prepend mirror prefix to GitHub asset URL */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Reassemble split parts (e.g., xxx.zip.part1 / xxx.zip.part2) into a logical asset:
 *   { name: 'xxx.zip', size: sum, parts: [{index, size, urls:[...]}] }
 * Parts must be contiguous starting from part1.
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Note: Gitee release assets only provide name and url, not size.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Mirror list: user custom mirrors take precedence, followed by built-in mirrors */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Release check result cache
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Circuit breaker: skip a rate-limited or failing source for a period of time
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Check whether source is in circuit breaker period; returns null if available, or user-facing reason */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Temporarily skipped (will not retry for ${Math.ceil((until - Date.now()) / 60000)} minutes)`;
  }

  /**
   * Non-API fallback: follow /releases/latest 302 redirect to retrieve tag.
   * Web redirects go through CDN and do not consume API rate limits.
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Construct minimal release metadata using tag name (used when API is unavailable) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    // Standard /releases/download/<tag>/<filename> URLs are supported by both GitHub and Gitee.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // Public repo releases can be queried anonymously; private repos require a read-only token.
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // If no formal release or GitHub blocked, fall back to first entry in release list
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* Continue fallback without API */ }
        // Non-API fallback when API is rate-limited: obtain tag from redirect and assemble asset names
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* Fallback also failed */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? ' (Rate limited, temporarily paused this source)'
          : (id === 'gitee' && !token ? ' (Try again later, or configure a read-only token in settings)' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Merge latest releases from both sources: higher version wins, with combined asset lists.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // Record rate-limited sources in circuit breaker
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'No data'}`).join('; ');
      // If all failed but previous cached result exists, return stale result rather than error directly
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Unable to connect to update server (${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Only assets for matching version are valid. Whole package takes precedence over split parts.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Exclude automatic source archives (v0.3.2.zip).
        // Official release assets consistently start with ApkStart.
        if (!/^ApkStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // Keep URLs from both sources when same asset exists on both.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Candidate URLs for an asset across all sources and mirrors (deduped, preserving order: direct host first, mirrors second).
   * Mirrors only apply to GitHub URLs.
   */
  candidates(assetOrUrl) {
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Sort candidate URLs by measured speed. Speed test results are cached for 30 minutes.
   * If all speed tests fail, fall back to original order.
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Testing speed of ${need.length} download sources...` });
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* invalid address displayed as is */ }
        onProgress?.({ stage: 'probe', message: `Testing source ${i}/${need.length}: ${host}...` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Selected fastest source: ${new URL(best).host} (~ ${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Clear speed test cache (called when mirrors or network changes) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
