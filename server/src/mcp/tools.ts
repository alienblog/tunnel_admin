import crypto from 'node:crypto';
import { z } from 'zod';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { HostRow } from '../db.js';
import type { SshManager, SshSession } from '../ssh/manager.js';
import type { ApprovalService } from '../approval.js';
import { logAudit, type CmdRule } from '../routes/misc.js';
import { eventBus } from '../events.js';

export interface McpDeps {
  config: Config;
  db: Database.Database;
  sshManager: SshManager;
  approvals: ApprovalService;
}

interface SessionState {
  cwd: string | null;
}

interface JobRecord {
  status: 'running' | 'done';
  result?: unknown;
}

/** 流式任务（tail -f 等）：分片累积，支持增量拉取 */
interface StreamJob {
  status: 'running' | 'done';
  chunks: Array<{ i: number; data: string }>;
  next: number;
  channel: import('ssh2').Channel | null;
}

// 会话状态/任务/SFTP 句柄缓存在进程级共享：无状态模式下每个请求会新建
// McpServer + registerTools，状态必须独立于注册闭包，否则会话记忆会随请求丢失。
const sessionStates = new Map<string, SessionState>();
const sftpCache = new Map<string, SFTPWrapper>();
const jobs = new Map<string, JobRecord>();
const streamJobs = new Map<string, StreamJob>();
const JOB_RETENTION = 50;

// MCP 端口转发（远程为主）：id → 记录
interface ForwardRec {
  id: string;
  sessionId: string;
  hostName: string;
  bindPort: number;
  remoteHost: string;
  remotePort: number;
}
const mcpForwards = new Map<string, ForwardRec>();
let forwardSeq = 0;

function text(result: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      },
    ],
  };
}

