# ApkStart v0.3.6

> In one sentence: **fixed "Hongguo always black screen after tapping 'Agree and continue'"**. The real cause is the Android virtual machine's Wi-Fi failing to connect for a long time; the app loads the home page without network, leaving only a black background — unrelated to GPU or rendering backend.

## 1. Hongguo black screen after tapping "Agree" — real cause and fix

### The previous version's misjudgment

v0.3.5 attributed the black screen to the GPU backend (swangle / software), which was **wrong**. Switching backends naturally did not help.

### The real cause located this time by hands-on

Investigated layer by layer with adb:

- `cmd wifi status`: `Wifi is not connected`; `ip -o addr show wlan0`: **no IP at all**;
- That is, **the virtual machine had no network at that time**;
- Hongguo's privacy popup is a local page, so it displays normally; after tapping "Agree and continue", it wants to pull home page data; getting no data, it renders into a whole black block — what the user sees is "black screen after agreeing";
- While `sys.boot_completed` only means the system came up; **Wi-Fi association + DHCP often still need to wait tens of seconds to over two minutes**. The app starts earlier than network ready; all home page requests fail, and the page stays black.

Hands-on evidence: the same virtual machine, checked immediately after boot is "no IP"; checked again one or two minutes later becomes `wlan0 inet 10.0.2.16/24` + `Wifi is connected to "AndroidWifi"`; at that time Hongguo home page is completely normal.

### This version's fix

1. **First wait for network ready before launching the app**: `installer.launch` will wait at most 150 seconds before `am start`; the log prints `Waiting for Android virtual machine network… Ns`; only after ready does it truly launch the app — rooting out "app runs before network" causing black screen.
2. **Network checkup after boot**: after boot succeeds, check whether the virtual machine got an IP; when no network, the log clearly writes the cause, no longer leaving the user guessing at a black screen.
3. **Settings → Repair network** (new button): one-click repair. The method is to reset Android user data and re-boot, then keep waiting until network is ready (at most 4 minutes); after success, save the "network normal" state as a quickboot snapshot.
   - **App list is retained**; opening an app auto-reinstalls; no need to manually reinstall APK;
   - In-app login status, binge-watching records, and other runtime data will be lost; need to log in again;
   - Only affects the current AVD; system image and local APK cache are untouched.

> If Hongguo is still black screen now: first directly try opening Hongguo (this version will auto-wait for network); if still black, tap "Settings → Repair network".

## 2. Previous version's "clean cache" fix remains effective

v0.3.5's `includeSnapshots` + "reset Android data" unmodified, still usable.

## 3. Known limitations

- This Android 14 (`google_apis_playstore`) image has an upstream problem: on **existing user data**, cold boot often keeps Wi-Fi at `NO-CARRIER` and cannot get an IP; the boot after data reset connects normally. Therefore "Repair network" will reset data, and immediately save a snapshot to preserve the usable state.
- The Play Store image does not allow `adb root`, so cannot separately delete bad Wi-Fi configuration.

## 4. Hands-on record

- After fix: tap "Agree and continue" → enter `MainFragmentActivity`, home page normally displays episode list and recommendation feed (screenshot confirmed, not black screen).
- Same virtual machine after waiting for network ready: `wlan0 inet 10.0.2.16/24`, `Wifi is connected to "AndroidWifi"`.
- `npm test`: **all 113 items passing** (8 + 25 + 80).

## 5. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
