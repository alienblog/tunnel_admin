import { useRef, useState } from 'react';
import type { DropPos, Rect } from '../store';

/**
 * 拖拽停靠处理（挂在工作区容器根节点）：
 * 拖拽事件（dragover/drop）冒泡到根必然到达——不依赖任何覆盖层渲染时机。
 * 高亮指示条 pointer-events-none，不拦截 tab 交互。
 */

export type DropTarget =
  | { kind: 'group'; id: string; pos: DropPos; rect: Rect }
  | { kind: 'dock'; rect: Rect };

export function dropIndicatorStyle(t: DropTarget): React.CSSProperties {
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

export function useDropTarget(opts: {
  /** 各 group 面板停靠区域（容器相对坐标） */
  groupRects: Map<string, Rect>;
  /** 是否允许右缘停靠为右栏（外层布局） */
  allowDock?: boolean;
  /** 当前是否处于拖拽（对应层的 drag id 非空） */
  isDragging: () => boolean;
  onGroupDrop: (groupId: string, pos: DropPos) => void;
  onDockDrop: () => void;
}): {
  target: DropTarget | null;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
} {
  const [target, setTarget] = useState<DropTarget | null>(null);
  const targetRef = useRef<DropTarget | null>(null);
  const update = (t: DropTarget | null): void => {
    targetRef.current = t;
    setTarget(t);
  };

  const onDragOver = (e: React.DragEvent): void => {
    if (!opts.isDragging()) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cr = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - cr.left;
    const y = e.clientY - cr.top;
    // 右缘停靠优先（外层）：主区右缘 64px
    if (opts.allowDock && x > cr.width - 64) {
      const rect = { x: cr.width - 64, y: 0, w: 64, h: cr.height };
      if (targetRef.current?.kind !== 'dock') update({ kind: 'dock', rect });
      return;
    }
    let best: { id: string; rect: Rect } | null = null;
    for (const [id, r] of opts.groupRects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
        // 面积小的（更内层）优先
        if (!best || r.w * r.h < best.rect.w * best.rect.h) best = { id, rect: r };
      }
    }
    if (!best) {
      update(null);
      return;
    }
    const rx = (x - best.rect.x) / best.rect.w;
    const ry = (y - best.rect.y) / best.rect.h;
    const pos: DropPos = rx < 0.25 ? 'left' : rx > 0.75 ? 'right' : ry < 0.25 ? 'top' : ry > 0.75 ? 'bottom' : 'center';
    const cur = targetRef.current;
    if (cur?.kind !== 'group' || cur.id !== best.id || cur.pos !== pos) {
      update({ kind: 'group', id: best.id, pos, rect: best.rect });
    }
  };

  const onDrop = (e: React.DragEvent): void => {
    if (!opts.isDragging()) return;
    e.preventDefault();
    const t = targetRef.current;
    if (t?.kind === 'dock') opts.onDockDrop();
    else if (t?.kind === 'group') opts.onGroupDrop(t.id, t.pos);
    update(null);
  };

  return { target, onDragOver, onDrop };
}
