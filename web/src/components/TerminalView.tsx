import { memo, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { THEMES } from '../themes';
import ReplayOverlay from './ReplayOverlay';
import { api } from '../api';
import { getDesktop } from '../desktop';
import { ws, type ClientMsg } from '../ws';
import { useStore, type Rect, type TerminalTab } from '../store';


interface CompletionItem {
  text: string;
  type: 'cmd' | 'file' | 'dir' | 'svc';
}

interface CompletionState {
  items: CompletionItem[];
  selected: number;
  kind: 'cmd' | 'path' | 'svc';
  prefix: string;
  x: number;
  y: number;
}

/** 候选过滤 + 排序（主流体验）：先按当前词前缀过滤（readline 语义），再 精确匹配最前 → 目录优先 → 较短前缀优先 → 字母序 */
function sortItems(items: CompletionItem[], prefix: string): CompletionItem[] {
  const p = prefix;
  return items
    .filter((i) => i.text.startsWith(p))
    .sort((a, b) => {
    const ae = a.text === p ? 0 : 1;
    const be = b.text === p ? 0 : 1;
    if (ae !== be) return ae - be;
    const ad = a.type === 'dir' ? 0 : 1;
    const bd = b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    if (a.text.length !== b.text.length) return a.text.length - b.text.length;
    return 0; // 同长保持服务端顺序（命令补全的 history 高频优先）
    });
}

/** systemctl 服务操作子命令（这些命令的参数是服务名，按服务补全而非路径） */
const SYSTEMCTL_ACTIONS = new Set([
  'start', 'stop', 'restart', 'status', 'enable', 'disable', 'reload', 'restart', 'mask', 'unmask',
  'is-active', 'is-enabled', 'is-failed', 'try-restart', 'reload-or-restart', 'show', 'cat', 'edit',
]);

/** 从输入缓冲与光标位置推导补全上下文 */
function getCompletionContext(buf: string, cursor: number): { kind: 'cmd' | 'path' | 'svc'; prefix: string; force: boolean } | null {
  const before = buf.slice(0, cursor);
  const firstSpace = before.indexOf(' ');
  if (firstSpace === -1) {
    if (before.trim() === '') return null;
    return { kind: 'cmd', prefix: before, force: true };
  }
  const words = before.split(' ');
  const lastWord = words.pop() ?? '';
  // systemctl <动作> <前缀> → 服务名补全（如 systemctl restart ssh → ssh.service）；
  // 空前缀（如 systemctl restart <空格>）仅 Tab 强制时返回（自动模式抑制，见 requestCompletion）
  if (words[0] === 'systemctl' && words[1] !== undefined && SYSTEMCTL_ACTIONS.has(words[1])) {
    return { kind: 'svc', prefix: lastWord, force: true };
  }
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

function TerminalViewInner({ tab, rect }: { tab: TerminalTab; rect: Rect | null }) {
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
  type ClientMsgOpen = Extract<ClientMsg, { type: 'terminal:open' }>;

  /** terminal:open 消息体：动态连接首次带一次性 connectToken；
   *  ready 后 token 已消费清除，重连/多开走服务端会话复用或凭据缓存（不带 token） */
  const openPayload = (cols: number, rows: number): ClientMsgOpen => {
    const cur = useStore.getState().tabs.find((t) => t.id === tab.id);
    const token = cur?.connectToken;
    return {
      type: 'terminal:open',
      reqId: tab.id,
      hostId: tab.hostId,
      cols,
      rows,
      tmuxId: tab.id,
      ...(token ? { connectToken: token } : {}),
    };
  };

  const closeCompletion = (): void => {
    completionRef.current = null;
    setCompletion(null);
  };

  /** 幽灵补全（VSCode 式）：最佳匹配灰色显示在光标后，方向键右键应用 */
  const [ghost, setGhost] = useState<{ text: string } | null>(null);
  const ghostRef = useRef<{ text: string } | null>(null);
  const closeGhost = (): void => {
    if (ghostRef.current) {
      ghostRef.current = null;
      setGhost(null);
    }
  };

  /** 应用幽灵补全（发送 suffix 到 shell + 更新输入缓冲） */
  const applyGhost = (): void => {
    const g = ghostRef.current;
    if (!g || g.text === '') return;
    applySuffix(g.text);
    closeGhost();
  };

  /** 应用补全 suffix：发送到 shell + 更新输入缓冲 */
  const applySuffix = (suffix: string): void => {
    if (suffix === '') return;
    if (streamIdRef.current) {
      ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: suffix });
    }
    const cur = cursorRef.current;
    cmdBufRef.current = cmdBufRef.current.slice(0, cur) + suffix + cmdBufRef.current.slice(cur);
    cursorRef.current = cur + suffix.length;
  };

  const requestCompletion = async (force: boolean): Promise<void> => {
    const buf = cmdBufRef.current;
    const cur = cursorRef.current;
    const ctx = getCompletionContext(buf, cur);
    if (!ctx) {
      closeCompletion();
      closeGhost();
      return;
    }
    // 空前缀（如 systemctl restart <空格>）仅 Tab 强制触发，自动模式抑制（避免输入空格弹全部候选）
    if (!force && ctx.prefix === '') {
      closeCompletion();
      closeGhost();
      return;
    }
    const seq = ++completeSeqRef.current;
    // 优先服务端 bash 原生补全（任意命令参数），无结果降级到本地上下文（cmd/path/svc）
    let items: CompletionItem[] | null = null;
    const sort = (list: CompletionItem[]): CompletionItem[] => sortItems(list, ctx.prefix);
    try {
      const r = await api<{ items: CompletionItem[] }>(
        `/api/complete?hostId=${tab.hostId}&line=${encodeURIComponent(buf)}&cwd=${encodeURIComponent(cwdRef.current ?? '~')}`,
      );
      if (seq !== completeSeqRef.current) return;
      items = sort(r.items);
    } catch {
      items = null;
    }
    if (items === null || items.length === 0) {
      try {
        const r = await api<{ items: CompletionItem[] }>(
          `/api/complete?hostId=${tab.hostId}&kind=${ctx.kind}&prefix=${encodeURIComponent(ctx.prefix)}&cwd=${encodeURIComponent(cwdRef.current ?? '~')}`,
        );
        if (seq !== completeSeqRef.current || r.items.length === 0) return;
        items = sort(r.items);
      } catch {
        closeGhost();
        return;
      }
    }
    if (force && items.length === 1 && !completionRef.current) {
      // Tab 且唯一候选：直接补全（bash 式），不弹列表
      closeGhost();
      const item = items[0];
      let suffix = item.text.slice(ctx.prefix.length);
      if (ctx.kind === 'path' && item.type === 'dir' && !item.text.endsWith('/')) {
        suffix += '/';
      }
      applySuffix(suffix);
      return;
    }
    if (force || completionRef.current) {
      closeGhost();
      // 光标位置 → 像素
      const term = termRef.current;
      if (!term) return;
      const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { actualCellWidth: number; actualCellHeight: number } } } })._core?._renderService?.dimensions;
      const cellW = dims?.actualCellWidth ?? 8;
      const cellH = dims?.actualCellHeight ?? 13;
      const state: CompletionState = {
        items,
        selected: 0,
        kind: ctx.kind,
        prefix: ctx.prefix,
        x: Math.round(term.buffer.active.cursorX * cellW),
        y: Math.round(term.buffer.active.cursorY * cellH),
      };
      completionRef.current = state;
      setCompletion(state);
    } else {
      // 自动模式：最佳匹配灰色显示（幽灵文本），不实际输入
      const item = items[0];
      let suffix = item.text.slice(ctx.prefix.length);
      if (ctx.kind === 'path' && item.type === 'dir' && !item.text.endsWith('/')) {
        suffix += '/';
      }
      if (suffix !== '') {
        ghostRef.current = { text: suffix };
        setGhost({ text: suffix });
      } else {
        closeGhost();
      }
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
    applySuffix(suffix);
    closeCompletion();
  };

  const scheduleAuto = (): void => {
    clearTimeout(autoTimerRef.current);
    autoTimerRef.current = window.setTimeout(() => void requestCompletion(false), 120);
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

    // 滚轮：普通终端滚动视口（浏览历史输出）；TUI（alternate screen）转发方向键。
    // 显式接管，避免 wheel 被当作输入历史（readline 上翻）或浏览器页面滚动。
    term.attachCustomWheelEventHandler(() => false); // 关闭 xterm 默认 wheel 处理，由下方自定义处理
    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      const isAlt = term.buffer.active.type === 'alternate';
      if (isAlt) {
        if (streamIdRef.current) {
          ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: ev.deltaY < 0 ? '\x1b[A' : '\x1b[B' });
        }
        return;
      }
      // 普通终端：滚动视口（每格约 3 行，与常见终端一致）
      term.scrollLines(ev.deltaY < 0 ? -3 : 3);
    };
    container.addEventListener('wheel', onWheel, { passive: false });

    // Ctrl+Shift+K（VSCode 终端风格）：前端清屏——清除视口与历史缓冲，不发送给 shell。
    // journalctl -f 等持续输出场景：清掉旧内容避免 scrollback 累积导致渲染卡顿；
    // 在 DOM 层处理以区分 shift（传统字节流中 Ctrl+Shift+K 与 Ctrl+K 同为 \x0b，
    // 若在 onData 拦截会破坏 bash 的 Ctrl+K 剪切到行尾）
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
        term.clear();
        return false;
      }
      return true;
    });

    /** 容器尺寸是否可 fit：隐藏（display:none → 0）或布局未就绪时跳过，
     *  避免把 xterm 缩到 10×6 并发送假 terminal:resize（SIGWINCH 导致 shell 重排） */
    const canFit = (el: HTMLElement): boolean => el.clientWidth >= 100 && el.clientHeight >= 50;

    try {
      if (canFit(container)) fit.fit();
    } catch {
      // 容器尚未布局完成时忽略
    }

    const ro = new ResizeObserver(() => {
      // 隐藏（切走 tab，尺寸归零）时不 fit：xterm 保持原尺寸，切回时无假 resize
      if (!canFit(container)) return;
      try {
        fit.fit();
      } catch {
        // 忽略
      }
    });
    ro.observe(container);

      // 输入缓冲维护 + clear 拦截 + 终端发送
      // Enter：若整行是 clear，不发送（保留终端历史），仅把视口滚动到顶部
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
        // 普通字符/退格：不关闭列表，继续作为普通输入处理（发送到 shell + 更新缓冲），
        // scheduleAuto 会按新前缀重新请求补全，列表实时过滤（主流 SSH 工具行为）
      }

      // 方向键右键：应用幽灵补全（无 ghost 时正常移动光标）
      if (d === '\x1b[C') {
        if (ghostRef.current) {
          applyGhost();
          return;
        }
        cursorRef.current = Math.min(cmdBufRef.current.length, cursorRef.current + 1);
        return;
      }
      // 其他输入：清除旧 ghost（120ms 后自动生成新的）
      closeGhost();

      // Tab：发送到远端 shell，由 bash readline 原生补全（主流 SSH 工具行为）。
      // bash 补全会直接改写终端行（唯一候选补全/多候选打印），前端不做下拉候选。
      // 补全后 shell 行与前端缓冲不再同步，清空缓冲（后续输入重新积累）。
      if (d === '\t') {
        cmdBufRef.current = '';
        cursorRef.current = 0;
        if (streamIdRef.current) ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: '\t' });
        return;
      }

      if (streamIdRef.current) ws.send({ type: 'terminal:input', streamId: streamIdRef.current, data: d });

      if (d === '\r' || d === '\n') {
        if (cmdBufRef.current.trim() === 'clear') {
          term.scrollToTop();
          cmdBufRef.current = '';
          cursorRef.current = 0;
          clearTimeout(autoTimerRef.current);
          return;
        }
        // 视口在顶部（如 clear 后）输入时滚回底部，避免看不到提示符
        if (term.buffer.active.viewportY === 0) term.scrollToBottom();
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
      } else if (d === '\x03') {
        // Ctrl+C：shell 中断清行，同步输入缓冲（避免补全上下文残留）
        cmdBufRef.current = '';
        cursorRef.current = 0;
        closeCompletion();
      } else if (d === '\x15') {
        // Ctrl+U：删除光标前所有字符（readline）
        cmdBufRef.current = cmdBufRef.current.slice(cursorRef.current);
        cursorRef.current = 0;
        scheduleAuto();
      } else if (d === '\x17') {
        // Ctrl+W：删除光标前一个词（readline）
        const cur = cursorRef.current;
        const after = cmdBufRef.current.slice(cur);
        const trimmed = cmdBufRef.current.slice(0, cur).replace(/\S+\s*$/, '');
        cmdBufRef.current = trimmed + after;
        cursorRef.current = trimmed.length;
        scheduleAuto();
      } else if (d === '\x01') {
        // Ctrl+A：光标到行首
        cursorRef.current = 0;
      } else if (d === '\x05') {
        // Ctrl+E：光标到行尾
        cursorRef.current = cmdBufRef.current.length;
      } else if (d === '\x1b[D') {
        cursorRef.current = Math.max(0, cursorRef.current - 1);
      } else if (d === '\x1b[A' || d === '\x1b[B') {
        // 历史命令：缓冲失效
        cmdBufRef.current = '';
        cursorRef.current = 0;
        closeCompletion();
      } else if (!d.startsWith('\x1b')) {
        // 视口在顶部（clear 后）时输入先滚回底部
        if (term.buffer.active.viewportY === 0) term.scrollToBottom();
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
        ws.send(openPayload(term.cols, term.rows));
      }, delay);
    };

    const offData = ws.on('terminal:data', (e) => {
      if (e.streamId !== streamIdRef.current) return;
      term.write(e.data);
      // shell 输出（含输入回显）到达：幽灵补全失效（位置/上下文已变）
      closeGhost();
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
      setTabStatus(tab.id, { status: 'connected', streamId: e.streamId, connectToken: undefined });
      const wasReconnect = reconnectAttemptRef.current > 0;
      stopReconnect();
      // 已连接徽标 2 秒后淡出（重连成功时显示「已重连」）
      setConnBadge({ kind: 'connected', text: wasReconnect ? '已重连' : '已连接' });
      window.clearTimeout(badgeTimerRef.current);
      badgeTimerRef.current = window.setTimeout(() => setConnBadge(null), 2000);
      // 尺寸对齐：open 可能发生在容器未布局时（默认 80x24），ready 后按实际尺寸重发一次，
      // 让 shell 收到 SIGWINCH 重绘（修复「$ 下一行」/首屏显示错乱）
      window.setTimeout(() => {
        if (streamIdRef.current !== e.streamId) return;
        const term = termRef.current;
        if (term) {
          ws.send({ type: 'terminal:resize', streamId: e.streamId, cols: term.cols, rows: term.rows });
          // 强制刷新首屏：新终端 open 后渲染循环可能未启动（首屏输出挂起，
          // 输入/滚动才恢复），scrollToBottom 触发视口重绘
          try {
            term.scrollToBottom();
          } catch {
            // 忽略
          }
        }
      }, 50);
    });
    const offError = ws.on('terminal:error', (e) => {
      if (e.reqId !== undefined && e.reqId !== tab.id) return;
      setTabStatus(tab.id, { status: 'error', error: e.message });
      setConnBadge({ kind: 'error', text: e.message });
      // 动态设备（负 hostId，插件连接）：无 hosts 记录且 token 一次性，重试无意义
      if (!shouldReconnectRef.current && !isAgent && tab.hostId >= 0) {
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

    // ws 重连（服务端重启 / 网络闪断）：服务端已清理旧 stream，重新 open 恢复现场
    // （动态终端 token 已消费：不带 token，服务端按 tmuxId 复用保留会话 / 凭据缓存）
    const onWsOpen = (e: Event): void => {
      const detail = (e as CustomEvent<{ reconnect?: boolean }>).detail;
      if (!detail?.reconnect) return;
      if (isAgent || !streamIdRef.current || shouldReconnectRef.current) return;
      streamIdRef.current = null;
      setConnBadge({ kind: 'connecting', text: '连接恢复中…' });
      ws.send(openPayload(term.cols, term.rows));
    };
    window.addEventListener('ta:ws:open', onWsOpen);

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
              // 桌面端：非活动终端命令完成 → 系统通知（窗口后台也能感知）
              getDesktop()?.notify({
                title: `命令完成 · ${tab.hostName}`,
                body:
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

    // 发起连接由下方 rect effect 负责（布局就绪且 fit 成功后发送，避免默认 80x24 首屏导致提示符错位）

    return () => {
      ro.disconnect();
      container.removeEventListener('wheel', onWheel);
      window.removeEventListener('ta:ws:open', onWsOpen);
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
        // tab 仍存在 = 布局移动（拖拽分屏/合并）等非关闭操作：TerminalView 由内容池按 tab id
        // 保持挂载，此处仅在真正卸载时触发（closeTab/登出）；服务端按 kind=open 断开对应会话
        ws.send({ type: 'terminal:close', streamId: streamIdRef.current });
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, tab.hostId, tab.sessionId, isAgent]);

  // 发起连接：布局就绪（rect 非空）且 fit 成功后才发送 open/attach，
  // 避免容器未布局时以默认 80x24 创建 pty 再 resize，导致首屏提示符换行错位
  const openedRef = useRef(false);
  useEffect(() => {
    // rect 未布局（null 或 0 尺寸）时不发起连接：等待有效布局后再 open，
    // 避免以 fit 保底尺寸（10x5）创建 pty/tmux，导致 TUI 程序（omp 等）显示错乱
    if (rect === null || rect.w < 50 || rect.h < 30 || openedRef.current || tab.ended) return;
    openedRef.current = true;
    const term = termRef.current;
    if (!term) return;
    try {
      const el = containerRef.current;
      if (el && el.clientWidth >= 100 && el.clientHeight >= 50) fitRef.current?.fit();
    } catch {
      // 容器尚未布局完成时忽略（ResizeObserver 会补发）
    }
    if (isAgent && tab.sessionId) {
      setConnBadge({ kind: 'connecting', text: '附加会话中…' });
      ws.send({ type: 'terminal:attach', reqId: tab.id, sessionId: tab.sessionId, cols: term.cols, rows: term.rows });
    } else if (!isAgent) {
      // 持久会话：tmuxId = tab.id（重连 attach 恢复现场）
      setConnBadge({ kind: 'connecting', text: '连接中…' });
      ws.send(openPayload(term.cols, term.rows));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect, tab.id, tab.hostId, tab.sessionId, isAgent]);

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
          const el = containerRef.current;
          if (!el || el.clientWidth < 100 || el.clientHeight < 50) return;
          fitRef.current?.fit();
        } catch {
          // 忽略
        }
      });
    }
  }, [isActive]);

  // 焦点跟随：本终端激活且可见（点击主机外层 tab / 终端 tab / 新开终端）时，
  // 自动聚焦 xterm，无需鼠标再点一次即可直接输入。
  // 直接聚焦 textarea（比 term.focus() 更可靠：新终端刚 open 时 xterm 内部 focus
  // 可能因渲染层未就绪而无效），并验证聚焦结果短时重试：
  // Electron 中关闭 confirm 等原生对话框后 document 焦点可能未恢复
  // （textarea 无焦点 → 光标变空心 outline、空格被焦点元素拦截），
  // 窗口/文档恢复聚焦后重试即可命中。
  useEffect(() => {
    if (!isActive || !rect) return;
    const term = termRef.current;
    if (!term) return;
    const ta = (term as unknown as { textarea?: HTMLTextAreaElement }).textarea;
    let cancelled = false;
    let tries = 0;
    const tryFocus = (): void => {
      if (cancelled) return;
      if (ta) {
        try {
          ta.focus();
        } catch {
          // 忽略
        }
      } else {
        try {
          term.focus();
        } catch {
          // 忽略
        }
      }
      if (ta && document.activeElement !== ta && tries < 8) {
        tries++;
        window.setTimeout(tryFocus, 50);
      }
    };
    tryFocus();
    return () => {
      cancelled = true;
    };
  }, [isActive, rect]);

  return (
    <div className="relative group" style={rect ? { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { display: 'none' }}>
      <div
        ref={containerRef}
        className="h-full w-full"
        onContextMenu={(e) => {
          // PowerShell 式右键：选中文本 → 复制；未选中 → 粘贴（多行由 onData 二次确认）
          e.preventDefault();
          const term = termRef.current;
          if (!term) return;
          const sel = term.getSelection();
          if (sel) {
            // 先聚焦再复制：document 未聚焦时 clipboard.writeText 会抛
            // NotAllowedError（Electron 关闭原生对话框后焦点可能未恢复）
            try {
              term.focus();
            } catch {
              // 忽略
            }
            void navigator.clipboard.writeText(sel).catch(() => {
              // 剪贴板写入失败（document 未聚焦/权限）静默：选中文本保留，用户可手动 Ctrl+C
            });
            term.clearSelection();
            pushToast({ hostName: tab.hostName, kind: 'success', text: `已复制选中文本（${sel.length} 字符）` });
            return;
          }
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (!text) return;
              term.paste(text);
            })
            .catch(() => {
              // 剪贴板读取失败（无权限）静默
            });
        }}
      />
      {/* 连接状态徽标（不写入终端文本；connected 2s 淡出，error/closed 常驻） */}
      {connBadge && (
        <div
          className={`pointer-events-none absolute top-1 right-1 z-30 max-w-72 truncate rounded-sm border px-1.5 py-0.5 text-[10px] ${
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
      {/* 回放/清屏入口（hover 显示） */}
      <div className="absolute top-1 left-1 z-30 hidden gap-1 group-hover:flex">
        <button
          title="回放本次会话"
          onClick={() => setReplayOpen(true)}
          className="rounded-sm border border-[#3c3c3c] bg-[#252526]/90 px-1.5 py-0.5 text-[10px] text-[#858585] hover:text-white"
        >
          ⏵ 回放
        </button>
        <button
          title="清屏（Ctrl+Shift+K）：清除视口与历史缓冲，不发送命令给 shell"
          onClick={() => termRef.current?.clear()}
          className="rounded-sm border border-[#3c3c3c] bg-[#252526]/90 px-1.5 py-0.5 text-[10px] text-[#858585] hover:text-white"
        >
          ␡ 清屏
        </button>
      </div>
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

      {/* 幽灵补全（VSCode 式）：最佳匹配灰色显示在光标后，方向键右键应用 */}
      {ghost && (() => {
        // 位置跟随 xterm 光标 DOM（helper textarea 由 xterm 定位在光标单元格），
        // 任何滚动/缓冲/换行场景下都与输入对齐
        const container = containerRef.current;
        const ta = container?.querySelector('.xterm-helper-textarea');
        const tr = ta ? ta.getBoundingClientRect() : null;
        const cr = container ? container.getBoundingClientRect() : null;
        if (!tr || !cr) return null;
        const left = tr.left - cr.left + (tr.width || 0);
        const top = tr.top - cr.top;
        return (
          <span
            className="pointer-events-none absolute z-40 font-mono text-[13px] whitespace-pre text-[#6a6a6a]/70"
            style={{ left: Math.round(left), top: Math.round(top) }}
          >
            {ghost.text}
          </span>
        );
      })()}

      {/* 补全浮层 */}
      {completion && (
        <div
          className="absolute z-50 w-72 overflow-hidden rounded-sm border border-[#3c3c3c] bg-[#252526] shadow-2xl"
          style={(() => {
            // VSCode 式：优先在光标下方弹出（不遮当前输入行）；下方空间不足时收窄高度，
            // 只有完全放不下才弹到上方（底部对齐光标行上方，尽量不遮输入内容）
            const elH = termRef.current?.element?.clientHeight ?? 0;
            const below = elH - (completion.y + 13);
            const listMaxH = Math.min(224, Math.max(48, below - 44));
            const top = below >= 54 ? completion.y + 13 : Math.max(0, completion.y - listMaxH - 44);
            return { left: Math.min(completion.x, 200), top };
          })()}
        >
          <div
            className="overflow-y-auto py-0.5"
            style={{ maxHeight: Math.min(224, Math.max(48, (termRef.current?.element?.clientHeight ?? 0) - (completion.y + 13) - 44)) }}
          >
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
                  ) : it.type === 'svc' ? (
                    <span className="text-[#4ec9b0]">⚙</span>
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

export default memo(TerminalViewInner);
