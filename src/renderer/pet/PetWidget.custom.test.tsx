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
})
