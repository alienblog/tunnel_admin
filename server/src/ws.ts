import crypto from 'node:crypto';
import type { Channel } from 'ssh2';
import type { FastifyInstance } from 'fastify';
import type { HostCreds, SshManager, SshSession } from './ssh/manager.js';
import type { HostRow } from './db.js';
import { takeConnect, type DynamicConnectInfo } from './plugins/connectQueue.js';
import { getDynamicDevice, setDynamicDevice } from './dynamicDevices.js';
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
  | { type: 'terminal:open'; reqId: string; hostId: number; cols: number; rows: number; tmuxId?: string; connectToken?: string }
  | { type: 'terminal:attach'; reqId: string; sessionId: string; cols: number; rows: number }
  | { type: 'terminal:input'; streamId: string; data: string }
  | { type: 'terminal:resize'; streamId: string; cols: number; rows: number }
  | { type: 'terminal:close'; streamId: string };

/** 动态设备（插件 ctx.ssh.requestConnect）→ 临时 HostRow + 明文凭据覆盖 */
function dynamicToHost(info: DynamicConnectInfo): { host: HostRow; creds: HostCreds } {
  const now = new Date().toISOString();
  return {
    host: {
      id: 0,
      name: info.name,
      host: info.host,
      port: info.port,
      username: info.username,
      auth_type: info.authType,
      password_enc: null,
      private_key_enc: null,
      passphrase_enc: null,
      jump_host_id: info.jumpHostId ?? null,
      credential_id: null,
      group: '',
      tags: '',
      note: '',
      trusted: 1,
      created_at: now,
      updated_at: now,
    },
    creds: { password: info.password, privateKey: info.privateKey, passphrase: info.passphrase },
  };
}

interface StreamRec {
  id: string;
  session: SshSession;
  channel: Channel;
  kind: 'open' | 'attach';
  /** 前端 tab id（terminal:open 的 tmuxId）：断线后凭此复用保留的会话 */
  tmuxId?: string;
}

