import { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';

/** agent 连接审批弹窗：展示待批准请求，支持批准/拒绝/记住信任 */
export default function ApprovalModal() {
  const approvals = useStore((s) => s.approvals);
  const removeApproval = useStore((s) => s.removeApproval);
  const [remember, setRemember] = useState(true);

  if (approvals.length === 0) return null;
  const a = approvals[0];

  const resolve = async (approved: boolean): Promise<void> => {
    removeApproval(a.id);
    try {
      await api(`/api/approvals/${a.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ approved, remember }),
      });
    } catch {
      // 审批已过期等情况忽略
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-105 max-w-[90vw] rounded-xl border border-amber-700/60 bg-slate-900 p-6 shadow-2xl">
        <div className="mb-1 flex items-center gap-2 text-amber-400">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-500" />
          </span>
          <span className="font-semibold">AI Agent 请求连接</span>
        </div>
        <p className="mt-3 text-sm text-slate-400">
          检测到 AI Agent 请求通过 MCP 建立 SSH 连接，请确认是否允许：
        </p>
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800 p-4 font-mono text-sm">
          <div className="text-slate-300">
            目标：<span className="text-emerald-400">{a.hostName}</span>
          </div>
          <div className="mt-1 text-slate-400">
            {a.username}@{a.host}:{a.port}
          </div>
          <div className="mt-1 text-xs text-slate-500">来源：{a.source === 'mcp' ? 'MCP (AI Agent)' : a.source}</div>
        </div>
        {approvals.length > 1 && (
          <div className="mt-3 text-xs text-slate-500">还有 {approvals.length - 1} 个待处理请求</div>
        )}
        <div className="mt-5 flex items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-400">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="accent-emerald-500"
            />
            始终信任该主机（免审批）
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void resolve(false)}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              拒绝
            </button>
            <button
              onClick={() => void resolve(true)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              批准并连接
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
