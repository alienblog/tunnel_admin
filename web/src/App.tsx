import { useEffect, useRef, useState } from 'react';
import { api, type ApprovalInfo } from './api';
import { getDesktop } from './desktop';
import { ws, type SessionInfo } from './ws';
import { useStore, type HostMetrics, type OuterTab, type Toast, type View } from './store';
import SideBar from './components/SideBar';
import Login from './pages/Login';
import Terminals from './pages/Terminals';
import ApprovalModal from './components/ApprovalModal';

const NAV: Array<{ view: View; label: string; icon: string }> = [
  { view: 'terminals', label: '终端', icon: 'terminal' },
  { view: 'hosts', label: '主机', icon: 'server' },
  { view: 'sftp', label: '文件', icon: 'folder' },
  { view: 'forward', label: '转发', icon: 'forward' },
];

/** 底部工具按钮：点击在外层打开工具 tab */
const TOOLS: Array<{ id: string; label: string; icon: string }> = [
  { id: 'transfer', label: '传输', icon: 'transfer' },
  { id: 'audit', label: '审计', icon: 'audit' },
  { id: 'settings', label: '设置', icon: 'settings' },
];

const ICONS: Record<string, React.ReactNode> = {
  terminal: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M1.5 3A1.5 1.5 0 013 1.5h10A1.5 1.5 0 0114.5 3v10a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 13V3zm2.19.47L6.31 6 3.69 8.53l.94.94 2.5-2.5a.75.75 0 000-1.06l-2.5-2.5-.94.94zM7.5 8.5a.75.75 0 000 1.5h3a.75.75 0 000-1.5h-3z" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M1.5 2A1.5 1.5 0 013 .5h10A1.5 1.5 0 0114.5 2v3A1.5 1.5 0 0113 6.5H3A1.5 1.5 0 011.5 5V2zm0 9A1.5 1.5 0 013 9.5h10a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5H3A1.5 1.5 0 011.5 14v-3zm2-7.5a.75.75 0 100-1.5.75.75 0 000 1.5zm0 9a.75.75 0 100-1.5.75.75 0 000 1.5z" />
    </svg>
  ),
  folder: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
    </svg>
  ),
  forward: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M1 8a.75.75 0 01.75-.75h9.19L8.47 4.78a.75.75 0 111.06-1.06l3.75 3.75a.75.75 0 010 1.06l-3.75 3.75a.75.75 0 11-1.06-1.06l2.47-2.47H1.75A.75.75 0 011 8z" />
    </svg>
  ),
  audit: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M2 3.75A.75.75 0 012.75 3h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4A.75.75 0 012.75 7h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.75zm0 4A.75.75 0 012.75 11h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 012 11.75z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M6.5 1.5a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75V2.9a4.25 4.25 0 011.8 1.04l1.46-.6a.75.75 0 01.97.34l.75 1.3a.75.75 0 01-.25 1L13.5 7a4.3 4.3 0 010 2l1.23.96a.75.75 0 01.25 1l-.75 1.3a.75.75 0 01-.97.34l-1.46-.6a4.25 4.25 0 01-1.8 1.04v1.76a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75v-1.76a4.25 4.25 0 01-1.8-1.04l-1.46.6a.75.75 0 01-.97-.34l-.75-1.3a.75.75 0 01.25-1L2.5 9a4.3 4.3 0 010-2L1.27 6.04a.75.75 0 01-.25-1l.75-1.3a.75.75 0 01.97-.34l1.46.6a4.25 4.25 0 011.8-1.04V1.5zM8 5.25A2.75 2.75 0 108 10.75 2.75 2.75 0 008 5.25z" />
    </svg>
  ),
  transfer: (
    <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
      <path d="M8 1.5a.75.75 0 01.75.75v9.19l2.47-2.47a.75.75 0 111.06 1.06l-3.75 3.75a.75.75 0 01-1.06 0l-3.75-3.75a.75.75 0 111.06-1.06l2.47 2.47V2.25A.75.75 0 018 1.5z" />
    </svg>
  ),
};

