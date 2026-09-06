@echo off
REM AI Cursor - compile by o0 - build into o0\Release
setlocal
cd /d "%~dp0"
set "PS1="
for %%F in ("%~dp0*.ps1") do set "PS1=%%~fF"
if not defined PS1 (
  echo [compile by o0] missing *.ps1 next to this cmd
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set EXITCODE=%ERRORLEVEL%
if %EXITCODE% neq 0 (
  echo.
  echo [compile by o0] failed with exit code %EXITCODE%
  pause
  exit /b %EXITCODE%
)
echo.
pause
exit /b 0