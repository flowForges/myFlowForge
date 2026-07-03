import { it, expect } from 'vitest'
import { providerSupportsResume } from './resumeSupport'

it('claude/cursor/qoder/codex support native resume', () => {
  expect(providerSupportsResume('claude')).toBe(true)
  expect(providerSupportsResume('cursor')).toBe(true)
  expect(providerSupportsResume('qoder')).toBe(true)
  expect(providerSupportsResume('codex')).toBe(true)
})
it('gemini does not (text preamble fallback)', () => {
  expect(providerSupportsResume('gemini')).toBe(false)
})
