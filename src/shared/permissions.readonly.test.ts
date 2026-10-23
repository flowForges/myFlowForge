import { describe, it, expect } from 'vitest'
import { providerEnforcesReadonly, providerSupportsPermissions, READONLY_ENFORCED_PROVIDERS } from './permissions'

describe('providerEnforcesReadonly', () => {
  it('providers whose readonly launch is a hard restriction', () => {
    for (const p of ['claude', 'codex', 'qoder', 'pi', 'opencode', 'trae', 'kimi']) expect(providerEnforcesReadonly(p)).toBe(true)
  })
  it('ACP providers only while their ACP gate is up', () => {
    for (const p of ['gemini', 'qwen', 'copilot']) {
      expect(providerEnforcesReadonly(p)).toBe(true)
      expect(providerEnforcesReadonly(p, true)).toBe(false)
    }
  })
  it('antigravity / cursor / reasonix / unknown do not enforce readonly', () => {
    for (const p of ['antigravity', 'deepseek', 'cursor', 'reasonix', 'whatever']) expect(providerEnforcesReadonly(p)).toBe(false)
  })
  it('does not widen PERMISSION_AWARE_PROVIDERS (auto/full still mean nothing for pi/opencode/trae/kimi)', () => {
    for (const p of ['pi', 'opencode', 'trae', 'kimi']) expect(providerSupportsPermissions(p)).toBe(false)
    expect(READONLY_ENFORCED_PROVIDERS).not.toContain('antigravity')
  })
})
