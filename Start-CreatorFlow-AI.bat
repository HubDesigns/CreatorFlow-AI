@echo off
cd /d "%~dp0"

powershell -NoProfile -Command "if (Test-NetConnection 127.0.0.1 -Port 3456 -InformationLevel Quiet) { exit 1 } else { exit 0 }"

if errorlevel 1 (
    echo CreatorFlow AI is already running.
    start "" "http://localhost:3456"
    exit /b
)

echo Starting CreatorFlow AI...
start "CreatorFlow AI Server" cmd /k "cd /d ""%~dp0"" && npm.cmd start"

echo Waiting for dashboard...
timeout /t 8 /nobreak >nul
start "" "http://localhost:3456"
