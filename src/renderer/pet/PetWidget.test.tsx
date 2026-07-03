import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PetWidget } from './PetWidget'

describe('PetWidget', () => {
  it('applies the anim + accent classes', () => {
    const { container } = render(<PetWidget skin="sprite" anim="spin-halo" accent="warn" />)
    expect(container.querySelector('.pet.pet-anim-spin-halo.pet-accent-warn')).not.toBeNull()
  })
  it('reflects the skin via data-skin and renders an svg', () => {
    const { container } = render(<PetWidget skin="bot" anim="float" accent="none" />)
    const root = container.querySelector('.pet')!
    expect(root.getAttribute('data-skin')).toBe('bot')
    expect(root.querySelector('svg')).not.toBeNull()
  })
  it('renders a distinct svg per skin', () => {
    const ghost = render(<PetWidget skin="ghost" anim="float" accent="none" />).container.querySelector('svg')!.innerHTML
    const sprite = render(<PetWidget skin="sprite" anim="float" accent="none" />).container.querySelector('svg')!.innerHTML
    expect(ghost).not.toBe(sprite)
  })
  it('renders 3 orbiting stars when anim=sparkle', () => {
    const { container } = render(<PetWidget skin="sprite" anim="sparkle" accent="none" />)
    const wrap = container.querySelector('.pet-stars')
    expect(wrap).not.toBeNull()
    expect(wrap!.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.pet-stars .ps').length).toBe(3)
  })
  it('does not render stars for other anims', () => {
    const { container } = render(<PetWidget skin="sprite" anim="float" accent="none" />)
    expect(container.querySelector('.pet-stars')).toBeNull()
  })
  it('renders stars on custom-emoji skins too when anim=sparkle', () => {
    const { container } = render(
      <PetWidget skin="custom" anim="sparkle" accent="none" customEmoji={{ name: 'cat', emoji: '🐱', color: '' }} />
    )
    expect(container.querySelectorAll('.pet-stars .ps').length).toBe(3)
  })
})
