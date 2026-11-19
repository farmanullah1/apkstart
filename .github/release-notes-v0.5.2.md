# ApkStart v0.5.2

This release fixes only one thing: **the Microsoft Store version, after installation, prompts "hardware acceleration not enabled"**.

## Why Store users will definitely encounter it

The Android emulator on Windows has only two acceleration paths:

| Method | What it is | Needs admin? | Needs reboot? |
|---|---|---|---|
| **AEHD** | Google's own kernel driver | During driver install | No |
| **WHPX** | Windows built-in feature "Virtual Machine Platform" | When enabling the feature | Yes |

The Microsoft Store (MSIX) package is launched by the AppX deployment model, fixed at mediumIL: **it cannot install kernel drivers, nor obtain administrator authorization**. So the Store version only has WHPX left, and "Windows Virtual Machine Platform" is **disabled by default** on a fresh Windows — so right after installation it prompts no hardware acceleration, and can only run pure software emulation (boot takes several minutes).

## Where the old version went wrong

1. Tapping "Fix" went through `Start-Process -Verb RunAs` elevation — the packaged app cannot obtain it, doomed to fail, so the prompt could never clear.
2. The prompt text wrote "suggest installing the AEHD driver or enabling the virtual machine platform" — the Store version cannot install drivers, so it pointed to a dead end.
3. Only mentioned "virtual machine platform (VirtualMachinePlatform)", but that is the feature **WSL2** uses; the emulator needs **"Virtual Machine Platform (HypervisorPlatform)"**. Enabling only the former, `emulator -accel-check` still says unavailable.
4. Used `WinHvPlatform.dll` existence to judge "whether to take the WHPX branch" — this DLL has always been present on modern Windows (tested present on this machine, but running AEHD); the judgment was completely distorted.
5. After successful enabling, did not clear the acceleration cache, so the UI still showed the old conclusion.

## What it does now

- **Store version**: tap "Fix" → no longer pops the administrator authorization it is doomed to not obtain; instead **directly opens the "Turn Windows features on or off" dialog** (`optionalfeatures.exe`, only inside it is that item), and clearly tells you to check "Windows Virtual Machine Platform", and after completing, restart once.
- **Installer / portable version**: still one-click enable (UAC) → automatically switches to installing the AEHD driver on failure; if the user taps "No", it clearly says "you cancelled authorization", instead of a vague "failed to enable".
- Both features are enabled at once (HypervisorPlatform first, then VirtualMachinePlatform); after enabling, clears the acceleration cache.
- When running in software emulation, **the first time an app is opened, a system notification pops up once**: explaining acceleration can be 5~10× faster, and where to enable it. (The self-check item in settings is buried deep; people waiting for boot will never see it.)

## Store version users enabling it themselves (two equivalent routes)

Graphical interface: `Win+R` → type `optionalfeatures` → check **Windows Virtual Machine Platform** → OK → restart.

Administrator PowerShell:

```powershell
dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

## Also

- `docs/store-listing.md`'s Notes for certification added a paragraph explaining this, to avoid reviewers seeing that prompt and judging "unusable".
- README added a section "what to do when prompted hardware acceleration not enabled" (including the two commands above).

---

## Microsoft Store

- Package: `dist/store/ApkStart_0.5.2.0_x64.msix` (x64, about 850 MB, full runtime bundled)
- Identity: `farmanullah1.ApkStart` / `CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D`
- Upgrade: `0.5.2.0 > 0.5.1.0 > 0.5.0.0`, can directly overwrite previously submitted versions

Test: 9 + 25 + 118 = 152 passing.
