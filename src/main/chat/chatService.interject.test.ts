import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import { readMessages } from './chatStore'
import type { AgentProvider, AgentSession, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatEvent, ChatSendPayload } from '@shared/types'

const payload = (ws: string): ChatSendPayload => ({
  workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'first', attachments: [],
})

/** provider:一轮由测试手动收尾;interject 由测试决定回什么。 */
function makeProvider(interject: AgentSession['interject']) {
  let cb!: ChatCallbacks
  const provider: AgentProvider = {
    id: 'claude', displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false },
    async detect() { return true },
    async listModels() { return [] },
    run() { return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
    chat(task: ChatTask, c: ChatCallbacks) {
      cb = c
      return { id: task.id, cancel() {}, done: new Promise(() => {}), interject }
    },
  }
  return { provider, cb: () => cb }
}

describe('sendTurn — 插话', () => {
  it('成功:历史里在这一轮的回复之前追加一条带 interjected 的用户消息,并广播出去', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-interject-'))
    try {
      const inj = vi.fn(async () => true)
      const { provider, cb } = makeProvider(inj)
      const events: ChatEvent[] = []
      let session!: AgentSession
      const p = sendTurn(payload(ws), { provider, env: process.env, emit: (e) => events.push(e), onSessionStart: (s) => { session = s } })
      expect(typeof session.interject).toBe('function')
      cb().onAssistantDelta('part1')
      expect(await session.interject!('second', [{ name: 'f', path: '/f', size: 1 }], 'iPhone')).toBe(true)
      expect(inj).toHaveBeenCalledWith('second', [{ name: 'f', path: '/f', size: 1 }], 'iPhone')
      cb().onAssistantDelta(' part2')
      cb().onDone({ elapsed: 1 })
      await p
      const msgs = readMessages(ws, 's1')
      expect(msgs.map(m => `${m.who}:${m.text}`)).toEqual(['user:first', 'user:second', 'ai:part1 part2'])
      expect(msgs[1].interjected).toBe(true)
      expect(msgs[1].via).toBe('iPhone')
      expect(msgs[1].files).toEqual([{ name: 'f', path: '/f', size: 1 }])
      expect(msgs[0].interjected).toBeUndefined()
      const userEvents = events.filter(e => e.type === 'user') as Array<Extract<ChatEvent, { type: 'user' }>>
      expect(userEvents.map(e => e.message.text)).toEqual(['first', 'second'])
      expect(userEvents[1].message.interjected).toBe(true)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('provider 说不行:什么都不记', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-interject-'))
    try {
      const { provider, cb } = makeProvider(async () => false)
      let session!: AgentSession
      const p = sendTurn(payload(ws), { provider, env: process.env, emit: () => {}, onSessionStart: (s) => { session = s } })
      expect(await session.interject!('second')).toBe(false)
      cb().onDone({ elapsed: 1 })
      await p
      expect(readMessages(ws, 's1').map(m => m.text)).toEqual(['first', ''])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('这一轮已经收尾:不再问 provider,返回 false', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-interject-'))
    try {
      const inj = vi.fn(async () => true)
      const { provider, cb } = makeProvider(inj)
      let session!: AgentSession
      const p = sendTurn(payload(ws), { provider, env: process.env, emit: () => {}, onSessionStart: (s) => { session = s } })
      cb().onAssistantDelta('x')
      cb().onDone({ elapsed: 1 })
      await p
      expect(await session.interject!('late')).toBe(false)
      expect(inj).not.toHaveBeenCalled()
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('provider 不支持插话:包出来的句柄也没有 interject', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-interject-'))
    try {
      const { provider, cb } = makeProvider(undefined)
      let session!: AgentSession
      const p = sendTurn(payload(ws), { provider, env: process.env, emit: () => {}, onSessionStart: (s) => { session = s } })
      expect(session.interject).toBeUndefined()
      cb().onDone({ elapsed: 1 }); await p
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})
