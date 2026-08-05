#!/bin/bash
# 构建 Linux server 发布包（tar.gz，node 运行）
# 用法: bash scripts/build-release.sh   → 产物 release/tunneladmin-server-linux-x64.tar.gz
# 本地与 GitHub Actions (ubuntu runner) 通用
set -e
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.."

echo "== 构建 web + server =="
npm run build

echo "== 组装 Linux server 包 =="
rm -rf /tmp/ta-release && mkdir -p /tmp/ta-release/server/dist /tmp/ta-release/web/dist
cp package-lock.json /tmp/ta-release/
cat > /tmp/ta-release/package.json <<'EOF'
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
EOF
cp -r server/dist/. /tmp/ta-release/server/dist/
cp -r web/dist/. /tmp/ta-release/web/dist/
cat > /tmp/ta-release/start.sh <<'EOF'
#!/bin/sh
cd "$(dirname "$0")"
# 崩溃自动重启：正常退出（exit 0，如 Ctrl+C/SIGTERM）不重启；异常退出（崩溃）2 秒后拉起
while true; do
  node server/dist/index.js
  code=$?
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  echo "[tunneladmin] server exited ($code), restarting in 2s..."
  sleep 2
done
EOF
cat > /tmp/ta-release/start.bat <<'EOF'
@echo off
cd /d %~dp0
:loop
node server\dist\index.js
if %errorlevel%==0 exit /b 0
echo [tunneladmin] server exited (%errorlevel%), restarting in 2s...
timeout /t 2 /nobreak >nul
goto loop
EOF
cat > /tmp/ta-release/README.txt <<'EOF'
TunnelAdmin Server
启动: ./start.sh （Windows: start.bat）
端口: 8080（PORT 环境变量可改）
数据: 首次启动生成 data/ 目录（master.key / password.hash，初始密码在启动日志）
免登录: TUNNELADMIN_AUTH=none 环境变量
EOF
chmod +x /tmp/ta-release/start.sh

echo "== 安装生产依赖 =="
(cd /tmp/ta-release && npm ci --omit=dev >/dev/null 2>&1)

echo "== 验证启动 =="
mkdir -p release
nohup env TUNNELADMIN_PORT=18111 TUNNELADMIN_DATA_DIR=/tmp/ta-reltest node /tmp/ta-release/server/dist/index.js > /tmp/ta-rel.log 2>&1 &
sleep 4
CODE_API="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18111/api/me || true)"
CODE_WEB="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18111/ || true)"
pkill -f "dist/index.js" || true
rm -rf /tmp/ta-reltest
if [ "$CODE_API" != "200" ] || [ "$CODE_WEB" != "200" ]; then
  echo "启动验证失败 api=$CODE_API web=$CODE_WEB"; tail -5 /tmp/ta-rel.log; exit 1
fi
echo "启动验证通过 api=$CODE_API web=$CODE_WEB"

tar czf release/tunneladmin-server-linux-x64.tar.gz -C /tmp/ta-release .
rm -rf /tmp/ta-release
echo "完成: release/tunneladmin-server-linux-x64.tar.gz ($(du -h release/tunneladmin-server-linux-x64.tar.gz | cut -f1))"
