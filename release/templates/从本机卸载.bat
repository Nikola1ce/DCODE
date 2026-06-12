@echo off
REM Uninstall DCODE from LOCALAPPDATA and remove dcode from user PATH.
chcp 65001 >nul

echo.
echo Uninstalling DCODE from this PC...
echo This removes %%LOCALAPPDATA%%\DCODE and the Start Menu shortcut.
echo User config in %%USERPROFILE%%\.dcode is kept.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-windows.ps1"
if errorlevel 1 goto uninstall_fail

echo.
echo Done. Restart terminal if you had dcode in PATH.
echo.
pause
exit /b 0

:uninstall_fail
echo Uninstall failed.
pause
exit /b 1
