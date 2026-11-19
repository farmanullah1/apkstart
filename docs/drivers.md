# Drivers (compatibility patches)

> Since ApkStart 0.5.7, the "drivers" extension is supported: one driver = one JSON file
> that declares **which machines to match** + **what launch parameters to change when matched**.
> Users can write a patch for "my machine" themselves without waiting for an ApkStart release.

---

## 1. What problem does it solve

The same default parameters cannot run on every machine:

- Old integrated GPUs whose GLES only reaches 3.1; with `-gpu host` the guest crashes after a few tens of seconds;
- Machines without "Virtual Machine Platform" enabled will always fail hardware acceleration and must fall back to software emulation;
- Some GPU driver versions go black screen as soon as Vulkan is turned on; switching to `swangle` fixes it;
- Certain screen ratio / DPI combinations need `hw.lcd.density` changed to avoid blur.

These differences are **machine attributes**, not program bugs. Hard-coding the judgment in code means releasing a new version every time; making it a data file means that once a user (or community) finds a working combination, one JSON file can be shared with others.

## 2. Where they live

| Location | Purpose |
|---|---|
| Settings → Drivers → **Open drivers directory** | Your own drivers, `%APPDATA%\apkstart\drivers\*.json` (Store version in `%USERPROFILE%\ApkStart\data\drivers`) |
| Install directory `resources/app/src/drivers/` | Built-in examples, read-only, default `enabled: false` |

When the same `id` exists, **the user directory overrides the built-in**: to modify an official example, export/copy it to the user directory and edit it there, without touching the install directory.

## 3. What a driver looks like

```json
{
  "format": "apkstart-driver/1",
  "id": "amd-igpu-swangle",
  "name": "AMD integrated GPU switch to swangle rendering",
  "version": "1.0.0",
  "author": "your name",
  "description": "Explain why this machine needs this change so others can tell at a glance",
  "priority": 0,
  "match": {
    "platform": ["win32"],
    "gpuVendor": ["amd"],
    "totalMB": { "min": 8192 },
    "accel": ["whpx"]
  },
  "effect": {
    "gpuMode": "swangle",
    "forceTcg": false,
    "emulatorArgs": ["-feature=Vulkan"],
    "configIni": { "hw.gpu.mode": "swangle" },
    "env": { "ANDROID_EMUGL_VERBOSE": "1" },
    "notes": ["If still black screen, change gpuMode to software"]
  }
}
```

### 3.1 Top-level fields

| Field | Required | Description |
|---|---|---|
| `format` | Yes | Fixed `apkstart-driver/1` |
| `id` | Yes | Alphanumeric plus `. _ -`, 3–64 characters; used as the filename on import |
| `name` | Yes | Display name on the UI (≤80 characters) |
| `version` | Yes | Like `1.0.0`; bump the version when the patch changes |
| `author` / `description` / `homepage` | No | For humans, to help others judge whether it is usable |
| `enabled` | No | Default on/off inside the file; built-in examples are all `false`. The UI switch takes priority over it |
| `priority` | No | `-100~100`, default 0. **Higher = applied later** (overrides earlier-applied ones) |
| `match` | Yes | Match conditions, see 3.2 |
| `effect` | Yes | What to change after a match, see 3.3 |

### 3.2 `match`: whether this machine uses it

All conditions must be satisfied (AND); writing no conditions at all means no match. To match "all machines", write `{"any": true}`.

| Key | Values | Description |
|---|---|---|
| `any` | `true` | Match all machines (suitable as a baseline fallback) |
| `platform` | `win32` / `linux` | |
| `arch` | `x64` / `arm64` | |
| `gpuVendor` | `nvidia` / `amd` / `intel` / `unknown` | Rough GPU vendor grouping; arrays are allowed |
| `gpuName` | Regex string (≤200 characters) | For example `"radeon\\s+780m"`, case-insensitive |
| `cpuVendor` | String or array | Match CPU model text |
| `accel` | `whpx` / `aehd` / `none` | Current hardware acceleration state; `none` = software emulation only |
| `osBuild` | Number or `{min,max}` | Windows internal build number, e.g. 22631 |
| `totalMB` | `{min,max}` | Physical memory (MB) |
| `cores` | `{min,max}` | Logical core count |
| `emulatorVersion` | `{min,max}` | Compared numerically; `36.4.9 < 36.4.10` |

On the settings page each driver shows "matched: gpu=amd / accel=whpx" or "this machine does not match", so there is no guessing why it did not take effect.

### 3.3 `effect`: what changes after a match

