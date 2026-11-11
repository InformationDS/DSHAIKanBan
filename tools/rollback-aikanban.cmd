@echo off
setlocal
rem One-click AIKanBan rollback: restore the newest complete profile backup.
rem Close DeepSeek Harness first. Works even if the app will not boot.
set "ROOT=%~dp0.."
set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

echo AIKanBan rollback: newest backup -> desktop profile
echo.
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | findstr /I "DeepSeek" >nul
if not errorlevel 1 (
  echo WARNING: DeepSeek Harness is running.
  echo Close it completely, then double-click this file again.
  pause
  exit /b 2
)

"%NODE%" "%ROOT%\tools\install-to-profile.mjs" --restore-latest
if errorlevel 1 (
  echo.
  echo ROLLBACK FAILED. See the output above.
  pause
  exit /b 1
)

echo.
echo Rollback completed. Restart DeepSeek Harness.
pause
