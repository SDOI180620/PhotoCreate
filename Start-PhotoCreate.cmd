@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
node --input-type=module -e "try { const response = await fetch('http://127.0.0.1:8764/api/health', { signal: AbortSignal.timeout(1000) }); const data = await response.json(); process.exit(data.app === 'PhotoCreate' ? 0 : 1); } catch { process.exit(1); }" >nul 2>nul
if not errorlevel 1 (
  start "" "http://127.0.0.1:8764"
  exit /b 0
)
if not exist "node_modules\express" (
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
echo.
echo PhotoCreate Studio: http://0.0.0.0:8764
echo Open in browser: http://127.0.0.1:8764
echo Keep this window open while using the studio.
echo.
call npm start
pause
