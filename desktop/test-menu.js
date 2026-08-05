/* 验证 Electron 默认菜单 vs 自定义菜单对 Ctrl+C 的拦截（终端收不到按键 = TUI 无法中断） */
const { app, BrowserWindow, Menu } = require('electron');

const MODE = process.argv[2] || 'default'; // default | custom

app.whenReady().then(async () => {
  if (MODE === 'custom') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        { role: 'fileMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
  }
  // default 模式：不设置 → Electron 默认菜单（含 Edit Ctrl+C/V）

  const win = new BrowserWindow({ width: 400, height: 300, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        '<html><body><script>window.__keys=[];document.addEventListener("keydown",e=>{window.__keys.push(e.key+"("+(e.ctrlKey?"ctrl":"")+")")});document.body.innerHTML="<h1>ready</h1>";document.body.focus();</script></body></html>',
      ),
  );
  await new Promise((r) => setTimeout(r, 800));
  win.webContents.focus();

  const send = (key, mods) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
    win.webContents.sendInputEvent({ type: 'char', keyCode: key, modifiers: mods });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
  };
  send('C', ['control']); // Ctrl+C
  send('V', ['control']); // Ctrl+V
  await new Promise((r) => setTimeout(r, 600));

  const got = await win.webContents.executeJavaScript('JSON.stringify(window.__keys)');
  const ctrlC = got.includes('c(ctrl)') || got.includes('C(ctrl)');
  const ctrlV = got.includes('v(ctrl)') || got.includes('V(ctrl)');
  console.log(`MODE=${MODE} 页面收到 Ctrl+C: ${ctrlC}  Ctrl+V: ${ctrlV}  原始: ${got}`);
  app.exit(0);
});
