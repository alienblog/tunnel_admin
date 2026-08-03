/**
 * TunnelAdmin 桌面端 preload：向渲染进程暴露最小桥（contextIsolation 下）
 * - taDownloadDone：主进程在浏览器下载完成后通知保存路径
 * - showItemInFolder：定位文件（传输管理器「📂 定位」按钮）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('taDesktop', {
  isDesktop: true,
  onDownloadDone: (cb) => {
    const listener = (_e, info) => cb(info);
    ipcRenderer.on('ta:download-done', listener);
    return () => ipcRenderer.removeListener('ta:download-done', listener);
  },
  showItemInFolder: (p) => ipcRenderer.send('ta:show-item', p),
});
