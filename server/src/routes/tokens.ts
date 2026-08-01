import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireAuth } from './auth.js';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyMcpToken(db: Database.Database, header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const hash = hashToken(token);
  const row = db
    .prepare('SELECT revoked FROM mcp_tokens WHERE token_hash = ?')
    .get(hash) as { revoked: number } | undefined;
  if (!row || row.revoked) return false;
  db.prepare('UPDATE mcp_tokens SET last_used_at = datetime(\'now\') WHERE token_hash = ?').run(hash);
  return true;
}

export function registerTokens(app: FastifyInstance, config: Config, db: Database.Database): void {
  app.get('/api/tokens', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const rows = db
      .prepare('SELECT id, name, created_at, last_used_at, revoked FROM mcp_tokens ORDER BY id DESC')
      .all();
    return rows;
  });

  app.post('/api/tokens', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { name?: string } | null;
    const name = (body?.name ?? '').trim() || 'unnamed';
    const token = `ta_${randomBytes(24).toString('base64url')}`;
    db.prepare('INSERT INTO mcp_tokens (name, token_hash) VALUES (?, ?)').run(name, hashToken(token));
    return { id: Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id), name, token };
  });

  app.delete('/api/tokens/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    db.prepare('DELETE FROM mcp_tokens WHERE id = ?').run(id);
    return { ok: true };
  });
}

/** 恒定时间比较，防时序侧信道 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
