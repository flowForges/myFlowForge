import { describe, it, expect } from 'vitest'
import type { ChatEvent, LogLine } from './types'

describe('plan + kind types', () => {
  it('ChatEvent 支持 plan-request / plan-resolved', () => {
    const req: ChatEvent = {
      workspacePath: '/w', sessionId: 's1', type: 'plan-request', id: 'pl-1',
      approach: '先建模型再写测试', stages: [{ key: 'design', name: '设计', agents: 2, perProject: true, projects: ['a', 'b'] }], allProjects: ['a', 'b'], task: '加评论'
    }
    const res: ChatEvent = { workspacePath: '/w', sessionId: 's1', type: 'plan-resolved', id: 'pl-1' }
    expect(req.type).toBe('plan-request')
    expect(res.type).toBe('plan-resolved')
  })
  it('LogLine 支持可选 kind', () => {
    const l: LogLine = { ts: '00:00:00', text: '编辑 a.ts', level: 'accent', kind: 'file' }
    expect(l.kind).toBe('file')
  })
})
