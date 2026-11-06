@echo off
rem ============================================================
rem  Game RGB Launcher - Windows build (mirror fallback)
rem  Fixes electron-builder error: "read ECONNRESET"
rem  (GitHub downloads unreachable - common on Iranian networks)
rem
rem  Usage: double-click this file, or run from cmd:
rem     build-windows.bat
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo [1/3] Setting reliable download mirrors (npmmirror)...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo [2/3] Installing dependencies (skipped if already installed)...
if not exist "node_modules\electron-builder" (
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :fail
)

echo [3/3] Building Windows installer (NSIS)...
call npx electron-builder --win nsis
if errorlevel 1 (
    echo.
    echo First attempt failed - retrying once...
    call npx electron-builder --win nsis
    if errorlevel 1 goto :fail
)

echo.
echo ============================================================
echo   BUILD OK  -^>  dist\GameRGBLauncher.*.exe
echo.
echo   To publish a release with auto-update support, upload
echo   ALL of these to the GitHub release page:
echo     dist\GameRGBLauncher.*.exe
echo     dist\GameRGBLauncher.*.exe.blockmap
echo     dist\latest.yml
echo ============================================================
goto :eof

:fail
echo.
echo BUILD FAILED.
echo  - Just run this file again (it retries automatically)
echo  - Or connect to a VPN / fix your internet, then retry
echo.
pause
exit /b 1
