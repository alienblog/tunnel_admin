import { useRef, useState } from 'react';
import {
  useStore,
  collectGroups,
  collectLeaves,
  type DropPos,
  type LayoutNode,
  type OuterTab,
} from '../store';
import TerminalView from '../components/TerminalView';
import { AuditTab, EditorTab, SettingsTab, TransferTab } from './tabs';

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

/** 外层 tab 标签图标 */
function OuterTabIcon({ tab }: { tab: OuterTab }) {
  if (tab.kind === 'host') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#858585]" fill="currentColor">
        <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
      </svg>
    );
  }
  if (tab.kind === 'editor') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#4fc1ff]" fill="currentColor">
        <path d="M2 1.5h4.5l2 2H14a1 1 0 011 1V13a1 1 0 01-1 1H2a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
      </svg>
    );
  }
  if (tab.kind === 'transfer') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#4ec9b0]" fill="currentColor">
        <path d="M8 1.5a.75.75 0 01.75.75v9.19l2.47-2.47a.75.75 0 111.06 1.06l-3.75 3.75a.75.75 0 01-1.06 0l-3.75-3.75a.75.75 0 111.06-1.06l2.47 2.47V2.25A.75.75 0 018 1.5z" />
      </svg>
    );
  }
  if (tab.kind === 'audit') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#cca700]" fill="currentColor">
        <path d="M2 3.75A.75.75 0 012.75 3h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4A.75.75 0 012.75 7h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.75zm0 4A.75.75 0 012.75 11h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 012 11.75z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-[#858585]" fill="currentColor">
      <path d="M6.5 1.5a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75V2.9a4.25 4.25 0 011.8 1.04l1.46-.6a.75.75 0 01.97.34l.75 1.3a.75.75 0 01-.25 1L13.5 7a4.3 4.3 0 010 2l1.23.96a.75.75 0 01.25 1l-.75 1.3a.75.75 0 01-.97.34l-1.46-.6a4.25 4.25 0 01-1.8 1.04v1.76a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75v-1.76a4.25 4.25 0 01-1.8-1.04l-1.46.6a.75.75 0 01-.97-.34l-.75-1.3a.75.75 0 01.25-1L2.5 9a4.3 4.3 0 010-2L1.27 6.04a.75.75 0 01-.25-1l.75-1.3a.75.75 0 01.97-.34l1.46.6a4.25 4.25 0 011.8-1.04V1.5zM8 5.25A2.75 2.75 0 108 10.75 2.75 2.75 0 008 5.25z" />
    </svg>
  );
}

export default function Terminals() {
  const outerTabs = useStore((s) => s.outerTabs);
  const activeOuterId = useStore((s) => s.activeOuterId);
  const hostLayouts = useStore((s) => s.hostLayouts);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActiveOuter = useStore((s) => s.setActiveOuter);
  const closeOuterTab = useStore((s) => s.closeOuterTab);
  const tabs = useStore((s) => s.tabs);

  const activeTab = outerTabs.find((t) => t.id === activeOuterId) ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* 外层 tab 栏 */}
      <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[#1e1e1e] bg-[#2d2d2d]">
        {outerTabs.map((tab) => {
          const active = tab.id === activeOuterId;
          if (tab.kind === 'host') {
            const leaves = collectLeaves(hostLayouts[tab.hostId]);
            const host = tabs.find((t) => t.id === leaves[0]);
            return (
              <div
                key={tab.id}
                onClick={() => {
                  setActiveOuter(tab.id);
                  const first = leaves[0];
                  if (first) setActiveTab(first);
                }}
                className={`group flex cursor-pointer items-center gap-1.5 border-r border-[#1e1e1e] px-3 text-[13px] whitespace-nowrap select-none ${
                  active ? 'border-t-2 border-t-[#007acc] bg-[#1e1e1e] text-white' : 'text-[#969696] hover:bg-[#333333]'
                }`}
              >
                <OuterTabIcon tab={tab} />
                <span className="max-w-32 truncate">{host?.hostName ?? tab.hostId}</span>
                <span className="rounded-sm bg-[#3a3d41] px-1 text-[10px] text-[#cccccc]">{leaves.length}</span>
                <button
                  title="关闭该主机全部终端"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeOuterTab(tab.id);
                  }}
                  className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
                >
                  ×
                </button>
              </div>
            );
          }
          // 工具 tab：设置 / 传输 / 审计 / 编辑器
          const label =
            tab.kind === 'settings' ? '设置' : tab.kind === 'transfer' ? '传输' : tab.kind === 'audit' ? '审计' : tab.name;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveOuter(tab.id)}
              className={`group flex cursor-pointer items-center gap-1.5 border-r border-[#1e1e1e] px-3 text-[13px] whitespace-nowrap select-none ${
                active ? 'border-t-2 border-t-[#007acc] bg-[#1e1e1e] text-white' : 'text-[#969696] hover:bg-[#333333]'
              }`}
              title={tab.kind === 'editor' ? tab.path : label}
            >
              <OuterTabIcon tab={tab} />
              <span className="max-w-40 truncate">{label}</span>
              <button
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  closeOuterTab(tab.id);
                }}
                className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
              >
                ×
              </button>
            </div>
          );
        })}
        {outerTabs.length === 0 && (
          <div className="flex items-center px-3 text-[12px] text-[#5a5a5a]">从左侧主机列表选择主机打开终端</div>
        )}
      </div>

      {/* 内容区 */}
      <div className="relative min-h-0 flex-1">
        {!activeTab ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[#5a5a5a]">
            <div className="text-4xl">⌨️</div>
            <div>从左侧主机列表选择主机打开终端</div>
          </div>
        ) : activeTab.kind === 'host' ? (
          <div className="h-full">
            {hostLayouts[activeTab.hostId] ? (
              <LayoutNodeView node={hostLayouts[activeTab.hostId]} hostId={activeTab.hostId} />
            ) : (
              <div className="flex h-full items-center justify-center text-[#5a5a5a]">终端已全部关闭</div>
            )}
          </div>
        ) : activeTab.kind === 'editor' ? (
          <EditorTab tab={activeTab} />
        ) : activeTab.kind === 'settings' ? (
          <SettingsTab />
        ) : activeTab.kind === 'transfer' ? (
          <TransferTab />
        ) : (
          <AuditTab />
        )}
      </div>
    </div>
  );
}
