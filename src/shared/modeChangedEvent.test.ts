import { describe, it, expect } from 'vitest'
import type { ChatEvent } from './types'

describe('ChatEvent mode-changed', () => {
  it('carries sessionId + mode + optional runId and narrows to workflow', () => {
    const e: ChatEvent = { workspacePath: '/w', sessionId: 's-1', type: 'mode-changed', mode: 'workflow', runId: 'r-1' }
    expect(e.type).toBe('mode-changed')
    if (e.type === 'mode-changed') { expect(e.mode).toBe('workflow'); expect(e.runId).toBe('r-1') }
  })
  it('mode-changed back to chat omits runId', () => {
    const e: ChatEvent = { workspacePath: '/w', sessionId: 's-1', type: 'mode-changed', mode: 'chat' }
    if (e.type === 'mode-changed') expect(e.runId).toBeUndefined()
  })
})
