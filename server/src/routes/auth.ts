import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, signSession, verifyPassword, verifySession, type Config } from '../config.js';

export const SESSION_COOKIE = 'ta_session';

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
    const body = req.body as { password?: string } | null;
    const password = body?.password ?? '';
    if (!verifyPassword(password, config.passwordHash)) {
      return reply.code(401).send({ error: '密码错误' });
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

  app.get('/api/me', async (req) => ({ authenticated: isAuthed(req, config), authRequired: config.authRequired }));

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