function ActivityBar({
  view,
  setView,
  collapsed,
  setCollapsed,
}: {
  view: View;
  setView: (v: View) => void;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
}) {
  const openOuterTab = useStore((s) => s.openOuterTab);
  const activeOuterId = useStore((s) => s.activeOuterId);

  return (
    <div className="flex w-12 shrink-0 flex-col items-center bg-[#333333] py-1">
      {/* 顶部：侧边栏收起/展开 */}
      <button
        title={collapsed ? '展开侧边栏' : '收起侧边栏'}
        onClick={() => setCollapsed(!collapsed)}
        className={`flex h-12 w-12 items-center justify-center ${collapsed ? 'text-white' : 'text-[#858585] hover:text-white'}`}
      >
        <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
          {collapsed ? (
            <path d="M2.75 2.5A1.75 1.75 0 001 4.25v7.5c0 .966.784 1.75 1.75 1.75h3a.75.75 0 000-1.5h-3a.25.25 0 01-.25-.25v-7.5a.25.25 0 01.25-.25h3a.75.75 0 000-1.5h-3zM6.47 5.47a.75.75 0 011.06 0L10 7.94l2.47-2.47a.75.75 0 111.06 1.06l-3 3a.75.75 0 01-1.06 0l-3-3a.75.75 0 010-1.06zM14.25 12.5a.75.75 0 010 1.5h-6.5a.75.75 0 010-1.5h6.5z" />
          ) : (
            <path d="M2.75 2.5A1.75 1.75 0 001 4.25v7.5c0 .966.784 1.75 1.75 1.75h3a.75.75 0 000-1.5h-3a.25.25 0 01-.25-.25v-7.5a.25.25 0 01.25-.25h3a.75.75 0 000-1.5h-3zM13.53 5.47a.75.75 0 010 1.06L11.06 9l2.47 2.47a.75.75 0 11-1.06 1.06l-3-3a.75.75 0 010-1.06l3-3a.75.75 0 011.06 0zM14.25 2.5a.75.75 0 010 1.5h-6.5a.75.75 0 010-1.5h6.5z" />
          )}
        </svg>
      </button>
      {NAV.map((n) => (
        <button
          key={n.view}
          title={n.label}
          onClick={() => {
            // 点击当前视图图标：收起/展开侧边栏（VSCode 行为）
            if (view === n.view && !collapsed) {
              setCollapsed(true);
            } else {
              setCollapsed(false);
              setView(n.view);
            }
          }}
          className={`relative flex h-12 w-12 items-center justify-center transition-colors ${
            view === n.view && !collapsed ? 'text-white' : 'text-[#858585] hover:text-white'
          }`}
        >
          {view === n.view && !collapsed && <span className="absolute top-0 left-0 h-full w-0.5 bg-white" />}
          {ICONS[n.icon]}
        </button>
      ))}
      <div className="flex-1" />
      {TOOLS.map((t) => {
        const tab: OuterTab =
          t.id === 'transfer'
            ? { kind: 'transfer', id: 'transfer' }
            : t.id === 'audit'
              ? { kind: 'audit', id: 'audit' }
              : { kind: 'settings', id: 'settings' };
        const active = activeOuterId === t.id;
        return (
          <button
            key={t.id}
            title={t.label}
            onClick={() => openOuterTab(tab)}
            className={`relative flex h-12 w-12 items-center justify-center transition-colors ${
              active ? 'text-white' : 'text-[#858585] hover:text-white'
            }`}
          >
            {active && <span className="absolute top-0 left-0 h-full w-0.5 bg-white" />}
            {ICONS[t.icon]}
          </button>
        );
      })}
      {/* 桌面版（免登录）不显示退出登录 */}
      {!getDesktop() && (
        <button
          title="退出登录"
          onClick={() => {
            void api('/api/logout', { method: 'POST' }).finally(() => {
              ws.close();
              useStore.getState().setAuthed(false);
            });
          }}
          className="flex h-12 w-12 items-center justify-center text-[#858585] hover:text-white"
        >
          <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor">
            <path d="M6.5 8a.75.75 0 001.5 0V1.75a.75.75 0 00-1.5 0V8zm-3.17 1.41a.75.75 0 10-1.06-1.06l-1.5 1.5a.75.75 0 000 1.06l1.5 1.5a.75.75 0 101.06-1.06l-.97-.97h3.14a.75.75 0 000-1.5H2.36l.97-.97zM8 3.5a.75.75 0 000-1.5H5.5A1.5 1.5 0 004 3.5V5a.75.75 0 001.5 0V3.5H8z" />
          </svg>
        </button>
      )}
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${n}B`;
}

function fmtRate(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K/s`;
  return `${n.toFixed(0)}B/s`;
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 130;
  const h = 26;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`);
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function MetricsBar() {
  const metrics = useStore((s) => s.metrics);
  const activeTabId = useStore((s) => s.activeTabId);
  // 原始值 selector（对象/数组每次都是新引用会触发无限重渲染）
  const activeHostName = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.hostName ?? null);
  const activeHostId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.hostId ?? null);
  // 指标历史（环形缓冲，每主机独立）与告警去重标记
  const histRef = useRef<Record<number, { cpu: number[]; mem: number[]; rx: number[]; tx: number[] }>>({});
  const alertedRef = useRef<Record<string, boolean>>({});
  const [hist, setHist] = useState<{ cpu: number[]; mem: number[]; rx: number[]; tx: number[] } | null>(null);

  useEffect(() => {
    const poll = async (): Promise<void> => {
      const st = useStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab) {
        st.setMetrics(null);
        setHist(null);
        return;
      }
      try {
        const m = await api<HostMetrics>(`/api/metrics?hostId=${tab.hostId}`);
        st.setMetrics(m);
        // 历史缓冲（cap 60 点 ≈ 3 分钟）
        const h = histRef.current[tab.hostId] ?? { cpu: [], mem: [], rx: [], tx: [] };
        const memPct = m.mem.total > 0 ? (m.mem.used / m.mem.total) * 100 : 0;
        const diskTotal = m.disks.reduce((a, d) => a + d.total, 0);
        const diskPct = diskTotal > 0 ? (m.disks.reduce((a, d) => a + d.used, 0) / diskTotal) * 100 : 0;
        h.cpu.push(m.cpu ?? 0);
        h.mem.push(memPct);
        h.rx.push(m.net.rxRate);
        h.tx.push(m.net.txRate);
        if (h.cpu.length > 60) {
          h.cpu.shift();
          h.mem.shift();
          h.rx.shift();
          h.tx.shift();
        }
        histRef.current[tab.hostId] = h;
        if (tab.id === st.activeTabId) setHist({ cpu: [...h.cpu], mem: [...h.mem], rx: [...h.rx], tx: [...h.tx] });
        // 告警检查（超限通知一次，恢复后重置）
        const th = st.alertThresholds;
        const checks: Array<[string, number, number]> = [
          ['cpu', m.cpu ?? 0, th.cpu],
          ['mem', memPct, th.mem],
          ['disk', diskPct, th.disk],
        ];
        for (const [key, val, limit] of checks) {
          const flag = `${tab.hostId}:${key}`;
          if (val >= limit && !alertedRef.current[flag]) {
            alertedRef.current[flag] = true;
            st.pushToast({
              hostName: tab.hostName,
              kind: 'warning',
              text: `${key.toUpperCase()} 超过阈值 ${limit}%（当前 ${val.toFixed(0)}%）`,
            });
          } else if (val < limit - 5 && alertedRef.current[flag]) {
            alertedRef.current[flag] = false;
          }
        }
      } catch {
        // 保留上次数据
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeHostId]);

  if (!activeHostName || !metrics) return null;
  const memPct = metrics.mem.total > 0 ? Math.round((metrics.mem.used / metrics.mem.total) * 100) : 0;
  const diskTotal = metrics.disks.reduce((a, d) => a + d.total, 0);
  const diskUsed = metrics.disks.reduce((a, d) => a + d.used, 0);
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  return (
    <div className="group relative flex items-center gap-1.5">
      <span className="font-medium">{activeHostName}</span>
      <span className="opacity-90">CPU {metrics.cpu ?? '--'}%</span>
      <span className="opacity-90">MEM {memPct}%</span>
      <span className="opacity-90">DISK {diskPct}%</span>
      <span className="opacity-90">↓{fmtRate(metrics.net.rxRate)} ↑{fmtRate(metrics.net.txRate)}</span>
      {/* 悬停详情 */}
      <div className="pointer-events-none absolute bottom-7 left-0 z-50 hidden w-72 rounded-sm border border-[#3c3c3c] bg-[#252526] p-3 text-[12px] shadow-2xl group-hover:block">
        <div className="mb-2 font-medium text-[#cccccc]">
          {activeHostName}
          <span className="ml-2 text-[10px] text-[#5a5a5a]">{metrics.cores} 核</span>
        </div>
        <div className="mb-1 flex justify-between text-[#858585]">
          <span>CPU</span>
          <span className="text-[#cccccc]">{metrics.cpu ?? '--'}%</span>
        </div>
        <div className="mb-1 flex justify-between text-[#858585]">
          <span>负载</span>
          <span className="font-mono text-[#cccccc]">{metrics.load.map((v) => v.toFixed(2)).join('  ')}</span>
        </div>
        <div className="mb-1 flex justify-between text-[#858585]">
          <span>内存</span>
          <span className="text-[#cccccc]">
            {fmtBytes(metrics.mem.used)} / {fmtBytes(metrics.mem.total)} ({memPct}%)
          </span>
        </div>
        <div className="mb-2 h-1 overflow-hidden rounded bg-[#3c3c3c]">
          <div className="h-full bg-[#0e639c]" style={{ width: `${memPct}%` }} />
        </div>
        <div className="mb-1 text-[#858585]">磁盘</div>
        {metrics.disks.slice(0, 4).map((d) => {
          const p = d.total > 0 ? Math.round((d.used / d.total) * 100) : 0;
          return (
            <div key={d.mount} className="mb-1.5">
              <div className="flex items-center justify-between gap-2 text-[11px] text-[#858585]">
                <span className="min-w-0 flex-1 break-all font-mono">{d.mount}</span>
                <span className="shrink-0 text-[#cccccc]">
                  {fmtBytes(d.used)} / {fmtBytes(d.total)} ({p}%)
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded bg-[#3c3c3c]">
                <div
                  className={`h-full ${p > 85 ? 'bg-[#f14c4c]' : p > 70 ? 'bg-[#cca700]' : 'bg-[#0e639c]'}`}
                  style={{ width: `${p}%` }}
                />
              </div>
            </div>
          );
        })}
        <div className="mb-1 mt-2 flex justify-between text-[#858585]">
          <span>网络</span>
          <span className="font-mono text-[#cccccc]">↓ {fmtRate(metrics.net.rxRate)}  ↑ {fmtRate(metrics.net.txRate)}</span>
        </div>
        {metrics.net.interfaces.slice(0, 3).map((i) => (
          <div key={i.name} className="flex items-center justify-between gap-2 text-[11px] text-[#5a5a5a]">
            <span className="min-w-0 flex-1 break-all font-mono">{i.name}</span>
            <span className="shrink-0">RX {fmtBytes(i.rx)} · TX {fmtBytes(i.tx)}</span>
          </div>
        ))}
        {/* 历史趋势（近 3 分钟） */}
        {hist && hist.cpu.length >= 2 && (
          <div className="mt-2 border-t border-[#3c3c3c] pt-2">
            <div className="mb-1 text-[#858585]">近 3 分钟趋势</div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#5a5a5a]">CPU</span>
              <Sparkline data={hist.cpu} color="#4fc1ff" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#5a5a5a]">内存</span>
              <Sparkline data={hist.mem} color="#4ec9b0" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#5a5a5a]">网络↓</span>
              <Sparkline data={hist.rx} color="#cca700" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBar() {
  const mcpCount = useStore((s) => s.mcpSessions.length);
  const tabCount = useStore((s) => s.tabs.length);
  const view = useStore((s) => s.view);
  const quickCommands = useStore((s) => s.quickCommands);
  const pushToast = useStore((s) => s.pushToast);
  const label = NAV.find((n) => n.view === view)?.label ?? '';

  /** 在激活终端执行快捷命令 */
  const runQuick = (cmd: string): void => {
    const st = useStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    if (!tab?.streamId) {
      pushToast({ hostName: '快捷命令', kind: 'warning', text: '没有可执行命令的激活终端' });
      return;
    }
    ws.send({ type: 'terminal:input', streamId: tab.streamId, data: `${cmd}\r` });
  };

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 bg-[#007acc] px-3 text-[12px] text-white">
      <span className="whitespace-nowrap">🤖 agent 会话 {mcpCount}</span>
      <span className="whitespace-nowrap">终端 {tabCount}</span>
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
      {/* 快捷命令（name 显示 / value 执行，| 分隔） */}
      <div className="flex min-w-0 items-center overflow-x-auto whitespace-nowrap">
        {quickCommands.map((c, i) => (
          <span key={i} className="flex items-center">
            {i > 0 && <span className="mx-1 text-white/40">|</span>}
            <button
              title={`在激活终端执行：${c.value}`}
              onClick={() => runQuick(c.value)}
              className="rounded-sm px-1 py-0.5 text-white/90 hover:bg-white/15"
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <div className="flex-1" />
      {/* 右侧：性能监控 */}
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <MetricsBar />
      </div>
      <span className="hidden whitespace-nowrap md:inline">MCP: {location.origin}/mcp</span>
      <span className="whitespace-nowrap">v0.2.2</span>
    </div>
  );
}

export default function App() {
  const authed = useStore((s) => s.authed);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useStore((s) => s.setSidebarCollapsed);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api<{ authenticated: boolean }>('/api/me')
      .then((r) => {
        if (r.authenticated) {
          // 先恢复工作区（必须在 setAuthed 之前：setAuthed 会触发持久化订阅，避免空状态覆盖已保存数据）
          useStore.getState().restoreWorkspace();
          useStore.getState().setAuthed(true);
          ws.connect();
          void useStore.getState().loadHosts();
          // 初始同步：活跃会话列表（刷新页面后恢复 agent 会话 tab）
          void api<SessionInfo[]>('/api/sessions').then((list) => {
            const st = useStore.getState();
            const known = new Set(st.tabs.filter((t) => t.kind === 'agent').map((t) => t.sessionId));
            const fresh = list.filter((s) => s.source === 'mcp' && !known.has(s.sessionId));
            if (fresh.length > 0) {
              const hasActive = st.activeTabId !== null;
              fresh.forEach((s, i) => st.addAgentTab(s, { activate: !hasActive && i === fresh.length - 1 }));
            }
            st.updateSessions(list);
          });
          void api<ApprovalInfo[]>('/api/approvals/pending').then((list) => {
            for (const a of list) useStore.getState().upsertApproval(a);
          });
        }
      })
      .catch(() => useStore.getState().setAuthed(false))
      .finally(() => setChecking(false));

    const onUnauth = (): void => {
      ws.close();
      useStore.getState().setAuthed(false);
    };
    window.addEventListener('ta:unauthorized', onUnauth);

    const offApprovalNew = ws.on('approval:new', (e) => {
      useStore.getState().upsertApproval({
        id: e.approvalId,
        hostId: 0,
        hostName: e.hostName,
        host: e.host,
        port: e.port,
        username: e.username,
        source: e.source,
        kind: e.kind,
        command: e.command,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
    });
    const offApprovalResolved = ws.on('approval:resolved', (e) => {
      useStore.getState().removeApproval(e.approvalId);
    });
    const offSessions = ws.on('sessions:update', (e) => {
      const st = useStore.getState();
      // 新出现的 agent 会话：自动打开 tab（已有 tab 的不重复开）
      const known = new Set(st.tabs.filter((t) => t.kind === 'agent').map((t) => t.sessionId));
      const fresh = e.sessions.filter((s) => s.source === 'mcp' && !known.has(s.sessionId));
      if (fresh.length > 0) {
        // 有正在工作的连接实例（活动 tab）→ 静默打开；否则选中最新一个
        const hasActive = st.activeTabId !== null;
        fresh.forEach((s, i) => st.addAgentTab(s, { activate: !hasActive && i === fresh.length - 1 }));
      }
      useStore.getState().updateSessions(e.sessions);
    });

    return () => {
      window.removeEventListener('ta:unauthorized', onUnauth);
      offApprovalNew();
      offApprovalResolved();
      offSessions();
      ws.close();
    };
  }, []);

  useEffect(() => {
    // 页面卸载标记：刷新/关闭时不销毁 tmux 持久会话
    const markUnloading = (): void => {
      (window as unknown as { __taUnloading?: boolean }).__taUnloading = true;
    };
    window.addEventListener('beforeunload', markUnloading);
    window.addEventListener('pagehide', markUnloading);
    return () => {
      window.removeEventListener('beforeunload', markUnloading);
      window.removeEventListener('pagehide', markUnloading);
    };
  }, []);

  useEffect(() => {
    // 工作区变化自动持久化（延迟一帧：避免加载流程中空状态覆盖已保存数据）
    const unsub = useStore.subscribe((s) => {
      setTimeout(() => s.saveWorkspace(), 0);
    });
    return unsub;
  }, []);

  if (checking) {
    return <div className="flex h-screen items-center justify-center bg-[#1e1e1e] text-[#858585]">加载中…</div>;
  }
  if (!authed) return <Login />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      <div className="flex min-h-0 flex-1">
        <ActivityBar
          view={view}
          setView={setView}
          collapsed={sidebarCollapsed}
          setCollapsed={setSidebarCollapsed}
        />
        {!sidebarCollapsed && <SideBar view={view} />}
        {/* 编辑区：始终显示终端标签组，不随活动栏切换（VSCode 行为） */}
        <main className="min-w-0 flex-1">
          <Terminals />
        </main>
      </div>
      <StatusBar />
      <ApprovalModal />
      <ToastStack />
    </div>
  );
}

/** 右下角命令完成通知 */
function ToastStack() {
  const toasts = useStore((s) => s.toasts);
  const removeToast = useStore((s) => s.removeToast);
  const styles: Record<Toast['kind'], string> = {
    success: 'border-[#4ec9b0]/60 text-[#4ec9b0]',
    warning: 'border-[#cca700]/60 text-[#cca700]',
    error: 'border-[#f14c4c]/60 text-[#f14c4c]',
  };
  const icons: Record<Toast['kind'], string> = { success: '✓', warning: '⚠', error: '✗' };
  return (
    <div
      data-testid="toast-stack"
      className="pointer-events-none fixed top-4 right-4 z-40 flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => removeToast(t.id)}
          className={`pointer-events-auto rounded-sm border bg-[#252526]/95 px-4 py-2.5 text-left text-sm shadow-xl backdrop-blur ${styles[t.kind]}`}
        >
          <div className="font-medium">
            {icons[t.kind]} 🤖 {t.hostName} · 命令完成
          </div>
          <div className="mt-0.5 text-xs text-[#858585]">{t.text}</div>
        </button>
      ))}
    </div>
  );
}
