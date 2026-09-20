import { describe, it, expect } from 'vitest'

// ★`notify.ts` 整个 import 了 react-native 和 expo-notifications,在 node 那套 vitest 里跑不了。
//  `tapTargetOf` 是它里面唯一的纯函数,而它决定「点了通知落到哪一屏」—— 认错就是点了没反应。
//  所以在这儿**照抄一份实现**是不行的(抄的那份永远绿)。改成把它单独放一个零 import 的文件。
import { tapTargetOf } from './tapTarget'

describe('tapTargetOf', () => {
  it('带会话的通知 → 那条会话', () => {
    expect(tapTargetOf({ wsPath: '/ws', sessionId: 's1', kind: 'confirm' })).toEqual({ wsPath: '/ws', sessionId: 's1' })
  })
  it('工作区级的通知 → 只有工作区', () => {
    expect(tapTargetOf({ wsPath: '/ws', sessionId: null, kind: 'gate' })).toEqual({ wsPath: '/ws', sessionId: null })
  })
  it('空串的 sessionId 也当没有', () => {
    expect(tapTargetOf({ wsPath: '/ws', sessionId: '' })).toEqual({ wsPath: '/ws', sessionId: null })
  })
  it('没有工作区路径 → null(测试推送就是这种,它没有目标)', () => {
    expect(tapTargetOf({ wsPath: '', sessionId: null })).toBeNull()
  })
  it('★什么垃圾都不许抛 —— 这条 data 是从系统那儿回来的,不是我们自己刚写的那份', () => {
    for (const bad of [null, undefined, 0, 'x', [], { wsPath: 5 }, { sessionId: 's' }])
      expect(() => expect(tapTargetOf(bad)).toBeNull()).not.toThrow()
  })
})
