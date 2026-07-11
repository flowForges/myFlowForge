import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { appendMessage, readWatermark, writeSession, writeWatermark } from './chatStore'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'svc-switch-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function recordingProvider(agentId: string) {
  const captured: { prompt?: string; sessionId?: string } = {}
  const provider: AgentProvider = {
    id: agentId, displayName: agentId,
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      if (!task.id.startsWith('distill-')) { captured.prompt = task.prompt; captured.sessionId = task.sessionId }
      cb.onSession('native-sess-1')
      cb.onAssistantDelta('ok')
      cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) }
    },
  }
  return { provider, captured }
}

const basePayload = (agent: string, text: string) => ({
  workspacePath: ws, sessionId: 's1', agent, agentLabel: agent, model: 'default', text, attachments: [],
})

describe('chatService provider-switch 3-branch preamble selection', () => {
  it('branch 1: no native session yet for this provider -> FULL local history preamble', async () => {
    // Prior conversation exists (e.g. produced by a different provider), but 'claude' has never had
    // a native session in this chat session -> readSession(...) undefined -> hasSession=false.
    appendMessage(ws, 's1', { id: 'u0', who: 'user', text: '早前问题ONE', ts: '' })
    appendMessage(ws, 's1', { id: 'a0', who: 'ai', text: '早前回答ONE', ts: '', provider: 'qoder' })

    const { provider, captured } = recordingProvider('claude')
    await sendTurn(basePayload('claude', '新一轮'), { provider, env: process.env, emit: () => {} })

    expect(captured.prompt).toContain('早前问题ONE')
    expect(captured.prompt).toContain('早前回答ONE')
    // watermark updated to cover this turn (2 prior + user + assistant this turn = 4)
    expect(readWatermark(ws, 's1', 'claude')).toBe(4)
  })

  it('branch 2: has native session but watermark behind latest -> INCREMENTAL preamble (only messages from watermark onward)', async () => {
    // claude ran turn 1 (2 messages), got a native session, watermark caught up to 2.
    appendMessage(ws, 's1', { id: 'u0', who: 'user', text: '第一问EARLY', ts: '' })
    appendMessage(ws, 's1', { id: 'a0', who: 'ai', text: '第一答EARLY', ts: '', provider: 'claude' })
    writeSession(ws, 's1', 'claude', 'claude-sess-1')
    writeWatermark(ws, 's1', 'claude', 2)
    // Meanwhile codex ran for a while (2 more messages) that claude never saw.
    appendMessage(ws, 's1', { id: 'u1', who: 'user', text: '第二问MID', ts: '' })
    appendMessage(ws, 's1', { id: 'a1', who: 'ai', text: '第二答MID', ts: '', provider: 'codex' })

    const { provider, captured } = recordingProvider('claude')
    await sendTurn(basePayload('claude', '切回来了'), { provider, env: process.env, emit: () => {} })

    expect(captured.prompt).not.toContain('第一问EARLY')
    expect(captured.prompt).not.toContain('第一答EARLY')
    expect(captured.prompt).toContain('第二问MID')
    expect(captured.prompt).toContain('第二答MID')
    expect(captured.prompt).toContain('离开期间')
    // native resume id still used (claude keeps its own continuity via --resume)
    expect(captured.sessionId).toBe('claude-sess-1')
    // watermark advances to cover everything through this turn (4 prior + user + assistant = 6)
    expect(readWatermark(ws, 's1', 'claude')).toBe(6)
  })

  it('error path: watermark is NOT advanced on a failed turn (so a later switch-back still catches up)', async () => {
    appendMessage(ws, 's1', { id: 'u0', who: 'user', text: '早前问题', ts: '' })
    appendMessage(ws, 's1', { id: 'a0', who: 'ai', text: '早前回答', ts: '', provider: 'claude' })
    writeSession(ws, 's1', 'claude', 'claude-sess-1')
    writeWatermark(ws, 's1', 'claude', 2)

    const provider: AgentProvider = {
      id: 'claude', displayName: 'claude',
      capabilities: { structuredOutput: true, permissionHook: true, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
      chat(task: ChatTask, cb: ChatCallbacks) {
        cb.onError(new Error('boom'))
        return { id: task.id, cancel() {}, done: Promise.resolve({ ok: false }) }
      },
    }
    await sendTurn(basePayload('claude', '再问一次'), { provider, env: process.env, emit: () => {} })

    // Turn failed before the provider could absorb context -> watermark must stay at its pre-turn value,
    // NOT jump to the new message count (which would silently skip the missed context on a switch-back).
    expect(readWatermark(ws, 's1', 'claude')).toBe(2)
  })

  it('branch 3: has native session and watermark caught up -> no preamble injected (fast path)', async () => {
    appendMessage(ws, 's1', { id: 'u0', who: 'user', text: '第一问CAUGHTUP', ts: '' })
    appendMessage(ws, 's1', { id: 'a0', who: 'ai', text: '第一答CAUGHTUP', ts: '', provider: 'claude' })
    writeSession(ws, 's1', 'claude', 'claude-sess-1')
    writeWatermark(ws, 's1', 'claude', 2) // == latest (2 messages so far)

    const { provider, captured } = recordingProvider('claude')
    await sendTurn(basePayload('claude', '继续'), { provider, env: process.env, emit: () => {} })

    expect(captured.prompt).not.toContain('第一问CAUGHTUP')
    expect(captured.prompt).not.toContain('第一答CAUGHTUP')
    expect(captured.prompt).toBe('继续')
    expect(captured.sessionId).toBe('claude-sess-1')
    // watermark advances past this turn too (2 prior + user + assistant = 4)
    expect(readWatermark(ws, 's1', 'claude')).toBe(4)
  })
})
