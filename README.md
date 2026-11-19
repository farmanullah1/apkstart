# ApkStart



[![CI](https://github.com/farmanullah1/apkstart/actions/workflows/ci.yml/badge.svg)](https://github.com/farmanullah1/apkstart/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/farmanullah1/APK-START-English?include_prereleases&sort=semver)](https://github.com/farmanullah1/apkstart/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#)

**Windows Android app runner — install and use Android apps like native Windows software.**

*Note: This is an open-source hobby project developed in spare time. It is completely free, ad-free, and open source.*

- 🖱️ **Double-click .apk to install**: After registering the `.apk` file association, double-click an APK file in Windows File Explorer to automatically parse, install, and generate a desktop shortcut, without ever showing an emulator interface.
- 🧩 **Independent desktop icon per app**: Icons are parsed and extracted offline directly from inside the APK and converted to multi-size `.ico` files. Double-clicking an app shortcut opens that specific app directly, matching the experience of native Windows software.
- 🪟 **Each app has its own window**: The runtime runs in **windowed mode** (in headless mode Android does not generate VSYNC, so the app process runs but the screen remains blank). ApkStart renames the window, applies the app's real icon, and configures the portrait aspect ratio, delivering an independent app window experience. **Fullscreen mode** fills the vertical screen height centered; **windowed mode** allows free dragging, resizing, and remembers each app's custom dimensions.
- 🔍 **Searchable via Windows Start menu**: After installation, shortcuts are created on both the Desktop and the Start Menu (`Programs\ApkStart\`). You can search for the app by name in Windows Search to launch it directly, and the taskbar groups instances per application.
- 📁 **Bi-directional shared folder**: `%USERPROFILE%\ApkStartShared` syncs automatically and bidirectionally with Android's `/sdcard/ApkStartShared`. Files downloaded or saved inside Android apps appear immediately on the host.
- 🪶 **Ultra-lightweight architecture**: The shell has zero third-party dependencies (even ZIP / PNG / ICO / AXML parsing is written from scratch in pure JavaScript), the runtime boots on demand and shuts down automatically when idle, and it can also reuse an existing Android runtime on the host with zero extra footprint.



```
┌────────────────────────────────────────────────────────────┐
│  Desktop Shortcut (Real app icon .lnk)                     │
│      │  Double-click                                       │
│      ▼                                                     │
│  ApkStart.exe --launch <package-name>                      │
│      │  Runtime not started? → Auto-launch (Android Emulator + API34) │
│      ▼                                                     │
│  Launch via system-resolved LAUNCHER entry (not APK main Activity) │
│      │  Observe health for 18s; auto-retry / reset data / grant permissions on crash │
│      ▼                                                     │
│  Emulator window = App window (title renamed, icon replaced, portrait ratio, centered) │
└────────────────────────────────────────────────────────────┘
```

## Ready-to-Run Downloads (No Build Needed)

Both download mirrors offer identical releases:

- GitHub: [github.com/farmanullah1/APK-START-English/releases](https://github.com/farmanullah1/apkstart/releases)
- Gitee: [gitee.com/daily-miku/apkstart/releases](https://gitee.com/daily-miku/apkstart/releases) (faster direct connection in China)

Release packages (four formats, identical core functionality and version):

| Format | File Name | When to Choose |
|---|---|---|
| Microsoft Store package | `ApkStart_<four-part-version>_x64.msix` | Install via Microsoft Store / MSIX. The complete runtime is pre-bundled with no post-install downloads required; updates are handled via Store. |
| Full portable package | `ApkStart-v*-win64-full.zip` (~830 MB, ~1.3 GB extracted) | **No installation or download waiting?** Extract and run immediately — the runtime (emulator + system image) is fully included. |
| Installer package | `ApkStart-v*-Setup.exe` (~1.3 GB) | Recommended when you want standard desktop/Start menu shortcuts and a clean uninstallation entry. |
| Lightweight portable package | `ApkStart-v*-win64-portable.zip` (~96 MB, ~227 MB extracted) | Ideal for quick trials; downloads and sets up the runtime on first launch. |

> All `ApkStart.exe` executables are compiled with **branded icons and version resources** (FileDescription = `ApkStart Android App Runner`, CompanyName = `farmanullah1`, version synchronized with `package.json`), rather than default Electron metadata.
> To package from source: `npm run pack` (lightweight) / `npm run pack:full` (complete) / `npm run build:msix` (Store package).

### Screen Aspect Ratio & Automatic Layout Adaptation

The emulator's **physical panel orientation** (`hw.lcd.width/height`) determines the actual screen shape. If the panel orientation does not match the app's declared `screenOrientation`, Android places the app into a letterboxed column with black bars on both sides — modifying window size, `wm size`, or letterbox styling cannot eliminate these borders.

Therefore, ApkStart **analyzes `AndroidManifest.xml` offline during APK installation** to determine whether the app is naturally portrait or landscape (weighted by the launcher Activity; full `sensor`/`fullSensor` apps query Android for the actual orientation upon first run). This is stored in `apps.json` and used to set the panel orientation at startup:

- Portrait apps (e.g., short-drama readers) → Portrait panel 720×1280, upright, filled, density 190 (sw606dp) delivering a tablet layout;
- Landscape apps (e.g., HD video/games) → Landscape panel 1280×720, upright, filled.

The runtime only restarts when launching an app with a different orientation from the currently active panel (~40 seconds with progress status on title bar); launching subsequent apps with the same orientation is instant. The title bar rotation toggle **remembers** orientation per app without affecting other apps, and Settings → App Window → Screen Orientation allows forcing landscape or portrait globally.

Layout is governed by **logical density**: 720 width at 190 dpi equals **606dp**, comfortably crossing Android's 600dp tablet breakpoint. Dual-column list views and split settings panes appear only at this density (the default 320 dpi results in only 360dp, which is phone layout). This can be toggled via "Tablet Layout" in settings (enabled by default).

### Online Updates (Automatic Fastest Mirror Selection)

Navigate to Settings → **Software Update** → "Check for Updates", or right-click the system tray icon → "Check for Updates". Once a new version is detected, click "Update Now".

- Installer build: downloads `ApkStart-v*-Setup.exe` and installs silently;
- Portable build: downloads `ApkStart-v*-win64-portable.zip` and extracts over the **application directory** — the runtime directory (`%APPDATA%\apkstart\runtime`), installed apps, and snapshots reside in user data paths, ensuring no data loss during upgrades;
- In-place file replacement is performed by an isolated PowerShell script (waits for main process exit → overwrites files → relaunches), eliminating "Please close running program" popups and orphaned emulator windows.

The update pipeline actively **benchmarks and selects mirrors in real time**:

1. Queries GitHub and Gitee release APIs simultaneously and adopts the latest version tag (timeouts or rate limits on one source do not block the other);
2. Compiles candidates across direct source URLs, Gitee mirrors, and acceleration prefixes, testing each with a 256 KB transfer to evaluate post-first-byte throughput;
3. Sorts candidates by real-world bandwidth and downloads chunks in parallel from the fastest source, falling back automatically if an error occurs.

Under Settings → "Update & Download Sources", you can lock the source to a single provider, disable public acceleration mirrors, or specify custom proxy endpoints.

### Default Out-of-the-Box Behaviors

- Auto-starts on Windows boot and resides quietly in the system tray; double-clicking desktop shortcuts opens apps directly.
- Automatically generates both **Desktop and Start Menu** shortcuts upon APK installation, enabling native Windows Search discovery; legacy installations are backfilled automatically at startup.
- Native direct rendering (not screen mirroring): **Fullscreen** matches screen height centered with correct aspect ratio; **Windowed mode** retains portrait orientation with resizable borders and per-app remembered dimensions. Toggle anytime via `F11` or system tray context menu.
- Automatically grants runtime permissions requested by the application, eliminating setup permission prompts; automatically retries launches and clears cached data if an app crashes.
- **Direct host network sharing**: Android utilizes QEMU user-mode NAT routed through host network adapters, **without creating any virtual network cards or Hyper-V virtual switches** on Windows. No extra drivers, virtual adapters, or manual network modifications required.

## Categorized & Searchable Settings

Starting from version 0.6.0, settings are organized into eight functional categories with a left-hand navigation bar:

| Category | Contents |
|---|---|
| General & Setup | Runtime environment, one-click setup, auto-start on boot, disk space & cleanup |
| Display & Windows | Display mode, auto-fullscreen, screen orientation, auto-rotate, tablet layout, window hosting mode, Android settings |
| Controls & Input | Mouse bindings, key mapping (gamepad / keyboard) |
| Performance & Resources | Resource strategy, render quality, data partition, system language, Chinese IME, snapshots, prewarm, advanced parameters |
| Network & Downloads | Update & download sources, public acceleration mirrors, download thread count |
| Diagnostics & Repair | Host preflight · auto configuration, drivers · compatibility patches, auto-detect · smart diagnostics |
| Integration & Files | Desktop shortcuts & apps, shared folder, system integration |
| Updates & About | Software updates, about |

A top search box enables cross-category filtering for keywords like "Landscape", "Memory", "Proxy", ensuring matching items remain visible across all groups. The active tab is remembered between sessions.

## Automatic Diagnostics & Self-Healing

Navigate to Settings → **Diagnostics & Repair** → "Auto-Detect · Smart Diagnostics". A background service periodically monitors machine health and categorizes issues:

- **Runtime**: Cause of previous boot failure, boot hangs, stale lock files, orphaned emulator processes, empty snapshot hulls, missing hardware acceleration;
- **Device Connection**: ADB unauthorized (pending prompt), offline state, runtime running but undetected by ADB;
- **Storage**: Free disk space, data partition configuration mismatches (qcow2 overlays blocking resizing), unwriteable shared folders;
- **Settings**: Orientation conflicts between app policy and physical panel, auto-fullscreen misconfigurations;
- **Network / Logs**: Android network unavailability, unreachable download endpoints, recent log errors.

Issues feature one-click remediation (restart runtime, clear locks, terminate orphaned processes, discard broken snapshots, clean disk, reset Android network). A verification check runs automatically after repair.

Diagnostics operate under two strict rules: **probe failures are never reported as system defects** (unreadable metrics report "unknown" rather than inventing faults), and **notifications trigger only once when a new issue arises** without recurring popups.

## Building from Source

```powershell
# 1. Install dependencies (including Electron runtime)
npm install

# 2. Start development server and complete runtime deployment
npm start

# 3. (Optional) Register .apk double-click file association
npm run assoc:on

# 4. Package portable build (standalone, distributable)
npm run pack
# Output: dist/ApkStart-win64-portable/ApkStart.exe

# 5. Compress to ZIP for release (uses specialized script for optimal ratio)
node build/zip.js dist/ApkStart-win64-portable ApkStart-win64-portable.zip
```

### Single-File Standalone Installer (Bundled Complete Runtime)

To create an all-in-one standalone installer that runs offline without post-installation downloads:

```powershell
# Prepare the distribution runtime in engine/
# (system.img is compressed via xz/LZMA2 from 3.1GB to ~1.1GB; unused architectures pruned)
npm run runtime

# Compile standalone NSIS installer
npm run build:exe
# Output: dist/release/ApkStart-<version>-Setup.exe
```

Size breakdown: Electron runtime (~180 MB), pruned emulator (~480 MB), xz-compressed system image (~1.1 GB), resulting in a final package of ~1.32 GB (saving ~490 MB compared to gzip).

Upon first launch, the compressed image extracts to `%APPDATA%\apkstart\system-images` (~20 seconds, performed once), and is reused on all subsequent boots. AVD and user data remain stored in `%APPDATA%\apkstart\avd`.

## Runtime Architecture: Fully Independent

ApkStart is self-contained. All runtime components are downloaded, validated, and managed locally under `%APPDATA%\apkstart\runtime`:

| Component | Source | Size | Role |
|---|---|---|---|
| ADB (platform-tools) | dl.google.com official repository | ~8 MB | App installation, launching, and lifecycle control |
| Android Emulator | dl.google.com official repository | ~440 MB | Core virtualization engine with device models and GPU translation |
| Android 14 System Image (Google Play x86_64) | dl.google.com official repository | ~3.1 GB raw (~1.1 GB xz) | Universal base layer: supports x86, ARM-only (via translation), and GMS services |
| AEHD Driver (optional) | dl.google.com official repository | ~0.2 MB | Hardware hypervisor acceleration (alternative to Windows WHPX) |

Upon initial launch, the Setup Wizard handles deployment in a single automated step:
1. Downloads ADB, emulator engine, and system image automatically;
2. Boots the environment and configures initial parameters; subsequent shortcut clicks launch instantly.



### Automated Device Compatibility

- Automatically falls back to software simulation when hardware acceleration is unavailable; retries with up to 4 fallback parameter matrices (`GPU backend → Accel mode → Memory / Cold boot`).
- Dynamic `-gpu` selection based on emulator version (`software` on 37.x, `swiftshader` on older builds); auto-adjusts RAM under 16 GB down to 4 GB; dynamically binds free ports; normalizes Chinese paths; cleans stale AVD locks.
- Translates error logs into human-readable suggestions; supports exporting full diagnostic bundles.
- Downloads utilize 8 parallel streams with resume support, falling back to single-stream downloads if range requests are unsupported.
- **Strictly isolated from other third-party emulators**: ApkStart does not scan, intercept, or modify installations of MuMu, LDPlayer, BlueStacks, or WSA. Their configuration changes do not impact ApkStart.
- **Host Preflight & Auto-Configuration**: Evaluates CPU virtualization (VT-x/SVM), Windows Hypervisor Platform, GPU vendors, VRAM, and system versions; automatically writes optimal memory, cores, and rendering modes into drivers ([docs/preflight.md](docs/preflight.md)).
- **Compatibility Driver Extensions**: Supports declarative JSON compatibility patches that adjust parameters for specific hardware models without altering application source code ([docs/drivers.md](docs/drivers.md)).

### Containerized Low-Overhead Operation

- **Read-Only Base Layer**: A single shared `system-images/` directory is used across all applications, eliminating duplicate images.
- **Thin Writable Layer**: Individual AVD instances use delta qcow2 overlays + quickboot memory snapshots. When the last app window closes, the memory state is saved to snapshot for instant resumption.
- **Background Prewarming (Enabled by Default)**: Pre-boots the Android runtime in the background with hidden windows upon ApkStart launch, making app launches near-instantaneous (~1 GB idle memory).
- **Accelerated Cold Boot**: Results of acceleration and engine version probes are cached on disk; unneeded `wmic` process enumerations are skipped; guest initialization commands are batched into single round-trips.
- **Self-Constructed `/data` Partition**: Directly formats a 4 KB block ext4 partition with file-level encryption and SELinux attributes, expanding to configured capacity using bundled `qemu-img` and `resize2fs`.
- **Zero Console Window Leaks**: Suppresses `conhost.exe` and `netsimd` console windows before launch and enforces window filtering to prevent stray console flashes.
- **Seamless Window Experience**: The emulator window (`Android Emulator - apkstart5554`) is never displayed as an isolated window — it is either suppressed or hosted within the app window.

## Project Structure

```
apkstart/
├─ src/
│  ├─ main.js              Main process: windows, tray, single-instance lock, CLI routing, IPC
│  ├─ preload.js           Security bridge
│  ├─ ui/                  Renderer layer (vanilla HTML/CSS/JS, zero frameworks)
│  └─ core/
│     ├─ zip.js            Minimalist streaming ZIP extractor
│     ├─ axml.js           Android Binary XML (AXML) parser
│     ├─ arsc.js           resources.arsc parser (resolves app names and icon resources)
│     ├─ apk.js            APK metadata extractor: package, version, launcher Activity, icon, ABI
│     ├─ png.js            Zero-dependency PNG encoder + icon generator
│     ├─ shortcut.js       Multi-resolution ICO generator + Windows .lnk shortcut creator
│     ├─ assoc.js          .apk file association (HKCU, no admin required)
│     ├─ adb.js            ADB client (install, launch, sync, capture, diagnostics)
│     ├─ engine.js         Runtime management: probing, emulator lifecycle, idle reclamation
│     ├─ sharer.js         Host ↔ Android bidirectional shared folder synchronization
│     ├─ installer.js      APK installation pipeline orchestrator
│     └─ store.js          Application catalog and configuration persistence
├─ engine/                 Runtime component cache (emulator, system-images, platform-tools)
├─ tools/platform-tools/   Bundled portable ADB
├─ test/                   Unit tests, Electron integration tests, automated test suite
├─ build/pack.js           Portable distribution packager
└─ scripts/assoc.js        CLI switch for .apk file association
```

## Command Line Interface

```
ApkStart.exe                      Open main management interface
ApkStart.exe <path\to.apk>        Install APK directly
ApkStart.exe --launch <pkg-name>  Launch specific app (used by desktop shortcuts)
```

## Testing

```powershell
npm test                                   # Unit tests + engine pipeline tests (pure Node, offline)
npm run test:boot                          # Real boot verification with 61MB Alpine guest
npm run selftest                           # Runtime verification: install → launch → screenshot → shared sync
electron test/electron-integration.js      # ICO & shortcut integration tests
electron . --smoke test\shot.png           # Headless launch and smoke screenshot test
```

## Technical Architecture & Tradeoffs

- **Built on AOSP / QEMU / ADB**: Android kernel virtualization, GPU translation, and ART execution represent decades of engineering; ApkStart focuses on delivering a seamless, native desktop integration layer over standard AOSP/QEMU components.
- **Synchronized Shared Storage**: When Windows operates without root privileges, directly mounting host NTFS partitions into Android is restricted; ApkStart implements high-speed bidirectional synchronization to provide equivalent behavior.
- **ARM Translation & High Compatibility**: Supports modern ARM-only applications through the **Android 14 (API 34) Google Play image** equipped with Google's native bridge translator. Tested with complex modern mobile applications.

| Running ARM64 Application (Android 14 · AEHD Hardware Acceleration) |
|:---:|


### Troubleshooting: "Hardware Acceleration Not Enabled"

Android emulation on Windows supports two acceleration interfaces:

| Mechanism | Description | Admin Privileges Required | Reboot Required |
|---|---|---|---|
| **WHPX** | Built-in Windows feature: "Windows Hypervisor Platform" | During feature enablement | Yes |
| **AEHD** | Google official kernel driver | During driver installation | No |

- **Installer / Portable Editions**: Open Settings → Environment Check → click **Fix** next to "Hardware Acceleration Not Enabled". Windows prompts for UAC to automatically enable WHPX; if unsupported or declined, it falls back to installing the AEHD driver.
- **Microsoft Store (MSIX) Edition**: Store applications cannot elevate privileges directly. Clicking "Fix" opens the "Turn Windows features on or off" dialog; check **"Windows Hypervisor Platform"** (`HypervisorPlatform`), click OK, and reboot your computer.

Alternatively, enable via Administrator PowerShell:

```powershell
dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

> Note: Ensure **"HypervisorPlatform"** is enabled, not just "VirtualMachinePlatform" (which is used by WSL2). The emulator specifically requires the hypervisor platform interface.

### Troubleshooting: Shortcut Displays Generic / ApkStart Icon

Each Android application shortcut is configured with its own dedicated icon (extracted from the APK to `%APPDATA%\apkstart\icons\<package>.ico`). If a shortcut displays a default icon:

1. Navigate to **Settings → System Integration → Rebuild Shortcuts** (rewrites desktop and Start menu shortcuts based on active apps, repairing icon paths and taskbar identities);
2. If unresolved, delete the shortcut, right-click the app in ApkStart, and select Recreate Shortcut or reinstall the APK.

Each shortcut includes an individual `AppUserModelID`, ensuring pinned taskbar buttons group under their specific app icon rather than collapsing into ApkStart.

### Troubleshooting: ADB Cannot Find Device

ApkStart's internal ADB daemon operates on **dedicated port 5044**, isolated from the system default ADB port (5037). This prevents conflicts with Android Studio, scrcpy, or existing emulators.

To connect via command line:

```powershell
$env:ANDROID_ADB_SERVER_PORT = 5044
adb devices              # Displays emulator-5554
```

⚠️ **Do not** manually run `adb connect 127.0.0.1:5555`: the Play Store system image will display an authorization popup covering the active app.

## About the Project

ApkStart is maintained by **farmanullah1**.

- GitHub: <https://github.com/farmanullah1/apkstart>



<p align="center"><i>Powered by <b>farmanullah1</b></i></p>

## Contributing

Issues and Pull Requests are welcome. The shell core maintains zero third-party runtime dependencies; please ensure `npm test` passes before submitting. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE). Distribution builds contain only ApkStart source code and the Electron runtime. System images, QEMU binaries, and Google platform tools are downloaded on demand upon initial setup from official repositories in accordance with their respective licenses.
