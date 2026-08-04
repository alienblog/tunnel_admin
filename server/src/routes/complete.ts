import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { SshSession } from '../ssh/manager.js';
import { requireAuth } from './auth.js';
import type { SftpSessionCache } from './sftpSession.js';

/**
 * 命令/路径自动补全：远程 compgen 取数据，前端渲染。
 * - cmd：compgen -c 命令表（主机维度缓存 5 分钟）
 * - path：cd cwd && compgen -f/-d 实时查询
 * - svc：systemctl list-unit-files 服务名（主机维度缓存 5 分钟）
 * 非 bash 环境自动降级（PATH 扫描 / ls 通配）。
 */

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function execCapture(session: SshSession, cmd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  const { promise, resolve } = Promise.withResolvers<{ stdout: string; stderr: string; code: number }>();
  session.client.exec(cmd, (err, channel) => {
    if (err) {
      resolve({ stdout: '', stderr: err.message, code: -1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      channel.close();
      resolve({ stdout, stderr, code: -1 });
    }, timeoutMs);
    channel.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    channel.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    channel.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    channel.on('error', () => channel.close());
  });
  return promise;
}

export interface CompleteItem {
  text: string;
  type: 'cmd' | 'file' | 'dir' | 'svc';
}

const CMD_CACHE_TTL = 5 * 60 * 1000;

export function registerComplete(app: FastifyInstance, config: Config, sessions: SftpSessionCache): void {
  const cmdCacheMap = new Map<number, { list: string[]; ts: number }>();
  const svcCacheMap = new Map<number, { list: string[]; ts: number }>();
  const homeCache = new Map<number, string>();

  async function getHome(hostId: number, session: SshSession): Promise<string> {
    const cached = homeCache.get(hostId);
    if (cached) return cached;
    const r = await execCapture(session, 'echo $HOME', 3000);
    const home = r.stdout.trim() || '~';
    homeCache.set(hostId, home);
    return home;
  }

  app.get('/api/complete', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const q = req.query as { hostId?: string; kind?: string; prefix?: string; cwd?: string };
    const hostId = Number(q.hostId);
    const kind = q.kind === 'cmd' ? 'cmd' : q.kind === 'svc' ? 'svc' : 'path';
    const prefix = q.prefix ?? '';
    const cwd = q.cwd && q.cwd !== '' ? q.cwd : '~';
    if (!Number.isInteger(hostId) || hostId <= 0) return reply.code(400).send({ error: 'hostId 无效' });
    const { handle, error } = await sessions.get(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立连接' });

    try {
      if (kind === 'cmd') {
        // 命令表：compgen -c 全量 + ~/.bash_history 常用优先（缓存）
        let cached = cmdCacheMap.get(hostId);
        if (!cached || Date.now() - cached.ts > CMD_CACHE_TTL) {
          const r = await execCapture(
            handle.session,
            'compgen -c 2>/dev/null | sort -u; echo __H__; cat ~/.bash_history 2>/dev/null',
            5000,
          );
          const [cmdPart, histPart = ''] = r.stdout.split('__H__');
          const allCmds = new Set(
            cmdPart.split('\n').map((s) => s.trim()).filter(Boolean),
          );
          // history 统计：每行首个词为命令，按出现频率排序（常用优先）
          const histFreq = new Map<string, number>();
          for (const line of histPart.split('\n')) {
            const m = line.trim().match(/^(\S+)/);
            if (m && allCmds.has(m[1])) {
              histFreq.set(m[1], (histFreq.get(m[1]) ?? 0) + 1);
            }
          }
          let list: string[];
          if (allCmds.size > 0) {
            // history 高频在前，全量按字母序补充
            list = [...histFreq.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([c]) => c)
              .concat([...allCmds].filter((c) => !histFreq.has(c)).sort());
          } else {
            // 降级：PATH 目录扫描 + history
            const r2 = await execCapture(
              handle.session,
              'for p in $(echo $PATH | tr ":" " "); do ls $p; done 2>/dev/null | sort -u; echo __H__; cat ~/.bash_history 2>/dev/null',
              5000,
            );
            const [p2, h2 = ''] = r2.stdout.split('__H__');
            const cmds = new Set(p2.split('\n').map((s) => s.trim()).filter(Boolean));
            const freq = new Map<string, number>();
            for (const line of h2.split('\n')) {
              const m = line.trim().match(/^(\S+)/);
              if (m && cmds.has(m[1])) freq.set(m[1], (freq.get(m[1]) ?? 0) + 1);
            }
            list = [...freq.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([c]) => c)
              .concat([...cmds].filter((c) => !freq.has(c)).sort());
          }
          cached = { list, ts: Date.now() };
          cmdCacheMap.set(hostId, cached);
        }
        const items: CompleteItem[] = cached.list
          .filter((c) => c.startsWith(prefix))
          .slice(0, 50)
          .map((text) => ({ text, type: 'cmd' as const }));
        return { items };
      }

      if (kind === 'svc') {
        // systemctl 服务名补全：list-unit-files 取服务单元列表（主机维度缓存 5 分钟）
        let cached = svcCacheMap.get(hostId);
        if (!cached || Date.now() - cached.ts > CMD_CACHE_TTL) {
          const r = await execCapture(
            handle.session,
            'systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null | awk \'{print $1}\'',
            5000,
          );
          const list = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
          cached = { list, ts: Date.now() };
          svcCacheMap.set(hostId, cached);
        }
        const items: CompleteItem[] = cached.list
          .filter((c) => c.startsWith(prefix))
          .slice(0, 50)
          .map((text) => ({ text, type: 'svc' as const }));
        return { items };
      }

      // 路径补全：拆分目录部分与 basename（compgen 按 basename 匹配，目录部分先 cd）
      const home = await getHome(hostId, handle.session);
      const expandTilde = (p: string): string => p.replace(/^~(?:\/|$)/, home + '/');
      const lastSlash = prefix.lastIndexOf('/');
      const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : '';
      const basePart = lastSlash >= 0 ? prefix.slice(lastSlash + 1) : prefix;
      const resolvedCwd = expandTilde(cwd);
      // 目录部分为绝对路径（/ 或 ~ 开头）时直接使用，否则拼到 cwd 后
      const cdTarget =
        dirPart.startsWith('/') || dirPart.startsWith('~')
          ? expandTilde(dirPart)
          : dirPart
            ? `${resolvedCwd.replace(/\/+$/, '')}/${expandTilde(dirPart)}`
            : resolvedCwd;
      const r = await execCapture(
        handle.session,
        `cd ${shellQuote(cdTarget)} 2>/dev/null; echo __F__; compgen -f -- ${shellQuote(basePart)} 2>/dev/null; echo __D__; compgen -d -- ${shellQuote(basePart)} 2>/dev/null`,
        5000,
      );
      let section = '';
      const files = new Set<string>();
      const dirs = new Set<string>();
      for (const line of r.stdout.split('\n')) {
        if (line === '__F__') {
          section = 'F';
          continue;
        }
        if (line === '__D__') {
          section = 'D';
          continue;
        }
        if (!section) continue;
        const t = line.trim();
        if (t === '') continue;
        if (section === 'D') dirs.add(t);
        else files.add(t);
      }

      // 降级：compgen 不存在 → ls 通配（glob 用完整 prefix）
      if (files.size === 0 && dirs.size === 0 && (r.code !== 0 || r.stderr.includes('not found') || r.stderr.includes('command'))) {
        const glob = prefix !== '' ? `${prefix}*` : '';
        const r2 = await execCapture(
          handle.session,
          `cd ${shellQuote(cwd)} 2>/dev/null; ls -dap ${glob !== '' ? shellQuote(glob) : '.??* *'} 2>/dev/null`,
          5000,
        );
        for (const line of r2.stdout.split('\n')) {
          const t = line.trim();
          if (t === '' || t === './' || t === '../') continue;
          if (t.endsWith('/')) dirs.add(t.replace(/\/+$/, ''));
          else files.add(t);
        }
      }

      // 条目拼回目录前缀（前端基于完整 prefix 回填）
      const items: CompleteItem[] = [
        ...[...dirs].map((text) => ({ text: dirPart + text, type: 'dir' as const })),
        ...[...files].filter((f) => !dirs.has(f)).map((text) => ({ text: dirPart + text, type: 'file' as const })),
      ].slice(0, 50);
      return { items };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
