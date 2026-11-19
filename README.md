# ApkStart

[![GitHub Release](https://img.shields.io/github/v/release/farmanullah1/apkstart?include_prereleases&label=Release)](https://github.com/farmanullah1/apkstart/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/farmanullah1/apkstart/blob/main/LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6.svg)](#download--play-no-compiling-required)

**Android App Runner on Windows** — Install and use Android apps just like native Windows software.

> **About This Repository:** This repository (`farmanullah1/apkstart`) is a fork of **ApkStart**, originally created by [RoutineMiku](https://github.com/RoutineMiku/apkstart). It is a lightweight, open-source, ad-free hobby project designed to make Android apps feel like native Windows desktop software.

---

## Key Features

- 🖱️ **Double-Click `.apk` to Install:** Once `.apk` file association is enabled, double-clicking an APK file in Windows File Explorer automatically parses, installs, and creates a desktop icon for the app—no need to open an emulator interface.
- 🧩 **Individual Desktop Icons:** App icons are extracted offline directly from the APK and converted into multi-size `.ico` files. Double-clicking the icon launches the app directly, just like a native Windows program.
- 🪟 **Standalone App Windows:** Android apps do not render graphics in headless mode (the process runs, but the screen stays blank). ApkStart runs the app in a dedicated window, applies the app's real title and icon, and sizes it to match a phone's vertical screen ratio. Fullscreen mode centers the app and fills the screen height, while Windowed mode lets you freely drag, resize, and save custom window dimensions for each app.
- 🔍 **Windows Search & Start Menu Integration:** Installing an app creates shortcuts on both your Desktop and in the Start Menu (`Programs\ApkStart\`). You can search for any installed Android app by name in Windows Search, and taskbar icons are grouped cleanly per app.
- 📁 **Two-Way File Sharing:** `%USERPROFILE%\ApkStartShared` continuously syncs both ways with `/sdcard/ApkStartShared` inside Android. Files saved by an Android app appear immediately on your PC, and vice versa.
- 🪶 **Extremely Lightweight:** The main shell has **zero third-party dependencies** (even the ZIP, PNG, ICO, and AXML parsers are written from scratch). The Android runtime starts on demand and shuts down automatically when idle.

### How Launching Works

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  Desktop Shortcut (Real App Icon .lnk)                                  │
│      │  Double-click                                                    │
│      ▼                                                                  │
│  ApkStart.exe --launch <package_name>                                   │
│      │  Runtime not running? → Auto-starts (Android Emulator + API 34)  │
│      ▼                                                                  │
│  Launches via system-resolved LAUNCHER entry (not just Main Activity)    │
│      │  Monitors for 18s (auto-retries on crash / resets data / grants) │
│      ▼                                                                  │
│  Emulator Window = App Window (Custom title, icon, aspect ratio, zoom)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Download & Play (No Compiling Required)

You can download pre-built packages from the [Releases Page](https://github.com/farmanullah1/apkstart/releases) (or from the [upstream releases](https://github.com/RoutineMiku/apkstart/releases) if no binary release has been published on this fork yet).

### Available Packages

| Package Type | File Name | When to Choose This |
| :--- | :--- | :--- |
| **Microsoft Store** | `ApkStart_<version>_x64.msix` | Install directly via MSIX / Microsoft Store. Includes the full runtime (no internet needed after install), and updates are handled automatically. |
| **Full Portable** | `ApkStart-v*-win64-full.zip`<br>*(~830 MB download / ~1.3 GB extracted)* | No installation or extra downloads required. Just unzip and run—the emulator and system image are already included. |
| **Standard Installer** | `ApkStart-v*-Setup.exe`<br>*(~1.3 GB)* | Best if you want a traditional Windows installer with Start Menu shortcuts and a standard uninstaller. |
| **Lightweight Portable** | `ApkStart-v*-win64-portable.zip`<br>*(96 MiB download / ~227 MB extracted)* | Best if you just want to try it out first. Downloads the Android runtime online upon first launch. |

All versions of `ApkStart.exe` include custom branding icons and version metadata (`FileDescription = ApkStart Android App Runner`, synced with `package.json`) rather than default Electron placeholders.  
To package builds yourself from this repository: `npm run pack` (lightweight), `npm run pack:full` (complete), or `npm run build:msix` (MSIX package).

---

## How Fullscreen, Screen Orientation & Tablet Layout Work

An emulator's physical screen panel (`hw.lcd.width/height`) controls the true shape of the display. If the emulator panel's orientation does not match the app's declared `screenOrientation`, Android forces the app into a narrow letterboxed strip with black bars on both sides—and resizing the window or running `wm size` will not fix it.

To solve this, ApkStart inspects `AndroidManifest.xml` offline during installation to determine whether an app is naturally portrait or landscape (weighted by its launch Activity; `allSensor` / `fullSensor` apps are re-checked after their first run) and saves this profile in `apps.json`:

- **Portrait Apps** (e.g., short-drama and vertical video apps): Uses a `720×1280` vertical panel at `190 dpi` (`sw606dp`) with **Tablet Layout** enabled.
- **Landscape Apps** (e.g., e-readers and horizontal games): Uses a `1280×720` horizontal panel.

The runtime only restarts when switching between apps with **different** orientations (takes ~40 seconds, with a progress prompt in the title bar). Launching apps with the **same** orientation takes only a few seconds. You can also click the rotate button in the title bar (which remembers your choice for that specific app) or force an orientation under **Settings → Display & Window → Screen Orientation**.

### Why Tablet Layout?
Android's tablet interface breakpoint starts at `600dp`. At `720px` width and `190 dpi`, the logical width equals `606dp`—just past the tablet threshold (whereas a standard `320 dpi` phone screen is only `360dp`). This unlocks dual-column layouts (such as side-by-side episode lists and settings menus). **Tablet Layout** is enabled by default and can be toggled off anytime in Settings.

---

## Online Updates (Smart Fastest-Source Selection)

Go to **Settings → Updates & About → Check for Updates** (or right-click the system tray icon → **Check for Updates**), then click **Update Now** when a new version is found:

- **Installer version:** Downloads `ApkStart-v*-Setup.exe` and installs it silently.
- **Lightweight portable version:** Downloads `ApkStart-v*-win64-portable.zip`, extracts it, and overwrites the app folder. Your runtime (`%APPDATA%\apkstart\runtime`), installed apps, and snapshots are stored separately, so nothing is lost during updates.
- **Seamless replacement:** A standalone PowerShell script waits for the main process to exit, replaces the files, and relaunches the app automatically—no manual close prompts or leftover emulator windows.

Instead of relying on a single hardcoded link, the updater tests sources dynamically every time:
1. Queries **GitHub** and **Gitee** simultaneously and picks whichever has the higher version number (if one is blocked or times out, the other still works).
2. Lists all candidate URLs (Direct Source / Gitee Release Asset / Mirror Prefixes) and runs a real **256 KB speed test**, measuring throughput only *after* the first byte arrives (so high-latency, high-bandwidth servers aren't unfairly penalized).
3. Ranks candidates by actual download speed, downloads in parallel chunks using the fastest source, and automatically falls back to the next source if an error occurs.

You can lock updates to a specific source, disable public mirrors, or configure a custom mirror/repository URL in **Settings → Network & Downloads**. Because Gitee has a 100 MB file upload limit, the portable package is compressed with 7-Zip deflate (`95.0 MB`) so it can be downloaded as a single archive without needing split `.part1/.part2` files.

---

## Out-of-the-Box Default Behaviors

These features work automatically with zero setup required:

- **Auto-Start & Tray Mode:** Launches at Windows startup and stays quietly in the system tray. Double-click any app shortcut on your desktop to open it immediately.
- **Automatic Shortcuts:** Creates both Desktop and Start Menu shortcuts upon APK installation so apps appear in Windows Search. Missing shortcuts from older versions are repaired automatically on startup.
- **Native Rendering (Not Screen Casting):** Fullscreen mode fills your screen height and centers the app without stretching. Windowed mode preserves the phone aspect ratio, supports free resizing/dragging, and remembers window sizes per app. Press `F11` or right-click the tray icon to toggle fullscreen anytime.
- **Auto-Permissions & Crash Recovery:** Automatically grants requested runtime permissions upon installation so apps don't get stuck on system permission popups. If an app crashes, ApkStart retries automatically and resets app data if necessary.
- **Zero Virtual Network Adapters:** Android connects to the internet via QEMU user-mode NAT using your PC's existing network adapter. It never creates virtual network cards or virtual switches on Windows, requires no extra network drivers, and needs zero network configuration.

---

## Categorized & Searchable Settings

Settings are organized into **8 clear categories** in a left-hand navigation sidebar:

| Category | What's Included |
| :--- | :--- |
| **General & Installation** | Runtime & environment setup, one-click deployment, launch at startup, disk usage & cleanup |
| **Display & Window** | Display mode, auto-fullscreen, screen orientation, mirror auto-rotate, tablet layout, window hosting mode, Android system settings |
| **Controls & Input** | Mouse keybindings, keyboard mapping (gamepad simulation) |
| **Performance & Resources** | Resource allocation policy, graphics quality, data partition size, system language, Chinese IME, snapshots, boot warm-up, advanced parameters |
| **Network & Downloads** | Update & download sources, public acceleration mirrors, download thread count |
| **Diagnostics & Repair** | System health check & auto-config, drivers & compatibility patches, auto-detection & smart diagnostics |
| **Integration & Files** | Desktop & app shortcuts, shared folder sync, system integration |
| **Updates & About** | Software updates, version info & credits |

A **search bar** at the top lets you search keywords like `"landscape"`, `"memory"`, or `"proxy"` across all categories at once. ApkStart also remembers the last category you opened.

---

## Auto-Detection & Smart Diagnostics

Go to **Settings → Diagnostics & Repair → Auto-Detection & Smart Diagnostics**. ApkStart periodically checks your system in the background and lists any issues by category:

- **Runtime:** Root cause of the last startup failure, boot freezes, leftover lock files, orphaned emulator processes, corrupted/empty snapshots, or disabled hardware acceleration.
- **Device Connection:** Unauthorized ADB connections (e.g., an unattended *"Allow USB debugging?"* prompt), offline device states, or a running runtime that ADB cannot detect.
- **Storage:** Low disk space, mismatches between configured and actual data partition sizes, or a non-writable shared folder.
- **Settings:** Conflicts between screen orientation policies and the physical panel, or unsupported auto-fullscreen settings in standalone window mode.
- **Network & Logs:** No internet access inside Android, unreachable download sources, or recent errors in log files.

Every detected issue includes a **one-click fix button** (restart runtime, clear locks, kill orphan processes, invalidate broken snapshots, clean disk space, reset Android network, etc.) followed by an automatic re-check.

- **Two Core Principles:** Failed health probes are marked as *"Unknown"* (never reported as false alarms), and notifications trigger only once when a *new* issue appears. Scans run every 10 minutes by default and can be customized or turned off on the same page.

---

## Building from Source

### 1. Clone This Repository

```bash
git clone https://github.com/farmanullah1/apkstart.git
cd apkstart
```

### 2. Standard Build (Lightweight)

```bash
# 1. Install dependencies (including Electron runtime)
npm install

# 2. Launch and deploy the runtime (one-time download of adb / Emulator / system image)
npm start

# 3. (Optional) Register .apk double-click file association
npm run assoc:on

# 4. Package the lightweight portable version (no installation needed)
npm run pack
# Output: dist/ApkStart-win64-portable/ApkStart.exe

# 5. Compress into a release ZIP
# IMPORTANT: Use this script instead of PowerShell's Compress-Archive (which adds ~5 MB and exceeds Gitee's 100 MB limit)
node build/zip.js dist/ApkStart-win64-portable ApkStart-win64-portable.zip
```

### 3. Single-File Installer EXE (Offline Bundle)

If you want a single installer `.exe` that works offline immediately after installation:

```bash
# 1. Package engine/ into a redistributable runtime
# (Compresses system.img with xz/LZMA2 from 3.1 GB down to ~1.1 GB and strips unused ARM64 QEMU, Vulkan, locales, and VR files)
npm run runtime

# 2. Build the NSIS installer EXE (installs to the current user's directory)
npm run build:exe
# Output: dist/release/ApkStart-<version>-Setup.exe
```

- **Size Breakdown:** Electron (~180 MB) + slimmed Emulator (~480 MB) + xz-compressed system image (~1.1 GB) = **~1.32 GB total** (saving ~490 MB compared to gzip). `system.img` cannot be trimmed further because it is protected by Android `dm-verity`.
- **First Launch:** Extracts the xz system image to `%APPDATA%\apkstart\system-images` (~20 seconds, one-time only) and reuses it thereafter. Your AVD and installed apps are stored permanently in `%APPDATA%\apkstart\avd`, so portable upgrades never erase your data.

---

## Runtime Architecture (100% Self-Contained)

ApkStart manages, verifies, and stores all runtime components independently inside `%APPDATA%\apkstart\runtime`—it does not depend on any third-party Android emulators. The lightweight edition downloads a pre-packaged runtime bundle (`ApkStart-runtime-*.zip`) from GitHub Releases, falling back directly to official Google servers (`dl.google.com`) if needed:

| Component | Source | Size | Purpose |
| :--- | :--- | :--- | :--- |
| **adb (platform-tools)** | `dl.google.com` | ~8 MB | Installs and launches Android apps |
| **Android Emulator** | `dl.google.com` (8-thread download) | ~440 MB | Core runtime engine with device profiles & GPU translation |
| **Android 14 Universal System Image**<br>*(Google Play x86_64)* | `dl.google.com` | ~3.1 GB raw<br>*(~1.1 GB xz)* | Single base layer supporting x86 apps, ARM-only apps, and Google Mobile Services (GMS) |
| **AEHD Driver** *(Optional)* | `dl.google.com` | ~0.2 MB | Hardware virtualization acceleration (alternative to Windows WHPX) |

On first launch, the **Runtime** page guides you through a **one-click setup** that downloads the components at full speed (10+ MB/s) and boots Android automatically.

---

## Automatic Device Compatibility

- **Smart Fallbacks & Retries:** Automatically falls back to software rendering if hardware acceleration is unavailable. If startup fails, it retries up to 4 parameter combinations (`render backend → acceleration mode → memory / cold boot`).
- **Engine-Aware GPU Flags:** Automatically picks the right `-gpu` mode based on emulator version (`software` for v37.x, `swiftshader_indirect` for older versions) without using deprecated flags.
- **Auto-Tuned Hardware & Paths:** Automatically scales RAM and CPU cores based on your PC's specs (`2–4 GB RAM` / `2–4 cores`), shrinks the default data partition from `16 GB` to `4 GB`, picks free network ports dynamically, converts non-ASCII file paths to Windows short paths, and clears stale AVD lock files.
- **Clear Error Reports:** Translates startup errors into plain language with actionable fix tips, and lets you export a full diagnostic report from Settings.
- **Multi-Threaded Downloads:** Uses 8-thread chunked downloads with resume support, automatically falling back to single-stream downloads if a server doesn't support HTTP Range requests.
- **Zero Conflict with Other Emulators:** ApkStart ignores MuMu, LDPlayer, BlueStacks, and WSA on your system—their updates, ports, or presence will never affect ApkStart.
- **System Health Check & Auto-Config (`docs/preflight.md`):** Scans CPU virtualization (`VT-x/SVM`), Windows Hypervisor Platform, GPU/VRAM, RAM, and Windows version after install. Automatically applies optimal RAM/CPU/graphics settings, provides one-click buttons for admin actions, and explains BIOS settings if needed.
- **Driver Compatibility Patches (`docs/drivers.md`):** Supports declarative JSON patches to adjust whitelisted launch arguments for older GPUs or buggy drivers without executing any external code.

---

## Container-Style Low-Overhead Design

- **Shared Read-Only Base Layer:** Only one copy of `system-images/` is stored on your PC and shared across all apps.
- **Thin Writable Layer & Quickboot Snapshots:** Uses differential user data and named quickboot snapshots. When you close the last open app window, ApkStart saves the memory state to a snapshot so the next launch resumes quickly instead of cold-booting.
- **Idle Warm-Up (Enabled by Default):** Like WSA or Tencent App Treasure PC, ApkStart quietly boots Android in the background when started (with all windows hidden), so clicking an app icon only needs an instant `am start` command. Uses ~1 GB of idle RAM and can be disabled in Settings.
- **Faster Cold Boots:** Caches hardware/version probes on disk, skips slow `wmic` process scans, uses adaptive boot polling (starting at `350ms`), and batches guest setup commands into a single ADB round-trip—shaving 5–10 seconds off startup (~23s cold boot, ~10s snapshot resume).
- **Custom `/data` Partition Formatting:** The official `userdata.img` is just a 1 MB empty placeholder that normally requires Android Studio's SDK tools to format. ApkStart formats a proper `4 KB`-block `ext4` filesystem with `ENCRYPT` (file-based encryption) and `ext_attr` (SELinux labels) using `qemu-img` and `resize2fs`, preventing recovery boot loops on first launch.
- **Snapshot Integrity Checks:** Detects and cleans up incomplete snapshot shells, while supporting both `ram.bin` (newer emulators) and `ram.img` (older emulators) so valid 3 GB snapshots are never deleted by mistake.
- **Zero Console Window Popups:** QEMU and `netsimd` normally spawn flashing black `conhost.exe` console windows. ApkStart applies persistent window suppression before launch, scans by window class/title (`emulator`, `qemu`, `netsim`), and polls every `120ms` during the first 90 seconds of boot.
- **Clean App-Only Interface:** The raw emulator window (`Android Emulator - apkstart5554`) never appears standalone on your desktop—it is either hidden or embedded inside the ApkStart app window via `SetParent`. When closing an app, ApkStart safely detaches and hides the emulator window before destroying the host window, and guards against stray windows for up to 3 minutes after exit.
- **On-Demand ARM & Split-APK Support:** Downloads ARM translation support when needed and automatically installs `.apks` and `.xapk` bundles using `adb install-multiple`.
- **Reclaimable Storage:** Strips non-x86_64 QEMU targets during build (~400 MB saved) and lets you clean old system images, snapshots, lock files, and leftover AVDs directly from Settings.

---

## Project Directory Structure

```text
apkstart/
├─ src/
│  ├─ main.js              Main process: windows, tray, single-instance lock, CLI routing, IPC
│  ├─ preload.js           Secure context bridge
│  ├─ ui/                  Renderer UI (vanilla HTML/CSS/JS, zero frameworks)
│  └─ core/
│     ├─ zip.js            Minimalist ZIP reader (on-demand extraction)
│     ├─ axml.js           Android binary XML parser
│     ├─ arsc.js           resources.arsc parser (resolves app names & icon paths)
│     ├─ apk.js            APK metadata extractor (package name, version, Launcher Activity, icon, ABI)
│     ├─ png.js            Zero-dependency PNG encoder & icon renderer
│     ├─ shortcut.js       Multi-size .ico generator & Windows .lnk shortcut creator
│     ├─ assoc.js          .apk file association (HKCU registry, no admin rights needed)
│     ├─ adb.js            ADB client (install, launch, sync, screenshot, etc.)
│     ├─ engine.js         Runtime manager (hardware probing, emulator lifecycle, idle cleanup)
│     ├─ sharer.js         Two-way file sync between Windows and Android shared folders
│     ├─ installer.js      APK installation pipeline orchestrator
│     └─ store.js          App inventory and settings persistence
├─ engine/                 Downloaded runtime components cache (emulator / system-images / platform-tools)
├─ tools/platform-tools/   Portable ADB location
├─ test/                   Unit tests, Electron integration tests & UI smoke screenshots
├─ build/pack.js           Portable edition packager
└─ scripts/assoc.js        CLI toggle for .apk file association
```

---

## Command-Line Usage

```bash
ApkStart.exe                      # Open the main ApkStart dashboard
ApkStart.exe <path\to\app.apk>    # Install an APK file
ApkStart.exe --launch <pkg_name>  # Launch an app directly (used by desktop shortcuts)
```

---

## Testing

```bash
npm test                                 # Pure Node unit tests & engine pipeline tests (offline)
npm run test:boot                        # Real boot test using a 61 MB Alpine guest to verify QEMU flags & shutdown
npm run selftest                         # Full runtime verification (ADB, Android version, freeform mode, folder sync)
electron test/electron-integration.js    # Integration test for .ico and .lnk shortcut generation
electron . --smoke test\shot.png         # Launch the UI and capture a smoke-test screenshot
```

> **Tip:** Running `npm run selftest -- --apk path\to\app.apk` performs an end-to-end acceptance test: installs the APK, launches it in a standalone window, verifies foreground focus, and takes a screenshot.

---

## Design Trade-Offs (Honest Notes)

- **Built on Proven Foundations, Not a Custom Hypervisor:** Building an Android kernel, GPU translator, and ART runtime from scratch takes years. Like Tencent App Treasure PC and Google Play Games for PC, ApkStart stands on the shoulders of **AOSP, QEMU, and ADB**, focusing its engineering effort on delivering a seamless, native-like Windows desktop experience.
- **Fast Two-Way Sync Instead of Folder Mounting:** Because Windows cannot mount NTFS drives directly inside Android without root modifications, ApkStart uses real-time two-way file synchronization to achieve the exact same user experience.
- **ARM-Only Apps:** Enabling **ARM Compatibility Mode** in Settings switches to the Android 14 (API 34) Google Play system image, which includes an updated `ndk_translation` layer. Apps built strictly for `arm64-v8a` install, browse feeds, and play videos smoothly (whereas older API 30 images could trigger `DoBadTrampoline SIGABRT` crashes due to custom signal handlers). Apps with aggressive anti-emulator checks (e.g., strict hardware sensor or cellular baseband verification) may still be restricted; ApkStart displays clear explanations whenever an app fails to install or launch.

---

## Troubleshooting & FAQ

### 1. What if I see "Hardware Acceleration Not Enabled"?

Android emulators on Windows support two hardware acceleration methods:

| Method | What It Is | Requires Admin? | Requires Reboot? |
| :--- | :--- | :--- | :--- |
| **WHPX** | Built-in Windows feature (*Windows Hypervisor Platform*) | Yes (when enabling) | **Yes** |
| **AEHD** | Google's official hypervisor kernel driver | Yes (during driver install) | **No** |

- **Installer / Portable Editions:** Go to **Settings → Diagnostics & Repair**, click **Fix** next to *"Hardware Acceleration Not Enabled"*, and approve the UAC prompt. ApkStart will automatically enable WHPX, or fall back to installing the AEHD driver if WHPX is unavailable.
- **Microsoft Store (MSIX) Edition:** Store apps cannot elevate privileges automatically. Clicking **Fix** opens the **Turn Windows features on or off** window—check **Windows Hypervisor Platform**, click **OK**, and restart your PC.
- **Manual Setup via Administrator PowerShell:**
  ```powershell
  dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
  dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
  ```
  > **Important:** Do **not** enable only *Virtual Machine Platform* (`VirtualMachinePlatform`)—that feature is for WSL2. The Android emulator specifically requires **Windows Hypervisor Platform** (`HypervisorPlatform`).

*(Note: ApkStart can still run without hardware acceleration using pure software rendering, though booting will take several minutes. The warning is informational and does not prevent apps from running.)*

### 2. Why does my desktop shortcut show the generic ApkStart icon (or a blank icon)?

Each app shortcut should display its own icon (extracted to `%APPDATA%\apkstart\icons\<package_name>.ico` during installation). If it shows the green ApkStart play icon or a blank icon:
1. Go to **Settings → Integration & Files → Rebuild Shortcuts** to regenerate all Desktop and Start Menu shortcuts with their proper icons and taskbar IDs.
2. If that doesn't work, delete the shortcut, right-click the app inside ApkStart, and select **Recreate Shortcut** (or reinstall the APK).

**Why this happens:** Early versions pointed shortcut icons to ApkStart's main executable, or moving a portable folder to a new location broke the hardcoded paths inside `.lnk` files. Each shortcut also carries its own `AppUserModelID`, ensuring pinned taskbar icons match the app instead of grouping under ApkStart.

### 3. Why doesn't `adb devices` show my running Android device?

ApkStart runs its own dedicated ADB server on **port `5044`** instead of the standard port `5037`. This prevents conflicts with Android Studio or `scrcpy` so neither tool accidentally hijacks or terminates the other's emulator.

To connect via command line (PowerShell):

```powershell
$env:ANDROID_ADB_SERVER_PORT = 5044
adb devices   # Lists emulator-5554
```

> ⚠️ **Warning:** Do **not** manually run `adb connect` on port `5555`. On Google Play system images, doing so triggers an *"Allow USB debugging?"* system dialog inside Android that blocks your running app window.

---

## Credits, Contributing & License

- **Fork Maintainer:** [farmanullah1](https://github.com/farmanullah1/apkstart)
- **Original Creator:** [RoutineMiku](https://github.com/RoutineMiku/apkstart)
- **Contributing:** Issues and Pull Requests are welcome on the [GitHub Issues](https://github.com/farmanullah1/apkstart/issues) and [Pull Requests](https://github.com/farmanullah1/apkstart/pulls) pages! Please keep the core shell free of third-party dependencies and run `npm test` before submitting changes. See `CONTRIBUTING.md` for details.
- **License:** **MIT License**. Release packages contain only ApkStart's source code and the Electron runtime—they do not redistribute Android system images, QEMU binaries, or Google components. Those components are downloaded on demand from official sources upon first launch under their respective licenses.