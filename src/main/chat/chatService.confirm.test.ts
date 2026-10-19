import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import type { AgentProvider } from '../agents/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'svc-confirm-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function confirmingProvider(): AgentProvider {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    chat: (_task, cb) => {
      ;(async () => {
        const d = cb.onConfirm ? await cb.onConfirm({ title: 'Write theme.ts', where: 'theme.ts' }) : 'deny'
        cb.onAssistantDelta(d === 'allow' ? '已写入' : '已拒绝')
        cb.onDone({ elapsed: 1 })
      })()
      return { id: 'a', cancel() {}, done: Promise.resolve({ ok: true }) }
    },
  } as AgentProvider
}

describe('sendTurn confirm bridge', () => {
  it('routes provider onConfirm through deps.confirm and applies the decision', async () => {
    const confirm = vi.fn(async () => 'allow' as const)
    const events: unknown[] = []
    const msg = await sendTurn(
      { workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'hi', attachments: [] },
      { provider: confirmingProvider(), env: process.env, emit: e => events.push(e), confirm },
    )
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Write theme.ts', where: 'theme.ts' }))
    expect(msg.text).toContain('已写入')
  })
})

// ACP provider 回落到 run() 之前的「完全访问」关口(见 ChatTask.beforeFallback):交互聊天这一轮得把它带进 chat()。
describe('sendTurn beforeFallback', () => {
  it('把 deps.beforeFallback 原样带进 provider.chat 的 task', async () => {
    const beforeFallback = vi.fn(async () => true)
    let seen: unknown
    const provider = { ...confirmingProvider(), chat: (task, cb) => { seen = task.beforeFallback; cb.onDone({ elapsed: 0 }); return { id: 'a', cancel() {}, done: Promise.resolve({ ok: true }) } } } as AgentProvider
    await sendTurn(
      { workspacePath: ws, sessionId: 's1', agent: 'gemini', agentLabel: 'Gemini', model: 'm', text: 'hi', attachments: [] },
      { provider, env: process.env, emit: () => {}, beforeFallback },
    )
    expect(seen).toBe(beforeFallback)
  })
})
