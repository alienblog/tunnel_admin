/** 下载预fs：mode = ask（每次下载前询问，批量只问一次）/ default（直接下到默认目录） */
export interface DownloadPrefs {
  mode: 'ask' | 'default';
  dir: string;
}

/** Electron 桌面端桥（preload 注入 window.taDesktop）；Web 浏览器环境为 null */
export interface TaDesktop {
  isDesktop: boolean;
  /** 订阅下载完成事件（返回取消函数）；info.name = 文件名，info.path = 保存路径 */
  onDownloadDone: (cb: (info: { name: string; path: string }) => void) => () => void;
  /** 打开文件所在文件夹并定位（showItemInFolder） */
  showItemInFolder: (p: string) => void;
  /** 读取下载预fs（模式 + 默认目录） */
  getDownloadPrefs: () => Promise<DownloadPrefs>;
  /** 保存下载预fs（返回保存后的值） */
  setDownloadPrefs: (p: Partial<DownloadPrefs>) => Promise<DownloadPrefs>;
  /** 弹出系统目录选择框；取消返回 null */
  chooseDownloadDir: () => Promise<string | null>;
}

export function getDesktop(): TaDesktop | null {
  return (window as unknown as { taDesktop?: TaDesktop }).taDesktop ?? null;
}
