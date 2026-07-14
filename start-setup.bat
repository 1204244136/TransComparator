@echo off
setlocal

cd /d "%~dp0"

set "PORT=4317"
set "URL=http://127.0.0.1:%PORT%/"
set "NPM_CMD="

if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM_CMD if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPM_CMD for %%I in (npm.cmd) do set "NPM_CMD=%%~$PATH:I"

if not defined NPM_CMD (
  echo Could not find npm.cmd. Please install Node.js and run npm install first.
  pause
  exit /b 1
)

echo Starting TransComparator setup server...
echo %URL%

timeout /t 2 /nobreak >nul
start "" "%URL%"

set "TRANSCOMPARATOR_SETUP_PORT=%PORT%"
call "%NPM_CMD%" run setup
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo TransComparator setup server exited with code %EXIT_CODE%.
) else (
  echo TransComparator setup server stopped.
)
echo Review the output above, then press any key to close this window.
pause >nul

endlocal & exit /b %EXIT_CODE%
