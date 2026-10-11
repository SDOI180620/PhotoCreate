@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 24 或更新版本。
  pause
  exit /b 1
)
if "%~1"=="" (
  echo 請先關閉 PhotoCreate，再將完整備份 ZIP 拖曳到這個檔案以還原。
  echo 原本的資料會保留在旁邊的資料夾。
  pause
  exit /b 1
)
node --env-file-if-exists=.env.local scripts/restore-backup.mjs "%~1"
pause
