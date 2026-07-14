import { describe, it, expect } from 'vitest'
import { branchSlug, deriveWorkBranch } from './branchName'

describe('branchName', () => {
  it('slugs an ascii alias: lowercase, spaces/punct → single -, trimmed', () => {
    expect(branchSlug('My Blog System')).toBe('my-blog-system')
    expect(branchSlug('  Feature: Auth!!  ')).toBe('feature-auth')
    expect(branchSlug('a__b--c')).toBe('a__b-c')   // '-' runs collapse; valid '_' kept as-is
  })

  it('deriveWorkBranch uses the feat/ prefix', () => {
    expect(deriveWorkBranch('My Blog')).toBe('feat/my-blog')
  })

  it('an all-CJK alias never yields a CJK branch — falls back to a stable feat/ws-<hash>', () => {
    const b = deriveWorkBranch('我的博客')
    expect(b).toMatch(/^feat\/ws-[a-z0-9]+$/)          // ascii only, no CJK
    expect(b).toBe(deriveWorkBranch('我的博客'))          // deterministic/stable
    expect(deriveWorkBranch('另一个')).not.toBe(b)        // different alias → different branch
  })

  it('a mixed alias keeps the ascii part and drops CJK', () => {
    expect(deriveWorkBranch('blog博客')).toBe('feat/blog')
  })
})
