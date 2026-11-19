# ApkStart v0.5.5

This release solves three things: **black screen** (MuMu base + host GLES gap), **50GB-class large games that cannot fit / fail halfway through installation**, and **memory / CPU / storage that the user can allocate themselves**.

The install package is still **independently runnable**: it comes with emulator + platform-tools + system image; install and use immediately, with no need to pre-install MuMu or any other emulator. MuMu is only reused "when your machine already has it", as an optional enhancement.

---

## 1. Black screen auto-diagnosis and self-healing (MuMu base)

This machine's MuMu 12 graphics log reports on every boot:

```
EGL ERROR: eglCreateContext: Requested GLES version (3.2) is greater than max supported (3, 1)
```

The instance's configured GPU is `Adreno (TM) 740` (advertised as GLES 3.2), while the host GPU only provides up to GLES 3.1. The result: Android comes up, ADB can connect, the game process is alive, **but the screen window is fully black** — what the user sees is "open and black screen".

The current handling order:

1. Read MuMu's `graphics_log`, parse out the host's real GLES version and GPU model;
2. Arrange rendering tiers by GPU (5 tiers: `dx/vk` × high/medium/low), write into MuMu settings before boot;
3. After boot, capture one guest framebuffer frame, sample and calculate brightness to judge whether it is pure black;
4. If black, switch to the next tier and restart, until the screen is normal, and remember the tier this machine can use;
5. Only perform the checkup on "the instance ApkStart launched this time"; **does not go restart the emulator you are using**.

Also fixes a real bug: `windowTargets()`'s called `findDeviceWindows()` / `hwndOf()` were never defined; MuMu's window takeover actually never reached the designed path (manifests as window not embedding / standalone window not appearing).

## 2. 50GB-class large games

- Pre-check disk before installation: estimate per "install package × 1.8 + 2GB"; a 50GB package needs about 92GB; if space is insufficient, it says so **before installation**, instead of failing at 80%.
- The built-in runtime also checks `/data` partition capacity at the same time (only expanding the host image while the guest partition does not follow is equivalent to not expanding).
- Large package install timeout is scaled by body size, no longer fixed at 180 seconds.

## 3. Memory / CPU / storage allocated by the user

The settings page adds "MuMu instance resource allocation": memory 2~32GB, CPU 2~16 cores, `0 = use MuMu's original settings` (default does not touch your configuration). On the built-in runtime side, the fillable upper limit for memory and cores is changed to follow the host — previously hard-coded at 8GB / 8 cores, a 32GB machine could only allocate 8GB.

All inputs are converged uniformly before saving: leave 25% memory for Windows, leave at least 1 core, data partition no more than 80% of the disk it is on. Hand-editing `settings.json` to 999GB also will not crash qemu.

Hands-on: pass 8192MB / 6 cores → guest `MemTotal 8138280 kB`, `/proc/cpuinfo` 6 cores, all matching.

## 4. Storage expansion no longer "fake success"

Previously tapping "Expand immediately" showed success, but quickboot would create a `userdata-qemu.img.qcow2` differential disk layer for userdata; the guest mounts that: the base expands to 8GB, the inner `resize2fs` also reaches 8GB, but `df /data` is still 5.7GB; installing a 50GB game still fails halfway.

There is no root inside the guest, nor `resize2fs`; the differential disk cannot be merged on the host side into usable ext4. So now it is changed to **report the error truthfully**: give `needsReset`; after a second confirmation on the UI, go "clear and rebuild /data at the new capacity", instead of pretending expansion succeeded.

## 5. Hard guarantee of independent operation

- The packaging script adds a guard: if MuMu / LDPlayer / BlueStacks binaries or directories appear in the output, the **build directly fails**. This kind of problem can never be measured locally, only exposed on someone else's computer, so it is caught at build time.
- When settings retain `mode=mumu` but this machine does not have MuMu installed (imported configuration, or MuMu uninstalled), it no longer fails to start and hangs the whole app; instead it automatically falls back to the built-in runtime and explains the reason in the log; re-select the base to switch back.
- The default engine is always the built-in runtime; on Windows, automatic selection also puts builtin first, and does not go take over a simulator the user has open themselves.

---

## Upgrade notes from 0.5.4

- `0.5.5.0 > 0.5.4.0`, Store can directly overwrite upgrade.
- Installed Android apps and save files are all retained; no need to reinstall.
- For users using the MuMu base: after upgrade, the first boot will re-checkup the screen, possibly taking a few extra tens of seconds; the remembered usable tier will be shown on the settings page.
- To enlarge the data partition: after saving the new capacity, "clear and rebuild /data at the new capacity" is needed; this clears installed apps, and after rebuild you can reinstall.

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.5.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Submission materials: `docs/store-listing.md` (includes this version's What's new in Chinese and English)
- Steps: `docs/store-upload-walkthrough.md`

Test: full suite 275 items passing (new MuMu compatibility 20 items, resource allocation 32 items, independent operation 15 items).
