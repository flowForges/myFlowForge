import { describe, it, expect } from 'vitest'
import { listForgeTools } from './forgeMcp'

describe('forge_delegate 注册', () => {
  it('FORGE_TOOLS 含 forge_delegate 时出现在清单', () => {
    expect(listForgeTools('forge_delegate')).toContain('forge_delegate')
  })
  it('不在白名单则不出现', () => {
    expect(listForgeTools('forge_handoff')).not.toContain('forge_delegate')
  })
  it('未设置 FORGE_TOOLS 返回全部(含 delegate)', () => {
    expect(listForgeTools()).toContain('forge_delegate')
  })
  it('stage 工具集不放行 delegate(防子代理再委派递归)', () => {
    expect(listForgeTools('forge_read_context,forge_write_artifact,forge_ask,forge_handoff,forge_heartbeat')).not.toContain('forge_delegate')
  })
})
