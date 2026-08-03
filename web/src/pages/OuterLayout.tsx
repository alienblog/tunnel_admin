import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStore,
  computeLeafRects,
  type DropPos,
  type LayoutNode,
  type OuterTab,
  type Rect,
} from '../store';
import { HostWorkspace } from './Terminals';
import { AuditTab, EditorTab, SettingsTab, TransferTab } from './tabs';

/**
 * 第一层工作区（VSCode 编辑器组模型）：
 * - 外层 tab（主机/编辑器/设置/传输/审计）也可拖拽分屏/合并（outerLayout 布局树）
 * - 工具页拖到右缘可停靠为固定右栏（可展开/折叠）
 * - 内容与终端同理：渲染在布局树外的池中按矩形绝对定位，布局重组零卸载
 */

/** 外层 tab 显示标签 */
export function outerLabel(tab: OuterTab): string {
  if (tab.kind === 'editor') return tab.name;
  if (tab.kind === 'settings') return '设置';
  if (tab.kind === 'transfer') return '传输';
  if (tab.kind === 'audit') return '审计';
  return tab.hostId;
}

/** 外层 tab 内容（按类型渲染） */
export function OuterTabContent({ tab }: { tab: OuterTab }) {
  if (tab.kind === 'host') return <HostWorkspace hostId={tab.hostId} />;
  if (tab.kind === 'editor') return <EditorTab tab={tab} />;
  if (tab.kind === 'settings') return <SettingsTab />;
  if (tab.kind === 'transfer') return <TransferTab />;
  return <AuditTab />;
}

/** 外层 tab 图标 */
export function OuterTabIcon({ tab }: { tab: OuterTab }) {
  if (tab.kind === 'host') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#858585]" fill="currentColor">
        <path d="M1.5 3A1.5 1.5 0 013 1.5h3.086c.398 0 .78.158 1.061.44l.914.914H13A1.5 1.5 0 0114.5 4.354v8.146A1.5 1.5 0 0113 14H3a1.5 1.5 0 01-1.5-1.5V3z" />
      </svg>
    );
  }
  if (tab.kind === 'editor') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#4fc1ff]" fill="currentColor">
        <path d="M2 1.5h4.5l2 2H14a1 1 0 011 1V13a1 1 0 01-1 1H2a1 1 0 01-1-1V2.5a1 1 0 011-1z" />
      </svg>
    );
  }
  if (tab.kind === 'transfer') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#4ec9b0]" fill="currentColor">
        <path d="M8 1.5a.75.75 0 01.75.75v9.19l2.47-2.47a.75.75 0 111.06 1.06l-3.75 3.75a.75.75 0 01-1.06 0l-3.75-3.75a.75.75 0 111.06-1.06l2.47 2.47V2.25A.75.75 0 018 1.5z" />
      </svg>
    );
  }
  if (tab.kind === 'audit') {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#cca700]" fill="currentColor">
        <path d="M2 3.75A.75.75 0 012.75 3h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.75zm0 4A.75.75 0 012.75 7h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.75zm0 4A.75.75 0 012.75 11h6.5a.75.75 0 010 1.5h-6.5A.75.75 0 012 11.75z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-[#858585]" fill="currentColor">
      <path d="M6.5 1.5a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75V2.9a4.25 4.25 0 011.8 1.04l1.46-.6a.75.75 0 01.97.34l.75 1.3a.75.75 0 01-.25 1L13.5 7a4.3 4.3 0 010 2l1.23.96a.75.75 0 01.25 1l-.75 1.3a.75.75 0 01-.97.34l-1.46-.6a4.25 4.25 0 01-1.8 1.04v1.76a.75.75 0 01-.75.75h-1.5a.75.75 0 01-.75-.75v-1.76a4.25 4.25 0 01-1.8-1.04l-1.46.6a.75.75 0 01-.97-.34l-.75-1.3a.75.75 0 01.25-1L2.5 9a4.3 4.3 0 010-2L1.27 6.04a.75.75 0 01-.25-1l.75-1.3a.75.75 0 01.97-.34l1.46.6a4.25 4.25 0 011.8-1.04V1.5zM8 5.25A2.75 2.75 0 108 10.75 2.75 2.75 0 008 5.25z" />
    </svg>
  );
}

const dropIndicator: Record<DropPos, string> = {
  left: 'left-0 top-0 bottom-0 w-1/4',
  right: 'right-0 top-0 bottom-0 w-1/4',
  top: 'top-0 left-0 right-0 h-1/4',
  bottom: 'bottom-0 left-0 right-0 h-1/4',
  center: 'inset-0',
};