export function registerWs(app: FastifyInstance, config: Config, manager: SshManager): void {
  const streams = new Map<string, StreamRec>();

  /**
   * 断线保留的会话（tmuxId → 会话+channel）：
   * 前端 ws 断开时 SSH 会话与交互 shell 原样保留（channel 不 end、session 不断开），
   * 前端重连后 terminal:open（同 tmuxId）直接重新挂接，零新增输出（无新提示符）。
   * 超时（DETACH_TTL）未重连则回收。
   */
  const detached = new Map<string, { session: SshSession; channel: Channel; timer: ReturnType<typeof setTimeout> }>();
  const DETACH_TTL_MS = 5 * 60 * 1000;

  function detachChannel(tmuxId: string, rec: StreamRec): void {
    const prev = detached.get(tmuxId);
    if (prev) {
      clearTimeout(prev.timer);
      try {
        prev.channel.end();
      } catch {
        // 已关闭
      }
      manager.disconnect(prev.session.id);
    }
    const timer = setTimeout(() => {
      const d = detached.get(tmuxId);
      if (!d) return;
      detached.delete(tmuxId);
      try {
        d.channel.end();
      } catch {
        // 已关闭
      }
      manager.disconnect(d.session.id);
    }, DETACH_TTL_MS);
    detached.set(tmuxId, { session: rec.session, channel: rec.channel, timer });
  }

  /**
   * 打开交互 shell。tmuxId 断线保留：
   * 前端 ws 断开时 SSH 会话与 channel 由 detachChannel 保留，重连 open 复用（不新开 shell）。
   */
  function openShell(session: SshSession, cols: number, rows: number, tmuxId?: string): Promise<Channel> {
    // 不使用远端 tmux 包装（tmux 会捕获滚轮/鼠标，且嵌套 TUI 有兼容问题）。
    // 直接打开交互 shell；断线恢复由 detachChannel 保留 channel 复用实现（非 tmux）。
    void tmuxId;
    return new Promise((resolve, reject) => {
      session.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) reject(err);
        else resolve(stream);
      });
    });
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
      // SSH 连接层断开（主机重启 / 网络中断）：带 reason 广播，前端据此自动重连。
      // 注意：channel close 可能先于 client close 触发（streams 已删），此处不做存在性检查，
      // 由前端对「无 reason exit」延迟处理来合并两个事件。
      const onConnLost = (): void => {
        eventBus.broadcast({ type: 'terminal:exit', streamId: rec.id, reason: 'connection-lost' });
      };
      rec.session.client.once('error', onConnLost);
      rec.session.client.once('close', onConnLost);
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
          // 断线重连（前端 ws 断开后重新 open，同 tmuxId）：优先复用保留的会话，
          // 原 SSH 会话与 shell 原样继续（无新提示符）；channel 已死则走新连接。
          if (msg.tmuxId) {
            const det = detached.get(msg.tmuxId);
            if (det && !det.channel.destroyed) {
              clearTimeout(det.timer);
              detached.delete(msg.tmuxId);
              const rec: StreamRec = { id: crypto.randomUUID(), session: det.session, channel: det.channel, kind: 'open', tmuxId: msg.tmuxId };
              wireStream(rec);
              send({ type: 'terminal:ready', reqId: msg.reqId, streamId: rec.id, sessionId: det.session.id });
              break;
            }
            if (det) {
              // channel 已死（SSH 断开）：清除残留
              clearTimeout(det.timer);
              detached.delete(msg.tmuxId);
              try {
                det.channel.end();
              } catch {
                // 已关闭
              }
              manager.disconnect(det.session.id);
            }
          }
          // 动态连接（插件 ta.ssh.connect）：凭据由插件后端登记的一次性令牌承载；
          // 令牌消费后（重连/同主机多开/SFTP 等 HTTP 层）走 dynamicDevices 共享缓存；
          // 常规连接：按 hosts 表 id
          let host: HostRow;
          let creds: HostCreds | undefined;
          if (msg.connectToken) {
            const info = takeConnect(msg.connectToken);
            if (!info)
              return send({ type: 'terminal:error', reqId: msg.reqId, message: '连接令牌无效或已过期，请重新点击连接' });
            ({ host, creds } = dynamicToHost(info));
          } else if (msg.hostId < 0) {
            const dyn = getDynamicDevice(msg.hostId);
            if (!dyn)
              return send({ type: 'terminal:error', reqId: msg.reqId, message: '动态设备凭据已过期，请重新点击连接' });
            host = dyn.host;
            creds = dyn.creds;
          } else {
            const h = manager.getHostRow(msg.hostId);
            if (!h) return send({ type: 'terminal:error', reqId: msg.reqId, message: '主机不存在' });
            host = h;
          }
          const log = (message: string): void => send({ type: 'terminal:log', reqId: msg.reqId, message });
          try {
            const session = await manager.connect(host, { source: 'web' }, log, creds);
            const channel = await openShell(session, msg.cols, msg.rows, msg.tmuxId);
            const rec: StreamRec = { id: crypto.randomUUID(), session, channel, kind: 'open', tmuxId: msg.tmuxId };
            wireStream(rec);
            send({ type: 'terminal:ready', reqId: msg.reqId, streamId: rec.id, sessionId: session.id });
            // 动态设备登记共享缓存：终端多开（组内加号）/重连/SFTP/补全/编辑器复用；TTL 过期清除
            if (msg.connectToken && msg.hostId < 0) {
              setDynamicDevice(msg.hostId, host, creds);
            }
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
        // web 交互终端（open + tmuxId）：保留 SSH 会话与 shell，供前端重连复用
        if (rec.kind === 'open' && rec.tmuxId) {
          detachChannel(rec.tmuxId, rec);
          continue;
        }
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
