/**
 * 桌面版 server 启动器（纯 Node，可独立测试）：
 * 扫描空闲端口 → spawn server 子进程（ELECTRON_RUN_AS_NODE）→ 等待就绪。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

/** 探测端口是否可连接 */
function probePort(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/me', timeout }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 尝试在 8080 起扫描可用端口（8080 起 + 20 个） */
async function findFreePort(start = 8080) {
  for (let p = start; p < start + 20; p++) {
    if (!(await probePort(p))) return p;
  }
  return start + 20;
}

/**
 * 启动 server 子进程。
 * @param {object} opts
 * @param {string} opts.serverEntry server 入口 JS 路径
 * @param {string} opts.dataDir 数据目录（userData）
 * @param {string} opts.nodeExec electron 二进制（ELECTRON_RUN_AS_NODE）
 * @param {number} opts.port 期望端口（实际可能扫描偏移）
 */
async function launchServer({ serverEntry, dataDir, nodeExec, port = 8080 }) {
  const actualPort = await findFreePort(port);
  const child = spawn(nodeExec, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      TUNNELADMIN_PORT: String(actualPort),
      TUNNELADMIN_DATA_DIR: dataDir,
      // 桌面客户端免 Web 登录（本地单用户）；MCP 仍走 token 鉴权
      TUNNELADMIN_AUTH: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // 等待就绪（最长 30s）
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server 子进程退出（code ${child.exitCode}）`);
    }
    if (await probePort(actualPort)) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('server 启动超时');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { child, port: actualPort };
}

module.exports = { launchServer, probePort, findFreePort };
