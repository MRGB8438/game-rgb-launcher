@echo off
chcp 65001 >nul
title Game RGB Launcher - Installer Builder
color 0A

echo ============================================
echo    Game RGB Launcher - Setup Builder
echo ============================================
echo.

:: Check Node.js
echo [1/4] Checking Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo ERROR: Node.js is not installed!
    echo Install from: https://nodejs.org
    pause
    exit /b 1
)
echo OK!

:: Clean
echo.
echo [2/4] Cleaning old files...
if exist dist rmdir /s /q dist 2>nul
echo Done!

:: Install if needed
echo.
echo [3/4] Checking dependencies...
if not exist node_modules (
    echo Installing (5-10 minutes)...
    call npm install
    if %errorlevel% neq 0 (
        color 0C
        echo ERROR: npm install failed!
        pause
        exit /b 1
    )
) else (
    echo Already installed!
)

:: Build installer
echo.
echo [4/4] Building Setup.exe (5-15 minutes)...
call npx electron-builder --win nsis
if %errorlevel% neq 0 (
    color 0C
    echo.
    echo ERROR: Build failed!
    pause
    exit /b 1
)

:: Done
echo.
color 0A
echo ============================================
echo  SUCCESS! Setup file is ready!
echo ============================================
echo.
echo Location: dist folder
echo.
if exist "dist\GameRGBLauncher Setup 1.0.0.exe" (
    echo File: GameRGBLauncher Setup 1.0.0.exe
    for %%I in ("dist\GameRGBLauncher Setup 1.0.0.exe") do echo Size: %%~zI bytes
) else (
    echo Files in dist:
    dir dist\*.exe /b 2>nul
)
echo.
echo Opening dist folder...
explorer "dist"
echo.
pause
