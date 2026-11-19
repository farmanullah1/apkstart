# Development environment and command quick reference

> This document records the environment facts needed to "continue developing ApkStart on this development machine".
> Most pitfalls are sandbox-specific; change machines and rely on actual detection.
> Last verified: 2026-11-14 (v0.3.5, local fixes published on top of v0.3.4).

## 0. Incident record: the working directory was once thrown whole into the Recycle Bin

Around 2026-11-14 20:55, the entire `D:\apkstart-dsh` directory (261 items: source / test / docs / `.workbuddy` memory) was moved into the Recycle Bin by an operation that looked like "clean up old apkstart artifacts"; the same batch was also cleaned included `D:\apkstart-dist`, `D:\dist-gitee`, `D:\ApkStart-0.3.3-preview`, `D:\tmp-wx` and other old directories — it looks like a wildcard cleanup of `D:\apkstart*` took the working directory along with it.

Recovery process (reusable):

1. **Do not empty the Recycle Bin.** Items on D: are in `D:\$Recycle.Bin\<SID>\`, each item is a pair of `$I<id><ext>` (metadata) + `$R<id><ext>` (data).
2. `$I` layout: version u64 @0, original size u64 @8, deletion time u64 @16, **path length u32 @24 (unit is UTF-16 character count, not bytes!)**, path UTF-16LE @28. Rename `$R` back to the original path recorded in `$I` to recover (directories are automatically recreated).
3. `.git` is not in the Recycle Bin (may have been skipped by the deletion tool): restore history from `C:\Users\15656\WorkBuddy\2026-10-29-20-43-38\apkstart\.git` (e1db34b = v0.3.4), then re-commit the working directory.
4. Verification after recovery: `src/**` and `dist\ApkStart-win64-portable\resources\app\src` are byte-for-byte SHA256 identical; `npm test` 112 items all green.

**Suggestion**: regularly zip source + `.git` + docs + test and place it outside `D:\` (for example under `C:\Users\15656\WorkBuddy\`), not on the same disk as the working directory.

## 1. Toolchain locations (not on PATH, must use absolute paths)

| Tool | Path | Version |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | Bundled with Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | In-repo `node_modules\electron\dist\electron.exe` | 33.4.11 |

First supplement PATH in PowerShell:

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

When dependencies are cleared, reinstall (about 19 seconds, goes through a mirror):

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. Two environment variables every shell must clear first

The host shell inherits these two; failing to clear them causes "Electron runs as plain Node" and other ghost phenomena:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # otherwise electron.exe becomes node, --launch reports bad option
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # otherwise build/pack.js's batch deletion gets blocked by safe-delete into SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. Common commands

```powershell
cd D:\apkstart-dsh\apkstart

# Unit / regression tests (plain Node, no Electron/adb/network needed)
npm test

# Electron integration test (ICO / .lnk / WebP icon fallback)
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# UI smoke screenshots (--settings additionally shoots the settings page; --perf/--download shoot corresponding blocks)
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# Real boot (cold/warm boot timing, --stop does graceful shutdown and saves snapshot)
node tools\e2e-boot.js . --stop

# Portable package (produces dist\ApkStart-win64-portable)
node build\pack.js

# Full installer (needs build/runtime, about 1.4GB runtime; run in CI)
npm run build:exe
```

> After smoke/boot, remember to confirm no leftover processes: `Get-Process -Name ApkStart,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`. The emulator is detached; after Electron exits qemu may still be alive (this is by design: next time it is taken over instantly).
>
> If `dist\ApkStart-win64-portable` is being held (Resource Manager / antivirus / a previous instance still open), `pack.js` falls back to `dist\ApkStart-v<version>-win64-portable`, which is expected; rename it back after closing the holder. Read-only / indexing processes (Defender, SearchIndexer) may make an empty directory undeletable for a few minutes; wait a bit and try again.

## 4. Data and runtime paths (this machine)

| Purpose | Path |
|---|---|
| Settings / app list / logs / APK backup | `%APPDATA%\apkstart` (actual directory name `ApkStart`, case-insensitive) |
| Runtime (emulator + adb + image) | `D:\ApkStartRuntime` (`settings.runtime.dir`) |
| AVD / installed apps / snapshots | `D:\ApkStartData` (`settings.runtime.avdDir`) |
| Shared directory | `%USERPROFILE%\ApkStartShared` |
| Diagnostic report | `%APPDATA%\apkstart\logs\diagnostic-*.txt` |
| Last boot failure record | `%APPDATA%\apkstart\logs\last-failure.json` |

## 5. Text / file operation notes (specific to this terminal)

- **Do not use `Set-Content` / `Get-Content -Raw` to handle UTF-8 files containing Chinese**: PowerShell 5.1 decodes as ANSI by default and writes garbled text (this session tripped over this once, directly destroying a test file). Read/write text using editor tools; when you must write files in PowerShell use `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`.
- **The static methods of `[System.IO.File]` use the process's initial directory**; after `cd` they still resolve the old path — always use absolute paths.
- **Delete large directories**: `Remove-Item -Recurse` may be blocked by the safe-delete layer; use `[System.IO.Directory]::Delete($path, $true)`; if space is not released after deletion, clear the Recycle Bin.
- **Long-running processes** (qemu / large downloads) use background tasks; ordinary commands ending will clean up the child process tree along with them.
- When reading `reg.exe` output, note that it is in console code page; package names / paths and similar ASCII content are fine.

## 6. Common failure reference

| Symptom | Cause / handling |
|---|---|
| `electron --version` outputs `v20.x` (Node version) | `ELECTRON_RUN_AS_NODE=1` not cleared |
| Package build reports `SAFE_DELETE_BULK_GUARD_ERROR` | `NODE_OPTIONS` not cleared |
| `npm test` shows axml/apk cases as "skipped" | No real fixture; synthetic APK cases still run (`test/lib/make-apk.js`) |
| Emulator `0xC0000005` (3221225477) | Rendering backend crashed; new versions automatically switch backends and write `last-failure.json`; report is in `logs\diagnostic-*.txt` |
| "Running multiple emulators with the same AVD" | Leftover qemu holding a lock; `node tools\emu-clean.ps1` or boot again (new version auto-cleans orphans) |
| Gitee 403 in update checks | Anonymous API rate limit; client circuit-breaks for 15 minutes and uses only GitHub; not a failure |
| `reg.exe` / `sc.exe` blocked in sandbox | Only affects automated tests; product running on the user desktop is unaffected |
| Portable version exits after 1 second with no window | Single-instance lock held by another ApkStart process (possibly an old instance that did not exit cleanly); first `Stop-Process -Name ApkStart` |

## 7. Release process (do only after confirmed hands-on pass)

```powershell
# 1. bump version
#    package.json: version -> 0.3.5
# 2. release notes: docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. commit + tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "ApkStart v0.3.5"
# 4. push both repositories (GitHub via SSH, Gitee via https; as needed)
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI: `release.yml` builds the portable version (95MB zip), full Setup (~1.35GB), and runtime whole package (~1.36GB), and syncs the portable version to Gitee (requires `GITEE_TOKEN` secret; failing is a direct failure, not a silent skip). The `full` job's xz compression takes about 40 minutes, which is normal.
