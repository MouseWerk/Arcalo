<#
.SYNOPSIS
  Packs the Microsoft Store build of Arcalo as an MSIX package (docs/release/microsoft-store.md).

.DESCRIPTION
  Builds the package layout (Arcalo.exe, AppxManifest.xml with the identity filled in, Assets,
  resources.pri) and packs it with MakeAppx from the Windows SDK. MakeAppx checks the manifest
  against the schema. With -CertificatePfx the package is signed (tests: a self-signed
  certificate whose subject is the Publisher); the Store signs submitted packages itself, so
  the package for Partner Center stays unsigned.

  The executable is the Store build: `cargo build --release -p arcalo --features custom-protocol,store`
  after `npm --prefix ui run build`.

.EXAMPLE
  ./packaging/msix/pack.ps1 -Exe target/release/arcalo.exe -Version 1.12.0 `
    -IdentityName 12345MouseWerk.Arcalo -Publisher "CN=00000000-0000-0000-0000-000000000000" `
    -PublisherDisplayName MouseWerk -OutDir dist
#>
param(
  [Parameter(Mandatory)] [string] $Exe,
  # x.y.z of the app; the package version is x.y.z.0 (the Store reserves the fourth part).
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $IdentityName,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $PublisherDisplayName,
  [string] $OutDir = "dist",
  [string] $CertificatePfx = "",
  [string] $CertificatePassword = ""
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Version $Version is not MAJOR.MINOR.PATCH" }
if (-not (Test-Path $Exe)) { throw "Executable not found: $Exe" }
# Package/Identity/Name: letters, digits, '.' and '-', 3 to 50 characters.
if ($IdentityName -notmatch '^[A-Za-z0-9.\-]{3,50}$') { throw "Identity name '$IdentityName' is not a valid package name" }
if ($Publisher -notmatch '^CN=') { throw "Publisher '$Publisher' is not a distinguished name (CN=...)" }

# MakeAppx, MakePri and SignTool: the newest Windows SDK on this machine.
function Find-SdkTool([string] $name) {
  $kits = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  $tool = Get-ChildItem $kits -Directory -Filter "10.*" -ErrorAction SilentlyContinue |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "x64\$name" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if (-not $tool) { throw "$name not found under $kits (install the Windows SDK)" }
  return $tool
}
$makeappx = Find-SdkTool "makeappx.exe"
$makepri = Find-SdkTool "makepri.exe"
Write-Host "Windows SDK: $(Split-Path $makeappx)"

$out = New-Item -ItemType Directory -Force $OutDir
$layout = Join-Path $out "msix-layout"
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory $layout | Out-Null

Copy-Item $Exe (Join-Path $layout "Arcalo.exe")
Copy-Item -Recurse (Join-Path $here "Assets") (Join-Path $layout "Assets")

# The manifest with the identity (XML-escaped: a publisher name may contain '&' or quotes).
function Escape-Xml([string] $s) { [System.Security.SecurityElement]::Escape($s) }
$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path $here "AppxManifest.xml")
$manifest = $manifest.Replace("{{IDENTITY_NAME}}", (Escape-Xml $IdentityName)).
  Replace("{{PUBLISHER}}", (Escape-Xml $Publisher)).
  Replace("{{PUBLISHER_DISPLAY_NAME}}", (Escape-Xml $PublisherDisplayName)).
  Replace("{{VERSION}}", "$Version.0")
if ($manifest -match '\{\{[A-Z_]+\}\}') { throw "Placeholder left in the manifest: $($Matches[0])" }
$manifestPath = Join-Path $layout "AppxManifest.xml"
[System.IO.File]::WriteAllText($manifestPath, $manifest, [System.Text.UTF8Encoding]::new($false))
[xml](Get-Content -Raw $manifestPath) | Out-Null  # well-formed

# Every asset the manifest names has its scale variants.
$names = [regex]::Matches($manifest, 'Assets\\([A-Za-z0-9]+)\.png') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($n in $names) {
  if (-not (Get-ChildItem (Join-Path $layout "Assets") -Filter "$n.scale-*.png")) { throw "No scale variants of Assets\$n.png" }
}

# resources.pri: resolves Assets\Square44x44Logo.png to the file for the scale or icon size.
$priconfig = Join-Path $out "priconfig.xml"
& $makepri createconfig /cf $priconfig /dq en-US_de-DE /pv 10.0.0 /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "MakePri createconfig failed ($LASTEXITCODE)" }
& $makepri new /pr $layout /cf $priconfig /mn $manifestPath /of (Join-Path $layout "resources.pri") /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "MakePri new failed ($LASTEXITCODE)" }

$msix = Join-Path $out "Arcalo_${Version}_x64.msix"
& $makeappx pack /d $layout /p $msix /o /h SHA256 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed ($LASTEXITCODE)" }

if ($CertificatePfx) {
  $signtool = Find-SdkTool "signtool.exe"
  & $signtool sign /fd SHA256 /f $CertificatePfx /p $CertificatePassword $msix | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed ($LASTEXITCODE)" }
}

Write-Host "Packed $msix ($([math]::Round((Get-Item $msix).Length / 1MB, 1)) MB)"
if ($env:GITHUB_OUTPUT) { "msix=$msix" | Out-File -Append -Encoding utf8 $env:GITHUB_OUTPUT }
