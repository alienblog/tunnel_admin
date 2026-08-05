import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { decryptText, encryptText } from '../crypto.js';
import { requireAuth } from '../routes/auth.js';
import { queueConnect } from './connectQueue.js';
import type { Config } from '../config.js';
import type {
  PluginActivation,
  PluginContext,
  PluginHostDeps,
  PluginInfo,
  PluginManifest,
  PluginModule,
  PluginSource,
  PluginTimer,
} from './types.js';

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const DISABLED_PREFIX = 'plugin_disabled:';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** 插件 iframe 内使用的宿主桥脚本（同源加载，插件页面 <script src> 引入后使用 window.ta） */
const TA_CLIENT_JS = `(function () {
  var pluginId = new URLSearchParams(location.search).get('plugin') || '';
  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData) && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }
    var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
    if (res.status === 401) { window.dispatchEvent(new Event('ta:unauthorized')); throw new Error('未登录'); }
    if (!res.ok) {
      var msg = '请求失败 (' + res.status + ')';
      try { var b = await res.json(); if (b && b.error) msg = b.error; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }
  window.ta = {
    pluginId: pluginId,
    api: api,
    /** SSH 一键连接：token 由插件后端 ctx.ssh.requestConnect 产生；name 用于终端标签 */
    ssh: {
      connect: function (token, name) {
        return new Promise(function (resolve, reject) {
          var id = Math.random().toString(36).slice(2);
          var timer = window.setTimeout(function () {
            window.removeEventListener('message', onMsg);
            reject(new Error('连接请求超时'));
          }, 15000);
          function onMsg(e) {
            var d = e.data;
            if (!d || d.source !== 'ta-plugin' || d.type !== 'ssh-connect-result' || d.id !== id) return;
            window.clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            if (d.ok) resolve(d.tabId);
            else reject(new Error(d.error || '连接失败'));
          }
          window.addEventListener('message', onMsg);
          window.parent.postMessage(
            { source: 'ta-plugin', type: 'ssh-connect', id: id, token: token, name: name || '动态设备' },
            '*'
          );
        });
      }
    }
  };
})();`;

interface LoadedPlugin {
  info: PluginInfo;
  manifest: PluginManifest;
  dir: string;
  webDir: string;
  ctx: PluginContext;
  activation?: PluginActivation;
  disposables: Set<() => void>;
  routes: Map<string, Map<string, (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>>>;
}

export class PluginManager {
  private loaded = new Map<string, LoadedPlugin>();
  private loading = false;
  private deps: PluginHostDeps;
  private config: Config;
  private pluginsDir: string;
  private app?: FastifyInstance;

  constructor(deps: PluginHostDeps, config: Config) {
    this.deps = deps;
    this.config = config;
    this.pluginsDir = path.join(config.dataDir, 'plugins');
    fs.mkdirSync(this.pluginsDir, { recursive: true });
  }

  /* ---------- 宿主侧注册 ---------- */