| Field | Description |
|---|---|
| `gpuMode` | Fixed rendering backend: `auto` / `host` / `swangle` / `swiftshader` / `swiftshader_indirect` / `software`. `auto` = no intervention |
| `forceTcg` | `true` = turn off hardware acceleration and use software emulation (equivalent to `-accel off`) |
| `emulatorArgs` | Extra arguments passed to the emulator, `-flag=value` form, only a whitelist is allowed |
| `configIni` | Override the AVD's `config.ini`, only a whitelist of keys is allowed |
| `env` | Extra environment variables; only `ANDROID_` / `QEMU_` / `LIBGL_` / `MESA_` / `EMUGL_` prefixes are allowed |
| `notes` | Explanatory text, shown in the boot log and on the settings page |

`gpuMode` and `forceTcg` apply to **every round** of launch attempts (including automatic downgrade retries): if the driver says "this machine can only use swangle", there is no point in trying backends that already crashed first.

## 4. Whitelist: what can be changed, and why

Driver files can be downloaded from the web and passed around, so ApkStart restricts their permissions tightly:

**No code execution is allowed.** A driver is pure JSON — no script hooks, no `eval`, never `require`s a file you wrote.

**`emulatorArgs` only accepts**

| Argument | Allowed values |
|---|---|
| `-gpu` | Known rendering backends (see table above) |
| `-accel` | `auto` / `off` / `on` / `whpx` / `hax` / `haxm` / `aehd` / `tcg` |
| `-feature` | Alphanumeric plus `_,.-`, ≤160 characters |
| `-gltransport` | `pipe` / `asgpu` / `virtio` |
| `-qemu` | A single qemu argument, limited character set, ≤120 characters |
| Switch form | `-no-audio` `-no-boot-anim` `-no-metrics` `-no-snapshot` `-no-snapshot-load` `-no-snapshot-save` |

Explicitly rejected: `-wipe-data` (clears apps and data), `-partition-size`, `-datadir`, `-sysdir`, `-avd`, `-port`, `-http-proxy`. These either destroy data or break ApkStart's own managed locations.

**`configIni` only accepts**: `hw.gpu.mode`, `hw.gpu.enabled`, `hw.gltransport`, `hw.keyboard`, `hw.audioInput`, `hw.audioOutput`, `hw.camera.back`, `hw.camera.front`, `hw.gps`, `vm.heapSize`, `hw.lcd.density`. `disk.dataPartition.size`, `hw.ramSize`, `hw.cpu.ncore`, `image.sysdir.*` are all rejected — ApkStart itself writes these based on settings, and mixing them in just causes conflicts.

**`env`**: `ANDROID_*`, `QEMU_*`, `LIBGL_*`, `MESA_*`, `EMUGL_*`; values ≤200 characters and must not contain newlines. `PATH`, `SystemRoot`, `NODE_OPTIONS` and similar are rejected outright.

## 5. How to make your own driver

1. Settings → Drivers → **Export current machine template** (the `match` is already filled in for the current machine, saved to the drivers directory);
2. Open with Notepad / VS Code and edit `effect`:
   - Black screen / distorted screen → first try `"gpuMode": "swangle"`, if that fails change to `"software"`;
   - Machine does not have hardware acceleration enabled → `"forceTcg": true`;
   - Save after editing;
3. Return to the settings page and click **Refresh**, see "this machine matches / already effective";
4. Open the app once to verify, shut down and open again to confirm stability;
5. To share: send the JSON to others; the other party uses "Import driver…" to import it.

A broken file does not affect startup: files that fail validation only appear in the settings page error list; drivers that do not match have no effect at all.

## 6. Troubleshooting

- The boot log (Settings → Diagnostics / `%APPDATA%\apkstart\logs\emulator.log`) writes: `drivers: amd-igpu-swangle@1.0.0`, plus the actual `-gpu` / `-accel` used in each round;
- Each driver on the settings page explains "matched / not matched / disabled" plus which conditions were matched;
- File load failures (JSON syntax errors, wrong fields, over 256KB) list the specific file and reason;
- To temporarily exclude a driver: turn off its switch in the UI (written into settings, not deleting the file).

## 7. Built-in examples

Three examples under `src/drivers/`, all **disabled by default**:

| File | Scenario |
|---|---|
| `example-amd-igpu-swangle.json` | AMD integrated GPU + old driver; `-gpu host` crashes after boot |
| `example-no-hypervisor-tcg.json` | No hardware acceleration; go directly to software emulation |
| `example-intel-igpu-software.json` | Old Intel integrated GPU GLES initialization failure |

They are also documentation: modify the `match` following them and you get a patch that "only affects this machine".
