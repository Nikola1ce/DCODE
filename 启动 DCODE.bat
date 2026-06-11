@echo off
REM DCODE launcher at repo root - requires npm run build first.
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

if exist "dist\cli.js" set "DCODE_CLI=%~dp0dist\cli.js" & goto run
for /d %%D in ("release\out\DCODE-v*") do if exist "%%D\dist\cli.js" set "DCODE_CLI=%%D\dist\cli.js" & goto run

echo.
echo [DCODE] dist\cli.js not found. Run: npm run build
echo.
pause
exit /b 1

:run
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

cd /d "!WORKDIR!"
echo [DCODE] CWD: !CD!
node "!DCODE_CLI!" %*
if "%~1"=="" pause
endlocal
exit /b 0

:no_node
echo [DCODE] Install Node.js: https://nodejs.org
start "" "https://nodejs.org/"
pause
exit /b 1
