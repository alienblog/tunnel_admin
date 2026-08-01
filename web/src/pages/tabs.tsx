import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AuditEntry, type CmdRule, type McpToken } from '../api';
import { useStore, type OuterTab } from '../store';
import { THEME_NAMES } from '../themes';

/** 外层工具 tab：文件编辑器 / 设置 / 传输管理器 / 审计 */

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K`;
  return `${n}B`;
}

const inputCls =
  'rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2 py-1 text-[12px] text-[#cccccc] outline-none focus:border-[#007acc]';

/** 文件编辑器：双击文件打开，Ctrl+S 保存，5MB 上限（超限只读防误覆盖） */
export function EditorTab({ tab }: { tab: Extract<OuterTab, { kind: 'editor' }> }) {
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [binary, setBinary] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const taRef = useRef<HTMLTextAreaElement>(null);
  const closeOuterTab = useStore((s) => s.closeOuterTab);
  const pushToast = useStore((s) => s.pushToast);

  const load = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const r = await api<{ content: string; binary: boolean; truncated: boolean }>(
        `/api/sftp/read?hostId=${tab.hostId}&path=${encodeURIComponent(tab.path)}&maxBytes=${5 * 1024 * 1024}`,
      );
      setBinary(r.binary);
      setTooBig(r.truncated);
      setContent(r.binary ? '' : r.content);
      setDirty(false);
    } catch (err) {
      setError((err as Error).message);
      setContent('');
    }
  }, [tab.hostId, tab.path]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    if (content === null || binary || tooBig || saving) return;
    setSaving(true);
    setError('');
    try {
      await api('/api/sftp/write', { method: 'POST', body: JSON.stringify({ hostId: Number(tab.hostId), path: tab.path, content }) });
      setDirty(false);
      const parent = tab.path.slice(0, tab.path.lastIndexOf('/')) || '/';
      useStore.getState().invalidateSftpPath(tab.hostId, parent);
      pushToast({ hostName: tab.hostName, kind: 'success', text: `已保存 ${tab.name}` });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [content, binary, tooBig, saving, tab, pushToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const onSelect = (): void => {
    const el = taRef.current;
    if (!el) return;
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    setCursor({ line, col });
  };

  const readOnly = binary || tooBig;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      {/* 顶栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[#252526] bg-[#252526] px-3 text-[12px]">
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#858585]" fill="currentColor">
          <path d="M2 1.5h4.5l2 2H14a1 1 0 011 1V13a1 1 0 01-1 1H2a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
        </svg>
        <span className="truncate font-mono text-[#9cdcfe]">{tab.path}</span>
        {dirty && <span className="shrink-0 rounded-sm bg-[#3b3b1d] px-1.5 py-0.5 text-[10px] text-[#cca700]">未保存</span>}
        {tooBig && <span className="shrink-0 rounded-sm bg-[#3b1d1d] px-1.5 py-0.5 text-[10px] text-[#f14c4c]">超过 5MB，只读</span>}
        {binary && <span className="shrink-0 rounded-sm bg-[#3b1d1d] px-1.5 py-0.5 text-[10px] text-[#f14c4c]">二进制文件</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={() => void load()}
            title="重新加载"
            className="rounded-sm px-1.5 py-0.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          >
            ↻
          </button>
          <button
            onClick={() => void save()}
            disabled={readOnly || saving || content === null}
            title="保存 (Ctrl+S)"
            className={`rounded-sm px-2.5 py-0.5 font-medium ${
              dirty && !readOnly
                ? 'bg-[#0e639c] text-white hover:bg-[#1177bb]'
                : 'border border-[#3c3c3c] text-[#858585] hover:bg-[#3a3d41]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            onClick={() => closeOuterTab(tab.id)}
            title="关闭"
            className="rounded-sm px-1.5 py-0.5 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c]"
          >
            ×
          </button>
        </span>
      </div>
      {error && <div className="border-b border-[#252526] bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
      {/* 编辑区 */}
      <div className="relative min-h-0 flex-1">
        {content === null ? (
          <div className="flex h-full items-center justify-center text-[#5a5a5a]">加载中…</div>
        ) : readOnly ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[#5a5a5a]">
            <div className="text-3xl">🚫</div>
            <div>{binary ? '二进制文件无法编辑' : '文件超过 5MB 编辑上限，仅可下载'}</div>
            <div className="font-mono text-[11px]">{tab.path}</div>
          </div>
        ) : (
          <textarea
            ref={taRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            onSelect={onSelect}
            onClick={onSelect}
            onKeyUp={onSelect}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="absolute inset-0 h-full w-full resize-none bg-transparent p-3 font-mono text-[13px] leading-relaxed text-[#d4d4d4] caret-[#aeafad] outline-none selection:bg-[#264f78]"
          />
        )}
      </div>
      {/* 底部状态 */}
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-[#252526] bg-[#007acc] px-3 text-[11px] text-white">
        <span>{tab.hostName}</span>
        <span>{tab.name}</span>
        {content !== null && !binary && <span>{fmtBytes(new Blob([content]).size)}</span>}
        <span className="ml-auto">行 {cursor.line}, 列 {cursor.col}</span>
      </div>
    </div>
  );
}

// ---------- 设置 ----------

/** 告警阈值配置（localStorage 持久） */
function AlertThresholds() {
  const alertThresholds = useStore((s) => s.alertThresholds);
  const setAlertThresholds = useStore((s) => s.setAlertThresholds);

  useEffect(() => {
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
    <div className="flex flex-col gap-2">
      {rows.map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-[12px] text-[#cccccc]">
          <span className="w-10">{label}</span>
          <input
            type="number"
            min={1}
            max={100}
            value={alertThresholds[key]}
            onChange={(e) => set(key, e.target.value)}
            className={`${inputCls} w-20`}
          />
          <span className="text-[#858585]">%</span>
        </label>
      ))}
      <div className="text-[11px] text-[#5a5a5a]">指标超限时状态栏弹出提醒（恢复后重置）</div>
    </div>
  );
}

/** 快捷命令编辑（状态栏左侧） */
function QuickCommands() {
  const quickCommands = useStore((s) => s.quickCommands);
  const setQuickCommands = useStore((s) => s.setQuickCommands);
  const [draft, setDraft] = useState('');

  const add = (e: React.FormEvent): void => {
    e.preventDefault();
    const cmd = draft.trim();
    if (!cmd) return;
    setQuickCommands([...quickCommands, cmd]);
    setDraft('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[11px] text-[#5a5a5a]">
        状态栏左侧的快捷命令，点击即在当前激活终端执行
      </div>
      <form onSubmit={add} className="flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="如 git status"
          className={`${inputCls} min-w-0 flex-1 font-mono`}
        />
        <button type="submit" className="shrink-0 rounded-sm bg-[#0e639c] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb]">
          ＋
        </button>
      </form>
      <div className="flex flex-col gap-1">
        {quickCommands.map((c, i) => (
          <div key={i} className="group flex items-center gap-1.5 rounded-sm px-2 py-1 text-[12px] hover:bg-[#2a2d2e]">
            <span className="min-w-0 flex-1 truncate font-mono text-[#9cdcfe]">{c}</span>
            <button
              title="上移"
              onClick={() => {
                if (i === 0) return;
                const next = [...quickCommands];
                [next[i - 1], next[i]] = [next[i], next[i - 1]];
                setQuickCommands(next);
              }}
              className="hidden rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white group-hover:inline"
            >
              ↑
            </button>
            <button
              title="下移"
              onClick={() => {
                if (i === quickCommands.length - 1) return;
                const next = [...quickCommands];
                [next[i + 1], next[i]] = [next[i], next[i + 1]];
                setQuickCommands(next);
              }}
              className="hidden rounded px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white group-hover:inline"
            >
              ↓
            </button>
            <button
              title="删除"
              onClick={() => setQuickCommands(quickCommands.filter((_, j) => j !== i))}
              className="hidden rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c] group-hover:inline"
            >
              ×
            </button>
          </div>
        ))}
        {quickCommands.length === 0 && <div className="text-[11px] text-[#5a5a5a]">暂无快捷命令</div>}
      </div>
    </div>
  );
}

/** MCP 配置：令牌 + 危险命令规则 + 接入提示词 */
function McpSettings() {
  const pushToast = useStore((s) => s.pushToast);
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [rules, setRules] = useState<CmdRule[]>([]);
  const [rulePattern, setRulePattern] = useState('');
  const [ruleAction, setRuleAction] = useState<'block' | 'approve'>('block');
  const [ruleNote, setRuleNote] = useState('');
  const [copying, setCopying] = useState(false);

  const loadRules = useCallback(async (): Promise<void> => {
    try {
      setRules(await api<CmdRule[]>('/api/cmd-rules'));
    } catch {
      // 忽略
    }
  }, []);

  const loadTokens = useCallback(async (): Promise<void> => {
    try {
      setTokens(await api<McpToken[]>('/api/tokens'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadRules();
    void loadTokens();
  }, [loadRules, loadTokens]);

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

  const create = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string }>('/api/tokens', { method: 'POST', body: JSON.stringify({ name }) });
      setCreated(r.token);
      setName('');
      await loadTokens();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const revoke = async (t: McpToken): Promise<void> => {
    if (!confirm(`确认吊销 token「${t.name}」？`)) return;
    try {
      await api(`/api/tokens/${t.id}`, { method: 'DELETE' });
      await loadTokens();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 复制 MCP 接入提示词（给 agent 用） */
  const copyPrompt = async (): Promise<void> => {
    setCopying(true);
    setError('');
    try {
      const r = await api<{ prompt: string }>('/api/mcp/prompt');
      await navigator.clipboard.writeText(r.prompt);
      pushToast({ hostName: 'MCP', kind: 'success', text: '接入提示词已复制，可直接粘贴给 agent' });
    } catch (err) {
      setError(`复制失败：${(err as Error).message}`);
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-[#cccccc]">接入提示词</span>
          <button
            onClick={() => void copyPrompt()}
            disabled={copying}
            className="rounded-sm bg-[#0e639c] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb] disabled:opacity-60"
          >
            {copying ? '获取中…' : '📋 复制提示词'}
          </button>
        </div>
        <div className="text-[11px] leading-relaxed text-[#5a5a5a]">
          一键复制一段说明（endpoint / 鉴权 / 工具清单），粘贴给 AI agent 即可接入本 MCP server
        </div>
      </div>

      <div className="border-t border-[#252526] pt-3">
        <div className="mb-2 text-[13px] font-semibold text-[#cccccc]">MCP 令牌</div>
        <div className="mb-2 text-[11px] leading-relaxed text-[#5a5a5a]">
          Agent 调用 <code className="rounded-sm bg-[#1e1e1e] px-1 font-mono text-[10px] text-[#4ec9b0]">{location.origin}/mcp</code>，携带
          Bearer Token
        </div>
        <form onSubmit={create} className="mb-2 flex gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="用途标识，如 claude-code"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button type="submit" className="shrink-0 rounded-sm bg-[#0e639c] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#1177bb]">
            生成
          </button>
        </form>
        {created && (
          <div className="mb-2 rounded-sm border border-[#cca700]/60 bg-[#3b3116] p-2">
            <div className="mb-1 text-[11px] font-medium text-[#cca700]">Token 仅显示一次：</div>
            <div className="break-all font-mono text-[11px] text-[#4ec9b0]">{created}</div>
            <button onClick={() => setCreated(null)} className="mt-1 text-[10px] text-[#858585] hover:text-[#cccccc]">
              已保存，关闭
            </button>
          </div>
        )}
        <div className="flex flex-col gap-1">
          {tokens.map((t) => (
            <div key={t.id} className="group flex items-center gap-1.5 rounded-sm px-2 py-[3px] text-[12px] hover:bg-[#2a2d2e]">
              <span className="truncate text-[#cccccc]">{t.name}</span>
              <span className="ml-auto hidden shrink-0 text-[10px] text-[#5a5a5a] group-hover:inline">{t.last_used_at ?? '未使用'}</span>
              <button
                title="吊销"
                className="hidden shrink-0 rounded px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c] group-hover:block"
                onClick={() => void revoke(t)}
              >
                ×
              </button>
            </div>
          ))}
          {tokens.length === 0 && <div className="text-[11px] text-[#5a5a5a]">暂无 Token</div>}
        </div>
      </div>

      <div className="border-t border-[#252526] pt-3">
        <div className="mb-2 text-[13px] font-semibold text-[#cccccc]">危险命令规则</div>
        <div className="mb-2 text-[11px] leading-relaxed text-[#5a5a5a]">
          MCP 执行匹配规则的命令时：拦截（block）或弹窗审批（approve）
        </div>
        <form onSubmit={addRule} className="mb-2 flex flex-col gap-1.5">
          <input
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
            placeholder="正则，如 ^\s*rm\s+-rf\s+/"
            className={`${inputCls} font-mono`}
          />
          <div className="flex gap-1.5">
            <select
              value={ruleAction}
              onChange={(e) => setRuleAction(e.target.value as 'block' | 'approve')}
              className={`${inputCls} shrink-0`}
            >
              <option value="block">拦截</option>
              <option value="approve">审批</option>
            </select>
            <input
              value={ruleNote}
              onChange={(e) => setRuleNote(e.target.value)}
              placeholder="说明"
              className={`${inputCls} min-w-0 flex-1`}
            />
            <button type="submit" className="shrink-0 rounded-sm bg-[#0e639c] px-2 py-1 text-[12px] text-white hover:bg-[#1177bb]">
              ＋
            </button>
          </div>
        </form>
        <div className="flex flex-col gap-1">
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
          {rules.length === 0 && <div className="text-[11px] text-[#5a5a5a]">暂无规则</div>}
        </div>
      </div>

      {error && <div className="rounded-sm bg-[#3b1d1d] px-3 py-1 text-[11px] text-[#f14c4c]">{error}</div>}
    </div>
  );
}

/** 设置页：左侧分类导航 + 右侧内容 */
export function SettingsTab() {
  const [section, setSection] = useState<'terminal' | 'monitor' | 'mcp' | 'quick'>('terminal');
  const themeName = useStore((s) => s.terminalTheme);
  const setTerminalTheme = useStore((s) => s.setTerminalTheme);

  const nav: Array<{ key: typeof section; label: string; icon: string }> = [
    { key: 'terminal', label: '终端', icon: '⌨️' },
    { key: 'monitor', label: '监控', icon: '📈' },
    { key: 'mcp', label: 'MCP', icon: '🤖' },
    { key: 'quick', label: '快捷命令', icon: '⚡' },
  ];

  return (
    <div className="flex h-full min-h-0 bg-[#1e1e1e]">
      {/* 左侧分类导航 */}
      <div className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[#252526] bg-[#252526] p-2">
        {nav.map((n) => (
          <button
            key={n.key}
            onClick={() => setSection(n.key)}
            className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] ${
              section === n.key ? 'bg-[#094771] text-white' : 'text-[#cccccc] hover:bg-[#2a2d2e]'
            }`}
          >
            <span>{n.icon}</span>
            {n.label}
          </button>
        ))}
      </div>
      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {section === 'terminal' && (
          <div className="flex flex-col gap-2">
            <div className="mb-1 text-[13px] font-semibold text-[#cccccc]">终端主题</div>
            {Object.entries(THEME_NAMES).map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-2 text-[12px] text-[#cccccc]">
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
        )}
        {section === 'monitor' && (
          <div className="flex flex-col gap-2">
            <div className="mb-1 text-[13px] font-semibold text-[#cccccc]">告警阈值</div>
            <AlertThresholds />
          </div>
        )}
        {section === 'mcp' && <McpSettings />}
        {section === 'quick' && (
          <div className="flex flex-col gap-2">
            <div className="mb-1 text-[13px] font-semibold text-[#cccccc]">快捷命令</div>
            <QuickCommands />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 传输管理器 ----------

function fmtRate(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M/s`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}K/s`;
  return `${n.toFixed(0)}B/s`;
}

export function TransferTab() {
  const transfers = useStore((s) => s.transfers);
  const clearTransfers = useStore((s) => s.clearTransfers);
  const running = transfers.filter((t) => t.status === 'running');
  const done = transfers.filter((t) => t.status === 'done').slice(-50).reverse();
  const failed = transfers.filter((t) => t.status === 'error').reverse();

  const Row = ({ t }: { t: (typeof transfers)[number] }) => {
    const pct = t.size > 0 ? Math.min(100, Math.round((t.transferred / t.size) * 100)) : 0;
    return (
      <div className="rounded-sm border border-[#252526] bg-[#252526] px-3 py-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className={t.direction === 'up' ? 'text-[#4fc1ff]' : 'text-[#4ec9b0]'}>
            {t.direction === 'up' ? '⬆' : '⬇'}
          </span>
          <span className="min-w-0 flex-1 truncate text-[#cccccc]">{t.name}</span>
          <span className="shrink-0 text-[10px] text-[#5a5a5a]">{t.hostName}</span>
          <span className="shrink-0 text-[10px] text-[#5a5a5a]">{new Date(t.ts).toLocaleTimeString()}</span>
          {t.status === 'error' && <span className="shrink-0 text-[#f14c4c]">✗</span>}
        </div>
        {t.status === 'running' && t.size > 0 && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded bg-[#3a3d41]">
              <div className="h-full bg-[#007acc]" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 text-[10px] text-[#858585]">
              {fmtBytes(t.transferred)} / {fmtBytes(t.size)} · {pct}%
            </span>
          </div>
        )}
        {t.status === 'running' && t.size === 0 && (
          <div className="mt-1 text-[10px] text-[#5a5a5a]">
            传输中… {t.transferred > 0 ? `${fmtBytes(t.transferred)} · ${fmtRate(t.transferred / Math.max(1, (Date.now() - t.ts) / 1000))}` : ''}
          </div>
        )}
        {t.status === 'error' && t.error && <div className="mt-1 text-[10px] text-[#f14c4c]">{t.error}</div>}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-[#252526] bg-[#252526] px-3 text-[12px]">
        <span className="font-medium text-[#cccccc]">文件传输</span>
        <button
          onClick={clearTransfers}
          className="rounded-sm px-2 py-0.5 text-[11px] text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          title="清空已完成记录"
        >
          🗑 清空记录
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {running.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-[#4fc1ff]">进行中 ({running.length})</div>
            <div className="flex flex-col gap-1.5">
              {running.map((t) => (
                <Row key={t.id} t={t} />
              ))}
            </div>
          </div>
        )}
        {failed.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-[#f14c4c]">失败 ({failed.length})</div>
            <div className="flex flex-col gap-1.5">
              {failed.map((t) => (
                <Row key={t.id} t={t} />
              ))}
            </div>
          </div>
        )}
        {done.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-[#4ec9b0]">已完成 ({done.length})</div>
            <div className="flex flex-col gap-1.5">
              {done.map((t) => (
                <Row key={t.id} t={t} />
              ))}
            </div>
          </div>
        )}
        {transfers.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[#5a5a5a]">
            <div className="text-3xl">📁</div>
            <div>暂无传输记录，上传/下载文件后这里会展示进度</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 审计 ----------

export function AuditTab() {
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
    <div className="flex h-full min-h-0 flex-col bg-[#1e1e1e]">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-[#252526] bg-[#252526] px-3">
        <span className="text-[12px] font-medium text-[#cccccc]">审计日志</span>
        <div className="flex gap-3 text-[11px] text-[#858585]">
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
        <button onClick={() => void load()} className="ml-auto rounded px-1.5 text-[#858585] hover:bg-[#3a3d41] hover:text-white" title="刷新">
          ↻
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {shown.map((e) => (
          <div key={e.id} className="rounded-sm px-2 py-[3px] hover:bg-[#2a2d2e]">
            <div className="flex items-center gap-1.5 text-[12px]">
              <span className={e.source === 'mcp' ? 'text-[#cca700]' : 'text-[#4fc1ff]'}>{e.source === 'mcp' ? 'MCP' : 'Web'}</span>
              <span className="truncate font-mono text-[#9cdcfe]">{e.command || '—'}</span>
              {e.exit_code !== null && (
                <span className={e.exit_code === 0 ? 'ml-auto shrink-0 text-[#4ec9b0]' : 'ml-auto shrink-0 text-[#f14c4c]'}>{e.exit_code}</span>
              )}
            </div>
            <div className="text-[10px] text-[#5a5a5a]">
              {e.ts} · {e.host_name ?? '-'} · {e.duration_ms}ms
            </div>
          </div>
        ))}
        {shown.length === 0 && <div className="px-3 py-1 text-[12px] text-[#5a5a5a]">暂无记录</div>}
      </div>
    </div>
  );
}
