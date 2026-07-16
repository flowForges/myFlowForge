import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLive, readLive, clearLive, mergeLive } from './liveTurns'
import { sendTurn } from './chatService'
import { readMessages } from './chatStore'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatMessage, ChatSendPayload } from '@shared/types'

const aiMsg = (id: string, text: string): ChatMessage => ({ id, who: 'ai', text, ts: '' })

describe('liveTurns buffer', () => {
  it('set/read/clear round-trips and is keyed per (ws, sid)', () => {
    setLive('/w', 's1', aiMsg('a1', 'hi'))
    expect(readLive('/w', 's1')?.id).toBe('a1')
    expect(readLive('/w', 's2')).toBeUndefined()
    clearLive('/w', 's1')
    expect(readLive('/w', 's1')).toBeUndefined()
  })

  it('clearLive with a stale id does not wipe a newer turn that replaced the entry', () => {
    setLive('/w', 's1', aiMsg('old', 'x'))
    setLive('/w', 's1', aiMsg('new', 'y')) // a second turn started
    clearLive('/w', 's1', 'old')           // old turn finishing late must not clobber the new one
    expect(readLive('/w', 's1')?.id).toBe('new')
    clearLive('/w', 's1', 'new')
    expect(readLive('/w', 's1')).toBeUndefined()
  })

  it('mergeLive appends the in-flight message unless already persisted', () => {
    const history = [aiMsg('h1', 'done')]
    setLive('/w', 's1', aiMsg('live', 'streaming…'))
    expect(mergeLive('/w', 's1', history).map(m => m.id)).toEqual(['h1', 'live'])
    // once persisted under the same id, it must not double-count
    setLive('/w', 's1', aiMsg('h1', 'streaming…'))
    expect(mergeLive('/w', 's1', history).map(m => m.id)).toEqual(['h1'])
    clearLive('/w', 's1')
    expect(mergeLive('/w', 's1', history).map(m => m.id)).toEqual(['h1'])
  })
})

describe('sendTurn live buffer', () => {
  let ws: string
  beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'live-')) })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  const payload = (text: string): ChatSendPayload => ({
    workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude', model: 'opus', text, attachments: [],
  })

  // A provider that streams a delta then hands back control so the test can inspect the live buffer
  // mid-stream before completing the turn.
  function deferredProvider(): { provider: AgentProvider; finish: () => void } {
    let doneCb: (() => void) | undefined
    const provider: AgentProvider = {
      id: 'claude', displayName: 'Claude',
      capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
      chat(task: ChatTask, cb: ChatCallbacks) {
        if (!task.id.startsWith('distill-')) {
          cb.onSession('sess-1')
          cb.onAssistantDelta('部分')
          cb.onAssistantDelta('输出')
          doneCb = () => cb.onDone({ elapsed: 1 })
        } else {
          cb.onDone({ elapsed: 0 })
        }
        return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) }
      },
    }
    return { provider, finish: () => doneCb?.() }
  }

  it('exposes accumulated in-flight text via mergeLive mid-stream, then clears on done', async () => {
    const { provider, finish } = deferredProvider()
    const turn = sendTurn(payload('hi'), { provider, env: process.env, emit: () => {} })

    // Mid-stream: not yet persisted (only the user message is on disk), but the live buffer holds the
    // already-streamed assistant text — this is exactly what a switch-away-and-back must recover.
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user'])
    const merged = mergeLive(ws, 's1', readMessages(ws, 's1'))
    expect(merged.map(m => m.who)).toEqual(['user', 'ai'])
    const liveAi = merged[1]
    expect(liveAi.text).toBe('部分输出')
    expect(liveAi.ts).toBe('') // marks it as still-streaming for the renderer

    finish()
    await turn

    // After done: assistant persisted, live buffer cleared → no duplicate.
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user', 'ai'])
    expect(readLive(ws, 's1')).toBeUndefined()
    expect(mergeLive(ws, 's1', readMessages(ws, 's1')).map(m => m.who)).toEqual(['user', 'ai'])
  })
})
