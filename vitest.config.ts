import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Several provider tests spawn real `node` subprocesses (execa) and the renderer e2e tests do
    // heavy jsdom work. When all files run in parallel and saturate the CPU, the default 5s test /
    // 10s hook timeouts are occasionally too tight → intermittent flakes that pass in isolation.
    // Generous ceilings absorb load spikes while still failing a genuine hang.
    testTimeout: 20000,
    hookTimeout: 20000,
    projects: [
      { extends: true, test: { name: 'renderer', environment: 'jsdom', include: ['src/renderer/**/*.test.{ts,tsx}'] } },
      { extends: true, test: { name: 'main', environment: 'node', include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'] } },
      // 手机端里**不 import React Native** 的那部分纯逻辑。带 RN 的组件跑不了(要 RN 的 jest preset),
      // 所以只收 src/ui/*.ts 这类纯文件 —— 它们决定「哪一段内容被折起来看不见」,值得钉住。
      { extends: true, test: { name: 'mobile', environment: 'node', include: ['mobile/src/**/*.test.ts'] } },
      // 中转。撮合核心是纯逻辑(没有 I/O、没有定时器、没有全局状态),所以在这里就能测透 ——
      // 它在 Node 和 Cloudflare Durable Object 里跑的是同一份代码,行为必须一致。
      { extends: true, test: { name: 'relay', environment: 'node', include: ['relay/src/**/*.test.ts'] } },
    ],
  }
})
