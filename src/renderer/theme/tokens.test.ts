import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8')
describe('theme tokens (fidelity guard)', () => {
  it('keeps the exact prototype accent and surface tokens', () => {
    expect(css).toContain('--accent: oklch(72% 0.15 235)')
    expect(css).toContain('--surface: oklch(26% 0.013 250)')
    expect(css).toContain('--r-lg: 14px')
  })
  it('defines a light theme override', () => {
    expect(css).toContain('[data-theme="light"]')
    expect(css).toContain('--surface: oklch(99% 0.003 250)')
  })
})
