@echo off
setlocal

REM Lifecycle entry point for the pinned CAS Gate 0A emulator.
REM This is simulation-only and never targets a physical device.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0pixel-emulator.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo Pixel emulator action failed. Review the validation result in emulator-results.
)

exit /b %EXIT_CODE%