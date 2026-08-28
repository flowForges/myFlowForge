import { describe, it, expect } from 'vitest'
import { sessionCanDelete } from './sessionOps'

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
