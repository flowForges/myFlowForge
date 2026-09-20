import { describe, it, expect } from 'vitest'
import { pushEventFrom } from './fromEvent'

describe('pushEventFrom · 两端共用的那一份映射', () => {
  it('权限门', () => {
    expect(pushEventFrom('chat:event', { workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1' }))
      .toEqual({ kind: 'confirm', target: { workspacePath: '/ws', sessionId: 's1' }, eventId: 'c1' })
  })

  it('代理提问', () => {
    expect(pushEventFrom('chat:event', { workspacePath: '/ws', sessionId: 's1', type: 'ask-request', id: 'a1' })?.kind).toBe('ask')
  })

  it('跑完了 —— 没有 eventId(按会话去重)', () => {
    const r = pushEventFrom('chat:event', { workspacePath: '/ws', sessionId: 's1', type: 'done' })
    expect(r?.kind).toBe('done')
    expect(r?.eventId).toBeUndefined()
  })

  it('工作流阶段门', () => {
    expect(pushEventFrom('run2:event', { workspacePath: '/ws', event: { id: 'g1', kind: 'gate' } }))
      .toEqual({ kind: 'gate', target: { workspacePath: '/ws', sessionId: null }, eventId: 'g1' })
  })

  it('★泳道四种都要认出来 —— 漏一种的症状只是「有时候有提醒」', () => {
    for (const kind of ['question', 'auth', 'doubt', 'failure'])
      expect(pushEventFrom('run2:event', { workspacePath: '/ws', event: { id: 'x', kind } })?.kind, kind).toBe('question')
  })

  it('会话里的事 sessionId 保留,工作区级的事一律是 null', () => {
    expect(pushEventFrom('chat:event', { workspacePath: '/ws', type: 'done' })?.target.sessionId).toBeNull()
    expect(pushEventFrom('run2:event', { workspacePath: '/ws', event: { kind: 'gate' } })?.target.sessionId).toBeNull()
  })

  it('不该提醒的一概返回 null', () => {
    const nos: Array<[string, unknown]> = [
      ['chat:event', { workspacePath: '/ws', type: 'delta' }],
      ['chat:event', { workspacePath: '/ws', type: 'confirm-resolved', id: 'c1' }],
      ['chat:event', { workspacePath: '/ws', type: 'ask-resolved', id: 'a1' }],
      ['run2:event', { workspacePath: '/ws', event: { kind: 'answer' } }],
      ['run2:update', { workspacePath: '/ws', state: { status: 'done' } }],
      ['run2:log', { workspacePath: '/ws' }],
      ['settings:changed', {}],
      ['chat:event', { workspacePath: '', type: 'done' }],
      ['run2:event', { workspacePath: '/ws' }],
      ['run2:event', { workspacePath: '/ws', event: 5 }],
    ]
    for (const [ch, p] of nos) expect(pushEventFrom(ch, p), `${ch} ${JSON.stringify(p)}`).toBeNull()
  })

  it('畸形 payload 一律 null,绝不抛', () => {
    for (const bad of [null, undefined, 0, 'x', true])
      for (const ch of ['chat:event', 'run2:event'])
        expect(() => expect(pushEventFrom(ch, bad)).toBeNull()).not.toThrow()
  })
})
