import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { McpPortManager } from '../mcpPortManager.js';
import { requireAuth } from './auth.js';

/**
 * MCP 端口运行时配置（设置页）：
 * - POST /api/mcp/port { port: number | null }：应用并持久化到 data/config.json（null = 关闭独立端口）
 * - GET  /api/mcp/port：当前生效端口与来源
 */
export function registerMcpPortSettings(app: FastifyInstance, config: Config, mcpPorts: McpPortManager): void {
  const configFile = path.join(config.dataDir, 'config.json');

  function loadSaved(): { mcpPort: number | null } {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8')) as { mcpPort: number | null };
    } catch {
      return { mcpPort: null };
    }
  }

  app.get('/api/mcp/port', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const saved = loadSaved();
    return {
      port: mcpPorts.port ?? config.mcpPort ?? null,
      configured: saved.mcpPort ?? null,
      envOverride: process.env.TUNNELADMIN_MCP_PORT ? parseInt(process.env.TUNNELADMIN_MCP_PORT, 10) || null : null,
    };
  });

  app.post('/api/mcp/port', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { port?: number | null };
    const port = body.port === null || body.port === undefined ? null : Number(body.port);
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      return reply.code(400).send({ error: '端口必须是 1-65535 的整数' });
    }
    if (port === config.port) {
      return reply.code(400).send({ error: `不能与主服务端口 ${config.port} 相同` });
    }
    if (process.env.TUNNELADMIN_MCP_PORT) {
      return reply.code(400).send({ error: '已设置 TUNNELADMIN_MCP_PORT 环境变量，端口由环境变量控制，无法在设置页修改' });
    }
    const previous = mcpPorts.port ?? config.mcpPort ?? null;
    // 先应用（失败回滚），成功后持久化
    try {
      await mcpPorts.apply(port);
    } catch (err) {
      await mcpPorts.apply(previous).catch(() => {});
      return reply.code(400).send({ error: `端口 ${port ?? '（关闭）'} 不可用：${(err as Error).message}` });
    }
    const saved = loadSaved();
    saved.mcpPort = port;
    try {
      fs.writeFileSync(configFile, JSON.stringify(saved, null, 2) + '\n');
    } catch (err) {
      await mcpPorts.apply(previous).catch(() => {});
      return reply.code(500).send({ error: `配置保存失败：${(err as Error).message}` });
    }
    return { ok: true, port };
  });
}
