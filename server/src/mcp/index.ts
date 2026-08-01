import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type McpDeps } from './tools.js';
import { verifyMcpToken } from '../routes/tokens.js';

/**
 * MCP Streamable HTTP endpoint（无状态模式）：
 * 每次请求创建临时 transport 并连接到共享的 McpServer 单例。
 * POST /mcp 执行 JSON-RPC，GET /mcp 建立 SSE 流。
 * 所有请求必须携带 `Authorization: Bearer <token>`。
 */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!verifyMcpToken(deps.db, req.headers.authorization)) {
      await reply.code(401).send({ error: '无效或缺失 MCP token' });
      return;
    }
    // 无状态模式：每个请求新建 Server + transport（Protocol 单实例只支持单 transport）
    const server = new McpServer(
      { name: 'tunneladmin', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(server, deps);
    const transport = new StreamableHTTPServerTransport({});
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body as Record<string, unknown> | undefined);
  };

  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
