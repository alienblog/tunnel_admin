import { useEffect, useState } from 'react';
import { api, type Credential, type Host } from '../api';
import { useStore } from '../store';

interface FormState {
  name: string;
  host: string;
  port: string;
  username: string;
  auth_type: 'password' | 'private_key';
  password: string;
  private_key: string;
  passphrase: string;
  jump_host_id: string;
  /** 引用的凭据 id（'' = 内联凭据） */
  credential_id: string;
  group: string;
  tags: string;
  note: string;
  trusted: boolean;
}

const EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  auth_type: 'password',
  password: '',
  private_key: '',
  passphrase: '',
  jump_host_id: '',
  credential_id: '',
  group: '',
  tags: '',
  note: '',
  trusted: false,
};

function toForm(h: Host): FormState {
  return { ...EMPTY, name: h.name, host: h.host, port: String(h.port), username: h.username, auth_type: h.auth_type, jump_host_id: h.jump_host_id ? String(h.jump_host_id) : '', credential_id: h.credential_id ? String(h.credential_id) : '', group: h.group, tags: h.tags, note: h.note, trusted: h.trusted };
}

export default function HostForm({ initial, onDone }: { initial: Host | null; onDone: () => void }) {
  const [f, setF] = useState<FormState>(initial ? toForm(initial) : EMPTY);
  const [error, setError] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const hosts = useStore((s) => s.hosts);
  const loadHosts = useStore((s) => s.loadHosts);
  const editing = initial !== null;

  useEffect(() => {
    void api<Credential[]>('/api/credentials')
      .then((list) => setCredentials(list))
      .catch(() => {});
  }, []);

  const set = (patch: Partial<FormState>): void => setF((x) => ({ ...x, ...patch }));

  // 已有分组（自由输入 + 下拉选择）
  const groups = [...new Set(hosts.map((h) => h.group).filter((g) => g !== ''))].sort();
  const credId = f.credential_id ? Number(f.credential_id) : null;
  const usingCred = credentials.find((c) => c.id === credId) ?? null;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    const body: Record<string, unknown> = {
      name: f.name || f.host,
      host: f.host,
      port: Number(f.port),
      username: f.username,
      auth_type: f.auth_type,
      jump_host_id: f.jump_host_id ? Number(f.jump_host_id) : null,
      credential_id: f.credential_id ? Number(f.credential_id) : null,
      group: f.group,
      tags: f.tags,
      note: f.note,
      trusted: f.trusted,
    };
    // 引用凭据时不再发送内联凭据字段（连接时以凭据为准）
    if (!f.credential_id) {
      // 编辑时密码/私钥留空 = 保持不变
      if (f.auth_type === 'password') {
        if (f.password !== '') body.password = f.password;
      } else {
        if (f.private_key !== '') body.private_key = f.private_key;
        body.passphrase = f.passphrase !== '' ? f.passphrase : undefined;
      }
    }
    try {
      if (editing) await api(`/api/hosts/${initial.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await api('/api/hosts', { method: 'POST', body: JSON.stringify(body) });
      await loadHosts();
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const inputCls = 'w-full rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-1.5 text-sm text-[#cccccc] outline-none focus:border-[#007acc]';
  const labelCls = 'mb-1 block text-xs text-[#858585]';

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-3">
      <div>
        <label className={labelCls}>名称</label>
        <input className={inputCls} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="留空则用主机地址" />
      </div>
      <div>
        <label className={labelCls}>分组</label>
        <input className={inputCls} list="ta-host-groups" value={f.group} onChange={(e) => set({ group: e.target.value })} placeholder="可选（自由输入或下拉选择）" />
        <datalist id="ta-host-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </div>
      <div>
        <label className={labelCls}>使用凭据（可选）</label>
        <select
          className={inputCls}
          value={f.credential_id}
          onChange={(e) => {
            const cred = credentials.find((c) => String(c.id) === e.target.value);
            // 选择凭据时同步用户名（可再改），认证方式按凭据
            set({
              credential_id: e.target.value,
              ...(cred ? { username: cred.username, auth_type: cred.auth_type } : {}),
            });
          }}
        >
          <option value="">不引用（内联凭据）</option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}（{c.username}）
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>主机地址</label>
        <input className={inputCls} value={f.host} onChange={(e) => set({ host: e.target.value })} required />
      </div>
      <div>
        <label className={labelCls}>端口</label>
        <input className={inputCls} type="number" min={1} max={65535} value={f.port} onChange={(e) => set({ port: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>用户名</label>
        <input className={inputCls} value={f.username} onChange={(e) => set({ username: e.target.value })} required />
      </div>
      <div>
        <label className={labelCls}>认证方式</label>
        <select className={inputCls} value={f.auth_type} onChange={(e) => set({ auth_type: e.target.value as FormState['auth_type'] })}>
          <option value="password">密码</option>
          <option value="private_key">私钥</option>
        </select>
      </div>
      {f.credential_id ? (
        <div className="col-span-2 rounded-sm border border-[#3c3c3c] bg-[#1e1e1e] px-3 py-2 text-xs text-[#858585]">
          {usingCred ? `将使用凭据「${usingCred.name}」认证（${usingCred.username}，${usingCred.auth_type === 'password' ? '密码' : '私钥'}）；下方可继续填写内联凭据备用` : '所选凭据不存在，请重新选择'}
        </div>
      ) : f.auth_type === 'password' ? (
        <div className="col-span-2">
          <label className={labelCls}>{editing ? '密码（留空保持不变）' : '密码'}</label>
          <input className={inputCls} type="password" value={f.password} onChange={(e) => set({ password: e.target.value })} required={!editing} autoComplete="new-password" />
        </div>
      ) : (
        <>
          <div className="col-span-2">
            <label className={labelCls}>{editing ? '私钥（留空保持不变）' : '私钥'}</label>
            <textarea className={`${inputCls} h-28 font-mono text-xs`} value={f.private_key} onChange={(e) => set({ private_key: e.target.value })} required={!editing} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>私钥口令（可选）</label>
            <input className={inputCls} type="password" value={f.passphrase} onChange={(e) => set({ passphrase: e.target.value })} autoComplete="new-password" />
          </div>
        </>
      )}
      <div>
        <label className={labelCls}>跳板机</label>
        <select className={inputCls} value={f.jump_host_id} onChange={(e) => set({ jump_host_id: e.target.value })}>
          <option value="">无</option>
          {hosts
            .filter((h) => !initial || h.id !== initial.id)
            .map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>标签（逗号分隔）</label>
        <input className={inputCls} value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
      </div>
      <div className="col-span-2">
        <label className={labelCls}>备注</label>
        <input className={inputCls} value={f.note} onChange={(e) => set({ note: e.target.value })} />
      </div>
      <label className="col-span-2 flex cursor-pointer items-center gap-2 text-sm text-[#cccccc]">
        <input type="checkbox" checked={f.trusted} onChange={(e) => set({ trusted: e.target.checked })} className="accent-[#007acc]" />
        MCP 免审批直连（agent 连接时不再弹窗确认）
      </label>
      {error && <div className="col-span-2 text-sm text-[#f14c4c]">{error}</div>}
      <div className="col-span-2 flex justify-end gap-2 pt-1">
        <button type="button" onClick={onDone} className="rounded-sm border border-[#3c3c3c] px-4 py-1.5 text-sm text-[#cccccc] hover:bg-[#3a3d41]">
          取消
        </button>
        <button type="submit" className="rounded-sm bg-[#0e639c] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#1177bb]">
          {editing ? '保存' : '创建'}
        </button>
      </div>
    </form>
  );
}
