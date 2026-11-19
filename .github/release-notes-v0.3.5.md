# ApkStart v0.3.5 Release Notes

> This version fixes a series of defects confirmed during the code walkthrough on top of v0.3.4, all hands-on tested on this machine.

## What this version solves

### 1. APKs over 2GB cannot install (#21)

The old version read the entire APK file into memory when parsing; over 2GB directly hits Node's single Buffer limit, manifesting as "tap install, pop an English error, bottom-right keeps spinning".

- Parsing changed to **file-version ZIP reader**: only reads the central directory; manifest / resource table / icon read on demand; peak memory dropped from "install package size" to "a few MB";
- `.apks` / `.xapk` split packages also changed to streaming unpack (each split decompressed and written to disk on the fly); on failure cleans the temporary directory;
- `adb install` timeout changed from fixed 4 minutes to **scaled by package body** (2GB package about 5 minutes, capped at 20 minutes), avoiding large packages on slow disks being misjudged as failures;
- Install failure prompts uniformly emitted from the main process event exit, and clear the "installing…" spinning prompt; after error, no longer leaves a perpetually spinning progress bar.

### 2. Large image packages / large update packages ZIP compatibility

- Added **ZIP64** support (EOCD locator + extension field id=0x0001): when entries exceed 65535, no longer silently drop entries; super-large entry offset/size also read from extension fields.

### 3. Deployment stage "stuck at preparing runtime" / "stuck at 99% then re-download a whole set of images"

- Source speed test changed from "no feedback within 30 seconds" to **progress reported per source** (the i-th of n sources); a single source waits at most 6 seconds; unreachable ports only rank last, not affecting download;
- Before downloading the runtime whole package, first prompt "Getting runtime version info…";
- System image expansion failure **no longer silently swallowed**: clearly reports error and gives the filename; no more "progress stuck at 99% → jumps back to official source and re-downloads 1.4GB";
- Image expansion changed to **write `.part` first then atomically rename**: mid-way power loss / closing the program does not leave a "looks completed" half-finished system.img;
- "Already expanded" judgment changed from "greater than 32MB" to "at least not less than the compressed package size"; half-finished images are re-expanded;
- Disk guard supplements the runtime whole package estimate (1.5GB compressed + 3.3GB expanded, peak coexisting); insufficient space gives an actionable prompt in advance instead of failing halfway through download.

### 4. Changed "runtime data directory" in settings, but still downloads to the old directory (#23)

When the portable program directory has a side `runtime/`, the old version would, at launch, overwrite the user's manually set `runtime.dir` with that bundled runtime. Now: **as long as the user has explicitly specified a directory and it contains an emulator, it is always respected**; only "never set" or "the set directory is already unusable" automatically takes over.

### 5. Online update may treat the 1.5GB runtime whole package as the program package

The release hangs both the portable package and `ApkStart-runtime-*.zip`. The old version's fallback `.zip` match did not exclude the latter; if a release accidentally omitted the portable package, the updater would decompress the runtime whole package into the program directory. Now the fallback match explicitly excludes `runtime` assets; when no usable asset exists, it truthfully prompts "please go to the release page to download manually".

### 6. After boot failure, diagnostic report cannot see the cause (#20 / #25)

The old version only kept "launch attempt records / diagnostic conclusions" in memory; the user restarts ApkStart and then exports a report; inside it is `attempts: []`, `UNKNOWN`, only letting the author go dig through logs.

- On boot failure, **attempts / diagnostic conclusions / exit code** are written to disk at `%APPDATA%\apkstart\logs\last-failure.json` (cleared on next successful boot);
- The diagnostic report carries the on-disk record, exit code meaning, and the tail of `emulator.log` (when memory log is empty, directly reads the last 300 lines from file);
- Added **`0xC0000005` (decimal 3221225477) diagnostic rule**: judged as "rendering backend crash", suggests updating GPU driver / lowering graphics quality, instead of vague "runtime failed to complete boot";
- On encountering this kind of crash, **automatically retries with a more conservative rendering backend and remembers** (`engine.badGpu`, invalidated per emulator version); next boot no longer crashes into it first;
- The runtime panel on the settings page directly shows "Last boot failed: …", without waiting to export a report.

### 7. Uninstalling ApkStart wipes the user's original .apk file association

The old version, when unassociating, unconditionally cleared `.apk`'s default program (the "only when still pointing to ourselves" promised in code comments was not implemented). Now:

