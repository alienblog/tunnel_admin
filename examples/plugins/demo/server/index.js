'use strict';
/**
 * 示例插件后端入口（CJS：插件目录无 package.json 时 .js 按 CommonJS 解析）。
 * 与 ESM 等价：`export function activate(ctx) { ... }` 亦可（兼容两者）。
 *
 * ctx 可用能力：log / store(加密KV) / schedule / registerRoute / db(只读) / ssh(Phase 2)
 */
module.exports = {
  activate(ctx) {
    ctx.log.info('示例插件已激活');

    // 私有 KV（AES 加密落盘）：计数器演示持久化
    ctx.registerRoute('GET', '/ping', () => ({ pong: true, time: new Date().toISOString(), plugin: ctx.id }));

    ctx.registerRoute('POST', '/echo', (req) => ({ echoed: req.body ?? {} }));

    ctx.registerRoute('GET', '/counter', () => {
      const n = parseInt(ctx.store.get('counter') ?? '0', 10) + 1;
      ctx.store.set('counter', String(n));
      return { count: n, plugin: ctx.id };
    });

    // 定时任务：每 10 分钟打一次心跳日志（dispose 时自动清理）
    const timer = ctx.schedule(10 * 60 * 1000, () => {
      ctx.log.info(`心跳，counter=${ctx.store.get('counter') ?? 0}`);
    });

    return {
      dispose() {
        timer.cancel();
        ctx.log.info('示例插件已卸载');
      },
    };
  },
};
