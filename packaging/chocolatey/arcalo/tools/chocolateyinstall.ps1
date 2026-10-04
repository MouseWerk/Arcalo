$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/MouseWerk/Arcalo/releases/download/v1.11.0/Arcalo_1.11.0_x64-setup.exe'
  checksum64     = 'e30fe0d4f6727556a0f97ebc5628b012ce203c3e57ea8d2ae14bb4fc1abb12df'
  checksumType64 = 'sha256'
  softwareName   = 'Arcalo*'
  silentArgs     = '/S'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
