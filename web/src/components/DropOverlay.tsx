import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { DropPos, Rect } from '../store';

/**
 * 拖拽停靠覆盖层：拖拽期间全屏接收 dragover/drop，按各 group 的矩形计算停靠目标。
 * 覆盖在内容池之上（z-40），解决「内容池与布局壳分离后拖拽事件到达不了壳」的问题。
 * 外层布局可额外支持「右缘停靠为固定右栏」（allowDock）。
 */

type DropTarget =
  | { kind: 'group'; id: string; pos: DropPos; rect: Rect }
  | { kind: 'dock'; rect: Rect };

function indicatorStyle(t: DropTarget): CSSProperties {
  const r = t.rect;
  if (t.kind === 'dock') {
    return { left: r.x + r.w - 64, top: r.y, width: 64, height: r.h };
  }
  switch (t.pos) {
    case 'left':
      return { left: r.x, top: r.y, width: r.w * 0.25, height: r.h };
    case 'right':
      return { left: r.x + r.w * 0.75, top: r.y, width: r.w * 0.25, height: r.h };
    case 'top':
      return { left: r.x, top: r.y, width: r.w, height: r.h * 0.25 };
    case 'bottom':
      return { left: r.x, top: r.y + r.h * 0.75, width: r.w, height: r.h * 0.25 };
    case 'center':
      return { left: r.x, top: r.y, width: r.w, height: r.h };
  }
}

export default function DropOverlay({
  groupRects,
  allowDock = false,
  onGroupDrop,
  onDockDrop,
}: {
  /** 各 group 面板的停靠区域（容器相对坐标） */
  groupRects: Map<string, Rect>;
  /** 是否允许右缘停靠为右栏（外层布局） */
  allowDock?: boolean;
  onGroupDrop: (groupId: string, pos: DropPos) => void;
  onDockDrop: () => void;
}) {
  const [target, setTarget] = useState<DropTarget | null>(null);

  const onDragOver = (e: React.DragEvent): void => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cr = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - cr.left;
    const y = e.clientY - cr.top;
    // 右缘停靠优先（外层）：主区右缘 64px
    if (allowDock && x > cr.width - 64) {
      const rect = { x: cr.width - 64, y: 0, w: 64, h: cr.height };
      setTarget((prev) => (prev?.kind === 'dock' ? prev : { kind: 'dock', rect }));
      return;
    }
    let best: { id: string; rect: Rect } | null = null;
    for (const [id, r] of groupRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        // 面积小的（更内层）优先
        if (!best || r.w * r.h < best.rect.w * best.rect.h) best = { id, rect: r };
      }
    }
    if (!best) {
      setTarget(null);
      return;
    }
    const rx = (x - best.rect.x) / best.rect.w;
    const ry = (y - best.rect.y) / best.rect.h;
    const pos: DropPos = rx < 0.25 ? 'left' : rx > 0.75 ? 'right' : ry < 0.25 ? 'top' : ry > 0.75 ? 'bottom' : 'center';
    setTarget((prev) =>
      prev?.kind === 'group' && prev.id === best.id && prev.pos === pos ? prev : { kind: 'group', id: best.id, pos, rect: best.rect },
    );
  };

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    if (target?.kind === 'dock') onDockDrop();
    else if (target?.kind === 'group') onGroupDrop(target.id, target.pos);
    setTarget(null);
  };

  return (
    <div className="absolute inset-0 z-40" onDragOver={onDragOver} onDragLeave={() => setTarget(null)} onDrop={onDrop}>
      {target && (
        <div
          className={`pointer-events-none absolute bg-[#007acc]/30 ${target.kind === 'dock' ? 'border-l border-[#007acc]/60' : ''}`}
          style={indicatorStyle(target)}
        />
      )}
    </div>
  );
}
