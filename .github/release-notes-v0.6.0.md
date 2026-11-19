# ApkStart v0.6.0

This release reorganizes the settings page and adds **auto-detection**:
settings items are grouped into 8 categories by purpose and are searchable; the background periodically checks this machine's health and only notifies once when a new issue is found, with the rest quietly listed under "Diagnostics & Repair".

---

## 1. Settings page reclassified

Settings items grew to 16 groups; a single long scroll was already hard to navigate. Now there is a left navigation column, grouped into eight categories:

| Category | What's included |
|---|---|
| General & Installation | Runtime & environment, one-click setup, launch at startup, disk usage & cleanup |
| Display & Window | Display mode, auto-fullscreen, screen orientation, mirror auto-rotate, tablet layout, window hosting mode, portrait size, Android system settings (Wi-Fi / animations / volume / font / display size) |
| Controls & Input | Mouse keybindings, keyboard mapping (gamepad) |
| Performance & Resources | Resource policy, graphics quality, data partition, system language, Chinese IME, network acceleration, sound, snapshots, container details, background trimming, boot warm-up, advanced parameters |
| Network & Downloads | Update & download sources, public acceleration mirrors, mirror prefixes, download thread count, Gitee token |
| Diagnostics & Repair | System health check & auto-config, drivers & compatibility patches, auto-detection & smart diagnostics |
| Integration & Files | Desktop & app shortcuts, file sharing, system integration |
| Updates & About | Software updates, about |

Plus a search box: type keywords like "landscape", "memory", "proxy", "snapshot", and matches **cross categories** (no "searched in vain" just because you were in another category). The last-stayed category is remembered (localStorage), and reopens there next time.

Jump logic was also updated: tray "install guide", status bar self-check count, and "data partition has a problem" entries inside the detection panel now all go through the unified `focusGroup()` — switching to the corresponding category first and then scrolling, instead of scrolling to a currently-invisible group.

## 2. Auto-detection (auto debug)

The background periodically samples machine state and produces a **problem list grouped by category**:

| Category | What it checks |
|---|---|
| Runtime | Real cause of last boot failure, boot freeze, leftover lock files, orphaned emulator processes, empty snapshot shells, no hardware acceleration |
| Device connection | ADB unauthorized (the "Allow USB debugging?" prompt was never clicked), offline, runtime running but ADB cannot see the device |
| Storage | Disk space, data partition configured value vs actual value (differential disk blocks expansion), shared folder writability |
| Settings | Orientation policy vs physical panel conflict, auto-fullscreen not working in standalone window mode, disk tight + snapshots off |
| Network | No internet on the Android side, download source unreachable |
| Logs | Error lines in recent logs |

### Three design principles (all learned the hard way)

1. **Collection and judgment are separated**: `src/core/autodebug-probe.js` handles collection (it calls system commands), `src/core/autodebug.js` is a pure-function judgment layer that does not touch fs / electron / child_process — so CI can directly `require` it and unit-test it (lesson from 2026-11-17: in CI, modules with a top-level `require('electron')` all go red).
2. **Detection failure ≠ problem**: if status cannot be obtained, leave it blank; the judgment layer treats it as "unknown". Never fabricate a line just to have "something to report" — one false alarm and users stop trusting auto-detection.
3. **Only disturb when a new issue appears**: old issues have already been prompted; popping a window every round is noise; severity escalation (e.g. warn→error) re-prompts; recovery is only silently accounted.

### One-click fix

Each problem carries a "Fix" button that directly reuses the settings page's existing repair entry:

| Problem | Fix action |
|---|---|
| Unauthorized / boot freeze / orphan lock | Restart runtime (go through a cold boot, authorization popup reappears) |
| Leftover lock file | Clear the lock file |
| Orphaned emulator process | Kill the leftover process holding the AVD lock |
| Empty snapshot shell | Invalidate snapshot (one cold boot, reclaim several GB disk) |
| Disk pressure | Clean recoverable files |
| Data partition not effective | Jump to the performance page to rebuild (will clear installed apps; **not done automatically**) |
| Orientation conflict | Change the panel orientation to match the policy |
| Android no network | Reset Android network (app list retained) |
| Log errors | Export diagnostic report |

## 3. Critical fix: 0.5.9 "clicking an app does nothing / no app can open"

This was a fatal regression in 0.5.9, and this release roots it out. The failure chain has three links; missing any one does not trigger it:

1. **Packaging forgot to include native modules**: `build/pack.js` only copies `src/`, never copies `node_modules`. The system image is `.img.xz`, and decompression relies on `@napi-rs/lzma` (a production dependency in `package.json`). The packaged app, on first launch, throws `Cannot find module '@napi-rs/lzma'` — the image cannot be expanded, the runtime cannot start, all four parameter combinations result in `boot-failed`, and what the user sees is "installed but nothing opens". Now packaging copies production dependencies per `dependencies` (scope packages bring the whole scope together; native binaries live in `@napi-rs/*-win32-x64-msvc`). When missing, it now reports a readable error (`LZMA_MISSING`) instead of a long `require stack`.
2. **The image file itself was truncated**: `system.img.xz` was only 495 MB, decompressing to 1366 MB (should be 2958 MB), then reporting `failed to fill whole buffer`. Packaging now adds **xz integrity verification** (checks the footer); a truncated image now makes the build fail directly instead of waiting for the user to install and then discover.
3. **Having an existing image went and decompressed again**: previously `paths()` picked `system-images` as long as the runtime directory had it, even if that place only had a compressed package while the user data directory already had a usable 3.1 GB `system.img`. Now it prefers the already-expanded location, using whichever is available.

## 4. Verification

- Added `test/autodebug-test.js` **29 items**: empty snapshot no false alarm, unauthorized/offline distinction, disk and data partition thresholds, orientation conflict judgment, summary and diff, front-end/back-end category table consistency, IPC wiring.
- Added `test/settings-categories-test.js` **12 items**: each group has a category, categories and navigation correspond one-to-one (no "clicked and it's empty"), search crosses categories, jumps uniformly via `focusGroup`.
- Added `test/settings-ui-test.js` (real Electron window, 15 items): open settings → switch categories → auto-detection panel rendering → search → clear → remember category → console no errors.
- Full plain Node test suite **355 items passing** (original 314 + 41 new).
- UI screenshots: `test/out/settings-{display,diag,search}.png`.

## Upgrade notes from 0.5.9

- `0.6.0.0 > 0.5.9.0`; Store can directly overwrite upgrade; installed apps, data, and snapshots are all retained.
- No settings items were deleted, only reclassified; previously remembered scroll position no longer applies (changed to remember category).
- Auto-detection is **enabled by default**: runs the first round 25 seconds after launch, then every 10 minutes. To disable, turn it off under "Settings → Diagnostics & Repair", or set the interval to 1 hour.
- Detection is read-only and does not change the system: except for actions you tapped in "one-click fix", it does not change any settings.

## Microsoft Store

- Package: `dist/store/ApkStart_0.6.0.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Submission materials: `docs/store-listing.md` (includes this version's What's new in Chinese and English)
