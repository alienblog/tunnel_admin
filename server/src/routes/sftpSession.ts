import type { SFTPWrapper } from 'ssh2';
import type { SshManager, SshSession, HostCreds } from '../ssh/manager.js';
import type { HostRow } from '../db.js';
import { getDynamicDevice } from '../dynamicDevices.js';

export interface SftpHandle {
  session: SshSession;
  sftp: SFTPWrapper;
  lastUsed: number;
}

/**
 * 按 hostId 缓存的 SFTP 会话（10 分钟空闲回收）。
 * 文件浏览与系统指标采集共用同一 SSH 连接。
 */
export class SftpSessionCache {
  private cache = new Map<number, SftpHandle>();

  constructor(private manager: SshManager) {
    const idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [hostId, h] of this.cache) {
        if (now - h.lastUsed > 10 * 60 * 1000) {
          this.manager.disconnect(h.session.id);
          this.cache.delete(hostId);
        }
      }
    }, 5 * 60 * 1000);
    idleTimer.unref();
  }

  async get(hostId: number): Promise<{ handle?: SftpHandle; error?: string }> {
    const cached = this.cache.get(hostId);
    if (cached) {
      cached.lastUsed = Date.now();
      return { handle: cached };
    }
    // 动态设备（插件 ctx.ssh.requestConnect，负 hostId）：凭据在 dynamicDevices 共享缓存，
    // 不落 hosts 表，SFTP/文件浏览/编辑器/补全按同一 id 复用连接
    let host: HostRow;
    let creds: HostCreds | undefined;
    if (hostId < 0) {
      const dyn = getDynamicDevice(hostId);
      if (!dyn) return { error: '动态设备不存在或凭据已过期，请重新点击插件连接' };
      host = dyn.host;
      creds = dyn.creds;
    } else {
      const h = this.manager.getHostRow(hostId);
      if (!h) return { error: '主机不存在' };
      host = h;
    }
    try {
      const session = await this.manager.connect(host, { source: 'web' }, undefined, creds);
      const { promise, resolve, reject } = Promise.withResolvers<SFTPWrapper>();
      session.client.sftp((err, s) => (err ? reject(err) : resolve(s)));
      const sftp = await promise;
      const handle: SftpHandle = { session, sftp, lastUsed: Date.now() };
      this.cache.set(hostId, handle);
      return { handle };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
}
