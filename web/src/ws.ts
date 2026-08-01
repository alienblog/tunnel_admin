/** WebSocket 事件总线客户端：自动重连（指数退避），按类型分发事件 */

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

export type ClientMsg =
  | { type: 'terminal:open'; reqId: string; hostId: number; cols: number; rows: number }
  | { type: 'terminal:attach'; reqId: string; sessionId: string; cols: number; rows: number }
  | { type: 'terminal:input'; streamId: string; data: string }
  | { type: 'terminal:resize'; streamId: string; cols: number; rows: number }
  | { type: 'terminal:close'; streamId: string };

type Handler = (evt: ServerEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  connect(): void {
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      window.dispatchEvent(new CustomEvent('ta:ws:open'));
    };
    ws.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data as string) as ServerEvent;
        const set = this.handlers.get(evt.type);
        if (set) for (const h of set) h(evt);
      } catch (err) {
        console.error('[ws] 事件处理失败:', err);
      }
    };
    ws.onclose = () => {
      if (this.closedByUser) return;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 15000);
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  on<T extends ServerEvent['type']>(type: T, handler: (evt: Extract<ServerEvent, { type: T }>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const generic = handler as Handler;
    set.add(generic);
    return () => set!.delete(generic);
  }
}

export const ws = new WsClient();
