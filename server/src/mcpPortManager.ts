import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerMcpEndpoint } from './mcp/index.js';
import type { McpDeps } from './mcp/tools.js';

/**
 * MCP 独立端口管理器：运行时动态启用/关闭 MCP 独立监听实例（设置页可配置）。
 * - 未启用（null）：MCP 挂主服务 /mcp
 * - 启用：独立 Fastify 实例只挂 /mcp（Bearer token 鉴权）
 */
export class McpPortManager {
  private app: FastifyInstance | null = null;
  private current: number | null = null;

  constructor(private deps: McpDeps) {}

  /** 当前生效的独立端口（null = 未启用，MCP 在主服务） */
  get port(): number | null {
    return this.current;
  }

  /** 应用端口：先停旧实例，再按新端口启动；失败时抛错并保持无独立实例 */
  async apply(port: number | null): Promise<void> {
    if (this.app) {
      await this.app.close().catch(() => {});
      this.app = null;
      this.current = null;
    }
    if (port === null) return;
    const app = Fastify({ logger: { level: 'warn' } });
    registerMcpEndpoint(app, this.deps);
    await app.listen({ port, host: this.deps.config.host });
    this.app = app;
    this.current = port;
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close().catch(() => {});
      this.app = null;
      this.current = null;
    }
  }
}
