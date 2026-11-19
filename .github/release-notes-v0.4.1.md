# ApkStart v0.4.1

> In one sentence: located and rooted out "rotation black edges / app not filling / click failure / cannot click agree" — these symptoms are actually **the same cause**: the embedded emulator window and the Electron web layer are sibling windows, and the web layer is always on top.

## 1. The real root cause

Using `WindowFromPoint` to do hit-testing at the screen center, it was found that what is returned is **not the emulator window**, but `Chrome_RenderWidgetHostHWND` (Electron's web render layer).

That is: that black-bottom web layer is always covering the Android screen, and eats all mouse events. So the following appear simultaneously:

| What the user sees | Actual cause |
|---|---|
| Black edges / not filling | The web layer black bottom covers the embedded screen, or only exposes part |
| Click failure, cannot correspond | The mouse clicked the web layer, never entered Android |
| Cannot click "Agree and continue" | Same (because `adb input tap` uses logical coordinates and bypasses the host) |
| More obvious after rotation / fullscreen | Changing window size triggers Chromium repainting, lifting itself back to top again |

Previously in v0.3.9 I used `SetWindowRgn` clipping to try to squeeze that 8px title bar out of the screen, but instead **broke Qt/GL sub-window hit-testing**, and made the region mismatch the window size after resize — that was exactly the direct source of this version's problem.

## 2. Fix

1. **Remove `SetWindowRgn` clipping**, and instead explicitly clear regions that old versions may have left residual at `Embed()` time. The title bar overflow is naturally covered by the host's self-drawn title bar.
2. **Hang the emulator window as a child of the web render layer** (instead of a sibling child of the host). The sub-window's Z-order and mouse hit-testing are naturally prior to the parent window; the web layer will no longer cover the screen or eat clicks.
   - At the moment of embed the web layer may not yet be built, so supplementary hanging is done in `Fit()` and the resident scan, guaranteeing it takes effect.
3. **Narrow `HideStrayWindows`**: only hide explicit popup-type (Qt tool windows / console), absolutely do not touch `QWindowIcon` / `subWin` (that is the LCD being displayed), to avoid mis-hiding the screen into full black.
4. **After launch completes, raise the window to top** (briefly topmost then revoke): to avoid other windows (browser, etc.) covering it and causing "black screen + cannot click".
5. **Window size during rotation**:
   - Under maximized state `setContentSize` is ineffective; now first `unmaximize` then change size, otherwise the landscape screen is stuffed into a portrait window = black edges / not filling;
   - Target size is limited within the screen available area;
   - After `wm size` changes, Qt re-lays out multiple times; changed to 6 consecutive rounds of `Fit` convergence, thoroughly eliminating residual black edges.

## 3. Hands-on (this time end-to-end real interaction, not adb simulation)

- Used a **real mouse** to click "Agree and continue" → enter `MainFragmentActivity` → continue tapping into `ShortSeriesActivity` play page;
- `PrintWindow` captured the host window: Android screen **fills all area below the title bar, no black edges, no blank space** around; video / like / comment / select episodes / title bar four buttons all normal;
- `WindowFromPoint` at screen center returns the emulator window (before fix returned the web layer);
- `npm test`: **all 115 items passing** (8 + 25 + 82), added two regression tests nailing down "embedded window must be hung under the web layer and must not set region".

## 4. Engineering strengthening

- `agent.ps1` keeps UTF-8 BOM (losing BOM makes PowerShell 5.1 read Chinese comments as ANSI, `Add-Type` compile fails → window agent startup fails);
- Added regression test: verify `SetParent(emu, parent)` / `FindChromeRender` exist, `CreateRectRgn(0, clipTop)` does not exist, clear region at embed time.

## 5. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
