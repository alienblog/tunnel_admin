/** 下载预fs：mode = ask（每次下载前询问，批量只问一次）/ default（直接下到默认目录） */
export interface DownloadPrefs {
  mode: 'ask' | 'default';
  dir: string;
}

/** 流式直写下载启动结果（桌面端） */
export interface DesktopDownloadStart {
  ok: boolean;
  /** 用户取消目录选择（ask 模式弹框点了取消） */
  canceled?: boolean;
  /** 下载会话令牌（后续数据块/结束/取消用） */
  token?: string;
  /** 实际保存路径（重名自动追加 (1) (2)） */
  path?: string;
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
  /** 流式直写下载：开始下载（内部按 prefs 决定目录，ask 模式此时弹框询问） */
  downloadStart: (name: string) => Promise<DesktopDownloadStart>;
  /** 写入一块数据（Uint8Array）到已启动的下载流 */
  downloadData: (token: string, data: Uint8Array) => Promise<void>;
  /** 结束下载（写完文件，触发 onDownloadDone 通知） */
  downloadEnd: (token: string) => Promise<void>;
  /** 取消下载并删除半成品文件 */
  downloadCancel: (token: string) => Promise<void>;
  /** 窗口标题（显示活动主机名；空串回退默认标题） */
  setTitle: (title: string) => void;
  /** 系统通知 + 窗口闪烁（审批请求/命令完成等） */
  notify: (opts: { title: string; body: string }) => void;
  /** 任务栏进度条：0..1 进度；null 清除 */
  setProgress: (value: number | null) => void;
}

export function getDesktop(): TaDesktop | null {
  return (window as unknown as { taDesktop?: TaDesktop }).taDesktop ?? null;
}
