# ApkStart v0.4.0

> In one sentence: fix the "Hongguo cannot open / always black screen" regression, single-click the tray to open the main interface, compress another round of boot speed, and uniformly suppress miscellaneous windows during runtime.

## 1. Fix: Hongguo cannot open / always black screen (v0.3.9 regression)

**Cause**: the previous version, in order to "wait for network ready before launching the app", called wait logic with **cold boot retry** in the launch flow. When the network is slow, it will "stop the virtual machine → cold boot", while the app launch is just about to `adb install` / `am start` — the device disappears midway, and so:

```
adb.exe: device 'emulator-5554' not found
launch failed com.phoenix.read
```

**Fix**:

- **On the launch path, only wait, never restart**: wait at most 20 seconds; if not ready, launch the app first (slower page is fine, cannot directly fail);
- Cold boot / reset and other heavy work is only done when the user actively taps "Repair network";
- `waitForNetwork` no longer gives up as soon as it sees `device-offline` — a just-restarted virtual machine has tens of seconds where ADB is not yet online; now given a 45-second grace period (previous versions therefore misjudged "repair failed").

**At the same time, fix "Repair network"**: hands-on found this image only stably connects to the network on the boot after `-wipe-data`; so now directly reset data (app list retained, automatically reinstall when opened), and **immediately save a snapshot** after network succeeds — when restoring from snapshot next time, the network card state is restored together.

Hands-on: after fix, boot log shows `Virtual machine network ready (10.0.2.16)`, tap "Agree and continue" to enter `MainFragmentActivity`, home page normally refreshes episodes and recommendation feed.

## 2. Tray: single-click opens main interface

Previously only double-click was bound; single-click having no response made users think the tray icon was broken. Now single-click directly opens the main window (right-click is still the menu, double-click as before).

## 3. Boot speed

- The launch path no longer does cold boot retry, removing waits that could take 3~5 minutes;
- Network wait dropped from 60 seconds to **20 seconds**, and returns immediately when the device goes offline instead of spinning;
- After network is fixed, a "network normal" snapshot is saved; from then on, every recovery from snapshot: hands-on full launch (boot → network → install → embed) about **48 seconds**, of which boot is about 20 seconds.

## 4. Runtime miscellaneous windows

The window agent adds a layer of fallback: **all extra visible top-level windows created by processes belonging to our runtime directory** are uniformly hidden (Qt prompt boxes, crash dialogs, volume bars, log windows, etc.), retaining only the one emulator main window to embed into the host. The previous implementation named each by class name; missing one would flash once.

## 5. Engineering strengthening

- `agent.ps1` brought back **UTF-8 BOM**. Previously saving with an ordinary method lost BOM; PowerShell 5.1 reads Chinese comments as ANSI, possibly merging the comment and the next line of code into one line, causing `Add-Type` compile failure (manifesting as "window agent startup failed / app window not embedded").
- Added regression test: **window agent script must carry UTF-8 BOM**; losing it later will directly fail the test.

## 6. Hands-on

- `npm test`: **all 114 items passing** (8 + 25 + 81).
- Hongguo: launch → agree → home page normally displays video feed (screenshot confirmed).
- Tray single-click can open main interface.

## 7. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
