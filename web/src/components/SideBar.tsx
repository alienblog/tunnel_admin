import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AuditEntry, type CmdRule, type ForwardRec, type Host, type McpToken, type SftpItem } from '../api';
import { useStore, type View } from '../store';
import { ws } from '../ws';
import HostForm from './HostForm';
import { THEME_NAMES } from '../themes';

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

function HostRow({ host, onActivate, onEdit }: { host: Host; onActivate: () => void; onEdit: () => void }) {
  return (
    <div
      className="group flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]"
      onClick={onActivate}
      title={`${host.username}@${host.host}:${host.port}`}
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
function HostTree({ onEdit }: { onEdit: (h: Host) => void }) {
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
            <HostRow key={h.id} host={h} onActivate={() => addTab(h)} onEdit={() => onEdit(h)} />
          ))}
        </div>
      ))}
      {hosts.length === 0 && <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">暂无主机，请到主机视图添加</div>}
    </>
  );
}

function SessionSideBar() {
  const tabs = useStore((s) => s.tabs);
  const mcpSessions = useStore((s) => s.mcpSessions);
  const addAgentTab = useStore((s) => s.addAgentTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const openHostModal = useStore((s) => s.openHostModal);

  return (
    <div className="flex h-full flex-col">
      <div className={sectionCls}>主机</div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <HostTree onEdit={openHostModal} />
      </div>
      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>Agent 会话</div>
      <div className="max-h-40 overflow-y-auto pb-2">
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
      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>已打开终端</div>
      <div className="max-h-40 overflow-y-auto pb-2">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] hover:bg-[#2a2d2e] ${
              t.ended ? 'text-[#5a5a5a]' : 'text-[#cccccc]'
            }`}
            onClick={() => setActiveTab(t.id)}
          >
            <span className="truncate">{t.kind === 'agent' ? '🤖 ' : ''}{t.hostName}</span>
            {t.notify === 'error' && <span className="text-[#f14c4c]">✗</span>}
            {t.notify === 'warning' && <span className="text-[#cca700]">⚠</span>}
            {t.notify === 'success' && <span className="text-[#4ec9b0]">✓</span>}
          </div>
        ))}
        {tabs.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无</div>}
      </div>
    </div>
  );
}

function HostsSideBar() {
  const hosts = useStore((s) => s.hosts);
  const loadHosts = useStore((s) => s.loadHosts);
  const hostModal = useStore((s) => s.hostModal);
  const openHostModal = useStore((s) => s.openHostModal);
  const closeHostModal = useStore((s) => s.closeHostModal);
  const grouped = useMemo(() => groupHosts(hosts), [hosts]);

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
        {grouped.map((g) => (
          <div key={g.group}>
            <div className="flex items-center gap-1 px-2 py-[3px] text-[11px] text-[#858585]">
              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.086c.398 0 .78.158 1.061.44l.914.914H13.5A1.5 1.5 0 0115 4.854v7.146a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V3.5z" />
              </svg>
              {g.group}
            </div>
            {g.hosts.map((h) => (
              <div key={h.id} className="group flex items-center gap-1.5 rounded-sm px-2 py-[3px] text-[13px] text-[#cccccc] hover:bg-[#2a2d2e]">
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
        ))}
        {hosts.length === 0 && <div className="px-3 py-2 text-[12px] text-[#5a5a5a]">暂无主机，点击上方 ＋ 新建</div>}
      </div>

      {hostModal.open && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onClick={closeHostModal}>
          <div
            className="max-h-[90vh] w-160 max-w-[92vw] overflow-auto rounded-sm border border-[#3c3c3c] bg-[#252526] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-base font-semibold text-[#cccccc]">{hostModal.editing ? '编辑主机' : '新建主机'}</h2>
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

  const upload = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || !hostId) return;
    setError('');
    try {
      for (const f of Array.from(files)) {
        const target = `${sftp.path.replace(/\/+$/, '')}/${f.name}`;
        await fetch(`/api/sftp/upload?hostId=${hostId}&path=${encodeURIComponent(target)}`, {
          method: 'POST',
          body: f,
        }).then((res) => {
          if (!res.ok) return res.json().then((b) => Promise.reject(new Error(b.error ?? '上传失败')));
        });
      }
      await fetchDir(hostId, sftp.path);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const mkdir = async (): Promise<void> => {
    const name = prompt('目录名称：');
    if (!name || !hostId) return;
    try {
      await api('/api/sftp/mkdir', { method: 'POST', body: JSON.stringify({ hostId: Number(hostId), path: `${sftp.path.replace(/\/+$/, '')}/${name}` }) });
      await fetchDir(hostId, sftp.path);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  const rename = async (item: SftpItem, parentPath: string): Promise<void> => {
    const name = prompt('新名称：', item.name);
    if (!name || !hostId || name === item.name) return;
    try {
      const from = `${parentPath.replace(/\/+$/, '')}/${item.name}`;
      const to = `${parentPath.replace(/\/+$/, '')}/${name}`;
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
      await api(`/api/sftp/rm?hostId=${hostId}&path=${encodeURIComponent(`${parentPath.replace(/\/+$/, '')}/${item.name}`)}&recursive=${item.type === 'dir' ? '1' : '0'}`, { method: 'DELETE' });
      await fetchDir(hostId, parentPath);
      setCtx(null);
    } catch (err) {
      alert((err as Error).message);
    }
  };

  /** 右键「刷新」：目录 → 重新加载该目录；文件 → 重新加载其父目录（更新该文件元信息） */
  const refreshItem = (item: SftpItem, parentPath: string): void => {
    if (!hostId) return;
    if (item.type === 'dir') {
      void fetchDir(hostId, `${parentPath.replace(/\/+$/, '')}/${item.name}`);
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
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
            data-sftp-path={full}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setCtx({ x: e.clientX, y: e.clientY, item: it, parentPath: dirPath });
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

  /** 跳转：在激活终端执行 cd，文件树跟随 */
  const jumpTo = (dirPath: string): void => {
    const st = useStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (tab?.streamId) {
      ws.send({ type: 'terminal:input', streamId: tab.streamId, data: `cd ${shellQuote(dirPath)}\r` });
    }
    setSftp({ path: dirPath || '/', selectedPath: dirPath || '/' });
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
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          <button onClick={() => fileInput.current?.click()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]">
            ⬆ 上传
          </button>
          <button onClick={() => void mkdir()} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]">
            ＋ 目录
          </button>
          <button onClick={() => hostId && void fetchDir(hostId, sftp.path)} className="rounded-sm border border-[#3c3c3c] px-2 py-0.5 text-[11px] text-[#cccccc] hover:bg-[#3a3d41]">
            ↻
          </button>
        </div>
      </div>
      {error && <div className="border-t border-[#252526] bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
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

      {/* 右键菜单 */}
      {ctx && (
        <div
          className="fixed z-50 min-w-44 rounded-sm border border-[#3c3c3c] bg-[#252526] py-1 shadow-2xl"
          style={{ left: Math.min(ctx.x, window.innerWidth - 190), top: Math.min(ctx.y, window.innerHeight - 220) }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctx.item.type === 'dir' ? (
            <button className={menuItemCls} onClick={() => { onToggleDir(`${ctx.parentPath.replace(/\/+$/, '')}/${ctx.item.name}`); setCtx(null); }}>
              {expanded[cacheKey(hostId, `${ctx.parentPath.replace(/\/+$/, '')}/${ctx.item.name}`)] ? '▾ 折叠' : '▸ 展开'}
            </button>
          ) : (
            <a
              className={`${menuItemCls} no-underline`}
              href={`/api/sftp/download?hostId=${hostId}&path=${encodeURIComponent(`${ctx.parentPath.replace(/\/+$/, '')}/${ctx.item.name}`)}`}
              download={ctx.item.name}
              onClick={() => setCtx(null)}
            >
              ↓ 下载
            </a>
          )}
          {ctx.item.type === 'dir' && (
            <button className={menuItemCls} onClick={() => jumpTo(`${ctx.parentPath.replace(/\/+$/, '')}/${ctx.item.name}`)}>
              ⤵ 跳转到此目录
            </button>
          )}
          <button className={menuItemCls} onClick={() => refreshItem(ctx.item, ctx.parentPath)}>
            ↻ 刷新{ctx.item.type === 'dir' ? '此文件夹' : '此文件'}
          </button>
          <div className="my-1 border-t border-[#3c3c3c]" />
          <button className={menuItemCls} onClick={() => { void rename(ctx.item, ctx.parentPath); setCtx(null); }}>
            ✎ 重命名
          </button>
          <button className={`${menuItemCls} text-[#f14c4c]`} onClick={() => void remove(ctx.item, ctx.parentPath)}>
            🗑 删除
          </button>
          <div className="my-1 border-t border-[#3c3c3c]" />
          <button className={menuItemCls} onClick={() => { fileInput.current?.click(); setCtx(null); }}>
            ⬆ 上传到此目录
          </button>
          <button className={menuItemCls} onClick={() => { if (hostId) void fetchDir(hostId, sftp.path); setCtx(null); }}>
            ↻ 刷新当前目录
          </button>
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

function AuditSideBar() {
  const filter = useStore((s) => s.auditFilter);
  const setFilter = useStore((s) => s.setAuditFilter);
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setEntries(await api<AuditEntry[]>('/api/audit?limit=200'));
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = entries.filter((e) => filter === 'all' || e.source === filter);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-semibold tracking-wide text-[#858585]">审计日志</span>
        <button onClick={() => void load()} className="rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white" title="刷新">
          ↻
        </button>
      </div>
      <div className="flex gap-2 px-3 pb-2 text-[11px] text-[#858585]">
        {(
          [
            ['all', '全部'],
            ['mcp', 'MCP'],
            ['web', 'Web'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-1">
            <input type="radio" name="audit-filter" checked={filter === value} onChange={() => setFilter(value)} className="accent-[#007acc]" />
            {label}
          </label>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {shown.map((e) => (
          <div key={e.id} className="rounded-sm px-2 py-[3px] hover:bg-[#2a2d2e]">
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={e.source === 'mcp' ? 'text-[#cca700]' : 'text-[#4fc1ff]'}>{e.source === 'mcp' ? 'MCP' : 'Web'}</span>
              <span className="truncate font-mono text-[#9cdcfe]">{e.command || '—'}</span>
              {e.exit_code !== null && (
                <span className={e.exit_code === 0 ? 'ml-auto shrink-0 text-[#4ec9b0]' : 'ml-auto shrink-0 text-[#f14c4c]'}>{e.exit_code}</span>
              )}
            </div>
            <div className="text-[10px] text-[#5a5a5a]">{e.ts} · {e.host_name ?? '-'} · {e.duration_ms}ms</div>
          </div>
        ))}
        {shown.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无记录</div>}
      </div>
    </div>
  );
}

/** 告警阈值配置（localStorage 持久） */
function AlertThresholds() {
  const alertThresholds = useStore((s) => s.alertThresholds);
  const setAlertThresholds = useStore((s) => s.setAlertThresholds);

  useEffect(() => {
    // 载入本地保存的阈值
    try {
      const saved = localStorage.getItem('ta-alert-thresholds');
      if (saved) setAlertThresholds(JSON.parse(saved));
    } catch {
      // 忽略
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (key: 'cpu' | 'mem' | 'disk', v: string): void => {
    const n = Math.min(100, Math.max(1, parseInt(v, 10) || 90));
    const next = { ...alertThresholds, [key]: n };
    setAlertThresholds(next);
    localStorage.setItem('ta-alert-thresholds', JSON.stringify(next));
  };

  const rows: Array<[keyof typeof alertThresholds, string]> = [
    ['cpu', 'CPU'],
    ['mem', '内存'],
    ['disk', '磁盘'],
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-[11px] text-[#858585]">
          <span className="w-8">{label}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={alertThresholds[key]}
            onChange={(e) => set(key, e.target.value)}
            className="w-16 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-1.5 py-0.5 text-[11px] text-[#cccccc] outline-none focus:border-[#007acc]"
          />
          <span>%</span>
        </label>
      ))}
      <div className="text-[10px] text-[#5a5a5a]">指标超限时状态栏弹出提醒（恢复后重置）</div>
    </div>
  );
}

function SettingsSideBar() {
  const themeName = useStore((s) => s.terminalTheme);
  const setTerminalTheme = useStore((s) => s.setTerminalTheme);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');
  // 命令规则
  const [rules, setRules] = useState<CmdRule[]>([]);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleAction, setRuleAction] = useState<'block' | 'approve'>('block');
  const [ruleNote, setRuleNote] = useState('');

  const loadRules = useCallback(async (): Promise<void> => {
    try {
      setRules(await api<CmdRule[]>('/api/cmd-rules'));
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  const addRule = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!rulePattern.trim()) return;
    try {
      await api('/api/cmd-rules', { method: 'POST', body: JSON.stringify({ pattern: rulePattern, action: ruleAction, note: ruleNote }) });
      setRulePattern('');
      setRuleNote('');
      await loadRules();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeRule = async (id: number): Promise<void> => {
    try {
      await api(`/api/cmd-rules/${id}`, { method: 'DELETE' });
      await loadRules();
    } catch {
      // 忽略
    }
  };

  const load = useCallback(async (): Promise<void> => {
    try {
      setTokens(await api<McpToken[]>('/api/tokens'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) });
      setCreated(r.token);
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (t: McpToken): Promise<void> => {
    if (!confirm(`确认吊销 token「${t.name}」？`)) return;
    try {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className={sectionCls}>MCP Token</div>
      <div className="px-3 pb-2 text-[11px] leading-relaxed text-[#5a5a5a]">
        Agent 调用 <code className="rounded-sm bg-[#1e1e1e] px-1 font-mono text-[10px] text-[#4ec9b0]">{location.origin}/mcp</code>
      </div>
      {error && <div className="border-t border-[#252526] bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
      <form onSubmit={create} className="flex gap-1.5 px-3 pb-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="用途标识，如 claude-code"
          className="min-w-0 flex-1 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1 text-[12px] text-[#cccccc] outline-none focus:border-[#007acc]"
        />
        <button type="submit" className="shrink-0 rounded-sm bg-[#0e639c] px-2 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb]">生成</button>
      </form>
      {created && (
        <div className="mx-3 mb-2 rounded-sm border border-[#cca700]/60 bg-[#3b3116] p-2">
          <div className="mb-1 text-[11px] font-medium text-[#cca700]">Token 仅显示一次：</div>
          <div className="break-all font-mono text-[11px] text-[#4ec9b0]">{created}</div>
          <button onClick={() => setCreated(null)} className="mt-1 text-[10px] text-[#858585] hover:text-[#cccccc]">已保存，关闭</button>
        </div>
      )}
      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>已有 Token</div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {tokens.map((t) => (
          <div key={t.id} className="group flex items-center gap-1.5 rounded-sm px-2 py-[3px] text-[12px] hover:bg-[#2a2d2e]">
            <span className="truncate text-[#cccccc]">{t.name}</span>
            <span className="ml-auto hidden shrink-0 text-[10px] text-[#5a5a5a] group-hover:inline">{t.last_used_at ?? '未使用'}</span>
            <button title="吊销" className="hidden shrink-0 rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c] group-hover:block" onClick={() => void revoke(t)}>
              ×
            </button>
          </div>
        ))}
        {tokens.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无 Token</div>}
      </div>

      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>终端主题</div>
      <div className="px-3 pb-2">
        <div className="flex flex-col gap-1.5">
          {Object.entries(THEME_NAMES).map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center gap-2 text-[11px] text-[#858585]">
              <input
                type="radio"
                name="terminal-theme"
                checked={themeName === key}
                onChange={() => {
                  setTerminalTheme(key);
                  localStorage.setItem('ta-terminal-theme', key);
                }}
                className="accent-[#007acc]"
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>告警阈值</div>
      <div className="px-3 pb-2">
        <AlertThresholds />
      </div>

      <div className={`border-t border-[#1e1e1e] ${sectionCls}`}>危险命令规则</div>
      <div className="px-3 pb-2 text-[11px] leading-relaxed text-[#5a5a5a]">
        MCP 执行匹配规则的命令时：拦截（block）或弹窗审批（approve）
      </div>
      {error && <div className="px-3 pb-1 text-[11px] text-[#f14c4c]">{error}</div>}
      <form onSubmit={addRule} className="flex flex-col gap-1.5 px-3 pb-2">
        <input
          value={rulePattern}
          onChange={(e) => setRulePattern(e.target.value)}
          placeholder="正则，如 ^\\s*rm\\s+-rf\\s+/ "
          className="rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1 font-mono text-[11px] text-[#cccccc] outline-none focus:border-[#007acc]"
        />
        <div className="flex gap-1.5">
          <select
            value={ruleAction}
            onChange={(e) => setRuleAction(e.target.value as 'block' | 'approve')}
            className="rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-1.5 py-1 text-[11px] text-[#cccccc] outline-none"
          >
            <option value="block">拦截</option>
            <option value="approve">审批</option>
          </select>
          <input
            value={ruleNote}
            onChange={(e) => setRuleNote(e.target.value)}
            placeholder="说明"
            className="min-w-0 flex-1 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1 text-[11px] text-[#cccccc] outline-none focus:border-[#007acc]"
          />
          <button type="submit" className="shrink-0 rounded-sm bg-[#0e639c] px-2 py-1 text-[11px] text-white hover:bg-[#1177bb]">＋</button>
        </div>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {rules.map((r) => (
          <div key={r.id} className="group flex items-center gap-1.5 rounded-sm px-2 py-[3px] text-[11px] hover:bg-[#2a2d2e]">
            <span className={r.action === 'block' ? 'shrink-0 text-[#f14c4c]' : 'shrink-0 text-[#cca700]'}>
              {r.action === 'block' ? '⛔' : '⚠'}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[#9cdcfe]">{r.pattern}</span>
            <span className="hidden shrink-0 text-[#5a5a5a] group-hover:inline">{r.note}</span>
            <button
              title="删除"
              className="hidden shrink-0 rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c] group-hover:block"
              onClick={() => void removeRule(r.id)}
            >
              ×
            </button>
          </div>
        ))}
        {rules.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无规则</div>}
      </div>
    </div>
  );
}

export default function SideBar({ view }: { view: View }) {
  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-[#1e1e1e] bg-[#252526]">
      {view === 'terminals' && <SessionSideBar />}
      {view === 'hosts' && <HostsSideBar />}
      {view === 'sftp' && <SftpSideBar />}
      {view === 'forward' && <ForwardSideBar />}
      {view === 'audit' && <AuditSideBar />}
      {view === 'settings' && <SettingsSideBar />}
    </aside>
  );
}