  registerRoutes(app: FastifyInstance): void {
    this.app = app;

    // 管理 API
    app.get('/api/plugins', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      return { plugins: [...this.loaded.values()].map((p) => p.info) };
    });
    app.post('/api/plugins/install', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const body = (req.body ?? {}) as { filename?: string; contentBase64?: string };
      const filename = body.filename ?? '';
      const contentBase64 = body.contentBase64 ?? '';
      if (!filename.toLowerCase().endsWith('.taplugin') || !contentBase64) {
        return reply.code(400).send({ error: '需要 .taplugin 文件内容（base64）' });
      }
      try {
        const buf = Buffer.from(contentBase64, 'base64');
        if (buf.length === 0 || buf.length > 50 * 1024 * 1024) {
          return reply.code(400).send({ error: '插件包大小不合法' });
        }
        const id = this.extractPackage(buf, filename);
        await this.rescan();
        return { ok: true, id };
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
      }
    });
    app.delete('/api/plugins/:id', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const id = (req.params as { id: string }).id;
      const p = this.loaded.get(id);
      if (!p) return reply.code(404).send({ error: '插件不存在' });
      if (p.info.source !== 'installed') return reply.code(400).send({ error: '开发目录插件不能卸载（移除目录即可）' });
      this.disposePlugin(p);
      this.loaded.delete(id);
      fs.rmSync(p.dir, { recursive: true, force: true });
      return { ok: true };
    });
    app.post('/api/plugins/:id/enable', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const id = (req.params as { id: string }).id;
      if (!this.loaded.has(id)) return reply.code(404).send({ error: '插件不存在' });
      this.setDisabled(id, false);
      await this.rescan();
      return { ok: true };
    });
    app.post('/api/plugins/:id/disable', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const id = (req.params as { id: string }).id;
      if (!this.loaded.has(id)) return reply.code(404).send({ error: '插件不存在' });
      this.setDisabled(id, true);
      await this.rescan();
      return { ok: true };
    });
    app.post('/api/plugins/reload', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      await this.rescan(true);
      return { ok: true };
    });
    app.get('/api/plugins/devdirs', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      return { dirs: this.getDevDirs() };
    });
    app.put('/api/plugins/devdirs', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const body = (req.body ?? {}) as { dirs?: unknown };
      if (!Array.isArray(body.dirs)) return reply.code(400).send({ error: 'dirs 必须是数组' });
      const dirs = body.dirs.filter((d): d is string => typeof d === 'string' && d.length > 0);
      this.setDevDirs(dirs);
      await this.rescan();
      return { ok: true };
    });

    // 插件路由（catch-all 分发，支持运行时 rescan 而不重注册 Fastify 路由）
    app.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      url: '/api/plugins/:id/rpc/*',
      handler: async (req, reply) => {
        if (!requireAuth(req, reply, this.config)) return;
        const id = (req.params as { id: string }).id;
        const wild = (req.params as { '*': string })['*'] ?? '';
        const p = this.loaded.get(id);
        if (!p) return reply.code(404).send({ error: '插件不存在或已禁用' });
        const byPath = p.routes.get(req.method);
        const handler = byPath?.get('/' + wild.replace(/\/+$/, '') || '/');
        if (!handler) return reply.code(404).send({ error: `插件路由不存在: ${req.method} /${wild}` });
        try {
          const r = await handler(req, reply);
          if (!reply.sent) reply.send(r ?? { ok: true });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.log(id, 'error', `路由 ${req.method} /${wild} 出错: ${msg}`);
          if (!reply.sent) reply.code(500).send({ error: msg });
        }
      },
    });

    // 插件静态资源（web/ 目录）
    app.get('/api/plugins/:id/assets/*', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      const id = (req.params as { id: string }).id;
      const wild = (req.params as { '*': string })['*'] ?? '';
      const p = this.loaded.get(id);
      if (!p) return reply.code(404).send({ error: '插件不存在或已禁用' });
      const abs = path.resolve(p.webDir, wild);
      if (!abs.startsWith(p.webDir + path.sep)) return reply.code(400).send({ error: '路径不合法' });
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        return reply.code(404).send({ error: '资源不存在' });
      }
      reply.type(MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream').send(buf);
    });

    // 宿主桥脚本（插件页面 <script src="/api/plugins/ta-client.js">）
    app.get('/api/plugins/ta-client.js', async (req, reply) => {
      if (!requireAuth(req, reply, this.config)) return;
      reply.type('application/javascript; charset=utf-8').send(TA_CLIENT_JS);
    });
  }

  /** 全部卸载（服务关闭时） */
  async disposeAll(): Promise<void> {
    for (const p of [...this.loaded.values()]) this.disposePlugin(p);
    this.loaded.clear();
  }

  /* ---------- 扫描与加载 ---------- */

  async rescan(force = false): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const dirs = new Map<string, { dir: string; source: PluginSource }>();
      // 已安装：pluginsDir 下的每个子目录
      for (const name of fs.readdirSync(this.pluginsDir, { withFileTypes: true })) {
        if (name.isDirectory()) {
          const dir = path.join(this.pluginsDir, name.name);
          if (fs.existsSync(path.join(dir, 'plugin.json'))) dirs.set(name.name, { dir, source: 'installed' });
        }
      }
      // 开发目录：用户配置的本地插件目录（目录本身即插件根）
      for (const d of this.getDevDirs()) {
        if (!d || !fs.existsSync(path.join(d, 'plugin.json'))) continue;
        try {
          const manifest = this.readManifest(d);
          dirs.set(manifest.id, { dir: d, source: 'dev' });
        } catch {
          // 无效 dev 目录：跳过，不打断其他
        }
      }
      // 卸载消失的
      for (const [id, p] of [...this.loaded.entries()]) {
        const next = dirs.get(id);
        if (!next || next.dir !== p.dir) {
          this.disposePlugin(p);
          this.loaded.delete(id);
        }
      }
      // 加载/重载
      for (const [id, { dir, source }] of dirs) {
        const cur = this.loaded.get(id);
        if (cur && cur.dir === dir && !force && cur.info.enabled) {
          // 已加载且未禁用：跳过（错误态保留在 info.error 供查看）
          continue;
        }
        if (cur) this.disposePlugin(cur); // 强制重载：先清理旧实例（定时器/路由/存储句柄）
        const ok = await this.loadPlugin(id, dir, source);
        if (!ok && cur) {
          // 重载失败：保留旧实例（已 dispose，仅保留错误信息展示）
          this.loaded.set(id, cur);
        }
      }
    } finally {
      this.loading = false;
    }
  }

  private async loadPlugin(id: string, dir: string, source: PluginSource): Promise<boolean> {
    let manifest: PluginManifest;
    try {
      manifest = this.readManifest(dir);
      this.validateManifest(manifest, dir);
    } catch (e) {
      this.loaded.set(id, this.errorInfo(id, dir, source, e));
      return false;
    }
    const enabled = !this.isDisabled(id);
    const info: PluginInfo = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? '',
      icon: manifest.icon,
      source,
      dir,
      enabled,
      ui: manifest.ui ?? [],
      activation: manifest.activation ?? 'onStartup',
    };
    if (!enabled) {
      this.loaded.set(id, this.makeLoaded(info, manifest, dir));
      return true;
    }
    try {
      const entry = path.resolve(dir, manifest.entry);
      if (!entry.startsWith(dir + path.sep)) throw new Error('entry 路径越界');
      // query 版本戳：绕过 ESM 模块缓存（插件代码更新后重载立即生效）
      const mod = (await import(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as PluginModule | { default?: PluginModule };
      const pluginMod = (mod as { default?: PluginModule }).default ?? (mod as PluginModule);
      const activate = pluginMod?.activate;
      if (typeof activate !== 'function') throw new Error('插件入口缺少 activate(ctx) 导出');

      const loaded = this.makeLoaded(info, manifest, dir);
      this.loaded.set(id, loaded);
      this.log(id, 'info', '加载中…');
      const activation = await activate(loaded.ctx);
      loaded.activation = (activation ?? undefined) as PluginActivation | undefined;
      this.log(id, 'info', '已激活');
      return true;
    } catch (e) {
      this.log(id, 'error', `激活失败: ${e instanceof Error ? e.message : String(e)}`);
      // 错误态：仍列出，便于管理页查看
      this.loaded.set(id, this.errorInfo(id, dir, source, e, info));
      return false;
    }
  }

  private makeLoaded(info: PluginInfo, manifest: PluginManifest, dir: string): LoadedPlugin {
    const disposables = new Set<() => void>();
    const routes = new Map<string, Map<string, (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>>>();
    const self = this;
    const ctx: PluginContext = {
      id: info.id,
      dir,
      log: {
        info: (m) => self.log(info.id, 'info', m),
        warn: (m) => self.log(info.id, 'warn', m),
        error: (m) => self.log(info.id, 'error', m),
      },
      store: {
        get: (key) => {
          const row = self.deps.db.prepare('SELECT value_enc FROM plugin_kv WHERE plugin_id = ? AND key = ?').get(info.id, key) as
            | { value_enc: string }
            | undefined;
          return row ? decryptText(self.deps.masterKey, row.value_enc) : null;
        },
        set: (key, value) => {
          self.deps.db
            .prepare(
              `INSERT INTO plugin_kv (plugin_id, key, value_enc, updated_at) VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(plugin_id, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = datetime('now')`,
            )
            .run(info.id, key, encryptText(self.deps.masterKey, value));
        },
        del: (key) => {
          self.deps.db.prepare('DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?').run(info.id, key);
        },
      },
      schedule: (intervalMs, fn) => {
        const t = setInterval(() => {
          void Promise.resolve()
            .then(fn)
            .catch((e) => self.log(info.id, 'error', `定时任务出错: ${e instanceof Error ? e.message : String(e)}`));
        }, intervalMs);
        const timer: PluginTimer = { cancel: () => clearInterval(t) };
        disposables.add(() => clearInterval(t));
        return timer;
      },
      registerRoute: (method, routePath, handler) => {
        if (!routePath.startsWith('/')) throw new Error('路由路径必须以 / 开头');
        if (!routes.has(method)) routes.set(method, new Map());
        routes.get(method)!.set(routePath.replace(/\/+$/, '') || '/', handler);
      },
      db: this.deps.db,
      ssh: {
        requestConnect: (info) => {
          if (!info?.host || !info?.username) throw new Error('requestConnect 需要 host/username');
          return { token: queueConnect(info) };
        },
      },
    };
    return {
      info,
      manifest,
      dir,
      webDir: path.join(dir, 'web'),
      disposables,
      routes,
      ctx,
    };
  }

  private errorInfo(id: string, dir: string, source: PluginSource, e: unknown, base?: PluginInfo): LoadedPlugin {
    const info: PluginInfo = base ?? {
      id,
      name: id,
      version: '',
      description: '',
      source,
      dir,
      enabled: false,
      error: e instanceof Error ? e.message : String(e),
      ui: [],
      activation: 'onStartup',
    };
    info.enabled = false;
    info.error = e instanceof Error ? e.message : String(e);
    const loaded = this.makeLoaded(info, { id, name: id, version: '', entry: '', activation: 'onStartup' }, dir);
    loaded.info.error = info.error;
    return loaded;
  }

  private disposePlugin(p: LoadedPlugin): void {
    try {
      void p.activation?.dispose?.();
    } catch (e) {
      this.log(p.info.id, 'warn', `dispose 出错: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const fn of p.disposables) {
      try {
        fn();
      } catch {
        // 忽略单个清理失败
      }
    }
    p.disposables.clear();
  }

  /* ---------- 工具 ---------- */

  private readManifest(dir: string): PluginManifest {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as Partial<PluginManifest>;
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new Error('plugin.json 缺少合法 id（小写字母开头，字母/数字/._-）');
    if (typeof raw.entry !== 'string' || raw.entry.length === 0) throw new Error('plugin.json 缺少 entry');
    return raw as PluginManifest;
  }

  private validateManifest(m: PluginManifest, dir: string): void {
    const entry = path.resolve(dir, m.entry);
    if (!entry.startsWith(dir + path.sep)) throw new Error('entry 路径越界');
    for (const u of m.ui ?? []) {
      const f = path.resolve(path.join(dir, 'web'), u.entry);
      if (!f.startsWith(path.join(dir, 'web') + path.sep)) throw new Error(`ui 入口越界: ${u.id}`);
    }
  }

  private isDisabled(id: string): boolean {
    const row = this.deps.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(DISABLED_PREFIX + id) as
      | { value: string }
      | undefined;
    return row?.value === '1';
  }

  private setDisabled(id: string, disabled: boolean): void {
    this.deps.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(DISABLED_PREFIX + id, disabled ? '1' : '0');
  }

  private getDevDirs(): string[] {
    const row = this.deps.db.prepare('SELECT value FROM app_settings WHERE key = ?').get('plugin_dev_dirs') as
      | { value: string }
      | undefined;
    if (!row) return [];
    try {
      const v = JSON.parse(row.value) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private setDevDirs(dirs: string[]): void {
    this.deps.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('plugin_dev_dirs', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(JSON.stringify(dirs));
  }

  /** 解压 .taplugin 安装包到 pluginsDir/<id>（校验清单 + 防路径穿越） */
  private extractPackage(buf: Buffer, filename: string): string {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buf);
    } catch {
      throw new Error('不是合法的 .taplugin 包');
    }
    const entries = zip.getEntries();
    const hasManifest = entries.some((e) => !e.isDirectory && e.entryName === 'plugin.json');
    if (!hasManifest) throw new Error('包内缺少根 plugin.json');
    const manifestRaw = zip.readAsText('plugin.json');
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(manifestRaw) as PluginManifest;
    } catch {
      throw new Error('plugin.json 不是合法 JSON');
    }
    if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) throw new Error('plugin.json 缺少合法 id');
    const target = path.join(this.pluginsDir, manifest.id);
    const safeNames: string[] = [];
    for (const e of entries) {
      const n = e.entryName.replace(/\\/g, '/');
      if (n.startsWith('../') || n.includes('/../') || n.startsWith('/')) throw new Error(`包内存在非法路径: ${n}`);
      safeNames.push(n);
    }
    fs.rmSync(target, { recursive: true, force: true });
    for (const n of safeNames) {
      if (n.endsWith('/')) continue;
      zip.extractEntryTo(n, target, true, true);
    }
    // 清理意外多余文件（如 __MACOSX）
    const macosx = path.join(target, '__MACOSX');
    if (fs.existsSync(macosx)) fs.rmSync(macosx, { recursive: true, force: true });
    void filename;
    return manifest.id;
  }

  private log(id: string, level: 'info' | 'warn' | 'error', msg: string): void {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[plugin:${id}] ${msg}`);
  }
}
