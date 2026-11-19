# ApkStart v0.3.8

> In one sentence: added a **nice launch welcome card** (reminds you everything is ready when launching at startup), fixed **some users unable to check for updates**, added **cleaning old version residuals**, and beautified the interface overall.

## 1. New: launch welcome card

When launching at startup or opening ApkStart, a lightweight welcome card pops up:

- Top is a brand gradient header image + dynamic greeting (Good morning / Good afternoon / Late night…);
- Three indicators at a glance: **installed apps / Android runtime status / device port**;
- Two most useful prompts right now (when no apps installed, teach how to install; when apps installed, teach window operations);
- When a new version is found, it is prompted directly here, no longer a separate bottom-right bubble;
- Bottom can check **"Do not auto-popup next launch"**, or directly "Open settings".

Popup rules: must-pop on launch at startup; manual open at most once per day; after checking, never pop again.

## 2. Fix: some users unable to check for updates

**Cause**: version info depends on two companies' APIs. GitHub anonymous API is only 60 calls per IP per hour; Gitee's anonymous API is tighter, tested continuous several times returns `403 Rate Limit Exceeded`. Under company network / campus network / carrier NAT exit, users easily get both sources rate-limited, and the UI only shows "check update failed".

**Fix**:

- Added a **fallback not depending on API**: directly follow `releases/latest`'s 302 jump to get the version number (goes through CDN, does not consume API quota), then splice the download address per publishing convention;
- GitHub and Gitee's `/releases/download/<tag>/<filename>` standard addresses both support splicing (tested Gitee 302s to attachment direct link, can download complete bytes);
- On check failure, the UI is no longer a blank screen, but gives an **"Open download page"** button; `app:updateOpen` now also allows `gitee.com`, so domestic users are not blocked.

## 3. New: clean old version residuals

Settings → System integration → **"Clean old version residuals"**:

- Scans **old-version program directories** (like `ApkStart-vX.Y.Z-win64-portable` under the same directory, and must really contain `ApkStart.exe`; absolutely does not touch the currently running version);
- Scans **invalid registry uninstall items** (dead entries whose `InstallLocation` or uninstall program no longer exist);
- Scans **temporary packages left by update downloads** (`%APPDATA%\apkstart\update` and temporary directory's `ApkStart-*.zip` etc.);
- First lists the inventory and releasable space, then deletes after confirmation, and truthfully reports "several items were in use and not deleted".

Only does provable-safe cleaning; **does not touch user data, does not touch the current version**.

## 4. Hide zero-small popups at startup

- The startup "new version found" system notification has been canceled, uniformly collected into the welcome card;
- Previous startup prompts were scattered across multiple toasts / bubbles; now only this one card;
- Console black window suppression logic kept (emulator / netsimd / adb console windows still hidden).

## 5. Interface beautification

- Brand-new color scheme: jade-green brand color + soft neutral background, background with a faint brand glow;
- Title bar changed to **frosted glass** texture; window icon changed to a vector brand mark (recognizable as a "play button" even at small sizes, no longer a dark block smudged into a lump);
- App cards: larger rounded corners, hover lift + brand color border, icon with shadow;
- Buttons: main button gradient + inner highlight, secondary buttons lighter;
- Modal boxes, group titles, scrollbars, status bar uniformly redone;
- Welcome card uses the same design language (gradient header + glow + dot matrix texture).

## 6. Hands-on

- `npm test`: **all 113 items passing** (8 + 25 + 80).
- Smoke screenshot verification: main interface and welcome card both render normally (see release page screenshots).
- "Clean old version residuals" scanned out 6 old-version directories, about 1.3 GB on the development machine; current running version correctly excluded.

## 7. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
