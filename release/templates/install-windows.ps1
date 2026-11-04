# DCODE Windows installer: copy release files to LOCALAPPDATA and register dcode command.
# Producer: Moriarty_Dox
param(
  [Parameter(Mandatory = $true)]
  [string]$SourceDir
)

$ErrorActionPreference = 'Stop'

# Normalize path: trim quotes and trailing slashes from cmd.exe argument passing
$SourceDir = $SourceDir.Trim().Trim('"').TrimEnd('\', '/')

if (-not (Test-Path (Join-Path $SourceDir 'dist\cli.js'))) {
  Write-Error "dist\cli.js not found under: $SourceDir"
}

# Source checkouts carry package.json; portable releases carry VERSION.txt instead.
$packageSrc = Join-Path $SourceDir 'package.json'
$versionSrc = Join-Path $SourceDir 'VERSION.txt'
$version = $null
if (Test-Path -LiteralPath $packageSrc -PathType Leaf) {
  $version = (Get-Content -LiteralPath $packageSrc -Raw -Encoding UTF8 | ConvertFrom-Json).version
} elseif (Test-Path -LiteralPath $versionSrc -PathType Leaf) {
  $versionText = Get-Content -LiteralPath $versionSrc -Raw -Encoding UTF8
  if ($versionText -match '(?m)^DCODE v(\S+)\s*$') {
    $version = $Matches[1]
  }
}
if ($version -isnot [string] -or [string]::IsNullOrWhiteSpace($version)) {
  Write-Error "Source version not found in package.json or VERSION.txt under: $SourceDir"
}

$installRoot = Join-Path $env:LOCALAPPDATA 'DCODE'
$binDir = Join-Path $installRoot 'bin'
$distDir = Join-Path $installRoot 'dist'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

Copy-Item -Force (Join-Path $SourceDir 'dist\cli.js') (Join-Path $distDir 'cli.js')

$assetsSrc = Join-Path $SourceDir 'dist\assets'
if (Test-Path -LiteralPath $assetsSrc -PathType Container) {
  Copy-Item -LiteralPath $assetsSrc -Destination $distDir -Recurse -Force
}

$packageJson = [ordered]@{
  name = 'dcode'
  version = $version
  type = 'module'
} | ConvertTo-Json
# PowerShell 5.1's UTF8 encoding adds a BOM, which updater's JSON.parse cannot read.
[System.IO.File]::WriteAllText((Join-Path $installRoot 'package.json'), $packageJson, [System.Text.UTF8Encoding]::new($false))

$licenseSrc = Join-Path $SourceDir 'LICENSE'
if (Test-Path $licenseSrc) {
  Copy-Item -Force $licenseSrc (Join-Path $installRoot 'LICENSE')
}

$readmeSrc = Join-Path $SourceDir '安装说明.txt'
if (Test-Path $readmeSrc) {
  Copy-Item -Force $readmeSrc (Join-Path $installRoot '安装说明.txt')
}

$distCli = Join-Path $distDir 'cli.js'
$cmdPath = Join-Path $binDir 'dcode.cmd'
Set-Content -Path $cmdPath -Value "@echo off`r`nnode `"$distCli`" %*" -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
if ($userPath -notlike "*$binDir*") {
  $newPath = if ($userPath.TrimEnd(';')) { "$userPath;$binDir" } else { $binDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "Added to PATH: $binDir"
} else {
  Write-Host "PATH already contains: $binDir"
}

$shell = New-Object -ComObject WScript.Shell
$startMenu = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $startMenu 'DCODE.lnk'
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'cmd.exe'
$shortcut.Arguments = "/k cd /d `"$env:USERPROFILE\Desktop`" && dcode"
$shortcut.WorkingDirectory = $env:USERPROFILE
$shortcut.Description = 'DCODE - DeepSeek AI coding assistant'
$shortcut.Save()

Write-Host "Installed to: $installRoot"
Write-Host "Start menu shortcut: $shortcutPath"
