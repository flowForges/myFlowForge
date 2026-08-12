import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-'))
  process.env.HOME = home
  vi.resetModules()
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('archiveWorkspaceLifecycle', () => {
  it('marks archived + unpins', async () => {
    const { registerWorkspace, readWorkspaceRegistry, readSettings, writeSettings } = await import('../config/store')
    const { archiveWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('a', '/tmp/a')
    writeSettings({ ...readSettings(), pinnedWorkspaces: ['/tmp/a'] })
    archiveWorkspaceLifecycle('/tmp/a')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/a')!
    expect(e.archived).toBe(true)
    expect(e.archivedAt).toBeGreaterThan(0)
    expect(readSettings().pinnedWorkspaces).not.toContain('/tmp/a')
  })

  it('works when workspace is not pinned', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { archiveWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('b', '/tmp/b')
    archiveWorkspaceLifecycle('/tmp/b')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/b')!
    expect(e.archived).toBe(true)
    expect(e.archivedAt).toBeGreaterThan(0)
  })
})

// 归档 = 只读封存,它自己绝不能再起 agent。原先归档会跑一个一次性 CLI(摘要 agent)去生成这行描述,
// 结果是:被归档工作区的目录里凭空多出一个 claude 进程,外部的 agent 监控插件看得见、还推了通知。
// 现在描述直接取最后一个会话的标题,不跑任何 provider。
describe('归档描述', () => {
  const archiveFresh = async (name: string, seed: (ws: string) => void) => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { archiveWorkspaceLifecycle } = await import('../workspace/archiveOps')
    const ws = mkdtempSync(join(tmpdir(), 'forge-ws-'))
    registerWorkspace(name, ws)
    seed(ws)
    archiveWorkspaceLifecycle(ws)
    const desc = readWorkspaceRegistry().find(w => w.path === ws)!.description
    rmSync(ws, { recursive: true, force: true })
    return desc
  }

  it('取最后一个会话的标题,不留「总结中…」这类中间态', async () => {
    const { newSession } = await import('../chat/sessionStore')
    const desc = await archiveFresh('d', ws => {
      newSession(ws, '接入钉钉机器人')
      newSession(ws, '重构 API 网关限流')
    })
    expect(desc).toBe('重构 API 网关限流')
  })

  it('末尾是没聊过的「新会话」时,往前取上一个有名字的', async () => {
    const { newSession } = await import('../chat/sessionStore')
    const desc = await archiveFresh('e', ws => {
      newSession(ws, '重构 API 网关限流')
      newSession(ws)                       // 用户随手新建、还没说话
    })
    expect(desc).toBe('重构 API 网关限流')
  })

  it('全都没聊过就留空,由界面回落到「已归档 · 只读」', async () => {
    const desc = await archiveFresh('f', () => { /* 一个会话都没建过 */ })
    expect(desc).toBe('')
  })
})

describe('restoreWorkspaceLifecycle', () => {
  it('clears archived flag', async () => {
    const { registerWorkspace, readWorkspaceRegistry } = await import('../config/store')
    const { archiveWorkspaceLifecycle, restoreWorkspaceLifecycle } = await import('../workspace/archiveOps')
    registerWorkspace('c', '/tmp/c')
    archiveWorkspaceLifecycle('/tmp/c')
    restoreWorkspaceLifecycle('/tmp/c')
    const e = readWorkspaceRegistry().find(w => w.path === '/tmp/c')!
    expect(e.archived).toBe(false)
    expect(e.archivedAt).toBeNull()
  })
})
