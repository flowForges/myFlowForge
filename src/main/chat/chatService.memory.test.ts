import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readSessions } from './sessionStore'
import { appendMessage } from './chatStore'
import { writeWorkspaceMemory, writeSystemMemory } from './memory/memoryStore'
import * as distiller from './memory/distiller'
import type { ChatTask, ChatCallbacks } from '../agents/types'

// Controllable memory toggle: override only `memory` on the real settings (read-only, no disk write).
let memoryEnabled = true
vi.mock('../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), memory: { enabled: memoryEnabled } }) }
})

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'csmem-')); writeSystemMemory(''); memoryEnabled = true; vi.restoreAllMocks() })
afterEach(() => { rmSync(ws, { recursive: true, force: true }); writeSystemMemory('') })

// A provider whose chat() records the prompt it received and replies a fixed line.
function recordingProvider() {
  const prompts: string[] = []
  const provider: any = {
    chat: (task: ChatTask, cb: ChatCallbacks) => {
      prompts.push(task.prompt)
      cb.onAssistantDelta('已蒸馏摘要')
      cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel: () => {}, done: Promise.resolve({ ok: true }) }
    },
  }
  return { provider, prompts }
}

describe('chatService memory wiring', () => {
  it('prepends system+workspace memory to the prompt sent to the provider', async () => {
    writeSystemMemory('## 偏好\n- 中文\n')
    writeWorkspaceMemory(ws, '## 架构\n- 单仓多 worktree\n')
    const sid = readSessions(ws).sessions[0].id
    const { provider, prompts } = recordingProvider()
    await sendTurn(
      { workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: '帮我加测试', attachments: [] },
      { provider, env: {}, emit: () => {} }
    )
    // first chat() call is the turn itself - its prompt carries the memory preamble before the user text
    expect(prompts[0]).toContain('# 记忆上下文')
    expect(prompts[0]).toContain('## 架构')
    expect(prompts[0]).toContain('帮我加测试')
    expect(prompts[0].indexOf('# 记忆上下文')).toBeLessThan(prompts[0].indexOf('帮我加测试'))
  })
  it('does not throw when memory is empty (preamble omitted)', async () => {
    const sid = readSessions(ws).sessions[0].id
    const { provider, prompts } = recordingProvider()
    await sendTurn(
      { workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'hi', attachments: [] },
      { provider, env: {}, emit: () => {} }
    )
    expect(prompts[0]).not.toContain('# 记忆上下文')
    expect(prompts[0]).toContain('hi')
  })
  it('when memory disabled: no preamble injected and no distillation', async () => {
    memoryEnabled = false
    writeSystemMemory('## 偏好\n- 中文\n')
    writeWorkspaceMemory(ws, '## 架构\n- 单仓多 worktree\n')
    const sid = readSessions(ws).sessions[0].id
    const session = vi.spyOn(distiller, 'distillSession').mockResolvedValue()
    const wsp = vi.spyOn(distiller, 'promoteToWorkspace').mockResolvedValue()
    const sys = vi.spyOn(distiller, 'promoteToSystem').mockResolvedValue()
    const { provider, prompts } = recordingProvider()
    await sendTurn(
      { workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: '帮我加测试', attachments: [] },
      { provider, env: {}, emit: () => {} }
    )
    expect(prompts[0]).not.toContain('# 记忆上下文')
    expect(prompts[0]).toContain('帮我加测试')
    expect(session).not.toHaveBeenCalled()
    expect(wsp).not.toHaveBeenCalled()
    expect(sys).not.toHaveBeenCalled()
  })
  it('promotes to system at the message-count cadence when enabled', async () => {
    const sid = readSessions(ws).sessions[0].id
    // Pre-seed 18 messages so this turn (user+assistant = +2) lands msgCount on a multiple of 20.
    for (let i = 0; i < 18; i++) appendMessage(ws, sid, { id: `seed-${i}`, who: 'user', text: 'x', ts: '' })
    const wsp = vi.spyOn(distiller, 'promoteToWorkspace').mockResolvedValue()
    const sys = vi.spyOn(distiller, 'promoteToSystem').mockResolvedValue()
    const { provider } = recordingProvider()
    await sendTurn(
      { workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'go', attachments: [] },
      { provider, env: {}, emit: () => {} }
    )
    expect(wsp).toHaveBeenCalled()          // every turn
    expect(sys).toHaveBeenCalledWith(ws, expect.anything())  // cadence hit at 20
  })
})
