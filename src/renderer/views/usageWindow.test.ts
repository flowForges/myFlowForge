import { it, expect } from 'vitest'
import { resolveContextWindow } from './usageWindow'
import type { ProviderInfo } from '@shared/types'

const claude: ProviderInfo = { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'opus', contextWindow: 200_000 }] }
const codex: ProviderInfo = { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'default', label: '账号默认' }] }
const defaults = { claude: 200_000, codex: 128_000 }

it('uses the model contextWindow when present', () => {
  expect(resolveContextWindow(claude, 'opus', defaults)).toBe(200_000)
})
it('falls back to the provider default when model has no window', () => {
  expect(resolveContextWindow(codex, 'default', defaults)).toBe(128_000)
})
it('falls back to 200k when provider unknown', () => {
  expect(resolveContextWindow(undefined, 'x', defaults)).toBe(200_000)
})
