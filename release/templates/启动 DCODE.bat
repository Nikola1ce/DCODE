@echo off
REM DCODE portable launcher for Windows - double-click to run.
chcp 65001 >nul
setlocal EnableDelayedExpansion

call "%~dp0dcode-locate.bat"
if errorlevel 1 goto no_cli

where node >nul 2>&1
if errorlevel 1 goto no_node

set "WORKDIR="
if exist "%~dp0工作目录.txt" for /f "usebackq delims=" %%L in ("%~dp0工作目录.txt") do set "WORKDIR=%%L"

if not defined WORKDIR (
  echo.
  echo Enter project folder path, or press Enter for Desktop:
  set /p WORKDIR=
  if not defined WORKDIR set "WORKDIR=%USERPROFILE%\Desktop"
  echo !WORKDIR!> "%~dp0工作目录.txt"
)

if not exist "!WORKDIR!" goto bad_workdir

cd /d "!WORKDIR!"
echo.
echo [DCODE] CWD: !CD!
echo [DCODE] CLI: !DCODE_CLI!
echo.
node "!DCODE_CLI!" %*
if "%~1"=="" pause
endlocal
exit /b 0

:no_cli
echo.
echo [DCODE] dist\cli.js not found. Use Release ZIP or npm run build.
echo.
pause
exit /b 1

:no_node
echo.
echo [DCODE] Node.js required: https://nodejs.org
start "" "https://nodejs.org/"
pause
exit /b 1

:bad_workdir
echo.
echo [DCODE] Workdir missing: !WORKDIR!
echo Edit 工作目录.txt in this folder.
echo.
pause
exit /b 1
