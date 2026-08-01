import type { SFTPWrapper } from 'ssh2';
import type { SshManager, SshSession } from '../ssh/manager.js';

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
    const host = this.manager.getHostRow(hostId);
    if (!host) return { error: '主机不存在' };
    try {
      const session = await this.manager.connect(host, { source: 'web' });
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

  touch(hostId: number): void {
    const h = this.cache.get(hostId);
    if (h) h.lastUsed = Date.now();
  }
}
