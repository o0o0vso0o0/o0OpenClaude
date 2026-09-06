@echo off
REM AI Cursor - run GUI locally after npm run build (no TUI)
setlocal
cd /d "%~dp0"
if not exist "dist\index.html" (
  echo Building UI...
  call npm.cmd run build
)
set OPENCLAUDE_GUI_OPEN=1
set OPENCLAUDE_GUI_DATA=%~dp0..\.cache\o0Data
if not exist "%~dp0..\.cache" mkdir "%~dp0..\.cache"
if not exist "%OPENCLAUDE_GUI_DATA%" mkdir "%OPENCLAUDE_GUI_DATA%"
echo OpenClaude GUI -> http://127.0.0.1:3920
echo Data: %OPENCLAUDE_GUI_DATA%
node server\server.mjs
