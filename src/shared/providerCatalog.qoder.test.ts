import { describe, it, expect } from 'vitest'
import { getBuiltinProvider } from './providerCatalog'

describe('qoder provider', () => {
  it('auth command is qodercli login', () => {
    const q = getBuiltinProvider('qoder')!
    expect(q.authCmd).toBe('qodercli login')
    expect(q.installHelp).toMatch(/qodercli login/)
  })
})
