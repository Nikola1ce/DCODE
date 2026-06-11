@echo off
REM Install DCODE to LOCALAPPDATA and add dcode to user PATH.
chcp 65001 >nul

call "%~dp0dcode-locate.bat"
if errorlevel 1 goto locate_fail

where node >nul 2>&1
if errorlevel 1 goto need_node

echo.
echo Installing DCODE...
echo Source: %DCODE_HOME%
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" -SourceDir "%DCODE_HOME%"
if errorlevel 1 goto install_fail

echo.
echo Done. Restart terminal and run: dcode
echo Or search DCODE in Start Menu.
echo.
pause
exit /b 0

:locate_fail
echo.
echo [DCODE] dist\cli.js not found.
echo.
echo Option 1: Download DCODE-vX-portable.zip from Releases and extract
echo Option 2: Run npm run package, open release\out\DCODE-vX\
echo Option 3: Run npm run build, double-click 启动 DCODE.bat in repo root
echo.
pause
exit /b 1

:need_node
echo [DCODE] Install Node.js from https://nodejs.org
start "" "https://nodejs.org/"
pause
exit /b 1

:install_fail
echo Install failed.
pause
exit /b 1
