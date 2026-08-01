import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { THEMES } from '../themes';
import { useStore } from '../store';
import { THEME_NAMES } from '../themes';

interface ReplayFrame {
  t: number;
  data: string;
}

/** 终端回放播放器：按时间差重放录制帧 */
export default function ReplayOverlay({
  frames,
  hostName,
  onClose,
}: {
  frames: ReplayFrame[];
  hostName: string;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const timersRef = useRef<number[]>([]);
  const themeName = useStore((s) => s.terminalTheme);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "Courier New", monospace',
      theme: THEMES[themeName] ?? THEMES['dark-plus'],
      scrollback: 10000,
      disableStdin: true,
    });
    term.open(container);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPlayback = (): void => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setPlaying(false);
  };

  const play = (from = 0): void => {
    stopPlayback();
    const term = termRef.current;
    if (!term || frames.length === 0) return;
    term.clear();
    setTotal(frames.length);
    setProgress(from);
    setPlaying(true);
    const t0 = frames[from]?.t ?? 0;
    for (let i = from; i < frames.length; i++) {
      const delay = Math.max(0, (frames[i].t - t0) / speed);
      const timer = window.setTimeout(() => {
        term.write(frames[i].data);
        setProgress(i + 1);
        if (i === frames.length - 1) setPlaying(false);
      }, delay);
      timersRef.current.push(timer);
    }
  };

  const togglePlay = (): void => {
    if (playing) {
      stopPlayback();
    } else {
      play(progress);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="mx-auto mt-8 flex h-[80vh] w-[90vw] max-w-5xl flex-col rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[#252526] bg-[#252526] px-3 py-1.5">
          <span className="text-[12px] font-medium text-[#cccccc]">⏵ 回放：{hostName}</span>
          <span className="text-[10px] text-[#5a5a5a]">{frames.length} 帧</span>
          <div className="flex-1" />
          <button
            onClick={togglePlay}
            className="rounded-sm bg-[#0e639c] px-2.5 py-0.5 text-[11px] text-white hover:bg-[#1177bb]"
          >
            {playing ? '⏸ 暂停' : '⏵ 播放'}
          </button>
          <select
            value={speed}
            onChange={(e) => {
              const s = Number(e.target.value);
              setSpeed(s);
              if (playing) play(progress);
            }}
            className="rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-1 py-0.5 text-[11px] text-[#cccccc] outline-none"
          >
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={4}>4×</option>
            <option value={8}>8×</option>
          </select>
          <button
            onClick={onClose}
            className="rounded-sm px-2 text-[#858585] hover:bg-[#3a3d41] hover:text-white"
          >
            ×
          </button>
        </div>
        <div className="relative min-h-0 flex-1 p-1">
          <div ref={containerRef} className="h-full w-full" />
        </div>
        <div className="border-t border-[#252526] bg-[#252526] px-3 py-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#5a5a5a]">{progress}/{total}</span>
            <div className="h-1 flex-1 overflow-hidden rounded bg-[#3c3c3c]">
              <div
                className="h-full bg-[#007acc]"
                style={{ width: total > 0 ? `${(progress / total) * 100}%` : '0%' }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export type { ReplayFrame };
export { THEME_NAMES };
