@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
call npm ls --depth=0 >nul 2>nul
if errorlevel 1 (
  echo Installing or updating project dependencies.
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
node --env-file-if-exists=.env.local scripts/stop-existing-studio.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo PhotoCreate Studio: http://0.0.0.0:8764
echo Open in browser: http://127.0.0.1:8764
echo Manage studio: http://127.0.0.1:8764/admin
echo Keep this window open while using the studio.
echo.
call npm start
pause
