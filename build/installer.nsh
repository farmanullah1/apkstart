; ApkStart custom NSIS script
; Purpose: before uninstall starts, terminate runtime processes that may still be resident in the background,
; otherwise they lock files in the install folder, leaving an incomplete uninstall that even bulk-delete tools cannot fix.
;
; A detached qemu can outlive ApkStart (it is kept around so the next launch is instant),
; so the uninstaller has to sweep for it itself.

; Installer epilogue: one more safety net for the desktop icon.
; electron-builder's createDesktopShortcut goes through its own CreateShortcuts routine,
; which can fail in some environments (desktop redirected by OneDrive, shortcut rolled back by security software),
; leaving the user with an empty desktop after install. So write it once more with the native NSIS CreateShortcut:
; $DESKTOP resolves via SHGetFolderPath, so it follows a redirected desktop; the operation is idempotent,
; and running it again after electron-builder just overwrites the same .lnk.
!macro customInstall
  DetailPrint "Creating desktop shortcut..."
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart - run Android apps directly on your PC"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart - run Android apps directly on your PC"
!macroend

!macro customUnInstall
  ; Remove the shortcut entry this script created (nothing should be left behind even if ApkStart is gone)
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "Closing leftover ApkStart processes..."
  ; /F force-kills, /T includes child processes. taskkill returns 128 when no process matches; ignore it.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Give the process a moment to exit and release its file handles
  Sleep 1500
!macroend
