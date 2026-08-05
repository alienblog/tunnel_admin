import { useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { PluginInfo } from '../store';

/**
 * 插件管理页：已安装/开发目录插件列表、安装 .taplugin 包、启用/禁用/卸载、开发目录管理。
 */
export default function PluginsManage() {
  const plugins = useStore((s) => s.plugins);
  const loadPlugins = useStore((s) => s.loadPlugins);
  const openOuterTab = useStore((s) => s.openOuterTab);
  const setView = useStore((s) => s.setView);
  const [busy, setBusy] = useState(false);
  const [devDirs, setDevDirs] = useState<string[]>([]);
  const [dirInput, setDirInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = async (): Promise<void> => {
    await loadPlugins();
    try {
      const { dirs } = await api<{ dirs: string[] }>('/api/plugins/devdirs');
      setDevDirs(dirs);
    } catch {
      // 忽略
    }
  };

  const act = async (fn: () => Promise<unknown>, okText: string): Promise<void> => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'ok', text: okText });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const install = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    }
    const contentBase64 = btoa(bin);
    await act(() => api('/api/plugins/install', { method: 'POST', body: JSON.stringify({ filename: file.name, contentBase64 }) }), `已安装 ${file.name}`);
    if (fileRef.current) fileRef.current.value = '';
  };

  const openPlugin = (p: PluginInfo): void => {
    setView(`plugin:${p.id}`);
    openOuterTab({ kind: 'plugin', id: `plugin:${p.id}`, pluginId: p.id });
  };

  return (
    <div className="h-full overflow-y-auto bg-[#1e1e1e] p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-medium text-[#cccccc]">插件管理</h2>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".taplugin"
            className="hidden"
            onChange={(e) => void install(e.target.files?.[0])}
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="rounded-sm border border-[#3c3c3c] bg-[#2d2d2d] px-3 py-1.5 text-sm text-[#cccccc] hover:bg-[#3a3a3a] disabled:opacity-50"
          >
            安装 .taplugin…
          </button>
          <button
            onClick={() => void act(() => api('/api/plugins/reload', { method: 'POST' }), '已重新加载插件')}
            disabled={busy}
            className="rounded-sm border border-[#3c3c3c] bg-[#2d2d2d] px-3 py-1.5 text-sm text-[#cccccc] hover:bg-[#3a3a3a] disabled:opacity-50"
          >
            重新加载
          </button>
        </div>
      </div>

      {msg && (
        <div className={`mb-3 rounded-sm border px-3 py-2 text-sm ${msg.kind === 'ok' ? 'border-[#4ec9b0]/50 text-[#4ec9b0]' : 'border-[#f14c4c]/50 text-[#f14c4c]'}`}>
          {msg.text}
        </div>
      )}

      <div className="space-y-2">
        {plugins.length === 0 && <div className="py-8 text-center text-sm text-[#858585]">暂无插件。安装 .taplugin 包，或在下方添加本地插件开发目录。</div>}
        {plugins.map((p) => (
          <div key={p.id} className="flex items-start justify-between rounded-sm border border-[#3c3c3c] bg-[#252526] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[#cccccc]">{p.name}</span>
                <span className="text-xs text-[#858585]">v{p.version}</span>
                {p.enabled ? (
                  <span className="rounded-sm bg-[#4ec9b0]/15 px-1.5 py-0.5 text-xs text-[#4ec9b0]">已启用</span>
                ) : (
                  <span className="rounded-sm bg-[#858585]/15 px-1.5 py-0.5 text-xs text-[#858585]">已禁用</span>
                )}
                <span className="text-xs text-[#6a6a6a]">{p.source === 'dev' ? '开发目录' : '已安装'}</span>
              </div>
              {p.description && <div className="mt-1 truncate text-xs text-[#a0a0a0]">{p.description}</div>}
              {p.error && <div className="mt-1 text-xs text-[#f14c4c]">加载失败：{p.error}</div>}
              <div className="mt-1 truncate text-xs text-[#6a6a6a]">{p.dir}</div>
            </div>
            <div className="ml-4 flex shrink-0 items-center gap-1.5">
              {p.enabled && p.ui.length > 0 && (
                <button
                  onClick={() => openPlugin(p)}
                  className="rounded-sm border border-[#3c3c3c] bg-[#2d2d2d] px-2.5 py-1 text-xs text-[#cccccc] hover:bg-[#3a3a3a]"
                >
                  打开页面
                </button>
              )}
              <button
                onClick={() => void act(() => api(`/api/plugins/${p.id}/${p.enabled ? 'disable' : 'enable'}`, { method: 'POST' }), p.enabled ? '已禁用' : '已启用')}
                disabled={busy || !!p.error}
                className="rounded-sm border border-[#3c3c3c] bg-[#2d2d2d] px-2.5 py-1 text-xs text-[#cccccc] hover:bg-[#3a3a3a] disabled:opacity-40"
              >
                {p.enabled ? '禁用' : '启用'}
              </button>
              {p.source === 'installed' && (
                <button
                  onClick={() => {
                    if (window.confirm(`卸载插件「${p.name}」？`)) void act(() => api(`/api/plugins/${p.id}`, { method: 'DELETE' }), '已卸载');
                  }}
                  disabled={busy}
                  className="rounded-sm border border-[#f14c4c]/40 bg-[#2d2d2d] px-2.5 py-1 text-xs text-[#f14c4c] hover:bg-[#3a1d1d] disabled:opacity-40"
                >
                  卸载
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-medium text-[#cccccc]">本地插件开发目录（开发模式加载，目录本身即插件根）</h3>
        <div className="flex gap-2">
          <input
            value={dirInput}
            onChange={(e) => setDirInput(e.target.value)}
            placeholder="/path/to/my-plugin"
            className="min-w-0 flex-1 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-2.5 py-1.5 text-sm text-[#cccccc] outline-none focus:border-[#4fc1ff]"
          />
          <button
            onClick={() => {
              const d = dirInput.trim();
              if (!d) return;
              setDirInput('');
              void act(async () => {
                const dirs = [...devDirs, d];
                await api('/api/plugins/devdirs', { method: 'PUT', body: JSON.stringify({ dirs }) });
                setDevDirs(dirs);
              }, '已添加开发目录');
            }}
            disabled={busy}
            className="rounded-sm border border-[#3c3c3c] bg-[#2d2d2d] px-3 py-1.5 text-sm text-[#cccccc] hover:bg-[#3a3a3a] disabled:opacity-50"
          >
            添加
          </button>
        </div>
        {devDirs.length === 0 ? (
          <div className="mt-2 text-xs text-[#6a6a6a]">未配置开发目录</div>
        ) : (
          <div className="mt-2 space-y-1">
            {devDirs.map((d) => (
              <div key={d} className="flex items-center justify-between rounded-sm border border-[#3c3c3c] bg-[#252526] px-2.5 py-1.5 text-xs text-[#a0a0a0]">
                <span className="min-w-0 truncate">{d}</span>
                <button
                  onClick={() => void act(async () => {
                    const dirs = devDirs.filter((x) => x !== d);
                    await api('/api/plugins/devdirs', { method: 'PUT', body: JSON.stringify({ dirs }) });
                    setDevDirs(dirs);
                  }, '已移除开发目录')}
                  className="ml-3 shrink-0 text-[#f14c4c] hover:underline"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
