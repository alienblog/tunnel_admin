import { useRef, useState } from 'react';
import {
  useStore,
  collectGroups,
  collectLeaves,
  type DropPos,
  type LayoutNode,
} from '../store';
import TerminalView from '../components/TerminalView';

/**
 * 双层工作区（VSCode 编辑器组模型）：
 * - 外层 = 主机 tab；内层 = 该主机的布局树（group / split）
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
  const tab = useStore((s) => s.tabs.find((t) => t.id === activeTabId));
  const addTerminalToGroup = useStore((s) => s.addTerminalToGroup);
  const moveTab = useStore((s) => s.moveTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const dropPosRef = useRef<DropPos | null>(null);

  const onDragOver = (e: React.DragEvent): void => {
    const dragId = useStore.getState().dragTabId;
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const pos: DropPos =
      x < 0.25 ? 'left' : x > 0.75 ? 'right' : y < 0.25 ? 'top' : y > 0.75 ? 'bottom' : 'center';
    dropPosRef.current = pos;
    setDropPos((prev) => (prev === pos ? prev : pos));
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    const dragId = useStore.getState().dragTabId;
    if (dragId) moveTab(dragId, node.id, dropPosRef.current ?? 'center');
    dropPosRef.current = null;
    setDropPos(null);
  };

  const indicator: Record<DropPos, string> = {
    left: 'left-0 top-0 bottom-0 w-1/4',
    right: 'right-0 top-0 bottom-0 w-1/4',
    top: 'top-0 left-0 right-0 h-1/4',
    bottom: 'bottom-0 left-0 right-0 h-1/4',
    center: 'inset-0',
  };

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
      {/* 内容 + 拖拽停靠目标 */}
      <div
        className="relative min-h-0 flex-1"
        onClick={() => activeTabId && setActiveTab(activeTabId)}
        onDragOver={onDragOver}
        onDragLeave={() => setDropPos(null)}
        onDrop={onDrop}
      >
        {tab ? (
          <TerminalView tab={tab} />
        ) : (
          <div className="flex h-full items-center justify-center text-[#5a5a5a]">终端已关闭</div>
        )}
        {dropPos && (
          <div className={`pointer-events-none absolute ${indicator[dropPos]} bg-[#007acc]/30`} />
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
  if (node.type === 'group') return <GroupPanel node={node} hostId={hostId} />;
  return <SplitView node={node} hostId={hostId} />;
}

export default function Terminals() {
  const outerHost = useStore((s) => s.outerHost);
  const hostLayouts = useStore((s) => s.hostLayouts);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeHostWorkspace = useStore((s) => s.closeHostWorkspace);
  const tabs = useStore((s) => s.tabs);

  const hostIds = Object.keys(hostLayouts).filter((h) => hostLayouts[h] !== null);

  return (
    <div className="flex h-full flex-col">
      {/* 外层主机 tab 栏 */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[#1e1e1e] bg-[#2d2d2d]">
        {hostIds.map((hostId) => {
          const leaves = collectLeaves(hostLayouts[hostId]);
          const host = tabs.find((t) => t.id === leaves[0]);
          const active = outerHost === hostId;
          return (
            <div
              key={hostId}
              onClick={() => {
                const first = leaves[0];
                if (first) setActiveTab(first);
              }}
              className={`group flex cursor-pointer items-center gap-1.5 border-r border-[#1e1e1e] px-3 text-[13px] whitespace-nowrap select-none ${
                active ? 'border-t-2 border-t-[#007acc] bg-[#1e1e1e] text-white' : 'text-[#969696] hover:bg-[#333333]'
              }`}
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#858585]" fill="currentColor">
                <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
              </svg>
              <span className="max-w-32 truncate">{host?.hostName ?? hostId}</span>
              <span className="rounded-sm bg-[#3a3d41] px-1 text-[10px] text-[#cccccc]">{leaves.length}</span>
              <button
                title="关闭该主机全部终端"
                onClick={(e) => {
                  e.stopPropagation();
                  closeHostWorkspace(hostId);
                }}
                className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
              >
                ×
              </button>
            </div>
          );
        })}
        {hostIds.length === 0 && (
          <div className="flex items-center px-3 text-[12px] text-[#5a5a5a]">从左侧主机列表选择主机打开终端</div>
        )}
      </div>

      {/* 内层：活动主机的布局 */}
      <div className="relative min-h-0 flex-1">
        {outerHost && hostLayouts[outerHost] ? (
          <div className="h-full">
            <LayoutNodeView node={hostLayouts[outerHost]} hostId={outerHost} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[#5a5a5a]">
            <div className="text-4xl">⌨️</div>
            <div>从左侧主机列表选择主机打开终端</div>
          </div>
        )}
      </div>
    </div>
  );
}
