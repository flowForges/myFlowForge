import { describe, it, expect } from 'vitest'
import { EventBus } from './eventBus'
import type { EngineEvent } from '@shared/types'

describe('EventBus', () => {
  it('delivers emitted engine events to subscribers and supports unsubscribe', () => {
    const bus = new EventBus()
    const got: EngineEvent[] = []
    const off = bus.subscribe(e => got.push(e))
    bus.emit({ type: 'agent:state', agentId: 'a1', state: 'run' })
    off()
    bus.emit({ type: 'agent:state', agentId: 'a1', state: 'ok' })
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual({ type: 'agent:state', agentId: 'a1', state: 'run' })
  })
})
