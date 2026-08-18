/**
 * TunnelAdmin 桌面客户端（Electron 主进程）：
 * - 单实例锁
 * - 启动画面（splash）→ 启动 server 子进程（ELECTRON_RUN_AS_NODE）→ 主窗口
 * - 数据目录指向 Electron userData（~/.config/tunneladmin）
 * - server 仅监听 127.0.0.1（免登录模式下防局域网免密访问）
 * - server 崩溃自动重启（指数退避，连续 5 次失败提示）+ 日志落盘 userData/logs/server.log
 * - 系统通知（审批/命令完成）+ 窗口闪烁、任务栏传输进度、窗口状态持久化、动态标题
 */
const { app, BrowserWindow, dialog, ipcMain, shell, session, Menu, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { launchServer } = require('./server-launch');

const APP_ID = 'com.tunneladmin.desktop';

/** 启动画面（server 就绪前显示，避免无反馈等待） */
const SPLASH_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1e1e1e;display:flex;flex-direction:column;
    align-items:center;justify-content:center;font-family:"Segoe UI",system-ui,sans-serif;color:#cccccc;user-select:none}
  .logo{font-size:20px;font-weight:600;letter-spacing:.5px}
  .logo span{color:#007acc}
  .spinner{width:22px;height:22px;margin-top:16px;border:2px solid #3c3c3c;border-top-color:#007acc;
    border-radius:50%;animation:spin .9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .hint{margin-top:10px;font-size:11px;color:#6a6a6a}
</style></head><body>
  <div class="logo">Tunnel<span>Admin</span></div>
  <div class="spinner"></div>
  <div class="hint">正在启动内置服务…</div>
</body></html>`;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let serverChild = null;
  let serverPort = 8080;
  let stopping = false;
  let restartAttempt = 0;
  let logStream = null;
  let mainWin = null;
  let splash = null;
  let winStateTimer = null;

  /** server 子进程日志落盘（滚动：启动时 >5MB 归档 .old） */
  function openLogStream() {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, 'server.log');
      try {
        if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, logPath + '.old');
      } catch {
        // 无历史日志
      }
      logStream = fs.createWriteStream(logPath, { flags: 'a' });
    } catch (err) {
      console.error('打开日志文件失败:', err);
    }
  }
  const log = (msg) => {
    console.log(`[main] ${msg}`);
    try {
      logStream?.write(`[main] ${msg}\n`);
    } catch {
      // 忽略
    }
  };

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
    // 子进程输出同时落盘（server-launch 已转发到主进程 stdout/stderr，此处再挂一份）
    child.stdout?.on('data', (d) => {
      try {
        logStream?.write(d);
      } catch {
        // 忽略
      }
    });
    child.stderr?.on('data', (d) => {
      try {
        logStream?.write(d);
      } catch {
        // 忽略
      }
    });
    // 崩溃自愈：非主动退出时指数退避重启（1s→2s→…→30s 封顶，连续 5 次失败停止并提示）
    child.on('exit', (code, signal) => {
      serverChild = null;
      if (stopping) return;
      restartAttempt += 1;
      log(`server 进程退出（code=${code}, signal=${signal}），第 ${restartAttempt} 次尝试重启`);
      try {
        if (Notification.isSupported()) {
          new Notification({ title: 'TunnelAdmin 服务异常', body: '内置服务已退出，正在自动重启…' }).show();
        }
      } catch {
        // 通知失败不影响重启
      }
      if (restartAttempt >= 5) {
        dialog.showErrorBox('TunnelAdmin 服务异常', `内置服务连续重启失败（${restartAttempt} 次）。请关闭应用后重新打开。`);
        return;
      }
      const delay = Math.min(1000 * 2 ** (restartAttempt - 1), 30000);
      setTimeout(() => {
        void startServer()
          .then(() => {
            restartAttempt = 0;
            log(`server 重启成功（端口 ${serverPort}）`);
            if (mainWin && !mainWin.isDestroyed()) {
              // 端口漂移（重启后端口变化）时重新加载页面；端口不变则前端 ws 自动重连恢复
              const current = mainWin.webContents.getURL();
              const want = `http://127.0.0.1:${serverPort}`;
              if (!current.startsWith(want)) mainWin.loadURL(want);
            }
          })
          .catch((err) => {
            log(`server 重启失败: ${err.message}`);
          });
      }, delay);
    });
    return port;
  }

  function stopServer() {
    stopping = true;
    if (serverChild && serverChild.exitCode === null) {
      serverChild.kill();
    }
    serverChild = null;
  }

  // ---- 窗口状态持久化（位置/尺寸/最大化）----
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
  function loadWinState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.w) && Number.isFinite(s.h)) {
        return s;
      }
    } catch {
      // 无历史状态
    }
    return {};
  }
  function saveWinState() {
    if (!mainWin || mainWin.isDestroyed()) return;
    try {
      const bounds = mainWin.getNormalBounds();
      fs.writeFileSync(
        stateFile(),
        JSON.stringify({ x: bounds.x, y: bounds.y, w: bounds.width, h: bounds.height, maximized: mainWin.isMaximized() }),
      );
    } catch {
      // 忽略
    }
  }
  function scheduleSaveWinState() {
    if (winStateTimer) clearTimeout(winStateTimer);
    winStateTimer = setTimeout(saveWinState, 500);
  }

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // Windows 系统通知需要 AppUserModelId（与安装快捷方式一致，否则 Notification 不显示）
    app.setAppUserModelId(APP_ID);
    openLogStream();

    // 自定义菜单：不包含 Edit 菜单（复制/粘贴加速键 Ctrl+C/V/X/A 会在页面之前拦截按键，
    // 导致终端收不到 Ctrl+C，TUI 程序（omp 等）无法中断）。表单/终端的复制粘贴由
    // Chromium 默认编辑行为与 xterm.js 自行处理，无需菜单加速键。
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { role: 'fileMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );

    // 剪贴板权限：右键复制/粘贴（navigator.clipboard.readText/writeText）需要
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });

    // ---- 启动画面（server 就绪前显示）----
    splash = new BrowserWindow({
      width: 360,
      height: 220,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      center: true,
      backgroundColor: '#1e1e1e',
      webPreferences: { sandbox: true },
    });
    splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(SPLASH_HTML));
    splash.once('ready-to-show', () => splash.show());

    // ---- IPC：动态标题 / 系统通知+闪烁 / 任务栏进度 ----
    ipcMain.on('ta:set-title', (_e, title) => {
      if (!mainWin || mainWin.isDestroyed()) return;
      const base = title ? `${title} - TunnelAdmin` : 'TunnelAdmin';
      // MCP endpoint 提示（端口非 8080 时告知）
      const suffix = serverPort !== 8080 ? `（MCP 端口 ${serverPort}，默认 8080 被占用）` : '';
      mainWin.setTitle(base + suffix);
    });
    ipcMain.on('ta:notify', (_e, opts) => {
      const { title = 'TunnelAdmin', body = '' } = opts ?? {};
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      } catch {
        // 通知失败忽略
      }
      // 窗口闪烁提醒（macOS 无效但无害；获得焦点后停止）
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.flashFrame(true);
        setTimeout(() => {
          if (mainWin && !mainWin.isDestroyed()) mainWin.flashFrame(false);
        }, 10000);
      }
    });
    ipcMain.on('ta:progress', (_e, value) => {
      if (!mainWin || mainWin.isDestroyed()) return;
      // value: 0..1 进度；null 清除
      mainWin.setProgressBar(value === null ? -1 : Math.max(0, Math.min(1, value)));
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
      // 合并语义：未传的字段保留原值（如「选择默认目录」只传 dir，mode 不被重置）
      downloadPrefs = {
        mode: p?.mode === undefined ? downloadPrefs.mode : (p.mode === 'default' ? 'default' : 'ask'),
        dir: typeof p?.dir === 'string' ? p.dir : downloadPrefs.dir,
      };
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

    // ---- 流式直写下载（桌面端主路径）----
    // 渲染进程 fetch 分块 → IPC → 本地文件直写（不经浏览器下载/Blob 全量内存）。
    // 目录在下载开始前决定（ask 弹框 / default 直下），重名自动追加 (1) (2)。
    let dlSeq = 0;
    const dlStreams = new Map(); // token → { stream, path, name }
    ipcMain.handle('ta:download-start', async (_e, name) => {
      const dir = await decideDir();
      if (!dir) return { ok: false, canceled: true };
      const base = path.basename(String(name || 'download'));
      let finalPath = path.join(dir, base);
      if (fs.existsSync(finalPath)) {
        const dot = base.lastIndexOf('.');
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : '';
        for (let i = 1; ; i++) {
          const cand = path.join(dir, `${stem} (${i})${ext}`);
          if (!fs.existsSync(cand)) {
            finalPath = cand;
            break;
          }
        }
      }
      const token = `dl-${Date.now()}-${dlSeq++}`;
      dlStreams.set(token, { stream: fs.createWriteStream(finalPath), path: finalPath, name: base });
      return { ok: true, token, path: finalPath };
    });
    ipcMain.handle('ta:download-data', (_e, token, data) => {
      const rec = dlStreams.get(token);
      if (!rec) return;
      rec.stream.write(Buffer.from(data));
    });
    ipcMain.handle('ta:download-end', (_e, token) => {
      const rec = dlStreams.get(token);
      if (!rec) return;
      dlStreams.delete(token);
      rec.stream.end();
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send('ta:download-done', { name: rec.name, path: rec.path });
      }
    });
    ipcMain.handle('ta:download-cancel', (_e, token) => {
      const rec = dlStreams.get(token);
      if (!rec) return;
      dlStreams.delete(token);
      try {
        rec.stream.destroy();
      } catch {
        // 已关闭
      }
      fs.unlink(rec.path, () => {});
    });

    // ---- 启动 server ----
    let port;
    try {
      port = await startServer();
    } catch (err) {
      if (splash && !splash.isDestroyed()) splash.close();
      dialog.showErrorBox('TunnelAdmin 启动失败', String((err && err.message) || err));
      app.quit();
      return;
    }

    const winState = loadWinState();
    mainWin = new BrowserWindow({
      width: winState.w ?? 1280,
      height: winState.h ?? 800,
      x: winState.x,
      y: winState.y,
      minWidth: 900,
      minHeight: 600,
      title: 'TunnelAdmin',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      show: false, // ready-to-show 后显示（splash 已覆盖等待期，避免白屏）
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'preload.js'),
        // 窗口最小化/失焦时保持渲染（xterm 的 rAF 不被节流，TUI 恢复不冻结）
        backgroundThrottling: false,
      },
    });
    if (winState.maximized) mainWin.maximize();
    mainWin.once('ready-to-show', () => {
      if (splash && !splash.isDestroyed()) {
        splash.close();
        splash = null;
      }
      mainWin.show();
    });
    // 窗口状态持久化（防抖）
    mainWin.on('resize', scheduleSaveWinState);
    mainWin.on('move', scheduleSaveWinState);
    mainWin.on('close', saveWinState);
    // 窗口获得焦点时停止闪烁
    mainWin.on('focus', () => mainWin.flashFrame(false));
    // 外部链接交给系统浏览器（插件页面/意外 window.open 等）
    mainWin.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWin.loadURL(`http://127.0.0.1:${port}`);
  });

  app.on('window-all-closed', () => {
    stopServer();
    app.quit();
  });

  app.on('before-quit', stopServer);
  app.on('will-quit', stopServer);
}
