@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  This folder is the SOURCE CODE and needs Node.js.
  echo.
  echo  If you just want to use the tool, download the zip file here instead:
  echo    https://github.com/LeierStudio/poe-build-pricer/releases/latest
  echo.
  pause
  exit /b 1
)
node server.js
pause
