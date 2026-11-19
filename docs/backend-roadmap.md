# Android runtime backend evaluation（v0.5.0 branch）

> Background: v0.4.3 used the Google native emulator + Qt window, embedded into an Electron window.
> That embedding path had a chain of inherent flaws（black borders, coordinate mismatch, incomplete fill, Qt panel orientation fighting）.
> This doc records the feasibility evaluation for "switching the runtime backend", and what actually landed in v0.5.0.

## Quick conclusions

| Option | Performance | Stability | Distribution / compliance | Effort | Conclusion |
|------|------|------|------|------|------|
| **A. Existing emulator + standalone window mode** | Medium | High | No issue | Small | ✅ **v0.5.0 already shipped** |
| **B. Waydroid + WSL2** | High | Medium | No issue | Large | ⚠️ Possible, but with hard gates |
| **C. Waydroid + lightweight Linux VM** | High | Medium | No issue | Large | ⚠️ Same as B, and heavier |
| **D. Tencent AppPlayer** | High | High | ❌ Closed source | — | ❌ Not viable |
| **E. Microsoft WSA** | High | — | ❌ Support ended | — | ❌ Not viable |
| **F. Switch OS（FydeOS / PhoenixOS / Bliss OS）** | High | Medium | No issue | Huge | ❌ Conflicts with product positioning |

## A. Standalone window mode（shipped）

Instead of SetParent-ing the emulator window into our own window, let the emulator open its own
native window, and we only handle "open the app → put that window in front of the user".

**Why this is better than keeping fixing embedding**: the problems under embedding mode（black borders, coordinate mismatch, clicks not matching, not filling）all root-caused in "we're treating a Qt/OpenGL window like an ordinary child window and forcing it around". Fix one and another shows up. In standalone window mode, display rendering, input mapping and size adaption are all handled by the emulator itself — which is exactly what it's good at.

**Already implemented**:
- `display.windowEmbed` setting（`embed` / `detached`），selectable in the UI.
- `appwin.openDetached()`: hide the empty shell window → drop the parent/child relationship → show the native window →
  center it by panel aspect.
- `agent.ps1` adds `layout` / `detach` / `perf` commands; under `_detachedMode`
  cleanup only does the minimum, and never hides the window the user is looking at as junk.
- The size must be **right on the panel aspect in one shot**: the emulator's native window locks its own aspect ratio, and a wrong aspect gets clamped back（give 1280 wide and only 400 actually fits）.

**Measured**（this machine Ryzen 7 8745HS / Win10 26300 / AEHD）：
Fanqie Free Drama fills `Android Emulator - apkstart:5554`'s native window, correct orientation, clicks match, no black borders.

**Cost**: one extra taskbar icon, and the look is not perfectly unified with the main window.

## B / C. Waydroid route

Waydroid is an LXC container solution（not a VM）: it reuses the host Linux kernel to run the Android
framework directly, and draws graphics to Wayland, so performance is clearly better than any emulator.

**Hard gates**（all required）：

1. **Need a Linux kernel that can actually run**, and the kernel must be compiled with binder / ashmem.
   - Microsoft's official WSL2 kernel has **binder removed by default**, so you must compile your own
     from `microsoft/WSL2-Linux-Kernel` with options like `CONFIG_ANDROID_BINDER_IPC`
     and swap it in.
2. **Need a Wayland session**. Waydroid does not run on X11.
3. **Need `/dev/dri/renderD*` GPU render node**, and it **does not support NVIDIA proprietary drivers**.
4. **Need Hyper-V / WSL2 infrastructure**（if going the WSL2 route）.

**This machine's actual state**:

| Gate | Status |
|------|------|
| `HypervisorPresent` | `False` — Hyper-V not enabled |
| WSL | Only a `wsl.exe` stub, **no distro at all** |
| AEHD | Running（the emulator uses it for acceleration） |
| GPU | AMD Radeon 780M（fits, not NVIDIA） |
| CPU / RAM | 16 threads / 31.3 GB（plenty） |

**Key conflict**: ApkStart currently relies on **AEHD**（Android Emulator Hypervisor Driver）
for acceleration. AEHD and Hyper-V are **mutually exclusive** — once Hyper-V is enabled, AEHD stops working. So
Waydroid cannot coexist with the existing emulator backend on the same machine at the same time; it's one or the other.

**Option C（lightweight Linux VM）is heavier than B**: you'd run an extra full Linux
VM on Windows（QEMU/VirtualBox/Hyper-V）and then install Waydroid inside it, which is two layers of virtualization +
distributing a whole Linux distro. Startup time, disk use and first-time setup complexity all
far exceed the current "double-click an APK and it works".

**Waydroid also lacks ARM compatibility**: in an x86 environment it can only run x86 apps, and apps that only have ARM
`libhoudini`/`libndk` need an extra translation layer, with worse performance after translation. Domestic short-video /
social APKs are heavily arm64-only, and that's a hard weakness for a "drop any APK in" positioning.

## D. Tencent AppPlayer

Closed-source commercial product, no public API, cannot be embedded, cannot be distributed with us, cannot be relied on long-term.
**Not viable.**

## E. Microsoft WSA

Microsoft ended support in March 2025 and closed the official distribution channel; and it depends on Hyper-V, which conflicts with
AEHD. Third-party repackaged versions carry compliance risk. **Not viable.**

## F. Switch OS（FydeOS / PhoenixOS / Bliss OS）

These are **full operating systems**, not a component for "run Android apps on Windows". Adopting them means
making the user reinstall their OS — a direct conflict with the "double-click an APK on Windows and it works" positioning. Also,
PhoenixOS is basically unmaintained now. **Not a product direction.**

## Follow-up suggestions

1. **Short term**: standalone window mode（A）has already solved the main UX problems; polish it first and
   watch user feedback. This is the highest benefit/cost step.
2. **Mid term**: the pluggable backend abstraction in `src/core/backends/` is already in place（`Backend` +
   `CAPS` capability flags）. If Waydroid ever needs to be connected, just add one new backend implementation,
   with no change to the main flow.
3. **If Waydroid is ever really built**, the only pragmatic form is: **a separate installer / separate branch**,
   clearly telling users "this version requires Hyper-V, and cannot coexist with the emulator version", instead of
   trying to seamlessly switch with the existing backend.
