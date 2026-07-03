import { describe, it, expect } from 'vitest'
import { canContinue } from './canContinue'
import type { ChatSession } from '@shared/types'

const ro: ChatSession = {
  id: 'ext-claude-a1',
  title: 'Imported',
  mode: 'chat',
  createdAt: 0,
  readonly: true,
  external: { source: 'claude', externalId: 'a1', filePaths: ['/x.jsonl'] },
}

const roNoExternal: ChatSession = {
  id: 'ext-orphan',
  title: 'Orphan',
  mode: 'chat',
  createdAt: 0,
  readonly: true,
  // external intentionally absent
}

const writable: ChatSession = {
  id: 's-1',
  title: 'Writable',
  mode: 'chat',
  createdAt: 0,
}

describe('canContinue', () => {
  it('readonly + external + has messages → true', () => {
    expect(canContinue(ro, 3)).toBe(true)
  })
  it('readonly + external + 0 messages → false (hasBody=false / empty)', () => {
    expect(canContinue(ro, 0)).toBe(false)
  })
  it('readonly but no external → false', () => {
    expect(canContinue(roNoExternal, 5)).toBe(false)
  })
  it('non-readonly session → false', () => {
    expect(canContinue(writable, 10)).toBe(false)
  })
})
