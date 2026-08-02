#!/bin/bash
# GitHub Releases 发布脚本（需 gh CLI + 认证：gh auth login）
# 用法：bash scripts/release.sh v0.1.0
set -e
TAG="$1"
if [ -z "$TAG" ]; then echo "用法: $0 <tag>（如 v0.1.0）"; exit 1; fi
if ! command -v gh >/dev/null 2>&1; then echo "未安装 gh：https://cli.github.com/ 或 Windows: winget install GitHub.cli"; exit 1; fi

RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)/release"
FILES=()
for f in release/tunneladmin-server-linux-x64.tar.gz release/TunnelAdmin-${TAG#v}-x64.exe release/TunnelAdmin-${TAG#v}-x64.zip release/tunneladmin-server-windows-x64.zip; do
  [ -f "$f" ] && FILES+=("$f")
done

gh release create "$TAG" "${FILES[@]}" \
  --title "TunnelAdmin $TAG" \
  --notes "## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Linux | tunneladmin-server-linux-x64.tar.gz | server 部署包（node 运行，./start.sh） |
| Windows | tunneladmin-server-windows-x64.zip | server（start.bat） |
| Windows | TunnelAdmin-${TAG#v}-x64.exe | 桌面客户端（NSIS 安装器） |
| Windows | TunnelAdmin-${TAG#v}-x64.zip | 桌面客户端（便携版） |

纯 Vibe Coding 项目（Oh My Pi + DeepSeek V4 Flash，总花费 \$2）。
"
echo "已发布：https://github.com/alienblog/tunnel_admin/releases/tag/$TAG"
