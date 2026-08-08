import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { GrowthSprite } from './GrowthSprite'
import type { GrowthPack } from '@shared/growthPet'

const PACK: GrowthPack = {
  atlas: { cols: 4, cellW: 100, cellH: 100 },
  actions: {
    idle: { row: 0, durations: [200, 200] },
    working: { row: 1, durations: [100, 100] },
  },
  stages: [
    { from: 0, name: '种子', sheet: 'gt/0-seed.png' },
    { from: 100000, name: '树干', sheet: 'gt/1-trunk.png' },
  ],
}

function el(c: HTMLElement): HTMLElement {
  const node = c.querySelector('.pet-growth')
  if (!node) throw new Error('.pet-growth 没渲染出来')
  return node as HTMLElement
}

describe('GrowthSprite', () => {
  it('按进度选阶段图', () => {
    const a = render(<GrowthSprite growth={PACK} todayTokens={40000} state="idle" reducedMotion />)
    expect(el(a.container).style.backgroundImage).toContain('0-seed.png')
    const b = render(<GrowthSprite growth={PACK} todayTokens={140000} state="idle" reducedMotion />)
    expect(el(b.container).style.backgroundImage).toContain('1-trunk.png')
  })

  it('background-size 按包自己的网格算(4 列 × 2 行)', () => {
    const { container } = render(<GrowthSprite growth={PACK} todayTokens={0} state="idle" reducedMotion />)
    expect(el(container).style.backgroundSize).toBe('400% 200%')
  })

  it('working 走 working 行', () => {
    const { container } = render(<GrowthSprite growth={PACK} todayTokens={0} state="working" reducedMotion />)
    expect(el(container).dataset.action).toBe('working')
    // row 1 of 2 → y = 100%
    expect(el(container).style.backgroundPosition).toBe('0% 100%')
  })

  it('包里没画 alert 行时回落到 idle', () => {
    const { container } = render(<GrowthSprite growth={PACK} todayTokens={0} state="confirm" reducedMotion />)
    expect(el(container).dataset.action).toBe('idle')
  })

  it('does not scale the whole atlas within a stage', () => {
    const { container } = render(<GrowthSprite growth={PACK} todayTokens={50000} state="idle" reducedMotion />)
    expect(el(container).style.getPropertyValue('--growth-sub')).toBe('')
  })

  it('预加载所有阶段图,阶段一跳就有图', () => {
    render(<GrowthSprite growth={PACK} todayTokens={0} state="idle" reducedMotion />)
    // React 19 把 <link rel="preload"> 提升到 document.head —— 那才是预加载真正生效的位置,
    // 所以断言查 head 而不是渲染容器。用例之间不会串:RTL 的 auto-cleanup 卸载组件时,
    // React 会把它提升上去的 link 一并撤掉,所以这里断长度是安全的 —— 而且比只断 href 更强,
    // 能抓住「多预加载了一张」和「同一张重复预加载」。
    const links = [...document.head.querySelectorAll('link[rel="preload"][as="image"]')]
    expect(links).toHaveLength(2)
    const hrefs = links.map((l) => l.getAttribute('href'))
    expect(hrefs).toContain('forge-pet://img/gt/0-seed.png')
    expect(hrefs).toContain('forge-pet://img/gt/1-trunk.png')
  })
})
