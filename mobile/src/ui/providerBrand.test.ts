import { describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDERS } from '../../../src/shared/providerCatalog'
import { brandFor, FALLBACK_BRAND, PROVIDER_BRAND } from './providerBrand'

/**
 * 这张表是 `@shared/providerCatalog` 的**手抄副本**(理由见 providerBrand.ts:RN 不认 oklch)。
 * 所以这一组测试是它唯一的对账机制 —— 少了它,电脑端加一个 provider 之后手机上那个代理的
 * 徽章就是一个空方框,而**没有任何东西会报错**。
 */
describe('providerBrand · 和电脑端那份目录对账', () => {
  it('★★内置代理一个都不能少 —— 少一个就是手机上一个空徽章,而且不报错', () => {
    const want = BUILTIN_PROVIDERS.map((p) => p.id).sort()
    expect(Object.keys(PROVIDER_BRAND).sort()).toEqual(want)
  })

  it('★字形必须和电脑端**一模一样** —— 同一个代理在两块屏幕上不该长两个样', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(PROVIDER_BRAND[p.id]?.glyph, p.id).toBe(p.glyph)
    }
  })

  it('★★颜色必须是 RN 认得的形状(#rrggbb 或 rgba()),绝不能是 oklch —— 那是这份副本存在的全部理由', () => {
    for (const [id, b] of Object.entries(PROVIDER_BRAND)) {
      expect(b.bg, `${id}.bg`).toMatch(/^rgba\(\d+, \d+, \d+, [\d.]+\)$/)
      if (b.fg !== null) expect(b.fg, `${id}.fg`).toMatch(/^#[0-9a-f]{6}$/)
      expect(b.bg, `${id}.bg`).not.toContain('oklch')
      expect(b.fg ?? '', `${id}.fg`).not.toContain('oklch')
    }
  })

  it('★电脑端写 var(--accent) 的,这边必须是 null(跟着皮肤走),不能抄一个死值', () => {
    for (const p of BUILTIN_PROVIDERS) {
      const mine = PROVIDER_BRAND[p.id]
      if (p.brandColor === 'var(--accent)') expect(mine?.fg, p.id).toBeNull()
      else expect(mine?.fg, p.id).not.toBeNull()
    }
  })

  it('底色的透明度要和电脑端那份一致(徽章压在任何背景上都该是同一个分量)', () => {
    for (const p of BUILTIN_PROVIDERS) {
      const wantAlpha = /\/\s*([\d.]+)\s*\)/.exec(p.brandBg)?.[1]
      if (!wantAlpha) continue
      const gotAlpha = /,\s*([\d.]+)\)$/.exec(PROVIDER_BRAND[p.id]!.bg)?.[1]
      expect(Number(gotAlpha), p.id).toBeCloseTo(Number(wantAlpha), 5)
    }
  })

  it('没见过的 id 回落到兜底,**不返回 undefined**', () => {
    expect(brandFor('某个自定义代理')).toBe(FALLBACK_BRAND)
    expect(brandFor('')).toBe(FALLBACK_BRAND)
    expect(FALLBACK_BRAND.glyph).toBeTruthy()
  })

  it('★兜底的字色也是 null —— 自定义代理没有品牌色,该跟着皮肤的 accent 走', () => {
    expect(FALLBACK_BRAND.fg).toBeNull()
  })
})
