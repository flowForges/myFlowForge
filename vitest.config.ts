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
    ],
  }
})
