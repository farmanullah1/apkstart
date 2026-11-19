# ApkStart v0.5.7

This release adds the **drivers (compatibility patches)** extension: when a machine cannot run, instead of waiting for ApkStart to release a new version, write a JSON patch to fix the parameters, and it can be shared with others.

The install package is still independently runnable, carrying only its own runtime — drivers change **our own emulator launch parameters**, and do not involve any third-party emulators.

---

## 1. Why drivers are needed

The same default parameters cannot cover all machines. Examples actually encountered:

- AMD integrated GPU + old driver: `-gpu host` passes the emulator self-check, but the guest process crashes directly after a few tens of seconds of boot (the log only shows `AEHD is operational`) → switching to `swangle` fixes it;
- Machine without "Virtual Machine Platform" enabled: hardware acceleration will always fail, should go `-accel off` from the start;
- Old Intel integrated GPU: GLES initialization failure / distorted screen → use `software` rendering;
- Certain screen ratio + DPI combinations need `hw.lcd.density` changed to avoid blur.

These are **machine attributes**, not program bugs. Hard-coding them in code means releasing a new version every time; making them data files means that whoever finds a working combination can write one JSON file to help machines of the same model.

## 2. What a driver is

A driver is one JSON:

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD integrated GPU switch to swangle rendering",
  "version": "1.0.0",
  "match": { "platform": ["win32"], "gpuVendor": ["amd"], "accel": ["whpx"] },
  "effect": { "gpuMode": "swangle", "notes": ["If still black screen, change to software"] }
}
```

- `match`: whether this machine uses it (GPU vendor / model regex / memory / cores / system build number / acceleration state / emulator version);
- `effect`: what changes after a match (`gpuMode`, `forceTcg`, `emulatorArgs`, `configIni`, `env`, `notes`);
- `priority`: when multiple drivers match at the same time, larger ones are applied later (override earlier ones).

Full field table and whitelist see **`docs/drivers.md`**; three built-in examples are in `src/drivers/`.

## 3. Security boundary (important)

Driver files can be downloaded from the web and passed around, so:

1. **Only recognize JSON, execute no code** — no script hooks, no `eval`, never `require`s anything in the driver;
2. **Parameter whitelist** — `-gpu` / `-accel` / `-feature` / `-gltransport` / a single `-qemu` and several switch-type parameters; `-wipe-data`, `-partition-size`, `-datadir`, `-sysdir`, `-avd`, `-port` are all rejected (would delete data / change locations);
3. **config.ini whitelist** — only allows `hw.gpu.*` / `hw.gltransport` / `hw.keyboard` / `hw.audio*` / `hw.camera.*` / `hw.gps` / `vm.heapSize` / `hw.lcd.density`; data partition, memory, CPU core count do not accept external changes;
4. **env whitelist** — only allows `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` prefixes; `PATH` / `SystemRoot` / `NODE_OPTIONS` are directly rejected;
5. A single file ≤256KB; bad files only record errors and do not affect other drivers; drivers that do not match have no effect at all.

## 4. UI

The settings page adds "Drivers · compatibility patches":

- Lists each driver's name, version, author, match conditions, and whether effective;
- Switch: built-in examples are off by default; tap once to enable (written into settings, not changing the read-only install directory);
- **Import driver…**: select JSON → validate → save to `%APPDATA%\apkstart\drivers\<id>.json` → enable immediately;
- **Open drivers directory** / **Export current machine template** (the `match` is already filled in for the current machine; change `effect` to use);
- Files that fail to load are explained one by one below the list (JSON syntax, wrong fields, over limit).

## 5. Integrated into the boot chain

- Parsed once before boot: overlay matched drivers into one effect (`priority` small first, large later overrides);
- `gpuMode` / `forceTcg` apply to **every round** of boot attempts (including automatic downgrade retries) — if the driver says "this machine can only use swangle", there is no need to try backends that already crashed again;
- `emulatorArgs` appended to the command line (`-gpu` / `-accel` are uniformly handled by the previous two items, to avoid duplicate parameters);
- `configIni` overwrites the same-name keys in `config.ini` in place, appends missing ones;
- `env` merged into the emulator process environment;
- Boot log writes one line `drivers: amd-igpu-swangle@1.0.0`, also visible in the exported diagnostic report.

## 6. Verification

- Full plain Node test suite **287 items passing**, of which drivers **29 items**: validation, matching, stacking, switch, read-disk tolerance, import/export, whitelist rejection (`-wipe-data` / `-partition-size` / `PATH` / newline injection), and "do `buildArgs` / `env` / `config.ini` actually use the driver effect";
- `scripts/selftest.js` 9/9 (real `emulator-5554`);
- MSIX 0.5.7 rebuilt; payload contains no third-party emulator files; source and in-package are consistent.

## Upgrade notes from 0.5.6

- `0.5.7.0 > 0.5.6.0`, Store can directly overwrite upgrade; installed apps, data, and snapshots are all retained.
- Default **does not** enable any drivers: built-in examples are `enabled:false`; behavior is completely consistent with 0.5.6.
- To patch your machine: Settings → Drivers → Export current machine template → edit `effect` → Refresh.

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.7.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Submission materials: `docs/store-listing.md` (includes this version's What's new in Chinese and English)
- Driver documentation: `docs/drivers.md`
