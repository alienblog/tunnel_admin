import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, signSession, verifyPassword, verifySession, type Config } from '../config.js';

export const SESSION_COOKIE = 'ta_session';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 是否要求登录（TUNNELADMIN_AUTH=none 时免登录，桌面客户端用） */
export function isAuthed(req: FastifyRequest, config: Config): boolean {
  if (!config.authRequired) return true;
  return verifySession(config.sessionSecret, req.cookies?.[SESSION_COOKIE]);
}

/** 未登录返回 401 并发送错误响应 */
export function requireAuth(req: FastifyRequest, reply: FastifyReply, config: Config): boolean {
  if (isAuthed(req, config)) return true;
  reply.code(401).send({ error: '未登录' });
  return false;
}

// 登录失败限流（内存，按 IP：10 次/5 分钟，防暴力破解）
const MAX_LOGIN_FAILS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const loginFails = new Map<string, { count: number; resetAt: number }>();

export function registerAuth(app: FastifyInstance, config: Config): void {
  app.post('/api/login', async (req, reply) => {
    // 免登录模式：任意请求直接成功
    if (!config.authRequired) {
      reply.setCookie(SESSION_COOKIE, signSession(config.sessionSecret), {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24 * 30,
      });
      return { ok: true };
    }

    // 简单限流：失败次数超限返回 429（窗口过期自动重置）
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    let rec = loginFails.get(ip);
    if (!rec || rec.resetAt < now) {
      rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      loginFails.set(ip, rec);
    }
    if (rec.count >= MAX_LOGIN_FAILS) {
      return reply.code(429).send({ error: '登录尝试次数过多，请 5 分钟后再试' });
    }

    const body = req.body as { password?: string } | null;
    const password = body?.password ?? '';
    if (!verifyPassword(password, config.passwordHash)) {
      rec.count += 1;
      return reply.code(401).send({ error: '密码错误' });
    }
    loginFails.delete(ip);

    // 旧版 SHA-256 哈希验证通过后升级为 scrypt 格式（写入失败不影响登录）
    if (!config.passwordHash.startsWith('s2:')) {
      config.passwordHash = hashPassword(password);
      try {
        fs.writeFileSync(path.join(config.dataDir, 'password.hash'), config.passwordHash, { mode: 0o600 });
      } catch (err) {
        req.log.warn(`密码哈希升级写入失败: ${(err as Error).message}`);
      }
    }

    reply.setCookie(SESSION_COOKIE, signSession(config.sessionSecret), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // 应用版本（根 package.json，状态栏显示；发布时随根版本号同步）
  const appVersion = (() => {
    try {
      const root = path.resolve(__dirname, '../../..');
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
      return pkg.version ?? '';
    } catch {
      return '';
    }
  })();

  app.get('/api/me', async (req) => ({
    authenticated: isAuthed(req, config),
    authRequired: config.authRequired,
    version: appVersion,
  }));

  // 修改 Web 登录密码（免登录模式也可设置，重启后去掉 TUNNELADMIN_AUTH=none 即生效）
  app.post('/api/password', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { oldPassword?: string; newPassword?: string } | null;
    const newPassword = body?.newPassword ?? '';
    if (newPassword.length < 6) {
      return reply.code(400).send({ error: '新密码至少 6 位' });
    }
    // 密码模式下必须验证旧密码；免登录模式跳过（本地单用户）
    if (config.authRequired && !verifyPassword(body?.oldPassword ?? '', config.passwordHash)) {
      return reply.code(401).send({ error: '旧密码错误' });
    }
    config.passwordHash = hashPassword(newPassword);
    try {
      fs.writeFileSync(path.join(config.dataDir, 'password.hash'), config.passwordHash, { mode: 0o600 });
    } catch (err) {
      return reply.code(500).send({ error: `密码已更新但写入失败：${(err as Error).message}` });
    }
    return { ok: true };
  });
}
