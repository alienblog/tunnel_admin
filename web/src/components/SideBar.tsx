import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ForwardRec, type Host, type SftpItem } from '../api';
import { useStore, type View } from '../store';
import { ws } from '../ws';
import HostForm from './HostForm';
import { downloadWithProgress, uploadFileXHR } from '../transfer';

/** VSCode 风格侧边栏：活动栏切换的视图内容全部在此，编辑区（终端）保持不变 */

function groupHosts(hosts: Host[]): Array<{ group: string; hosts: Host[] }> {
  const map = new Map<string, Host[]>();
  for (const h of hosts) {
    const key = h.group || '未分组';
    const list = map.get(key) ?? [];
    list.push(h);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([group, list]) => ({ group, hosts: list }))
    .sort((a, b) => a.group.localeCompare(b.group));
}

const sectionCls = 'px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-[#858585]';

function HostRow({ host, onActivate, onEdit, onContextMenu }: { host: Host; onActivate: () => void; onEdit: () => void; onContextMenu: (e: React.MouseEvent, h: Host) => void }) {
  return (
    <div
      className="group flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]"
      onDoubleClick={onActivate}
      onContextMenu={(e) => onContextMenu(e, host)}
      title={`${host.username}@${host.host}:${host.port}（双击打开终端）`}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#858585]" fill="currentColor">
        <path d="M1 3.5A1.5 1.5 0 012.5 2h3.086c.398 0 .78.158 1.061.44l.914.914H13.5A1.5 1.5 0 0115 4.854v7.146a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V3.5z" />
      </svg>
      <span className="truncate">{host.name}</span>
      {host.trusted && <span className="text-[10px] text-[#4ec9b0]">●</span>}
      <span className="ml-auto hidden shrink-0 gap-0.5 group-hover:flex">
        <button
          title="编辑"
          className="rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          ✎
        </button>
      </span>
    </div>
  );
}

