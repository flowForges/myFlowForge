import { describe, it, expect } from 'vitest'
import { branchSlug, dateSuffix, deriveWorkBranch } from './branchName'

// 固定日期,避免测试跟着今天走(2026-08-07 → 0807)。
const DAY = new Date(2026, 7, 7)

describe('branchName', () => {
  it('slugs an ascii alias: lowercase, spaces/punct → single -, trimmed', () => {
    expect(branchSlug('My Blog System')).toBe('my-blog-system')
    expect(branchSlug('  Feature: Auth!!  ')).toBe('feature-auth')
    expect(branchSlug('a__b--c')).toBe('a__b-c')   // '-' runs collapse; valid '_' kept as-is
  })

  it('dateSuffix 是零填充的 MMDD', () => {
    expect(dateSuffix(DAY)).toBe('0807')
    expect(dateSuffix(new Date(2026, 0, 1))).toBe('0101')
    expect(dateSuffix(new Date(2026, 11, 31))).toBe('1231')
  })

  it('deriveWorkBranch uses the feat/ prefix and appends the date', () => {
    expect(deriveWorkBranch('My Blog', DAY)).toBe('feat/my-blog-0807')
  })

  it('★同一个工作区名在不同日子生成不同分支(同名工作区不再撞车)', () => {
    const a = deriveWorkBranch('go-blog', new Date(2026, 7, 7))
    const b = deriveWorkBranch('go-blog', new Date(2026, 7, 8))
    expect(a).toBe('feat/go-blog-0807')
    expect(b).toBe('feat/go-blog-0808')
    expect(a).not.toBe(b)
  })

  it('an all-CJK alias never yields a CJK branch — falls back to feat/ws-<hash>-<date>', () => {
    const b = deriveWorkBranch('我的博客', DAY)
    expect(b).toMatch(/^feat\/ws-[a-z0-9]+-0807$/)              // ascii only, no CJK
    expect(b).toBe(deriveWorkBranch('我的博客', DAY))             // 同名同日 → 稳定
    // 哈希保留:否则同一天建的两个中文名工作区会撞成同一个分支
    expect(deriveWorkBranch('另一个', DAY)).not.toBe(b)
  })

  it('a mixed alias keeps the ascii part and drops CJK', () => {
    expect(deriveWorkBranch('blog博客', DAY)).toBe('feat/blog-0807')
  })

  it('不传日期时用今天(取默认值这条路也得通)', () => {
    expect(deriveWorkBranch('My Blog')).toBe(`feat/my-blog-${dateSuffix(new Date())}`)
  })
})
