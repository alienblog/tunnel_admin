import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
