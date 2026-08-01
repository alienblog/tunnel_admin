import { create } from 'zustand';
import { api, type ApprovalInfo, type Host } from './api';
import type { SessionInfo } from './ws';

export type View = 'terminals' | 'hosts' | 'sftp' | 'forward' | 'audit' | 'settings';

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
  approvals: ApprovalInfo[];
  mcpSessions: SessionInfo[];
  tabs: TerminalTab[];
  /** 每主机的布局树（group/split） */
  hostLayouts: Record<string, LayoutNode>;
  /** 外层活动主机（编辑区显示其布局） */
  outerHost: string | null;
  /** 全局焦点终端（派生维护，供 SFTP 跟随 / 后台通知判断） */
  activeTabId: string | null;
  /** 拖拽中的 tab */
  dragTabId: string | null;
  /** 当前活动主机的系统指标（状态栏） */
  metrics: HostMetrics | null;
  /** 告警阈值（百分比） */
  alertThresholds: { cpu: number; mem: number; disk: number };
  /** 终端主题名 */
  terminalTheme: string;
  toasts: Toast[];
  sftp: SftpState;
  hostModal: HostModalState;
  auditFilter: 'all' | 'web' | 'mcp';
  forwardList: import('./api').ForwardRec[];
  /** SFTP 目录列表缓存：key = `${hostId}:${path}` */
  sftpCache: Record<string, SftpCacheEntry>;
  /** SFTP 树展开状态：key = `${hostId}:${path}` → 是否展开 */
  sftpExpanded: Record<string, boolean>;

  setAuthed: (v: boolean) => void;
  setView: (v: View) => void;
  loadHosts: () => Promise<void>;
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
  /** 幂等展开（reveal 用，不翻转） */
  expandSftpPath: (path: string) => void;
  /** 打开主机工作区（外层激活），新建终端（若已有工作区则加入第一个组） */
  addTab: (host: Host) => string;
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
  /** 拖拽停靠：拖 tabId 到 targetGroupId 面板（边缘分屏 / 中心合并） */
  moveTab: (tabId: string, targetGroupId: string, pos: DropPos) => void;
  /** 调整分屏比例（拖动分割栏） */
  setSplitRatio: (hostId: string, splitId: string, ratio: number) => void;
  setDragTab: (id: string | null) => void;
  setMetrics: (m: HostMetrics | null) => void;
  setAlertThresholds: (t: { cpu: number; mem: number; disk: number }) => void;
  setTerminalTheme: (t: string) => void;
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
  approvals: [],
  mcpSessions: [],
  tabs: [],
  hostLayouts: {},
  outerHost: null,
  activeTabId: null,
  dragTabId: null,
  metrics: null,
  alertThresholds: { cpu: 90, mem: 90, disk: 90 },
  terminalTheme: 'dark-plus',
  toasts: [],
  sftp: { hostId: '', path: '/', selectedPath: null, revealPath: null },
  hostModal: { open: false, editing: null },
  auditFilter: 'all',
  forwardList: [],
  sftpCache: {},
  sftpExpanded: {},

  setAuthed: (v) => set({ authed: v }),
  setView: (v) => set({ view: v }),

  loadHosts: async () => {
    const hosts = await api<Host[]>('/api/hosts');
    set({ hosts });
  },
  refreshHosts: async () => {
    await get().loadHosts();
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

  /** 打开主机工作区（外层激活）；已有工作区则加入第一个组（不分屏） */
  addTab: (host) => {
    const hostId = String(host.id);
    const tab = makeTab('web', host.id, host.name, null);
    const existing = get().hostLayouts[hostId];
    const newLayout = existing ? addTabToFirstGroup(existing, tab.id) : makeGroup(tab.id);
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: newLayout },
      outerHost: hostId,
      activeTabId: tab.id,
    });
    return tab.id;
  },

  /** 组内加号：在该组新建终端（不分屏，激活新终端） */
  addTerminalToGroup: (hostId, groupId) => {
    const layout = get().hostLayouts[hostId];
    if (!layout) return null;
    const host = get().hosts.find((h) => String(h.id) === hostId);
    if (!host) return null;
    const tab = makeTab('web', host.id, host.name, null);
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: addTabToGroup(layout, groupId, tab.id) },
      outerHost: hostId,
      activeTabId: tab.id,
    });
    return tab.id;
  },

  addAgentTab: (session, opts) => {
    const hostId = String(session.hostId);
    const tab = makeTab('agent', session.hostId, session.hostName, session.sessionId);
    const existing = get().hostLayouts[hostId];
    const newLayout = existing ? addTabToFirstGroup(existing, tab.id) : makeGroup(tab.id);
    const activate = opts?.activate ?? true;
    const outerHost = activate ? hostId : get().outerHost;
    set({
      tabs: [...get().tabs, tab],
      hostLayouts: { ...get().hostLayouts, [hostId]: newLayout },
      outerHost,
      activeTabId: activate && outerHost === hostId ? tab.id : get().activeTabId,
    });
    return tab.id;
  },

  setTabStatus: (id, patch) =>
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }),

  closeTab: (id) => {
    const hostId = findHostOfTab(get().hostLayouts, id);
    if (!hostId) return;
    const layout = removeTabFromLayout(get().hostLayouts[hostId], id);
    const hostLayouts = { ...get().hostLayouts };
    if (!layout) delete hostLayouts[hostId];
    else hostLayouts[hostId] = layout;
    const leaves = layout ? collectLeaves(layout) : [];
    const outerHost = get().outerHost;
    let activeTabId = get().activeTabId;
    if (activeTabId === id) activeTabId = leaves[0] ?? null;
    if (outerHost === hostId && activeTabId === null) {
      const nextHost = Object.keys(hostLayouts)[0] ?? null;
      const nextLayout = nextHost ? hostLayouts[nextHost] : null;
      set({
        tabs: get().tabs.filter((t) => t.id !== id),
        hostLayouts,
        outerHost: nextHost,
        activeTabId: nextLayout ? collectLeaves(nextLayout)[0] ?? null : null,
      });
      return;
    }
    set({ tabs: get().tabs.filter((t) => t.id !== id), hostLayouts, activeTabId });
  },

  closeHostWorkspace: (hostId) => {
    const layout = get().hostLayouts[hostId];
    if (!layout) return;
    const closing = new Set(collectLeaves(layout));
    const hostLayouts = { ...get().hostLayouts };
    delete hostLayouts[hostId];
    const nextHost = Object.keys(hostLayouts)[0] ?? null;
    const nextLayout = nextHost ? hostLayouts[nextHost] : null;
    set({
      tabs: get().tabs.filter((t) => !closing.has(t.id)),
      hostLayouts,
      outerHost: get().outerHost === hostId ? nextHost : get().outerHost,
      activeTabId:
        get().outerHost === hostId
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
      outerHost: hostId,
      activeTabId: id,
      tabs: get().tabs.map((t) => (t.id === id && t.notify ? { ...t, notify: undefined } : t)),
    });
  },

  moveTab: (tabId, targetGroupId, pos) => {
    if (tabId === targetGroupId) return;
    const srcHost = findHostOfTab(get().hostLayouts, tabId);
    const dstHost = Object.entries(get().hostLayouts).find(([, l]) =>
      collectGroups(l).some((g) => g.id === targetGroupId),
    )?.[0];
    if (!srcHost || !dstHost) return;
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

  saveWorkspace: () => {
    const { tabs, hostLayouts, outerHost } = get();
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
    try {
      localStorage.setItem('ta-workspace', JSON.stringify({ tabs: webTabs, hostLayouts, outerHost, ts: Date.now() }));
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
      };
      if (!saved?.tabs?.length || !saved.hostLayouts) return;
      // 布局中引用已不存在 tab 的 leaf 清理掉
      const ids = new Set(saved.tabs.map((t) => t.id));
      const hostLayouts: Record<string, LayoutNode> = {};
      for (const [hostId, layout] of Object.entries(saved.hostLayouts)) {
        let cleaned: LayoutNode | null = layout;
        for (const leaf of collectLeaves(layout)) {
          if (!ids.has(leaf)) cleaned = removeTabFromLayout(cleaned, leaf);
        }
        if (cleaned) hostLayouts[hostId] = cleaned;
      }
      const outerHost = saved.outerHost && hostLayouts[saved.outerHost] ? saved.outerHost : (Object.keys(hostLayouts)[0] ?? null);
      set({
        tabs: saved.tabs,
        hostLayouts,
        outerHost,
        activeTabId: null,
      });
    } catch {
      // 数据损坏则忽略
    }
  },
}));
