import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // xterm 6.0.0 预压缩产物被 esbuild 二次压缩破坏（requestMode 引用未定义变量，
  // 导致 vim/omp 的 DECSET 同步输出解析抛 ReferenceError、终端渲染冻结/白屏）。
  // 用 terser 压缩规避（esbuild 二次压缩的 bug）；若 terser 仍有问题则回退 minify: false。
  build: {
    minify: 'terser',
  },
  server: {
    port: 5173,
    // 禁用模块缓存：避免浏览器命中旧 transform 导致白屏
    headers: { 'Cache-Control': 'no-store' },
    proxy: {
      '/api': process.env.TA_PROXY ?? 'http://127.0.0.1:8080',
      '/ws': { target: process.env.TA_PROXY ?? 'ws://127.0.0.1:8080', ws: true },
      '/mcp': process.env.TA_PROXY ?? 'http://127.0.0.1:8080',
    },
  },
});
