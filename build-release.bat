@echo off
setlocal
echo Starting Production Build Sequence...

REM 1. Clean previous builds
echo Cleaning...
if exist release rmdir /s /q release
if exist backend\dist rmdir /s /q backend\dist
if exist frontend\dist rmdir /s /q frontend\dist

REM 2. Build Frontend
echo Building Frontend...
cd frontend
call npm install
call npm run build
cd ..

REM 3. Build Backend
echo Building Backend...
cd backend
call npm install
call npm run build
call npm prune --production
cd ..

REM 4. Build Electron Main Process
echo Compiling Electron...
call npm run build:electron

REM 5. Package Application
echo Packaging for Windows...
call .\node_modules\.bin\electron-builder

echo Build Complete! Check the 'release' directory.
endlocal
