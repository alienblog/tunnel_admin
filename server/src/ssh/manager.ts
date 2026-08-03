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

/** 解密 HostRow 中的加密凭据（含凭据引用：credential_id 指向 credentials 表时以其为准） */
export function decryptHostCreds(host: HostRow, masterKey: Buffer, db?: Database.Database): HostCreds {
  const creds: HostCreds = {};
  // 凭据引用：优先使用保存的凭据（username 一并覆盖）
  if (host.credential_id && db) {
    const cred = db.prepare('SELECT * FROM credentials WHERE id = ?').get(host.credential_id) as
      | {
          username: string;
          password_enc: string | null;
          private_key_enc: string | null;
          passphrase_enc: string | null;
        }
      | undefined;
    if (cred) {
      if (cred.password_enc) creds.password = decryptText(masterKey, cred.password_enc);
      if (cred.private_key_enc) creds.privateKey = decryptText(masterKey, cred.private_key_enc);
      if (cred.passphrase_enc) creds.passphrase = decryptText(masterKey, cred.passphrase_enc);
      (creds as HostCreds & { username?: string }).username = cred.username;
    }
    return creds;
  }
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
    const creds = decryptHostCreds(host, this.masterKey, this.db);
    // 凭据引用时用凭据的 username
    const username = (creds as HostCreds & { username?: string }).username ?? host.username;
    let sock: Readable | undefined;
    const cleanups: Array<() => void> = [];

    if (host.jump_host_id) {
      onLog?.(`经由跳板机 ${host.jump_host_id} 建立隧道…`);
      const path = await this.buildJumpPath(host.jump_host_id, host.host, host.port, cleanups, onLog);
      sock = path;
    }

    try {
      const client = await connectClient(buildConnectConfig({ ...host, username }, creds, sock, opts.timeoutMs ?? 15000), onLog);
      const session: SshSession = {
        id: crypto.randomUUID(),
        hostId: host.id,
        hostName: host.name,
        host: host.host,
        port: host.port,
        username,
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
    const creds = decryptHostCreds(jump, this.masterKey, this.db);
    onLog?.(`→ 跳板机 ${jump.name}（${jump.host}:${jump.port}）…`);

    let upstream: Readable | undefined;
    if (jump.jump_host_id) {
      upstream = await this.buildJumpPath(jump.jump_host_id, jump.host, jump.port, cleanups, onLog);
    }

    const jumpUsername = (creds as HostCreds & { username?: string }).username ?? jump.username;
    const client = await connectClient(buildConnectConfig({ ...jump, username: jumpUsername }, creds, upstream, 15000), onLog);
    cleanups.push(() => client.end());
    onLog?.(`→ 跳板机隧道已建立（${targetHost}:${targetPort}）`);

    const { promise, resolve, reject } = Promise.withResolvers<Readable>();
    client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, chan) => {
      if (err) reject(err);
      else resolve(chan);
    });
    return promise;
  }

  /**
   * 测试连接（主机表单「测试连接」按钮）：不注册会话，连接就绪后立即断开。
   * 支持凭据引用与跳板机链；返回 { ok, message }。
   */
  async testConnect(
    input: {
      host: string;
      port: number;
      username: string;
      auth_type: string;
      password?: string;
      private_key?: string;
      passphrase?: string;
      jump_host_id?: number | null;
      credential_id?: number | null;
    },
    timeoutMs = 8000,
  ): Promise<{ ok: boolean; message: string }> {
    let username = input.username;
    const creds: HostCreds = {};
    // 凭据引用优先
    if (input.credential_id) {
      const cred = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(input.credential_id) as
        | { username: string; password_enc: string | null; private_key_enc: string | null; passphrase_enc: string | null }
        | undefined;
      if (cred) {
        if (cred.password_enc) creds.password = decryptText(this.masterKey, cred.password_enc);
        if (cred.private_key_enc) creds.privateKey = decryptText(this.masterKey, cred.private_key_enc);
        if (cred.passphrase_enc) creds.passphrase = decryptText(this.masterKey, cred.passphrase_enc);
        username = cred.username;
      }
    } else {
      if (input.password) creds.password = input.password;
      if (input.private_key) creds.privateKey = input.private_key;
      if (input.passphrase) creds.passphrase = input.passphrase;
    }
    const logs: string[] = [];
    const log = (m: string): void => {
      logs.push(m);
    };
    const cleanups: Array<() => void> = [];
    try {
      let sock: Readable | undefined;
      if (input.jump_host_id) {
        sock = await this.buildJumpPath(input.jump_host_id, input.host, input.port, cleanups, log);
      }
      const client = await connectClient(
        buildConnectConfig(
          {
            id: 0,
            name: input.host,
            host: input.host,
            port: input.port,
            username,
            auth_type: input.auth_type as 'password' | 'private_key',
            password_enc: null,
            private_key_enc: null,
            passphrase_enc: null,
            jump_host_id: null,
            credential_id: null,
            group: '',
            tags: '',
            note: '',
            trusted: 0,
            created_at: '',
            updated_at: '',
          },
          creds,
          sock,
          timeoutMs,
        ),
        log,
      );
      client.end();
      return { ok: true, message: '连接成功，认证通过' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    } finally {
      cleanups.forEach((fn) => fn());
    }
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
