# Portable adb

Extract the Android platform-tools into this directory (so that `adb.exe` appears here) and ApkStart
will prefer it:

```
tools/platform-tools/adb.exe
```

Download: https://developer.android.com/tools/releases/platform-tools

If this directory is empty, ApkStart tries, in order:

1. The adb path set manually in the settings
2. This directory
3. The adb bundled with the runtime
4. The adb shipped with common emulators (LDPlayer / MuMu / BlueStacks)
5. The system PATH
