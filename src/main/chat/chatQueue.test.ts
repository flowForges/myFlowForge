import { describe, it, expect, vi } from 'vitest'
import { ChatQueue } from './chatQueue'
import type { ChatSendPayload } from '@shared/types'

const mk = (ws: string, text: string, agent = 'claude'): ChatSendPayload =>
  ({ workspacePath: ws, sessionId: 's1', agent, agentLabel: 'Claude Code', model: 'opus-4.8', text, attachments: [] })

describe('ChatQueue', () => {
  it('runs immediately when idle; queues when busy; FIFO after done', async () => {
    const calls: string[] = []
    let release: (() => void) | null = null
    const runTurn = vi.fn((p: ChatSendPayload) => { calls.push(p.text); return new Promise<void>(res => { release = res }) })
    const events: any[] = []
    const q = new ChatQueue(runTurn, (_ch, e) => events.push(e))
    q.enqueue(mk('/w', 'A'), '你')
    expect(calls).toEqual(['A'])
    q.enqueue(mk('/w', 'B'), '你')
    expect(calls).toEqual(['A'])
    const last = events[events.length - 1]
    expect(last.busy).toBe(true)
    expect(last.queue.map((x: any) => x.text)).toEqual(['B'])
    release!(); await Promise.resolve(); await Promise.resolve()
    expect(calls).toEqual(['A', 'B'])
  })

  it('different workspaces run concurrently (independent queues)', () => {
    const calls: string[] = []
    const runTurn = vi.fn((p: ChatSendPayload) => { calls.push(p.workspacePath); return new Promise<void>(() => {}) })
    const q = new ChatQueue(runTurn, () => {})
    q.enqueue(mk('/w1', 'A'), '你')
    q.enqueue(mk('/w2', 'B'), '你')
    expect(calls).toEqual(['/w1', '/w2'])
  })

  it('runTurn rejection still frees busy and continues the queue', async () => {
    const calls: string[] = []
    const runTurn = vi.fn((p: ChatSendPayload) => { calls.push(p.text); return p.text === 'A' ? Promise.reject(new Error('x')) : Promise.resolve() })
    const q = new ChatQueue(runTurn, () => {})
    q.enqueue(mk('/w', 'A'), '你')
    q.enqueue(mk('/w', 'B'), '你')
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual(['A', 'B'])
  })

  it('cancel removes a queued item; clear empties; running item unaffected', () => {
    const runTurn = vi.fn(() => new Promise<void>(() => {}))
    const events: any[] = []
    const q = new ChatQueue(runTurn, (_c, e) => events.push(e))
    q.enqueue(mk('/w', 'A'), '你')
    q.enqueue(mk('/w', 'B'), '你')
    q.enqueue(mk('/w', 'C'), '宠物')
    const idB = events[events.length - 1].queue[0].id
    q.cancel('/w', idB)
    expect(events[events.length - 1].queue.map((x: any) => x.text)).toEqual(['C'])
    q.clear('/w')
    expect(events[events.length - 1].queue).toEqual([])
    expect(runTurn).toHaveBeenCalledTimes(1)
  })

  it('broadcast projects only {id,text,source}; keeps source', () => {
    let lastEvent: any
    const q = new ChatQueue(() => new Promise<void>(() => {}), (_c, e) => { lastEvent = e })
    q.enqueue(mk('/w', 'A'), '你')
    q.enqueue(mk('/w', 'B'), '宠物')
    expect(lastEvent.workspacePath).toBe('/w')
    expect(lastEvent.queue).toEqual([{ id: expect.any(String), text: 'B', source: '宠物' }])
  })

  it('running carries {id,text,sessionId} + runningSessionId during execution, null after', async () => {
    let release: (() => void) | null = null
    const events: any[] = []
    const runTurn = vi.fn((_p: ChatSendPayload) => new Promise<void>(res => { release = res }))
    const q = new ChatQueue(runTurn, (_c, e) => events.push(e))
    q.enqueue(mk('/w', 'Hello'), '你')
    // first emit: busy=true, running set — sessionId is threaded so the sidebar can light that
    // specific session's dot, not just the workspace pill.
    const runningEvent = events[events.length - 1]
    expect(runningEvent.running).toEqual({ id: expect.any(String), text: 'Hello', sessionId: 's1' })
    expect(runningEvent.runningSessionId).toBe('s1')
    expect(runningEvent.busy).toBe(true)
    // complete the turn
    release!(); await Promise.resolve(); await Promise.resolve()
    const doneEvent = events[events.length - 1]
    expect(doneEvent.running).toBeNull()
    expect(doneEvent.runningSessionId).toBeNull()
    expect(doneEvent.busy).toBe(false)
  })

  it('stop() calls the registered activeCancel', async () => {
    const cancelSpy = vi.fn()
    let release: (() => void) | null = null
    const runTurn = vi.fn((_p: ChatSendPayload) => new Promise<void>(res => { release = res }))
    const q = new ChatQueue(runTurn, () => {})
    q.enqueue(mk('/w', 'A'), '你')
    // register the cancel fn (simulating what runTurn internals would do)
    q.registerActive('/w', cancelSpy)
    q.stop('/w')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    // resolve the turn so it cleans up
    release!(); await Promise.resolve(); await Promise.resolve()
  })

  it('stop() resolves current turn and advances to next queued item', async () => {
    const calls: string[] = []
    let releaseA: (() => void) | null = null
    const runTurn = vi.fn((p: ChatSendPayload) => {
      calls.push(p.text)
      if (p.text === 'A') return new Promise<void>(res => { releaseA = res })
      return Promise.resolve()
    })
    const q = new ChatQueue(runTurn, () => {})
    q.enqueue(mk('/w', 'A'), '你')
    q.enqueue(mk('/w', 'B'), '你')
    q.registerActive('/w', () => { releaseA?.() }) // cancel resolves A's promise
    q.stop('/w')
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual(['A', 'B'])
  })
})
