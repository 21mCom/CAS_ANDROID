@echo off
setlocal

REM Double-click entry point for the CAS Pixel Gate 0A Windows preflight.
REM This launches the read-only check with the physical-device target.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-preflight.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Preflight passed. Attach the JSON and Markdown files shown above.
) else if "%EXIT_CODE%"=="1" (
  echo Preflight completed with warnings. Resolve or document them before the field run.
) else (
  echo Preflight is blocked. Do not continue to the Gate 0A run until the blocking checks pass.
)
echo.
pause
exit /b %EXIT_CODE%