import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readMessages, readSession } from './chatStore'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatSendPayload } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'e2e-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const seen: (string | undefined)[] = []
function provider(): AgentProvider {
  return {
    id: 'claude', displayName: 'Claude Code', capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'opus-4.8', label: 'opus-4.8' }] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      const isDistill = task.id.startsWith('distill-')
      if (!isDistill) seen.push(task.sessionId)
      if (!isDistill && !task.sessionId) cb.onSession('S')   // only the first turn establishes the session
      cb.onAssistantDelta('ok'); cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel() {}, done: Promise.resolve({ ok: true }) }
    }
  }
}

const p = (text: string): ChatSendPayload => ({ workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text, attachments: [] })

describe('chat two-turn e2e', () => {
  it('resumes the stored session on the second turn and accumulates the transcript', async () => {
    seen.length = 0
    const deps = { provider: provider(), env: process.env, emit: () => {} }
    await sendTurn(p('first'), deps)
    await sendTurn(p('second'), deps)
    expect(seen).toEqual([undefined, 'S'])           // 1st turn no session, 2nd turn resumes 'S'
    expect(readSession(ws, 's1', 'claude')).toBe('S')
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user', 'ai', 'user', 'ai'])
  })
})
