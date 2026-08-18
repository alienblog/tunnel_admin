import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import { encryptText } from '../crypto.js';
import { requireAuth } from './auth.js';

/** 凭据输入（密码/私钥均为明文，服务端加密存储） */
interface CredInput {
  name?: string;
  username?: string;
  auth_type?: 'password' | 'private_key';
  password?: string;
  private_key?: string;
  passphrase?: string;
}

function toPublic(row: {
  id: number;
  name: string;
  username: string;
  auth_type: string;
  password_enc: string | null;
  private_key_enc: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    auth_type: row.auth_type,
    has_password: !!row.password_enc,
    has_private_key: !!row.private_key_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerCredentials(app: FastifyInstance, config: Config, db: Database.Database): void {
  app.get('/api/credentials', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const rows = db
      .prepare(
        'SELECT id, name, username, auth_type, password_enc, private_key_enc, created_at, updated_at FROM credentials ORDER BY name',
      )
      .all() as Array<{
      id: number;
      name: string;
      username: string;
      auth_type: string;
      password_enc: string | null;
      private_key_enc: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map(toPublic);
  });

  app.post('/api/credentials', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const input = req.body as CredInput;
    const name = (input.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: '凭据名称不能为空' });
    const username = (input.username ?? '').trim();
    if (!username) return reply.code(400).send({ error: '用户名不能为空' });
    const authType = input.auth_type ?? 'password';
    if (authType === 'password' && !input.password) {
      return reply.code(400).send({ error: '密码认证需要提供密码' });
    }
    if (authType === 'private_key' && !input.private_key) {
      return reply.code(400).send({ error: '私钥认证需要提供私钥' });
    }
    const result = db
      .prepare(
        `INSERT INTO credentials (name, username, auth_type, password_enc, private_key_enc, passphrase_enc)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        username,
        authType,
        input.password ? encryptText(config.masterKey, input.password) : null,
        input.private_key ? encryptText(config.masterKey, input.private_key) : null,
        input.passphrase ? encryptText(config.masterKey, input.passphrase) : null,
      );
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(result.lastInsertRowid);
    return toPublic(row as Parameters<typeof toPublic>[0]);
  });

  app.put('/api/credentials/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
      | { password_enc: string | null; private_key_enc: string | null; passphrase_enc: string | null }
      | undefined;
    if (!row) return reply.code(404).send({ error: '凭据不存在' });
    const input = req.body as CredInput;
    const name = (input.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: '凭据名称不能为空' });
    // 密文字段语义：undefined=保持不变；''=清除；其他=更新
    const enc = (v: string | undefined, cur: string | null): string | null =>
      v === undefined ? cur : v === '' ? null : encryptText(config.masterKey, v);
    db.prepare(
      `UPDATE credentials SET
         name = ?, username = ?, auth_type = ?,
         password_enc = ?, private_key_enc = ?, passphrase_enc = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      name,
      (input.username ?? '').trim() || (db.prepare('SELECT username FROM credentials WHERE id = ?').get(id) as { username: string }).username,
      input.auth_type ?? (db.prepare('SELECT auth_type FROM credentials WHERE id = ?').get(id) as { auth_type: string }).auth_type,
      enc(input.password, row.password_enc),
      enc(input.private_key, row.private_key_enc),
      enc(input.passphrase, row.passphrase_enc),
      id,
    );
    const updated = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
    return toPublic(updated as Parameters<typeof toPublic>[0]);
  });

  app.delete('/api/credentials/:id', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const id = Number((req.params as { id: string }).id);
    // 引用该凭据的主机解除引用：主机若无内联凭据，删除后需重新配置凭据才能连接
    const detach = db.prepare('UPDATE hosts SET credential_id = NULL WHERE credential_id = ?').run(id);
    db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    return { ok: true, detachedHosts: detach.changes };
  });
}
