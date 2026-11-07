# Build, sign, install and launch the app on Mohamad TV.
# Usage: pwsh -File deploy.ps1
param(
    [string]$TvIp = '192.168.1.78',
    [string]$Profile = 'TaherTV',
    [string]$AppId = 'TaherIPTV0.TaherIPTV'
)
$ErrorActionPreference = 'Stop'
$tizen = 'C:\tizen-studio\tools\ide\bin\tizen.bat'
$sdb = 'C:\tizen-studio\tools\sdb.exe'

# Stage a clean copy so signing files never land in app/.
$stage = Join-Path $PSScriptRoot (".build\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'app\*') $stage -Recurse

& $sdb connect $TvIp | Out-Host
$serial = (& $sdb devices | Select-String "^$([regex]::Escape($TvIp)):\d+\s+device\s+(\S+)").Matches.Groups[1].Value
if (-not $serial) { throw "TV $TvIp not connected. Check Developer Mode Host PC IP on the TV." }

& $tizen package -t wgt -s $Profile -- $stage | Out-Host
$wgt = Get-ChildItem $stage -Filter *.wgt | Select-Object -First 1
if (-not $wgt) { throw "Packaging failed: no .wgt in $stage" }
Rename-Item $wgt.FullName 'TaherIPTV.wgt'

& $tizen install -n TaherIPTV.wgt -t $serial -- $stage | Out-Host
& $tizen run -p $AppId -t $serial | Out-Host
Write-Host "Deployed $AppId to $serial"
