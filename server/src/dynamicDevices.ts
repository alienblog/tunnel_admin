import type { HostRow } from './db.js';
import type { HostCreds } from './ssh/manager.js';

/**
 * 动态设备（插件 ctx.ssh.requestConnect）共享缓存：
 * 前端以「唯一负 hostId」标识动态设备，ws 终端层建连成功后把
 * （临时 HostRow + 明文凭据）登记到这里；SFTP/补全/编辑器等按负 hostId
 * 请求连接时从此处取凭据，未落库的设备也能复用连接。
 *
 * 明文凭据不离开服务端进程；TTL 10 分钟（与 SFTP 会话空闲回收一致），
 * get 时惰性清理，过期后需重新点击插件连接。
 */
interface DynamicDevice {
  host: HostRow;
  creds: HostCreds | undefined;
  ts: number;
}

const devices = new Map<number, DynamicDevice>();
const TTL_MS = 10 * 60 * 1000;

/** 登记动态设备（hostId 为前端负值 id） */
export function setDynamicDevice(hostId: number, host: HostRow, creds: HostCreds | undefined): void {
  devices.set(hostId, { host, creds, ts: Date.now() });
}

/** 取动态设备；不存在或过期返回 null（过期时清理） */
export function getDynamicDevice(hostId: number): DynamicDevice | null {
  const d = devices.get(hostId);
  if (!d) return null;
  if (Date.now() - d.ts > TTL_MS) {
    devices.delete(hostId);
    return null;
  }
  return d;
}

/** 删除动态设备（终端关闭等场景，可选调用） */
export function deleteDynamicDevice(hostId: number): void {
  devices.delete(hostId);
}

/** 是否动态设备 id（负值） */
export function isDynamicHostId(hostId: number): boolean {
  return hostId < 0;
}