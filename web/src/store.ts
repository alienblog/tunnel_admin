import { create } from 'zustand';
import { api, type ApprovalInfo, type Host } from './api';
import type { SessionInfo } from './ws';

export type View = 'terminals' | 'hosts' | 'sftp' | 'forward' | 'plugin:manage' | `plugin:${string}`;

/** 插件信息（服务端 /api/plugins 返回） */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 图标 SVG path d（16×16，跟随 currentColor；可空=宿主拼图） */
  icon?: string;
  source: 'installed' | 'dev';
  dir: string;
  enabled: boolean;
  error?: string;
  ui: Array<{ id: string; label: string; entry: string }>;
  activation: 'onStartup' | 'onUiOpen';
}

/** 管理页视图 id */
export const PLUGIN_MANAGE_VIEW = 'plugin:manage' as const;

/**
 * 外层 tab（VSCode 编辑器组模型的外层）：
 * - host：主机工作区（含内层布局树）
 * - editor：文件编辑器（双击文件打开）
 * - settings / transfer / audit：单例工具页
 */
export type OuterTab =
  | { kind: 'host'; id: string; hostId: string; label?: string }
  | { kind: 'editor'; id: string; hostId: string; hostName: string; path: string; name: string }
  | { kind: 'settings'; id: 'settings' }
  | { kind: 'transfer'; id: 'transfer' }
  | { kind: 'audit'; id: 'audit' }
  | { kind: 'plugin'; id: string; pluginId: string }
  | { kind: 'plugins-manage'; id: 'plugins-manage' };

/** 传输记录（上传/下载，供传输管理器展示） */
export interface TransferRec {
  id: number;
  direction: 'up' | 'down';
  name: string;
  path: string;
  hostName: string;
  size: number;
  transferred: number;
  status: 'running' | 'done' | 'error';
  error?: string;
  /** 桌面端浏览器下载的本地保存路径（供「定位文件」） */
  localPath?: string;
  /** 完成时间戳（用于计算平均速度） */
  doneAt?: number;
  ts: number;
}

export interface TerminalTab {
  id: string;
  kind: 'web' | 'agent';
  hostId: number;
  hostName: string;
  /** agent 会话 tab 的目标 MCP 会话 */
  sessionId: string | null;
  streamId: string | null;
  status: 'connecting' | 'connected' | 'closed' | 'error';
  /** agent 会话已结束：只读视图（可查看，不可输入） */
  ended?: boolean;
  /** 后台命令完成的未读状态（点击 tab 清除） */
  notify?: 'success' | 'warning' | 'error';
  error?: string;
  /** 插件动态连接令牌（ctx.ssh.requestConnect 产生，一次性；存在时 open 走 connectToken） */
  connectToken?: string;
}

/**
 * 双层工作区（VSCode 编辑器组模型）：
 * - group = 终端组（含多个终端 tab + 加号，组内切换不分屏）
 * - split = 分屏（分割的是组，嵌套任意深度）
 * 每主机一棵布局树。
 */
export type LayoutNode =
  | { type: 'group'; id: string; tabIds: string[]; activeTabId: string | null }
  | { type: 'split'; id: string; dir: 'h' | 'v'; ratio: number; children: LayoutNode[] };

export type DropPos = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface Toast {
  id: number;
  hostName: string;
  kind: 'success' | 'warning' | 'error';
  text: string;
}

/** 终端视口矩形（像素，相对主机工作区容器） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 布局树 → 每个终端 tab 的视口矩形（group 的 tab 栏占顶部 32px；split 按 ratio 递归切分） */
export function computeLeafRects(node: LayoutNode | null, bounds: Rect): Map<string, Rect> {
  const map = new Map<string, Rect>();
  if (!node) return map;
  if (node.type === 'group') {
    const content: Rect = { ...bounds, y: bounds.y + 32, h: Math.max(0, bounds.h - 32) };
    if (node.activeTabId) map.set(node.activeTabId, content);
    return map;
  }
  const [a, b] = node.children;
  const aRect: Rect =
    node.dir === 'h' ? { ...bounds, w: bounds.w * node.ratio } : { ...bounds, h: bounds.h * node.ratio };
  const bRect: Rect =
    node.dir === 'h'
      ? { ...bounds, x: bounds.x + aRect.w, w: bounds.w - aRect.w }
      : { ...bounds, y: bounds.y + aRect.h, h: bounds.h - aRect.h };
  for (const [id, r] of computeLeafRects(a, aRect)) map.set(id, r);
  for (const [id, r] of computeLeafRects(b, bRect)) map.set(id, r);
  return map;
}

/** 布局树 → 每个 group 面板的拖拽停靠区域矩形（整个面板含 tab 栏，拖到 tab 栏同样生效） */
export function computeGroupRects(node: LayoutNode | null, bounds: Rect): Map<string, Rect> {
  const map = new Map<string, Rect>();
  if (!node) return map;
  if (node.type === 'group') {
    map.set(node.id, { ...bounds });
    return map;
  }
  const [a, b] = node.children;
  const aRect: Rect =
    node.dir === 'h' ? { ...bounds, w: bounds.w * node.ratio } : { ...bounds, h: bounds.h * node.ratio };
  const bRect: Rect =
    node.dir === 'h'
      ? { ...bounds, x: bounds.x + aRect.w, w: bounds.w - aRect.w }
      : { ...bounds, y: bounds.y + aRect.h, h: bounds.h - aRect.h };
  for (const [id, r] of computeGroupRects(a, aRect)) map.set(id, r);
  for (const [id, r] of computeGroupRects(b, bRect)) map.set(id, r);
  return map;
}

