/**
 * TunnelAdmin 桌面客户端（Electron 主进程）：
 * - 单实例锁
 * - 启动 server 子进程（打包目录内 server/dist/index.js，ELECTRON_RUN_AS_NODE）
 * - 数据目录指向 Electron userData（~/.config/tunneladmin）
 * - 加载 http://127.0.0.1:<port>，关闭时结束 server 子进程
 */
const { app, BrowserWindow, dialog, ipcMain, shell, session } = require('electron');
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
    // 剪贴板权限：右键复制/粘贴（navigator.clipboard.readText/writeText）需要
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });
    // ---- 下载管理器：预fs（userData/download-prefs.json）+ IPC ----------------
    // 下载模式：ask（每次下载前选目录，批量 5 秒窗口只问一次）/ default（直接下到默认目录）
    const prefsPath = () => path.join(app.getPath('userData'), 'download-prefs.json');
    let downloadPrefs = { mode: 'ask', dir: '' };
    try {
      downloadPrefs = { mode: 'ask', dir: '', ...JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) };
    } catch {
      // 首次运行无预fs
    }
    const savePrefs = () => {
      try {
        fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
        fs.writeFileSync(prefsPath(), JSON.stringify(downloadPrefs));
      } catch (err) {
        console.error('保存下载预fs失败:', err);
      }
    };
    ipcMain.handle('ta:get-download-prefs', () => ({ ...downloadPrefs }));
    ipcMain.handle('ta:set-download-prefs', (_e, p) => {
      downloadPrefs = { mode: p?.mode === 'default' ? 'default' : 'ask', dir: typeof p?.dir === 'string' ? p.dir : '' };
      savePrefs();
      return { ...downloadPrefs };
    });
    ipcMain.handle('ta:choose-download-dir', async () => {
      const r = await dialog.showOpenDialog({ title: '选择默认下载目录', properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    });

    // 下载：模式决策（ask 弹窗选择目录，5 秒窗口内批量下载只询问一次）
    let pendingDir = { dir: '', ts: 0 };
    const decideDir = async () => {
      const now = Date.now();
      // default 模式：直接下到默认目录（不经过询问/复用窗口）
      if (downloadPrefs.mode !== 'ask') return downloadPrefs.dir || app.getPath('downloads');
      // ask 模式：5 秒窗口内批量下载只询问一次
      if (pendingDir.dir && now - pendingDir.ts < 5000) return pendingDir.dir;
      const r = await dialog.showOpenDialog({ title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled) return null;
      pendingDir = { dir: r.filePaths[0], ts: now };
      return pendingDir.dir;
    };

    // 下载完成 → 通知渲染进程保存路径（传输管理器「📂 定位」按钮用）
    session.defaultSession.on('will-download', (_e, item) => {
      const name = item.getFilename();
      void decideDir().then((dir) => {
        if (!dir) {
          item.cancel();
          return;
        }
        item.setSavePath(path.join(dir, name));
      });
      item.once('done', (_ev, state) => {
        if (state !== 'completed') return;
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send('ta:download-done', { name, path: item.getSavePath() });
        }
      });
    });
    ipcMain.on('ta:show-item', (_e, p) => {
      if (typeof p === 'string' && p) shell.showItemInFolder(p);
    });

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
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
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
