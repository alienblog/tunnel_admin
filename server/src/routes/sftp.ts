import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import type { Stats } from 'ssh2';
import type { Config } from '../config.js';
import { requireAuth } from './auth.js';
import type { SftpSessionCache } from './sftpSession.js';

export interface SftpItem {
  name: string;
  type: 'dir' | 'file' | 'link' | 'unknown';
  size: number;
  mtime: string | null;
  mode: string;
}

/**
 * Web SFTP：使用共享会话缓存（按 hostId，10 分钟空闲回收），
 * 下载/上传均走流式管道，避免大文件占内存。
 */
export function registerSftp(
  app: FastifyInstance,
  config: Config,
  db: Database.Database,
  sessions: SftpSessionCache,
): void {
  async function getSftp(hostId: number): Promise<{ handle?: import('./sftpSession.js').SftpHandle; error?: string }> {
    return sessions.get(hostId);
  }

  function formatItem(name: string, attrs: Stats): SftpItem {
    const mode = attrs.mode ?? 0;
    const type = (mode & 0o170000) === 0o040000 ? 'dir' : (mode & 0o170000) === 0o120000 ? 'link' : 'file';
    return {
      name,
      type,
      size: attrs.size ?? 0,
      mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
      mode: (mode & 0o7777).toString(8),
    };
  }

  function parseQuery(req: FastifyRequest): { hostId: number; path: string } {
    const q = req.query as { hostId?: string; path?: string };
    return { hostId: Number(q.hostId), path: q.path ?? '.' };
  }

  /** 当前用户的 home 目录（SFTP 默认 cwd） */
  app.get('/api/sftp/home', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const hostId = Number((req.query as { hostId?: string }).hostId);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      handle.sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p)));
      const home = await promise;
      return { home };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sftp/ls', async (req, reply) => {    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
      handle.sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      const entries = await promise;
      const items = entries.map((e) => formatItem(e.filename, e.attrs)).sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      return { ok: true, path, items };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sftp/download', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    const name = path.split('/').pop() || 'download';
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    const stream = handle.sftp.createReadStream(path);
    stream.on('error', () => reply.code(400).send({ error: '读取文件失败' }));
    return reply.send(stream);
  });

  app.post('/api/sftp/upload', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const out = handle.sftp.createWriteStream(path);
      req.raw.pipe(out);
      out.on('close', () => resolve());
      out.on('error', (e: Error) => reject(e));
      req.raw.on('error', (e: Error) => reject(e));
      await promise;
      return { ok: true, path };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sftp/mkdir', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; path: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.mkdir(body.path, (err) => (err ? reject(err) : resolve()));
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sftp/rename', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; from: string; to: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.rename(body.from, body.to, (err) => (err ? reject(err) : resolve()));
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/sftp/rm', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const q = req.query as { hostId?: string; path?: string; recursive?: string };
    const { handle, error } = await getSftp(Number(q.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    const path = q.path ?? '';

    const rmDirRecursive = async (dir: string): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
      handle.sftp.readdir(dir, (e, list) => (e ? reject(e) : resolve(list)));
      const entries = await promise;
      for (const e of entries) {
        const child = dir.replace(/\/+$/, '') + '/' + e.filename;
        if ((e.attrs.mode ?? 0) & 0o40000) {
          await rmDirRecursive(child);
        } else {
          const { promise: up, resolve: ur, reject: uj } = Promise.withResolvers<void>();
          handle.sftp.unlink(child, (e) => (e ? uj(e) : ur()));
          await up;
        }
      }
      const { promise: rp, resolve: rr, reject: rj } = Promise.withResolvers<void>();
      handle.sftp.rmdir(dir, (e) => (e ? rj(e) : rr()));
      await rp;
    };

    try {
      if (q.recursive === '1') {
        await rmDirRecursive(path);
      } else {
        const { promise: pp, resolve: pr, reject: pj } = Promise.withResolvers<void>();
        handle.sftp.unlink(path, (e) => (e ? pj(e) : pr()));
        await pp;
      }
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
