import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          forgeMcp: resolve('src/main/mcp/forgeMcp.ts'),
          // 无头 daemon 入口(第二期 B)。跟 index 装载同一份核心,只是宿主能力换成无头实现。
          daemon: resolve('src/main/daemon/index.ts'),
          // PATH shim 的运行时。★必须是**独立入口**:它不跑在 Electron 主进程里,而是被 shim 脚本
          // 以 `electron --run-as-node agentShim.js <命令名> …` 单独拉起,跑在 agent 的环境中。
          agentShim: resolve('src/main/agents/shim/shimMain.ts'),
          // mff-ai 后台 harness 的两个入口:监管/工作进程(同一文件,--worker 区分)与 ACP 转接器
          mffaiDaemon: resolve('harness/src/entry/daemon.ts'),
          mffaiAcp: resolve('harness/src/entry/acp.ts'),
        },
      },
    },
    resolve: { alias: { '@shared': resolve('src/shared'), '@mffai/protocol': resolve('harness/src/protocol/index.ts') } },
  },
  preload: { build: { outDir: 'out/preload' }, resolve: { alias: { '@shared': resolve('src/shared'), '@mffai/protocol': resolve('harness/src/protocol/index.ts') } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@mffai/protocol': resolve('harness/src/protocol/index.ts') } },
    build: { outDir: 'out/renderer', rollupOptions: { input: { index: resolve('src/renderer/index.html'), pet: resolve('src/renderer/pet.html') } } }
  }
})
