## What this version solves

### 1. Slow download: the real cause is "all threads crowded on one walled-off address"

Hands-on this machine: 8 threads all hitting GitHub only **0.23 MB/s**; an 113MB update package takes **493 seconds**; at the same time two connections hitting direct connection are **zero bytes** (TCP connected but no data); only the mirror is running.

- **Multi-source parallel split**: after splitting the file into blocks, different blocks simultaneously pull from "GitHub direct / ghfast / gh-proxy", bandwidth stacked. Same machine hands-on: **113MB dropped from 493s to 77s** (about 1.5 MB/s, including speed test and decompression).
- **Slow-source swap**: when a block runs to a few tens of KB/s, automatically interrupts, swaps source, continues from breakpoint — previously would "get stuck at 95% motionless".
- **Block breakpoint resume**: 1.4GB runtime package fails halfway; re-executing only supplements missing blocks, no need to start over.
- **Stagnation watchdog**: connection established but 20 seconds without bytes, immediately discard that connection and switch to the next source; no longer dumbly wait 30s socket timeout to deadlock the whole package.
- **Measure and select on the spot each time**: each candidate address truly downloads 256KB to speed test, only counts throughput **after the first byte arrives** (counting the handshake few hundred milliseconds would misjudge a "high-latency but high-bandwidth" source as slow); sequential measurement avoids mutually stealing bandwidth.

### 2. Dual source: GitHub and Gitee automatic selection

- Both repos are now public: GitHub `farmanullah1/APK-START-English`, Gitee `daily-miku/apkstart`.
- Version check asks both sides simultaneously, takes the higher version number; one source timeout / walled off does not affect the other.
- Gitee release attachments have a 100MB single-file limit, so the portable package is published there as `.part1/.part2`; the client automatically selects sources per split to download and splices back into a whole package (verifies each split size; missing split immediately aborts).
- Gitee anonymous calls have rate limiting: added 10-minute version cache + 403/429 circuit break for 15 minutes; when both sources are down, falls back to the last result and marks `stale`; UI does not directly report error.

### 3. Will no longer mistakenly delete user data

- **No longer auto-clear data on full disk**: previously the last rung of the retry matrix carried `-wipe-data`; on full disk every rung fails, continuous retry would wipe apps and save files together. Now any automatic retry prohibits clearing data; insufficient disk directly stops and tells you what to do.
- **Image moving disks does not count as changing images**: after moving the runtime directory from C drive to D drive (the settings suggest doing so), previously would be judged "image changed" → `-wipe-data` → all installed apps lost. Now compares by image identity; disk change does not touch data.
- **`qemu-img resize` parameter order** corrected: previously would appear "file stretched to 6GB, filesystem still 64MB"; Android writing fills up, all services `setxattr` report ENOSPC crash. Now also self-heals comparison at boot.

### 4. Others

- Install failure no longer spams: the same APK rapid-tap only runs once; failure prompts give executable conclusions by type (partition insufficient / ARM package / signature conflict / version downgrade).
- Resources and disk controllable: resource policy three grades (save resources / balanced / smooth), graphics quality three grades, Android data partition 4–24GB adjustable and supports in-place expansion (does not lose installed apps), Android data directory can be pointed separately to another disk.
- Volume: portable version 230MB (cut 52 unused language packs, saving 39MB).
- Log rolls by size, no longer unlimited growth; shared folder sync no longer repeatedly shuttles the same file back and forth.

## This hands-on verification (same machine, Windows 11 + Android 14 Play image)

| Item | Result |
|---|---|
| Cold boot to openable app | **23–25 seconds** (first time including probe about 32 seconds) |
| Quickboot snapshot hit | **5 seconds** |
| Install APK and open app | App window appears in **1.5 seconds** (warm snapshot) |
| 45s full boot visible emulator/console windows | **0** |
| Desktop residual windows after exiting ApkStart | **0** |

## Install

- **Full version** `ApkStart-*-Setup.exe`: bundles runtime, usable immediately after install (about 1.4GB).
- **Lightweight version** `ApkStart-*-win64-portable.zip`: unzip and use; first launch automatically downloads runtime (now selects the fastest source, and supports breakpoint resume).

Both repos' content is consistent; domestic recommended to go Gitee.
