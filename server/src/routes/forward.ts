import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { SshManager, SshSession } from '../ssh/manager.js';
import { requireAuth } from './auth.js';

interface ForwardRec {
  id: string;
  hostId: number;
  hostName: string;
  session: SshSession;
  bindPort: number;
  remoteHost: string;
  remotePort: number;
  createdAt: number;
}

/**
 * 远程端口转发（远程为主）：把目标内网端口暴露到部署服务器的端口。
 * 浏览器/外部通过 http://server:bindPort 直接访问目标服务。
 * 会话断开时转发自动失效并从列表移除。
 */
export function registerForward(app: FastifyInstance, config: Config, db: Database.Database, manager: SshManager): void {
  const forwards = new Map<string, ForwardRec>();

  function toPublic(f: ForwardRec) {
    return {
      id: f.id,
      hostId: f.hostId,
      hostName: f.hostName,
      bindPort: f.bindPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      createdAt: new Date(f.createdAt).toISOString(),
    };
  }

  app.get('/api/forward', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    return [...forwards.values()].map(toPublic);
  });

  app.post('/api/forward', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; remoteHost: string; remotePort: number; bindPort: number } | null;
    if (!body || !body.hostId || !Number.isInteger(body.remotePort) || !Number.isInteger(body.bindPort)) {
      return reply.code(400).send({ error: '参数不完整' });
    }
    const host = manager.getHostRow(body.hostId);
    if (!host) return reply.code(404).send({ error: '主机不存在' });

    let session: SshSession;
    try {
      session = await manager.connect(host, { source: 'web' });
    } catch (err) {
      return reply.code(400).send({ error: `连接失败: ${(err as Error).message}` });
    }

    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      session.client.forwardIn('127.0.0.1', body.bindPort, (err) => (err ? reject(err) : resolve()));
      await promise;
    } catch (err) {
      manager.disconnect(session.id);
      return reply.code(400).send({ error: `绑定端口 ${body.bindPort} 失败: ${(err as Error).message}` });
    }

    const rec: ForwardRec = {
      id: crypto.randomUUID(),
      hostId: host.id,
      hostName: host.name,
      session,
      bindPort: body.bindPort,
      remoteHost: body.remoteHost,
      remotePort: body.remotePort,
      createdAt: Date.now(),
    };

    // 'tcp connection' 事件：服务器端口收到连接 → 通过 SSH 转发到目标
    session.client.on('tcp connection', (_info, accept, reject) => {
      session.client.forwardOut('127.0.0.1', 0, rec.remoteHost, rec.remotePort, (err, stream) => {
        if (err) return reject();
        const conn = accept();
        conn.pipe(stream).pipe(conn);
        conn.on('error', () => stream.destroy());
        stream.on('error', () => conn.destroy());
      });
    });

    session.client.on('close', () => {
      forwards.delete(rec.id);
    });

    forwards.set(rec.id, rec);
    return toPublic(rec);
  });

  app.delete('/api/forward/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = (req.params as { id: string }).id;
    const rec = forwards.get(id);
    if (!rec) return reply.code(404).send({ error: '转发不存在' });
    forwards.delete(id);
    manager.disconnect(rec.session.id);
    return { ok: true };
  });
}
