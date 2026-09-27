@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mvp-install.ps1"
set "CAS_EXIT=%ERRORLEVEL%"
popd
exit /b %CAS_EXIT%
