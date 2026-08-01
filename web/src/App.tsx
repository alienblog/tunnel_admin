import { useEffect, useState } from 'react';
import { api, type ApprovalInfo } from './api';
import { ws, type SessionInfo } from './ws';
import { useStore, type HostMetrics, type Toast, type View } from './store';
import SideBar from './components/SideBar';
import Login from './pages/Login';
import Terminals from './pages/Terminals';
import ApprovalModal from './components/ApprovalModal';

const NAV: Array<{ view: View; label: string; icon: string }> = [
  { view: 'terminals', label: '终端', icon: 'terminal' },
  { view: 'hosts', label: '主机', icon: 'server' },
  { view: 'sftp', label: '文件', icon: 'folder' },
  { view: 'forward', label: '转发', icon: 'forward' },
  { view: 'audit', label: '审计', icon: 'audit' },
  { view: 'settings', label: '设置', icon: 'settings' },
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
};

function ActivityBar({ view, setView }: { view: View; setView: (v: View) => void }) {  return (
    <div className="flex w-12 shrink-0 flex-col items-center bg-[#333333] py-1">
      {NAV.map((n) => (
        <button
          key={n.view}
          title={n.label}
          onClick={() => setView(n.view)}
          className={`relative flex h-12 w-12 items-center justify-center transition-colors ${
            view === n.view ? 'text-white' : 'text-[#858585] hover:text-white'
          }`}
        >
          {view === n.view && <span className="absolute top-0 left-0 h-full w-0.5 bg-white" />}
          {ICONS[n.icon]}
        </button>
      ))}
      <div className="flex-1" />
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

function MetricsBar() {
  const metrics = useStore((s) => s.metrics);
  const activeTabId = useStore((s) => s.activeTabId);
  // 原始值 selector（对象/数组每次都是新引用会触发无限重渲染）
  const activeHostName = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.hostName ?? null);
  const activeHostId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.hostId ?? null);

  const activeHostIdRef = activeHostId; // 供轮询使用

  useEffect(() => {
    const poll = async (): Promise<void> => {
      const st = useStore.getState();
      const tab = st.tabs.find((t) => t.id === st.activeTabId);
      if (!tab) {
        st.setMetrics(null);
        return;
      }
      try {
        const m = await api<HostMetrics>(`/api/metrics?hostId=${tab.hostId}`);
        st.setMetrics(m);
      } catch {
        // 保留上次数据
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, activeHostIdRef]);

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
      </div>
    </div>
  );
}

function StatusBar() {
  const mcpCount = useStore((s) => s.mcpSessions.length);
  const tabCount = useStore((s) => s.tabs.length);
  const view = useStore((s) => s.view);
  const label = NAV.find((n) => n.view === view)?.label ?? '';
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 bg-[#007acc] px-3 text-[12px] text-white">
      <span className="whitespace-nowrap">🤖 agent 会话 {mcpCount}</span>
      <span className="whitespace-nowrap">终端 {tabCount}</span>
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap">
        <MetricsBar />
      </div>
      <div className="flex-1" />
      <span className="hidden whitespace-nowrap md:inline">MCP: {location.origin}/mcp</span>
      <span className="whitespace-nowrap">v0.1.0</span>
    </div>
  );
}

export default function App() {
  const authed = useStore((s) => s.authed);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api<{ authenticated: boolean }>('/api/me')
      .then((r) => {
        if (r.authenticated) {
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

  if (checking) {
    return <div className="flex h-screen items-center justify-center bg-[#1e1e1e] text-[#858585]">加载中…</div>;
  }
  if (!authed) return <Login />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#1e1e1e] text-[#cccccc]">
      <div className="flex min-h-0 flex-1">
        <ActivityBar view={view} setView={setView} />
        <SideBar view={view} />
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
      className="pointer-events-none fixed right-4 bottom-8 z-40 flex w-80 flex-col gap-2"
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
