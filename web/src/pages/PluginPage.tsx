import { useEffect, useMemo } from 'react';
import { useStore } from '../store';

/**
 * 插件页面容器：iframe 承载插件 web/ 资源（同源，cookie 自动携带鉴权）。
 * 插件页面通过 <script src="/api/plugins/ta-client.js"> 获取 window.ta（宿主桥）。
 *
 * 桥协议（iframe → 宿主，postMessage）：
 * - { source:'ta-plugin', type:'ssh-connect', id, token, name }
 *   → 宿主打开动态终端（token 由插件后端 ctx.ssh.requestConnect 产生），回发
 *   { source:'ta-plugin', type:'ssh-connect-result', id, ok, tabId?, error? }
 */
export default function PluginPage({ pluginId }: { pluginId: string }) {
  const plugin = useStore((s) => s.plugins.find((p) => p.id === pluginId));
  const src = useMemo(() => {
    if (!plugin || !plugin.enabled || plugin.ui.length === 0) return null;
    const ui = plugin.ui[0];
    return `/api/plugins/${encodeURIComponent(plugin.id)}/assets/${ui.entry}?plugin=${encodeURIComponent(plugin.id)}`;
  }, [plugin]);

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const d = e.data as { source?: string; type?: string; id?: string; token?: string; name?: string } | null;
      if (!d || d.source !== 'ta-plugin' || d.type !== 'ssh-connect' || !d.token) return;
      const reply = (payload: Record<string, unknown>): void => {
        // 回给消息来源窗口（iframe），不能发到父页自身 window
        (e.source as Window | null)?.postMessage({ source: 'ta-plugin', type: 'ssh-connect-result', id: d.id, ...payload }, '*');
      };
      try {
        const tabId = useStore.getState().openDynamicTerminal(d.token, d.name || '动态设备');
        reply({ ok: true, tabId });
      } catch (err) {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!plugin) {
    return <div className="p-6 text-sm text-[#858585]">插件不存在或未加载。</div>;
  }
  if (!plugin.enabled) {
    return <div className="p-6 text-sm text-[#858585]">插件已禁用。</div>;
  }
  if (plugin.error) {
    return <div className="p-6 text-sm text-[#f14c4c]">插件加载失败：{plugin.error}</div>;
  }
  if (!src) {
    return <div className="p-6 text-sm text-[#858585]">插件未声明页面入口（plugin.json 缺少 ui）。</div>;
  }
  return <iframe key={src} src={src} title={plugin.name} className="h-full w-full border-0 bg-[#1e1e1e]" />;
}
