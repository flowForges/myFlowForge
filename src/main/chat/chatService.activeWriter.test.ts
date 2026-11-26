import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatEvent, ChatSendPayload } from '@shared/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cs-aw-')); process.env.HOME = dir; vi.resetModules() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const payload = (ws: string, agent = 'codex'): ChatSendPayload =>
  ({ workspacePath: ws, sessionId: 's1', agent, agentLabel: 'Codex', model: 'gpt', text: '接着改', attachments: [] })

const failing = (message: string): AgentProvider => ({
  id: 'codex', displayName: 'Codex',
  capabilities: { structuredOutput: true, permissionHook: true, pty: false },
  async detect() { return true },
  async listModels() { return [] },
  run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
  chat(task: ChatTask, cb: ChatCallbacks) {
    queueMicrotask(() => cb.onError(new Error(message)))
    return { id: task.id, cancel: vi.fn(), done: Promise.resolve({ ok: false }) }
  },
})

it('codex refusing a second writer ("active writer") takes the busy path: no error bubble, user message withdrawn, busy_elsewhere emitted', async () => {
  const { sendTurn } = await import('./chatService')
  const { readMessages } = await import('./chatStore')
  const ws = join(dir, 'ws')
  const events: ChatEvent[] = []
  const onBusyElsewhere = vi.fn()
  await sendTurn(payload(ws), { provider: failing('turn/start failed: thread 019a already has an active writer'), env: process.env, emit: e => events.push(e), onBusyElsewhere })
  expect(events.map(e => e.type)).not.toContain('error')
  const busy = events.find(e => e.type === 'busy_elsewhere') as any
  const user = events.find(e => e.type === 'user') as any
  expect(busy.app).toBe('Codex')
  expect(busy.drop).toEqual(expect.arrayContaining([user.message.id]))
  expect(onBusyElsewhere).toHaveBeenCalledWith('Codex')
  expect(readMessages(ws, 's1')).toEqual([])            // retry re-sends it; nothing left behind to duplicate
})

it('other codex errors still show as errors', async () => {
  const { sendTurn } = await import('./chatService')
  const events: ChatEvent[] = []
  await sendTurn(payload(join(dir, 'ws2')), { provider: failing('boom'), env: process.env, emit: e => events.push(e) })
  expect(events.map(e => e.type)).toContain('error')
  expect(events.map(e => e.type)).not.toContain('busy_elsewhere')
})

it('a refused workflow-stage turn does not use up the stage role text: the retry still carries it', async () => {
  const { sendTurn } = await import('./chatService')
  const { newSession, setSessionWorkflow, getSession } = await import('./sessionStore')
  const ws = join(dir, 'wsf')
  const sid = newSession(ws).activeSessionId
  setSessionWorkflow(ws, sid, { flowId: 'f', flowName: '流程', stages: [{ key: 'k', name: '设计', preamble: '你是设计师' } as any], currentIndex: 0, phase: 'chatting', projects: [] })
  await sendTurn({ ...payload(ws), sessionId: sid }, { provider: failing('already has an active writer'), env: process.env, emit: () => {} })
  expect(getSession(ws, sid)?.workflowSession?.preambleDoneIndex).toBeUndefined()
  let prompt = ''
  const ok: AgentProvider = { ...failing('x'), chat(task: ChatTask, cb: ChatCallbacks) { prompt = task.prompt; queueMicrotask(() => cb.onDone({ ok: true } as any)); return { id: task.id, cancel: vi.fn(), done: Promise.resolve({ ok: true }) } } }
  await sendTurn({ ...payload(ws), sessionId: sid }, { provider: ok, env: process.env, emit: () => {} })
  expect(prompt).toContain('你是设计师')
  expect(getSession(ws, sid)?.workflowSession?.preambleDoneIndex).toBe(0)
})
