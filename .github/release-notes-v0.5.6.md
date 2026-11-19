# ApkStart v0.5.6

This release does only one thing, but does it thoroughly: **delete the entire "third-party emulator base" chain**.

From this release, ApkStart **runs independently in all cases**: it only uses its own adb / emulator / system image, and does not probe, take over, drive, or depend on any emulator installed on your machine (MuMu / LDPlayer / BlueStacks / WSA / FydeOS are all not connected).

0.5.5 already achieved "the package does not carry someone else's emulator, defaults to the built-in runtime", but the code still retained the mumu / fydeos / attach three bases and the "fall back when unavailable" judgment. As long as that path remains, if the user switches in settings or imports an old `settings.json`, ApkStart will again go and drive someone else's emulator — where data, save files, and images land is unclear, and the other side's upgrade or port change will directly invalidate it. This release tears down the path; it does not just turn it off.

---

## 1. Only one runtime

- `src/core/backends/` now only has `base.js` / `builtin.js` / `index.js`: `mumu.js` (842 lines), `fydeos.js` (365 lines), `mumu-compat.js`, `frame.js` all deleted.
- The registry is fixed to `['builtin']`; `create()` **intentionally ignores `settings.engine.mode`**: residual `mode=mumu`, `fydeos`, `attach`, and any manually changed value, all create the built-in runtime.
- No more "automatic selection": it no longer scans third-party emulator install directories, registry, or adb ports. `autoPick()` directly returns builtin; not a single `probe()` is called in the source.
- Also removes a hidden risk: the adb candidate paths previously included MuMu / LDPlayer / BlueStacks' own adb. Using their adb would inherit someone else's server state (port, authorization, offline jitter); now it only recognizes the Android SDK and manually installed directories, and its own copy always goes first.

## 2. Old configuration will not bring third parties back

- `store.getSettings()` forcibly sets `engine.mode = 'builtin'` when reading from disk, and deletes residual fields like `mumuPath / mumuIndex / mumuRenderProfile / mumuMemoryGB / mumuCores / fydeosHost`.
- Only changes the object in memory, does not immediately write back to disk: the settings file belongs to the user; it naturally lands on disk the next time they save settings.
- The engine's `_fallbackFrom` fallback marker, `backendAvailable()` branching, `attach` branch, and `ATTACH_ENDPOINTS` (fixed ports for WSA / LDPlayer / MuMu / Nox / MEmu) are all removed.

## 3. Settings page is simpler

- The "engine mode" dropdown is removed, replaced with a one-line read-only note: *ApkStart built-in runtime (QEMU + Android 14, runs independently)*.
- Four groups of controls are deleted: "MuMu install directory", "FydeOS address", "device address + detect button", "MuMu instance resource allocation".
- Memory / CPU cores / data partition can still be allocated by the user (that was added in 0.5.5, goes through qemu parameters, unrelated to third parties); the upper limit is still calculated from host memory, core count, and remaining disk space.

## 4. Build-time guard tightened

`build/guard-standalone.js` previously only blocked "emulator binaries and directories"; now it also blocks **adapter source code**: if any of `backends/mumu.js`, `backends/fydeos.js`, `core/mumu-compat.js`, `core/frame.js` appears in the packaging output, the build directly `exit(4)`. This way "another path that can take over someone else's emulator" will not quietly slip into the package.

## 5. Verification

- Full plain Node test suite **258 items passing**; `scripts/selftest.js` against a real running `emulator-5554` **9/9 passing** (device, Android version, resolution, freeform, shared folder two-way sync).
- Independent-run tests expanded from 15 to 22 items; new: registry only builtin, various residual modes only create builtin, explicit `id=mumu` also cannot be forced through, third-party module files must not exist, settings page no longer has an engine dropdown, persistence layer overwrites obsolete fields, adb candidates do not include third-party adb, guard blocks adapter source code without harming `builtin.js`.

## Upgrade notes from 0.5.5

- `0.5.6.0 > 0.5.5.0`, Store can directly overwrite upgrade.
- Installed Android apps, save files, and quickboot snapshots are all retained; no need to reinstall.
- For users who previously switched the engine to MuMu / FydeOS / attach: after upgrade, automatically return to the built-in runtime; the settings page shows only the read-only runtime note; the first boot may wait a few extra tens of seconds because of re-guiding the built-in runtime.
- Apps and data from when you used a third-party emulator are over there, not here; if needed, drag the APK in again to install.

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.6.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Submission materials: `docs/store-listing.md` (includes this version's What's new in Chinese and English)
- Steps: `docs/store-upload-walkthrough.md`
