import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { THEMES } from '../themes';
import ReplayOverlay from './ReplayOverlay';
import { api } from '../api';
import { ws } from '../ws';
import { useStore, type TerminalTab } from '../store';


interface CompletionItem {
  text: string;
  type: 'cmd' | 'file' | 'dir';
}

interface CompletionState {
  items: CompletionItem[];
  selected: number;
  kind: 'cmd' | 'path';
  prefix: string;
  x: number;
  y: number;
}

/** 从输入缓冲与光标位置推导补全上下文 */
function getCompletionContext(buf: string, cursor: number): { kind: 'cmd' | 'path'; prefix: string; force: boolean } | null {
  const before = buf.slice(0, cursor);
  const firstSpace = before.indexOf(' ');
  if (firstSpace === -1) {
    if (before.trim() === '') return null;
    return { kind: 'cmd', prefix: before, force: true };
  }
  const lastWord = before.split(' ').pop() ?? '';
  if (lastWord === '') return null; // 空格结尾：不自动弹出（Tab 仍可强制）
  return { kind: 'path', prefix: lastWord, force: false };
}

/** 简化路径规范化（处理 . / ..，保留 ~ 前缀由服务端展开） */
function resolveCwd(cur: string | null, arg: string): string {
  if (arg.startsWith('/')) return arg;
  if (arg === '~' || arg.startsWith('~/')) return arg;
  const base = cur ?? '~';
  const combined = `${base.replace(/\/+$/, '')}/${arg}`;
  const stack: string[] = [];
  for (const seg of combined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  const out = '/' + stack.join('/');
  return out === '/' ? '/' : out;
}

export default function TerminalView({ tab }: { tab: TerminalTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const streamIdRef = useRef<string | null>(null);
  const setTabStatus = useStore((s) => s.setTabStatus);
  const activeTabId = useStore((s) => s.activeTabId);

  // ---- 输入缓冲（命令补全模型） ----
  const cmdBufRef = useRef('');
  const cursorRef = useRef(0);
  const cwdRef = useRef<string | null>(null);
  const completionRef = useRef<CompletionState | null>(null);
  const autoTimerRef = useRef<number | undefined>(undefined);
  const completeSeqRef = useRef(0);

  // ---- pwd 检测 ----
  const pwdPendingRef = useRef(false);
  const pwdBufRef = useRef('');
  const pwdTimerRef = useRef<number | undefined>(undefined);

  const [completion, setCompletion] = useState<CompletionState | null>(null);
  // 搜索状态
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchInfo, setSearchInfo] = useState('');
  const themeName = useStore((s) => s.terminalTheme);
  // 录制缓冲（帧：相对时间戳 + 数据，cap 10000）
  const recordingRef = useRef<Array<{ t: number; data: string }>>([]);
  const [replayOpen, setReplayOpen] = useState(false);
  // 连接状态徽标（不写入终端文本）：connecting 常驻 / connected 2s 淡出 / error、closed 常驻
  const [connBadge, setConnBadge] = useState<{ kind: 'connecting' | 'connected' | 'error' | 'closed'; text: string } | null>(null);
  const badgeTimerRef = useRef<number | undefined>(undefined);
  // 自动重连状态（SSH 断开/连接失败后定时重试）
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  /** exit 无 reason 时的延迟确认计时（等待 connection-lost 升级） */
  const exitTimerRef = useRef<number | undefined>(undefined);
  const pushToast = useStore((s) => s.pushToast);

  const isActive = activeTabId === tab.id;
  const isAgent = tab.kind === 'agent';

  const closeCompletion = (): void => {
    completionRef.current = null;
    setCompletion(null);
  };

  const requestCompletion = async (force: boolean): Promise<void> => {
    const buf = cmdBufRef.current;
    const cur = cursorRef.current;
    const ctx = getCompletionContext(buf, cur);
    if (!ctx || (!force && !ctx.force)) {
      closeCompletion();
      return;
    }
    const seq = ++completeSeqRef.current;
    try {
      const r = await api<{ items: CompletionItem[] }>(
        `/api/complete?hostId=${tab.hostId}&kind=${ctx.kind}&prefix=${encodeURIComponent(ctx.prefix)}&cwd=${encodeURIComponent(cwdRef.current ?? '~')}`,
      );
      if (seq !== completeSeqRef.current || r.items.length === 0) return;
      const term = termRef.current;
      if (!term) return;
      // 光标位置 → 像素
      const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { actualCellWidth: number; actualCellHeight: number } } } })._core?._renderService?.dimensions;
      const cellW = dims?.actualCellWidth ?? 8;
      const cellH = dims?.actualCellHeight ?? 13;
      const state: CompletionState = {
        items: r.items,
        selected: 0,
        kind: ctx.kind,
        prefix: ctx.prefix,
        x: Math.round(term.buffer.active.cursorX * cellW),
        y: Math.round(term.buffer.active.cursorY * cellH),
      };
      completionRef.current = state;
      setCompletion(state);
    } catch {
      // 补全失败静默
    }
  };

  const applyCompletion = (): void => {
    const comp = completionRef.current;
    if (!comp) return;
    const item = comp.items[comp.selected];
    let suffix = item.text.slice(comp.prefix.length);
    if (comp.kind === 'path' && item.type === 'dir' && !item.text.endsWith('/')) {
      suffix += '/';
    }
    if (suffix === '') {
      closeCompletion();
      return;
    }
    if (streamIdRef.current) {
      ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: suffix });
    }
    const cur = cursorRef.current;
    cmdBufRef.current = cmdBufRef.current.slice(0, cur) + suffix + cmdBufRef.current.slice(cur);
    cursorRef.current = cur + suffix.length;
    closeCompletion();
  };

  const scheduleAuto = (): void => {
    clearTimeout(autoTimerRef.current);
    autoTimerRef.current = window.setTimeout(() => void requestCompletion(false), 200);
  };

  const parseEnterCommand = (): void => {
    const cmd = cmdBufRef.current.trim();
    const m = cmd.match(/^cd(?:\s+(.+))?$/);
    if (m) {
      cwdRef.current = resolveCwd(cwdRef.current, (m[1] ?? '~').trim());
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      theme: THEMES[useStore.getState().terminalTheme] ?? THEMES['dark-plus'],
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchAddonRef.current = search;
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;

    try {
      fit.fit();
    } catch {
      // 容器尚未布局完成时忽略
    }

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // 隐藏状态（display:none）下无法 fit
      }
    });
    ro.observe(container);

    // 输入：补全拦截 + 缓冲维护 + 终端发送
    const onData = term.onData((d) => {
      if (tab.ended) return;
      // Ctrl+F：打开搜索
      if (d === '\x06') {
        setSearchOpen(true);
        return;
      }
      const comp = completionRef.current;

      // 浮层打开时的按键拦截
      if (comp) {
        if (d === '\r' || d === '\t') {
          applyCompletion();
          return;
        }
        if (d === '\x1b[A') {
          completionRef.current = { ...comp, selected: Math.max(0, comp.selected - 1) };
          setCompletion(completionRef.current);
          return;
        }
        if (d === '\x1b[B') {
          completionRef.current = { ...comp, selected: Math.min(comp.items.length - 1, comp.selected + 1) };
          setCompletion(completionRef.current);
          return;
        }
        if (d.startsWith('\x1b')) {
          closeCompletion();
          return;
        }
        closeCompletion();
        // 继续作为普通输入处理
      }

      // Tab：触发补全（不发送到 shell）
      if (d === '\t') {
        void requestCompletion(true);
        return;
      }

      if (streamIdRef.current) ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: d });

      if (d === '\r' || d === '\n') {
        parseEnterCommand();
        // pwd 命令检测：回车时若缓冲的命令行为 pwd，等待输出中的路径行
        if (cmdBufRef.current.trim() === 'pwd') {
          pwdPendingRef.current = true;
          pwdBufRef.current = '';
          clearTimeout(pwdTimerRef.current);
          pwdTimerRef.current = window.setTimeout(() => {
            pwdPendingRef.current = false;
            pwdBufRef.current = '';
          }, 3000);
        }
        cmdBufRef.current = '';
        cursorRef.current = 0;
        clearTimeout(autoTimerRef.current);
      } else if (d === '\x7f' || d === '\b') {
        const cur = cursorRef.current;
        if (cur > 0) {
          cmdBufRef.current = cmdBufRef.current.slice(0, cur - 1) + cmdBufRef.current.slice(cur);
          cursorRef.current = cur - 1;
        }
        scheduleAuto();
      } else if (d === '\x1b[D') {
        cursorRef.current = Math.max(0, cursorRef.current - 1);
      } else if (d === '\x1b[C') {
        cursorRef.current = Math.min(cmdBufRef.current.length, cursorRef.current + 1);
      } else if (d === '\x1b[A' || d === '\x1b[B') {
        // 历史命令：缓冲失效
        cmdBufRef.current = '';
        cursorRef.current = 0;
        closeCompletion();
      } else if (!d.startsWith('\x1b')) {
        // 多行粘贴确认（防误操作）
        if (d.length > 1 && /[\r\n]/.test(d)) {
          if (!window.confirm(`检测到多行粘贴（${d.length} 字符），确认发送到终端？`)) return;
        }
        const cur = cursorRef.current;
        cmdBufRef.current = cmdBufRef.current.slice(0, cur) + d + cmdBufRef.current.slice(cur);
        cursorRef.current = cur + d.length;
        scheduleAuto();
      }
    });

    const onResize = term.onResize(({ cols, rows }) => {
      if (streamIdRef.current) ws.send({ type: 'terminal:resize', streamId: streamIdRef.current, cols, rows });
    });

    // 服务端终端流 → xterm
    // 自动重连：SSH 断开/连接失败后定时重试 open（同一 TerminalView 实例，xterm 内容保留）
    const stopReconnect = (): void => {
      shouldReconnectRef.current = false;
      reconnectAttemptRef.current = 0;
      window.clearTimeout(reconnectTimerRef.current);
    };
    const scheduleReconnect = (): void => {
      if (!shouldReconnectRef.current) return;
      reconnectAttemptRef.current += 1;
      // 指数退避：5s → 10s → 20s → 30s 封顶
      const delay = Math.min(5000 * 2 ** (reconnectAttemptRef.current - 1), 30000);
      setConnBadge({ kind: 'connecting', text: `连接断开，${Math.round(delay / 1000)}s 后重连（第 ${reconnectAttemptRef.current} 次）` });
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = window.setTimeout(() => {
        if (!shouldReconnectRef.current) return;
        streamIdRef.current = null;
        ws.send({
          type: 'terminal:open',
          reqId: tab.id,
          hostId: tab.hostId,
          cols: term.cols,
          rows: term.rows,
          tmuxId: tab.id,
        });
      }, delay);
    };

    const offData = ws.on('terminal:data', (e) => {
      if (e.streamId !== streamIdRef.current) return;
      term.write(e.data);
      // 录制：记录相对时间戳（供回放）
      const rec = recordingRef.current;
      rec.push({ t: Date.now(), data: e.data });
      if (rec.length > 10000) rec.shift();
      // 等待 pwd 输出：首个以 / 开头且无空格的完整行即当前路径 → 文件树定位 + 校正 cwd
      if (pwdPendingRef.current) {
        pwdBufRef.current += e.data;
        const clean = pwdBufRef.current.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const hit = clean.split(/\r?\n|\r/).find((l) => l.trim().startsWith('/') && !l.includes(' '));
        if (hit) {
          pwdPendingRef.current = false;
          pwdBufRef.current = '';
          clearTimeout(pwdTimerRef.current);
          const p = hit.trim();
          if (p.startsWith('/')) {
            cwdRef.current = p;
            useStore.getState().setSftp({ revealPath: p });
          }
        }
      }
    });

    const offExit = ws.on('terminal:exit', (e) => {
      if (e.streamId === streamIdRef.current) {
        if (e.reason === 'connection-lost') {
          // SSH 连接断开（如主机重启）：自动重连，终端内容保留（agent 会话由 MCP 管理，不重连）
          window.clearTimeout(exitTimerRef.current);
          shouldReconnectRef.current = true;
          setTabStatus(tab.id, { status: 'closed' });
          pushToast({ hostName: tab.hostName, kind: 'warning', text: 'SSH 连接断开，正在自动重连…' });
          scheduleReconnect();
          return;
        }
        // 无 reason 的 exit（channel close）：延迟确认——连接断开时紧随其后的
        // connection-lost 事件会接管；正常退出（shell 关闭）则延迟后按关闭处理
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = window.setTimeout(() => {
          if (shouldReconnectRef.current) return;
          setTabStatus(tab.id, { status: 'closed' });
          setConnBadge({ kind: 'closed', text: '会话已关闭' });
          pushToast({ hostName: tab.hostName, kind: 'warning', text: '终端会话已关闭' });
        }, 300);
      }
    });
    const offReady = ws.on('terminal:ready', (e) => {
      if (e.reqId !== tab.id) return;
      streamIdRef.current = e.streamId;
      setTabStatus(tab.id, { status: 'connected', streamId: e.streamId });
      const wasReconnect = reconnectAttemptRef.current > 0;
      stopReconnect();
      // 已连接徽标 2 秒后淡出（重连成功时显示「已重连」）
      setConnBadge({ kind: 'connected', text: wasReconnect ? '已重连' : '已连接' });
      window.clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = window.setTimeout(() => setConnBadge(null), 2000);
    });
    const offError = ws.on('terminal:error', (e) => {
      if (e.reqId !== undefined && e.reqId !== tab.id) return;
      setTabStatus(tab.id, { status: 'error', error: e.message });
      setConnBadge({ kind: 'error', text: e.message });
      if (!shouldReconnectRef.current && !isAgent) {
        // 连接失败（主机不可达/正在重启）：进入自动重连
        shouldReconnectRef.current = true;
        pushToast({ hostName: tab.hostName, kind: 'warning', text: '连接失败，正在自动重连…' });
      }
      scheduleReconnect();
    });
    const offLog = ws.on('terminal:log', (e) => {
      if (e.reqId !== tab.id) return;
      setConnBadge({ kind: 'connecting', text: e.message });
    });

    // agent 会话视图：实时镜像 MCP 执行的命令与输出；后台命令完成时通知
    const offActivity = isAgent
      ? ws.on('exec:activity', (e) => {
          if (e.sessionId !== tab.sessionId) return;
          if (e.kind === 'begin') {
            term.write(`\r\n\x1b[38;5;214m── [agent] $ ${e.command ?? ''}\x1b[0m\r\n`);
          } else if (e.kind === 'data' && e.data) {
            term.write(e.data);
          } else if (e.kind === 'end') {
            term.write(`\x1b[38;5;244m\r\n── [agent] 退出码 ${e.exitCode ?? '?'}\x1b[0m\r\n`);
            const status = e.status ?? (e.exitCode === 0 ? 'success' : 'error');
            if (useStore.getState().activeTabId !== tab.id) {
              useStore.getState().setTabNotify(tab.id, status);
              useStore.getState().pushToast({
                hostName: tab.hostName,
                kind: status,
                text:
                  status === 'error'
                    ? `命令失败（exit ${e.exitCode ?? '?'}）`
                    : status === 'warning'
                      ? '命令完成，但有警告输出'
                      : '命令执行成功',
              });
            }
          }
        })
      : () => {};

    // agent 会话结束 → 只读徽标（不写入终端）
    if (tab.ended) {
      setConnBadge({ kind: 'closed', text: '会话已结束 · 只读视图' });
    }

    // 发起连接：web 终端新建会话；agent 会话附加到 MCP 会话
    if (isAgent && tab.sessionId && !tab.ended) {
      setConnBadge({ kind: 'connecting', text: '附加会话中…' });
      ws.send({ type: 'terminal:attach', reqId: tab.id, sessionId: tab.sessionId, cols: term.cols, rows: term.rows });
    } else if (!isAgent) {
      // 持久会话：tmuxId = tab.id（重连 attach 恢复现场）
      setConnBadge({ kind: 'connecting', text: '连接中…' });
      ws.send({
        type: 'terminal:open',
        reqId: tab.id,
        hostId: tab.hostId,
        cols: term.cols,
        rows: term.rows,
        tmuxId: tab.id,
      });
    }

    return () => {
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      offData();
      offExit();
      offReady();
      offError();
      offLog();
      offActivity();
      clearTimeout(pwdTimerRef.current);
      clearTimeout(autoTimerRef.current);
      window.clearTimeout(badgeTimerRef.current);
      window.clearTimeout(reconnectTimerRef.current);
      window.clearTimeout(exitTimerRef.current);
      shouldReconnectRef.current = false;
      closeCompletion();
      if (streamIdRef.current) {
        const unloading = (window as unknown as { __taUnloading?: boolean }).__taUnloading;
        ws.send({
          type: 'terminal:close',
          streamId: streamIdRef.current,
          // 页面刷新/关闭时不销毁 tmux（会话保持，重连恢复）；仅用户主动关闭 tab 才销毁
          ...(tab.kind === 'web' && !unloading ? { tmuxId: tab.id } : {}),
        });
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.hostId, tab.sessionId, isAgent]);

  // 会话结束后转为只读：禁止 stdin，并提示
  useEffect(() => {
    if (!termRef.current) return;
    termRef.current.options.disableStdin = !!tab.ended;
    if (tab.ended) {
      termRef.current.write('\r\n\x1b[38;5;244m[会话已结束 · 只读视图，可查看历史输出]\x1b[0m\r\n');
    }
  }, [tab.ended]);

  // 主题切换：更新现有终端的 theme
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = THEMES[themeName] ?? THEMES['dark-plus'];
    }
  }, [themeName]);

  // 从隐藏切换回可见时重新适配尺寸
  useEffect(() => {
    if (isActive && fitRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          // 忽略
        }
      });
    }
  }, [isActive]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {/* 连接状态徽标（不写入终端文本；connected 2s 淡出，error/closed 常驻） */}
      {connBadge && (
        <div
          className={`pointer-events-none absolute top-1 left-8 z-30 max-w-72 truncate rounded-sm border px-1.5 py-0.5 text-[10px] ${
            connBadge.kind === 'connecting'
              ? 'animate-pulse border-[#cca700]/60 bg-[#3b3116]/95 text-[#cca700]'
              : connBadge.kind === 'connected'
                ? 'border-[#4ec9b0]/60 bg-[#14352e]/95 text-[#4ec9b0]'
                : connBadge.kind === 'error'
                  ? 'border-[#f14c4c]/60 bg-[#3b1d1d]/95 text-[#f14c4c]'
                  : 'border-[#5a5a5a]/60 bg-[#252526]/95 text-[#858585]'
          }`}
          title={connBadge.text}
        >
          {connBadge.text}
        </div>
      )}
      {/* 回放入口（hover 显示） */}
      <button
        title="回放本次会话"
        onClick={() => setReplayOpen(true)}
        className="absolute top-1 left-1 z-30 hidden rounded-sm border border-[#3c3c3c] bg-[#252526]/90 px-1.5 py-0.5 text-[10px] text-[#858585] hover:text-white group-hover:block"
      >
        ⏵ 回放
      </button>
      {/* 搜索浮层 */}
      {searchOpen && (
        <div className="absolute top-1 right-1 z-50 flex items-center gap-1 rounded-sm border border-[#3c3c3c] bg-[#252526] px-1.5 py-1 shadow-2xl">
          <input
            autoFocus
            value={searchTerm}
            placeholder="搜索…"
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (e.target.value) {
                const found = searchAddonRef.current?.findNext(e.target.value) ?? false;
                setSearchInfo(found ? '已找到' : '无结果');
              } else {
                setSearchInfo('');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const found = searchAddonRef.current?.findNext(searchTerm) ?? false;
                setSearchInfo(found ? '已找到' : '无结果');
              }
              if (e.key === 'Escape') setSearchOpen(false);
            }}
            className="w-32 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-1.5 py-0.5 text-[11px] text-[#cccccc] outline-none focus:border-[#007acc]"
          />
          <button
            title="上一个"
            onClick={() => {
              const found = searchAddonRef.current?.findPrevious(searchTerm) ?? false;
              setSearchInfo(found ? '已找到' : '无结果');
            }}
            className="rounded-sm px-1.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          >
            ↑
          </button>
          <button
            title="下一个"
            onClick={() => {
              const found = searchAddonRef.current?.findNext(searchTerm) ?? false;
              setSearchInfo(found ? '已找到' : '无结果');
            }}
            className="rounded-sm px-1.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          >
            ↓
          </button>
          <span className="min-w-8 text-center text-[10px] text-[#5a5a5a]">{searchInfo}</span>
          <button
            title="关闭"
            onClick={() => setSearchOpen(false)}
            className="rounded-sm px-1.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          >
            ×
          </button>
        </div>
      )}

      {/* 补全浮层 */}
      {completion && (
        <div
          className="absolute z-50 w-72 overflow-hidden rounded-sm border border-[#3c3c3c] bg-[#252526] shadow-2xl"
          style={{
            left: Math.min(completion.x, 200),
            top:
              completion.y + 13 > (termRef.current?.element?.clientHeight ?? 0) - 220
                ? completion.y - 220
                : completion.y + 13,
          }}
        >
          <div className="max-h-56 overflow-y-auto py-0.5">
            {completion.items.map((it, i) => (
              <div
                key={it.text + i}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] ${
                  i === completion.selected ? 'bg-[#094771] text-white' : 'text-[#cccccc] hover:bg-[#2a2d2e]'
                }`}
                onMouseEnter={() => {
                  completionRef.current = { ...completion, selected: i };
                  setCompletion(completionRef.current);
                }}
                onClick={applyCompletion}
              >
                <span className="w-4 shrink-0 text-center">
                  {it.type === 'dir' ? (
                    <span className="text-[#dcb67a]">▸</span>
                  ) : it.type === 'cmd' ? (
                    <span className="text-[#4fc1ff]">&gt;_</span>
                  ) : (
                    <span className="text-[#858585]">·</span>
                  )}
                </span>
                <span className="truncate font-mono">{it.text}</span>
              </div>
            ))}
          </div>
          <div className="border-t border-[#3c3c3c] bg-[#1e1e1e] px-3 py-0.5 text-[10px] text-[#5a5a5a]">
            ↑↓ 选择 · Enter 确认 · Esc 关闭
          </div>
        </div>
      )}
      {/* 回放播放器 */}
      {replayOpen && recordingRef.current.length > 0 && (
        <ReplayOverlay
          frames={recordingRef.current.map((f) => ({ t: f.t - recordingRef.current[0].t, data: f.data }))}
          hostName={tab.hostName}
          onClose={() => setReplayOpen(false)}
        />
      )}
    </div>
  );
}
