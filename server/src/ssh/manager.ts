import { Client, type ConnectConfig } from 'ssh2';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import type { HostRow } from '../db.js';
import { decryptText } from '../crypto.js';
import { eventBus, type SessionInfo } from '../events.js';

export interface HostCreds {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface SshSession {
  id: string;
  hostId: number;
  hostName: string;
  host: string;
  port: number;
  username: string;
  source: 'web' | 'mcp';
  client: Client;
  createdAt: number;
  lastUsedAt: number;
  /** 会话关闭时释放的跳板机链资源 */
  cleanup?: () => void;
}

export interface ConnectOptions {
  source: 'web' | 'mcp';
  /** 连接建立超时（毫秒），默认 15s */
  timeoutMs?: number;
}

/** 解密 HostRow 中的加密凭据 */
export function decryptHostCreds(host: HostRow, masterKey: Buffer): HostCreds {
  const creds: HostCreds = {};
  if (host.password_enc) creds.password = decryptText(masterKey, host.password_enc);
  if (host.private_key_enc) creds.privateKey = decryptText(masterKey, host.private_key_enc);
  if (host.passphrase_enc) creds.passphrase = decryptText(masterKey, host.passphrase_enc);
  return creds;
}

function buildConnectConfig(host: HostRow, creds: HostCreds, sock?: Readable, timeoutMs = 15000): ConnectConfig {
  const cfg: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: timeoutMs,
    keepaliveInterval: 15000,
    keepaliveCountMax: 6,
  };
  if (creds.password) cfg.password = creds.password;
  if (creds.privateKey) cfg.privateKey = creds.privateKey;
  if (creds.passphrase) cfg.passphrase = creds.passphrase;
  if (sock) cfg.sock = sock;
  return cfg;
}

function connectClient(cfg: ConnectConfig, onLog?: (msg: string) => void): Promise<Client> {
  const { promise, resolve, reject } = Promise.withResolvers<Client>();
  const client = new Client();
  onLog?.(`正在连接 ${cfg.host}:${cfg.port}（${cfg.username}）…`);
  client.once('handshake', () => onLog?.('SSH 协议握手完成'));
  client.once('ready', () => {
    onLog?.('认证成功，会话就绪');
    resolve(client);
  });
  client.once('error', (err) => reject(err));
  client.once('close', () => reject(new Error('SSH 连接在就绪前关闭')));
  client.connect(cfg);
  return promise;
}

export class SshManager {
  private sessions = new Map<string, SshSession>();
  private db: Database.Database;
  private masterKey: Buffer;

  constructor(db: Database.Database, masterKey: Buffer) {
    this.db = db;
    this.masterKey = masterKey;
  }

  getHostRow(id: number): HostRow | undefined {
    return this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  }

  /**
   * 建立 SSH 连接（支持单层或多层跳板机链）。
   * 返回的 session 已注册到池中；调用方负责在会话结束时 disconnect()。
   * onLog 用于在连接过程中输出进度日志（Web 端显示）。
   */
  async connect(host: HostRow, opts: ConnectOptions, onLog?: (msg: string) => void): Promise<SshSession> {
    const creds = decryptHostCreds(host, this.masterKey);
    let sock: Readable | undefined;
    const cleanups: Array<() => void> = [];

    if (host.jump_host_id) {
      onLog?.(`经由跳板机 ${host.jump_host_id} 建立隧道…`);
      const path = await this.buildJumpPath(host.jump_host_id, host.host, host.port, cleanups, onLog);
      sock = path;
    }

    try {
      const client = await connectClient(buildConnectConfig(host, creds, sock, opts.timeoutMs ?? 15000), onLog);
      const session: SshSession = {
        id: crypto.randomUUID(),
        hostId: host.id,
        hostName: host.name,
        host: host.host,
        port: host.port,
        username: host.username,
        source: opts.source,
        client,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        cleanup: cleanups.length > 0 ? () => cleanups.forEach((fn) => fn()) : undefined,
      };
      client.on('error', () => this.disconnect(session.id));
      client.on('close', () => this.disconnect(session.id));
      this.sessions.set(session.id, session);
      this.touchHost(session);
      this.broadcastSessions();
      return session;
    } catch (err) {
      cleanups.forEach((fn) => fn());
      throw err;
    }
  }

  /**
   * 递归构建跳板机链：返回连接到目标 (targetHost:targetPort) 的流。
   * 链上每层跳板机的连接都记录到 cleanups，会话关闭时逐层释放。
   */
  private async buildJumpPath(
    jumpHostId: number,
    targetHost: string,
    targetPort: number,
    cleanups: Array<() => void>,
    onLog?: (msg: string) => void,
  ): Promise<Readable> {
    const jump = this.getHostRow(jumpHostId);
    if (!jump) throw new Error(`跳板机配置不存在（id=${jumpHostId}）`);
    const creds = decryptHostCreds(jump, this.masterKey);
    onLog?.(`→ 跳板机 ${jump.name}（${jump.host}:${jump.port}）…`);

    let upstream: Readable | undefined;
    if (jump.jump_host_id) {
      upstream = await this.buildJumpPath(jump.jump_host_id, jump.host, jump.port, cleanups, onLog);
    }

    const client = await connectClient(buildConnectConfig(jump, creds, upstream, 15000), onLog);
    cleanups.push(() => client.end());
    onLog?.(`→ 跳板机隧道已建立（${targetHost}:${targetPort}）`);

    const { promise, resolve, reject } = Promise.withResolvers<Readable>();
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, chan) => {
      if (err) reject(err);
      else resolve(chan);
    });
    return promise;
  }

  get(id: string): SshSession | undefined {
    const s = this.sessions.get(id);
    if (s) {
      s.lastUsedAt = Date.now();
      this.touchHost(s);
    }
    return s;
  }

  list(): SshSession[] {
    return [...this.sessions.values()];
  }

  disconnect(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.cleanup?.();
    } catch {
      // 忽略跳板机释放错误
    }
    s.client.end();
    this.broadcastSessions();
  }

  /** 广播活跃会话列表（供 Web 端展示 agent 会话） */
  private broadcastSessions(): void {
    const sessions: SessionInfo[] = this.list().map((s) => ({
      sessionId: s.id,
      hostId: s.hostId,
      hostName: s.hostName,
      host: s.host,
      port: s.port,
      username: s.username,
      source: s.source,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    }));
    eventBus.broadcast({ type: 'sessions:update', sessions });
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
  }

  private touchHost(s: SshSession): void {
    this.db.prepare('UPDATE sessions SET last_used_at = datetime(\'now\') WHERE id = ?').run(s.id);
  }
}
