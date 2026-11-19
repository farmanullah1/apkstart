# ApkStart v0.3.9

> In one sentence: change **portrait/landscape switching** from "rotate the screen" to real **phone / tablet layout switching**, fix fullscreen not landscape, click failure, and black edges appearing when clicking title bar buttons; also add **storage reclamation**.

## 1. Portrait/landscape / fullscreen: changed to real layout switching

**The original problem**: after tapping rotation (or fullscreen), the screen lies down clockwise/counterclockwise as a whole, the app does not re-layout, and cannot be positioned correctly; fullscreen also does not automatically go landscape.

**Root cause**: the old implementation was "change `wm size`, then have the window agent send Ctrl+← to the emulator". Ctrl+← only rotates the **emulator's screen** 90°; the Android side layout is completely unchanged — so what you see is "the screen lying down". And the AVD generation config hard-coded `hw.sensors.orientation=no`, so Android does not allow rotation at all, only faking it by rotating the screen.

**What it does now**:

- Only change the **logical display size** (`wm size`), letting Android re-layout per the new width:
  - Portrait 720×1280 @320dpi ≈ **360dp wide → phone layout**;
  - Landscape 1280×720 @320dpi ≈ **640dp wide → tablet/side-by-side layout** (Android takes 600dp as the tablet threshold);
- At the same time `wm user-rotation lock 0`, guaranteeing the screen is always upright, no more "lying down";
- **Deleted the screen-rotation step**; screen and layout are always consistent;
- The window recalculates aspect ratio per the new resolution and re-fits, leaving no black edges;
- **The fullscreen button now automatically switches to landscape (tablet layout)**, exiting fullscreen automatically returns to portrait phone layout; the "display mode" switch in settings also takes effect;
- AVD config changed to `hw.sensors.orientation=yes` + `hw.sensors.accelerometer=yes`, so future new machines will not be locked portrait again.

## 2. Fix: black edges appearing when clicking the four title bar buttons

The emulator's Qt window is one ring larger than the real LCD (8px gray edge on each side). To keep the gray edge from appearing in the screen, the old approach was to overflow the sub-window upward/leftward by 8px — that 8px exactly pressed on the bottom of the title bar; while when clicking buttons, the window agent lifts the emulator window to top, so that overflowing part draws a **black edge** below the title bar.

**Fix**: added **window region clipping** (`SetWindowRgn`) to the embedded emulator window, directly clipping off that 8px overflowing into the title bar. So no matter how it is lifted, it cannot draw onto the title bar.

## 3. Fix: click failure / cannot click "Agree and continue"

This item shares the same source as the above two problems: after the screen is rotated 90°, the window agent's coordinate mapping is still "portrait", so click positions are overall offset, looking like "clicked but no response". After the layout switch is corrected, clicks recover normally.

Also reduced the cost of "waiting for network": cold boot retry changed to **do once per process**, first wait dropped from 60s to 25s — previously one tap could wait several more minutes; now normally passes within a few seconds.

## 4. Storage usage optimization

"Clean old version residuals" now additionally reclaims **abandoned quickboot snapshots**:

- Old version legacy `default_boot` (a `ram.img` about **3 GB**);
- `*.stale-*` residuals that could not be deleted and were renamed;
- The currently used snapshot (`apkstart`) is never touched.

Hands-on on the development machine: reclaimable items total about **4.65 GB** (6 old-version program directories + 1 abandoned snapshot).

## 5. Hands-on

- `npm test`: **all 113 items passing** (8 + 25 + 80).
- `wm size 1280x720` then framebuffer hands-on changed to **1280×720**, screen upright (screenshot confirmed).
- App window embed `embedded=true`; after closing window `pidof` is empty (previous version's fix remains effective).

## 6. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
