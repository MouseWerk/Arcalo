<#
.SYNOPSIS
  Fails when a Windows program of Arcalo needs a DLL that a fresh Windows 10 or 11 does not have.

.DESCRIPTION
  arcalo.exe links the C and C++ runtime statically (.cargo/config.toml): it must not import the
  Visual C++ Redistributable's DLLs (VCRUNTIME140*.dll, MSVCP140*.dll, CONCRT140.dll), nor
  WebView2Loader.dll (linked statically as well). Up to 1.18.0 it needed the Redistributable and
  did not start without it. Reads the import table with dumpbin of the newest Visual Studio.

.EXAMPLE
  ./scripts/check-windows-runtime.ps1 target/release/arcalo.exe
#>
param([Parameter(Mandatory)] [string[]] $Exe)

$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found (Visual Studio)" }
$dumpbin = & $vswhere -latest -products * -find "VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Select-Object -First 1
if (-not $dumpbin) { throw "dumpbin.exe not found (Visual Studio C++ tools)" }

$failed = $false
foreach ($file in $Exe) {
  if (-not (Test-Path $file)) { throw "Not found: $file" }
  $dlls = & $dumpbin /nologo /dependents $file | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '\.dll$' }
  if ($LASTEXITCODE -ne 0) { throw "dumpbin failed on $file ($LASTEXITCODE)" }
  Write-Host "$file imports: $($dlls -join ', ')"
  $missing = $dlls | Where-Object { $_ -match '^(vcruntime|msvcp|concrt|vccorlib)\d+(_\d+)?\.dll$|^webview2loader\.dll$' }
  if ($missing) {
    Write-Host "::error::$file needs $($missing -join ', '), which a fresh Windows does not have"
    $failed = $true
  }
}
if ($failed) { exit 1 }
