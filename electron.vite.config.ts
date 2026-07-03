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
        },
      },
    },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: { build: { outDir: 'out/preload' }, resolve: { alias: { '@shared': resolve('src/shared') } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/renderer', rollupOptions: { input: { index: resolve('src/renderer/index.html'), pet: resolve('src/renderer/pet.html') } } }
  }
})
