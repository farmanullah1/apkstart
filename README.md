# ApkStart

A Windows app that lets you install and use Android apps just like regular Windows programs. Install an Android app, and it gets its own desktop icon and opens in its own window when you double-click it.

It is a free, open-source hobby project built in spare time, with no ads and no hidden costs.

---

## What it feels like to use

1. If you have an Android app file (`.apk`), you can double-click it in Windows and ApkStart will install it for you.
2. After installing, you get a normal-looking desktop shortcut with the app's own icon.
3. Double-click that shortcut and the app opens in its own window, not inside some generic emulator screen.
4. Files you save or download inside Android apps can appear on your Windows desktop automatically, and files you put on Windows can show up inside the Android apps too.

In short: Android apps become things you can start from the desktop, search for in the Start menu, and use like any other Windows program.

---

## What ApkStart is good for

- Running Android apps on Windows without needing to understand emulators, virtual machines, or dev tools.
- Making Android apps feel more like normal desktop apps, with their own icons and windows.
- Sharing files between Android apps and Windows without copying things around by hand.
- Keeping things simple: ApkStart bundles what it needs and does not depend on other emulator software you may already have on your computer.

---

## What kind of app is this, really?

ApkStart is a Windows program that can:

- read Android app packages,
- install those apps into an Android runtime,
- start those apps on demand,
- show each app in its own window,
- and create Windows shortcuts for them.

It is not a phone, and it does not replace your phone. It is a way to run selected Android apps on a Windows PC.

---

## Before you try it

ApkStart works best when your computer is allowed to help run virtual things a little faster. On Windows, that usually means making sure a feature called **Windows Hypervisor Platform** is enabled, or that the Google **AEHD** driver is available.

If that sounds intimidating, ApkStart can guide you through it inside the app. You only need to deal with it once, and sometimes Windows already has what it needs.

A few everyday notes:

- The first time you run ApkStart, it may need to download and set up part of the Android runtime. This can take a while the first time, but it usually happens only once.
- Some Android apps are built only for ARM processors. ApkStart can still run many of them using a translation layer, but very rarely a particular app may not work in any emulator.
- ApkStart is intended for Windows 10 or 11 on a 64-bit PC.

---

## How to get it

You do not need to build anything to use ApkStart. Ready-made downloads are available from two mirrors with the same content:

- GitHub releases
- Gitee releases, which is often faster if you are in China

The downloads come in a few shapes, so you can pick the one that matches how you want to use it.

### The simple version of the download choices

- **Microsoft Store package**
  Install it like any other Store app. It includes everything it needs, and updates can be handled through the Store.

- **Full portable package**
  A larger download that already includes the runtime. You can extract it and run it right away without waiting for extra downloads later.

- **Installer package**
  A normal installer that sets up desktop and Start menu shortcuts and gives you a clean way to uninstall later.

- **Light portable package**
  A smaller download for a quick try. The first time it runs, it downloads the runtime it needs.

If you only want to try it quickly, the light portable package is the easiest starting point. If you want the least fuss every time you open it, the full portable package or the Store package is more convenient.

---

## The first run

The very first time you open ApkStart, it may need to prepare the Android runtime. This can include downloading parts of the runtime and unpacking them once.

That first setup is normal. After it is done, opening apps is usually much faster.

A few things that help set expectations:

- The first launch can take longer than later launches.
- After the runtime is ready, opening an app is mostly a matter of starting it, not rebuilding everything from scratch.
- If you already have a desktop shortcut from an older version, make sure it points to the new ApkStart folder after you upgrade.

---

## Everyday use

### Installing an app

You can install an Android app in a few ways:

- Double-click the `.apk` file in Windows, if file association is enabled.
- Use the install option inside ApkStart.
- Use the command line and point it at the `.apk` file.

After install, ApkStart can create a desktop shortcut and a Start menu shortcut for the app.

### Opening an app

Double-click the app's desktop icon. Because the apps share the same Android runtime, opening a second app is usually quick once the runtime is already running.

### The app window

Each app opens in its own window. You can:

- switch between fullscreen and windowed mode,
- rotate the screen between portrait and landscape,
- and in many cases let ApkStart remember the app's size and orientation.

Fullscreen makes the window fill the screen height and stay centered. Windowed mode lets you drag and resize the window.

### Moving files between Windows and Android

ApkStart can keep a folder on Windows and a folder inside Android in sync.

- On Windows, the shared folder is usually under your user profile.
- Inside Android, the matching folder is under its shared storage.

If you put a file in one place, it can show up in the other.

### Finding your apps in Windows

Shortcuts can be placed on both the desktop and in the Start menu. That means you can search for an app by name in Windows and launch it directly, just like any other program.

---

## What ApkStart handles for you

ApkStart is designed to reduce the number of manual steps a normal user has to remember.

It can:

