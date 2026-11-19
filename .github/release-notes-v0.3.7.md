# ApkStart v0.3.7

> In one sentence: fix **the close button in the top-right of the app window (closing now truly ends the Android app)**, and change **virtual machine network** from "waiting for luck" to "automatic self-healing"; also the CI sync to Gitee token is now configured.

## 1. Fix: top-right window button, close now truly ends the app

**Problem**: tap the ⨯ on the title bar, the window disappears, but the Android app is still running in the background; when you tap that app again, it looks like "it was never closed".

**Cause**: `shell:close` directly called Electron's `win.close()`, bypassing `AppWindow.close()`'s cleanup logic. The window's `closed` event only cleared internal state; **neither `force-stop` the Android app, nor detach the emulator window from the host**. The same when closing via Alt+F4 / taskbar.

**Fix**:

- The ⨯ button now goes through `appWin.close()`: first detach and hide the emulator window, then `am force-stop` to stop the Android app;
- The `closed` event also supplements the same cleanup (covering Alt+F4, taskbar close, system shutdown, and other paths);
- Rotation / minimize / maximize logic kept as-is, unmodified.

**Hands-on**: after sending `WM_CLOSE` to the app window, `pidof com.phoenix.read` changes from `5152` to **empty**, foreground returns to the Android desktop — the app truly exited.

## 2. Network: no longer relying on luck, changed to automatic self-healing

The previous version already located "Hongguo black screen after agreeing" = virtual machine no network. But at that time it was only "wait a bit longer"; when Wi-Fi continuously does not associate at boot, it still times out.

This version changes network handling to **automatic escalation by cost from small to large**:

1. **First wait for network before launching the app** (at most 60s, progress visible in log);
2. If not ready, **cold boot the virtual machine once** (`-no-snapshot-load`, bypassing the quickboot snapshot that might have been saved when "no network"), then wait at most 180s;
3. As soon as network is connected, **immediately save a snapshot**, so the network card state is restored together next time;
4. "Settings → Repair network" uses the same flow; only if the first two steps both fail does it **reset Android data** (app list retained, auto-reinstall when opened; but in-app login status / records will be lost).

> About "upgrade Android version": this time no image was swapped. The reason is that swapping the image would require all users to re-download 1.5 GB, while the hands-on root of the problem is **emulator Wi-Fi association slow / intermittently not associating**, not the Android version itself; using "wait + cold boot self-healing" can cover the same scenario without increasing size. If a later version image is proven more stable, a separate release will migrate.

## 3. CI: Gitee sync token now configured

The GitHub repo Actions secret `GITEE_TOKEN` has been written; from now on, when tagging `v*` for release, the Release workflow automatically syncs the portable version to Gitee, no longer needing to manually run the script.

## 4. Hands-on

- `npm test`: **all 113 items passing** (8 + 25 + 80).
- After closing window, `pidof com.phoenix.read` is empty (app truly exited).
- Network ready log: `Virtual machine network ready (10.0.2.16)`, then Hongguo home page normally renders.

## 5. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
