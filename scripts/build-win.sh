#!/bin/bash
# WSL2 侧驱动 Windows 便携 node 构建桌面版
set -e
# 执行体用 WSL 路径（interop 启动）；脚本参数用 Windows 路径（node 直接解析）
NODE="/mnt/c/tools/node-v22.23.2-win-x64/node.exe"
NPM="C:/tools/node-v22.23.2-win-x64/node_modules/npm/bin/npm-cli.js"
cd /mnt/c/tunneladmin-build

echo "[1/4] npm ci"
"$NODE" "$NPM" ci

echo "[2/4] npm run build"
"$NODE" "$NPM" run build

echo "[3/4] electron-rebuild (better-sqlite3 -> Electron ABI)"
"$NODE" node_modules/electron-rebuild/lib/cli.js -f -w better-sqlite3

echo "[4/4] electron-builder --win nsis zip"
"$NODE" node_modules/electron-builder/out/cli/cli.js --win nsis zip

echo "BUILD_DONE"
ls -la release/ 2>/dev/null | head -10
