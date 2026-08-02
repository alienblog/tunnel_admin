# TunnelAdmin Windows 桌面版构建脚本（在 Windows 侧执行，无需 wine）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# 便携 node（免安装）：C:\tools\node-v22.23.2-win-x64
$NodeDir = 'C:\tools\node-v22.23.2-win-x64'
if (Test-Path "$NodeDir\node.exe") {
  $env:Path = "$NodeDir;" + $env:Path
} else {
  throw "找不到便携 node：$NodeDir（请先下载 node-v22.23.2-win-x64.zip 并解压）"
}

Write-Host '[1/4] npm ci（安装全部依赖）'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }

Write-Host '[2/4] 构建 server + web'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'build 失败' }

Write-Host '[3/4] better-sqlite3 重编译为 Electron ABI'
npx electron-rebuild -f -w better-sqlite3
if ($LASTEXITCODE -ne 0) { throw 'electron-rebuild 失败' }

Write-Host '[4/4] electron-builder 打包（nsis 安装器 + zip 便携版）'
npx electron-builder --win nsis zip
if ($LASTEXITCODE -ne 0) { throw 'electron-builder 失败' }

Write-Host '构建完成：release/ 目录下的 TunnelAdmin-*.exe / *.zip'
