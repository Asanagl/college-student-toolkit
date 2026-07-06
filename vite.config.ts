import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import path from 'node:path';

// 主进程与 preload 使用 vite-plugin-electron 标准形式编译
// 标准形式支持多 preload 入口（preload + importBrowserPreload）
// simple 形式内部对 preload 强制 inlineDynamicImports:true，不支持多入口
const externalDeps = [
  'better-sqlite3',
  'electron-store',
  'electron-updater',
  'tesseract.js',
  'cheerio',
  'archiver',
  'unzip-stream',
  'expr-eval',
];

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron/main',
            rollupOptions: {
              external: externalDeps,
            },
          },
        },
      },
      {
        entry: ['src/main/preload.ts', 'src/main/importBrowserPreload.ts'],
        vite: {
          build: {
            outDir: 'dist-electron/preload',
            rollupOptions: {
              external: externalDeps,
            },
          },
        },
      },
    ]),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
});
