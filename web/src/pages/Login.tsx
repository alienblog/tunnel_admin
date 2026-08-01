import { useState } from 'react';
import { api } from '../api';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#1e1e1e]">
      <form onSubmit={submit} className="w-80 rounded-sm border border-[#3c3c3c] bg-[#252526] p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <div className="text-2xl font-bold text-[#4fc1ff]">&gt;_ TunnelAdmin</div>
          <div className="mt-1 text-[12px] text-[#858585]">Web SSH 连接管理器</div>
        </div>
        <label className="mb-1 block text-[12px] text-[#858585]">密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="mb-4 w-full rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 text-[#cccccc] outline-none focus:border-[#007acc]"
        />
        {error && <div className="mb-4 text-[12px] text-[#f14c4c]">{error}</div>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-sm bg-[#0e639c] py-2 font-medium text-white transition-colors hover:bg-[#1177bb] disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
        <div className="mt-4 text-center text-[11px] text-[#5a5a5a]">首次启动密码见服务端启动日志</div>
      </form>
    </div>
  );
}
