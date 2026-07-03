import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { continueFrom } from './sessionStore'

function fakeProvider(captured: { sessionId?: string; prompt?: string }) {
  let firstCall = true
  return {
    chat: (task: any, cb: any) => {
      // Only capture the first (real) chat call; ignore async distill/oneShot calls
      if (firstCall) {
        firstCall = false
        captured.sessionId = task.sessionId
        captured.prompt = task.prompt
      }
      cb.onAssistantDelta('ok')
      cb.onDone({ elapsed: 1 })
      return { done: Promise.resolve(), cancel: () => {} }
    },
    run: () => ({ done: Promise.resolve(), cancel: () => {} }),
  } as any
}

describe('native resume in sendTurn', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-nr-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('passes externalId as sessionId when continuing same-source with claude', async () => {
    const f = continueFrom(dir, { source: 'claude', externalId: 'orig-123', title: 't', filePaths: [] })
    const sid = f.activeSessionId
    const captured: { sessionId?: string; prompt?: string } = {}
    await sendTurn(
      { workspacePath: dir, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus', text: 'hi', attachments: [] },
      { provider: fakeProvider(captured), env: process.env, emit: () => {} } as any,
    )
    expect(captured.sessionId).toBe('orig-123')
  })

  it('falls back (no externalId resume) for cross-provider continue', async () => {
    const f = continueFrom(dir, { source: 'claude', externalId: 'orig-123', title: 't', filePaths: [] })
    const sid = f.activeSessionId
    const captured: { sessionId?: string; prompt?: string } = {}
    await sendTurn(
      { workspacePath: dir, sessionId: sid, agent: 'codex', agentLabel: 'Codex', model: 'default', text: 'hi', attachments: [] },
      { provider: fakeProvider(captured), env: process.env, emit: () => {} } as any,
    )
    expect(captured.sessionId).toBeUndefined()
  })
})
