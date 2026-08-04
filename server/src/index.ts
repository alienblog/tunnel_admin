import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { SshManager } from './ssh/manager.js';
import { ApprovalService } from './approval.js';
import { registerAuth } from './routes/auth.js';
import { registerHosts, registerHostTest } from './routes/hosts.js';
import { registerTokens } from './routes/tokens.js';
import { registerCredentials } from './routes/credentials.js';
import { registerApprovals, registerAudit, registerSessions, registerCmdRules } from './routes/misc.js';
import { registerSftp } from './routes/sftp.js';
import { SftpSessionCache } from './routes/sftpSession.js';
import { registerMetrics } from './routes/metrics.js';
import { registerComplete } from './routes/complete.js';
import { registerForward } from './routes/forward.js';
import { registerWs } from './ws.js';
import { registerMcpEndpoint, registerMcpPrompt } from './mcp/index.js';
import { McpPortManager } from './mcpPortManager.js';
import { registerMcpPortSettings } from './routes/mcpPort.js';

const config = loadConfig();
const db = openDb(config.dataDir);
const sshManager = new SshManager(db, config.masterKey);
const approvals = new ApprovalService(db, config.approvalTimeoutMs);
const sftpSessions = new SftpSessionCache(sshManager);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(fastifyCookie);
await app.register(websocket);

// API 路由
registerAuth(app, config);
registerHosts(app, config, db);
registerHostTest(app, config, sshManager);
registerTokens(app, config, db);
registerCredentials(app, config, db);
registerApprovals(app, config, approvals);
registerAudit(app, config, db);
registerSessions(app, config, sshManager);
registerCmdRules(app, config, db);
registerSftp(app, config, db, sftpSessions);
registerMetrics(app, config, sftpSessions);
registerComplete(app, config, sftpSessions);
registerForward(app, config, db, sshManager);

// WebSocket 事件桥（终端 + 审批推送）
registerWs(app, config, sshManager);

// MCP：独立端口管理器（设置页可运行时配置端口；未启用时 MCP 挂主服务 /mcp）
const mcpDeps = { config, db, sshManager, approvals };
const mcpPorts = new McpPortManager(mcpDeps);

// MCP 接入提示词（主 API 提供，地址按 MCP 实际端口动态生成）
registerMcpPrompt(app, { config, db, sshManager, approvals, mcpPorts });
// MCP 端口设置接口（手动输入/随机生成，保存即生效并持久化到 data/config.json）
registerMcpPortSettings(app, config, mcpPorts);

// 启动时按配置启用独立端口；否则 MCP 挂主服务
if (config.mcpPort && config.mcpPort !== config.port) {
  await mcpPorts.apply(config.mcpPort);
} else {
  registerMcpEndpoint(app, mcpDeps);
}

// 生产模式：托管 web 构建产物
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: '/',
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/ws') || req.raw.url?.startsWith('/mcp')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.sendFile('index.html');
  });
}

const shutdown = (): void => {
  app.log.info('正在关闭…');
  sshManager.closeAll();
  void mcpPorts.close();
  db.close();
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
};
// 崩溃防护：未捕获异常记录后退出（退出码 1，start.sh 自动重启）；未处理 rejection 记录（避免静默丢错）
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
