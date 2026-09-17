import { describe, it, expect } from 'vitest'
import { askAnswerNote } from './askAnswerNote'

const Q = [{ question: '要保留哪些动态功能?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }]

describe('把选择写进对话', () => {
  it('问题原文和选项一起写 —— 只写答案的话,回头看是一句没头没尾的话', () => {
    const s = askAnswerNote(Q, { '要保留哪些动态功能?': ['要评论功能'] }, undefined)!
    expect(s).toContain('要保留哪些动态功能?')
    expect(s).toContain('要评论功能')
  })

  it('多选每个都列出来', () => {
    const s = askAnswerNote(Q, { '要保留哪些动态功能?': ['浏览量', '评论', '搜索'] }, undefined)!
    expect(s).toContain('浏览量')
    expect(s).toContain('评论')
    expect(s).toContain('搜索')
  })

  it('★自由输入和选项**可以同时有**,所以是追加不是二选一', () => {
    const s = askAnswerNote(Q, { '要保留哪些动态功能?': ['评论'] }, '再加个 RSS')!
    expect(s).toContain('评论')
    expect(s).toContain('再加个 RSS')
  })

  it('只有自由输入也要留', () => {
    const s = askAnswerNote(Q, {}, '我自己写一个')!
    expect(s).toContain('我自己写一个')
  })

  it('★什么都没答就返回 null —— 不留一条空记录', () => {
    expect(askAnswerNote(Q, {}, undefined)).toBeNull()
    expect(askAnswerNote(Q, { '要保留哪些动态功能?': [] }, '   ')).toBeNull()
    expect(askAnswerNote(undefined, undefined, undefined)).toBeNull()
  })

  it('★答案对不上任何一道题(key 不匹配)就当没答 —— 绝不瞎拼', () => {
    expect(askAnswerNote(Q, { '另一道题': ['x'] }, undefined)).toBeNull()
  })
})
