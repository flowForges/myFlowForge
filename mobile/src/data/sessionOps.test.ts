import { describe, it, expect } from 'vitest'
import { sessionCanDelete, sessionCloseWasRefused } from './sessionOps'

const S = (id: string, readonly?: true) => ({ id, readonly })

describe('这条会话能不能删', () => {
  it('两条以上,随便删', () => {
    expect(sessionCanDelete([S('a'), S('b')], 'a')).toEqual({ ok: true })
  })

  it('★★只剩最后一条可写会话时删不掉 —— 服务端会**静默**原样返回', () => {
    // src/main/chat/sessionStore.ts:99 `if (writable.length <= 1) return data`。
    // 不在这儿拦住的话,左滑露出一颗红色的「删除」,按下去什么都不发生 ——
    // 又一个「点了没反应」,而且服务端连个错都不报。
    const r = sessionCanDelete([S('only')], 'only')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.why).toContain('最后一条')
  })

  it('★不能删的时候必须给一句**能照着做**的话,不是「操作失败」', () => {
    const r = sessionCanDelete([S('only')], 'only')
    if (!r.ok) expect(r.why).toContain('新建')
  })

  it('★只读(导入来的)会话不算「可写会话」—— 它旁边那条唯一的可写会话仍然删不掉', () => {
    const r = sessionCanDelete([S('imported', true), S('only')], 'only')
    expect(r.ok).toBe(false)
  })

  it('★只读会话自己**永远删得掉** —— 服务端走的是「记住这次关闭」那条路,不受数量限制', () => {
    expect(sessionCanDelete([S('imported', true), S('only')], 'imported')).toEqual({ ok: true })
    expect(sessionCanDelete([S('imported', true)], 'imported')).toEqual({ ok: true })
  })

  it('找不到这条会话 → 不给删(而不是崩,也不是假装删了)', () => {
    const r = sessionCanDelete([S('a')], 'nope')
    expect(r.ok).toBe(false)
  })
})

describe('session:close 响应回来之后,这条会话到底删没删', () => {
  // ★这不是 sessionCanDelete 的活——sessionCanDelete 判的是按下之前那一刻的快照,
  //  这里判的是 invoke 真正打过去、服务端回了响应**之后**的事实:传去的那条 id
  //  是不是还在响应的 sessions 里。还在,就是被静默拒绝了(见 LAST_SESSION_WHY)。

  it('★★响应里这条 id 已经不在了 —— 真删掉了', () => {
    expect(sessionCloseWasRefused([S('b')], 'a')).toBe(false)
  })

  it('★★响应里这条 id 还在 —— 服务端静默拒绝了(竞态版的「只剩最后一条」)', () => {
    expect(sessionCloseWasRefused([S('a'), S('b')], 'a')).toBe(true)
  })
})
