@echo off
echo Starting Solvent AI Desktop Suite...

REM Generate session secret using Node.js (cross-platform alternative to openssl)
for /f "delims=" %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set BACKEND_INTERNAL_SECRET=%%i
echo Session Secret Generated

REM Start Backend
echo Starting Backend...
start /b cmd /c "cd backend && npx cross-env NODE_ENV=development npx tsx src/server.ts > ..\backend.log 2>&1"

REM Start Frontend
echo Starting Frontend...
start /b cmd /c "cd frontend && npm run dev > ..\frontend.log 2>&1"

REM Wait for services
echo Waiting for services to spin up (12s)...
timeout /t 12 /nobreak > nul

REM Build Electron
echo Building Desktop App...
call npm run build:electron

REM Launch Electron
echo Launching Desktop UI...
.\node_modules\.bin\electron electron\main.js

echo Shutting down...
taskkill /f /im node.exe > nul 2>&1
