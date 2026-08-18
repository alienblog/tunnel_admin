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
  getDownloadPrefs: () => ipcRenderer.invoke('ta:get-download-prefs'),
  setDownloadPrefs: (p) => ipcRenderer.invoke('ta:set-download-prefs', p),
  chooseDownloadDir: () => ipcRenderer.invoke('ta:choose-download-dir'),
  /** 流式直写下载：开始（决定目录，下载前询问）/ 数据块 / 结束 / 取消 */
  downloadStart: (name) => ipcRenderer.invoke('ta:download-start', name),
  downloadData: (token, data) => ipcRenderer.invoke('ta:download-data', token, data),
  downloadEnd: (token) => ipcRenderer.invoke('ta:download-end', token),
  downloadCancel: (token) => ipcRenderer.invoke('ta:download-cancel', token),
  /** 窗口标题（显示活动主机名；空串回退默认标题） */
  setTitle: (title) => ipcRenderer.send('ta:set-title', title),
  /** 系统通知 + 窗口闪烁（审批请求/命令完成等） */
  notify: (opts) => ipcRenderer.send('ta:notify', opts),
  /** 任务栏进度条：0..1 进度；null 清除 */
  setProgress: (value) => ipcRenderer.send('ta:progress', value),
});
