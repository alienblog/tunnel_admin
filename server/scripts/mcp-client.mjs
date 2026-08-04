#!/usr/bin/env node
/**
 * TunnelAdmin MCP 调试客户端：直接调用 MCP 工具，帮助验证/排查 agent 连接问题。
 *
 * 用法：
 *   node scripts/mcp-client.mjs list [--url <mcp地址>] [--token <Bearer令牌>]
 *   node scripts/mcp-client.mjs call <工具名> '<JSON 参数>' [--url ...] [--token ...]
 *
 * 示例：
 *   node scripts/mcp-client.mjs list --token ta_xxx
 *   node scripts/mcp-client.mjs call ssh_list_hosts '{}' --token ta_xxx
 *   node scripts/mcp-client.mjs call ssh_session_info '{}' --token ta_xxx
 *   node scripts/mcp-client.mjs call ssh_exec '{"host":"1","command":"uname -a"}' --token ta_xxx
 *   node scripts/mcp-client.mjs call ssh_connect '{"host":"1"}' --token ta_xxx
 *
 * 默认地址 http://127.0.0.1:8080/mcp；令牌也可用环境变量 TUNNELADMIN_MCP_TOKEN。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const url = opt('--url') ?? process.env.TUNNELADMIN_MCP_URL ?? 'http://127.0.0.1:8080/mcp';
const token = opt('--token') ?? process.env.TUNNELADMIN_MCP_TOKEN;
if (!token) {
  console.error('缺少令牌：用 --token <令牌> 或环境变量 TUNNELADMIN_MCP_TOKEN（设置页 → MCP → 新建令牌）');
  process.exit(1);
}

const cmd = args[0];
if (cmd !== 'list' && cmd !== 'call') {
  console.error('用法: node scripts/mcp-client.mjs <list|call> [工具名] [JSON参数] [--url ...] [--token ...]');
  process.exit(1);
}

const client = new Client({ name: 'tunneladmin-mcp-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  if (cmd === 'list') {
    const { tools } = await client.listTools();
    for (const t of tools) {
      console.log(`- ${t.name}：${t.description ?? ''}`.slice(0, 160));
    }
    console.log(`\n共 ${tools.length} 个工具`);
  } else {
    const name = args[1];
    if (!name) {
      console.error('call 需要工具名');
      process.exit(1);
    }
    let params = {};
    if (args[2] !== undefined && !args[2].startsWith('--')) {
      try {
        params = JSON.parse(args[2]);
      } catch {
        console.error(`参数不是合法 JSON: ${args[2]}`);
        process.exit(1);
      }
    }
    const t0 = Date.now();
    const result = await client.callTool({ name, arguments: params });
    console.log(`[${Date.now() - t0}ms]`);
    for (const c of result.content ?? []) {
      if (c.type === 'text') console.log(c.text);
      else console.log(JSON.stringify(c, null, 2));
    }
    if (result.isError) process.exitCode = 2;
  }
} catch (err) {
  console.error(`调用失败: ${err?.message ?? err}`);
  console.error('检查：地址/令牌是否正确、MCP 服务是否运行（主服务端口或独立 MCP 端口）');
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
