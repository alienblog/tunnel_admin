import crypto from 'node:crypto';
import type { Channel } from 'ssh2';
import type { FastifyInstance } from 'fastify';
import type { SshManager, SshSession } from './ssh/manager.js';
import { eventBus } from './events.js';
import { isAuthed } from './routes/auth.js';
import type { Config } from './config.js';

/**
 * 终端流协议（streamId 维度）：
 * - terminal:open   新建 SSH 会话 + 交互 shell（Web 独立终端）
 * - terminal:attach 复用已有会话（如 agent 的 MCP 会话），为其再开一个交互 shell
 * 同一 session 可挂多个 stream（多视图互不干扰）。
 */

type ClientMsg =
  | { type: 'terminal:open'; reqId: string; hostId: number; cols: number; rows: number }
  | { type: 'terminal:attach'; reqId: string; sessionId: string; cols: number; rows: number }
  | { type: 'terminal:input'; streamId: string; data: string }
  | { type: 'terminal:resize'; streamId: string; cols: number; rows: number }
  | { type: 'terminal:close'; streamId: string };

interface StreamRec {
  id: string;
  session: SshSession;
  channel: Channel;
  kind: 'open' | 'attach';
}

export function registerWs(app: FastifyInstance, config: Config, manager: SshManager): void {
  const streams = new Map<string, StreamRec>();

  function openShell(session: SshSession, cols: number, rows: number): Promise<Channel> {
    const { promise, resolve, reject } = Promise.withResolvers<Channel>();
    session.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
    return promise;
  }

  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!isAuthed(req as never, config)) {
      (socket as unknown as { close(): void }).close();
      return;
    }

    const rawSocket = socket as unknown as {
      on(event: 'message', cb: (data: unknown) => void): void;
      on(event: 'close', cb: () => void): void;
      send(data: string): void;
      close(): void;
      readyState: number;
    };

    const send = (obj: unknown): void => {
      try {
        rawSocket.send(JSON.stringify(obj));
      } catch {
        // 连接已关闭
      }
    };

    const unsubscribe = eventBus.subscribe({
      send: (payload) => {
        try {
          rawSocket.send(payload);
        } catch {
          // 连接已关闭
        }
      },
      closed: () => rawSocket.readyState !== 1,
    });

    // 本连接创建的 stream（连接断开时清理；open 类型断开会话，attach 类型仅关 channel）
    const owned = new Set<string>();

    function wireStream(rec: StreamRec): void {
      streams.set(rec.id, rec);
      owned.add(rec.id);
      rec.channel.on('data', (chunk: Buffer) => {
        eventBus.broadcast({ type: 'terminal:data', streamId: rec.id, data: chunk.toString('utf8') });
      });
      rec.channel.on('close', () => {
        streams.delete(rec.id);
        owned.delete(rec.id);
        eventBus.broadcast({ type: 'terminal:exit', streamId: rec.id });
      });
      rec.channel.on('error', () => rec.channel.end());
    }

    rawSocket.on('message', async (data: unknown) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data)) as ClientMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'terminal:open': {
          const host = manager.getHostRow(msg.hostId);
          if (!host) return send({ type: 'terminal:error', reqId: msg.reqId, message: '主机不存在' });
          const log = (message: string): void => send({ type: 'terminal:log', reqId: msg.reqId, message });
          try {
            const session = await manager.connect(
              host,
              { source: 'web' },
              log,
            );
            const channel = await openShell(session, msg.cols, msg.rows);
            const rec: StreamRec = { id: crypto.randomUUID(), session, channel, kind: 'open' };
            wireStream(rec);
            send({ type: 'terminal:ready', reqId: msg.reqId, streamId: rec.id, sessionId: session.id });
          } catch (err) {
            send({ type: 'terminal:error', reqId: msg.reqId, message: `连接失败: ${(err as Error).message}` });
          }
          break;
        }
        case 'terminal:attach': {
          const session = manager.get(msg.sessionId);
          if (!session)
            return send({ type: 'terminal:error', reqId: msg.reqId, message: `会话不存在或已断开: ${msg.sessionId}` });
          const log = (message: string): void => send({ type: 'terminal:log', reqId: msg.reqId, message });
          try {
            log(`附加到现有会话 ${session.hostName}（${session.host}:${session.port}）…`);
            const channel = await openShell(session, msg.cols, msg.rows);
            log('附加成功，会话就绪');
            const rec: StreamRec = { id: crypto.randomUUID(), session, channel, kind: 'attach' };
            wireStream(rec);
            send({ type: 'terminal:ready', reqId: msg.reqId, streamId: rec.id, sessionId: session.id });
          } catch (err) {
            send({ type: 'terminal:error', reqId: msg.reqId, message: `附加失败: ${(err as Error).message}` });
          }
          break;
        }
        case 'terminal:input': {
          const rec = streams.get(msg.streamId);
          if (rec && !rec.channel.destroyed) rec.channel.write(msg.data);
          break;
        }
        case 'terminal:resize': {
          const rec = streams.get(msg.streamId);
          if (rec && !rec.channel.destroyed) {
            try {
              rec.channel.setWindow(msg.rows, msg.cols, 0, 0);
            } catch {
              // 终端已关闭
            }
          }
          break;
        }
        case 'terminal:close': {
          const rec = streams.get(msg.streamId);
          if (rec) {
            streams.delete(rec.id);
            owned.delete(rec.id);
            try {
              rec.channel.end();
            } catch {
              // 已关闭
            }
            if (rec.kind === 'open') manager.disconnect(rec.session.id);
          }
          break;
        }
      }
    });

    rawSocket.on('close', () => {
      unsubscribe();
      for (const streamId of [...owned]) {
        const rec = streams.get(streamId);
        if (!rec) continue;
        streams.delete(streamId);
        try {
          rec.channel.end();
        } catch {
          // 已关闭
        }
        if (rec.kind === 'open') manager.disconnect(rec.session.id);
      }
      owned.clear();
    });
  });
}
