import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { SshManager } from '../ssh/manager.js';
import { requireAuth } from './auth.js';
import type { ApprovalService } from '../approval.js';

export function registerApprovals(app: FastifyInstance, config: Config, approvals: ApprovalService): void {
  app.get('/api/approvals/pending', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    return approvals.pendingList();
  });

  app.post('/api/approvals/:id/resolve', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { approved?: boolean; remember?: boolean } | null;
    const ok = approvals.resolve(id, body?.approved ?? false, body?.remember ?? false);
    if (!ok) return reply.code(404).send({ error: '该审批不存在或已处理' });
    return { ok: true };
  });
}

export function registerAudit(app: FastifyInstance, config: Config, db: Database.Database): void {
  app.get('/api/audit', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const q = req.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit ?? '100', 10) || 100, 1), 1000);
    const rows = db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(limit);
    return rows;
  });
}

export interface CmdRule {
  id: number;
  pattern: string;
  action: 'block' | 'approve';
  note: string;
}

/** 危险命令规则 CRUD */
export function registerCmdRules(app: FastifyInstance, config: Config, db: Database.Database): void {
  app.get('/api/cmd-rules', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    return db.prepare('SELECT * FROM cmd_rules ORDER BY id').all() as CmdRule[];
  });

  app.post('/api/cmd-rules', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { pattern?: string; action?: string; note?: string } | null;
    const pattern = body?.pattern?.trim();
    if (!pattern) return reply.code(400).send({ error: '规则模式不能为空' });
    const action = body?.action === 'block' ? 'block' : 'approve';
    // 校验正则合法性
    try {
      new RegExp(pattern);
    } catch {
      return reply.code(400).send({ error: '正则表达式无效' });
    }
    try {
      const r = db
        .prepare('INSERT INTO cmd_rules (pattern, action, note) VALUES (?, ?, ?)')
        .run(pattern, action, body?.note ?? '');
      return db.prepare('SELECT * FROM cmd_rules WHERE id = ?').get(r.lastInsertRowid);
    } catch {
      return reply.code(400).send({ error: '规则已存在' });
    }
  });

  app.delete('/api/cmd-rules/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    db.prepare('DELETE FROM cmd_rules WHERE id = ?').run(id);
    return { ok: true };
  });
}

export function registerSessions(app: FastifyInstance, config: Config, manager: SshManager): void {  app.get('/api/sessions', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    return manager
      .list()
      .filter((s) => s.source === 'mcp')
      .map((s) => ({
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
  });
}

export function logAudit(
  db: Database.Database,
  source: 'web' | 'mcp',
  hostId: number | null,
  hostName: string | null,
  command: string,
  exitCode: number | null,
  durationMs: number,
): void {
  db.prepare(
    'INSERT INTO audit_log (source, host_id, host_name, command, exit_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(source, hostId, hostName, command.slice(0, 2000), exitCode, durationMs);
}
