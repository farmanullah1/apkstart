# Runtime engine directory (manual placement, optional)

**Since 0.2 ApkStart is fully self-contained by default**: adb, QEMU and the system image are
downloaded and deployed into `%APPDATA%\apkstart\runtime\` by the app. Nothing has to be prepared by hand.

This directory only matters in the following two cases:

## 1. Placing QEMU manually (download source blocked / you want a specific build)

```
qemu\qemu-system-x86_64.exe
└─ ... (the rest of the QEMU files)
```

Official QEMU Windows builds: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` is an NSIS installer; ApkStart installs it silently into the runtime directory
with `/S /D=`. You can also extract it with 7-Zip and drop the files into the layout above.)

## 2. Placing adb manually

Extract the Android platform-tools here (see `tools/platform-tools/README.md`).

Download: https://developer.android.com/tools/releases/platform-tools

## System image

- Recommended: Android-x86 9.0-r2 (x86_64), downloadable from inside the app (multiple mirrors, resumable)
- Or import any disk image that already has Android installed (qcow2 / raw / vmdk) via "Runtime -> Import"
- After importing, ApkStart boots straight from the disk; no install step is involved

## Hardware acceleration

QEMU uses WHPX: Control Panel -> "Turn Windows features on or off" -> tick "Virtual Machine Platform" -> reboot.
When it is not enabled ApkStart falls back to pure software emulation (TCG), and the first boot is slow.
