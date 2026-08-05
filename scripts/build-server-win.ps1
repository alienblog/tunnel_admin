# ============================================================
# TunnelAdmin Windows Server 发布包构建（zip，node 运行）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\build-server-win.ps1
# 产物：release\tunneladmin-server-windows-x64.zip
# ============================================================
param([string]$Proxy = '')
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# ---- 代理 ----
if ($Proxy -eq '' -and $env:HTTPS_PROXY) { $Proxy = $env:HTTPS_PROXY }
if ($Proxy -ne '') {
  Write-Host "使用代理: $Proxy"
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
  $env:NPM_CONFIG_PROXY = $Proxy
  $env:NPM_CONFIG_HTTPS_PROXY = $Proxy
}

# ---- Node 环境（与 build-win.ps1 相同逻辑） ----
$nodeBin = $null
try { $nodeBin = (Get-Command node.exe -ErrorAction Stop).Source } catch { }
if (-not $nodeBin) {
  $portable = 'C:\tools\node-v22.23.2-win-x64\node.exe'
  if (-not (Test-Path $portable)) { throw '未找到 node.exe（请先运行 build-win.ps1 或安装 Node.js）' }
  $nodeBin = $portable
}
$env:Path = "$(Split-Path -Parent $nodeBin);$env:Path"
$env:npm_config_script_shell = 'cmd'

# ---- 组装临时目录 ----
$pkg = Join-Path $PSScriptRoot '..\server-pkg'
Remove-Item $pkg -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$pkg\server\dist" -Force | Out-Null
New-Item -ItemType Directory -Path "$pkg\web\dist" -Force | Out-Null

Write-Host '复制 server/dist 与 web/dist...'
Copy-Item 'server\dist\*' "$pkg\server\dist\" -Recurse -Force
Copy-Item 'web\dist\*' "$pkg\web\dist\" -Recurse -Force

@'
{
  "name": "tunneladmin-server",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@fastify/static": "^10.1.2",
    "@fastify/websocket": "^11.0.0",
    "@modelcontextprotocol/sdk": "^1.18.0",
    "adm-zip": "^0.5.18",
    "better-sqlite3": "^12.2.0",
    "fastify": "^5.2.0",
    "ssh2": "^1.16.0",
    "zod": "^4.4.3"
  }
}
'@ | Set-Content "$pkg\package.json" -Encoding UTF8
Copy-Item 'package-lock.json' "$pkg\package-lock.json"

@'
@echo off
cd /d %~dp0
node server\dist\index.js
'@ | Set-Content "$pkg\start.bat" -Encoding UTF8
@'
TunnelAdmin Server 0.1.0 (Windows)
启动: start.bat
端口: 8080（set PORT=xxxx 可改）
数据: 首次启动生成 data\ 目录（master.key / password.hash，初始密码在启动日志）
免登录: set TUNNELADMIN_AUTH=none
'@ | Set-Content "$pkg\README.txt" -Encoding UTF8

# ---- 安装生产依赖（Windows 原生 better-sqlite3） ----
Write-Host 'npm ci --omit=dev（Windows 原生依赖）...'
Push-Location $pkg
npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm ci 失败' }
Pop-Location

# ---- 打包 zip ----
Write-Host '打包 zip...'
$zip = Join-Path $PSScriptRoot '..\release\tunneladmin-server-windows-x64.zip'
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$pkg\*" -DestinationPath $zip -Force
Remove-Item $pkg -Recurse -Force

Write-Host "完成：$zip  $([math]::Round((Get-Item $zip).Length/1MB)) MB"
