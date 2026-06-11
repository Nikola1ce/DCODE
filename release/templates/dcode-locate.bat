@echo off
REM DCODE path resolver - sets DCODE_HOME and DCODE_CLI for sibling bat scripts.
REM DCODE_HOME has NO trailing backslash to avoid cmd quote-escape bugs.

set "DCODE_HOME="
set "DCODE_CLI="

if exist "%~dp0dist\cli.js" goto loc_self
if exist "%~dp0..\..\dist\cli.js" goto loc_repo
if exist "%LOCALAPPDATA%\DCODE\dist\cli.js" goto loc_installed
goto loc_scan_out

:loc_scan_out
for /d %%D in ("%~dp0..\out\DCODE-v*") do if exist "%%D\dist\cli.js" pushd "%%D" & goto loc_set
exit /b 1

:loc_self
pushd "%~dp0"
goto loc_set

:loc_repo
pushd "%~dp0..\.."
goto loc_set

:loc_installed
set "DCODE_HOME=%LOCALAPPDATA%\DCODE"
set "DCODE_CLI=%LOCALAPPDATA%\DCODE\dist\cli.js"
exit /b 0

:loc_set
set "DCODE_HOME=%CD%"
set "DCODE_CLI=%CD%\dist\cli.js"
popd
exit /b 0
