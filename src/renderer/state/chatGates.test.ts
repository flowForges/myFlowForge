import { describe, it, expect } from 'vitest'
import { applyChatGateEvent, type ChatGateMap } from './chatGates'
import type { ChatEvent } from '@shared/types'

const ev = (e: Record<string, unknown>) => ({ workspacePath: '/ws', sessionId: 's1', ...e }) as unknown as ChatEvent

describe('applyChatGateEvent — 侧栏门计数', () => {
  it('★流式 delta 这类和门无关的事件:原样返回 prev,不新建 Map/Set', () => {
    const prev: ChatGateMap = new Map()
    expect(applyChatGateEvent(prev, ev({ type: 'assistant-delta', id: 'm1', text: 'x' }))).toBe(prev)
    expect(applyChatGateEvent(prev, ev({ type: 'think-delta', id: 'm1', text: 'x' }))).toBe(prev)
  })

  it('confirm-request 加进去;重复同一个 id 不再换引用', () => {
    const a = applyChatGateEvent(new Map(), ev({ type: 'confirm-request', id: 'c1' }))
    expect([...a.get('/ws')!.confirm]).toEqual(['c1'])
    expect(applyChatGateEvent(a, ev({ type: 'confirm-request', id: 'c1' }))).toBe(a)
  })

  it('confirm-resolved / ask-resolved 删掉;删一个本来就没有的 id 不换引用', () => {
    let m = applyChatGateEvent(new Map(), ev({ type: 'confirm-request', id: 'c1' }))
    m = applyChatGateEvent(m, ev({ type: 'ask-request', id: 'q1' }))
    expect([...m.get('/ws')!.input]).toEqual(['q1'])
    expect(applyChatGateEvent(m, ev({ type: 'confirm-resolved', id: 'nope' }))).toBe(m)
    const r = applyChatGateEvent(m, ev({ type: 'confirm-resolved', id: 'c1' }))
    expect(r).not.toBe(m)
    expect(r.get('/ws')!.confirm.size).toBe(0)
    const r2 = applyChatGateEvent(r, ev({ type: 'ask-resolved', id: 'q1' }))
    expect(r2.get('/ws')!.input.size).toBe(0)
    // 原来的不被改
    expect(m.get('/ws')!.confirm.has('c1')).toBe(true)
  })

  it('不同工作区互不影响', () => {
    const m = applyChatGateEvent(new Map(), ev({ type: 'confirm-request', id: 'c1' }))
    const n = applyChatGateEvent(m, { ...ev({ type: 'ask-request', id: 'q1' }), workspacePath: '/other' } as ChatEvent)
    expect(n.get('/ws')).toBe(m.get('/ws'))
    expect([...n.get('/other')!.input]).toEqual(['q1'])
  })
})
