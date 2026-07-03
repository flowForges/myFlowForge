import { describe, it, expect } from 'vitest'
import { sessionBadge } from './sessionBadge'
import type { ChatSession } from '@shared/types'

const base: ChatSession = { id: 'a', title: 't', mode: 'chat', createdAt: 0 }

describe('sessionBadge', () => {
  it('imported (read-only external) → import badge', () => {
    const s: ChatSession = { ...base, readonly: true, external: { source: 'claude', externalId: 'x', filePaths: [] } }
    expect(sessionBadge(s).kind).toBe('import')
  })
  it('continued spin-off → cont badge', () => {
    const s: ChatSession = { ...base, continuedFrom: { source: 'claude', externalId: 'x' } }
    expect(sessionBadge(s).kind).toBe('cont')
  })
  it('plain in-app → new', () => {
    expect(sessionBadge(base).kind).toBe('new')
  })
})
