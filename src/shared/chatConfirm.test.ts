import { describe, it, expect } from 'vitest'
import type { ChatEvent, ChatConfirm } from '@shared/types'

describe('chat confirm types', () => {
  it('models a confirm-request and confirm-resolved event', () => {
    const req: ChatEvent = { workspacePath: '/ws', sessionId: 's1', type: 'confirm-request', id: 'c1', title: 'Write theme.ts', where: 'theme.ts' }
    const res: ChatEvent = { workspacePath: '/ws', sessionId: 's1', type: 'confirm-resolved', id: 'c1' }
    const c: ChatConfirm = { id: 'c1', title: 'Write theme.ts', where: 'theme.ts' }
    expect(req.type).toBe('confirm-request')
    expect(res.type).toBe('confirm-resolved')
    expect(c.id).toBe('c1')
  })
})
