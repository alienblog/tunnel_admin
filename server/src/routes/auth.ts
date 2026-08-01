import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { signSession, verifyPassword, verifySession, type Config } from '../config.js';

export const SESSION_COOKIE = 'ta_session';

export function isAuthed(req: FastifyRequest, config: Config): boolean {
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

  app.get('/api/me', async (req) => ({ authenticated: isAuthed(req, config) }));
}
