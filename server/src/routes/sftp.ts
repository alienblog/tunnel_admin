import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { PassThrough, Readable } from 'node:stream';
import type { Stats } from 'ssh2';
import type { Config } from '../config.js';
import { requireAuth } from './auth.js';
import type { SftpSessionCache } from './sftpSession.js';

export interface SftpItem {
  name: string;
  type: 'dir' | 'file' | 'link' | 'unknown';
  size: number;
  mtime: string | null;
  mode: string;
}

/** SFTP 并发读块大小 / 并发数：ssh2 顺序读每 32KB 一个 SSH 往返（大 RTT/慢设备下
 *  吞吐 = 32KB/RTT）；并发滑窗 4×256KB 实测本机吞吐 ~7 倍，远程/内网提升更大 */
const SFTP_CHUNK = 256 * 1024;
const SFTP_CONCURRENCY = 4;

/**
 * 并发 SFTP 读流：滑窗保持多个 in-flight read（不同 offset），掩盖 SSH 往返延迟。
 * 替代 sftp.createReadStream（顺序读）。背压由 Readable 缓冲 + inFlight 上限控制。
 */
function createConcurrentReadStream(
  sftp: import('ssh2').SFTPWrapper,
  path: string,
): NodeJS.ReadableStream {
  const stream = new Readable({
    highWaterMark: SFTP_CHUNK * SFTP_CONCURRENCY,
    read: () => pump(),
  });
  let fd: Buffer | null = null;
  let size = 0;
  let pos = 0;
  let inFlight = 0;
  let finished = false;
  let failed = false;
  const pump = (): void => {
    if (failed || finished || fd === null) return;
    while (inFlight < SFTP_CONCURRENCY && pos < size) {
      const p = pos;
      const len = Math.min(SFTP_CHUNK, size - p);
      pos += len;
      inFlight++;
      const buf = Buffer.allocUnsafe(len);
      sftp.read(fd, buf, 0, len, p, (err, bytesRead) => {
        inFlight--;
        if (failed) return;
        if (err) {
          failed = true;
          stream.destroy(err as Error);
          return;
        }
        if (bytesRead > 0) stream.push(buf.subarray(0, bytesRead));
        if (pos >= size && inFlight === 0) {
          finished = true;
          stream.push(null);
          sftp.close(fd as Buffer, () => {});
        } else if (!failed) {
          pump();
        }
      });
    }
  };
  sftp.open(path, 'r', (err, f) => {
    if (err) {
      failed = true;
      stream.destroy(err as Error);
      return;
    }
    fd = f;
    sftp.fstat(f, (e, st) => {
      if (e) {
        failed = true;
        stream.destroy(e as Error);
        return;
      }
      size = st.size ?? 0;
      pump();
    });
  });
  return stream;
}

/**
 * Web SFTP：使用共享会话缓存（按 hostId，10 分钟空闲回收），
 * 下载/上传均走流式管道，避免大文件占内存。
 */
