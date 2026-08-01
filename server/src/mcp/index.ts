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
  // MCP 接入提示词：供 Web 端一键复制，粘贴给 agent 后即可接入本 MCP server
  app.get('/api/mcp/prompt', async (req, reply) => {
    const tools = [
      ['ssh_list_hosts', '列出所有可连接的主机（含 ID、名称、地址、分组、信任状态）'],
      ['ssh_connect', '建立 SSH 连接会话（首次需 Web 人工批准）'],
      ['ssh_exec', '执行命令返回 stdout/stderr/退出码（支持 session 复用与后台任务）'],
      ['ssh_read_file', '读取远程文件内容'],
      ['ssh_write_file', '写入远程文件'],
      ['ssh_list_dir', '列出远程目录内容'],
      ['ssh_stat', '查看远程文件/目录元信息'],
      ['ssh_session_info', '列出活跃 MCP SSH 会话'],
      ['ssh_disconnect', '断开指定 SSH 会话'],
      ['ssh_job_status', '查询后台命令任务结果'],
      ['ssh_tail', '开启文件流式跟踪（tail -f）'],
      ['ssh_tail_poll', '增量拉取 tail 新输出'],
      ['ssh_tail_stop', '停止 tail 跟踪'],
      ['ssh_port_forward', '远程端口转发到服务器端口'],
      ['ssh_list_forwards', '列出活跃端口转发'],
      ['ssh_stop_forward', '停止端口转发'],
    ] as const;
    const origin = `${req.protocol}://${req.host}`;
    const prompt = `你可以通过 MCP 服务器管理本机的 SSH 连接与远程主机。

## 接入方式

给客户端配置一个 MCP server：
- 类型：Streamable HTTP
- 地址：${origin}/mcp
- 认证：Bearer Token（在 TunnelAdmin 设置页的「MCP 令牌」中创建）

## 可用工具

${tools.map(([name, desc]) => `- \`${name}\`：${desc}`).join('\n')}

## 使用要点

- 连接新主机需要用户在 Web 界面批准（弹窗），请先调用 ssh_list_hosts 查看，再 ssh_connect；
- 危险命令（如 rm -rf /、mkfs、shutdown 等）会被安全规则拦截或要求人工审批；
- 需要持续跟踪日志时用 ssh_tail + ssh_tail_poll 增量读取，用完 ssh_tail_stop 停止；
- 长任务用 ssh_exec 的 async 参数后台执行，再用 ssh_job_status 查询；
- 端口转发用 ssh_port_forward，目标主机端口会暴露到服务器 127.0.0.1:bindPort。`;
    return { ok: true, prompt };
  });

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
