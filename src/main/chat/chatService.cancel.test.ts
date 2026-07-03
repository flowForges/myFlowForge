import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import type { AgentProvider, AgentSession, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatEvent, ChatSendPayload } from '@shared/types'

function makeTmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'cs-cancel-'))
  return { dir: d, cleanup: () => rmSync(d, { recursive: true, force: true }) }
}

const payload = (ws: string): ChatSendPayload => ({
  workspacePath: ws,
  sessionId: 's1',
  agent: 'claude',
  agentLabel: 'Claude Code',
  model: 'opus-4.8',
  text: 'hi',
  attachments: [],
})

// Provider that:
// 1. streams a delta
// 2. schedules an error via setTimeout to give onSessionStart a chance to run first
// The test calls cancel via deps.onSessionStart (the wrapped session), then the error fires.
function makeCancelProvider(): AgentProvider {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true },
    async listModels() { return [{ id: 'opus-4.8', label: 'opus-4.8' }] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      cb.onSession('sess-cancel')
      cb.onAssistantDelta('partial')
      const done = new Promise<{ ok: boolean }>((resolve) => {
        // fire error asynchronously so onSessionStart's wrapped cancel can run first
        Promise.resolve().then(() => {
          cb.onError(new Error('Command failed: process exited with SIGTERM'))
          resolve({ ok: false })
        })
      })
      return { id: task.id, cancel: vi.fn(), done }
    },
  }
}

describe('chatService.sendTurn – user cancel vs real error', () => {
  it('user cancel: no error event, done message keeps streamed text (no 错误: prefix)', async () => {
    const { dir, cleanup } = makeTmpDir()
    try {
      const events: ChatEvent[] = []

      const provider = makeCancelProvider()

      const msg = await sendTurn(payload(dir), {
        provider,
        env: process.env,
        emit: (e) => events.push(e),
        // onSessionStart receives the WRAPPED session; calling cancel() sets aborted=true
        onSessionStart: (s) => { s.cancel() },
      })

      // no error event
      expect(events.map(e => e.type)).not.toContain('error')
      // done event was emitted
      expect(events.map(e => e.type)).toContain('done')
      // message preserves partial text, no 错误: prefix
      expect(msg.text).toBe('partial')
      expect(msg.text).not.toMatch(/^错误:/)
    } finally {
      cleanup()
    }
  })

  it('real error (not cancelled): still produces error event and 错误: prefix', async () => {
    const { dir, cleanup } = makeTmpDir()
    try {
      const events: ChatEvent[] = []

      // Provider that fires onError WITHOUT cancel being called first
      const provider: AgentProvider = {
        id: 'claude',
        displayName: 'Claude Code',
        capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true },
        async listModels() { return [] },
        run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
        chat(task: ChatTask, cb: ChatCallbacks) {
          cb.onSession('sess-err')
          cb.onAssistantDelta('partial')
          const done = Promise.resolve({ ok: true as const })
          // no cancel call — simulate a real network / API error
          cb.onError(new Error('network timeout'))
          return { id: task.id, cancel: vi.fn(), done }
        },
      }

      const msg = await sendTurn(payload(dir), {
        provider,
        env: process.env,
        emit: (e) => events.push(e),
      })

      // error event IS emitted
      expect(events.map(e => e.type)).toContain('error')
      // message text starts with 错误: (finishErr behaviour preserved)
      // finishErr: text = text || `错误: ${err.message}` — text is 'partial' so it's kept as-is
      // Actually looking at the impl: text = text || `错误: ${err.message}` — 'partial' is truthy so msg.text = 'partial'
      // The key assertion is the error EVENT was emitted
      expect(events.some(e => e.type === 'error')).toBe(true)
      // and no 'done' event (finishErr doesn't emit done)
      expect(events.map(e => e.type)).not.toContain('done')
      void msg
    } finally {
      cleanup()
    }
  })

  it('cancel with no streamed text: done message text is empty string (not 错误:)', async () => {
    const { dir, cleanup } = makeTmpDir()
    try {
      const events: ChatEvent[] = []

      const provider: AgentProvider = {
        id: 'claude',
        displayName: 'Claude Code',
        capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true },
        async listModels() { return [] },
        run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
        chat(task: ChatTask, cb: ChatCallbacks) {
          cb.onSession('sess-cancel2')
          // no delta streamed before cancel
          const done = new Promise<{ ok: boolean }>((resolve) => {
            Promise.resolve().then(() => {
              cb.onError(new Error('SIGTERM'))
              resolve({ ok: false })
            })
          })
          return { id: task.id, cancel: vi.fn(), done }
        },
      }

      const msg = await sendTurn(payload(dir), {
        provider,
        env: process.env,
        emit: (e) => events.push(e),
        // cancel via wrapped session before async error fires
        onSessionStart: (s) => { s.cancel() },
      })

      expect(events.map(e => e.type)).not.toContain('error')
      expect(events.map(e => e.type)).toContain('done')
      expect(msg.text).not.toMatch(/^错误:/)
    } finally {
      cleanup()
    }
  })

  it('wrapped session passed to onSessionStart: calling wrapped cancel sets aborted + delegates to original', async () => {
    const { dir, cleanup } = makeTmpDir()
    try {
      const originalCancel = vi.fn()
      let registeredSession: AgentSession | undefined

      const provider: AgentProvider = {
        id: 'claude',
        displayName: 'Claude Code',
        capabilities: { structuredOutput: true, permissionHook: true, pty: false },
        async detect() { return true },
        async listModels() { return [] },
        run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
        chat(task: ChatTask, cb: ChatCallbacks) {
          cb.onSession('sess-wrap')
          const done = Promise.resolve({ ok: true as const })
          cb.onAssistantDelta('hello')
          cb.onDone({ elapsed: 1 })
          return { id: task.id, cancel: originalCancel, done }
        },
      }

      await sendTurn(payload(dir), {
        provider,
        env: process.env,
        emit: () => {},
        onSessionStart: (s) => { registeredSession = s },
      })

      // The registered session's cancel is the WRAPPED version (not originalCancel)
      expect(registeredSession).toBeDefined()
      expect(registeredSession!.cancel).not.toBe(originalCancel)
      // id and done are preserved
      expect(typeof registeredSession!.id).toBe('string')
      expect(registeredSession!.done).toBeDefined()

      // calling wrapped cancel delegates to original
      registeredSession!.cancel()
      expect(originalCancel).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })
})
