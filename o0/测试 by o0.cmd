@echo off
REM AI Cursor - test by o0 - no console (delegates to VBS)
setlocal
cd /d "%~dp0"
for %%F in ("%~dp0*by o0.vbs") do (
  wscript //nologo "%%~fF"
  exit /b 0
)
echo [test by o0] missing *by o0.vbs
pause
exit /b 1