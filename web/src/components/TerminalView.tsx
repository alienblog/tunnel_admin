import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { ws } from '../ws';
import { useStore, type TerminalTab } from '../store';

const THEME = {
  background: '#1e1e1e',
  foreground: '#cccccc',
  cursor: '#aeafad',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5',
};

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
      theme: THEME,
      scrollback: 10000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
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
    const offData = ws.on('terminal:data', (e) => {
      if (e.streamId !== streamIdRef.current) return;
      term.write(e.data);
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
        term.write('\r\n\x1b[38;5;244m[会话已关闭]\x1b[0m\r\n');
        setTabStatus(tab.id, { status: 'closed' });
      }
    });
    const offReady = ws.on('terminal:ready', (e) => {
      if (e.reqId !== tab.id) return;
      streamIdRef.current = e.streamId;
      setTabStatus(tab.id, { status: 'connected', streamId: e.streamId });
    });
    const offError = ws.on('terminal:error', (e) => {
      if (e.reqId !== undefined && e.reqId !== tab.id) return;
      term.write(`\r\n\x1b[38;5;196m[连接失败] ${e.message}\x1b[0m\r\n`);
      setTabStatus(tab.id, { status: 'error', error: e.message });
    });
    const offLog = ws.on('terminal:log', (e) => {
      if (e.reqId !== tab.id) return;
      term.write(`\r\n\x1b[38;5;245m[连接] ${e.message}\x1b[0m\r\n`);
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

    // agent 会话结束 → 只读提示
    if (tab.ended) {
      term.write('\r\n\x1b[38;5;244m[会话已结束 · 只读视图，可查看历史输出]\x1b[0m\r\n');
    }

    // 发起连接：web 终端新建会话；agent 会话附加到 MCP 会话
    if (isAgent && tab.sessionId && !tab.ended) {
      ws.send({ type: 'terminal:attach', reqId: tab.id, sessionId: tab.sessionId, cols: term.cols, rows: term.rows });
    } else if (!isAgent) {
      ws.send({ type: 'terminal:open', reqId: tab.id, hostId: tab.hostId, cols: term.cols, rows: term.rows });
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
      closeCompletion();
      if (streamIdRef.current) ws.send({ type: 'terminal:close', streamId: streamIdRef.current });
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
    </div>
  );
}
