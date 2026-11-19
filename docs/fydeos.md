# ApkStart's FydeOS Base (usable on Windows too)

> In one sentence: **replace the Google emulator with the Android environment that FydeOS comes with**.
> FydeOS can be installed on the local machine, or run inside VMware / VirtualBox, with ApkStart on Windows connecting to it.

---

## ⚠️ Read this first: the real risks of the FydeOS route

I verified the feasibility of this route and the conclusion is not optimistic. **You should know this before deciding whether to invest.**

1. **The official VMware image is a preview.** The download page original text says it is "designed for users to **test and preview** FydeOS in a virtualized environment" ([FydeOS for VMware](https://fydeos.com/download/vm/x86_64/)).
2. **The Android subsystem in the VMware version often does not work.** The FydeOS community has explicit statements that "the VMware version is for preview only and does not guarantee full feature availability"; user hands-on feedback reports that Android apps cannot connect to the network, `adb` can connect but the screen is black. ([Community discussion](https://community.fydeos.com/t/topic/47865))
3. **Some people say an older version (v18) actually works normally, and newer versions are broken.** That is, this route depends on a specific version and is likely to stop working one day.

**Conclusion**: I built the FydeOS base and it is usable, but **it should not be treated as the main solution**. If you just want "lighter than the Google emulator, windows no longer have problems" — the networking + **independent window mode** already fixed in v0.5.0 already solves that; no need to switch bases.

---

## Two usage methods

### Usage A: ApkStart and FydeOS on the same machine (FydeOS installed locally)

Prerequisite: you installed the FydeOS system itself (not Windows).

1. FydeOS app launcher → open "Android settings"
2. System → Developer options → enable **ADB debugging** (cannot find developer options: Android settings → About device → tap "Build number" 7 times)
3. FydeOS settings → Linux → enable Linux subsystem
4. In the Linux terminal: `sudo apt update && sudo apt install -y adb`
5. ApkStart → Settings → Runtime → engine mode select **FydeOS Android subsystem**, address **leave blank** (automatically tries `arc:5555`, `100.115.92.2:5555`, `127.0.0.1:5555` in order)

### Usage B: ApkStart on Windows, FydeOS running in a virtual machine

This is the form you want. Full steps:

#### 1. Install a virtual machine program

- **VMware Workstation Player** (free) — the official FydeOS VM image is `.ova`, import it directly
- **VirtualBox** — also works, but after importing `.ova` you may need to manually adjust UEFI

> Note: **Do not use Hyper-V.** ApkStart's built-in runtime relies on AEHD acceleration, and AEHD and Hyper-V are mutually exclusive; with Hyper-V enabled the built-in runtime cannot be used. VMware / VirtualBox do not have this problem.

#### 2. Import the FydeOS image

Get the `.ova` from the [FydeOS for VMware download page](https://fydeos.com/download/vm/x86_64/) (about 1.5GB+), in VMware "Open Virtual Machine" → select that `.ova`. If it prompts "OVF specification compliance check failed", click **Retry** to relax the validation as prompted; import can still proceed normally.

Recommend giving the virtual machine **4GB+ memory** (the Android subsystem eats memory).

#### 3. Enable ADB debugging inside FydeOS

1. Start the virtual machine, complete FydeOS initialization (login / local account)
2. Open Android settings, enable the Android subsystem
3. Android settings → System → Developer options → enable **ADB debugging**

#### 4. Let Windows connect to that virtual machine

Two routes, pick one:

**Route 1 (recommended, simplest): NAT port forwarding**

VMware: Virtual machine settings → Network adapter → select NAT → "NAT Settings" → Port forwarding → Add:

| Host port | Type | Virtual machine IP | Virtual machine port |
|---|---|---|---|
| 5555 | TCP | (leave blank or 192.168.x.x) | 5555 |

VirtualBox: Settings → Network → Advanced → Port forwarding → add one `127.0.0.1:5555 → 10.0.2.15:5555`

Then in ApkStart fill in the address: `127.0.0.1:5555`

**Route 2: use the virtual machine IP directly**

Change the virtual machine network to "Bridged", in FydeOS `crosh` (Ctrl+Alt+T) → `shell` → `ip addr` to see the IP, then in ApkStart fill in `<that IP>:5555`

#### 5. Configure ApkStart

1. Settings → Runtime → engine mode select **FydeOS Android subsystem**
2. Fill in the address from the previous step (e.g. `127.0.0.1:5555`)
3. Click Detect

**The first time you connect, a "Allow debugging?" authorization dialog will pop up in FydeOS — be sure to click "Allow"**, otherwise APKs cannot be installed.

---

## Differences from the built-in runtime

| | Built-in runtime (QEMU) | FydeOS base |
|---|---|---|
| Where Android comes from | ApkStart downloads its own image and boots it | Provided by the FydeOS system, already running |
| Boot after shutdown | Requires booting (v0.5.0 about 18 seconds) | Nearly instant (the virtual machine is already on) |
| Extra memory | About 3GB | Depends on virtual machine allocation |
| Image usage | Several GB | None (FydeOS's own disk) |
| Window embedding | ✅ Can embed into the ApkStart window | ❌ Screen is displayed by FydeOS itself |
| One app per window | ✅ | ❌ All apps share the FydeOS desktop |
| Stability | High (hands-on tested) | **Depends on FydeOS version, see warning at the start** |

**About "one app per window"**: This is the most valuable part of the ApkStart experience, and the FydeOS base cannot provide it. The reason is that the Android screen is inside the FydeOS desktop (or inside that virtual machine's window), not an independent window of some Android app, so there is no HWND that `SetParent` can use.

So under the FydeOS base, ApkStart's role becomes: **app list + install packages + launch + icon/shortcut management**, with the screen displayed by FydeOS itself.

---

## Common problems

### Prompt "Please fill in the FydeOS address first"

On Windows there is no "local Android", so ApkStart has no way to guess where that virtual machine is. Configure port forwarding or fill in the IP as in step 4 above.

### Always unauthorized, authorization dialog does not pop up

A known issue on some versions of FydeOS X (adb key mismatch between host and Linux subsystem). Manually sync the key:

```bash
# 1. In FydeOS's Linux terminal
adb start-server
cat ~/.android/adbkey.pub      # copy the content

# 2. Crosh (Ctrl+Alt+T) → shell to enter the host
sudo mount -o remount,rw /
sudo mkdir -p /opt/google/containers/android/rootfs/android-data/data/misc/adb
sudo tee /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys <<'EOF'
<paste the adbkey.pub content here>
EOF
sudo chown 1000:1000 /opt/google/containers/android/rootfs/android-data/data/misc/adb/adb_keys
sudo mount -o remount,ro /
```

Then restart the Android subsystem and connect again.

### Connected but apps installed into it will not open

If it is `INSTALL_FAILED_NO_MATCHING_ABIS`, the APK only has an arm64 version and FydeOS runs on x86. FydeOS has a built-in ARM compatibility layer but coverage is not complete — for such apps, switching to the built-in runtime (which comes with Google's ARM translation) is more likely to succeed.

### App screen is black

This is a long-standing problem of the FydeOS VMware version (see the warning at the start). First confirm whether FydeOS's own Android apps can open normally; if the system's own apps are also black screen, that is not an ApkStart problem — switch FydeOS versions (some report v18 works) or switch to the built-in runtime.

---

## Technical details (for maintainers)

- The backend is implemented in `src/core/backends/fydeos.js`
- Capability bits are deliberately declared conservatively: no `provision` (no image installation), no `snapshot` (no own snapshots), no `rotatePanel` (panel managed by the system). Only `shutdown`, and it only disconnects the adb connection; it does not really shut down Android inside the system — that would affect the user's other apps.
- `embedCapable = false`. Upper layers (`main.js`'s `attachAppWindow`) see this flag and skip screen takeover, without circling around `SetParent` failures and refreshing a bunch of `attach failed` messages.
- On Windows, use ApkStart's own adb (`runtime/platform-tools/adb.exe`); users are not required to install platform-tools themselves.