export interface SftpState {
  /** 上次使用的 SFTP 主机（跨挂载记忆，避免重挂时误判主机切换） */
  hostId: string;
  /** 当前浏览根路径（树根） */
  path: string;
  /** 选中的目录/文件（高亮） */
  selectedPath: string | null;
  /** 待定位路径（终端 pwd 或右键跳转触发，SideBar 消费后清空） */
  revealPath: string | null;
}

/** SFTP 剪贴板：复制/剪切待粘贴项（跨视图保留） */
export interface SftpClipboard {
  action: 'copy' | 'cut';
  path: string;
  name: string;
  type: 'dir' | 'file';
}

export interface SftpCacheEntry {
  items: import('./api').SftpItem[];
  ts: number;
}

export interface HostModalState {
  open: boolean;
  editing: Host | null;
}

export interface HostMetrics {
  ts: number;
  cores: number;
  load: number[];
  cpu: number | null;
  mem: { total: number; used: number };
  disks: Array<{ mount: string; total: number; used: number }>;
  net: { rxRate: number; txRate: number; interfaces: Array<{ name: string; rx: number; tx: number }> };
}

/** 关闭确认：终端仍有活动连接（连接中/已连接）时二次确认 */
export function confirmCloseTab(tab: TerminalTab): boolean {
  if (tab.status === 'connected' || tab.status === 'connecting') {
    return window.confirm(`终端「${tab.hostName}」仍处于连接状态，确认关闭？关闭后将断开连接。`);
  }
  return true;
}

/** 关闭确认：主机仍有活动终端连接时二次确认 */
export function confirmCloseHost(hostId: string): boolean {
  const tabs = useStore.getState().tabs;
  const active = tabs.filter(
    (t) => t.hostId === Number(hostId) && (t.status === 'connected' || t.status === 'connecting'),
  );
  if (active.length > 0) {
    return window.confirm(`该主机有 ${active.length} 个活动终端连接，关闭将全部断开，确认？`);
  }
  return true;
}

// ---- 布局树工具（纯函数，不可变操作） ----

let groupSeq = 0;
let splitSeq = 0;

export function makeSplit(dir: 'h' | 'v', a: LayoutNode, b: LayoutNode): LayoutNode {
  return { type: 'split', id: `spl-${Date.now()}-${splitSeq++}`, dir, ratio: 0.5, children: [a, b] };
}

export function makeGroup(tabId: string): LayoutNode {
  return { type: 'group', id: `grp-${Date.now()}-${groupSeq++}`, tabIds: [tabId], activeTabId: tabId };
}

export function collectLeaves(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.type === 'group' ? node.tabIds : node.children.flatMap(collectLeaves);
}

export function collectGroups(node: LayoutNode | null): Array<Extract<LayoutNode, { type: 'group' }>> {
  if (!node) return [];
  return node.type === 'group' ? [node] : node.children.flatMap(collectGroups);
}

/** 在指定 group 内添加终端（不分屏） */
export function addTabToGroup(node: LayoutNode, groupId: string, tabId: string): LayoutNode {
  if (node.type === 'group') {
    if (node.id !== groupId) return node;
    return { ...node, tabIds: [...node.tabIds, tabId], activeTabId: tabId };
  }
  return { ...node, children: node.children.map((c) => addTabToGroup(c, groupId, tabId)) };
}

/** 在第一个 group 内添加终端（agent 自动开 tab / 默认路由） */
export function addTabToFirstGroup(node: LayoutNode, tabId: string): LayoutNode {
  if (node.type === 'group') {
    return { ...node, tabIds: [...node.tabIds, tabId], activeTabId: tabId };
  }
  const [first, ...rest] = node.children;
  if (!first) return node;
  const updated = addTabToFirstGroup(first, tabId);
  return { ...node, children: [updated, ...rest] };
}

