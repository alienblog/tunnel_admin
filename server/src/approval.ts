import type Database from 'better-sqlite3';
import { eventBus } from './events.js';
import type { HostRow } from './db.js';

export interface ApprovalInfo {
  id: number;
  hostId: number;
  hostName: string;
  host: string;
  port: number;
  username: string;
  source: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
}

interface PendingEntry {
  info: ApprovalInfo;
  resolve: (result: ApprovalResult) => void;
  timer: NodeJS.Timeout;
}

export type ApprovalResult =
  | { status: 'approved' }
  | { status: 'rejected' }
  | { status: 'expired' };

/**
 * agent 发起 SSH 连接时的人工审批服务。
 * 流程：requestApproval 落库并广播 → Web UI 弹窗 → resolve() 或超时 → MCP 侧 promise 结算。
 */
export class ApprovalService {
  private db: Database.Database;
  private pending = new Map<number, PendingEntry>();
  private timeoutMs: number;

  constructor(db: Database.Database, timeoutMs: number) {
    this.db = db;
    this.timeoutMs = timeoutMs;
  }

  /** 发起一次审批，阻塞直到用户响应或超时 */
  requestApproval(host: HostRow, source: string): Promise<ApprovalResult> {
    const createdAt = new Date().toISOString();
    const row = this.db
      .prepare('INSERT INTO approvals (host_id, source, status, created_at) VALUES (?, ?, ?, ?)')
      .run(host.id, source, 'pending', createdAt);

    const info: ApprovalInfo = {
      id: Number(row.lastInsertRowid),
      hostId: host.id,
      hostName: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      source,
      status: 'pending',
      createdAt,
    };

    eventBus.broadcast({
      type: 'approval:new',
      approvalId: info.id,
      hostName: info.hostName,
      host: info.host,
      port: info.port,
      username: info.username,
      source,
    });

    const { promise, resolve } = Promise.withResolvers<ApprovalResult>();
    const timer = setTimeout(() => {
      const entry = this.pending.get(info.id);
      if (!entry) return;
      this.pending.delete(info.id);
      this.db
        .prepare('UPDATE approvals SET status = ?, resolved_at = datetime(\'now\') WHERE id = ?')
        .run('expired', info.id);
      eventBus.broadcast({ type: 'approval:resolved', approvalId: info.id, result: 'expired' });
      resolve({ status: 'expired' });
    }, this.timeoutMs);

    this.pending.set(info.id, { info, resolve, timer });
    return promise;
  }

  /**
   * 用户响应审批。remember=true 时将该主机标记为 trusted（后续 agent 直连免审批）。
   * 返回 false 表示该审批不存在或已处理。
   */
  resolve(id: number, approved: boolean, remember: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    this.db
      .prepare('UPDATE approvals SET status = ?, resolved_at = datetime(\'now\') WHERE id = ?')
      .run(approved ? 'approved' : 'rejected', id);
    if (remember && approved) {
      this.db.prepare('UPDATE hosts SET trusted = 1 WHERE id = ?').run(entry.info.hostId);
    }
    eventBus.broadcast({
      type: 'approval:resolved',
      approvalId: id,
      result: approved ? 'approved' : 'rejected',
    });
    entry.resolve(approved ? { status: 'approved' } : { status: 'rejected' });
    return true;
  }

  /** 当前未决的审批（供 UI 初始化时恢复弹窗） */
  pendingList(): ApprovalInfo[] {
    return [...this.pending.values()].map((e) => e.info);
  }
}
