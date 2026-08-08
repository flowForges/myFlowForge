import { describe, it, expect } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { PetWidget } from './PetWidget'

describe('PetWidget custom skin', () => {
  it('renders an img with the data URL when customImages has the current state', () => {
    const src = 'data:image/png;base64,AAA'
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working" customImages={{ working: src }} />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(src)
    expect(container.querySelector('.pet-image-stack')).not.toBeNull()
    expect(img!.classList.contains('pet-image-front')).toBe(true)
  })

  it('falls back to the sprite SVG when customImages is missing the current state', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working" customImages={{}} />
    )
    // No img rendered — fallback is the sprite SVG
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders the imported emoji (tinted) when no image but customEmoji is set', () => {
    const { container, getByText } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="idle" customEmoji={{ name: '豆豆', emoji: '🐱', color: 'oklch(72% .16 30)' }} />
    )
    expect(container.querySelector('img')).toBeNull()
    const emoji = getByText('🐱')
    expect(emoji.classList.contains('pet-emoji')).toBe(true)
    expect((container.querySelector('[data-skin="custom-emoji"]') as HTMLElement).style.color).toContain('oklch')
  })

  it('prefers a per-state image over the emoji when both are set', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working"
        customImages={{ working: 'data:image/png;base64,AAA' }} customEmoji={{ name: 'x', emoji: '🐱', color: '' }} />
    )
    expect(container.querySelector('img')).not.toBeNull()
    expect(container.querySelector('.pet-emoji')).toBeNull()
  })

  it('keeps anim and accent classes on the pet wrapper when custom image is shown', () => {
    const src = 'data:image/png;base64,AAA'
    const { container } = render(
      <PetWidget skin="custom" anim="spin-halo" accent="warn" state="idle" customImages={{ idle: src }} />
    )
    const wrapper = container.querySelector('.pet')
    expect(wrapper?.classList.contains('pet-anim-spin-halo')).toBe(true)
    expect(wrapper?.classList.contains('pet-accent-warn')).toBe(true)
  })

  it('falls back to the idle image when the current state has no image', () => {
    const idleSrc = 'data:image/png;base64,IDLE'
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working" customImages={{ idle: idleSrc }} />
    )
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(idleSrc)
  })

  it('still prefers the per-state image over the idle fallback', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working"
        customImages={{ idle: 'data:image/png;base64,IDLE', working: 'data:image/png;base64,WORK' }} />
    )
    expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,WORK')
  })

  it('falls back to the sprite SVG when a custom image fails to load', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="idle" customImages={{ idle: 'missing/idle.gif' }} />
    )
    const img = container.querySelector('img')!
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('renders the atlas sprite when the custom pet has an atlas', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="working"
        atlas={{ path: 'p1/spritesheet.webp', version: 2 }} action="running" />,
    )
    const el = container.querySelector('.pet-atlas') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.getAttribute('style') ?? '').toContain('forge-pet://img/p1/spritesheet.webp')
    // the legacy <img> path is NOT used
    expect(container.querySelector('.pet-image-front')).toBeNull()
  })

  it('still renders the legacy image path when no atlas', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="idle" customImages={{ idle: 'p2/idle.webp' }} />,
    )
    expect(container.querySelector('.pet-atlas')).toBeNull()
  })

  // 成长包优先级最高:growth > codex atlas > 逐状态图 > emoji。
  it('renders the growth sprite (and nothing else) when the custom pet has a growth pack', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="float" accent="none" state="idle" growthProgress={0.6}
        growth={{
          atlas: { cols: 4, cellW: 100, cellH: 100 },
          actions: { idle: { row: 0, durations: [200, 200] } },
          stages: [{ at: 0, sheet: 'g1/0.png' }, { at: 0.5, sheet: 'g1/1.png' }],
        }}
        atlas={{ path: 'p1/spritesheet.webp', version: 2 }} action="running"
        customImages={{ idle: 'p2/idle.webp' }} customEmoji={{ name: 'x', emoji: '🐱', color: '' }} />,
    )
    const el = container.querySelector('.pet-growth') as HTMLElement
    expect(el).toBeTruthy()
    expect(el.style.backgroundImage).toContain('forge-pet://img/g1/1.png')
    expect(container.querySelector('.pet-atlas')).toBeNull()
    expect(container.querySelector('.pet-image-front')).toBeNull()
    expect(container.querySelector('.pet-emoji')).toBeNull()
  })

  // 成长包的动作完全由 atlas 行表达，宿主不能再给整棵树叠加 float/shake/spin-halo。
  it('keeps the sized .pet shell but disables whole-pet animations for growth sprites', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="spin-halo" accent="warn" state="idle"
        growth={{
          atlas: { cols: 4, cellW: 100, cellH: 100 },
          actions: { idle: { row: 0, durations: [200, 200] } },
          stages: [{ at: 0, sheet: 'g1/0.png' }],
        }} />,
    )
    const wrapper = container.querySelector('.pet') as HTMLElement
    expect(wrapper).toBeTruthy()
    expect(wrapper.dataset.skin).toBe('custom-growth')
    expect(wrapper.classList.contains('pet-anim-spin-halo')).toBe(false)
    expect(wrapper.classList.contains('pet-anim-none')).toBe(true)
    expect(wrapper.classList.contains('pet-accent-warn')).toBe(true)
    expect(wrapper.querySelector('.pet-growth')).toBeTruthy()
  })
})
