/**
 * TunnelAdmin Windows 执行代理：
 * 在 Windows 侧运行，供 WSL2/远端驱动 Windows 命令（npm/electron-builder 等）。
 *
 * 启动（Windows 命令行）：
 *   C:\tools\node-v22.23.2-win-x64\node.exe C:\tunneladmin-build\scripts\win-proxy.js
 * 首次启动会打印 token；建议以管理员身份运行（解决符号链接解压权限）。
 *
 * API（全部 JSON，Authorization: Bearer <token>）：
 *   GET  /ping                      健康检查
 *   POST /exec                      { command, cwd, env?, timeoutMs? } → { jobId }
 *   GET  /jobs/<jobId>              查询任务（stdout/stderr 累积，完成带 exitCode）
 *   POST /jobs/<jobId>/kill         终止任务
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 8897);
const TOKEN = process.argv.find((a) => a.startsWith('--token='))?.split('=')[1] || crypto.randomBytes(12).toString('hex');
// 便携 node 目录（可 --node-dir= 覆盖）
const NODE_DIR = process.argv.find((a) => a.startsWith('--node-dir='))?.split('=')[1] || 'C:\\tools\\node-v22.23.2-win-x64';

const jobs = new Map();
let jobSeq = 0;

function runJob({ command, cwd, env = {}, timeoutMs }) {
  const id = `job-${++jobSeq}`;
  const job = { id, status: 'running', stdout: '', stderr: '', exitCode: null, startedAt: Date.now() };
  jobs.set(id, job);
  const fullEnv = {
    ...process.env,
    Path: `${NODE_DIR};${process.env.Path || process.env.PATH || ''}`,
    ...env,
  };
  // chcp 65001：命令输出统一 UTF-8
  const proc = spawn('cmd.exe', ['/d', '/s', '/c', `chcp 65001 >nul & ${command}`], {
    cwd,
    env: fullEnv,
    windowsHide: true,
  });
  proc.stdout.on('data', (d) => {
    job.stdout += d.toString('utf8');
    if (job.stdout.length > 2 * 1024 * 1024) job.stdout = job.stdout.slice(-2 * 1024 * 1024);
  });
  proc.stderr.on('data', (d) => {
    job.stderr += d.toString('utf8');
    if (job.stderr.length > 1024 * 1024) job.stderr = job.stderr.slice(-1024 * 1024);
  });
  proc.on('error', (e) => {
    job.status = 'done';
    job.exitCode = -1;
    job.stderr += `\n[proxy] spawn error: ${e.message}`;
  });
  proc.on('close', (code) => {
    job.status = 'done';
    job.exitCode = code;
  });
  if (timeoutMs) {
    setTimeout(() => {
      if (job.status === 'running') {
        proc.kill();
        job.stderr += '\n[proxy] timeout, killed';
      }
    }, timeoutMs);
  }
  return id;
}

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function auth(req, res) {
  const h = req.headers.authorization || '';
  if (h !== `Bearer ${TOKEN}`) {
    send(res, 401, { error: '无效 token' });
    return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/ping') {
    send(res, 200, { ok: true, pid: process.pid, node: process.version });
    return;
  }
  if (!auth(req, res)) return;

  if (req.method === 'POST' && url.pathname === '/exec') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const { command, cwd, env, timeoutMs } = JSON.parse(body || '{}');
        if (!command) return send(res, 400, { error: 'command 必填' });
        const id = runJob({ command, cwd, env, timeoutMs });
        send(res, 200, { jobId: id });
      } catch (e) {
        send(res, 400, { error: e.message });
      }
    });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const id = url.pathname.slice(6);
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: '任务不存在' });
    send(res, 200, { ...job, running: job.status === 'running' });
    return;
  }
  if (req.method === 'POST' && url.pathname.endsWith('/kill')) {
    const id = url.pathname.slice(6).replace(/\/kill$/, '');
    const job = jobs.get(id);
    if (!job) return send(res, 404, { error: '任务不存在' });
    job.status = 'done';
    job.exitCode = -1;
    job.stderr += '\n[proxy] killed by client';
    send(res, 200, { ok: true });
    return;
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==============================================');
  console.log('TunnelAdmin Windows 代理已启动');
  console.log(`  端口: ${PORT}`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  建议以管理员身份运行（符号链接解压权限）`);
  console.log('  测试: curl http://127.0.0.1:%d/ping', PORT);
  console.log('==============================================');
});
