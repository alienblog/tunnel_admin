import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools, type McpDeps } from './tools.js';
import { verifyMcpToken } from '../routes/tokens.js';
import { decryptText } from '../crypto.js';
import type { McpPortManager } from '../mcpPortManager.js';

export type { McpDeps } from './tools.js';
export interface McpDepsWithPorts extends McpDeps {
  mcpPorts: McpPortManager;
}

const MCP_TOOLS: ReadonlyArray<readonly [string, string]> = [
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
];

/** 从请求 Host 头推导对外地址（含 MCP 独立端口时替换端口；优先动态生效端口） */
function mcpOrigin(req: FastifyRequest, deps: McpDepsWithPorts): string {
  const header = req.headers.host ?? '';
  const idx = header.lastIndexOf(':');
  // 无端口 / IPv6 字面量（含 ]）→ 用配置端口
  let hostname = header;
  if (idx > 0 && !header.includes(']')) hostname = header.slice(0, idx);
  const port = deps.mcpPorts.port ?? deps.config.mcpPort ?? deps.config.port;
  const proto = req.protocol;
  return port === 80 && proto === 'http' || port === 443 && proto === 'https'
    ? `${proto}://${hostname}`
    : `${proto}://${hostname}:${port}`;
}

/**
 * MCP 接入提示词路由（挂主 app）：动态地址 + 令牌选择 + 明文回显。
 * ?tokenId=<id> 指定令牌；不传则用第一个未吊销令牌。
 */
export function registerMcpPrompt(app: FastifyInstance, deps: McpDepsWithPorts): void {
  // 当前 MCP endpoint 地址（含独立端口），设置页展示
  app.get('/api/mcp/info', async (req) => {
    const port = deps.mcpPorts.port ?? deps.config.mcpPort ?? deps.config.port;
    return { url: `${mcpOrigin(req, deps)}/mcp`, port };
  });

  app.get('/api/mcp/prompt', async (req, reply) => {
    const query = req.query as { tokenId?: string };
    const rows = deps.db
      .prepare('SELECT id, name, token_enc FROM mcp_tokens WHERE revoked = 0 ORDER BY id ASC')
      .all() as Array<{ id: number; name: string; token_enc: string | null }>;
    if (rows.length === 0) {
      return reply.code(400).send({ error: '还没有 MCP 令牌，请先在设置页创建' });
    }
    const tokenId = query.tokenId ? Number(query.tokenId) : rows[0].id;
    const row = rows.find((r) => r.id === tokenId);
    if (!row) {
      return reply.code(400).send({ error: '指定令牌不存在或已吊销' });
    }
    if (!row.token_enc) {
      return reply.code(400).send({
        error: `令牌「${row.name}」创建于旧版本（明文不可恢复），无法生成含令牌的提示词；请创建新令牌`,
      });
    }
    let token: string;
    try {
      token = decryptText(deps.config.masterKey, row.token_enc);
    } catch {
      return reply.code(500).send({ error: '令牌解密失败（主密钥不匹配）' });
    }
    const origin = mcpOrigin(req, deps);
    const prompt = `你可以通过 MCP 服务器管理本机的 SSH 连接与远程主机。

## 接入方式

给客户端配置一个 MCP server：
- 类型：Streamable HTTP
- 地址：${origin}/mcp
- 认证：Bearer Token：\`${token}\`

客户端配置示例（Claude Code / Cursor 的 .mcp.json，omp / opencode 的 mcp 配置同样支持 http 类型）：

\`\`\`json
{
  "mcpServers": {
    "tunneladmin": {
      "type": "http",
      "url": "${origin}/mcp",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}
\`\`\`

## 可用工具

${MCP_TOOLS.map(([name, desc]) => `- \`${name}\`：${desc}`).join('\n')}

## 推荐工作流（重要：优先复用会话，避免频繁审批）

1. **查会话**：先调用 \`ssh_session_info\` 查看是否已有该主机的活跃会话；
2. **复用**：\`ssh_exec\` 等工具**始终传入 \`session\` 参数**（复用会话与记忆的工作目录），不要每次传 host 新建；
3. **无会话时**才 \`ssh_connect\`（返回 sessionId 后复用）；连接新主机需要用户在 Web 界面批准（弹窗）；
4. 任务完成用 \`ssh_disconnect\` 释放会话，避免堆积。

## 使用要点

- **审批与信任**：未信任主机的每次新建连接都需要人工批准（等待期间工具调用会挂起，超时后报错）。请在 Web 设置页 → 主机 → 编辑，把常用主机勾选为「信任」，之后连接免审批、不再出错；
- 会话断开时工具会报「会话不存在或已断开」，此时重新 \`ssh_connect\` 即可，不要 panic；
- 危险命令（如 rm -rf /、mkfs、shutdown 等）会被安全规则拦截或要求人工审批；
- 需要持续跟踪日志时用 ssh_tail + ssh_tail_poll 增量读取，用完 ssh_tail_stop 停止；
- 长任务用 ssh_exec 的 async 参数后台执行，再用 ssh_job_status 查询；
- 端口转发用 ssh_port_forward，目标主机端口会暴露到服务器 127.0.0.1:bindPort。`;
    return { ok: true, prompt };
  });
}

/** MCP Streamable HTTP endpoint（Bearer token 认证）。可挂主 app 或独立端口实例。 */
export function registerMcpEndpoint(app: FastifyInstance, deps: McpDeps): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!verifyMcpToken(deps.db, req.headers.authorization)) {
      await reply.code(401).send({ error: '无效或缺失 MCP token' });
      return;
    }
    // 无状态模式：每个请求新建 Server + transport（Protocol 单实例只支持单 transport）
    const server = new McpServer(
      { name: 'tunneladmin', version: '0.2.6' },
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

/** 兼容旧调用（挂主 app：prompt + endpoint 同端口） */
export function registerMcp(app: FastifyInstance, deps: McpDepsWithPorts): void {
  registerMcpPrompt(app, deps);
  registerMcpEndpoint(app, deps);
}
