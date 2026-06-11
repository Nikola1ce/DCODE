@echo off
REM DCODE 命令行启动器：在终端中调用，或将安装目录加入 PATH 后使用 dcode 命令。
chcp 65001 >nul

call "%~dp0dcode-locate.bat"
if errorlevel 1 (
  echo [DCODE] 找不到 dist\cli.js，请使用完整 Release 包或先 npm run build。
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo [DCODE] 未检测到 Node.js，请从 https://nodejs.org 安装后重试。
  exit /b 1
)

node "%DCODE_CLI%" %*
