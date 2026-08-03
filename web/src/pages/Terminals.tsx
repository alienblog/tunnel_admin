import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStore,
  collectGroups,
  computeGroupRects,
  computeLeafRects,
  type LayoutNode,
  type Rect,
} from '../store';
import TerminalView from '../components/TerminalView';
import DropOverlay from '../components/DropOverlay';
import OuterWorkspace, { OuterTabContent, OuterTabIcon, outerLabel } from './OuterLayout';

/**
 * 双层工作区（VSCode 编辑器组模型）：
 * - 外层 = 通用 tab（主机工作区 / 文件编辑器 / 设置 / 传输管理器 / 审计）
 * - 主机工作区内层 = 布局树（group / split）
 * - group = 终端组：自带 tab 栏（含加号），加号在组内新建终端（不分屏）
 * - split = 分屏：分割的是组；拖 tab 到面板边缘分屏、中心合并进该组
 */

function InnerTab({ tabId, groupId }: { tabId: string; groupId: string }) {
  const tab = useStore((s) => s.tabs.find((t) => t.id === tabId));
  const groupActive = useStore((s) => {
    const g = collectGroups(s.hostLayouts[String(tab?.hostId)] ?? null).find((x) => x.id === groupId);
    return g?.activeTabId ?? null;
  });
  const closeTab = useStore((s) => s.closeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setDragTab = useStore((s) => s.setDragTab);
  const seq = useStore((s) => {
    const g = collectGroups(s.hostLayouts[String(tab?.hostId)] ?? null).find((x) => x.id === groupId);
    return (g?.tabIds ?? []).indexOf(tabId);
  });

  if (!tab) return null;
  const active = groupActive === tabId;
  const label = seq > 0 ? `${tab.hostName} #${seq + 1}` : tab.hostName;

  return (
    <div
      draggable
      onDragStart={(e) => {
        setDragTab(tabId);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDragTab(null)}
      onClick={() => setActiveTab(tabId)}
      className={`group flex cursor-grab items-center gap-1.5 border-r border-[#1e1e1e] px-2.5 text-[12px] whitespace-nowrap select-none active:cursor-grabbing ${
        active ? 'border-t-2 border-t-[#007acc] bg-[#1e1e1e] text-white' : 'bg-[#2d2d2d] text-[#969696] hover:bg-[#333333]'
      }`}
      title="拖动可停靠分屏"
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          tab.ended
            ? 'bg-[#5a5a5a]'
            : tab.status === 'connected'
              ? 'bg-[#4ec9b0]'
              : tab.status === 'error'
                ? 'bg-[#f14c4c]'
                : 'animate-pulse bg-[#cca700]'
        }`}
      />
      {tab.kind === 'agent' && <span className="text-[#4fc1ff]">🤖</span>}
      <span className="max-w-28 truncate">{label}</span>
      {tab.notify === 'error' && <span className="animate-pulse text-[#f14c4c]">✗</span>}
      {tab.notify === 'warning' && <span className="animate-pulse text-[#cca700]">⚠</span>}
      {tab.notify === 'success' && <span className="animate-pulse text-[#4ec9b0]">✓</span>}
      {tab.ended && <span className="text-[10px] text-[#6a6a6a]">已结束</span>}
      <button
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tabId);
        }}
        title="关闭"
        className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

/** 终端组面板：tab 栏 + 内容 + 拖拽停靠目标 */
function GroupPanel({ node, hostId }: { node: Extract<LayoutNode, { type: 'group' }>; hostId: string }) {
  const activeTabId = node.activeTabId ?? node.tabIds[0] ?? null;
  const addTerminalToGroup = useStore((s) => s.addTerminalToGroup);
  const setActiveTab = useStore((s) => s.setActiveTab);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 组内 tab 栏 + 加号 */}
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto bg-[#252526]">
        {node.tabIds.map((id) => (
          <InnerTab key={id} tabId={id} groupId={node.id} />
        ))}
        <button
          title="在此组新建终端"
          onClick={() => addTerminalToGroup(hostId, node.id)}
          className="flex items-center px-2 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
        >
          ＋
        </button>
      </div>
      {/* 内容区：终端本体由终端池按布局矩形绝对定位渲染；拖拽停靠由 DropOverlay 按矩形统一处理 */}
      <div className="relative min-h-0 flex-1" onClick={() => activeTabId && setActiveTab(activeTabId)}>
        {node.tabIds.length === 0 && (
          <div className="flex h-full items-center justify-center text-[#5a5a5a]">终端已关闭</div>
        )}
      </div>
    </div>
  );
}

function SplitView({ node, hostId }: { node: Extract<LayoutNode, { type: 'split' }>; hostId: string }) {
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const ref = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startPos: number; startRatio: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const total = node.dir === 'h' ? rect.width : rect.height;
    if (total === 0) return;
    dragState.current = {
      startPos: node.dir === 'h' ? e.clientX : e.clientY,
      startRatio: node.ratio,
      total,
    };
    setDragging(true);
    const move = (ev: PointerEvent): void => {
      const st = dragState.current;
      if (!st) return;
      const delta = (node.dir === 'h' ? ev.clientX : ev.clientY) - st.startPos;
      const ratio = Math.min(0.85, Math.max(0.15, st.startRatio + delta / st.total));
      setSplitRatio(hostId, node.id, ratio);
    };
    const up = (): void => {
      dragState.current = null;
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const horizontal = node.dir === 'h';
  return (
    <div ref={ref} className={`relative flex h-full min-h-0 min-w-0 ${horizontal ? 'flex-row' : 'flex-col'}`}>
      <div className="min-h-0 min-w-0" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <LayoutNodeView node={node.children[0]} hostId={hostId} />
      </div>
      <div
        title="拖动调整分屏大小"
        onPointerDown={onPointerDown}
        className={`z-10 shrink-0 bg-[#252526] hover:bg-[#007acc]/60 ${
          horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        }`}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <LayoutNodeView node={node.children[1]} hostId={hostId} />
      </div>
      {dragging && <div className="absolute inset-0 z-20" />}
    </div>
  );
}

function LayoutNodeView({ node, hostId }: { node: LayoutNode; hostId: string }) {
  // key = node.id：布局重组（拖拽移动 tab / 分屏调整）时 React 按 key 保留组件实例，
  // 未移动的面板不卸载（终端本体在 TerminalPool，天然不受布局重组影响）
  if (node.type === 'group') return <GroupPanel key={node.id} node={node} hostId={hostId} />;
  return <SplitView key={node.id} node={node} hostId={hostId} />;
}

/**
 * 主机工作区：布局壳（tab 栏 / 分隔栏 / 拖拽停靠） + 终端池（绝对定位渲染 TerminalView）。
 * 终端池独立于布局树：拖拽分屏 / 合并 / 根节点类型变化时 TerminalView 永不卸载，
 * 连接与 xterm 历史完整保留；布局变化只更新每个 tab 的视口矩形。
 */
export function HostWorkspace({ hostId }: { hostId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layout = useStore((s) => s.hostLayouts[hostId]);
  const tabs = useStore((s) => s.tabs);
  const dragTabId = useStore((s) => s.dragTabId);
  const moveTab = useStore((s) => s.moveTab);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rects = useMemo(() => {
    if (!layout || size.w === 0 || size.h === 0) return new Map<string, Rect>();
    return computeLeafRects(layout, { x: 0, y: 0, w: size.w, h: size.h });
  }, [layout, size]);

  const groupRects = useMemo(() => {
    if (!layout || size.w === 0 || size.h === 0) return new Map<string, Rect>();
    return computeGroupRects(layout, { x: 0, y: 0, w: size.w, h: size.h });
  }, [layout, size]);

  const hostTabs = useMemo(
    () => tabs.filter((t) => t.hostId === Number(hostId)),
    [tabs, hostId],
  );

  return (
    <div ref={containerRef} className="relative h-full min-h-0 min-w-0">
      {layout ? (
        <LayoutNodeView node={layout} hostId={hostId} />
      ) : (
        <div className="flex h-full items-center justify-center text-[#5a5a5a]">终端已全部关闭</div>
      )}
      {hostTabs.map((t) => (
        <TerminalView key={t.id} tab={t} rect={rects.get(t.id) ?? null} />
      ))}
      {/* 内层拖拽：全屏覆盖层按 group 矩形计算停靠（内容池与布局壳分离后事件不再经过壳） */}
      {!!dragTabId && (
        <DropOverlay
          groupRects={groupRects}
          onGroupDrop={(gid, pos) => {
            const id = useStore.getState().dragTabId;
            if (id) moveTab(id, gid, pos);
          }}
          onDockDrop={() => {}}
        />
      )}
    </div>
  );
}

export default function Terminals() {
  const outerTabs = useStore((s) => s.outerTabs);
  const rightDockId = useStore((s) => s.rightDockId);
  const rightDockCollapsed = useStore((s) => s.rightDockCollapsed);
  const toggleRightDock = useStore((s) => s.toggleRightDock);
  const setRightDock = useStore((s) => s.setRightDock);
  const closeOuterTab = useStore((s) => s.closeOuterTab);
  const openOuterTab = useStore((s) => s.openOuterTab);
  const setOuterDragId = useStore((s) => s.setOuterDragId);
  const hosts = useStore((s) => s.hosts);
  const rightTab = outerTabs.find((t) => t.id === rightDockId) ?? null;
  const rightLabel = rightTab
    ? rightTab.kind === 'host'
      ? (hosts.find((h) => String(h.id) === rightTab.hostId)?.name ?? rightTab.hostId)
      : outerLabel(rightTab)
    : '';

  return (
    <div className="flex h-full min-h-0">
      {/* 主区：第一层布局（tab 栏按组渲染，可拖拽分屏/合并/停靠右栏） */}
      <div className="flex min-w-0 flex-1 flex-col">
        <OuterWorkspace />
      </div>
      {/* 固定右栏（拖外层 tab 到主区右缘停靠；可展开/折叠/移回主区/关闭） */}
      {rightTab && (
        <div className={`flex shrink-0 flex-col border-l border-[#1e1e1e] bg-[#252526] ${rightDockCollapsed ? 'w-9' : 'w-80'}`}>
          <div
            draggable
            onDragStart={(e) => {
              setOuterDragId(rightTab.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => setOuterDragId(null)}
            title="拖动到主区可移回布局"
            className="flex h-8 shrink-0 cursor-grab items-center gap-1 border-b border-[#1e1e1e] px-1 active:cursor-grabbing"
          >
            <button
              title={rightDockCollapsed ? '展开右栏' : '折叠右栏'}
              onClick={toggleRightDock}
              className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
            >
              {rightDockCollapsed ? '«' : '»'}
            </button>
            {!rightDockCollapsed && (
              <>
                <OuterTabIcon tab={rightTab} />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[#cccccc]">{rightLabel}</span>
                <button
                  title="移回主区"
                  onClick={() => {
                    openOuterTab(rightTab);
                    setRightDock(null);
                  }}
                  className="rounded-sm px-1 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
                >
                  ⇱
                </button>
                <button
                  title="关闭"
                  onClick={() => closeOuterTab(rightTab.id)}
                  className="rounded-sm px-1 text-[#858585] hover:bg-[#f14c4c]/20 hover:text-[#f14c4c]"
                >
                  ×
                </button>
              </>
            )}
          </div>
          {!rightDockCollapsed && (
            <div className="min-h-0 flex-1">
              <OuterTabContent tab={rightTab} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
