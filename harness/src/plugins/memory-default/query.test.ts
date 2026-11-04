// 中文全文检索(06 spec §2、§5):语料和 spike 同形;两份 SQLite(vitest 的系统 Node、e2e 的 Electron Node)跑同样的查询
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildMatch, excerpt, windowTerms } from './query'
import { openStore, type Store } from './store'

const log = { info() {}, warn() {}, error() {}, debug() {} }

const CORPUS = [
  '发布流程:先跑测试,再打 tag,最后推到发布分支',
  '夜间整合昨晚失败了,日志里写着数据库被锁',
  '夜间整合的触发时间改到凌晨三点',
  '记忆插件用中文全文检索,短词走退路',
  'dev server 跑在 5173 端口,库在 postgres://***@10.0.0.5:5432/db,工具叫 apply_patch',
  '用户喜欢用 pnpm 做包管理器,不用 npm',
  'Hello World from the raw layer',
  '这个为什么不行呢',
  '折扣 50% 起,路径 C:\\temp 🎉',
]

let dir: string
let store: Store
const hits = (q: string) => store.searchRaw({ q, scopes: ['owner'], limit: 20 }).map(r => r.seq)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-query-'))
  store = openStore(join(dir, 'memory.sqlite'), { log })
  CORPUS.forEach((text, i) => store.insertRaw({ seq: i + 1, ts: i, sessionId: `s${i}`, turnId: `t${i}`, role: 'user', origin: 'app', scope: 'owner', text }))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('buildMatch', () => {
  it('quotes every long word, doubles inner quotes, leaves short words to LIKE', () => {
    expect(buildMatch('发布流程 a"b 记忆')).toEqual({ match: '"发布流程" AND "a""b"', likes: ['%记忆%'], terms: ['发布流程', 'a"b', '记忆'] })
  })

  it('counts code points: a pair of emoji is short, three are not', () => {
    expect(buildMatch('🎉🎉').match).toBeUndefined()
    expect(buildMatch('🎉🎉🎉').match).toBe('"🎉🎉🎉"')
  })

  it('escapes LIKE wildcards with a backslash', () => {
    expect(buildMatch('%').likes).toEqual(['%\\%%'])
    expect(buildMatch('_').likes).toEqual(['%\\_%'])
    expect(buildMatch('\\').likes).toEqual(['%\\\\%'])
  })

  it('an empty query has nothing to run', () => {
    expect(buildMatch(' \u3000\n')).toEqual({ likes: [], terms: [] })
  })

  it('drops invisible characters and NUL, which would end the quoted string early', () => {
    expect(buildMatch('发布\u200b流程').match).toBe('"发布流程"')
    expect(buildMatch('abc\0def').match).toBe('"abcdef"')
  })
})

describe('windowTerms', () => {
  it('slides a 3-character window with stride 1 over each CJK run', () => {
    expect(windowTerms('夜间整合')).toEqual(['夜间整', '间整合'])
    expect(windowTerms('记忆')).toEqual([])
  })

  it('keeps Latin and digit words whole, ahead of the windows, and drops short ones', () => {
    expect(windowTerms('用 pnpm 做包管理 at 10.0.0.5:5432')).toEqual(['pnpm', '10.0.0.5:5432', '做包管', '包管理'])
  })

  it('caps at max, without repeats', () => {
    expect(windowTerms('一二三四五六七八九十', 3)).toEqual(['一二三', '二三四', '三四五'])
    expect(windowTerms('一二三一二三')).toEqual(['一二三', '二三一', '三一二'])
    expect(windowTerms('一二三四五六七八九十'.repeat(10)).length).toBeLessThanOrEqual(24)
  })

  it('does not cut an emoji in half', () => {
    expect(windowTerms('🎉🎉🎉🎉')).toEqual([])
  })
})

describe('excerpt', () => {
  it('takes the radius on each side of the first hit, in code points', () => {
    const text = `${'🎉'.repeat(100)}夜间整合${'🎉'.repeat(100)}`
    const out = excerpt(text, ['夜间整合'], 2)
    expect(out).toBe('…🎉🎉夜间整合🎉🎉…')
  })

  it('picks the earliest hit of any term, ignoring case', () => {
    expect(excerpt('aaa bbb HELLO ccc world', ['world', 'hello'], 3)).toBe('…bb HELLO cc…')
  })

  it('no hit: the head of the text', () => {
    expect(excerpt('一二三四五六', ['无'], 1)).toBe('一二…')
  })

  it('a term with regex characters is literal', () => {
    expect(excerpt('a(b)c', ['(b)'], 1)).toBe('a(b)c')
  })
})

