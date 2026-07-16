import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PetAtlasSprite } from './PetAtlasSprite'

const style = (el: HTMLElement) => el.getAttribute('style') ?? ''

describe('PetAtlasSprite', () => {
  it('renders the atlas as background with 800% 1100% sizing', () => {
    const { container } = render(<PetAtlasSprite atlasPath="p1/spritesheet.webp" action="idle" />)
    const el = container.querySelector('.pet-atlas') as HTMLElement
    expect(style(el)).toContain('forge-pet://img/p1/spritesheet.webp')
    expect(style(el)).toContain('background-size: 800% 1100%')
  })

  it('idle frame 0 sits at background-position 0% 0% (row 0 col 0)', () => {
    const { container } = render(<PetAtlasSprite atlasPath="p1/spritesheet.webp" action="idle" />)
    const el = container.querySelector('.pet-atlas') as HTMLElement
    expect(style(el)).toContain('background-position: 0% 0%')
  })

  it('a look angle overrides animation with the static look cell (90° → row 9 col 4 → 57.14% 90%)', () => {
    const { container } = render(<PetAtlasSprite atlasPath="p1/spritesheet.webp" action="idle" lookDeg={90} />)
    const el = container.querySelector('.pet-atlas') as HTMLElement
    // col 4 of 8 → 4/7*100 = 57.142857%, row 9 of 11 → 9/10*100 = 90%
    expect(style(el)).toMatch(/background-position:\s*57\.14\d*% 90%/)
  })
})
