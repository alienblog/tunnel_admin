import type Database from 'better-sqlite3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SshManager } from '../ssh/manager.js';
import type { DynamicConnectInfo } from './connectQueue.js';

/** 插件清单（plugin.json，位于插件根目录） */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 图标：16×16 viewBox 的 SVG path d（单色，跟随 currentColor）；缺省用宿主拼图图标 */
  icon?: string;
  /** 后端入口 JS（相对插件根目录，如 server/index.js） */
  entry: string;
  /** 前端 UI 入口（相对插件根目录，如 web/index.html）；空数组 = 无页面 */
  ui?: Array<{
    /** 页面 id（同插件内唯一），URL 用 ?ui=<id> 区分 */
    id: string;
    label: string;
    /** web/ 下的页面文件 */
    entry: string;
  }>;
  /** 激活时机：onStartup（默认）| onUiOpen */
  activation?: 'onStartup' | 'onUiOpen';
}

export type PluginSource = 'installed' | 'dev';

/** 管理接口暴露的插件信息 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 图标 SVG path d（可空） */
  icon?: string;
  source: PluginSource;
  dir: string;
  enabled: boolean;
  /** 激活错误（加载失败时非空，插件被跳过但可在管理页查看） */
  error?: string;
  ui: NonNullable<PluginManifest['ui']>;
  activation: PluginManifest['activation'];
}

/** 插件私有 KV（value 经 AES-256-GCM 加密落盘） */
export interface PluginStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
}

/** 定时任务句柄 */
export interface PluginTimer {
  cancel(): void;
}

/** 宿主暴露给插件的上下文（窄接口，不暴露 masterKey） */
export interface PluginContext {
  /** 插件 id */
  id: string;
  /** 插件根目录（可读静态资源） */
  dir: string;
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  /** 插件私有 KV 存储（加密落盘） */
  store: PluginStore;
  /** 定时任务（插件禁用/卸载/重载时自动清理） */
  schedule(intervalMs: number, fn: () => void | Promise<void>): PluginTimer;
  /** 注册插件自己的 API 路由：最终路径为 /api/plugins/<id><path> */
  registerRoute(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => unknown | Promise<unknown>,
  ): void;
  /** 只读数据库访问（单用户本地信任模型；如需建表请用 plugin_ 前缀） */
  db: Database.Database;
  /**
   * SSH 动态连接：
   * - requestConnect：登记一次连接（凭据在此传入，仅存于服务端进程），返回一次性令牌
   * - 插件前端用 ta.ssh.connect(token) 让宿主打开终端（明文凭据不出服务端）
   */
  ssh: {
    requestConnect(info: DynamicConnectInfo): { token: string };
  };
}

/** 插件激活返回 */
export interface PluginActivation {
  /** 卸载/禁用/重载时调用（清理资源） */
  dispose?(): void | Promise<void>;
}

/** 插件入口模块（server/index.js） */
export interface PluginModule {
  activate(ctx: PluginContext): PluginActivation | void | Promise<PluginActivation | void>;
}

/** 宿主 API 接口（SshManager 动态连接等，由 manager 组合） */
export interface PluginHostDeps {
  db: Database.Database;
  masterKey: Buffer;
  sshManager: SshManager;
}
