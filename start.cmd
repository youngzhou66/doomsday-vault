@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==========================================================
echo   Doomsday Vault  -  Local Movie Library
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo         Install Node.js 20+ from https://nodejs.org/
  echo         Then close this window and double-click start.cmd again.
  echo.
  pause
  exit /b 1
)

if not exist "server\index.mjs" (
  echo [ERROR] File not found: server\index.mjs
  echo         Run start.cmd from the project root folder
  echo         ^(the folder containing package.json, server and web^).
  echo.
  pause
  exit /b 1
)

echo Starting... your browser will open automatically.
echo Close this window to stop the service.
echo.

node server\index.mjs --open
set EXITCODE=%errorlevel%

echo.
if not "%EXITCODE%"=="0" (
  echo [ERROR] Startup failed ^(exit code %EXITCODE%^).
  echo         Run "npm run doctor" in the project folder for a diagnosis.
) else (
  echo Service stopped.
)
echo.
pause
