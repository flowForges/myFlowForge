import { describe, it, expect } from 'vitest'
import { pickSessionAgent } from './sessionAgent'

const AGENTS = [
  { id: 'claude', models: [{ id: 'sonnet' }, { id: 'opus' }] },
  { id: 'codex', models: [{ id: 'gpt-5' }] },
]

describe('这条会话该用哪个代理和模型', () => {
  it('会话自己记着的优先 —— 每条会话各留各的选择,这是服务端早就在存的东西', () => {
    expect(pickSessionAgent({ agentId: 'codex', modelId: 'gpt-5' }, AGENTS))
      .toEqual({ agentId: 'codex', modelId: 'gpt-5' })
  })

  it('会话什么都没记(新会话)→ 落到第一个装了的', () => {
    expect(pickSessionAgent({}, AGENTS)).toEqual({ agentId: 'claude', modelId: 'sonnet' })
  })

  it('★会话记的代理**已经不在了**(那个 CLI 被卸了)→ 退到第一个装了的,别卡在一个装不上的上面', () => {
    // 不退的话:顶栏显示一个根本不存在的代理名,发送键看着是活的,一发就报错。
    expect(pickSessionAgent({ agentId: 'qoder', modelId: 'x' }, AGENTS))
      .toEqual({ agentId: 'claude', modelId: 'sonnet' })
  })

  it('★代理还在但**模型**没了(升级换了模型名)→ 保住代理,模型退到它自己的第一个', () => {
    expect(pickSessionAgent({ agentId: 'claude', modelId: 'sonnet-3' }, AGENTS))
      .toEqual({ agentId: 'claude', modelId: 'sonnet' })
  })

  it('一个代理都没探测到 → 两个都是 null(顶栏显示「选代理」,发送键该是灰的)', () => {
    expect(pickSessionAgent({ agentId: 'claude', modelId: 'sonnet' }, [])).toEqual({ agentId: null, modelId: null })
  })

  it('没选会话 → 仍然给出默认,顶栏不至于空着', () => {
    expect(pickSessionAgent(null, AGENTS)).toEqual({ agentId: 'claude', modelId: 'sonnet' })
  })

  it('★代理一个模型都没有 → 代理留着,模型是 null(别硬造一个模型 id 发出去)', () => {
    expect(pickSessionAgent({}, [{ id: 'bare', models: [] }]))
      .toEqual({ agentId: 'bare', modelId: null })
  })
})