- create shortcuts automatically after install,
- keep each app's icon and window settings,
- restart the Android runtime when needed,
- try different settings if one setting does not work,
- check the computer and suggest better settings,
- and tidy up stale locks or leftover processes when something gets stuck.

You are not expected to manage emulator paths, ADB ports, or image files by hand unless you want to.

---

## Settings made simple

Starting in version 0.6.0, settings are grouped into eight categories with a search box at the top. That means you do not have to hunt through everything to find one setting.

The main groups are:

- **General and setup** — runtime, first-time setup, starting with Windows, disk space, and cleanup.
- **Display and windows** — how apps appear, fullscreen, screen orientation, window mode, and related layout options.
- **Controls and input** — mouse and keyboard behavior.
- **Performance and resources** — memory, quality, data partition, language, snapshots, and startup warming.
- **Network and downloads** — where updates and downloads come from, and how many download parts to use at once.
- **Diagnostics and repair** — computer checkups, compatibility patches, and automatic issue detection.
- **Integration and files** — shortcuts, shared folder, and system integration.
- **Updates and about** — checking for new versions and seeing project info.

The search box helps when you only know a keyword like "memory", "sound", or "orientation".

---

## Automatic checks and fixes

ApkStart can run background checks and point out common problems.

These checks can look at things like:

- whether the computer supports the acceleration it needs,
- whether the Android runtime can be seen,
- whether there is enough disk space,
- whether settings are conflicting,
- and whether the Android side has network access.

When it finds something fixable, it can often offer a one-click fix.

Two important ideas behind the checks:

- if a check cannot read the computer's state, it says "unknown" instead of guessing,
- and it tries not to keep showing the same problem over and over.

If you are ever stuck, the same Diagnostics area can also help you export a report that is useful when asking for help.

---

## When something does not work

The most common issues are usually not mysterious. A few examples:

- **Slow startup or "hardware acceleration not enabled"**
  This often means the computer is running without the acceleration it would prefer. ApkStart can still work, but it may be slower. The app can guide you to turn on the right Windows feature or driver.

- **Install fails**
  Install errors can happen for many reasons, such as an incomplete download, a signature mismatch, or not enough space. ApkStart translates many of these into plain language in the app.

- **App installs but will not start**
  Some apps need ARM translation support, and a few need a compatible runtime image. ApkStart includes logic to handle common cases automatically.

- **The app will not launch at all**
  This can be caused by a stale shortcut, an old version still being referenced, or the runtime not being ready yet. The troubleshooting notes in the app walk through the likely causes step by step.

- **No sound**
  If only ApkStart's apps are silent, the cause is often a setting or a Windows audio service issue. If the whole computer is silent, fix Windows audio first.

If you are helping someone else or reporting an issue, the most useful things to include are:

- a diagnostic report from the app,
- the last part of the app log,
- and the version and type of ApkStart you are using.

---

## Command line basics

ApkStart can also be used from the command line.

- Running it with no arguments opens the main window.
- Running it with an `.apk` path starts the install process.
- Running it with a launch command starts a specific app directly. That is what desktop shortcuts normally use.

---

## Building from source

If you want to build ApkStart yourself, the basic steps are:

1. Install dependencies.
2. Start the development setup.
3. Optionally enable `.apk` file association.
4. Package the build if you want a standalone copy.

There are a few packaging options depending on whether you want a light portable build, a full build with the runtime included, or a Store package.

A couple of practical notes:

- The full build is larger because it includes the Android runtime.
- The light build is smaller, but it may download part of the runtime the first time it runs.
- The installer package is useful if you want shortcuts and a normal uninstall entry.

---

## How ApkStart is put together

ApkStart is made of a few parts that work together:

- the main program that manages windows, shortcuts, and startup,
- a small bridge that lets the safe parts of the app talk to the interface,
- the interface itself,
- and the core logic that reads Android packages, manages the runtime, shares files, and handles installation.

It also uses a local runtime folder to keep the parts it needs, such as the Android tools and system image, on your computer.

One design goal is independence: ApkStart does not rely on other emulator installations you may have. It manages its own runtime instead.

---

## What it does not do

To keep expectations honest:

- ApkStart is not an Android phone replacement.
- It does not magically make every Android app work on Windows.
- It does not depend on, change, or interfere with other emulator software on your PC.
- It does not require you to become a developer to use it.

---

## About the project

ApkStart is maintained by **farmanullah1**.

You can find the project on GitHub.

---

## Contributing

If you want to help, bug reports and suggestions are welcome.

Because the app tries to stay simple and self-contained, it helps to test your change with the existing tests before submitting anything.

---

## License

The project is released under the MIT license.

The ApkStart code and the Electron runtime are included in distribution builds. Other parts, such as system images, emulator binaries, and Google platform tools, are downloaded from official sources when first needed, and they remain subject to their own licenses.
