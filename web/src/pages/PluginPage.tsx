import { useMemo } from 'react';
import { useStore } from '../store';

/**
 * 插件页面容器：iframe 承载插件 web/ 资源（同源，cookie 自动携带鉴权）。
 * 插件页面通过 <script src="/api/plugins/ta-client.js"> 获取 window.ta（宿主桥）。
 * iframe 关闭时自动销毁（卸载组件即卸载页面，不保留状态）。
 */
export default function PluginPage({ pluginId }: { pluginId: string }) {
  const plugin = useStore((s) => s.plugins.find((p) => p.id === pluginId));
  const src = useMemo(() => {
    if (!plugin || !plugin.enabled || plugin.ui.length === 0) return null;
    const ui = plugin.ui[0];
    return `/api/plugins/${encodeURIComponent(plugin.id)}/assets/${ui.entry}?plugin=${encodeURIComponent(plugin.id)}`;
  }, [plugin]);

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
