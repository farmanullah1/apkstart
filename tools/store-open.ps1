﻿# ApkStart Store publishing - open everything you need in one go
# Usage: right-click -> Run with PowerShell
# Purpose: put the four things publishing needs on screen at once instead of hunting through directories

$ErrorActionPreference = 'Continue'
$root = 'D:\apkstart-dsh\apkstart'
# The version is read from package.json at runtime; never hardcode it -- bumping it every release and forgetting this is inevitable.
# MSIX versions have four parts (0.5.2 -> 0.5.2.0), matching the rule in build/msix.js.
$ver = '0.0.0.0'
try {
    # -Encoding UTF8 is mandatory: Windows PowerShell 5.1 defaults to ANSI,
    # and package.json used to contain non-ASCII text that turned into mojibake and made ConvertFrom-Json throw.
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $ver = ('{0}.0' -f $pkg.version)
}
catch {
    Write-Host '  [!] Could not read version from package.json, falling back to looking for 0.5.3.0' -ForegroundColor Yellow
    $ver = '0.5.3.0'
}
$msix = Join-Path $root ('dist\store\ApkStart_{0}_x64.msix' -f $ver)
$guide = Join-Path $root 'docs\store-upload-walkthrough.md'
$listing = Join-Path $root 'docs\store-listing.md'

Write-Host ''
Write-Host '  ApkStart publishing assistant' -ForegroundColor Green
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

if (-not (Test-Path $msix)) {
    Write-Host "  [!] Installer not found: $msix" -ForegroundColor Red
    Write-Host '      Run node build/msix.js to package it first.' -ForegroundColor DarkGray
}
else {
    $mb = [math]::Round((Get-Item $msix).Length / 1MB, 1)
    Write-Host "  [1] Installer  $mb MB" -ForegroundColor Cyan
    Write-Host '      Selected in Explorer; drag it straight into the upload' -ForegroundColor DarkGray
    Start-Process explorer.exe "/select,`"$msix`""
}

Write-Host '  [2] Partner Center (opens in the browser, sign-in required)' -ForegroundColor Cyan
Start-Process 'https://partner.microsoft.com/dashboard/apps-and-games'

if (Test-Path $guide) {
    Write-Host '  [3] Publishing checklist (copy-paste)' -ForegroundColor Cyan
    Start-Process $guide
}

if (Test-Path $listing) {
    Write-Host '  [4] Store listing copy (long description / feature list / review notes)' -ForegroundColor Cyan
    Start-Process $listing
}

Write-Host ''
Write-Host '  Order: create product -> upload package -> paste listing -> submit' -ForegroundColor Yellow
Write-Host '  隐私政策：https://github.com/farmanullah1/apkstart/blob/main/docs/privacy.md' -ForegroundColor DarkGray
Write-Host ''
