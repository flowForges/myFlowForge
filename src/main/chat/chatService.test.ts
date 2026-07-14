import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readMessages, readSession } from './chatStore'
import type { AgentProvider, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatEvent, ChatSendPayload } from '@shared/types'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'svc-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

let lastSessionSeen: string | undefined
function fakeChatProvider(): AgentProvider {
  return {
    id: 'claude', displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'opus-4.8', label: 'opus-4.8' }] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      if (!task.id.startsWith('distill-')) lastSessionSeen = task.sessionId
      cb.onSession('sess-1'); cb.onThinkDelta('think a'); cb.onAssistantDelta('Hel'); cb.onAssistantDelta('lo')
      const done = Promise.resolve({ ok: true })
      cb.onDone({ elapsed: 3 })
      return { id: task.id, cancel() {}, done }
    }
  }
}

const payload = (text: string): ChatSendPayload => ({
  workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text, attachments: []
})

describe('chatService.sendTurn', () => {
  it('persists user + assistant, streams events, stores session, and resumes next turn', async () => {
    const events: ChatEvent[] = []
    const deps = { provider: fakeChatProvider(), env: process.env, emit: (e: ChatEvent) => events.push(e) }

    const first = await sendTurn(payload('hi'), deps)
    expect(first.who).toBe('ai')
    expect(first.text).toBe('Hello')
    expect(first.model).toBe('Claude Code · opus-4.8')
    expect(first.think?.elapsed).toBe(3)
    expect(first.think?.steps).toContain('think a')
    expect(events.map(e => e.type)).toEqual(['user', 'assistant-start', 'think-delta', 'assistant-delta', 'assistant-delta', 'done'])
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user', 'ai'])
    expect(readSession(ws, 's1', 'claude')).toBe('sess-1')

    await sendTurn(payload('again'), deps)
    expect(lastSessionSeen).toBe('sess-1')
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user', 'ai', 'user', 'ai'])
  })

  it('streams runtime skill references discovered from thinking/tool output', async () => {
    const provider: AgentProvider = {
      ...fakeChatProvider(),
      chat(task: ChatTask, cb: ChatCallbacks) {
        cb.onSession('sess-ctx')
        cb.onThinkDelta('调用 shell: /bin/zsh -lc "sed -n 1,220p /Users/zghua/.codex/skills/using-superpowers/SKILL.md"')
        cb.onAssistantDelta('ok')
        const done = Promise.resolve({ ok: true })
        cb.onDone({ elapsed: 1 })
        return { id: task.id, cancel() {}, done }
      },
    }
    const events: ChatEvent[] = []

    const msg = await sendTurn(payload('hi'), { provider, env: process.env, emit: e => events.push(e) })

    const think = events.find(e => e.type === 'think-delta') as Extract<ChatEvent, { type: 'think-delta' }>
    expect(think.context?.skills.map(s => s.name)).toContain('using-superpowers')
    expect(msg.context?.skills.map(s => s.name)).toContain('using-superpowers')
  })

  it('includes forge MCP context when chat env injects the forge server', async () => {
    const events: ChatEvent[] = []
    const msg = await sendTurn(payload('hi'), {
      provider: fakeChatProvider(),
      env: { FORGE_SOCKET: '/s.sock', FORGE_AGENT_ID: 'chat', FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: 'forge_propose_plan' },
      emit: e => events.push(e),
    })

    const start = events.find(e => e.type === 'assistant-start') as Extract<ChatEvent, { type: 'assistant-start' }>
    expect(start.context?.mcps?.map(m => m.name)).toEqual(['forge'])
    expect(msg.context?.mcps?.map(m => m.name)).toEqual(['forge'])
  })

  it('captures onUsage and stamps the done assistant message with usage', async () => {
    const provider: AgentProvider = {
      ...fakeChatProvider(),
      chat(task: ChatTask, cb: ChatCallbacks) {
        cb.onSession('sess-u')
        cb.onUsage?.({ used: 30000, window: 200000 })
        cb.onAssistantDelta('ok')
        cb.onUsage?.({ used: 45000, window: 200000 })   // running max; latest wins
        const done = Promise.resolve({ ok: true })
        cb.onDone({ elapsed: 2 })
        return { id: task.id, cancel() {}, done }
      },
    }
    const events: ChatEvent[] = []
    const msg = await sendTurn(payload('hi'), { provider, env: process.env, emit: e => events.push(e) })
    expect(msg.usage).toEqual({ used: 45000, window: 200000 })
    const doneEvt = events.find(e => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(doneEvt.message.usage).toEqual({ used: 45000, window: 200000 })
    // persisted message also carries usage
    const persisted = readMessages(ws, 's1').find(m => m.who === 'ai')
    expect(persisted?.usage).toEqual({ used: 45000, window: 200000 })
  })

  it('leaves usage undefined when the provider never reports it', async () => {
    const msg = await sendTurn(payload('hi'), { provider: fakeChatProvider(), env: process.env, emit: () => {} })
    expect(msg.usage).toBeUndefined()
  })

  it('falls back to run() for a provider without chat()', async () => {
    const runProvider: AgentProvider = {
      id: 'codex', displayName: 'Codex', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run'); cb.onLog({ ts: '0', text: 'partial', level: 'accent' }); cb.onState('ok')
        const done = Promise.resolve({ ok: true, summary: 'partial' }); cb.onDone({ ok: true, summary: 'partial' }); return { id: task.agentId, cancel() {}, done }
      }
    }
    const events: ChatEvent[] = []
    const msg = await sendTurn({ ...payload('hi'), agent: 'codex', agentLabel: 'Codex' },
      { provider: runProvider, env: process.env, emit: (e) => events.push(e) })
    expect(msg.who).toBe('ai')
    expect(msg.text.length).toBeGreaterThan(0)
    expect(readMessages(ws, 's1').map(m => m.who)).toEqual(['user', 'ai'])
    // Verify that the one-shot run() degradation path emits the expected chat events
    const types = events.map(e => e.type)
    expect(types).toContain('assistant-start')
    expect(types).toContain('assistant-delta')
    expect(types).toContain('done')
    const doneEvt = events.find(e => e.type === 'done') as any
    expect(doneEvt?.message?.text).toBe('partial')
  })

  it('run() fallback excludes process lines (kind:tool/file) but keeps reply output', async () => {
    const runProvider: AgentProvider = {
      id: 'codex', displayName: 'Codex', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        cb.onLog({ ts: '0', text: '调用 Read', level: 'accent', kind: 'tool' })
        cb.onLog({ ts: '0', text: '编辑文件 a.ts', level: 'accent', kind: 'file' })
        cb.onLog({ ts: '0', text: '思考中', level: 'accent', kind: 'think' })
        cb.onLog({ ts: '0', text: '真正的回答', level: 'accent', kind: 'output' })
        cb.onState('ok')
        const done = Promise.resolve({ ok: true }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done }
      }
    }
    const msg = await sendTurn({ ...payload('hi'), agent: 'codex', agentLabel: 'Codex' },
      { provider: runProvider, env: process.env, emit: () => {} })
    expect(msg.text).toBe('真正的回答')
    expect(msg.text).not.toContain('调用 Read')
    expect(msg.text).not.toContain('编辑文件')
    expect(msg.text).not.toContain('思考中')
  })

  it('persists messages under the payload session and stamps events with sessionId', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-'))
    const events: any[] = []
    const provider: any = { chat: (task: any, cb: any) => { cb.onAssistantDelta('hello'); cb.onDone({ elapsed: 1 }) } }
    await sendTurn(
      { workspacePath: ws, sessionId: 's-xyz', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'hi', attachments: [] },
      { provider, env: {}, emit: e => events.push(e) }
    )
    // every event carries the session id
    expect(events.every(e => e.sessionId === 's-xyz')).toBe(true)
    // messages went to that session's file, not a sibling
    expect(readMessages(ws, 's-xyz').length).toBeGreaterThan(0)
    expect(readMessages(ws, 'other')).toEqual([])
    rmSync(ws, { recursive: true, force: true })
  })
})

