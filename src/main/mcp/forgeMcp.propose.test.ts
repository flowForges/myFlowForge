import { describe, it, expect } from 'vitest'
import { listForgeTools } from './forgeMcp'

describe('forge_propose_plan 注册', () => {
  it('FORGE_TOOLS 含 forge_propose_plan 时出现在清单', () => {
    expect(listForgeTools('forge_propose_plan')).toContain('forge_propose_plan')
  })
  it('不在白名单则不出现', () => {
    expect(listForgeTools('forge_handoff')).not.toContain('forge_propose_plan')
  })
  it('未设置 FORGE_TOOLS 返回全部(含 propose_plan)', () => {
    expect(listForgeTools()).toContain('forge_propose_plan')
  })
})
