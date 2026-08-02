/**
 * TunnelAdmin 桌面客户端（Electron 主进程）：
 * - 单实例锁
 * - 启动 server 子进程（打包目录内 server/dist/index.js，ELECTRON_RUN_AS_NODE）
 * - 数据目录指向 Electron userData（~/.config/tunneladmin）
 * - 加载 http://127.0.0.1:<port>，关闭时结束 server 子进程
 */
const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { launchServer } = require('./server-launch');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let serverChild = null;
  let serverPort = 8080;

  // server 入口：开发时用源码 dist；打包后位于 app.asar.unpacked/server/dist
  function resolveServerEntry() {
    const candidates = [
      path.join(__dirname, '..', 'server', 'dist', 'index.js'),
      path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'dist', 'index.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    throw new Error(`找不到 server 入口（尝试: ${candidates.join(', ')}）`);
  }

  async function startServer() {
    const entry = resolveServerEntry();
    const dataDir = path.join(app.getPath('userData'), 'data');
    const { child, port } = await launchServer({
      serverEntry: entry,
      dataDir,
      nodeExec: process.execPath,
      port: 8080,
    });
    serverChild = child;
    serverPort = port;
    return port;
  }

  function stopServer() {
    if (serverChild && serverChild.exitCode === null) {
      serverChild.kill();
    }
    serverChild = null;
  }

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    let port;
    try {
      port = await startServer();
    } catch (err) {
      dialog.showErrorBox('TunnelAdmin 启动失败', String((err && err.message) || err));
      app.quit();
      return;
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      title: 'TunnelAdmin',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadURL(`http://127.0.0.1:${port}`);
    // MCP endpoint 提示（端口非 8080 时告知）
    if (port !== 8080) {
      win.webContents.once('did-finish-load', () => {
        win.setTitle(`TunnelAdmin（MCP 端口 ${port}，默认 8080 被占用）`);
      });
    }
  });

  app.on('window-all-closed', () => {
    stopServer();
    app.quit();
  });

  app.on('before-quit', stopServer);
  app.on('will-quit', stopServer);
}
