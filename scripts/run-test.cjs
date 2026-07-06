// Node.js 测试启动器：通过 mock electron 模块，在纯 Node.js 环境中运行 Phase 1 测试。
// 这样绕过对 electron 二进制的依赖（electron 二进制需要下载，环境可能受限）。
//
// 运行方式：
//   1. npx esbuild scripts/test-phase1.ts --bundle --platform=node --format=cjs ^
//        --external:electron --external:better-sqlite3 --external:electron-store ^
//        --external:archiver --external:unzip-stream --outfile=dist-test/test-phase1.cjs
//   2. node scripts/run-test.cjs
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 测试用的 userData 目录（模拟 app.getPath('userData')）
const testUserData = path.join(__dirname, '..', 'dist-test', 'test-userdata');
fs.mkdirSync(testUserData, { recursive: true });

// electron mock：提供 app / Notification / dialog 等 API 的最小实现
// Notification.isSupported 返回 false，避免在 Node.js 环境尝试弹通知
const electronMock = {
  app: {
    getPath(name) {
      if (name === 'userData') return testUserData;
      if (name === 'temp') return os.tmpdir();
      return testUserData;
    },
    getVersion() {
      return '0.1.0-test';
    },
    whenReady() {
      return Promise.resolve();
    },
    on() {
      return this;
    },
    quit() {
      // 测试完成后延迟退出，给异步日志刷盘留时间
      setTimeout(() => process.exit(0), 200);
    },
    exit(code) {
      process.exit(code);
    },
  },
  Notification: class MockNotification {
    constructor() {}
    static isSupported() {
      return false;
    }
    show() {}
    on() {
      return this;
    }
    close() {}
  },
  dialog: {
    showSaveDialog() {
      return Promise.resolve({ canceled: true, filePath: '' });
    },
    showOpenDialog() {
      return Promise.resolve({ canceled: true, filePaths: [] });
    },
  },
  ipcMain: { handle() {}, on() {}, removeAllListeners() {} },
  BrowserWindow: class MockBrowserWindow {},
};

// 拦截 require('electron')，返回 mock 对象而非真实 electron
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return electronMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

// 加载并运行 esbuild 编译后的测试脚本
require('../dist-test/test-phase1.cjs');
