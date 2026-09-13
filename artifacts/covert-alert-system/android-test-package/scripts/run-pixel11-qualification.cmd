@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pixel11-gate0a.ps1" -Action qualification
set "CAS_EXIT=%ERRORLEVEL%"
popd
exit /b %CAS_EXIT%
