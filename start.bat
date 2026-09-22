@echo off
title NAS Shorts
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] Node.js not found. Please install from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting NAS Shorts ...  ^( http://localhost:8080 ^)
echo.
start "" http://localhost:8080
node server.js
pause
