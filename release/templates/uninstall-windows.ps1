# DCODE Windows uninstaller: remove LOCALAPPDATA install, PATH entry, and Start Menu shortcut.
param()

$ErrorActionPreference = 'Stop'

$installRoot = Join-Path $env:LOCALAPPDATA 'DCODE'
$binDir = Join-Path $installRoot 'bin'

# 从用户 PATH 中移除 bin 目录（兼容末尾分号与大小写差异）。
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$normalizedBin = $binDir.TrimEnd('\').ToLowerInvariant()
$parts = $userPath -split ';' | Where-Object {
  $p = $_.Trim()
  if (-not $p) { return $false }
  return $p.TrimEnd('\').ToLowerInvariant() -ne $normalizedBin
}
$newPath = ($parts -join ';').TrimEnd(';')
if ($newPath -ne $userPath.TrimEnd(';')) {
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "Removed from PATH: $binDir"
} else {
  Write-Host "PATH does not contain: $binDir"
}

# 删除开始菜单快捷方式。
$startMenu = [Environment]::GetFolderPath('Programs')
$shortcutPath = Join-Path $startMenu 'DCODE.lnk'
if (Test-Path $shortcutPath) {
  Remove-Item -Force $shortcutPath
  Write-Host "Removed shortcut: $shortcutPath"
} else {
  Write-Host "Shortcut not found: $shortcutPath"
}

# 删除安装目录（含 dist、bin、LICENSE 等）。
if (Test-Path $installRoot) {
  Remove-Item -Recurse -Force $installRoot
  Write-Host "Removed: $installRoot"
} else {
  Write-Host "Install directory not found: $installRoot"
}

Write-Host ""
Write-Host "DCODE uninstalled. Restart terminal to refresh PATH."
Write-Host "Note: ~/.dcode (config and sessions) was NOT removed."
