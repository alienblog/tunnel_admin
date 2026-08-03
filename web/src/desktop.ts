/** Electron 桌面端桥（preload 注入 window.taDesktop）；Web 浏览器环境为 null */
export interface TaDesktop {
  isDesktop: boolean;
  /** 订阅下载完成事件（返回取消函数）；info.name = 文件名，info.path = 保存路径 */
  onDownloadDone: (cb: (info: { name: string; path: string }) => void) => () => void;
  /** 打开文件所在文件夹并定位（showItemInFolder） */
  showItemInFolder: (p: string) => void;
}

export function getDesktop(): TaDesktop | null {
  return (window as unknown as { taDesktop?: TaDesktop }).taDesktop ?? null;
}
