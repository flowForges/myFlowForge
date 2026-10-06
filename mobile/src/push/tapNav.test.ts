import { describe, it, expect } from 'vitest'
import { tapNav } from './tapNav'

// 2026-10-06:点通知无限跳转期间 app 崩了。循环是主因(已修),但放大器是 `router.push` ——
// 它每次都新压一屏,十几屏聊天同时活着,每屏带着自己的订阅和消息列表,内存就爆了。
// 这个文件钉住「点通知该去哪儿」这个决策,好让 PushProvider 那边只剩执行。
const groups = [
  { ws: { path: '/a' }, sessions: [{ id: 's1' }, { id: 's2' }] },
  { ws: { path: '/empty' }, sessions: [] },
]

describe('tapNav —— 点通知该去哪一屏', () => {
  it('通知指明了会话:选中它并去聊天', () => {
    expect(tapNav({ wsPath: '/a', sessionId: 's2' }, groups)).toEqual({
      select: { wsPath: '/a', sessionId: 's2' },
      route: 'chat',
    })
  })

  it('★会话 id 即使不在已知列表里也照样去 —— 通知比本地列表新,别把人挡在外面', () => {
    expect(tapNav({ wsPath: '/a', sessionId: 'brand-new' }, groups)).toEqual({
      select: { wsPath: '/a', sessionId: 'brand-new' },
      route: 'chat',
    })
  })

  it('工作区级的通知(工作流的门):选该工作区第一条会话,去执行屏', () => {
    expect(tapNav({ wsPath: '/a', sessionId: null }, groups)).toEqual({
      select: { wsPath: '/a', sessionId: 's1' },
      route: 'exec',
    })
  })

  it('★工作区级但一条会话都没有:回列表,别推一屏空的进去', () => {
    expect(tapNav({ wsPath: '/empty', sessionId: null }, groups)).toEqual({ route: 'home' })
  })

  it('工作区根本不认识:同样回列表', () => {
    expect(tapNav({ wsPath: '/nope', sessionId: null }, groups)).toEqual({ route: 'home' })
  })

  it('没有任何工作区时不炸', () => {
    expect(tapNav({ wsPath: '/a', sessionId: null }, [])).toEqual({ route: 'home' })
  })
})
