#!/bin/bash
echo "============================================"
echo "  Game RGB Launcher - Build Script"
echo "============================================"
echo ""

echo "[1/4] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed!"
    echo "Please install from https://nodejs.org"
    exit 1
fi
echo "Node.js found!"

echo ""
echo "[2/4] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: npm install failed!"
    exit 1
fi

echo ""
echo "[3/4] Building Windows installer..."
npm run build
if [ $? -ne 0 ]; then
    echo "ERROR: Build failed!"
    exit 1
fi

echo ""
echo "[4/4] Done!"
echo ""
echo "Your installer is in the 'release' folder."
echo ""
