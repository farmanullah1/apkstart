'use strict';
/**
 * Two-way synchronization between Host ↔ Android shared directory
 *
 * Without root we cannot truly "mount" the folder, so incremental sync is used:
 * Any file added/modified on either side syncs within seconds, semantically equivalent to a shared folder.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MAX_FILE = 512 * 1024 * 1024; // 512MB per-file upper limit

function walk(dir, base = dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, base, out);
    else if (it.isFile()) {
      try {
        const st = fs.statSync(full);
        if (st.size <= MAX_FILE) {
          out.push({ abs: full, rel: path.relative(base, full).split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size });
        }
      } catch (_) { /* ignore */ }
    }
  }
  return out;
}

class Sharer {
  constructor(runtime) {
    this.runtime = runtime;
    this.stateFile = path.join(store.DATA_DIR, 'shared-state.json');
    this._busy = false;
    this._timer = null;
    this._lastError = '';
  }

  get localDir() { return store.getSettings().sharedDir; }
  get remoteDir() { return store.getSettings().deviceSharedDir; }

  loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return {}; }
  }

  saveState(s) {
    try { fs.writeFileSync(this.stateFile, JSON.stringify(s, null, 2)); } catch (_) { /* ignore */ }
  }

  async ensureDirs(onLog = () => {}) {
    if (!fs.existsSync(this.localDir)) fs.mkdirSync(this.localDir, { recursive: true });
    const client = this.runtime.client();
    if (!(await client.isOnline())) return false;
    await client.shellMkdir(this.remoteDir);
    return true;
  }

  async sync({ onLog = () => {} } = {}) {
    if (this._busy) return { skipped: true };
    this._busy = true;
    const result = { pushed: 0, pulled: 0, errors: [] };
    try {
      const client = this.runtime.client();
      if (!(await client.isOnline())) throw new Error('Runtime is not connected');
      await this.ensureDirs(onLog);
      const state = this.loadState();

      // --- Host → Device ---
      // State tracks both "host mtime" and "device mtime".
      // Previous implementation tracked only one mtime and wrote back host time, causing every sync to re-pull the same file.
      const stateOf = (prev) => (prev ? {
        size: prev.size,
        lmtime: prev.lmtime || prev.mtime || 0,
        rmtime: prev.rmtime || 0,
        dir: prev.dir || '',
      } : null);

      const localFiles = walk(this.localDir);
      for (const f of localFiles) {
        const prev = stateOf(state[f.rel]);
        const changed = !prev || prev.size !== f.size || Math.abs(prev.lmtime - f.mtime) > 1500;
        if (!changed) continue;
        const remote = `${this.remoteDir}/${f.rel}`;
        try {
          await client.shell(`mkdir -p "$(dirname '${remote}')"`);
          await client.push(f.abs, remote);
          state[f.rel] = { size: f.size, lmtime: f.mtime, rmtime: 0, dir: 'up', at: Date.now() };
          result.pushed++;
        } catch (e) {
          result.errors.push(`↑ ${f.rel}: ${e.message}`);
        }
      }

      // --- Device → Host ---
      // Prefer toybox stat for real mtime; fall back to ls parsing (only size check)
      let remoteList = null;
      try {
        remoteList = await client.listRemoteStat(this.remoteDir);
      } catch (_) { /* ignore */ }
      if (!remoteList) {
        try {
          remoteList = await this.listRemoteRecursive(client, this.remoteDir);
        } catch (_) { remoteList = []; }
      }

      for (const r of remoteList) {
        // Skip oversized files (videos/game data packages): local folder should not become device cache dump
        if (r.size > MAX_FILE) continue;
        const prev = stateOf(state[r.rel]);
        const sizeSame = !!prev && prev.size === r.size;
        const rmtimeSame = !!(prev && prev.rmtime && r.mtime)
          && Math.abs(prev.rmtime - r.mtime) <= 1500;
        if (prev && sizeSame && (rmtimeSame || prev.dir === 'up')) {
          // Same size, and either device time unchanged or file was just pushed by us:
          // Record device time and finish, never re-download
          if (r.mtime && prev.rmtime !== r.mtime) {
            state[r.rel] = { ...prev, rmtime: r.mtime };
          }
          continue;
        }
        if (prev && sizeSame && !r.mtime) continue;   // Unable to get device time and same size -> treat as identical
        const local = path.join(this.localDir, r.rel);
        try {
          fs.mkdirSync(path.dirname(local), { recursive: true });
          await client.pull(`${this.remoteDir}/${r.rel}`, local);
          const st = fs.statSync(local);
          state[r.rel] = { size: st.size, lmtime: st.mtimeMs, rmtime: r.mtime || 0, dir: 'down', at: Date.now() };
          result.pulled++;
        } catch (e) {
          result.errors.push(`↓ ${r.rel}: ${e.message}`);
        }
      }

      this.saveState(state);
      this._lastError = result.errors[0] || '';
      return result;
    } catch (e) {
      this._lastError = e.message;
      return { ...result, error: e.message };
    } finally {
      this._busy = false;
    }
  }

  async listRemoteRecursive(client, base, prefix = '', depth = 0, out = []) {
    if (depth > 6) return out;
    // Prefer single find + stat for batch retrieval (faster than recursive ls -l, immune to date format variance)
    if (depth === 0 && !prefix) {
      try {
        const text = await client.shell(
          `cd "${base}" 2>/dev/null && find . -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`,
        );
        const rows = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
          .map((l) => /^(\d+)\|(\d+)\|(.+)$/.exec(l))
          .filter(Boolean)
          .map((m) => ({ rel: m[3].replace(/^\.\//, ''), size: Number(m[1]), mtime: Number(m[2]) * 1000 }));
        if (rows.length) return rows;
      } catch (_) { /* Fall back to ls parsing */ }
    }
    const items = await client.listRemote(prefix ? `${base}/${prefix}` : base);
    for (const it of items) {
      if (it.name === '.' || it.name === '..') continue;
      const rel = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.isDir) {
        // eslint-disable-next-line no-await-in-loop
        await this.listRemoteRecursive(client, base, rel, depth + 1, out);
      } else {
        out.push({ rel, size: it.size, mtime: Date.now() });
      }
    }
    return out;
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get lastError() { return this._lastError; }
}

module.exports = { Sharer };
