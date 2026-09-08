@echo off
REM AI Cursor — start local SearXNG (Docker) or hidden Node compat fallback
setlocal
cd /d "%~dp0"
set "PORT=8888"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /I "%%A"=="SEARXNG_PORT" set "PORT=%%B"

where docker >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [WebSearch] docker compose up -d
  docker compose up -d
  if errorlevel 1 goto :fallback
  echo [WebSearch] http://127.0.0.1:%PORT%/  ^(docker SearXNG^)
  exit /b 0
)

wsl -e bash -lc "command -v docker >/dev/null 2>&1" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [WebSearch] docker compose via WSL
  for /f "delims=" %%P in ('wsl wslpath -a "%CD%"') do set "WSLDIR=%%P"
  wsl -e bash -lc "cd \"%WSLDIR%\" && docker compose up -d"
  if errorlevel 1 goto :fallback
  echo [WebSearch] http://127.0.0.1:%PORT%/  ^(docker SearXNG via WSL^)
  exit /b 0
)

:fallback
echo [WebSearch] Docker unavailable — starting hidden Node compat server
set "NODE="
if exist "%~dp0..\Release\runtime\node\node.exe" set "NODE=%~dp0..\Release\runtime\node\node.exe"
if exist "%~dp0..\runtime\node\node.exe" set "NODE=%~dp0..\runtime\node\node.exe"
if not defined NODE where node >nul 2>&1 && set "NODE=node"
if not defined NODE (
  echo [WebSearch] No Node runtime found.
  exit /b 1
)
set SEARXNG_PORT=%PORT%
echo %PORT%> "%~dp0.compat.port"
powershell -NoProfile -WindowStyle Hidden -Command ^
  "$p = Start-Process -FilePath '%NODE%' -ArgumentList '%~dp0server.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden -PassThru; Set-Content -Path '%~dp0.compat.pid' -Value $p.Id -Encoding ASCII"
echo [WebSearch] http://127.0.0.1:%PORT%/search  ^(compat, no console^)
exit /b 0
