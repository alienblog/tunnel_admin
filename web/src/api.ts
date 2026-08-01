/** 轻量 API 客户端：统一错误处理与 401 跳转 */

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };
  if (opts.body && !(opts.body instanceof FormData) && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('ta:unauthorized'));
    throw new Error('未登录');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `请求失败 (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface Host {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private_key';
  has_password: boolean;
  has_private_key: boolean;
  jump_host_id: number | null;
  group: string;
  tags: string;
  note: string;
  trusted: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApprovalInfo {
  id: number;
  hostId: number;
  hostName: string;
  host: string;
  port: number;
  username: string;
  source: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  source: 'web' | 'mcp';
  host_id: number | null;
  host_name: string | null;
  command: string;
  exit_code: number | null;
  duration_ms: number;
}

export interface McpToken {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked: number;
}

export interface ForwardRec {
  id: string;
  hostId: number;
  hostName: string;
  bindPort: number;
  remoteHost: string;
  remotePort: number;
  createdAt: string;
}

export interface SftpItem {
  name: string;
  type: 'dir' | 'file' | 'link' | 'unknown';
  size: number;
  mtime: string | null;
  mode: string;
}
