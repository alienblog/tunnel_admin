/**
 * 服务端事件总线：向所有已登录的 WebSocket 客户端广播事件。
 * 终端数据流、agent 连接审批、MCP 会话状态、agent 命令活动等统一走这里。
 */

export interface SessionInfo {
  sessionId: string;
  hostId: number;
  hostName: string;
  host: string;
  port: number;
  username: string;
  source: 'web' | 'mcp';
  createdAt: number;
  lastUsedAt: number;
}

export type ServerEvent =
  | { type: 'terminal:data'; streamId: string; data: string }
  | { type: 'terminal:exit'; streamId: string; code?: number; reason?: string }
  | { type: 'terminal:ready'; reqId: string; streamId: string; sessionId: string }
  | { type: 'terminal:error'; reqId?: string; message: string }
  | { type: 'terminal:log'; reqId: string; message: string }
  | { type: 'approval:new'; approvalId: number; hostName: string; host: string; port: number; username: string; source: string }
  | { type: 'approval:resolved'; approvalId: number; result: 'approved' | 'rejected' | 'expired' }
  | { type: 'sessions:update'; sessions: SessionInfo[] }
  | {
      type: 'exec:activity';
      sessionId: string;
      kind: 'begin' | 'data' | 'end';
      command?: string;
      data?: string;
      exitCode?: number | null;
      /** 命令完成状态（end 事件）：失败 / 警告（成功但 stderr 有输出）/ 成功 */
      status?: 'success' | 'warning' | 'error';
    };

export type WsSink = {
  send(payload: string): void;
  closed(): boolean;
};

class EventBus {
  private sinks = new Set<WsSink>();

  subscribe(sink: WsSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  broadcast(evt: ServerEvent): void {
    const payload = JSON.stringify(evt);
    for (const sink of this.sinks) {
      try {
        if (!sink.closed()) sink.send(payload);
      } catch {
        // 单连接失败不影响其他连接
      }
    }
  }
}

export const eventBus = new EventBus();
