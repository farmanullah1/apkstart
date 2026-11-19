# ApkStart v0.5.1

This release is a stability and appearance wrap-up: it reproduces, fixes, and re-verifies the 6 issues confirmed during the previous version's hands-on review one by one. The new version number is mainly for the Microsoft Store — if 0.5.0 has already been submitted, only `0.5.1.0` can overwrite-upgrade.

## 1. Switching apps no longer waits facing a blank screen for 40 seconds

In standalone window mode, the shell window is normally not displayed (the screen is inside the emulator's own window). But when switching to an app with a **different screen orientation**, the runtime must be restarted to swap panels, taking about 40 seconds — during this time the desktop has no windows at all, and the user will only think the program crashed.

Now, during the wait, a window is shown: "Switching 《Hongguo Short Dramas》 to portrait (restarting Android environment, about 40 seconds, only once)…", and it automatically retracts after the screen is connected.

Hands-on: t=2.1s the wait window appears, hangs until t=41.9s the screen is connected, the whole process is communicated.

## 2. No longer falsely reports "virtual machine has no network, please reset Android data"

Wi-Fi association + DHCP generally lag `sys.boot_completed` by 5~20 seconds, while the old implementation only checked once and concluded; so **every cold boot** produced a ⚠️: "Android virtual machine currently has no network… can be fixed by resetting Android data under 'Settings → Repair network'". This prompt itself is wrong (it will automatically connect a few seconds later), and the remedy it suggests **deletes installed apps**.

Now the network checkup is given a 12-second wait window (returns as soon as ready); only prompts on real timeout, and no longer suggests destructive operations.

## 3. Fix "app launch failure after orientation-switch restart"

`emulator.exe` is only a launcher; after spawning qemu it exits on its own, but the process object is retained. So after an orientation-switch restart, the immediately following `ensure()` goes to `start()`'s "reuse" fast path, gets the serial of an **already-closed** emulator, and all subsequent adb commands report `device not found` / `Can't find service: activity`; manifesting as "switching apps directly fails and bounces back to the main interface".

Now reuse must confirm there is really a machine running on the console port; `stop()` cleanup also clears the launcher handle.

## 4. Launch serialization

One launch is at most 80 seconds (panel swap + cold boot). If you tap another app during this time, the old behavior was to **really concurrently run the second round**: `openAppWindow` closes the app that is starting, while the virtual machine is restarting, and both fail together.

Now: the same app rapid-tap = only launches once; switching apps queues and waits for the previous one to finish.

## 5. Console black box at boot, and new window flashing the previous app's name

- After Win11 changed the default console host to Windows Terminal, qemu's console window belongs to `WindowsTerminal.exe`; pid / parent chain / title all cannot identify ownership, so every boot flashes a 200~300ms black box on screen. Now it uses "take a snapshot of the console window before boot + new appearance within 20 seconds after boot + title empty or containing terminal" to identify, and added a 100ms high-frequency scan channel (only in the first 15 seconds).
- The window agent caches the last set title, while `setTitle` was originally after `show()`, causing the new window to first display **the previous app's name** for about 0.5 seconds. Now the title is set before `show`.

## 6. Documentation: why `adb devices` cannot see this Android device

ApkStart's adb service runs on a **dedicated port 5044** (your own adb is 5037); this is an intentional isolation. To connect: `$env:ANDROID_ADB_SERVER_PORT = 5044` then run `adb devices`. Also do not manually `adb connect` on 5555 — the Play image will pop "Allow USB debugging?" and cover the app.

---

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.1.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Upgrade: Store compares four-segment version numbers; `0.5.1.0 > 0.5.0.0`, can directly overwrite the already-submitted 0.5.0
- Listing materials see `docs/store-listing.md`, steps see `docs/store-upload-walkthrough.md`

Test: 9 + 25 + 117 = 151 passing.
