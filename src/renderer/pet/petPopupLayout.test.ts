import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the pet popup layout fix: the popup must be a viewport-bounded flex column so a tall
// content set (pending confirm card + workspace list + footer) never overflows the pet window and
// gets clipped at the top ("方案设计确认被覆盖看不到"). Only the body scrolls; head/footer stay pinned.
const css = readFileSync(join(__dirname, 'pet.css'), 'utf8')

function block(selector: string): string {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
  return css.match(re)?.[1] ?? ''
}

describe('pet popup layout (no clipping)', () => {
  it('makes .pet-pop a flex column bounded to the viewport', () => {
    const b = block('.pet-pop')
    expect(b).toMatch(/display:\s*flex/)
    expect(b).toMatch(/flex-direction:\s*column/)
    expect(b).toMatch(/max-height:\s*calc\(100vh/)
  })

  it('lets only the body scroll (flex-shrink + min-height:0), not a fixed 380px cap', () => {
    const b = block('.pet-pop-body')
    expect(b).toMatch(/overflow-y:\s*auto/)
    expect(b).toMatch(/min-height:\s*0/)
    expect(b).not.toMatch(/max-height:\s*380px/)
  })
})
