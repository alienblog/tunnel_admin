import crypto from 'node:crypto';

/**
 * 动态连接令牌队列：插件后端（ctx.ssh.requestConnect）把「已解密凭据 + 设备信息」
 * 登记为一次性令牌，插件前端通过 ta.ssh.connect(token) 交给宿主 ws 层真正建连。
 * 明文凭据不离开服务端进程；令牌 60s 过期、一次性。
 */
export interface DynamicConnectInfo {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'private_key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** 跳板机（hosts 表真实 id，复用现有跳板机制） */
  jumpHostId?: number | null;
}

const TTL_MS = 60_000;
const pending = new Map<string, { info: DynamicConnectInfo; expires: number }>();
let timer: ReturnType<typeof setInterval> | null = null;

function sweep(): void {
  const now = Date.now();
  for (const [token, rec] of pending) {
    if (rec.expires < now) pending.delete(token);
  }
}

/** 登记一次动态连接，返回一次性令牌 */
export function queueConnect(info: DynamicConnectInfo): string {
  const token = crypto.randomBytes(24).toString('base64url');
  pending.set(token, { info, expires: Date.now() + TTL_MS });
  if (!timer) timer = setInterval(sweep, 30_000);
  timer.unref?.();
  return token;
}

/** 取出一性次令牌对应的连接信息（用过即删；过期/不存在返回 null） */
export function takeConnect(token: string): DynamicConnectInfo | null {
  const rec = pending.get(token);
  if (!rec) return null;
  pending.delete(token);
  if (rec.expires < Date.now()) return null;
  return rec.info;
}
