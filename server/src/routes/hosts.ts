import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { encryptText } from '../crypto.js';
import { requireAuth } from './auth.js';
import type { HostRow } from '../db.js';

export interface HostInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  auth_type?: 'password' | 'private_key';
  password?: string;
  private_key?: string;
  passphrase?: string;
  jump_host_id?: number | null;
  group?: string;
  tags?: string;
  note?: string;
  trusted?: boolean;
}

const HOST_RE = /^[a-zA-Z0-9._-]+$/;

function validateHost(input: HostInput): string | null {
  if (input.host !== undefined && !HOST_RE.test(input.host) && !/^[0-9a-fA-F:]+$/.test(input.host)) {
    return '主机地址格式非法';
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    return '端口必须在 1-65535 之间';
  }
  return null;
}

/** 输出给前端的 host 对象（不含密文） */
function toPublic(row: HostRow) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    auth_type: row.auth_type,
    has_password: !!row.password_enc,
    has_private_key: !!row.private_key_enc,
    jump_host_id: row.jump_host_id,
    group: row.group,
    tags: row.tags,
    note: row.note,
    trusted: !!row.trusted,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerHosts(app: FastifyInstance, config: Config, db: Database.Database): void {
  app.get('/api/hosts', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const rows = db.prepare('SELECT * FROM hosts ORDER BY "group", name').all() as HostRow[];
    return rows.map(toPublic);
  });

  app.post('/api/hosts', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const input = req.body as HostInput;
    const err = validateHost(input);
    if (err) return reply.code(400).send({ error: err });

    const authType = input.auth_type ?? 'password';
    if (authType === 'password' && !input.password) {
      return reply.code(400).send({ error: '密码认证需要提供密码' });
    }
    if (authType === 'private_key' && !input.private_key) {
      return reply.code(400).send({ error: '私钥认证需要提供私钥' });
    }

    const result = db
      .prepare(
        `INSERT INTO hosts (name, host, port, username, auth_type, password_enc, private_key_enc, passphrase_enc, jump_host_id, "group", tags, note, trusted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name ?? input.host,
        input.host,
        input.port ?? 22,
        input.username,
        authType,
        input.password ? encryptText(config.masterKey, input.password) : null,
        input.private_key ? encryptText(config.masterKey, input.private_key) : null,
        input.passphrase ? encryptText(config.masterKey, input.passphrase) : null,
        input.jump_host_id ?? null,
        input.group ?? '',
        input.tags ?? '',
        input.note ?? '',
        input.trusted ? 1 : 0,
      );
    const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(result.lastInsertRowid) as HostRow;
    return toPublic(row);
  });

  app.put('/api/hosts/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
    if (!row) return reply.code(404).send({ error: '主机不存在' });

    const input = req.body as HostInput;
    const err = validateHost(input);
    if (err) return reply.code(400).send({ error: err });

    // 凭据字段语义：undefined=保持不变；''=清除；其他=更新
    const enc = (v: string | undefined, cur: string | null): string | null =>
      v === undefined ? cur : v === '' ? null : encryptText(config.masterKey, v);

    db.prepare(
      `UPDATE hosts SET
         name = ?, host = ?, port = ?, username = ?, auth_type = ?,
         password_enc = ?, private_key_enc = ?, passphrase_enc = ?,
         jump_host_id = ?, "group" = ?, tags = ?, note = ?, trusted = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      input.name ?? row.name,
      input.host ?? row.host,
      input.port ?? row.port,
      input.username ?? row.username,
      input.auth_type ?? row.auth_type,
      enc(input.password, row.password_enc),
      enc(input.private_key, row.private_key_enc),
      enc(input.passphrase, row.passphrase_enc),
      input.jump_host_id === undefined ? row.jump_host_id : input.jump_host_id,
      input.group ?? row.group,
      input.tags ?? row.tags,
      input.note ?? row.note,
      input.trusted === undefined ? row.trusted : input.trusted ? 1 : 0,
      id,
    );
    const updated = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow;
    return toPublic(updated);
  });

  app.delete('/api/hosts/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
    return { ok: true };
  });
}
