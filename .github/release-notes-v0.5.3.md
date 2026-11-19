# ApkStart v0.5.3

This release is entirely around **icons**: making each Android app actually show its own icon on the desktop / taskbar.

## 1. Android app shortcuts restored to "the app's own icon"

The previous version, when organizing icons, uniformly wrote all ApkStart-related shortcut icons as ApkStart's brand icon; so the desktop shortcuts for Hongguo and MoreRead all became the green play button.

Now use the app's own `shortcut.writeShortcut()` to rewrite (the same code path as "Settings → Rebuild shortcuts"):

| Shortcut | Icon |
|---|---|
| Hongguo free short dramas (desktop + Start menu) | `%APPDATA%\apkstart\icons\com.phoenix.read.ico` |
| MoreRead (desktop + Start menu) | `%APPDATA%\apkstart\icons\cn.moread.app.ico` |
| ApkStart / Demo (the runner itself) | Brand icon |

> The product code was already using `app.icoPath`; this is a fix for a corrupted environment + an added layer of taskbar identity.

## 2. Taskbar identity switches per app

Windows only merges the currently running window with the taskbar pinned item, and inherits the shortcut's icon, when "the running process's AUMID == the shortcut's AUMID". Each app's shortcut writes `farmanullah1.ApkStart.<package name>`, while the process-level identity was originally `farmanullah1.ApkStart` — when they do not match, you get "the pinned item is the app icon, but the taskbar pops up another ApkStart button".

Now: before opening an app, switch the process identity to that app's AUMID; when returning to the management window, switch back to ApkStart's.

## 3. Runner exe branding (since 0.5.2)

`ApkStart.exe` was previously just renamed `electron.exe`: FileDescription=Electron, CompanyName=GitHub, Inc., version 33.4.11, and the icon was Electron's. Now packaging writes:

```
FileDescription  ApkStart Android App Runner
ProductName      ApkStart
CompanyName      farmanullah1
FileVersion      0.5.3.0
ProductVersion   0.5.3
```

And embeds `appicon.ico` (9 frames from 16→256).

---

## Upgrade notes from 0.5.2

- `0.5.3.0 > 0.5.2.0`, Store can directly overwrite upgrade.
- Users who previously installed 0.5.1 / 0.5.2: after updating, **no need to reinstall Android apps**, but it is recommended to tap "Settings → Rebuild shortcuts" once, to refresh old shortcuts' icons to the app's own (shortcuts for apps installed in 0.5.2 are themselves correct; only the few manually corrupted ones need rebuilding).

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.3.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Submission materials: `docs/store-listing.md` (includes this version's What's new in Chinese and English)
- Steps: `docs/store-upload-walkthrough.md`

Test: 9 + 25 + 121 = 155 passing.
