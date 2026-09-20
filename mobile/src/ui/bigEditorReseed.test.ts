import { describe, it, expect } from 'vitest'
import { shouldReseed } from './bigEditorReseed'

describe('shouldReseed', () => {
  it('关着 → 关着:不重新取值', () => {
    expect(shouldReseed(false, false)).toBe(false)
  })

  it('关着 → 打开:重新取值', () => {
    expect(shouldReseed(true, false)).toBe(true)
  })

  it('★开着 → 开着:不重新取值 —— 这一条保的是「人正在打字」', () => {
    expect(shouldReseed(true, true)).toBe(false)
  })

  it('打开 → 关着:不重新取值(关的时候没有 draft 可取)', () => {
    expect(shouldReseed(false, true)).toBe(false)
  })

  it('打开 → 关着 → 再打开:第二次打开重新取值(拿到当前文本,不是上次的旧草稿)', () => {
    expect(shouldReseed(false, true)).toBe(false)
    expect(shouldReseed(true, false)).toBe(true)
  })
})
