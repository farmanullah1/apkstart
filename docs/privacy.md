# ApkStart Privacy Policy

Last updated: 2026-11-16

ApkStart is an Android app runner that runs on your local machine. Our principle is simple: **we do not collect, upload, or share your personal data.**

## 1. What we do not collect

- No account, name, email, phone number, or other identity information (this app has no account system).
- No device identifiers, advertising ID, or location information.
- No analytics, telemetry, crash-reporting, or advertising SDKs are integrated.
- No data is sent to any of our servers (this app has no own servers).

## 2. Data saved locally

The following data is kept only on your own computer and never leaves the device:

| Location | Content |
|---|---|
| `%USERPROFILE%\ApkStart\data` | Android system image, installed apps, app data, snapshots |
| `%USERPROFILE%\ApkStartShared` | Shared folder synced two-way with `/sdcard/ApkStartShared` inside Android |

Uninstalling the Microsoft Store version does not automatically delete the above directories; you can delete them manually at any time.

## 3. Network behavior

- **Microsoft Store version**: the install package already bundles all runtime components; first launch only does local extraction and does not download any executable content; app updates are handled by Microsoft Store.
- **Installer / portable version**: GitHub / Gitee Release lists are contacted only when you "Check for updates"; the lightweight version downloads the runtime package from project Releases on first launch. Requests contain only the version number and standard HTTP headers needed for downloading.
- Network access of the Android apps themselves is decided by those apps, using QEMU user-mode NAT over the host network; ApkStart does not perform content inspection or retain forwarded traffic.

## 4. Third parties

Android apps you run through ApkStart are provided by their respective developers; their data handling behavior is governed by their own privacy policies. ApkStart does not control or represent these third-party apps.

## 5. Children

This app is not directed at children under 13 and does not intentionally collect children's information.

## 6. Changes and contact

If the policy changes, this page is updated and the "Last updated" date is changed. For issues, submit an issue at https://github.com/farmanullah1/apkstart/issues
