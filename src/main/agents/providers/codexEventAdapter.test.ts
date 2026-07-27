import { describe, it, expect } from 'vitest'
import { adaptCodexEvent } from './codexEventAdapter'
import { parseCodexEvent, codexToolActivity } from './codex'

describe('adaptCodexEvent', () => {
  it('adapts an agentMessage delta to a streamable assistant delta', () => {
    const e = adaptCodexEvent({ method: 'item/agentMessage/delta', params: { delta: 'hel' } })
    expect(parseCodexEvent(e)).toEqual([{ kind: 'assistant', text: 'hel' }])
  })
  it('adapts a completed agentMessage to assistant-final', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: 'done' } } })
    expect(parseCodexEvent(e)).toEqual([{ kind: 'assistant-final', text: 'done' }])
  })
  it('adapts a completed commandExecution so codexToolActivity renders it', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls -la', output: 'x', exit_code: 0 } } })
    const act = codexToolActivity(e)
    expect(act?.id).toBe('c1'); expect(act?.phase).toBe('done'); expect(act?.title).toContain('ls -la')
  })
  it('adapts an item.started commandExecution to a live row', () => {
    const e = adaptCodexEvent({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'ls' } } })
    expect(codexToolActivity(e)?.phase).toBe('start')
  })
  it('adapts a fileChange to an edit step', () => {
    const e = adaptCodexEvent({ method: 'item/completed', params: { item: { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts' }] } } })
    expect(codexToolActivity(e)?.title).toContain('a.ts')
  })
  it('returns null for chatty notifications', () => {
    expect(adaptCodexEvent({ method: 'thread/tokenUsage/updated', params: {} })).toBeNull()
    expect(adaptCodexEvent({ method: 'mcpServer/startupStatus/updated', params: {} })).toBeNull()
  })
})