describe('Chinese search on this SQLite', () => {
  it('prints which SQLite this is', () => {
    const { v } = store.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
    console.log(`memory search ran on SQLite ${v}, Node ${process.version}`)
    expect(v).toMatch(/^3\./)
  })

  it('a 4-character word finds its document', () => {
    expect(hits('发布流程')).toEqual([1])
  })

  it('夜间整合 hits both, and the excerpt holds it uncut', () => {
    const rows = store.searchRaw({ q: '夜间整合', scopes: ['owner'], limit: 20 })
    expect(rows.map(r => r.seq).sort()).toEqual([2, 3])
    for (const r of rows) expect(r.excerpt).toContain('夜间整合')
  })

  it('2-character words hit through LIKE', () => {
    expect(hits('记忆')).toEqual([4])
    expect(hits('中文')).toEqual([4])
  })

  it('short words and long words mix', () => {
    expect(hits('记忆 插件')).toEqual([4])
    expect(hits('记忆 全文检索')).toEqual([4])
    expect(hits('端口 5173')).toEqual([5])
  })

  it.each([['5173'], ['10.0.0.5:5432'], ['apply_patch'], ['postgres://']])('%s hits verbatim', q => {
    expect(hits(q)).toEqual([5])
  })

  it('search ignores case', () => {
    expect(hits('HELLO')).toEqual([7])
  })

  it('a single emoji is found and does not throw', () => {
    expect(hits('🎉')).toEqual([9])
  })
})

describe('nothing in a query is syntax', () => {
  it.each([
    ['"', []],
    ['a"b', []],
    ['text:x', []],
    ['NEAR(x)', []],
    ['*', [5]], // 字面的星号:第 5 条的 ***
    ['(', []],
    ['^abc', []],
    ['abc*', []],
    ['"abc" OR "def"', [7]], // OR 只是两个字母,退到 LIKE:World 里有
    ['text:"xyz"', []],
    ['NOT', []],
    ['%', [9]],
    ['\\', [9]],
    ['_', [5]],
    ['OR', [7]], // 只是两个字母:World 里有
  ] as [string, number[]][])('%s', (q, want) => {
    expect(hits(q)).toEqual(want)
    expect(() => store.searchNotes({ q, scopes: ['owner'], layers: ['memory'], limit: 5 })).not.toThrow()
    expect(() => store.recallUserRaw({ q, excludeSession: 'x', limit: 5 })).not.toThrow()
  })

  it('FTS syntax reaches MATCH inside quotes', () => {
    expect(buildMatch('text:发布流程').match).toBe('"text:发布流程"')
    expect(buildMatch('NEAR(abc)').match).toBe('"NEAR(abc)"')
    expect(buildMatch('abc* OR').match).toBe('"abc*"')
    // 列过滤要是生效了,这两条都该命中第 1 条
    expect(buildMatch('text:发布流程').likes).toEqual([])
    expect(store.searchRaw({ q: 'text:发布流程和别的不存在的长串文本内容abc', scopes: ['owner'], limit: 5 }).map(r => r.seq)).toEqual([1])
  })
})

describe('natural language', () => {
  it('a question finds the pnpm document through the OR fallback', () => {
    expect(hits('用户喜欢什么包管理器')).toEqual([6])
  })

  it('an unrelated sentence finds nothing', () => {
    expect(hits('今天的任务是修复登录页面的样式问题')).toEqual([])
  })

  it('short words get an OR fallback too', () => {
    expect(hits('记忆 没有的词')).toEqual([4])
  })

  it('recall keeps two-window hits and drops one-window hits (pins stride 1)', () => {
    const rows = store.recallUserRaw({ q: '夜间整合为什么失败了', excludeSession: 'other', limit: 10 })
    // 第 8 条只命中"为什么"一个窗
    expect(rows.map(r => r.seq).sort()).toEqual([2, 3])
  })

  it('recall on an unrelated sentence finds nothing', () => {
    expect(store.recallUserRaw({ q: '今天的任务是修复登录页面的样式问题', excludeSession: 'other', limit: 10 })).toEqual([])
  })
})