describe('chatService.sendTurn – onSessionStart callback', () => {
  it('calls onSessionStart with the AgentSession on the provider.chat path', async () => {
    const cancelSpy = vi.fn()
    const provider: AgentProvider = {
      ...fakeChatProvider(),
      chat(task: ChatTask, cb: ChatCallbacks) {
        cb.onSession('sess-x')
        cb.onAssistantDelta('hi')
        const done = Promise.resolve({ ok: true as const })
        cb.onDone({ elapsed: 1 })
        return { id: task.id, cancel: cancelSpy, done }
      },
    }
    const sessions: import('../agents/types').AgentSession[] = []
    await sendTurn(payload('hello'), {
      provider,
      env: process.env,
      emit: () => {},
      onSessionStart: (s) => sessions.push(s),
    })
    expect(sessions).toHaveLength(1)
    // cancel is wrapped (not the original spy) but delegating to it still works
    expect(sessions[0].cancel).not.toBe(cancelSpy)
    sessions[0].cancel()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('calls onSessionStart with the AgentSession on the provider.run fallback path', async () => {
    const cancelSpy = vi.fn()
    const runProvider: AgentProvider = {
      id: 'codex', displayName: 'Codex',
      capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      async detect() { return true }, async listModels() { return [] },
      run(task, cb) {
        cb.onState('run')
        cb.onLog({ ts: '0', text: 'output', level: 'accent', kind: 'output' })
        cb.onState('ok')
        const done = Promise.resolve({ ok: true as const })
        cb.onDone({ ok: true })
        return { id: task.agentId, cancel: cancelSpy, done }
      },
    }
    const sessions: import('../agents/types').AgentSession[] = []
    await sendTurn({ ...payload('hello'), agent: 'codex', agentLabel: 'Codex' }, {
      provider: runProvider,
      env: process.env,
      emit: () => {},
      onSessionStart: (s) => sessions.push(s),
    })
    expect(sessions).toHaveLength(1)
    // cancel is wrapped (not the original spy) but delegating to it still works
    expect(sessions[0].cancel).not.toBe(cancelSpy)
    sessions[0].cancel()
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })
})

function fenceProvider(): AgentProvider {
  return {
    id: 'claude', displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true }, async listModels() { return [{ id: 'opus-4.8', label: 'opus-4.8' }] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, cb: ChatCallbacks) {
      cb.onSession('s1')
      cb.onAssistantDelta('开始开发。\n```forge:run\n{"task":"做登录"}\n```')
      const done = Promise.resolve({ ok: true })
      cb.onDone({ elapsed: 1 })
      return { id: task.id, cancel() {}, done }
    },
  }
}

describe('chatService.sendTurn – forge:run fence is inert', () => {
  it('keeps the fence text verbatim in the message and triggers no run', async () => {
    const deps = { provider: fenceProvider(), env: process.env, emit: () => {} }
    const msg = await sendTurn(payload('帮我做登录'), deps)
    // The forge:run fence was removed as a trigger path — it must survive verbatim, not be stripped.
    expect(msg.text).toContain('```forge:run')
    expect(msg.text).toContain('做登录')
  })
})