- On registration, the original default program is remembered to `HKCU\Software\ApkStart\assocPrev`;
- On unassociation, **prioritizes restoring** it; only clears when there is no record and the current one still points to ApkStart;
- Hands-on on this machine: original association was `MuMuPlayer.apk`; after register → cancel, restored to original.

### 8. Icons: formats beyond WebP, and "using a placeholder but not saying so"

- Icon candidate formats added `jpg/jpeg`;
- Adaptive icons / `layer-list` XML now recursively find bitmaps (up to 3 layers), no longer uniformly falling back to the brand placeholder;
- When truly unable to parse, the install completion prompt clearly says "icon cannot be parsed, shortcut temporarily uses placeholder icon", instead of letting the user stare at a green triangle and guess.

### 9. After fresh install, tapping the desktop icon, only seeing the Android desktop

An upstream bug found by hands-on (v0.3.4 also had it): after installing an app, the launch entry recorded in `apps.json` is the "full component" (`com.foo.bar/com.foo.bar/.MainActivity`), while launch time spliced the package name once more; `am start -n` gets `com.foo.bar/com.foo.bar/com.foo.bar/.MainActivity`; the system directly cancels the launch (log `result code=-92`) — what is in the window is the Android desktop.

- Added `componentArg()`: full component used as-is; pure class name only then supplements the package name; both historical data forms are compatible;
- `parseResolvedActivity()` changed to scan all lines (the end of `resolve-activity` output often carries blank lines); no longer misjudges "cannot resolve" because the last line is an empty string;
- Hands-on: after reinstalling Hongguo, tap desktop icon; `mCurrentFocus` correctly lands on `com.phoenix.read/...SplashActivity`; the window is the app's own interface (no longer the desktop).

### 10. Log rotation boundary

- When the log filename does not end with `.log`, rotation would "delete first then rename", causing log loss; now directly skips rotation (log can be a bit larger, but will not be lost).

### 11. Others

- Added "synthetic APK" test fixture (`test/lib/make-apk.js`): self-made binary AXML manifest + PNG icon + ABI directory; when real APK fixtures are missing, the parsing stack still has coverage;
- Added/expanded regression cases: Zip64, .xapk split packages, materializeImages, update asset selection, `0xC0000005` diagnosis, log boundary, failure record on-disk, WebP icon fallback;
- `npm test` increased from 98 items to **113 all green**.

## Verification record

| Item | Result |
|---|---|
| `npm test` | 113 passing / 0 failed (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO / .lnk / WebP fallback all passing |
| Real cold boot | 25.0s ready (`sys.boot_completed=1`) |
| Snapshot hit | 5~6s |
| Graceful shutdown | `code=0`, `hasSnapshot=true` |
| Real machine APK parsing | Hongguo short dramas 7.4.3.32 / `res/b/a3.webp` / arm64-v8a correct |
| 2.15GB APK parsing | 18ms completed, process RSS 47MB (old version needed to read the entire 2.2GB into memory) |
| Fresh install + desktop icon launch | After reinstalling Hongguo, tap icon: `mCurrentFocus` = `com.phoenix.read/...SplashActivity`, window is app interface (before fix was Android desktop) |
| Runtime self-check `npm run selftest -- --apk` | **13 items all pass**: adb / engine / image / AEHD, Android 14 API34, freeform, shared folder two-way sync, parse→install→standalone window launch→screenshot |
| `tools/check-launch-clean.js` | Install + open full process: app window **0.5s appears**, emulator/console windows cumulatively **0 times** |
| Install chain | Packaged version dragged in 153MB APK: 22s completed parse/install/icon/shortcut; desktop + Start menu .lnk Target/Args/Icon all correct |
| No window leakage | `check-quit-clean`: full boot process + 8s after exit, visible emulator/console windows **0** |
| Registry association | This machine's original association `MuMuPlayer.apk`; after register→cancel, restored to original |
| Packaged version | 226MB portable package, UI smoke passed |

## Known limitations

- The **root cause** of `0xC0000005` is still on the GPU driver / Vulkan backend side; this version does "automatically switch backend + write the cause clearly"; if a machine still inevitably crashes, just send the new diagnostic report for location.
- Icon parsing still does not support `shape`/vector drawables (falls back to placeholder, and truthfully prompts).
- `.apk` association is written to HKCU (no admin needed); if another program in the system repeatedly grabs the association back, the system "default app" setting takes precedence.
