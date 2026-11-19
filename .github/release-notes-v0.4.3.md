# ApkStart v0.4.3

> In one sentence: change **rotation/fullscreen** from "change runtime resolution" to "swap physical panel size", so landscape is finally **upright and full**; also fix whole-machine lag, and add **game / low-latency mode** (in preparation for FPS).

## 1. Rotation / fullscreen: now really upright and full

### Why it was always wrong before

The emulator's screen comes from a "physical LCD panel"; Qt opens the window per panel size and pastes the screen at the top-left. The previous three approaches were all wrong paths, and each corresponds to one phenomenon in your screenshots:

| Approach | Result |
|---|---|
| Changing `wm size` at runtime | Only changes Android logical resolution; the physical panel is still portrait → screen **lies down 90°**, occupies only a strip at top-left, click coordinates misaligned |
| Changing `wm density` at runtime | Framebuffer size unchanged → screen **does not fill**; after maximize, a large empty area on the right |
| `adb emu rotate` | Only rotates screen content; the system side is still portrait |

### What it does now

**Rotation = change `hw.lcd.width/height` and restart the emulator** (about 30–60 seconds, only happens once when you tap rotation):

- Portrait panel `720x1280`, landscape panel `1280x720`;
- At the same time set direction lock `wm user-rotation` (landscape lock 1, portrait lock 0) + disable sensor auto-rotation — when the panel becomes landscape but rotation is still 0, the screen lies down;
- Direction is persisted in settings; re-opening ApkStart still boots with this direction;
- **Fullscreen button = switch to landscape**: window maximize + physical panel turns landscape, instead of stretching the portrait screen.

### Two real bugs also fixed along the way

1. **`-no-skin` overriding `-skin`**: launch parameters carried both; `-no-skin` made the panel size fall back to the `config.ini` old value — that is exactly the direct cause of "switched to landscape in settings, but actually still portrait". Removed `-no-skin`.
2. **Not filling after maximize**: when Electron maximizes, the host window becomes 1936×1048, but the internal Chrome render layer still stays at the old size (tested 532×984), and the emulator window hangs below the render layer, getting clipped by the parent window. Now Fit **first stretches the render layer to fill the host client area**, then pastes the emulator per that size; the window scan also self-heals once per round, recovering even if JS's resize event is lost.

## 2. Lag: three costs that made the whole machine laggy

1. **Window scan frequency**: previously in the first 90 seconds of boot, the whole desktop was enumerated once every 120ms (4 `EnumWindows` + process path query per round), continuously eating CPU. Now changed to 250ms for the first 10 seconds, then **1500ms**; game mode further drops to **3000ms**.
2. **Emulator priority**: the default balanced pushes qemu to BelowNormal, and after closing the app even drops to **Idle** (lowest) — Android therefore seriously drops frames. Now after closing the app it no longer unconditionally drops to Idle.
3. **Global mouse hook**: `WH_MOUSE_LL` synchronously callbacks every mouse event on the desktop, clearly increasing pointer latency. **Not installed at all in game mode**.

## 3. New: game / low-latency mode

Settings → Performance & Resources → **Virtual machine priority → "Game / Low latency"**:

- Emulator process raised to **High** priority; Android rendering and input preferentially get CPU;
- Global mouse hook removed; pointer takes the native input path;
- Window scan dropped to 3000ms, reducing host-side disturbance;
- The "smooth" resource policy now also directly enters this mode (video/game priority).

The cost is that other programs on the whole machine become a bit slower, so the default is still "balanced".

## 4. Strengthened along the way

- `settings.json` now tolerates **UTF-8 BOM**. Previously once the file had a BOM, `JSON.parse` threw directly, and the whole configuration silently fell back to defaults — the user would see "all settings lost" but could not find the reason (I tripped over this myself during testing). 
- Added regression tests: landscape must rely on `lcdFor({landscape})`, must not use runtime `wm size` again; window mode must use `-skin` and must not carry `-no-skin`; game mode must be High and not install the global hook.

## 5. Hands-on

- `npm test`: **all 117 items passing** (8 + 25 + 84).
- Landscape hands-on: `wm size` = `Physical size: 1280x720`, `user_rotation=1`, guest screen **upright, layout correct, no black edges**; after maximize, host client area 1920×1032, render layer synchronously stretched full.
- Portrait hands-on: `720x1280`, `rotation=0`, screen upright and full.

## 6. Upgrade method

- Portable version: unzip and overwrite; data directory (default `%APPDATA%\apkstart`) remains unchanged.
- Installer version: directly install and overwrite.
