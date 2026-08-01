import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { SshSession } from '../ssh/manager.js';
import { requireAuth } from './auth.js';
import type { SftpSessionCache } from './sftpSession.js';

/**
 * 系统指标采集：复用 SFTP 会话缓存连接，单次 exec 采集 CPU/内存/磁盘/网络。
 * 网络速率通过相邻两次采样的字节差计算。
 */

interface NetSample {
  rx: number;
  tx: number;
  ts: number;
}

const COLLECT_CMD = [
  'echo __C__', // cores
  'nproc',
  'echo __L__', // loadavg
  'cat /proc/loadavg',
  'echo __P__', // cpu (proc stat)
  "grep '^cpu ' /proc/stat",
  'echo __M__', // memory
  "free -b | grep '^Mem:'",
  'echo __D__', // disks
  'df -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs | tail -n +2',
  'echo __N__', // network
  'cat /proc/net/dev',
].join('\n');

function execCollect(session: SshSession, timeoutMs: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  session.client.exec(COLLECT_CMD, (err, channel) => {
    if (err) return reject(err);
    let out = '';
    const timer = setTimeout(() => {
      channel.close();
      reject(new Error('指标采集超时'));
    }, timeoutMs);
    channel.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    channel.stderr.on('data', () => {
      // 忽略 stderr（如 top 的提示）
    });
    channel.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
    channel.on('error', () => channel.close());
  });
  return promise;
}

export function registerMetrics(app: FastifyInstance, config: Config, sessions: SftpSessionCache): void {
  const netPrev = new Map<number, NetSample>();
  const cpuPrev = new Map<number, { total: number; idle: number; ts: number }>();

  app.get('/api/metrics', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const hostId = Number((req.query as { hostId?: string }).hostId);
    if (!Number.isInteger(hostId) || hostId <= 0) return reply.code(400).send({ error: 'hostId 无效' });
    const { handle, error } = await sessions.get(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立连接' });

    let raw: string;
    try {
      raw = await execCollect(handle.session, 5000);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const sections = new Map<string, string>();
    const lines = raw.split('\n');
    let cur = '';
    for (const line of lines) {
      const m = line.match(/^__(C|L|P|M|D|N)__$/);
      if (m) {
        cur = m[1];
        sections.set(cur, '');
      } else if (cur) {
        sections.set(cur, (sections.get(cur) ?? '') + line + '\n');
      }
    }

    // cores
    const cores = parseInt(sections.get('C')?.trim() || '0', 10) || 1;
    // loadavg
    const loadParts = (sections.get('L')?.trim() ?? '').split(/\s+/);
    const load = loadParts.slice(0, 3).map((v) => parseFloat(v) || 0);
    // cpu：/proc/stat 两次采样差值（top 单帧在部分环境不可靠）
    const statParts = (sections.get('P')?.trim() ?? '').split(/\s+/);
    let cpu: number | null = null;
    if (statParts.length >= 5) {
      const vals = statParts.slice(1).map((v) => parseInt(v, 10) || 0);
      const idle = (vals[3] ?? 0) + (vals[4] ?? 0); // idle + iowait
      const total = vals.reduce((a, b) => a + b, 0);
      if (total > 0) {
        const prevCpu = cpuPrev.get(hostId);
        const now = Date.now();
        if (prevCpu && now - prevCpu.ts > 500 && total > prevCpu.total && idle >= prevCpu.idle) {
          const dTotal = total - prevCpu.total;
          const dIdle = idle - prevCpu.idle;
          cpu = Math.max(0, Math.min(100, Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10));
        }
        cpuPrev.set(hostId, { total, idle, ts: now });
      }
    }
    // memory：Mem: total used free shared buff/cache available
    const memLine = sections.get('M')?.trim() ?? '';
    const memParts = memLine.split(/\s+/);
    const memTotal = parseInt(memParts[1] ?? '0', 10) || 0;
    const memAvail = parseInt(memParts[6] ?? '0', 10) || 0;
    // disk：Filesystem 1B-blocks Used Available Use% Mounted
    const disks = (sections.get('D')?.trim() ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const p = line.trim().split(/\s+/);
        if (p.length < 6) return null;
        return {
          mount: p[5],
          total: parseInt(p[1], 10) || 0,
          used: parseInt(p[2], 10) || 0,
        };
      })
      .filter((d): d is { mount: string; total: number; used: number } => d !== null && d.total > 0);
    // network
    let totalRx = 0;
    let totalTx = 0;
    const interfaces: Array<{ name: string; rx: number; tx: number }> = [];
    for (const line of (sections.get('N')?.trim() ?? '').split('\n')) {
      const m = line.trim().match(/^(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
      if (!m) continue;
      const name = m[1];
      if (name === 'lo') continue;
      const rx = parseInt(m[2], 10) || 0;
      const tx = parseInt(m[3], 10) || 0;
      interfaces.push({ name, rx, tx });
      totalRx += rx;
      totalTx += tx;
    }

    // 速率：与上次采样差值
    const now = Date.now();
    const prev = netPrev.get(hostId);
    let rxRate = 0;
    let txRate = 0;
    if (prev && now - prev.ts > 500 && totalRx >= prev.rx && totalTx >= prev.tx) {
      const dt = (now - prev.ts) / 1000;
      rxRate = (totalRx - prev.rx) / dt;
      txRate = (totalTx - prev.tx) / dt;
    }
    netPrev.set(hostId, { rx: totalRx, tx: totalTx, ts: now });

    return {
      ts: now,
      cores,
      load,
      cpu,
      mem: { total: memTotal, used: memTotal - memAvail },
      disks,
      net: { rxRate, txRate, interfaces },
    };
  });
}
