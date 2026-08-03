import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface HostRow {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private_key';
  password_enc: string | null;
  private_key_enc: string | null;
  passphrase_enc: string | null;
  jump_host_id: number | null;
  credential_id: number | null;
  group: string;
  tags: string;
  note: string;
  trusted: number;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password','private_key')),
  password_enc TEXT,
  private_key_enc TEXT,
  passphrase_enc TEXT,
  jump_host_id INTEGER REFERENCES hosts(id),
  credential_id INTEGER REFERENCES credentials(id),
  "group" TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  trusted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  source TEXT NOT NULL CHECK (source IN ('web','mcp')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL CHECK (source IN ('web','mcp')),
  host_id INTEGER,
  host_name TEXT,
  command TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('password','private_key')),
  password_enc TEXT,
  private_key_enc TEXT,
  passphrase_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id INTEGER NOT NULL REFERENCES hosts(id),
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS cmd_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('block','approve')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 默认危险命令规则（可增删）
INSERT OR IGNORE INTO cmd_rules (pattern, action, note) VALUES
  ('^\\s*rm\\s+-rf\\s+/\\s*$', 'block', '删除根目录'),
  ('^\\s*rm\\s+-rf\\s+~', 'block', '删除用户目录'),
  ('mkfs', 'block', '格式化磁盘'),
  ('dd\\s+if=', 'approve', '写入设备（确认目标）'),
  ('(^|\\s)(shutdown|reboot|poweroff|halt)\\b', 'approve', '关机/重启'),
  ('(^|\\s)init\\s+0', 'block', '关机'),
  ('chmod\\s+-R\\s+777\\s+/', 'approve', '根目录权限放开');
`;

export function openDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'tunneladmin.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // 迁移：mcp_tokens 补充 token_enc 列（AES 加密的明文令牌，供接入提示词回显；旧令牌为空）
  try {
    db.exec('ALTER TABLE mcp_tokens ADD COLUMN token_enc TEXT');
  } catch {
    // 列已存在
  }
  // 迁移：hosts 补充 credential_id 列（凭据引用，可空 = 使用内联凭据）
  try {
    db.exec('ALTER TABLE hosts ADD COLUMN credential_id INTEGER REFERENCES credentials(id)');
  } catch {
    // 列已存在
  }
  // 迁移：旧库 cmd_rules 表无 UNIQUE 约束时 seed 会重复，去重保留最小 id
  db.exec('DELETE FROM cmd_rules WHERE id NOT IN (SELECT MIN(id) FROM cmd_rules GROUP BY pattern)');
  return db;
}
