# ============================================================
# TunnelAdmin Windows 桌面版一键打包脚本
# 用法（管理员运行最佳，解决符号链接解压权限）：
#   powershell -ExecutionPolicy Bypass -File scripts\build-win.ps1
# 或直接双击 scripts\build-win.bat
#
# 参数：
#   -Proxy http://127.0.0.1:7897   指定代理（国内网络下载依赖/工具）
#   -SkipInstall                   跳过 npm ci（依赖已就绪时加速）
# 产物：release\TunnelAdmin-<version>-x64.exe（安装器）+ .zip（便携）
# ============================================================
param(
  [string]$Proxy = '',
  [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# ---- 代理检测：显式参数 > 环境变量 > 探测本地 7897 ----
if ($Proxy -eq '' -and $env:HTTPS_PROXY) { $Proxy = $env:HTTPS_PROXY }
if ($Proxy -eq '') {
  try {
    $t = Test-NetConnection -ComputerName 127.0.0.1 -Port 7897 -WarningAction SilentlyContinue
    if ($t.TcpTestSucceeded) { $Proxy = 'http://127.0.0.1:7897' }
  } catch { }
}
if ($Proxy -ne '') {
  Write-Step "使用代理: $Proxy"
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
  $env:NPM_CONFIG_PROXY = $Proxy
  $env:NPM_CONFIG_HTTPS_PROXY = $Proxy
}

# ---- 1. Node 环境（优先系统 node，否则便携 node 到 C:\tools） ----
Write-Step "1/5 检查 Node.js 环境"
$nodeBin = $null
try { $nodeBin = (Get-Command node.exe -ErrorAction Stop).Source } catch { }
if (-not $nodeBin) {
  $portable = 'C:\tools\node-v22.23.2-win-x64\node.exe'
  if (-not (Test-Path $portable)) {
    Write-Step "下载便携 Node.js v22.23.2（约 35MB）..."
    $zip = "$env:TEMP\node-v22.23.2-win-x64.zip"
    Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath 'C:\tools' -Force
    Remove-Item $zip -ErrorAction SilentlyContinue
  }
  $nodeBin = $portable
}
$nodeDir = Split-Path -Parent $nodeBin
$env:Path = "$nodeDir;$env:Path"
$env:npm_config_script_shell = 'cmd'   # 忽略项目 .npmrc 的 WSL script-shell
node -v
npm -v

# ---- 2. 安装依赖 ----
if (-not $SkipInstall) {
  Write-Step "2/5 npm ci（安装全部依赖，含 Electron 下载）"
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
} else {
  Write-Step "2/5 跳过 npm ci（-SkipInstall）"
}

# ---- 3. 构建 server + web ----
Write-Step "3/5 构建 server + web"
npm run build
if ($LASTEXITCODE -ne 0) { throw '构建失败' }

# ---- 4. better-sqlite3 重编译为 Electron ABI ----
Write-Step "4/5 better-sqlite3 -> Electron ABI"
$electronVer = (Get-Content node_modules\electron\package.json | ConvertFrom-Json).version
npx electron-rebuild -f -w better-sqlite3 --electron-version $electronVer
if ($LASTEXITCODE -ne 0) { throw 'electron-rebuild 失败' }

# ---- 5. 打包 ----
Write-Step "5/5 electron-builder（NSIS 安装器 + 便携 zip）"
npx electron-builder --win nsis zip
if ($LASTEXITCODE -ne 0) {
  $msg = $Error[0].Exception.Message
  if ($msg -match 'symbolic link|符号链接') {
    Write-Host "`n检测到符号链接权限问题：请【以管理员身份】重新运行本脚本，" -ForegroundColor Yellow
    Write-Host "或在 Windows 设置中开启「开发者模式」（允许创建符号链接）。" -ForegroundColor Yellow
  }
  throw '打包失败'
}

Write-Host "`n================ 构建完成 ================" -ForegroundColor Green
Get-ChildItem release\TunnelAdmin-*.exe, release\TunnelAdmin-*.zip | ForEach-Object { Write-Host "  $($_.Name)  $([math]::Round($_.Length/1MB)) MB" -ForegroundColor Green }
Write-Host "=========================================="
