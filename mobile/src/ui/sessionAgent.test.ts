import { describe, it, expect } from 'vitest'
import { pickModel, pickSessionAgent, shouldRederive } from './sessionAgent'

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

describe('要不要把顶栏重新判一遍(防「隔壁会话广播了一次,把我刚选的模型判掉」)', () => {
  it('从来没判过 → 必须判一次', () => {
    expect(shouldRederive(null, { key: 'a', hasSession: true, hasAgents: true })).toBe(true)
  })

  it('切了会话(key 变了)→ 不管上次判没判过、判没判完,都要重判', () => {
    expect(shouldRederive({ key: 'a', settled: true }, { key: 'b', hasSession: true, hasAgents: true })).toBe(true)
  })

  it('★同一条会话,上次判的时候数据还没到齐(没 settled),这次到齐了 → 必须补判一次', () => {
    // 这是「agents 和会话数据不是同时到」那条竞态:上次拿着还没读到的会话数据判过一次
    // (落到了默认代理),这次数据真的到了,不能当成「已经判过,不用管」——
    // 那样顶栏会永远停在启动时的默认代理上。
    expect(shouldRederive({ key: 'a', settled: false }, { key: 'a', hasSession: true, hasAgents: true })).toBe(true)
  })

  it('★同一条会话,已经拿完整数据判过一次(settled)→ 后面随便什么原因重渲染都不再判', () => {
    // 这正是要挡的竞态:隔壁会话跑完一轮广播了整份会话数组(store.tsx 的 sessionsChanged
    // 是整份替换,不是按 id 补丁),currentSession 换了个新对象,但这条会话本身没变——
    // 不能借着这次「顺便」重判,把用户刚选的模型用一份可能还没写回落地的旧快照判掉。
    expect(shouldRederive({ key: 'a', settled: true }, { key: 'a', hasSession: true, hasAgents: true })).toBe(false)
  })

  it('同一条会话数据一直没到(hasSession 恒 false)→ 不重复判,不会一直空转', () => {
    expect(shouldRederive({ key: 'a', settled: false }, { key: 'a', hasSession: false, hasAgents: true })).toBe(false)
  })
})

describe('挑模型(顶栏和判据共用的那一份)', () => {
  const models = [{ id: 'opus', label: '大' }, { id: 'sonnet', label: '中' }]

  it('记着的那个还在就用它', () => {
    expect(pickModel(models, 'sonnet')?.label).toBe('中')
  })

  it('★记着的那个没了(升级换了名字)退到第一个 —— 不是变成 null', () => {
    // 变 null 的话顶栏那一格空着,而发送键看着还是活的,一发才炸。
    expect(pickModel(models, 'opus-4.8')?.id).toBe('opus')
    expect(pickModel(models, null)?.id).toBe('opus')
  })

  it('一个模型都没有 / 没有代理 → null', () => {
    expect(pickModel([], 'opus')).toBe(null)
    expect(pickModel(undefined, 'opus')).toBe(null)
  })
})
