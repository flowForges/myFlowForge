import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readSessions } from './sessionStore'
import { writeWorkspaceMemory, writeSystemMemory } from './memory/memoryStore'
import type { ChatTask, ChatCallbacks } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'csmem-')); writeSystemMemory('') })
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
})