export function removeTabFromLayout(node: LayoutNode | null, tabId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    if (!node.tabIds.includes(tabId)) return node;
    const tabIds = node.tabIds.filter((t) => t !== tabId);
    if (tabIds.length === 0) return null;
    return { ...node, tabIds, activeTabId: node.activeTabId === tabId ? tabIds[0] : node.activeTabId };
  }
  const children = node.children
    .map((c) => removeTabFromLayout(c, tabId))
    .filter((c): c is LayoutNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** 从源 group 移除 tabId 并加入目标 group（中心 drop = 合并） */
export function moveTabIntoGroup(
  node: LayoutNode,
  tabId: string,
  targetGroupId: string,
): LayoutNode {
  if (node.type === 'group') {
    if (node.id === targetGroupId) {
      return { ...node, tabIds: [...node.tabIds, tabId], activeTabId: tabId };
    }
    return { ...node, tabIds: node.tabIds.filter((t) => t !== tabId) };
  }
  return { ...node, children: node.children.map((c) => moveTabIntoGroup(c, tabId, targetGroupId)) };
}

/** 在目标 group 旁按方向 split：新 group（含 tabId）与目标并排 */
export function splitGroupAt(
  node: LayoutNode,
  targetGroupId: string,
  tabId: string,
  pos: DropPos,
): LayoutNode {
  if (node.type === 'group') {
    if (node.id !== targetGroupId) return node;
    const dir = pos === 'left' || pos === 'right' ? 'h' : 'v';
    const newGroup = makeGroup(tabId);
    const first = pos === 'left' || pos === 'top' ? newGroup : node;
    const second = pos === 'left' || pos === 'top' ? node : newGroup;
    return makeSplit(dir, first, second);
  }
  return { ...node, children: node.children.map((c) => splitGroupAt(c, targetGroupId, tabId, pos)) };
}

/** 更新 group 的活动 tab */
export function setGroupActive(node: LayoutNode, groupId: string, tabId: string): LayoutNode {
  if (node.type === 'group') {
    if (node.id !== groupId) return node;
    return { ...node, activeTabId: tabId };
  }
  return { ...node, children: node.children.map((c) => setGroupActive(c, groupId, tabId)) };
}

/** 找到 tabId 所在 group id */
export function findGroupIdOfTab(node: LayoutNode | null, tabId: string): string | null {
  if (!node) return null;
  if (node.type === 'group') return node.tabIds.includes(tabId) ? node.id : null;
  for (const c of node.children) {
    const found = findGroupIdOfTab(c, tabId);
    if (found) return found;
  }
  return null;
}

function findHostOfTab(hostLayouts: Record<string, LayoutNode>, tabId: string): string | null {
  for (const [h, layout] of Object.entries(hostLayouts)) {
    if (collectLeaves(layout).includes(tabId)) return h;
  }
  return null;
}

interface AppState {
  authed: boolean;
  view: View;
  hosts: Host[];
  /** 已加载插件列表（NAV 动态项 / 插件管理页） */
  plugins: PluginInfo[];
  approvals: ApprovalInfo[];
  mcpSessions: SessionInfo[];
  tabs: TerminalTab[];
  /** 每主机的布局树（group/split） */
  hostLayouts: Record<string, LayoutNode>;
  /** 外层 tab 列表（主机工作区 / 编辑器 / 设置 / 传输 / 审计） */
  outerTabs: OuterTab[];
  /** 外层活动 tab id */
  activeOuterId: string | null;
  /** 外层布局树（第一层 tab 也可分屏/合并，VSCode 编辑器组模型） */
  outerLayout: LayoutNode | null;
  /** 右栏停靠的外层 tab id（null = 无右栏） */
  rightDockId: string | null;
  /** 右栏是否折叠 */
  rightDockCollapsed: boolean;
  /** 拖拽中的外层 tab id */
  outerDragId: string | null;
  /** 全局焦点终端（派生维护，供 SFTP 跟随 / 后台通知判断） */
  activeTabId: string | null;
  /** 拖拽中的 tab */
  dragTabId: string | null;
  /** 传输记录（上传/下载，供传输管理器） */
  transfers: TransferRec[];
  /** 快捷命令（状态栏显示 name，执行 value；设置中编辑） */
  quickCommands: Array<{ name: string; value: string }>;
  /** 侧边栏是否收起 */
  sidebarCollapsed: boolean;
  /** 侧边栏宽度（拖拽调整，localStorage 持久） */
  sidebarWidth: number;
  /** 右栏宽度（拖拽调整，localStorage 持久） */
  rightbarWidth: number;
  /** 当前活动主机的系统指标（状态栏） */
  metrics: HostMetrics | null;
  /** 告警阈值（百分比） */
  alertThresholds: { cpu: number; mem: number; disk: number };
  /** 终端主题名 */
  terminalTheme: string;
  /** MCP 服务地址（状态栏/设置页共用；'' = 未加载，用主服务端口） */
  mcpUrl: string;
  toasts: Toast[];
  sftp: SftpState;
  hostModal: HostModalState;
  auditFilter: 'all' | 'web' | 'mcp';
  forwardList: import('./api').ForwardRec[];
  /** SFTP 目录列表缓存：key = `${hostId}:${path}` */
  sftpCache: Record<string, SftpCacheEntry>;
  /** SFTP 树展开状态：key = `${hostId}:${path}` → 是否展开 */
  sftpExpanded: Record<string, boolean>;
  /** SFTP 剪贴板（复制/剪切） */
  sftpClipboard: SftpClipboard | null;
  /** 编辑器 dirty 状态：editor tab id → 未保存（tab 栏显示 ●） */
  editorDirty: Record<string, boolean>;

  setAuthed: (v: boolean) => void;
  setView: (v: View) => void;
  loadHosts: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  refreshHosts: () => Promise<void>;
  upsertApproval: (a: ApprovalInfo) => void;
  removeApproval: (id: number) => void;
  updateSessions: (sessions: SessionInfo[]) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  removeToast: (id: number) => void;
  setTabNotify: (id: string, notify: TerminalTab['notify']) => void;
  setSftp: (patch: Partial<SftpState>) => void;
  openHostModal: (editing?: Host | null) => void;
  closeHostModal: () => void;
  setAuditFilter: (f: 'all' | 'web' | 'mcp') => void;
  setForwardList: (list: import('./api').ForwardRec[]) => void;
  setSftpCache: (key: string, items: import('./api').SftpItem[]) => void;
  toggleSftpExpand: (path: string) => void;
  setSftpClipboard: (c: SftpClipboard | null) => void;
  setEditorDirty: (id: string, dirty: boolean) => void;
  /** 幂等展开（reveal 用，不翻转） */
  expandSftpPath: (path: string) => void;
  /** 打开/激活主机外层 tab（终端相关动作内部调用）；label 可选（插件动态设备名） */
  openHostOuter: (hostId: string, label?: string) => void;
  /** 打开外层 tab（editor 同名文件复用；settings/transfer/audit 单例） */
  openOuterTab: (tab: OuterTab) => void;
  /** 关闭外层 tab（host 关闭时同时关闭其全部终端） */
  closeOuterTab: (id: string) => void;
  setActiveOuter: (id: string | null) => void;
  /** 外层 tab 拖拽停靠：分屏/合并（第一层布局） */
  moveOuterTab: (tabId: string, targetGroupId: string, pos: DropPos) => void;
  /** 调整外层分屏比例 */
  setOuterSplitRatio: (splitId: string, ratio: number) => void;
  setOuterDragId: (id: string | null) => void;
  /** 停靠/取消停靠右栏（停靠时从外层布局移除） */
  setRightDock: (id: string | null) => void;
  toggleRightDock: () => void;
  /** 记录传输（自动分配 id，上限 100 条） */
  addTransfer: (t: Omit<TransferRec, 'id' | 'ts'>) => number;
  updateTransfer: (id: number, patch: Partial<Pick<TransferRec, 'transferred' | 'status' | 'error' | 'size' | 'localPath' | 'doneAt'>>) => void;
  clearTransfers: () => void;
  setQuickCommands: (cmds: Array<{ name: string; value: string }>) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setRightbarWidth: (w: number) => void;
  /** 编辑器保存后失效 SFTP 缓存（hostId + 父目录路径） */
  invalidateSftpPath: (hostId: string, path: string) => void;
  /** 打开主机工作区（外层激活），新建终端（若已有工作区则加入第一个组） */
  addTab: (host: Host) => string;
  /** 插件动态设备一键连接：令牌由插件后端 ctx.ssh.requestConnect 产生（一次性） */
  openDynamicTerminal: (token: string, name: string) => string;
  /** 在指定组的 tab 栏加号：组内新建终端（不分屏） */
  addTerminalToGroup: (hostId: string, groupId: string) => string | null;
  addAgentTab: (session: SessionInfo, opts?: { activate?: boolean }) => string;
  setTabStatus: (id: string, patch: Partial<Pick<TerminalTab, 'status' | 'streamId' | 'error'>>) => void;
  /** 关闭终端并从布局移除 */
  closeTab: (id: string) => void;
  /** 关闭主机工作区（该主机全部终端） */
  closeHostWorkspace: (hostId: string) => void;
  /** 定位终端所在主机并激活 */
  setActiveTab: (id: string | null) => void;
  /** 每台主机最后激活的 tab id（点击主机组头时恢复） */
  lastActiveByHost: Record<number, string>;
  /** 拖拽停靠：拖 tabId 到 targetGroupId 面板（边缘分屏 / 中心合并） */
  moveTab: (tabId: string, targetGroupId: string, pos: DropPos) => void;
  /** 调整分屏比例（拖动分割栏） */
  setSplitRatio: (hostId: string, splitId: string, ratio: number) => void;
  setDragTab: (id: string | null) => void;
  setMetrics: (m: HostMetrics | null) => void;
  setAlertThresholds: (t: { cpu: number; mem: number; disk: number }) => void;
  setTerminalTheme: (t: string) => void;
  setMcpUrl: (u: string) => void;
  /** 工作区持久化：布局/tab 存 localStorage（刷新后恢复，配合 tmux 恢复会话现场） */
  saveWorkspace: () => void;
  restoreWorkspace: () => void;
}

let tabSeq = 0;

function makeTab(kind: TerminalTab['kind'], hostId: number, hostName: string, sessionId: string | null): TerminalTab {
  return {
    id: `tab-${Date.now()}-${tabSeq++}`,
    kind,
    hostId,
    hostName,
    sessionId,
    streamId: null,
    status: 'connecting',
  };
}

export const useStore = create<AppState>((set, get) => ({
  authed: false,
  view: 'terminals',
  hosts: [],
  plugins: [],
  approvals: [],
  mcpSessions: [],
  tabs: [],
  hostLayouts: {},
  outerTabs: [],
  activeOuterId: null,
  outerLayout: null,
  rightDockId: null,
  rightDockCollapsed: false,
  outerDragId: null,
  activeTabId: null,
  dragTabId: null,
  transfers: (() => {
    try {
      const raw = localStorage.getItem('ta-transfers');
      if (raw) {
        const parsed = JSON.parse(raw) as TransferRec[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // 忽略
    }
    return [];
  })(),
  quickCommands: (() => {
    try {
      const raw = localStorage.getItem('ta-quick-commands');
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          // 兼容旧格式 string[] → { name, value }
          const cmds = parsed.every((c) => typeof c === 'string')
            ? (parsed as string[]).map((s) => ({ name: s, value: s }))
            : (parsed as Array<{ name?: unknown; value?: unknown }>)
                .filter((c): c is { name: string; value: string } => typeof c?.name === 'string' && typeof c?.value === 'string')
                .map((c) => ({ name: c.name, value: c.value }));
          if (cmds.length > 0) return cmds.slice(0, 20);
        }
      }
    } catch {
      // 忽略
    }
    return [
      { name: 'ls', value: 'ls -la' },
      { name: 'df', value: 'df -h' },
      { name: 'free', value: 'free -h' },
      { name: 'uptime', value: 'uptime' },
      { name: 'pwd', value: 'pwd' },
      { name: 'clear', value: 'clear' },
    ];
  })(),

  sidebarCollapsed: false,
  sidebarWidth: (() => {
    try {
      const v = Number(localStorage.getItem('ta-sidebar-width'));
      if (v >= 200 && v <= 800) return v;
    } catch {
      // 忽略
    }
    return 320;
  })(),
  rightbarWidth: (() => {
    try {
      const v = Number(localStorage.getItem('ta-rightbar-width'));
      if (v >= 200 && v <= 800) return v;
    } catch {
      // 忽略
    }
    return 320;
  })(),
  metrics: null,
  alertThresholds: { cpu: 90, mem: 90, disk: 90 },
  terminalTheme: 'dark-plus',
  lastActiveByHost: {},
  mcpUrl: '',
  toasts: [],
  sftp: { hostId: '', path: '/', selectedPath: null, revealPath: null },
  hostModal: { open: false, editing: null },
  auditFilter: 'all',
  forwardList: [],
  sftpCache: {},
  sftpExpanded: {},
  sftpClipboard: null,
  editorDirty: {},

  setAuthed: (v) => set({ authed: v }),
  setView: (v) => set({ view: v }),

  openHostOuter: (hostId, label) => {
    const exists = get().outerTabs.some((t) => t.kind === 'host' && t.hostId === hostId);
    const outerTabs = exists
      ? // 已存在：更新 label（动态设备重连时名称跟随最新设备）
        get().outerTabs.map((t) => (t.kind === 'host' && t.hostId === hostId && label ? { ...t, label } : t))
      : [...get().outerTabs, { kind: 'host', id: hostId, hostId, label } as OuterTab];
    let outerLayout = get().outerLayout;
    if (!outerLayout) outerLayout = makeGroup(hostId);
    else if (!collectLeaves(outerLayout).includes(hostId)) outerLayout = addTabToFirstGroup(outerLayout, hostId);
    const gid = findGroupIdOfTab(outerLayout, hostId);
    if (gid) outerLayout = setGroupActive(outerLayout, gid, hostId);
    set({ outerTabs, outerLayout, activeOuterId: hostId });
  },

  openOuterTab: (tab) => {
    const exists = get().outerTabs.some((t) => t.id === tab.id);
    const outerTabs = exists ? get().outerTabs : [...get().outerTabs, tab];
    let outerLayout = get().outerLayout;
    if (!outerLayout) outerLayout = makeGroup(tab.id);
    else if (!collectLeaves(outerLayout).includes(tab.id)) outerLayout = addTabToFirstGroup(outerLayout, tab.id);
    const gid = findGroupIdOfTab(outerLayout, tab.id);
    if (gid) outerLayout = setGroupActive(outerLayout, gid, tab.id);
    set({ outerTabs, outerLayout, activeOuterId: tab.id });
  },

  closeOuterTab: (id) => {
    const tab = get().outerTabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === 'host') {
      get().closeHostWorkspace(tab.hostId);
      return;
    }
    const outerTabs = get().outerTabs.filter((t) => t.id !== id);
    const outerLayout = removeTabFromLayout(get().outerLayout, id);
    const leaves = outerLayout ? collectLeaves(outerLayout) : [];
    const activeOuterId = get().activeOuterId === id ? (leaves[leaves.length - 1] ?? null) : get().activeOuterId;
    set({ outerTabs, outerLayout, activeOuterId });
  },

  setActiveOuter: (id) => {
    const layout = get().outerLayout;
    let outerLayout = layout;
    if (layout && id) {
      const gid = findGroupIdOfTab(layout, id);
      if (gid) outerLayout = setGroupActive(layout, gid, id);
    }
    set({ activeOuterId: id, outerLayout });
  },

  moveOuterTab: (tabId, targetGroupId, pos) => {
    if (tabId === targetGroupId) return;
    const layout = get().outerLayout;
    if (!layout || !get().outerTabs.some((t) => t.id === tabId)) return;
    // 防御：目标必须是外层布局内的 group（防内层 group id 误传）
    if (!collectGroups(layout).some((g) => g.id === targetGroupId)) return;
    // 已在目标组：合并无操作（防重复添加）
    if (pos === 'center') {
      const tg = collectGroups(layout).find((g) => g.id === targetGroupId);
      if (tg?.tabIds.includes(tabId)) return;
    }
    const src = removeTabFromLayout(layout, tabId);
    if (!src) return;
    const outerLayout =
      pos === 'center' ? moveTabIntoGroup(src, tabId, targetGroupId) : splitGroupAt(src, targetGroupId, tabId, pos);
    // 从右栏拖回主区时取消右栏停靠
    const patch = get().rightDockId === tabId ? { rightDockId: null as string | null } : {};
    set({ outerLayout, activeOuterId: tabId, ...patch });
  },

  setOuterSplitRatio: (splitId, ratio) => {
    const layout = get().outerLayout;
    if (!layout) return;
    const update = (node: LayoutNode): LayoutNode => {
      if (node.type === 'group') return node;
      if (node.id === splitId) return { ...node, ratio };
      return { ...node, children: node.children.map(update) };
    };
    set({ outerLayout: update(layout) });
  },

  setOuterDragId: (outerDragId) => set({ outerDragId }),

  setRightDock: (id) => {
    let outerLayout = get().outerLayout;
    if (id && outerLayout && collectLeaves(outerLayout).includes(id)) {
      outerLayout = removeTabFromLayout(outerLayout, id);
    }
    set({ rightDockId: id, rightDockCollapsed: false, outerLayout, outerDragId: null });
  },

  toggleRightDock: () => set({ rightDockCollapsed: !get().rightDockCollapsed }),

  addTransfer: (t) => {
    const rec: TransferRec = { ...t, id: Date.now() + Math.floor(Math.random() * 1000), ts: Date.now() };
    const transfers = [...get().transfers, rec].slice(-100);
    try {
      localStorage.setItem('ta-transfers', JSON.stringify(transfers.filter((x) => x.status !== 'running')));
    } catch {
      // 忽略
    }
    set({ transfers });
    return rec.id;
  },

  updateTransfer: (id, patch) => {
    const transfers = get().transfers.map((t) => (t.id === id ? { ...t, ...patch } : t));
    set({ transfers });
    if (patch.status && patch.status !== 'running') {
      try {
        localStorage.setItem('ta-transfers', JSON.stringify(transfers.filter((x) => x.status !== 'running')));
      } catch {
        // 忽略
      }
    }
  },

  clearTransfers: () => {
    set({ transfers: get().transfers.filter((t) => t.status === 'running') });
    try {
      localStorage.setItem('ta-transfers', JSON.stringify(get().transfers.filter((x) => x.status !== 'running')));
    } catch {
      // 忽略
    }
  },

  setQuickCommands: (cmds) => {
    set({ quickCommands: cmds.slice(0, 20) });
    try {
      localStorage.setItem('ta-quick-commands', JSON.stringify(cmds.slice(0, 20)));
    } catch {
      // 忽略
    }
  },

  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

  setSidebarWidth: (w) => {
    const width = Math.min(800, Math.max(200, Math.round(w)));
    set({ sidebarWidth: width });
    try {
      localStorage.setItem('ta-sidebar-width', String(width));
    } catch {
      // 忽略
    }
  },

  setRightbarWidth: (w) => {
    const width = Math.min(800, Math.max(200, Math.round(w)));
    set({ rightbarWidth: width });
    try {
      localStorage.setItem('ta-rightbar-width', String(width));
    } catch {
      // 忽略
    }
  },

  invalidateSftpPath: (hostId, path) => {
    const prefix = `${hostId}:`;
    const key = `${hostId}:${path}`;
    const next = { ...get().sftpCache };
    for (const k of Object.keys(next)) {
      if (k.startsWith(prefix) && (k === key || k.startsWith(key + '/'))) delete next[k];
    }
    set({ sftpCache: next });
  },

  loadHosts: async () => {
    const hosts = await api<Host[]>('/api/hosts');
    set({ hosts });
  },
  refreshHosts: async () => {
    await get().loadHosts();
  },
  loadPlugins: async () => {
    try {
      const { plugins } = await api<{ plugins: PluginInfo[] }>('/api/plugins');
      set({ plugins });
    } catch {
      // 插件接口异常不阻断主功能
    }
  },

  upsertApproval: (a) => {
    const exists = get().approvals.some((x) => x.id === a.id);
    set({ approvals: exists ? get().approvals.map((x) => (x.id === a.id ? a : x)) : [...get().approvals, a] });
  },
  removeApproval: (id) => set({ approvals: get().approvals.filter((x) => x.id !== id) }),

  updateSessions: (sessions) => {
    const mcp = sessions.filter((s) => s.source === 'mcp');
    const alive = new Set(mcp.map((s) => s.sessionId));
    const tabs = get().tabs.map((t) =>
      t.kind === 'agent' && t.sessionId !== null && !alive.has(t.sessionId) ? { ...t, ended: true } : t,
    );
    set({ mcpSessions: mcp, tabs });
  },

  pushToast: (t) => {
    const id = Date.now() + Math.random();
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => get().removeToast(id), 8000);
  },
  removeToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  setTabNotify: (id, notify) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, notify } : t)) }),

  setSftp: (patch) => set({ sftp: { ...get().sftp, ...patch } }),
  openHostModal: (editing = null) => set({ hostModal: { open: true, editing } }),
  closeHostModal: () => set({ hostModal: { open: false, editing: null } }),
  setAuditFilter: (auditFilter) => set({ auditFilter }),
  setForwardList: (forwardList) => set({ forwardList }),
  setSftpCache: (key, items) => {
    const next = { ...get().sftpCache, [key]: { items, ts: Date.now() } };
    const keys = Object.keys(next);
    if (keys.length > 100) {
      const oldest = keys.sort((a, b) => next[a].ts - next[b].ts)[0];
      delete next[oldest];
    }
    set({ sftpCache: next });
  },
  toggleSftpExpand: (path) =>
    set({ sftpExpanded: { ...get().sftpExpanded, [path]: !get().sftpExpanded[path] } }),
  expandSftpPath: (path) => set({ sftpExpanded: { ...get().sftpExpanded, [path]: true } }),
  setSftpClipboard: (c) => set({ sftpClipboard: c }),

  setEditorDirty: (id, dirty) =>
    set((st) => {
      const next = { ...st.editorDirty };
      if (dirty) next[id] = true;
      else delete next[id];
      return { editorDirty: next };
    }),

  /** 打开主机工作区（外层激活）；已有工作区则加入第一个组（不分屏） */
  addTab: (host) => {
    const hostId = String(host.id);
    const tab = makeTab('web', host.id, host.name, null);
    const existing = get().hostLayouts[hostId];
    const newLayout = existing ? addTabToFirstGroup(existing, tab.id) : makeGroup(tab.id);
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: newLayout },
      activeTabId: tab.id,
    });
    get().openHostOuter(hostId);
    return tab.id;
  },

  /** 插件动态设备一键连接：令牌由插件后端 ctx.ssh.requestConnect 产生（一次性） */
  openDynamicTerminal: (token, name) => {
    // 动态设备无 hosts 记录：hostId 用唯一负值（每设备独立布局与外层 tab，避免共用 '0' 串名）
    const hostId = -(Date.now() % 1_000_000) - tabSeq;
    const tab: TerminalTab = {
      id: `tab-${Date.now()}-${tabSeq++}`,
      kind: 'web',
      hostId,
      hostName: name,
      sessionId: null,
      streamId: null,
      status: 'connecting',
      connectToken: token,
    };
    const key = String(tab.hostId);
    const existing = get().hostLayouts[key];
    const newLayout = existing ? addTabToFirstGroup(existing, tab.id) : makeGroup(tab.id);
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [key]: newLayout },
      activeTabId: tab.id,
    });
    get().openHostOuter(key, name);
    return tab.id;
  },

  /** 组内加号：在该组新建终端（不分屏，激活新终端） */
  addTerminalToGroup: (hostId, groupId) => {    const layout = get().hostLayouts[hostId];
    if (!layout) return null;
    const host = get().hosts.find((h) => String(h.id) === hostId);
    if (!host) return null;
    const tab = makeTab('web', host.id, host.name, null);
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: addTabToGroup(layout, groupId, tab.id) },
      activeTabId: tab.id,
    });
    get().openHostOuter(hostId);
    return tab.id;
  },

  addAgentTab: (session, opts) => {
    const hostId = String(session.hostId);
    const tab = makeTab('agent', session.hostId, session.hostName, session.sessionId);
    const existing = get().hostLayouts[hostId];
    const newLayout = existing ? addTabToFirstGroup(existing, tab.id) : makeGroup(tab.id);
    const activate = opts?.activate ?? true;
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: newLayout },
      activeTabId: activate ? tab.id : get().activeTabId,
    });
    if (activate) get().openHostOuter(hostId);
    return tab.id;
  },

  setTabStatus: (id, patch) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),

  closeTab: (id) => {
    const hostId = findHostOfTab(get().hostLayouts, id);
    if (!hostId) return;
    const layout = removeTabFromLayout(get().hostLayouts[hostId], id);
    const hostLayouts = { ...get().hostLayouts };
    const outerTabs = [...get().outerTabs];
    let activeOuterId = get().activeOuterId;
    if (!layout) {
      delete hostLayouts[hostId];
      const idx = outerTabs.findIndex((t) => t.id === hostId);
      if (idx >= 0) outerTabs.splice(idx, 1);
      if (activeOuterId === hostId) {
        const nextHost = Object.keys(hostLayouts)[0] ?? null;
        activeOuterId = nextHost ?? null;
      }
    } else {
      hostLayouts[hostId] = layout;
    }
    const leaves = layout ? collectLeaves(layout) : [];
    let activeTabId = get().activeTabId;
    if (activeTabId === id) activeTabId = leaves[0] ?? null;
    set({
      tabs: get().tabs.filter((t) => t.id !== id),
      hostLayouts,
      outerTabs,
      activeOuterId,
      activeTabId,
    });
  },

  closeHostWorkspace: (hostId) => {
    const layout = get().hostLayouts[hostId];
    if (!layout) return;
    const closing = new Set(collectLeaves(layout));
    const hostLayouts = { ...get().hostLayouts };
    delete hostLayouts[hostId];
    // 外层布局同步移除该主机 tab
    let outerLayout = get().outerLayout;
    if (outerLayout && collectLeaves(outerLayout).includes(hostId)) {
      outerLayout = removeTabFromLayout(outerLayout, hostId);
    }
    const outerTabs = get().outerTabs.filter((t) => t.id !== hostId);
    const nextHost = Object.keys(hostLayouts)[0] ?? null;
    const nextLayout = nextHost ? hostLayouts[nextHost] : null;
    const wasActive = get().activeOuterId === hostId;
    const outerLeaves = outerLayout ? collectLeaves(outerLayout) : [];
    set({
      tabs: get().tabs.filter((t) => !closing.has(t.id)),
      hostLayouts,
      outerTabs,
      outerLayout,
      activeOuterId: wasActive ? (outerLeaves[outerLeaves.length - 1] ?? null) : get().activeOuterId,
      activeTabId: wasActive
        ? nextLayout
          ? collectLeaves(nextLayout)[0] ?? null
          : null
        : get().activeTabId,
    });
  },

  setActiveTab: (id) => {
    if (id === null) {
      set({ activeTabId: null });
      return;
    }
    const hostId = findHostOfTab(get().hostLayouts, id);
    if (!hostId) return;
    const groupId = findGroupIdOfTab(get().hostLayouts[hostId], id);
    const layout = groupId ? setGroupActive(get().hostLayouts[hostId], groupId, id) : get().hostLayouts[hostId];
    set({
      hostLayouts: { ...get().hostLayouts, [hostId]: layout },
      activeTabId: id,
      lastActiveByHost: { ...get().lastActiveByHost, [hostId]: id },
      tabs: get().tabs.map((t) => (t.id === id && t.notify ? { ...t, notify: undefined } : t)),
    });
    get().openHostOuter(hostId);
  },

  moveTab: (tabId, targetGroupId, pos) => {
    if (tabId === targetGroupId) return;
    const srcHost = findHostOfTab(get().hostLayouts, tabId);
    const dstHost = Object.entries(get().hostLayouts).find(([, l]) =>
      collectGroups(l).some((g) => g.id === targetGroupId),
    )?.[0];
    if (!srcHost || !dstHost) return;
    // 已在目标组：合并无操作（防重复添加）
    if (pos === 'center') {
      const tg = collectGroups(get().hostLayouts[dstHost]).find((g) => g.id === targetGroupId);
      if (tg?.tabIds.includes(tabId)) return;
    }
    const hostLayouts = { ...get().hostLayouts };
    if (pos === 'center') {
      // 合并：从源组移除并加入目标组
      const srcLayout = removeTabFromLayout(hostLayouts[srcHost], tabId);
      if (srcLayout) hostLayouts[srcHost] = srcLayout;
      else delete hostLayouts[srcHost];
      hostLayouts[dstHost] = moveTabIntoGroup(hostLayouts[dstHost], tabId, targetGroupId);
      set({ hostLayouts });
      return;
    }
    // 分屏：从源组移除，在目标组旁新建组
    const srcLayout = removeTabFromLayout(hostLayouts[srcHost], tabId);
    if (srcLayout) hostLayouts[srcHost] = srcLayout;
    else delete hostLayouts[srcHost];
    hostLayouts[dstHost] = splitGroupAt(hostLayouts[dstHost], targetGroupId, tabId, pos);
    set({ hostLayouts });
  },

  setDragTab: (dragTabId) => set({ dragTabId }),

  setSplitRatio: (hostId, splitId, ratio) => {
    const layout = get().hostLayouts[hostId];
    if (!layout) return;
    const update = (node: LayoutNode): LayoutNode => {
      if (node.type === 'group') return node;
      if (node.id === splitId) return { ...node, ratio };
      return { ...node, children: node.children.map(update) };
    };
    set({ hostLayouts: { ...get().hostLayouts, [hostId]: update(layout) } });
  },

  setMetrics: (metrics) => set({ metrics }),
  setAlertThresholds: (alertThresholds) => set({ alertThresholds }),
  setTerminalTheme: (terminalTheme) => set({ terminalTheme }),
  setMcpUrl: (mcpUrl) => set({ mcpUrl }),

  saveWorkspace: () => {
    const { tabs, hostLayouts } = get();
    // 仅持久化 web 终端（agent 会话由 MCP 管理，不恢复）
    const webTabs = tabs
      .filter((t) => t.kind === 'web')
      .map((t) => ({
        id: t.id,
        kind: 'web' as const,
        hostId: t.hostId,
        hostName: t.hostName,
        sessionId: null,
        streamId: null,
        status: 'connecting' as const,
      }));
    const activeOuterId = get().activeOuterId;
    const outerHost =
      get().outerTabs.find((t): t is Extract<OuterTab, { kind: 'host' }> => t.kind === 'host' && t.id === activeOuterId)?.hostId ?? null;
    // 外层：host tab 由 hostLayouts 恢复；工具页 tab（编辑器/设置等）数据持久化
    const toolOuterTabs = get().outerTabs.filter((t): t is Exclude<OuterTab, { kind: 'host' }> => t.kind !== 'host');
    try {
      localStorage.setItem(
        'ta-workspace',
        JSON.stringify({
          tabs: webTabs,
          hostLayouts,
          outerHost,
          outerLayout: get().outerLayout,
          toolOuterTabs,
          rightDockId: get().rightDockId,
          ts: Date.now(),
        }),
      );
    } catch {
      // 存储失败忽略
    }
  },

  restoreWorkspace: () => {
    try {
      const raw = localStorage.getItem('ta-workspace');
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        tabs: TerminalTab[];
        hostLayouts: Record<string, LayoutNode>;
        outerHost: string | null;
        outerLayout?: LayoutNode | null;
        toolOuterTabs?: OuterTab[];
        rightDockId?: string | null;
      };
      if (!saved?.hostLayouts) return;
      // 布局中引用已不存在 tab 的 leaf 清理掉
      const ids = new Set((saved.tabs ?? []).map((t) => t.id));
      const hostLayouts: Record<string, LayoutNode> = {};
      for (const [hostId, layout] of Object.entries(saved.hostLayouts)) {
        let cleaned: LayoutNode | null = layout;
        for (const leaf of collectLeaves(layout)) {
          if (!ids.has(leaf)) cleaned = removeTabFromLayout(cleaned, leaf);
        }
        if (cleaned) hostLayouts[hostId] = cleaned;
      }
      const outerTabs: OuterTab[] = [
        ...Object.keys(hostLayouts).map((hostId): OuterTab => ({ kind: 'host', id: hostId, hostId })),
        ...(saved.toolOuterTabs ?? []),
      ];
      // 外层布局恢复（清理引用不存在的 leaf）；无布局时按 outerTabs 建单组
      let outerLayout = saved.outerLayout ?? null;
      if (outerLayout) {
        const valid = new Set(outerTabs.map((t) => t.id));
        for (const leaf of collectLeaves(outerLayout)) {
          if (!valid.has(leaf)) outerLayout = removeTabFromLayout(outerLayout, leaf);
        }
      }
      if (!outerLayout && outerTabs.length > 0) {
        const [first, ...rest] = outerTabs;
        outerLayout = makeGroup(first.id);
        for (const t of rest) outerLayout = addTabToFirstGroup(outerLayout, t.id);
      }
      const outerLeaves = outerLayout ? collectLeaves(outerLayout) : [];
      const activeOuterId =
        saved.outerHost && outerLeaves.includes(saved.outerHost)
          ? saved.outerHost
          : (outerLeaves[outerLeaves.length - 1] ?? null);
      set({
        tabs: saved.tabs,
        hostLayouts,
        outerTabs,
        outerLayout,
        rightDockId: saved.rightDockId && outerTabs.some((t) => t.id === saved.rightDockId) ? saved.rightDockId : null,
        activeOuterId,
        activeTabId: null,
      });
    } catch {
      // 数据损坏则忽略
    }
  },
}));
