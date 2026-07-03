import { describe, it, expect } from 'vitest'
import { buildNarration, pickMainAgent, statusZh } from './narration'
import type { RunState } from '@shared/types'
import type { AgentProvider } from '../agents/types'

function fakeProvider(id: string, hasChat: boolean): AgentProvider {
  const base: any = {
    id, displayName: id === 'claude' ? 'Claude Code' : id,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } }
  }
  if (hasChat) base.chat = () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) })
  return base
}

const run: RunState = {
  id: 'r1', workspaceName: 'ws', workspacePath: '/ws', status: 'run', projects: [],
  pending: [],
  stages: [
    { key: 'design', name: '技术方案设计', state: 'ok', agents: [{ id: 'a1', name: 'design', role: 'r', provider: 'claude', model: 'opus-4.8', state: 'ok', logs: [] }] },
    { key: 'develop', name: '代码开发', state: 'run', agents: [
      { id: 'd1', name: 'web', role: 'r', provider: 'claude', model: 'sonnet-4.6', state: 'run', logs: [] },
      { id: 'd2', name: 'api', role: 'r', provider: 'claude', model: 'sonnet-4.6', state: 'run', logs: [] }
    ] }
  ]
}

describe('statusZh', () => {
  it('maps states to Chinese', () => {
    expect(statusZh('run')).toBe('执行中'); expect(statusZh('ok')).toBe('完成')
    expect(statusZh('err')).toBe('失败'); expect(statusZh('wait')).toBe('等待')
  })
})

describe('pickMainAgent', () => {
  it('returns the first stage first agent provider/model + display', () => {
    const got = pickMainAgent(run, { claude: fakeProvider('claude', true) })
    expect(got).not.toBeNull()
    expect(got!.model).toBe('opus-4.8')
    expect(got!.providerDisplay).toBe('Claude Code')
  })
  it('returns null when the provider has no chat()', () => {
    expect(pickMainAgent(run, { claude: fakeProvider('claude', false) })).toBeNull()
  })
  it('returns null when there is no first-stage agent', () => {
    expect(pickMainAgent({ ...run, stages: [] }, { claude: fakeProvider('claude', true) })).toBeNull()
  })
})

describe('buildNarration', () => {
  it('start: mentions the total sub-agent count and stage names', () => {
    const p = buildNarration('start', run, [])
    expect(p).toContain('3')
    expect(p).toContain('技术方案设计')
    expect(p).toContain('代码开发')
  })
  it('done: mentions stage states and change counts', () => {
    const p = buildNarration('done', { ...run, status: 'ok' }, [
      { path: 'a.ts', type: 'M', add: 4, del: 2 },
      { path: 'b.ts', type: 'A', add: 10, del: 0 }
    ])
    expect(p).toContain('2')
    expect(p).toMatch(/新增|修改|变更/)
  })
})
