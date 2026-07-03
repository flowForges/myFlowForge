import { it, expect } from 'vitest'
import { BUILTIN_PROVIDERS, PROVIDER_DEFAULT_WINDOW } from './providerCatalog'

it('claude models carry a 200k context window', () => {
  const claude = BUILTIN_PROVIDERS.find(p => p.id === 'claude')!
  for (const m of claude.defaultModels) expect(m.contextWindow).toBe(200_000)
})

it('every builtin provider has a default window fallback', () => {
  for (const p of BUILTIN_PROVIDERS) expect(PROVIDER_DEFAULT_WINDOW[p.id]).toBeGreaterThan(0)
})
