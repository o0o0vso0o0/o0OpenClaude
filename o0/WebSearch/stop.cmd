@echo off
REM AI Cursor — stop local SearXNG / hidden compat server
setlocal
cd /d "%~dp0"

where docker >nul 2>&1
if %ERRORLEVEL%==0 docker compose down >nul 2>&1

wsl -e bash -lc "command -v docker >/dev/null 2>&1" >nul 2>&1
if %ERRORLEVEL%==0 (
  for /f "delims=" %%P in ('wsl wslpath -a "%CD%"') do set "WSLDIR=%%P"
  wsl -e bash -lc "cd \"%WSLDIR%\" && docker compose down" >nul 2>&1
)

if exist ".compat.pid" (
  set /p PID=<.compat.pid
  if defined PID taskkill /PID %PID% /F /T >nul 2>&1
  del /q "%~dp0.compat.pid" 2>nul
)

set "PORT=8888"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /I "%%A"=="SEARXNG_PORT" set "PORT=%%B"
if exist ".compat.port" set /p PORT=<.compat.port
powershell -NoProfile -WindowStyle Hidden -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
del /q "%~dp0.compat.port" 2>nul
echo [WebSearch] stopped
exit /b 0
