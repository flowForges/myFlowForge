import { describe, it, expect } from 'vitest'
import { mergeActiveSessions } from './sessionsMap'
import type { ChatSession } from '@shared/types'

const s = (id: string): ChatSession => ({ id, title: id, mode: 'chat', createdAt: 0 })

describe('mergeActiveSessions', () => {
  it('当前工作区用实时列表覆盖缓存(增删改名即时可见)', () => {
    const out = mergeActiveSessions({ '/a': [s('a1')], '/b': [s('b1')] }, '/b', [s('b1'), s('b2')])
    expect(out['/b'].map(x => x.id)).toEqual(['b1', 'b2'])
    expect(out['/a'].map(x => x.id)).toEqual(['a1'])   // 其它工作区不受影响
  })

  it('★实时列表为空时保留缓存 —— 切换工作区那一帧不能让会话行整段消失(抖动 + 动效丢失的根因)', () => {
    const cached = { '/a': [s('a1')], '/b': [s('b1'), s('b2')] }
    // 刚点到工作区 B:useSessions 已丢弃 A 的数据、B 的还没到 → live 是空的
    const out = mergeActiveSessions(cached, '/b', [])
    expect(out['/b'].map(x => x.id)).toEqual(['b1', 'b2'])
    expect(out).toEqual(cached)
  })

  it('没有当前工作区(首页)时原样返回', () => {
    const cached = { '/a': [s('a1')] }
    expect(mergeActiveSessions(cached, undefined, [s('x')])).toEqual(cached)
  })
})
