## What this version solves

### 1. Opening ApkStart makes WeChat's (and other Qt apps') windows disappear

This was the most severe problem of the previous version. The window agent previously recognized its own windows by **window class name**:

- `FindEmulator()` recognized windows "whose class name contains `QWindowIcon`" — this is the class name of **all Qt top-level windows**;
- `HideToolWindows()` recognized windows "whose class name contains `QWindowTool`" — and Qt's menus, emoji panels, and floating sub-windows use exactly `QWindowToolSaveBits`;
- The resident suppression scans a round every 120ms, and `ShowWindow(h, 0)` on whatever it finds; `embed` / `park` also `SetParent` on it.

WeChat 4.x happens to be Qt 6 (`Weixin.dll` contains `QWindowToolSaveBits` / `Qt6` strings); its main window class name is `Qt51514QWindowIcon` — exactly the same as the emulator. So "opening ApkStart, WeChat window disappears / is embedded into ApkStart becoming a black block" happened.

**Hands-on comparison on the same machine** (WeChat 4.1.7.59, main window 296×388):

| Version | WeChat window status |
|---|---|
| 0.3.3 | 3.7s after launch `hidden`, then 74 subsequent samples all hidden |
| 0.3.4 | 45s / 280s two rounds full process `visible`, hidden 0 times |

**Fix: class name is not identity, process path is.** 

- Added `scope` command: the main process, before suppression/embed, pushes "our directories" (runtime root directory + the `engine` directory carried with the package) and the main process pid;
- All window judgments first go through `IsOurs(pid)`: the process executable must fall within these directories;
- **When there is no scope, not a single window is touched** — better to miss a black window than hide someone else's window;
- Console black windows no longer use fuzzy matching like "title contains emulator/qemu/netsim"; changed to the conhost parent process chain can reach the runtime directory, or the title contains the runtime directory's absolute path;
- `embed` verifies the host window's pid must equal the main process pid, otherwise rejects (prevents after handle reclamation, embedding the window into someone else's app);
- Mouse hook adds `IsWindow(_host)` and host pid verification; invalid handle is always let through;
- Rotation (Ctrl+←/→) only sends global keys when its own window is foreground; otherwise simply does not send;
- After agent process rebuild, re-push scope; otherwise the new agent dares not touch anything.

### 2. Also put a whole package on Gitee that can be double-clicked and unzipped directly (no longer part1/part2)

- Switched compressor: `Compress-Archive` (.NET deflate) → 7-Zip `-mx=9`; same directory **105.2MB → 99.8MB**;
- Removed `d3dcompiler_47.dll` inside the package (Windows 8.1+ `System32` carries the same-name DLL; tested no rendering difference), saving another 2.1MB; `vk_swiftshader` / `vulkan-1` retained — relied on when GPU driver is unavailable;
- Final **95.0 MiB**, within Gitee's single-file limit (100MB); download and directly unzip;
- Added `build/zip.js`: after compression, uses the app's own zip parser to verify entry count and total decompressed bytes; **over 100MiB directly makes CI fail** — package getting fat later will blow up on the spot, instead of silently falling back to split packages again.

### 3. "Dual-source automatic selection" previously actually did not take effect

Same-name assets deduplicated by name, first-come-first-served, GitHub ranked ahead, **Gitee's same-name address was directly dropped**. After whole packages no longer split, it was equivalent to always only using GitHub.

- Same-name assets changed to merge `urls`, and record `size` per address separately (the two sources' compressed bytes were always different);
- Speed test selection before download; `downloadMulti`'s "only mix sources with consistent declared sizes" changed to use the **fastest source**'s total size as baseline (previously fixed `Math.max`, equivalent to always downloading the larger-volume source);
- Hands-on this machine's four candidates (GitHub direct / ghfast / gh-proxy / Gitee), the fastest was Gitee, 95.2MB / 48s (about 2 MB/s).

### 4. Others

- Agent's "watch window" judgment only recognizes processes inside its own runtime; other emulators (MuMu / LDPlayer's own emulator.exe) no longer let the agent watch for 3 more minutes;
- Tool scripts (`check-agent` / `check-console` / `check-windows` / `check-launch-clean` / `check-quit-clean`) synced and supplemented scope.

## Verification record

| Item | Result |
|---|---|
| Unit + integration tests | run-tests 3 / auto-test **70 passing, 0 failed** |
| End-to-end (real runtime + real AVD + Hongguo APK) | Install → open → embed all passing; app window 0.5s appears; leaked windows cumulative **0** |
| WeChat (4.1.7.59) coexistence | Emulator launch / install app / embed full process, WeChat window hidden **0 times** |
| Gitee whole package | 95.18 MiB, `Expand-Archive` 5.2s unzip, 69 files md5 consistent with source directory |
| Real download from Gitee | 95.2MB / 48s, zip structure complete |

## Download

- Lightweight version `ApkStart-v0.3.4-win64-portable.zip` (**95 MB**, unzip and use, first launch then downloads runtime): GitHub and Gitee are both **one complete zip**, no need to splice splits.
- Full version `ApkStart-0.3.4-Setup.exe` (about 1.35 GB, bundles adb / emulator / system image, usable offline after install): volume exceeds Gitee single-file limit, only placed on GitHub.