/** shell 单引号转义，防注入 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export function registerTools(server: McpServer, deps: McpDeps): void {
  const { config, db, sshManager, approvals } = deps;

  function resolveHost(hostIdOrName: string): HostRow | null {
    const id = Number(hostIdOrName);
    if (Number.isInteger(id) && id > 0) {
      const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
      if (row) return row;
    }
    return (db.prepare('SELECT * FROM hosts WHERE name = ?').get(hostIdOrName) as HostRow | undefined) ?? null;
  }

  /** 已信任则直连，否则走人工审批。未传 sessionId 新建的会话标记 ephemeral（一次性，用完自动断开） */
  async function acquireSession(host?: string, sessionId?: string): Promise<{ session?: SshSession; error?: string; ephemeral?: boolean }> {
    if (sessionId) {
      const s = sshManager.get(sessionId);
      return s ? { session: s, ephemeral: false } : { error: `会话不存在或已断开: ${sessionId}` };
    }
    if (!host) return { error: '需要提供 host 或 session 之一' };
    const row = resolveHost(host);
    if (!row) return { error: `主机不存在: ${host}` };

    if (!row.trusted) {
      const result = await approvals.requestApproval(row, 'mcp');
      if (result.status !== 'approved') {
        return { error: `连接未获批准（${result.status}）：请在 Web 界面确认后再试` };
      }
    }
    try {
      const s = await sshManager.connect(row, { source: 'mcp' });
      sessionStates.set(s.id, { cwd: null });
      return { session: s, ephemeral: true };
    } catch (err) {
      return { error: `连接失败: ${(err as Error).message}` };
    }
  }

  function getSftp(session: SshSession): Promise<SFTPWrapper> {
    const cached = sftpCache.get(session.id);
    if (cached) return Promise.resolve(cached);
    const { promise, resolve, reject } = Promise.withResolvers<SFTPWrapper>();
    session.client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftpCache.set(session.id, sftp);
      resolve(sftp);
    });
    return promise;
  }

  function execCommand(
    session: SshSession,
    command: string,
    opts: { cwd?: string | null; env?: Record<string, string>; timeoutMs: number },
  ): Promise<ExecResult> {
    const state = sessionStates.get(session.id);
    const cwd = opts.cwd ?? state?.cwd ?? null;
    const prefix: string[] = [];
    if (cwd) prefix.push(`cd ${shellQuote(cwd)}`);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) prefix.push(`export ${k}=${shellQuote(v)}`);
    }
    const fullCmd = prefix.length ? `${prefix.join(' && ')} && ${command}` : command;

    const { promise, resolve } = Promise.withResolvers<ExecResult>();
    {
      const t0 = Date.now();
      session.client.exec(fullCmd, (err, channel) => {
        if (err) {
          return resolve({
            stdout: '',
            stderr: `无法执行命令: ${err.message}`,
            exitCode: -1,
            timedOut: false,
            durationMs: Date.now() - t0,
          });
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const limit = config.mcpOutputLimit;
        const append = (buf: Buffer, target: () => string, sink: (s: string) => void): void => {
          if (target().length >= limit) return;
          sink(buf.toString('utf8').slice(0, limit - target().length));
        };
        channel.on('data', (d: Buffer) => {
          append(d, () => stdout, (s) => (stdout += s));
          // agent 命令活动实时镜像到 Web 端会话视图
          eventBus.broadcast({ type: 'exec:activity', sessionId: session.id, kind: 'data', data: d.toString('utf8') });
        });
        channel.stderr.on('data', (d: Buffer) => append(d, () => stderr, (s) => (stderr += s)));
        channel.on('error', () => channel.close());

        const timer = setTimeout(() => {
          timedOut = true;
          channel.close();
        }, opts.timeoutMs);

        channel.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (opts.cwd !== undefined) sessionStates.set(session.id, { cwd: opts.cwd });
          const exitCode = code ?? -1;
          // 完成状态：失败（非 0 / 超时）/ 警告（成功但 stderr 有输出）/ 成功
          const status =
            exitCode !== 0 || timedOut
              ? ('error' as const)
              : stderr.trim() !== ''
                ? ('warning' as const)
                : ('success' as const);
          eventBus.broadcast({
            type: 'exec:activity',
            sessionId: session.id,
            kind: 'end',
            exitCode,
            status,
          });
          resolve({ stdout, stderr, exitCode, timedOut, durationMs: Date.now() - t0 });
        });
      });
    }
    return promise;
  }

  /** 危险命令检查：匹配 block 规则直接拒绝；approve 规则弹窗审批 */
  async function checkCommandRule(
    command: string,
    session: SshSession,
  ): Promise<{ error?: string }> {
    const rules = db.prepare('SELECT * FROM cmd_rules').all() as CmdRule[];
    for (const rule of rules) {
      let matched: boolean;
      try {
        matched = new RegExp(rule.pattern).test(command);
      } catch {
        continue; // 非法正则跳过
      }
      if (!matched) continue;
      if (rule.action === 'block') {
        return { error: `命令被安全规则拦截（${rule.note || rule.pattern}）` };
      }
      // approve：人工审批
      const host = sshManager.getHostRow(session.hostId);
      if (!host) return { error: '主机信息缺失' };
      const result = await approvals.requestApproval(host, 'mcp', 'command', command);
      if (result.status !== 'approved') {
        return { error: '命令未获批准：用户拒绝了执行' };
      }
      break;
    }
    return {};
  }

  // ---- 工具注册 ----

  server.tool(
    'ssh_list_hosts',
    '列出所有可连接的主机（含 ID、名称、地址、分组、信任状态），供后续连接使用',
    { group: z.string().optional().describe('按分组过滤') },
    async ({ group }) => {
      const rows = db.prepare('SELECT * FROM hosts ORDER BY "group", name').all() as HostRow[];
      const list = rows
        .filter((r) => !group || r.group === group)
        .map((r) => ({
          id: r.id,
          name: r.name,
          host: r.host,
          port: r.port,
          username: r.username,
          group: r.group,
          tags: r.tags,
          note: r.note,
          trusted: !!r.trusted,
        }));
      return text(list);
    },
  );

  server.tool(
    'ssh_connect',
    '建立 SSH 连接会话。首次连接某台主机需要用户在 Web 界面批准（有弹窗提示），批准后可返回 sessionId 供后续工具复用',
    {
      host: z.string().describe('主机 ID 或名称'),
    },
    async ({ host }) => {
      const row = resolveHost(host);
      if (!row) return text({ error: `主机不存在: ${host}` });
      if (!row.trusted) {
        const result = await approvals.requestApproval(row, 'mcp');
        if (result.status !== 'approved') {
          return text({ error: `连接未获批准（${result.status}）：用户未确认对 ${row.name}（${row.host}）的连接` });
        }
      }
      try {
        const session = await sshManager.connect(row, { source: 'mcp' });
        sessionStates.set(session.id, { cwd: null });
        return text({ ok: true, sessionId: session.id, hostName: row.name, host: row.host });
      } catch (err) {
        return text({ error: `连接失败: ${(err as Error).message}` });
      }
    },
  );

  server.tool(
    'ssh_exec',
    '在远程主机执行命令并返回 stdout/stderr/退出码。未指定 session 时自动新建一次性连接（同样需要审批）。指定 session 时复用连接与记忆的工作目录。超时或输出超限会被截断',
    {
      host: z.string().optional().describe('主机 ID 或名称（session 未指定时必填）'),
      session: z.string().optional().describe('ssh_connect 返回的会话 ID'),
      command: z.string().describe('要执行的命令'),
      cwd: z.string().optional().describe('工作目录；指定后会被会话记住'),
      env: z.record(z.string(), z.string()).optional().describe('附加环境变量'),
      timeout: z.number().int().positive().max(3600).optional().describe('超时秒数，默认 30s'),
      async: z.boolean().optional().describe('后台执行：立即返回 jobId，用 ssh_job_status 轮询结果'),
    },
    async (params) => {
      const { session, error, ephemeral } = await acquireSession(params.host, params.session);
      if (error || !session) return text({ error });

      const timeoutMs = (params.timeout ?? config.mcpDefaultTimeoutMs / 1000) * 1000;
      // 危险命令规则检查（block 拒绝 / approve 弹窗）
      const ruleCheck = await checkCommandRule(params.command, session);
      if (ruleCheck.error) return text({ error: ruleCheck.error });
      const run = async (): Promise<unknown> => {
        eventBus.broadcast({
          type: 'exec:activity',
          sessionId: session.id,
          kind: 'begin',
          command: params.command,
        });
        const res = await execCommand(session, params.command, {
          cwd: params.cwd,
          env: params.env,
          timeoutMs,
        });
        logAudit(db, 'mcp', session.hostId, session.hostName, params.command, res.exitCode, res.durationMs);
        return res;
      };

      if (params.async) {
        const jobId = crypto.randomUUID();
        jobs.set(jobId, { status: 'running' });
        run().then(
          (result) => {
            jobs.set(jobId, { status: 'done', result });
            if (ephemeral) sshManager.disconnect(session.id);
          },
          (err: Error) => {
            jobs.set(jobId, { status: 'done', result: { error: err.message } });
            if (ephemeral) sshManager.disconnect(session.id);
          },
        );
        if (jobs.size > JOB_RETENTION) {
          const oldest = jobs.keys().next().value;
          if (oldest) jobs.delete(oldest);
        }
        return text({ ok: true, jobId, message: '命令已在后台执行，用 ssh_job_status 查询' });
      }

      const result = await run();
      // 一次性会话（未传 session 新建的）用完即断，避免连接堆积
      if (ephemeral) sshManager.disconnect(session.id);
      return text({ ok: true, ...(result as object) });
    },
  );

  server.tool(
    'ssh_read_file',
    '读取远程文件内容（文本）。大文件可用 maxBytes 限制读取量',
    {
      host: z.string().optional(),
      session: z.string().optional(),
      path: z.string().describe('远程文件绝对路径'),
      maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional().describe('最大读取字节数，默认 1MB'),
    },
    async (params) => {
      const { session, error, ephemeral } = await acquireSession(params.host, params.session);
      if (error || !session) return text({ error });
      try {
        const sftp = await getSftp(session);
        const maxBytes = params.maxBytes ?? 1024 * 1024;
        const { promise, resolve, reject } = Promise.withResolvers<string>();
        sftp.readFile(params.path, { encoding: 'utf8' }, (err, data) => (err ? reject(err) : resolve(String(data))));
        const content = await promise;
        const truncated = content.length > maxBytes;
        return text({
          ok: true,
          path: params.path,
          truncated,
          byteLength: Buffer.byteLength(content),
          content: truncated ? content.slice(0, maxBytes) : content,
        });
      } catch (err) {
        return text({ error: `读取失败: ${(err as Error).message}` });
      } finally {
        if (ephemeral) sshManager.disconnect(session.id);
      }
    },
  );

  server.tool(
    'ssh_write_file',
    '写入远程文件。默认覆盖，可追加。内容为文本字符串',
    {
      host: z.string().optional(),
      session: z.string().optional(),
      path: z.string().describe('远程文件绝对路径'),
      content: z.string().describe('文件内容'),
      mode: z.enum(['overwrite', 'append']).optional().describe('写入模式，默认 overwrite'),
    },
    async (params) => {
      const { session, error, ephemeral } = await acquireSession(params.host, params.session);
      if (error || !session) return text({ error });
      try {
        const sftp = await getSftp(session);
        if (params.mode === 'append') {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          sftp.appendFile(params.path, params.content, (err) => (err ? reject(err) : resolve()));
          await promise;
        } else {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          sftp.writeFile(params.path, params.content, (err) => (err ? reject(err) : resolve()));
          await promise;
        }
        return text({ ok: true, path: params.path, mode: params.mode ?? 'overwrite' });
      } catch (err) {
        return text({ error: `写入失败: ${(err as Error).message}` });
      } finally {
        if (ephemeral) sshManager.disconnect(session.id);
      }
    },
  );

  server.tool(
    'ssh_list_dir',
    '列出远程目录内容（名称/类型/大小/修改时间）',
    {
      host: z.string().optional(),
      session: z.string().optional(),
      path: z.string().describe('远程目录绝对路径'),
    },
    async (params) => {
      const { session, error, ephemeral } = await acquireSession(params.host, params.session);
      if (error || !session) return text({ error });
      try {
        const sftp = await getSftp(session);
        const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
        sftp.readdir(params.path, (err, list) => (err ? reject(err) : resolve(list)));
        const entries = await promise;
        const items = entries.map((e) => {
          const mode = e.attrs.mode ?? 0;
          const type = (mode & 0o170000) === 0o040000 ? 'dir' : (mode & 0o170000) === 0o120000 ? 'link' : 'file';
          return {
            name: e.filename,
            type,
            size: e.attrs.size ?? 0,
            mtime: e.attrs.mtime ? new Date(e.attrs.mtime * 1000).toISOString() : null,
          };
        });
        return text({ ok: true, path: params.path, items });
      } catch (err) {
        return text({ error: `列目录失败: ${(err as Error).message}` });
      } finally {
        if (ephemeral) sshManager.disconnect(session.id);
      }
    },
  );

  server.tool(
    'ssh_stat',
    '查看远程文件或目录的元信息',
    {
      host: z.string().optional(),
      session: z.string().optional(),
      path: z.string().describe('远程路径'),
    },
    async (params) => {
      const { session, error, ephemeral } = await acquireSession(params.host, params.session);
      if (error || !session) return text({ error });
      try {
        const sftp = await getSftp(session);
        const { promise, resolve, reject } = Promise.withResolvers<Stats>();
        sftp.stat(params.path, (err, stats) => (err ? reject(err) : resolve(stats)));
        const st = await promise;
        const mode = st.mode ?? 0;
        return text({
          ok: true,
          path: params.path,
          type: (mode & 0o170000) === 0o040000 ? 'dir' : (mode & 0o170000) === 0o120000 ? 'link' : 'file',
          size: st.size ?? 0,
          mode: (mode & 0o7777).toString(8),
          uid: st.uid,
          gid: st.gid,
          mtime: st.mtime ? new Date(st.mtime * 1000).toISOString() : null,
        });
      } catch (err) {
        return text({ error: `stat 失败: ${(err as Error).message}` });
      } finally {
        if (ephemeral) sshManager.disconnect(session.id);
      }
    },
  );

  server.tool(
    'ssh_session_info',
    '列出所有活跃的 MCP SSH 会话（会话 ID、主机、地址、工作目录、最后使用时间）；优先复用现有会话避免重复建连',
    {},
    async () => {
      const list = sshManager
        .list()
        .filter((s) => s.source === 'mcp')
        .map((s) => ({
          sessionId: s.id,
          hostName: s.hostName,
          host: s.host,
          port: s.port,
          cwd: sessionStates.get(s.id)?.cwd ?? null,
          createdAt: new Date(s.createdAt).toISOString(),
          lastUsedAt: new Date(s.lastUsedAt).toISOString(),
        }));
      return text(list);
    },
  );

  server.tool(
    'ssh_disconnect',
    '断开指定 SSH 会话，释放连接',
    { session: z.string().describe('要断开的会话 ID') },
    async ({ session: sessionId }) => {
      const s = sshManager.get(sessionId);
      if (!s) return text({ error: `会话不存在: ${sessionId}` });
      sshManager.disconnect(sessionId);
      sessionStates.delete(sessionId);
      sftpCache.delete(sessionId);
      return text({ ok: true, sessionId });
    },
  );

  server.tool(
    'ssh_job_status',
    '查询 ssh_exec 后台任务（async=true）的执行结果',
    { jobId: z.string().describe('ssh_exec 返回的 jobId') },
    async ({ jobId }) => {
      const job = jobs.get(jobId);
      if (!job) return text({ error: `任务不存在或已过期: ${jobId}` });
      return text(job);
    },
  );

  server.tool(
    'ssh_tail',
    '跟踪远程文件输出：返回文件末尾内容，并开启流式跟踪（tail -f）。用 ssh_tail_poll 增量拉取新输出，ssh_tail_stop 停止。适合监控日志',
    {
      session: z.string().describe('会话 ID'),
      path: z.string().describe('远程文件路径'),
      lines: z.number().int().positive().max(500).optional().describe('初始返回末尾行数，默认 50'),
    },
    async (params) => {
      const s = sshManager.get(params.session);
      if (!s) return text({ error: `会话不存在: ${params.session}` });
      const lines = params.lines ?? 50;
      // 1. 同步返回末尾内容
      const head = await execCommand(s, `tail -n ${lines} -- ${shellQuote(params.path)}`, {
        timeoutMs: 10000,
      });
      if (head.exitCode !== 0) {
        return text({ error: `读取失败: ${head.stderr || head.stdout || 'exit ' + head.exitCode}` });
      }
      // 2. 后台 tail -f 持续跟踪
      const jobId = `tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const job: StreamJob = { status: 'running', chunks: [], next: 0, channel: null };
      streamJobs.set(jobId, job);
      s.client.exec(`tail -f -n 0 -- ${shellQuote(params.path)}`, (err, channel) => {
        if (err) {
          job.status = 'done';
          return;
        }
        job.channel = channel;
        channel.on('data', (d: Buffer) => {
          job.chunks.push({ i: job.next++, data: d.toString('utf8') });
          if (job.chunks.length > 200) job.chunks.shift();
        });
        channel.on('close', () => {
          job.status = 'done';
          job.channel = null;
        });
        channel.on('error', () => channel.close());
      });
      return text({ ok: true, jobId, content: head.stdout, exitCode: head.exitCode });
    },
  );

  server.tool(
    'ssh_tail_poll',
    '增量拉取 ssh_tail 的新输出（from 之后的片段）',
    {
      jobId: z.string(),
      from: z.number().int().nonnegative().describe('上次拉取到的片段序号，初始用 ssh_tail 返回的 0'),
    },
    async ({ jobId, from }) => {
      const job = streamJobs.get(jobId);
      if (!job) return text({ error: `任务不存在或已过期: ${jobId}` });
      const chunks = job.chunks.filter((c) => c.i >= from);
      return text({ status: job.status, next: job.next, data: chunks.map((c) => c.data).join('') });
    },
  );

  server.tool(
    'ssh_tail_stop',
    '停止 ssh_tail 的流式跟踪',
    { jobId: z.string() },
    async ({ jobId }) => {
      const job = streamJobs.get(jobId);
      if (!job) return text({ error: `任务不存在: ${jobId}` });
      if (job.channel) {
        try {
          job.channel.close();
        } catch {
          // 已关闭
        }
      }
      job.status = 'done';
      streamJobs.delete(jobId);
      return text({ ok: true, jobId });
    },
  );

  server.tool(
    'ssh_port_forward',
    '远程端口转发：把目标主机端口暴露到服务器端口（经 SSH 隧道）。服务器上的其他进程/agent 可通过 127.0.0.1:bindPort 访问',
    {
      session: z.string(),
      remoteHost: z.string().describe('目标地址（远端可达即可）'),
      remotePort: z.number().int().min(1).max(65535),
      bindPort: z.number().int().min(1).max(65535).describe('服务器上绑定的端口'),
    },
    async (params) => {
      const s = sshManager.get(params.session);
      if (!s) return text({ error: `会话不存在: ${params.session}` });
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        s.client.forwardIn('127.0.0.1', params.bindPort, (err) => (err ? reject(err) : resolve()));
        await promise;
      } catch (err) {
        return text({ error: `绑定端口 ${params.bindPort} 失败: ${(err as Error).message}` });
      }
      const rec: ForwardRec = {
        id: `fwd-${Date.now()}-${forwardSeq++}`,
        sessionId: s.id,
        hostName: s.hostName,
        bindPort: params.bindPort,
        remoteHost: params.remoteHost,
        remotePort: params.remotePort,
      };
      s.client.on('tcp connection', (_info, accept, reject) => {
        s.client.forwardOut('127.0.0.1', 0, rec.remoteHost, rec.remotePort, (err, stream) => {
          if (err) return reject();
          const conn = accept();
          conn.pipe(stream).pipe(conn);
          conn.on('error', () => stream.destroy());
          stream.on('error', () => conn.destroy());
        });
      });
      s.client.on('close', () => {
        mcpForwards.delete(rec.id);
      });
      mcpForwards.set(rec.id, rec);
      return text({ ok: true, forwardId: rec.id, bindPort: rec.bindPort, access: `127.0.0.1:${rec.bindPort}` });
    },
  );

  server.tool(
    'ssh_list_forwards',
    '列出所有活跃的 MCP 端口转发',
    {},
    async () => {
      return text(
        [...mcpForwards.values()].map((f) => ({
          forwardId: f.id,
          hostName: f.hostName,
          bindPort: f.bindPort,
          remoteHost: f.remoteHost,
          remotePort: f.remotePort,
        })),
      );
    },
  );

  server.tool(
    'ssh_stop_forward',
    '停止端口转发（会话断开也会自动停止）',
    { forwardId: z.string() },
    async ({ forwardId }) => {
      const rec = mcpForwards.get(forwardId);
      if (!rec) return text({ error: `转发不存在: ${forwardId}` });
      const s = sshManager.get(rec.sessionId);
      if (s) {
        try {
          s.client.unforwardIn('127.0.0.1', rec.bindPort);
        } catch {
          // 忽略
        }
      }
      mcpForwards.delete(forwardId);
      return text({ ok: true, forwardId });
    },
  );
}