export function registerSftp(
  app: FastifyInstance,
  config: Config,
  db: Database.Database,
  sessions: SftpSessionCache,
): void {
  async function getSftp(hostId: number): Promise<{ handle?: import('./sftpSession.js').SftpHandle; error?: string }> {
    return sessions.get(hostId);
  }

  /** 递归删除（recursive=true 时目录整棵删除，文件直接 unlink） */
  async function rmPathRecursive(sftp: import('ssh2').SFTPWrapper, path: string, recursive: boolean): Promise<void> {
    const rmDir = async (dir: string): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
      sftp.readdir(dir, (e, list) => (e ? reject(e) : resolve(list)));
      const entries = await promise;
      for (const e of entries) {
        const child = dir.replace(/\/+$/, '') + '/' + e.filename;
        if ((e.attrs.mode ?? 0) & 0o40000) {
          await rmDir(child);
        } else {
          const { promise: up, resolve: ur, reject: uj } = Promise.withResolvers<void>();
          sftp.unlink(child, (e) => (e ? uj(e) : ur()));
          await up;
        }
      }
      const { promise: rp, resolve: rr, reject: rj } = Promise.withResolvers<void>();
      sftp.rmdir(dir, (e) => (e ? rj(e) : rr()));
      await rp;
    };
    if (recursive) {
      // 先判断类型：目录递归删除，文件直接 unlink（readdir 文件会报错）
      const { promise: sp, resolve: sr, reject: sj } = Promise.withResolvers<Stats | null>();
      sftp.stat(path, (e, st) => (e ? sr(null) : sr(st)));
      const st = await sp;
      if (st && ((st.mode ?? 0) & 0o170000) === 0o040000) {
        await rmDir(path);
      } else {
        const { promise: pp, resolve: pr, reject: pj } = Promise.withResolvers<void>();
        sftp.unlink(path, (e) => (e ? pj(e) : pr()));
        await pp;
      }
    } else {
      const { promise: pp, resolve: pr, reject: pj } = Promise.withResolvers<void>();
      sftp.unlink(path, (e) => (e ? pj(e) : pr()));
      await pp;
    }
  }

  function formatItem(name: string, attrs: Stats): SftpItem {
    const mode = attrs.mode ?? 0;
    const type = (mode & 0o170000) === 0o040000 ? 'dir' : (mode & 0o170000) === 0o120000 ? 'link' : 'file';
    return {
      name,
      type,
      size: attrs.size ?? 0,
      mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
      mode: (mode & 0o7777).toString(8),
    };
  }

  function parseQuery(req: FastifyRequest): { hostId: number; path: string } {
    const q = req.query as { hostId?: string; path?: string };
    return { hostId: Number(q.hostId), path: q.path ?? '.' };
  }

  /** 当前用户的 home 目录（SFTP 默认 cwd） */
  app.get('/api/sftp/home', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const hostId = Number((req.query as { hostId?: string }).hostId);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      handle.sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p)));
      const home = await promise;
      return { home };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sftp/ls', async (req, reply) => {    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
      handle.sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)));
      const entries = await promise;
      const items = entries.map((e) => formatItem(e.filename, e.attrs)).sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      return { ok: true, path, items };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/sftp/download', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    const name = path.split('/').pop() || 'download';
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    // 并发读（滑窗 4×256KB），替代顺序 createReadStream（每 32KB 一个 SSH 往返）
    const stream = createConcurrentReadStream(handle.sftp, path);
    stream.on('error', () => reply.code(400).send({ error: '读取文件失败' }));
    return reply.send(stream);
  });

  // 上传：octet-stream 流式解析（parser 不缓冲，payload 为原始 req 流，
  // 服务端边收边写 SFTP；进度即真实转发进度）。bodyLimit 0 不限制大小。
  app.addContentTypeParser('application/octet-stream', { bodyLimit: 2 * 1024 * 1024 * 1024 }, (_req, payload, done) => done(null, payload));
  app.post('/api/sftp/upload', { bodyLimit: 2 * 1024 * 1024 * 1024 }, async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const body = req.body as unknown;
      if (body instanceof Readable || (body && typeof (body as NodeJS.ReadableStream).pipe === 'function')) {
        // 流式：边收边写（256KB 写块，减少 SSH 往返）
        const out = handle.sftp.createWriteStream(path, { highWaterMark: SFTP_CHUNK });
        (body as NodeJS.ReadableStream).pipe(out);
        (body as NodeJS.ReadableStream).on('error', (e: Error) => reject(e));
        out.on('close', () => resolve());
        out.on('error', (e: Error) => reject(e));
      } else if (Buffer.isBuffer(body)) {
        // 兜底：Buffer 直接写
        const out = handle.sftp.createWriteStream(path, { highWaterMark: SFTP_CHUNK });
        out.end(body);
        out.on('close', () => resolve());
        out.on('error', (e: Error) => reject(e));
      }
      await promise;
      return { ok: true, path };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sftp/mkdir', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; path: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.mkdir(body.path, (err) => (err ? reject(err) : resolve()));
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sftp/rename', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; from: string; to: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.rename(body.from, body.to, (err) => (err ? reject(err) : resolve()));
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/sftp/rm', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const q = req.query as { hostId?: string; path?: string; recursive?: string };
    const { handle, error } = await getSftp(Number(q.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      await rmPathRecursive(handle.sftp, q.path ?? '', q.recursive === '1');
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 新建空文件（open 'w' 创建/截断后关闭） */
  app.post('/api/sftp/touch', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; path: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.open(body.path, 'w', (err, fd) => {
        if (err) return reject(err);
        handle.sftp.close(fd, (e) => (e ? reject(e) : resolve()));
      });
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 流式复制（文件管道 / 目录递归，目录已存在则合并） */
  async function copyPath(
    sftp: import('ssh2').SFTPWrapper,
    from: string,
    to: string,
    isDir: boolean,
    size = 0,
  ): Promise<void> {
    if (isDir) {
      const { promise: mp, resolve: mr, reject: mj } = Promise.withResolvers<void>();
      sftp.mkdir(to, (e) => {
        if (!e) return mr();
        // OpenSSH 对已存在目录返回 SSH_FX_FAILURE（"Failure"），EEXIST 亦可能：确认目标是目录则继续
        sftp.stat(to, (e2, st) => {
          if (!e2 && ((st.mode ?? 0) & 0o170000) === 0o040000) return mr();
          mj(e);
        });
      });
      await mp;
      const { promise, resolve, reject } = Promise.withResolvers<Array<{ filename: string; attrs: Stats }>>();
      sftp.readdir(from, (e, list) => (e ? reject(e) : resolve(list)));
      const entries = await promise;
      for (const e of entries) {
        const childIsDir = ((e.attrs.mode ?? 0) & 0o170000) === 0o040000;
        await copyPath(sftp, from + '/' + e.filename, to + '/' + e.filename, childIsDir, e.attrs.size ?? 0);
      }
    } else if (size === 0) {
      // ssh2 WriteStream 惰性打开：0 字节不创建文件——显式 open('w')+close
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      sftp.open(to, 'w', (e, fd) => {
        if (e) return reject(e);
        sftp.close(fd, (e2) => (e2 ? reject(e2) : resolve()));
      });
      await promise;
    } else {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const rs = sftp.createReadStream(from);
      const ws = sftp.createWriteStream(to);
      rs.pipe(ws);
      ws.on('close', resolve);
      ws.on('error', reject);
      rs.on('error', reject);
      await promise;
    }
  }

  /** 复制：文件或目录（递归） */
  app.post('/api/sftp/copy', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; from: string; to: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<Stats>();
      handle.sftp.stat(body.from, (e, s) => (e ? reject(e) : resolve(s)));
      const st = await promise;
      await copyPath(handle.sftp, body.from, body.to, ((st.mode ?? 0) & 0o170000) === 0o040000, st.size ?? 0);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 移动：优先 rename；跨设备（EXDEV）回退复制+删除 */
  app.post('/api/sftp/move', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; from: string; to: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      try {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        handle.sftp.rename(body.from, body.to, (e) => (e ? reject(e) : resolve()));
        await promise;
      } catch (err) {
        const msg = (err as Error).message;
        // 目标已存在（OpenSSH rename 不覆盖）：先删除目标再重试
        const { promise: sp, resolve: sr, reject: sj } = Promise.withResolvers<Stats | null>();
        handle.sftp.stat(body.to, (e, s) => (e ? sr(null) : sr(s)));
        const target = await sp;
        if (target) {
          await rmPathRecursive(handle.sftp, body.to, true);
          const { promise: rp2, resolve: rr2, reject: rj2 } = Promise.withResolvers<void>();
          handle.sftp.rename(body.from, body.to, (e) => (e ? rj2(e) : rr2()));
          await rp2;
        } else if (/cross-device|EXDEV|unsupported/i.test(msg)) {
          // 跨设备：复制+删除源
          const { promise, resolve, reject } = Promise.withResolvers<Stats>();
          handle.sftp.stat(body.from, (e, s) => (e ? reject(e) : resolve(s)));
          const st = await promise;
          await copyPath(handle.sftp, body.from, body.to, ((st.mode ?? 0) & 0o170000) === 0o040000, st.size ?? 0);
          await rmPathRecursive(handle.sftp, body.from, true);
        } else {
          throw err;
        }
      }
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 修改权限（mode 为八进制字符串，如 755） */
  app.post('/api/sftp/chmod', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; path: string; mode: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      handle.sftp.setstat(body.path, { mode: parseInt(body.mode, 8) }, (e) => (e ? reject(e) : resolve()));
      await promise;
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 写文件（编辑器保存）：整体覆盖写入 */
  app.post('/api/sftp/write', { bodyLimit: 64 * 1024 * 1024 }, async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const body = req.body as { hostId: number; path: string; content: string };
    const { handle, error } = await getSftp(Number(body.hostId));
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const data = Buffer.from(body.content ?? '', 'utf8');
      const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
      handle.sftp.open(body.path, 'w', (e, fd) => (e ? reject(e) : resolve(fd)));
      const fd = await promise;
      try {
        const { promise: wp, resolve: wr, reject: wj } = Promise.withResolvers<void>();
        handle.sftp.write(fd, data, 0, data.length, 0, (e) => (e ? wj(e) : wr()));
        await wp;
        return { ok: true };
      } finally {
        const { promise: cp, resolve: cr, reject: cj } = Promise.withResolvers<void>();
        handle.sftp.close(fd, (e) => (e ? cj(e) : cr()));
        await cp;
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 文本预览：读前 maxBytes（默认 64KB），二进制（含 NUL）时提示 */
  app.get('/api/sftp/read', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const q = req.query as { hostId?: string; path?: string; maxBytes?: string };
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    try {
      const MAX = 64 * 1024;
      const want = Math.min(Number(q.maxBytes) || MAX, 64 * 1024 * 1024);
      const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
      handle.sftp.open(path, 'r', (e, fd) => (e ? reject(e) : resolve(fd)));
      const fd = await promise;
      try {
        const buf = Buffer.alloc(want);
        const { promise: rp, resolve: rr, reject: rj } = Promise.withResolvers<number>();
        handle.sftp.read(fd, buf, 0, want, 0, (e, n) => (e ? rj(e) : rr(n)));
        const n = await rp;
        const binary = buf.subarray(0, n).includes(0);
        return {
          ok: true,
          content: binary ? '' : buf.toString('utf8', 0, n),
          binary,
          truncated: n >= want,
        };
      } finally {
        const { promise: cp, resolve: cr, reject: cj } = Promise.withResolvers<void>();
        handle.sftp.close(fd, (e) => (e ? cj(e) : cr()));
        await cp;
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /** 目录打包下载：tar 流式打包（不依赖远程 tar 命令，支持中文名，带 backpressure） */
  app.get('/api/sftp/archive', async (req, reply) => {
    if (!requireAuth(req, reply, config)) return;
    const { hostId, path } = parseQuery(req);
    const { handle, error } = await getSftp(hostId);
    if (error || !handle) return reply.code(400).send({ error: error ?? '无法建立 SFTP 连接' });
    const name = path.split('/').pop() || 'archive';
    try {
      const { promise, resolve, reject } = Promise.withResolvers<Stats>();
      handle.sftp.stat(path, (e, s) => (e ? reject(e) : resolve(s)));
      const st = await promise;
      if (((st.mode ?? 0) & 0o170000) !== 0o040000) {
        return reply.code(400).send({ error: '仅支持目录打包' });
      }

      // ustar 头部（entryName 为 tar 内条目相对路径）
      function tarHeader(entryName: string, size: number, type: '0' | '5', mtimeSec: number): Buffer {
        const buf = Buffer.alloc(512);
        const nb = Buffer.from(entryName, 'utf8');
        nb.copy(buf, 0, 0, Math.min(nb.length, 100));
        buf.write('0000644\0', 100, 8, 'ascii');
        buf.write('0000000\0', 108, 8, 'ascii');
        buf.write('0000000\0', 116, 8, 'ascii');
        buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
        buf.write(Math.floor(mtimeSec).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
        buf.fill(0x20, 148, 156); // checksum 占位（空格）
        buf.write(type, 156, 1, 'ascii');
        buf.write('ustar\0', 257, 6, 'ascii');
        buf.write('00', 263, 2, 'ascii');
        let sum = 0;
        for (const b of buf) sum += b;
        buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        return buf;
      }

      const through = new PassThrough();
      reply.header('content-disposition', `attachment; filename="${encodeURIComponent(name)}.tar"`);
      reply.type('application/x-tar');
      const sf = handle.sftp;

      const pushBuffer = (buf: Buffer): Promise<void> =>
        new Promise((resolve) => {
          if (through.write(buf)) resolve();
          else through.once('drain', resolve);
        });

      void (async () => {
        try {
          const readDir = (dir: string): Promise<Array<{ filename: string; attrs: Stats }>> =>
            new Promise((resolve, reject) => {
              sf.readdir(dir, (e, list) => (e ? reject(e) : resolve(list)));
            });
          const packDir = async (dir: string, tarBase: string): Promise<void> => {
            const entries = await readDir(dir);
            if (tarBase) await pushBuffer(tarHeader(tarBase + '/', 0, '5', 0));
            for (const e of entries) {
              const full = dir.replace(/\/+$/, '') + '/' + e.filename;
              const childIsDir = ((e.attrs.mode ?? 0) & 0o170000) === 0o040000;
              const entryName = tarBase ? tarBase + '/' + e.filename : e.filename;
              if (childIsDir) {
                await packDir(full, entryName);
              } else {
                const size = e.attrs.size ?? 0;
                await pushBuffer(tarHeader(entryName, size, '0', e.attrs.mtime ?? 0));
                const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
                sf.open(full, 'r', (e2, fd) => (e2 ? reject(e2) : resolve(fd)));
                const fd = await promise;
                try {
                  const buf = Buffer.alloc(64 * 1024);
                  let offset = 0;
                  while (offset < size) {
                    const want = Math.min(buf.length, size - offset);
                    const { promise: rp, resolve: rr, reject: rj } = Promise.withResolvers<number>();
                    sf.read(fd, buf, 0, want, offset, (e2, n) => (e2 ? rj(e2) : rr(n)));
                    const n = await rp;
                    if (n <= 0) break;
                    await pushBuffer(Buffer.from(buf.subarray(0, n)));
                    offset += n;
                  }
                } finally {
                  const { promise: cp, resolve: cr, reject: cj } = Promise.withResolvers<void>();
                  sf.close(fd, (e2) => (e2 ? cj(e2) : cr()));
                  await cp;
                }
                const pad = (512 - (size % 512)) % 512;
                if (pad) await pushBuffer(Buffer.alloc(pad));
              }
            }
          };
          await packDir(path, name);
          await pushBuffer(Buffer.alloc(1024)); // 结束块
          through.end();
        } catch (err) {
          through.destroy(new Error((err as Error).message));
        }
      })();
      return reply.send(through);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