/** 外层 group 面板：tab 栏 + 拖拽停靠目标（内容由池按矩形渲染） */
function OuterGroupPanel({ node }: { node: Extract<LayoutNode, { type: 'group' }> }) {
  const outerTabs = useStore((s) => s.outerTabs);
  const hosts = useStore((s) => s.hosts);
  const setActiveOuter = useStore((s) => s.setActiveOuter);
  const closeOuterTab = useStore((s) => s.closeOuterTab);
  const moveOuterTab = useStore((s) => s.moveOuterTab);
  const setOuterDragId = useStore((s) => s.setOuterDragId);
  const [dropPos, setDropPos] = useState<DropPos | null>(null);
  const dropPosRef = useRef<DropPos | null>(null);
  const activeId = node.activeTabId ?? node.tabIds[0] ?? null;

  const onDragOver = (e: React.DragEvent): void => {
    if (!useStore.getState().outerDragId) return;
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
    const dragId = useStore.getState().outerDragId;
    if (dragId) moveOuterTab(dragId, node.id, dropPosRef.current ?? 'center');
    dropPosRef.current = null;
    setDropPos(null);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 组内 tab 栏（第一层 tab，可拖拽重组布局） */}
      <div className="flex h-8 shrink-0 items-stretch overflow-x-auto bg-[#252526]">
        {node.tabIds.map((id) => {
          const tab = outerTabs.find((t) => t.id === id);
          if (!tab) return null;
          const active = activeId === id;
          const label = tab.kind === 'host' ? (hosts.find((h) => String(h.id) === tab.hostId)?.name ?? tab.hostId) : outerLabel(tab);
          return (
            <div
              key={id}
              draggable
              onDragStart={(e) => {
                setOuterDragId(id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setOuterDragId(null)}
              onClick={() => setActiveOuter(id)}
              title={tab.kind === 'editor' ? tab.path : '拖动可停靠分屏/合并'}
              className={`group flex cursor-grab items-center gap-1.5 border-r border-[#1e1e1e] px-2.5 text-[12px] whitespace-nowrap select-none active:cursor-grabbing ${
                active ? 'border-t-2 border-t-[#007acc] bg-[#1e1e1e] text-white' : 'bg-[#2d2d2d] text-[#969696] hover:bg-[#333333]'
              }`}
            >
              <OuterTabIcon tab={tab} />
              <span className="max-w-32 truncate">{label}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeOuterTab(id);
                }}
                title="关闭"
                className="rounded-sm px-1 text-[#969696] hover:bg-[#3a3d41] hover:text-white"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {/* 内容区 + 拖拽停靠目标 */}
      <div
        className="relative min-h-0 flex-1"
        onDragOver={onDragOver}
        onDragLeave={() => setDropPos(null)}
        onDrop={onDrop}
      >
        {dropPos && <div className={`pointer-events-none absolute z-20 ${dropIndicator[dropPos]} bg-[#007acc]/30`} />}
      </div>
    </div>
  );
}

function OuterSplitView({ node }: { node: Extract<LayoutNode, { type: 'split' }> }) {
  const setOuterSplitRatio = useStore((s) => s.setOuterSplitRatio);
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
      setOuterSplitRatio(node.id, ratio);
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
        <OuterLayoutView node={node.children[0]} />
      </div>
      <div
        title="拖动调整分屏大小"
        onPointerDown={onPointerDown}
        className={`z-10 shrink-0 bg-[#252526] hover:bg-[#007acc]/60 ${
          horizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        }`}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <OuterLayoutView node={node.children[1]} />
      </div>
      {dragging && <div className="absolute inset-0 z-20" />}
    </div>
  );
}

function OuterLayoutView({ node }: { node: LayoutNode }) {
  if (node.type === 'group') return <OuterGroupPanel key={node.id} node={node} />;
  return <OuterSplitView key={node.id} node={node} />;
}

/**
 * 第一层工作区：布局壳 + 内容池（矩形绝对定位，布局重组零卸载）。
 * 拖拽中的外层 tab 拖到右缘区域 → 停靠为固定右栏。
 */
export default function OuterWorkspace() {
  const outerTabs = useStore((s) => s.outerTabs);
  const outerLayout = useStore((s) => s.outerLayout);
  const outerDragId = useStore((s) => s.outerDragId);
  const setRightDock = useStore((s) => s.setRightDock);
  const containerRef = useRef<HTMLDivElement>(null);
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
    if (!outerLayout || size.w === 0 || size.h === 0) return new Map<string, Rect>();
    return computeLeafRects(outerLayout, { x: 0, y: 0, w: size.w, h: size.h });
  }, [outerLayout, size]);

  return (
    <div ref={containerRef} className="relative h-full min-h-0 min-w-0">
      {outerLayout ? (
        <OuterLayoutView node={outerLayout} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-[#5a5a5a]">
          <div className="text-4xl">⌨️</div>
          <div>从左侧主机列表选择主机打开终端</div>
        </div>
      )}
      {/* 内容池：所有外层 tab 保持挂载（工具页状态/编辑器内容不因切换丢失），非活动隐藏 */}
      {outerTabs.map((t) => {
        const rect = rects.get(t.id) ?? null;
        return (
          <div
            key={t.id}
            className="relative group"
            style={rect ? { position: 'absolute', left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { display: 'none' }}
          >
            <OuterTabContent tab={t} />
          </div>
        );
      })}
      {/* 右缘停靠目标：拖外层 tab 到右缘 → 固定为右栏 */}
      {outerDragId && outerLayout && (
        <div
          className="absolute top-0 right-0 bottom-0 z-30 flex w-16 flex-col items-center justify-center gap-1 border-l border-[#007acc]/50 bg-[#007acc]/20 text-[10px] text-[#4fc1ff]"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const id = useStore.getState().outerDragId;
            if (id) setRightDock(id);
          }}
        >
          <span>⏸</span>
          <span>停靠右栏</span>
        </div>
      )}
    </div>
  );
}
