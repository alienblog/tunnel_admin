import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  /** HTTP 监听端口 */
  port: number;
  /** 监听地址 */
  host: string;
  /** MCP 独立监听端口（null = 与主服务同端口） */
  mcpPort: number | null;
  /** 数据目录（SQLite、密钥文件） */
  dataDir: string;
  /** AES-256-GCM 主密钥 */
  masterKey: Buffer;
  /** Web 登录密码哈希（salt:hash） */
  passwordHash: string;
  /** 是否要求 Web 登录（TUNNELADMIN_AUTH=none 免登录） */
  authRequired: boolean;
  /** cookie 签名密钥 */
  sessionSecret: string;
  /** agent 连接审批超时（毫秒） */
  approvalTimeoutMs: number;
  /** MCP 命令默认超时（毫秒） */
  mcpDefaultTimeoutMs: number;
  /** MCP 命令输出截断上限（字节） */
  mcpOutputLimit: number;
}

export function hashPassword(pwd: string): string {
  const salt = randomBytes(16);
  const hash = createHash('sha256').update(salt).update(pwd, 'utf8').digest();
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pwd: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const hash = createHash('sha256').update(salt).update(pwd, 'utf8').digest();
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // 数据目录固定定位到项目根（src/config.ts 与 dist/config.js 的 ../.. 均为项目根），
  // 避免 npm workspace 切换 cwd 导致数据落错位置。
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(moduleDir, '..', '..');
  const dataDir = env.TUNNELADMIN_DATA_DIR ?? path.join(projectRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // 主密钥：优先环境变量；否则读/生成密钥文件（0600）
  let masterKey: Buffer;
  const keyFile = path.join(dataDir, 'master.key');
  if (env.TUNNELADMIN_MASTER_KEY) {
    const hex = env.TUNNELADMIN_MASTER_KEY.replace(/^0x/i, '');
    masterKey = Buffer.from(hex, 'hex');
    if (masterKey.length !== 32) {
      throw new Error('TUNNELADMIN_MASTER_KEY 必须是 64 位 hex 字符串（32 字节）');
    }
  } else if (fs.existsSync(keyFile)) {
    masterKey = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } else {
    masterKey = randomBytes(32);
    fs.writeFileSync(keyFile, masterKey.toString('hex') + '\n', { mode: 0o600 });
    console.log(`[config] 已生成主密钥文件: ${keyFile}（chmod 600）`);
  }

  // Web 登录密码：优先环境变量；否则读/生成密码哈希文件（0600）
  let passwordHash: string;
  const pwdFile = path.join(dataDir, 'password.hash');
  if (env.TUNNELADMIN_PASSWORD) {
    passwordHash = hashPassword(env.TUNNELADMIN_PASSWORD);
  } else if (fs.existsSync(pwdFile)) {
    passwordHash = fs.readFileSync(pwdFile, 'utf8').trim();
  } else {
    const pwd = randomBytes(9).toString('base64url');
    passwordHash = hashPassword(pwd);
    fs.writeFileSync(pwdFile, passwordHash, { mode: 0o600 });
    console.log(`[config] 首次启动生成 Web 登录密码: ${pwd}`);
    console.log(`[config] 密码哈希已保存: ${pwdFile}（可用 TUNNELADMIN_PASSWORD 环境变量覆盖）`);
  }

  return {
    port: parseInt(env.PORT ?? env.TUNNELADMIN_PORT ?? '8080', 10),
    host: env.HOST ?? '0.0.0.0',
    mcpPort: env.TUNNELADMIN_MCP_PORT ? parseInt(env.TUNNELADMIN_MCP_PORT, 10) || null : null,
    dataDir,
    masterKey,
    passwordHash,
    authRequired: (env.TUNNELADMIN_AUTH ?? 'password') !== 'none',
    sessionSecret: env.TUNNELADMIN_SESSION_SECRET ?? masterKey.toString('hex'),
    approvalTimeoutMs: parseInt(env.TUNNELADMIN_APPROVAL_TIMEOUT ?? '60000', 10),
    mcpDefaultTimeoutMs: parseInt(env.TUNNELADMIN_MCP_TIMEOUT ?? '30000', 10),
    mcpOutputLimit: parseInt(env.TUNNELADMIN_MCP_OUTPUT_LIMIT ?? '65536', 10),
  };
}

// ---- 无状态签名 cookie ----

const SESSION_PAYLOAD = 'auth=1';

export function signSession(secret: string): string {
  const sig = createHmac('sha256', secret).update(SESSION_PAYLOAD).digest('base64url');
  return `${SESSION_PAYLOAD}.${sig}`;
}

export function verifySession(secret: string, cookie: string | undefined): boolean {
  if (!cookie) return false;
  const idx = cookie.lastIndexOf('.');
  if (idx <= 0) return false;
  const payload = cookie.slice(0, idx);
  const sig = cookie.slice(idx + 1);
  if (payload !== SESSION_PAYLOAD) return false;
  const expect = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}
