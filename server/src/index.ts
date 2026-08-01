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
import { registerHosts } from './routes/hosts.js';
import { registerTokens } from './routes/tokens.js';
import { registerApprovals, registerAudit, registerSessions, registerCmdRules } from './routes/misc.js';
import { registerSftp } from './routes/sftp.js';
import { SftpSessionCache } from './routes/sftpSession.js';
import { registerMetrics } from './routes/metrics.js';
import { registerComplete } from './routes/complete.js';
import { registerForward } from './routes/forward.js';
import { registerWs } from './ws.js';
import { registerMcp } from './mcp/index.js';

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
registerTokens(app, config, db);
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

// MCP Streamable HTTP endpoint（Bearer token 认证）
registerMcp(app, { config, db, sshManager, approvals });

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
  db.close();
  app.close().then(() => process.exit(0)).catch(() => process.exit(1));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
