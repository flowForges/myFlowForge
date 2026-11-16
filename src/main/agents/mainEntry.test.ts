import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { mainEntryPath } from './mainEntry'

// 实测 1.3.0-cu.1:handlers.ts 被 rollup 拆进 out/main/chunks/(index 与 daemon 共用),
// join(__dirname,'forgeMcp.js') 指向不存在的 chunks/forgeMcp.js,forge MCP 每轮 MODULE_NOT_FOUND。
describe('mainEntryPath', () => {
  const out = '/Applications/myFlowForge Test.app/Contents/Resources/app/out/main'
  it('code bundled into a chunk still finds the entry in out/main', () => {
    expect(mainEntryPath(join(out, 'chunks'), 'forgeMcp.js')).toBe(join(out, 'forgeMcp.js'))
    expect(mainEntryPath(join(out, 'chunks'), 'agentShim.js')).toBe(join(out, 'agentShim.js'))
  })
  it('code in an entry file keeps its own directory', () => {
    expect(mainEntryPath(out, 'forgeMcp.js')).toBe(join(out, 'forgeMcp.js'))
  })
})