/** 主机树（终端视图）：点击开终端 */
function HostTree({ onEdit, onContextMenu }: { onEdit: (h: Host) => void; onContextMenu: (e: React.MouseEvent, h: Host) => void }) {
  const hosts = useStore((s) => s.hosts);
  const addTab = useStore((s) => s.addTab);
  const grouped = useMemo(() => groupHosts(hosts), [hosts]);
  return (
    <>
      {grouped.map((g) => (
        <div key={g.group}>
          <div className="flex items-center gap-1 px-2 py-[3px] text-[11px] text-[#858585]">
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.086c.398 0 .78.158 1.061.44l.914.914H13.5A1.5 1.5 0 0115 4.854v7.146a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V3.5z" />
            </svg>
            {g.group}
            <span className="ml-auto pr-1 text-[10px] text-[#5a5a5a]">{g.hosts.length}</span>
          </div>
          {g.hosts.map((h) => (
            <HostRow key={h.id} host={h} onActivate={() => addTab(h)} onEdit={() => onEdit(h)} onContextMenu={onContextMenu} />
          ))}
        </div>
      ))}
      {hosts.length === 0 && <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">暂无主机，请到主机视图添加</div>}
    </>
  );
}

function SessionSideBar({ onHostContextMenu }: { onHostContextMenu: (e: React.MouseEvent, h: Host) => void }) {
  const tabs = useStore((s) => s.tabs);
  const mcpSessions = useStore((s) => s.mcpSessions);
  const hosts = useStore((s) => s.hosts);
  const addAgentTab = useStore((s) => s.addAgentTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const addTab = useStore((s) => s.addTab);
  const openHostModal = useStore((s) => s.openHostModal);
  // 折叠状态（默认：已打开终端与主机展开，agent 折叠）
  const [openTabs, setOpenTabs] = useState(true);
  const [openAgents, setOpenAgents] = useState(false);
  const [openHosts, setOpenHosts] = useState(true);
  // 「已打开终端」按主机分组折叠状态（localStorage 持久化）
  const [collapsedTabGroups, setCollapsedTabGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('ta-collapsed-opentabs') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggleTabGroup = (hostId: string): void => {
    setCollapsedTabGroups((prev) => {
      const next = { ...prev, [hostId]: !prev[hostId] };
      try {
        localStorage.setItem('ta-collapsed-opentabs', JSON.stringify(next));
      } catch {
        // 忽略存储失败
      }
      return next;
    });
  };
  // 按主机分组（保持 tab 打开顺序）
  const tabGroups = useMemo(() => {
    const map = new Map<number, (typeof tabs)[number][]>();
    for (const t of tabs) {
      const list = map.get(t.hostId) ?? [];
      list.push(t);
      map.set(t.hostId, list);
    }
    return [...map.entries()].map(([hostId, list]) => ({ hostId, hostName: list[0].hostName, tabs: list }));
  }, [tabs]);

  const section = (label: string, icon: string, opened: boolean, onToggle: () => void): React.ReactNode => (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-[#858585] hover:text-[#cccccc]"
    >
      <span className={`text-[10px] transition-transform ${opened ? 'rotate-90' : ''}`}>▶</span>
      {icon} {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 已打开终端（最上，默认展开） */}
      {section('已打开终端', '🖥', openTabs, () => setOpenTabs(!openTabs))}
      {openTabs && (
        <div className="max-h-48 overflow-y-auto pb-1">
          {tabGroups.map((g) => {
            const isCollapsed = !!collapsedTabGroups[String(g.hostId)];
            const hasActive = g.tabs.some((t) => !t.ended);
            return (
              <div key={g.hostId}>
                <div
                  className="flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[3px] text-[12px] font-medium text-[#cccccc] hover:bg-[#2a2d2e]"
                  onClick={() => toggleTabGroup(String(g.hostId))}
                  title={isCollapsed ? `展开 ${g.hostName} 的终端` : `折叠 ${g.hostName} 的终端`}
                >
                  <span className={`w-3 shrink-0 text-[10px] text-[#858585] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                    ▶
                  </span>
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${hasActive ? 'bg-[#4ec9b0]' : 'bg-[#5a5a5a]'}`} />
                  <span className="min-w-0 flex-1 truncate">{g.hostName}</span>
                  <span className="shrink-0 text-[10px] text-[#5a5a5a]">{g.tabs.length}</span>
                </div>
                {!isCollapsed &&
                  g.tabs.map((t, i) => (
                    <div
                      key={t.id}
                      className={`flex cursor-pointer items-center gap-1.5 rounded-sm py-[3px] pr-2 pl-6 text-[12px] hover:bg-[#2a2d2e] ${
                        t.ended ? 'text-[#5a5a5a]' : 'text-[#cccccc]'
                      }`}
                      onClick={() => setActiveTab(t.id)}
                    >
                      {t.kind === 'agent' ? (
                        <span className="w-3 shrink-0 text-center text-[10px]">🤖</span>
                      ) : (
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            t.ended
                              ? 'bg-[#5a5a5a]'
                              : t.status === 'connected'
                                ? 'bg-[#4ec9b0]'
                                : t.status === 'error'
                                  ? 'bg-[#f14c4c]'
                                  : 'animate-pulse bg-[#cca700]'
                          }`}
                        />
                      )}
                      <span className="truncate">{t.kind === 'agent' ? 'Agent 会话' : `终端 ${i + 1}`}</span>
                      {t.notify === 'error' && <span className="text-[#f14c4c]">✗</span>}
                      {t.notify === 'warning' && <span className="text-[#cca700]">⚠</span>}
                      {t.notify === 'success' && <span className="text-[#4ec9b0]">✓</span>}
                    </div>
                  ))}
              </div>
            );
          })}
          {tabs.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无</div>}
        </div>
      )}

      {/* Agent 会话 */}
      {section('Agent 会话', '🤖', openAgents, () => setOpenAgents(!openAgents))}
      {openAgents && (
        <div className="max-h-40 overflow-y-auto pb-1">
          {mcpSessions.map((s) => (
            <div
              key={s.sessionId}
              className="group flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]"
              onClick={() => addAgentTab(s, { activate: true })}
              title={`${s.username}@${s.host}:${s.port}`}
            >
              <span className="h-2 w-2 rounded-full bg-[#007acc]" />
              <span className="truncate">{s.hostName}</span>
              <span className="ml-auto hidden text-[10px] text-[#858585] group-hover:inline">查看</span>
            </div>
          ))}
          {mcpSessions.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无活跃的 agent 连接</div>}
        </div>
      )}

      {/* 主机 */}
      {section('主机', '🖧', openHosts, () => setOpenHosts(!openHosts))}
      {openHosts && (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <HostTree onEdit={openHostModal} onContextMenu={onHostContextMenu} />
        </div>
      )}

      {/* 底部快捷操作 */}
      <div className="flex items-center gap-1 border-t border-[#1e1e1e] px-3 py-1.5">
        <button
          onClick={() => void addTab(hosts[0])}
          disabled={hosts.length === 0}
          title={hosts.length === 0 ? '暂无主机' : '打开第一台主机的终端'}
          className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41] disabled:opacity-40"
        >
          ⚡ 快速终端
        </button>
      </div>
    </div>
  );
}

function HostsSideBar({ onContextMenu }: { onContextMenu: (e: React.MouseEvent, h: Host) => void }) {
  const hosts = useStore((s) => s.hosts);
  const loadHosts = useStore((s) => s.loadHosts);
  const addTab = useStore((s) => s.addTab);
  const hostModal = useStore((s) => s.hostModal);
  const openHostModal = useStore((s) => s.openHostModal);
  const closeHostModal = useStore((s) => s.closeHostModal);
  const grouped = useMemo(() => groupHosts(hosts), [hosts]);
  // 分组折叠状态（localStorage 持久化）
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('ta-collapsed-groups') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const toggleGroup = (g: string): void => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [g]: !prev[g] };
      try {
        localStorage.setItem('ta-collapsed-groups', JSON.stringify(next));
      } catch {
        // 忽略存储失败
      }
      return next;
    });
  };

  // 模态：ESC 关闭（点击遮罩不关闭，需显式操作）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && useStore.getState().hostModal.open) useStore.getState().closeHostModal();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const remove = async (h: Host): Promise<void> => {
    if (!confirm(`确认删除主机「${h.name}」？`)) return;
    try {
      await api(`/api/hosts/${h.id}`, { method: 'DELETE' });
      await loadHosts();
    } catch (err) {
      alert((err as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-semibold tracking-wide text-[#858585]">主机</span>
        <button
          title="新建主机"
          onClick={() => openHostModal()}
          className="rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
        >
          ＋
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {grouped.map((g) => {
          const isCollapsed = !!collapsedGroups[g.group];
          return (
            <div key={g.group}>
              <div
                className="flex cursor-pointer select-none items-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] font-semibold text-[#cccccc] hover:bg-[#2a2d2e]"
                onClick={() => toggleGroup(g.group)}
                title={isCollapsed ? `展开分组 ${g.group}` : `折叠分组 ${g.group}`}
              >
                <span className={`w-3 shrink-0 text-[10px] text-[#858585] transition-transform ${isCollapsed ? '' : 'rotate-90'}`}>
                  ▶
                </span>
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#d7ba7d]" fill="currentColor">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.086c.398 0 .78.158 1.061.44l.914.914H13.5A1.5 1.5 0 0115 4.854v7.146a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V3.5z" />
                </svg>
                <span className="min-w-0 flex-1 truncate">{g.group}</span>
                <span className="shrink-0 text-[10px] font-normal text-[#5a5a5a]">{g.hosts.length}</span>
              </div>
              {!isCollapsed && (
                <div className="flex flex-col gap-px pb-1 pl-4">
                  {g.hosts.map((h) => (
                    <div
                      key={h.id}
                      className="group flex cursor-context-menu items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]"
                      onContextMenu={(e) => onContextMenu(e, h)}
                      onDoubleClick={(e) => {
                        // 双击打开终端连接（编辑/删除按钮上双击不触发）
                        if ((e.target as HTMLElement).closest('button')) return;
                        void addTab(h);
                      }}
                      title={`${h.username}@${h.host}:${h.port}（双击打开终端）`}
                    >
                      <span className="truncate">{h.name}</span>
                      {h.trusted && <span className="text-[10px] text-[#4ec9b0]">●</span>}
                      <span className="ml-auto hidden shrink-0 gap-1 group-hover:flex">
                        <button title="编辑" className="rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white" onClick={() => openHostModal(h)}>
                          ✎
                        </button>
                        <button title="删除" className="rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c]" onClick={() => void remove(h)}>
                          🗑
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {hosts.length === 0 && <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">暂无主机，点击上方 ＋ 新建</div>}
      </div>

      {hostModal.open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60">
          <div className="max-h-[90vh] w-160 max-w-[92vw] overflow-auto rounded-sm border border-[#3c3c3c] bg-[#252526] p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-[#cccccc]">{hostModal.editing ? '编辑主机' : '新建主机'}</h2>
              <button
                title="关闭"
                onClick={closeHostModal}
                className="rounded-sm px-1.5 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
              >
                ✕
              </button>
            </div>
            <HostForm initial={hostModal.editing} onDone={closeHostModal} />
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function SftpSideBar() {
  const sftp = useStore((s) => s.sftp);
  const setSftp = useStore((s) => s.setSftp);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const pushToast = useStore((s) => s.pushToast);
  // 跟随当前活动终端 tab 的主机（VSCode 文件管理器跟随编辑器）
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const hostId = activeTab ? String(activeTab.hostId) : '';
  // 上次主机跨挂载记忆（store 持久），避免切视图重挂时误判主机切换
  const prevHost = useRef(useStore.getState().sftp.hostId);
  const sftpCache = useStore((s) => s.sftpCache);
  const setSftpCache = useStore((s) => s.setSftpCache);
  const expanded = useStore((s) => s.sftpExpanded);
  const toggleExpand = useStore((s) => s.toggleSftpExpand);
  const expandPath = useStore((s) => s.expandSftpPath);
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [ctx, setCtx] = useState<{ x: number; y: number; item: SftpItem; parentPath: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const sftpClipboard = useStore((s) => s.sftpClipboard);
  const setSftpClipboard = useStore((s) => s.setSftpClipboard);
  /** 文本预览抽屉 */
  const [preview, setPreview] = useState<{
    path: string;
    name: string;
    size: number;
    mtime: string | null;
    content: string;
    binary: boolean;
    truncated: boolean;
    loading: boolean;
  } | null>(null);
  /** 权限弹窗（mode 为八进制数值） */
  const [chmod, setChmod] = useState<{ path: string; name: string; mode: number } | null>(null);
  /** 拖拽悬停的目录路径（高亮） */
  const [dragOver, setDragOver] = useState<string | null>(null);
  /** 上传进度 */
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  // 待滚动定位的路径：仅 reveal（初始 home / 终端 pwd）时设置，消费后清空。
  // 展开节点等普通缓存更新不会触发滚动。
  const pendingScrollRef = useRef<string | null>(null);

  const cacheKey = (h: string, p: string): string => `${h}:${p}`;
  const isPathLoading = (p: string): boolean => loadingPaths.has(p);

  /** 请求目录列表并写入缓存（SWR：调用方先用缓存渲染，后台刷新） */
  const fetchDir = useCallback(async (h: string, p: string): Promise<void> => {
    if (!h) return;
    setLoadingPaths((prev) => new Set(prev).add(p));
    setError('');
    try {
      const r = await api<{ items: SftpItem[] }>(`/api/sftp/ls?hostId=${h}&path=${encodeURIComponent(p)}`);
      setSftpCache(cacheKey(h, p), r.items);
    } catch (err) {
      setError(`${p}: ${(err as Error).message}`);
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(p);
        return next;
      });
    }
  }, [setSftpCache]);

  // 主机变化：树根重置为 /，获取用户 home 并默认展开选中
  useEffect(() => {
    if (hostId !== prevHost.current) {
      prevHost.current = hostId;
      setSftp({ hostId, path: '/', selectedPath: null });
      void fetchDir(hostId, '/');
      void api<{ home: string }>(`/api/sftp/home?hostId=${hostId}`)
        .then((r) => {
          // 若已有待消费的 reveal（如终端 pwd 刚触发）则不覆盖，优先定位用户指定路径
          const cur = useStore.getState().sftp;
          if (cur.revealPath == null) setSftp({ revealPath: r.home });
        })
        .catch(() => {
          // home 获取失败则停留在根
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // reveal 请求（终端 pwd / 初始 home / 右键跳转）：逐级加载展开并选中
  useEffect(() => {
    const target = sftp.revealPath;
    if (!hostId || !target) return;
    setSftp({ revealPath: null });
    // 目标不在当前树内 → 树根重置为 /
    const root = sftp.path;
    const inside =
      target === root || (root === '/' ? target.startsWith('/') : target.startsWith(root + '/'));
    if (!inside) {
      setSftp({ path: '/' });
      void fetchDir(hostId, '/');
    }
    // 逐级：加载目录 + 展开父链（含目标自身：用户目录默认展开显示其内容）
    const parts = target.split('/').filter(Boolean);
    let cur = '';
    for (const seg of parts) {
      cur += '/' + seg;
      if (!sftpCache[cacheKey(hostId, cur)]) void fetchDir(hostId, cur);
      expandPath(cacheKey(hostId, cur));
    }
    setSftp({ selectedPath: target });
    // 标记待滚动：目标目录缓存就绪后滚到树顶部（仅定位时，展开节点不触发）
    pendingScrollRef.current = target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftp.revealPath]);

  // 定位滚动：pendingScroll 目标缓存就绪后滚动一次并清空
  useEffect(() => {
    const target = pendingScrollRef.current;
    if (!hostId || !target) return;
    if (!sftpCache[cacheKey(hostId, target)]) return;
    pendingScrollRef.current = null;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-sftp-path="${CSS.escape(target)}"]`);
      el?.scrollIntoView({ block: 'start' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpCache, hostId]);

  // 根路径：有缓存立即显示，始终后台刷新（切换 tab 不重复全量加载）
  useEffect(() => {
    if (hostId) void fetchDir(hostId, sftp.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, sftp.path]);

  // 展开目录：无缓存则加载（展开 key 按主机隔离）
  const onToggleDir = (dirPath: string): void => {
    const key = cacheKey(hostId, dirPath);
    if (!expanded[key] && !sftpCache[key]) {
      void fetchDir(hostId, dirPath);
    }
    toggleExpand(key);
  };

  const joinPath = (dir: string, name: string): string => dir.replace(/\/+$/, '') + '/' + name;

  /** 操作目标：选中目录优先（树根兜底）——＋文件/＋目录/上传 作用于用户选中的目录 */
  const opTarget = (): string => {
    const sel = sftp.selectedPath;
    if (sel && hostId) {
      const parent = sel.slice(0, sel.lastIndexOf('/')) || '/';
      const item = sftpCache[cacheKey(hostId, parent)]?.items.find((it) => joinPath(parent, it.name) === sel);
      if (item?.type === 'dir') return sel;
    }
    return sftp.path;
  };

  /** 单文件上传（XHR 带进度，记录到传输管理器） */
  const uploadFile = (f: File, targetPath: string): Promise<void> => {
    if (!hostId) return Promise.reject(new Error('未选择主机'));
    const hostName = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId)?.hostName ?? '远程';
    return uploadFileXHR(hostName, hostId, f, targetPath, (pct) => setUploading({ name: f.name, pct }));
  };

  /** 上传到指定目录（支持拖入的目录：webkitRelativePath 递归建目录） */
  const uploadTo = async (dirPath: string, files: FileList | File[] | null): Promise<void> => {
    if (!files || files.length === 0 || !hostId) return;
    setError('');
    try {
      for (const f of Array.from(files)) {
        const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
        if (rel) {
          const parts = rel.split('/');
          parts.pop(); // 去掉文件名
          let cur = dirPath;
          for (const seg of parts) {
            cur = joinPath(cur, seg);
            try {
              await api('/api/sftp/mkdir', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), path: cur }) });
            } catch {
              // 已存在则忽略
            }
          }
          await uploadFile(f, joinPath(cur, f.name));
        } else {
          await uploadFile(f, joinPath(dirPath, f.name));
        }
      }
      setUploading(null);
      await fetchDir(hostId, dirPath);
    } catch (err) {
      setUploading(null);
      setError((err as Error).message);
    }
  };

  const mkdir = async (at?: string): Promise<void> => {
    const name = prompt('目录名称：');
    if (!name || !hostId) return;
    const target = at ?? opTarget();
    try {
      await api('/api/sftp/mkdir', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), path: joinPath(target, name) }) });
      await fetchDir(hostId, target);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const touch = async (at?: string): Promise<void> => {
    const name = prompt('文件名称：');
    if (!name || !hostId) return;
    const target = at ?? opTarget();
    try {
      await api('/api/sftp/touch', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), path: joinPath(target, name) }) });
      await fetchDir(hostId, target);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const rename = async (item: SftpItem, parentPath: string): Promise<void> => {
    const name = prompt('新名称：', item.name);
    if (!name || !hostId || name === item.name) return;
    try {
      const from = joinPath(parentPath, item.name);
      const to = joinPath(parentPath, name);
      await api('/api/sftp/rename', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), from, to }) });
      await fetchDir(hostId, parentPath);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const remove = async (item: SftpItem, parentPath: string): Promise<void> => {
    const msg = item.type === 'dir' ? `确认递归删除目录「${item.name}」？此操作不可恢复！` : `确认删除「${item.name}」？`;
    if (!confirm(msg) || !hostId) return;
    try {
      await api(`/api/sftp/rm?hostId=${hostId}&path=${encodeURIComponent(joinPath(parentPath, item.name))}&recursive=${item.type === 'dir' ? '1' : '0'}`, { method: 'DELETE' });
      await fetchDir(hostId, parentPath);
      setCtx(null);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const copyItem = (item: SftpItem, parentPath: string): void => {
    setSftpClipboard({ action: 'copy', path: joinPath(parentPath, item.name), name: item.name, type: item.type === 'dir' ? 'dir' : 'file' });
    setCtx(null);
  };

  const cutItem = (item: SftpItem, parentPath: string): void => {
    setSftpClipboard({ action: 'cut', path: joinPath(parentPath, item.name), name: item.name, type: item.type === 'dir' ? 'dir' : 'file' });
    setCtx(null);
  };

  /** 粘贴：复制（copy）或移动（cut）；目标同名时先确认 */
  const pasteInto = async (dirPath: string): Promise<void> => {
    if (!hostId || !sftpClipboard) return;
    const target = joinPath(dirPath, sftpClipboard.name);
    if (target === sftpClipboard.path) {
      setCtx(null);
      return;
    }
    const exists = sftpCache[cacheKey(hostId, dirPath)]?.items.some((it) => it.name === sftpClipboard.name);
    if (exists && !confirm(`「${sftpClipboard.name}」已存在，${sftpClipboard.action === 'copy' ? '覆盖' : '移动'}？`)) {
      setCtx(null);
      return;
    }
    try {
      if (sftpClipboard.action === 'copy') {
        await api('/api/sftp/copy', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), from: sftpClipboard.path, to: target }) });
      } else {
        await api('/api/sftp/move', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), from: sftpClipboard.path, to: target }) });
        const srcParent = sftpClipboard.path.slice(0, sftpClipboard.path.lastIndexOf('/')) || '/';
        void fetchDir(hostId, srcParent);
      }
      setSftpClipboard(null);
      await fetchDir(hostId, dirPath);
      setCtx(null);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  /** 文本预览（前 64KB） */
  const openPreview = async (item: SftpItem, parentPath: string): Promise<void> => {
    if (!hostId) return;
    const path = joinPath(parentPath, item.name);
    setPreview({ path, name: item.name, size: item.size, mtime: item.mtime, content: '', binary: false, truncated: false, loading: true });
    try {
      const r = await api<{ content: string; binary: boolean; truncated: boolean }>(`/api/sftp/read?hostId=${hostId}&path=${encodeURIComponent(path)}`);
      setPreview((p) => (p && p.path === path ? { ...p, ...r, loading: false } : p));
    } catch (err) {
      setPreview((p) => (p && p.path === path ? { ...p, content: `读取失败：${(err as Error).message}`, loading: false } : p));
    }
  };

  /** 双击文件：在外层打开编辑器 tab */
  const openInEditor = (item: SftpItem, parentPath: string): void => {
    if (!hostId) return;
    const path = joinPath(parentPath, item.name);
    const activeTab = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId);
    useStore.getState().openOuterTab({
      kind: 'editor',
      id: `editor-${hostId}-${path}`,
      hostId,
      hostName: activeTab?.hostName ?? '远程',
      path,
      name: item.name,
    });
  };

  /** 目录打包下载（tar 流式，记录到传输管理器） */
  const downloadDir = (item: SftpItem, parentPath: string): void => {
    if (!hostId) return;
    const hostName = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId)?.hostName ?? '远程';
    void downloadWithProgress(
      hostName,
      `/api/sftp/archive?hostId=${hostId}&path=${encodeURIComponent(joinPath(parentPath, item.name))}`,
      `${item.name}.tar`,
      joinPath(parentPath, item.name),
    ).catch(() => {
      // 错误已在传输记录中体现
    });
    setCtx(null);
  };

  /** 文件下载（记录到传输管理器） */
  const downloadFile = (item: SftpItem, parentPath: string): void => {
    if (!hostId) return;
    const hostName = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId)?.hostName ?? '远程';
    const path = joinPath(parentPath, item.name);
    void downloadWithProgress(hostName, `/api/sftp/download?hostId=${hostId}&path=${encodeURIComponent(path)}`, item.name, path).catch(() => {
      // 错误已在传输记录中体现
    });
    setCtx(null);
  };

  const applyChmod = async (): Promise<void> => {
    if (!hostId || !chmod) return;
    try {
      await api('/api/sftp/chmod', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), path: chmod.path, mode: chmod.mode.toString(8) }) });
      const parent = chmod.path.slice(0, chmod.path.lastIndexOf('/')) || '/';
      void fetchDir(hostId, parent);
      setChmod(null);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  /** 右键「刷新」：目录 → 重新加载该目录；文件 → 重新加载其父目录（更新该文件元信息） */
  const refreshItem = (item: SftpItem, parentPath: string): void => {
    if (!hostId) return;
    if (item.type === 'dir') {
      void fetchDir(hostId, joinPath(parentPath, item.name));
    } else {
      void fetchDir(hostId, parentPath);
    }
    setCtx(null);
  };

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!ctx) return;
    const close = (): void => setCtx(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('contextmenu', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('contextmenu', close);
    };
  }, [ctx]);

  /** 递归渲染树节点 */
  const renderDir = (dirPath: string, depth: number): React.ReactNode => {
    const key = cacheKey(hostId, dirPath);
    const items = sftpCache[key]?.items;
    if (!items) {
      return isPathLoading(dirPath) ? (
        <div style={{ paddingLeft: 12 + depth * 14 }} className="px-2 py-[2px] text-[11px] text-[#5a5a5a]">
          加载中…
        </div>
      ) : null;
    }
    return items.map((it) => {
      const full = `${dirPath.replace(/\/+$/, '')}/${it.name}`;
      const fullKey = cacheKey(hostId, full);
      const isDir = it.type === 'dir';
      const isOpen = !!expanded[fullKey];
      return (
        <div key={full}>
          <div
            className={`group flex cursor-pointer items-center gap-1 rounded-sm px-2 py-[3px] text-[13px] hover:bg-[#2a2d2e] ${
              sftp.selectedPath === full ? 'bg-[#094771] text-white' : 'text-[#cccccc]'
            } ${dragOver === full ? 'bg-[#2a4a5e] ring-1 ring-inset ring-[#007acc]' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-sftp-path={full}
            onClick={() => setSftp({ selectedPath: full })}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtx({ x: e.clientX, y: e.clientY, item: it, parentPath: dirPath });
            }}
            onDoubleClick={() => {
              if (!isDir) openInEditor(it, dirPath);
            }}
            onDragOver={(e) => {
              if (!isDir) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(full);
            }}
            onDragLeave={() => setDragOver((d) => (d === full ? null : d))}
            onDrop={(e) => {
              if (!isDir) return;
              e.preventDefault();
              e.stopPropagation();
              setDragOver(null);
              void uploadTo(full, e.dataTransfer.files);
            }}
          >
            {isDir ? (
              <>
                <button
                  className="w-3 shrink-0 text-[10px] text-[#858585]"
                  onClick={() => onToggleDir(full)}
                  title={isOpen ? '折叠' : '展开'}
                >
                  {isOpen ? '▾' : '▸'}
                </button>
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 text-left text-[#4fc1ff]"
                  onClick={() => onToggleDir(full)}
                  title={it.name}
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#dcb67a]" fill="currentColor">
                    <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
                  </svg>
                  <span className="truncate">{it.name}</span>
                </button>
              </>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <span className="w-3 shrink-0" />
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#858585]" fill="currentColor">
                  <path d="M2 1.5h4.5l2 2H14a1 1 0 011 1V13a1 1 0 01-1 1H2a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
                </svg>
                <span className="truncate">{it.name}</span>
                {it.type !== 'dir' && <span className="ml-auto shrink-0 text-[10px] text-[#5a5a5a]">{formatSize(it.size)}</span>}
              </span>
            )}
          </div>
          {isDir && isOpen && renderDir(full, depth + 1)}
        </div>
      );
    });
  };

  const crumbs = sftp.path === '.' ? [] : sftp.path.split('/').filter(Boolean);
  const navigate = (depth: number): void => {
    const p = '/' + crumbs.slice(0, depth + 1).join('/');
    setSftp({ path: p });
  };

  const menuItemCls = 'flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-[#cccccc] hover:bg-[#094771]';

  /** shell 单引号转义 */
  const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

  /** 跳转：仅在激活终端执行 cd（绝对路径），文件浏览器自身不做任何动作 */
  const jumpTo = (dirPath: string): void => {
    const st = useStore.getState();
    const active = st.tabs.find((t) => t.id === st.activeTabId);
    // 优先活动终端；否则该主机任意已连接终端（覆盖恢复会话后 activeTabId 为空的情况）
    const tab = (active?.streamId ? active : st.tabs.find((t) => String(t.hostId) === hostId && t.streamId)) ?? active;
    if (tab?.streamId) {
      // 始终使用绝对路径（防御相对路径/./ 前缀）
      const abs = dirPath.startsWith('/') ? dirPath : `/${dirPath.replace(/^\.\//, '')}`;
      ws.send({ type: 'terminal:input', streamId: tab.streamId, data: `cd ${shellQuote(abs)}\r` });
      // 切回该主机的外层 tab（cd 结果立即可见）
      useStore.getState().openHostOuter(String(tab.hostId));
      if (st.activeTabId !== tab.id) st.setActiveTab(tab.id);
    } else {
      st.pushToast({ hostName: '文件', kind: 'warning', text: '没有已连接的终端，无法执行 cd（请先打开终端）' });
    }
    setCtx(null);
  };

  return (
    <div className="flex h-full flex-col">
      <div className={sectionCls}>文件 (SFTP)</div>
      <div className="px-3 pb-1 text-[12px]">
        {activeTab ? (
          <div className="flex items-center gap-1.5 text-[#cccccc]">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#858585]" fill="currentColor">
              <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
            </svg>
            <span className="truncate">{activeTab.hostName}</span>
            <span className="ml-auto shrink-0 text-[10px] text-[#5a5a5a]">跟随活动终端</span>
          </div>
        ) : (
          <div className="text-[#5a5a5a]">先在终端打开一个会话</div>
        )}
      </div>
      <div className="px-3 pb-1">
        <div className="mt-1 flex items-center gap-0.5 text-[12px] text-[#858585]">
          <button onClick={() => { setSftp({ path: '.' }); }} className="rounded-sm px-1 hover:bg-[#3a3d41] hover:text-[#cccccc]" title="根目录">
            /
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-0.5">
              <span className="text-[#5a5a5a]">/</span>
              <button onClick={() => navigate(i)} className="max-w-24 truncate rounded-sm px-1 hover:bg-[#3a3d41] hover:text-[#cccccc]">
                {c}
              </button>
            </span>
          ))}
          {isPathLoading(sftp.path) && <span className="ml-auto animate-pulse text-[10px] text-[#5a5a5a]">…</span>}
        </div>
        <div className="mt-1 flex gap-1">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void uploadTo(opTarget(), e.target.files)} />
          <input
            ref={dirInput}
            type="file"
            multiple
            hidden
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(e) => void uploadTo(opTarget(), e.target.files)}
          />
          <button onClick={() => fileInput.current?.click()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]" title={`上传文件到 ${opTarget()}`}>
            ⬆ 上传
          </button>
          <button onClick={() => dirInput.current?.click()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]" title={`上传目录到 ${opTarget()}`}>
            ⬆ 目录
          </button>
          <button onClick={() => void mkdir()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]" title={`在 ${opTarget()} 新建目录`}>
            ＋ 目录
          </button>
          <button onClick={() => void touch()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]" title={`在 ${opTarget()} 新建文件`}>
            ＋ 文件
          </button>
          {sftpClipboard && (
            <button
              onClick={() => void pasteInto(opTarget())}
              className="rounded-sm border border-[#007acc] px-2 py-0.5 text-[11px] text-[#4fc1ff] hover:bg-[#094771]"
              title={`${sftpClipboard.action === 'copy' ? '复制' : '剪切'}「${sftpClipboard.name}」→ 粘贴到 ${opTarget()}`}
            >
              📋 粘贴
            </button>
          )}
          <button onClick={() => hostId && void fetchDir(hostId, sftp.path)} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]">
            ↻
          </button>
        </div>
      </div>
      {error && <div className="border-t border-[#252526] bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-2"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(sftp.path);
        }}
        onDragLeave={() => setDragOver((d) => (d === sftp.path ? null : d))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(null);
          void uploadTo(sftp.path, e.dataTransfer.files);
        }}
      >
        {!hostId ? (
          <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">先在终端打开一个会话</div>
        ) : (
          <>
            {renderDir(sftp.path, 0)}
            {!sftpCache[cacheKey(hostId, sftp.path)] && isPathLoading(sftp.path) && (
              <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">加载中…</div>
            )}
          </>
        )}
      </div>

      {/* 上传进度 / 剪贴板提示 */}
      {uploading && (
        <div className="border-t border-[#252526] bg-[#1e1e1e] px-3 py-1 text-[11px] text-[#cccccc]">
          上传中 {uploading.name} {uploading.pct}%
          <div className="mt-0.5 h-1 w-full bg-[#3a3d41]">
            <div className="h-1 bg-[#007acc] transition-all" style={{ width: `${uploading.pct}%` }} />
          </div>
        </div>
      )}
      {sftpClipboard && !uploading && (
        <div className="border-t border-[#252526] bg-[#1e1e1e] px-3 py-1 text-[11px] text-[#5a5a5a]">
          {sftpClipboard.action === 'copy' ? '已复制' : '已剪切'}「{sftpClipboard.name}」——右键目标目录粘贴，或点工具栏「📋 粘贴」
        </div>
      )}

      {/* 右键菜单 */}
      {ctx && (
        <div
          className="fixed z-50 min-w-44 rounded-sm border border-[#3c3c3c] bg-[#252526] py-1 shadow-2xl"
          style={{ left: Math.min(ctx.x, window.innerWidth - 210), top: Math.min(ctx.y, window.innerHeight - 320) }}
          onContextMenu={(e) => e.preventDefault()}
          // 阻止 mousedown 冒泡：避免「点击外部关闭菜单」监听先关菜单导致点击失效
          onMouseDown={(e) => e.stopPropagation()}
        >
          {ctx.item.type === 'dir' && (
            <>
              <button
                className={menuItemCls}
                onClick={() => {
                  onToggleDir(joinPath(ctx.parentPath, ctx.item.name));
                  setCtx(null);
                }}
              >
                {expanded[cacheKey(hostId, joinPath(ctx.parentPath, ctx.item.name))] ? '▾ 折叠' : '▸ 展开'}
              </button>
              <button className={menuItemCls} onClick={() => jumpTo(joinPath(ctx.parentPath, ctx.item.name))}>
                ⤵ 跳转到此目录
              </button>
              <button
                className={menuItemCls}
                onClick={() => {
                  setSftp({ selectedPath: joinPath(ctx.parentPath, ctx.item.name) });
                  void touch(joinPath(ctx.parentPath, ctx.item.name));
                  setCtx(null);
                }}
              >
                ＋ 新建文件
              </button>
              <button
                className={menuItemCls}
                onClick={() => {
                  setSftp({ selectedPath: joinPath(ctx.parentPath, ctx.item.name) });
                  fileInput.current?.click();
                  setCtx(null);
                }}
              >
                ⬆ 上传到此目录
              </button>
              <button
                className={menuItemCls}
                onClick={() => {
                  setSftp({ selectedPath: joinPath(ctx.parentPath, ctx.item.name) });
                  dirInput.current?.click();
                  setCtx(null);
                }}
              >
                ⬆ 上传目录到此目录
              </button>
              {sftpClipboard && (
                <button
                  className={menuItemCls}
                  onClick={() => void pasteInto(joinPath(ctx.parentPath, ctx.item.name))}
                >
                  📋 粘贴到此处
                </button>
              )}
              <div className="my-1 border-t border-[#3c3c3c]" />
            </>
          )}
          {ctx.item.type !== 'dir' && (
            <>
              <button className={menuItemCls} onClick={() => { void openPreview(ctx.item, ctx.parentPath); setCtx(null); }}>
                👁 预览
              </button>
              <button className={menuItemCls} onClick={() => downloadFile(ctx.item, ctx.parentPath)}>
                ↓ 下载
              </button>
              <div className="my-1 border-t border-[#3c3c3c]" />
            </>
          )}
          {ctx.item.type === 'dir' && (
            <button className={menuItemCls} onClick={() => downloadDir(ctx.item, ctx.parentPath)}>
              🗜 打包下载 (tar)
            </button>
          )}
          <button
            className={menuItemCls}
            onClick={() => {
              const p = joinPath(ctx.parentPath, ctx.item.name);
              void navigator.clipboard.writeText(p);
              pushToast({ hostName: '文件', kind: 'success', text: `已复制路径：${p}` });
              setCtx(null);
            }}
          >
            🔗 复制路径
          </button>
          <button className={menuItemCls} onClick={() => copyItem(ctx.item, ctx.parentPath)}>
            📋 复制
          </button>
          <button className={menuItemCls} onClick={() => cutItem(ctx.item, ctx.parentPath)}>
            ✂ 剪切
          </button>
          <button
            className={menuItemCls}
            onClick={() => {
              setChmod({ path: joinPath(ctx.parentPath, ctx.item.name), name: ctx.item.name, mode: parseInt(ctx.item.mode, 8) || 0o644 });
              setCtx(null);
            }}
          >
            🔒 权限…
          </button>
          <div className="my-1 border-t border-[#3c3c3c]" />
          <button className={menuItemCls} onClick={() => { void rename(ctx.item, ctx.parentPath); setCtx(null); }}>
            ✎ 重命名
          </button>
          <button className={`${menuItemCls} text-[#f14c4c]`} onClick={() => void remove(ctx.item, ctx.parentPath)}>
            🗑 删除
          </button>
          <button className={menuItemCls} onClick={() => refreshItem(ctx.item, ctx.parentPath)}>
            ↻ 刷新{ctx.item.type === 'dir' ? '此文件夹' : '此文件'}
          </button>
          <div className="my-1 border-t border-[#3c3c3c]" />
          <button className={menuItemCls} onClick={() => { if (hostId) void fetchDir(hostId, sftp.path); setCtx(null); }}>
            ↻ 刷新当前目录
          </button>
        </div>
      )}

      {/* 文本预览抽屉（仅文件） */}
      {preview && (
        <div className="fixed bottom-0 left-48 right-0 z-40 flex h-72 flex-col border-t border-[#3c3c3c] bg-[#1e1e1e] shadow-2xl">
          <div className="flex items-center gap-2 border-b border-[#252526] px-3 py-1.5 text-[12px]">
            <span className="font-medium text-[#9cdcfe]">{preview.name}</span>
            <span className="text-[10px] text-[#5a5a5a]">
              {formatSize(preview.size)}
              {preview.mtime ? ` · ${new Date(preview.mtime).toLocaleString()}` : ''} · {preview.path}
            </span>
            {preview.binary && <span className="rounded-sm bg-[#3b3b1d] px-1.5 py-0.5 text-[10px] text-[#cca700]">二进制文件</span>}
            {preview.truncated && <span className="rounded-sm bg-[#3b3b1d] px-1.5 py-0.5 text-[10px] text-[#cca700]">仅显示前 64KB</span>}
            <span className="ml-auto flex items-center gap-1">
              <button
                onClick={() => void openPreview({ name: preview.name, type: 'file', size: preview.size, mtime: preview.mtime, mode: '' }, preview.path.slice(0, preview.path.lastIndexOf('/')) || '/')}
                className="rounded px-1.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
                title="重新加载"
              >
                ↻
              </button>
              <button onClick={() => setPreview(null)} className="rounded px-1.5 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c]" title="关闭">
                ×
              </button>
            </span>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12px] leading-relaxed text-[#cccccc]">
            {preview.loading ? '加载中…' : preview.content}
          </pre>
        </div>
      )}

      {/* 权限弹窗 */}
      {chmod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setChmod(null)}>
          <div
            className="w-80 rounded-sm border border-[#3c3c3c] bg-[#252526] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-[13px] font-semibold text-[#cccccc]">权限：{chmod.name}</h3>
            <div className="mb-2 text-[10px] text-[#5a5a5a]">{chmod.path}</div>
            <div className="mb-3 grid grid-cols-3 gap-2">
              {(
                [
                  ['属主', 0],
                  ['组', 1],
                  ['其他', 2],
                ] as const
              ).map(([label, idx]) => (
                <div key={label} className="rounded-sm border border-[#3c3c3c] p-2">
                  <div className="mb-1 text-[11px] text-[#858585]">{label}</div>
                  <div className="flex flex-col gap-1">
                    {(
                      [
                        ['读', 4],
                        ['写', 2],
                        ['执行', 1],
                      ] as const
                    ).map(([rlabel, v]) => {
                      const bit = v * 8 ** (2 - idx);
                      return (
                        <label key={rlabel} className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[#cccccc]">
                          <input
                            type="checkbox"
                            checked={(chmod.mode & bit) !== 0}
                            onChange={() => setChmod((c) => (c ? { ...c, mode: c.mode ^ bit } : c))}
                            className="accent-[#007acc]"
                          />
                          {rlabel}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="mb-3 flex items-center gap-2">
              <span className="text-[11px] text-[#858585]">数字</span>
              <input
                value={chmod.mode.toString(8)}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 8);
                  if (!Number.isNaN(n) && n >= 0 && n <= 0o7777) setChmod((c) => (c ? { ...c, mode: n } : c));
                }}
                className="w-16 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-1.5 py-0.5 text-[12px] font-mono text-[#cccccc] outline-none focus:border-[#007acc]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setChmod(null)} className="rounded-sm border border-[#3c3c3c] px-3 py-1 text-[12px] text-[#cccccc] hover:bg-[#3a3d41]">
                取消
              </button>
              <button onClick={() => void applyChmod()} className="rounded-sm bg-[#0e639c] px-3 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb]">
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function ForwardSideBar() {
  const hosts = useStore((s) => s.hosts);
  const list = useStore((s) => s.forwardList);
  const setForwardList = useStore((s) => s.setForwardList);
  const [hostId, setHostId] = useState('');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('');
  const [bindPort, setBindPort] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setForwardList(await api<ForwardRec[]>('/api/forward'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [setForwardList]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/forward', {
        method: 'POST',
        body: JSON.stringify({ hostId: Number(hostId), remoteHost, remotePort: Number(remotePort), bindPort: Number(bindPort) }),
      });
      setRemoteHost('');
      setRemotePort('');
      setBindPort('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (id: string): Promise<void> => {
    try {
      await api(`/api/forward/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const inputCls = 'w-full rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1 text-[12px] text-[#cccccc] outline-none focus:border-[#007acc]';

  return (
    <div className="flex h-full flex-col">
      <div className={sectionCls}>端口转发（远程为主）</div>
      <form onSubmit={create} className="flex flex-col gap-1.5 px-3 pb-2">
        <select value={hostId} onChange={(e) => setHostId(e.target.value)} className={inputCls} required>
          <option value="">选择主机…</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>{h.name}</option>
          ))}
        </select>
        <input className={inputCls} value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="目标地址（如 127.0.0.1）" required />
        <div className="flex gap-1.5">
          <input className={inputCls} type="number" min={1} max={65535} value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="目标端口" required />
          <input className={inputCls} type="number" min={1} max={65535} value={bindPort} onChange={(e) => setBindPort(e.target.value)} placeholder="服务器端口" required />
        </div>
        <button type="submit" className="rounded-sm bg-[#0e639c] px-2 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb]">
          创建转发
        </button>
      </form>
      {error && <div className="border-t border-[#252526] bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>活跃隧道</div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {list.map((f) => (
          <div key={f.id} className="group rounded-sm px-2 py-[3px] text-[12px] hover:bg-[#2a2d2e]">
            <div className="flex items-center gap-1">
              <span className="font-mono text-[#4ec9b0]">:{f.bindPort}</span>
              <span className="text-[#5a5a5a]">→</span>
              <span className="truncate font-mono text-[#9cdcfe]">{f.remoteHost}:{f.remotePort}</span>
              <button title="关闭" className="ml-auto hidden rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c] group-hover:block" onClick={() => void remove(f.id)}>
                ×
              </button>
            </div>
            <div className="text-[10px] text-[#5a5a5a]">{f.hostName}</div>
          </div>
        ))}
        {list.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无隧道</div>}
      </div>
    </div>
  );
}

export default function SideBar({ view }: { view: View }) {
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const loadHosts = useStore((s) => s.loadHosts);
  const pushToast = useStore((s) => s.pushToast);
  const openHostModal = useStore((s) => s.openHostModal);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // 主机右键菜单
  const [ctxMenu, setCtxMenu] = useState<{ host: Host; x: number; y: number } | null>(null);
  const ctxRef = useRef<{ host: Host; x: number; y: number } | null>(null);

  /** 右键菜单：编辑 / 克隆 / 删除 */
  const openCtx = (e: React.MouseEvent, h: Host): void => {
    e.preventDefault();
    ctxRef.current = { host: h, x: e.clientX, y: e.clientY };
    setCtxMenu(ctxRef.current);
  };

  const cloneHost = async (h: Host): Promise<void> => {
    try {
      await api(`/api/hosts/${h.id}/clone`, { method: 'POST' });
      await loadHosts();
      pushToast({ hostName: h.name, kind: 'success', text: '主机已克隆' });
    } catch (err) {
      pushToast({ hostName: h.name, kind: 'error', text: `克隆失败：${(err as Error).message}` });
    }
    setCtxMenu(null);
  };

  const removeHost = async (h: Host): Promise<void> => {
    if (!confirm(`确认删除主机「${h.name}」？`)) return;
    try {
      await api(`/api/hosts/${h.id}`, { method: 'DELETE' });
      await loadHosts();
    } catch (err) {
      alert((err as Error).message);
    }
    setCtxMenu(null);
  };

  /** 拖拽手柄：改变侧边栏宽度（200–800px） */
  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    const move = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      setSidebarWidth(d.startWidth + (ev.clientX - d.startX));
    };
    const up = (): void => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <aside
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-[#1e1e1e] bg-[#252526]"
      style={{ width: sidebarWidth }}
    >
      {view === 'terminals' && <SessionSideBar onHostContextMenu={openCtx} />}
      {view === 'hosts' && <HostsSideBar onContextMenu={openCtx} />}
      {view === 'sftp' && <SftpSideBar />}
      {view === 'forward' && <ForwardSideBar />}
      {/* 拖拽手柄：调整侧边栏宽度 */}
      <div
        title="拖动调整侧边栏宽度"
        onPointerDown={onPointerDown}
        className="absolute top-0 right-0 bottom-0 z-20 w-1 cursor-col-resize bg-transparent transition-colors hover:bg-[#007acc]/60"
      />
      {/* 主机右键菜单（编辑 / 克隆 / 删除） */}
      {ctxMenu && (
        <div
          className="fixed z-50 min-w-32 rounded-sm border border-[#3c3c3c] bg-[#252526] py-1 shadow-2xl"
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 160), top: Math.min(ctxMenu.y, window.innerHeight - 130) }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="border-b border-[#1e1e1e] px-3 py-1 text-[11px] text-[#5a5a5a]">{ctxMenu.host.name}</div>
          <button
            onClick={() => {
              setCtxMenu(null);
              openHostModal(ctxMenu.host);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#cccccc] hover:bg-[#094771]"
          >
            ✎ 编辑
          </button>
          <button
            onClick={() => void cloneHost(ctxMenu.host)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#cccccc] hover:bg-[#094771]"
          >
            ⧉ 克隆主机
          </button>
          <button
            onClick={() => void removeHost(ctxMenu.host)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-[#f14c4c] hover:bg-[#3b1d1d]"
          >
            🗑 删除
          </button>
        </div>
      )}
      {/* 点击其他区域关闭右键菜单 */}
      {ctxMenu && (
        <div
          className="fixed inset-0 z-40"
          onMouseDown={(e) => {
            if (ctxRef.current && !(e.target as HTMLElement).closest('.z-50')) {
              setCtxMenu(null);
            }
          }}
        />
      )}
    </aside>
  );
}
