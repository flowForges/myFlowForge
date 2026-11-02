import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn, history } from './chatService'
import { appendMessage, readMessages } from './chatStore'
import { readLive } from './liveTurns'
import type { AgentProvider, ChatBackgroundHooks, ChatCallbacks, ChatTask } from '../agents/types'
import type { ChatEvent, ChatSendPayload } from '@shared/types'

const payload = (ws: string): ChatSendPayload => ({ workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus-4.8', text: 'hi', attachments: [] })

// CLI 自己起的一轮(后台任务完成后):没有用户消息,但流式、落盘、done 事件、提醒要和普通回复一模一样。
describe('sendTurn — 接上活进程自己起的一轮(deps.adopt)', () => {
  it('不写用户消息、不 spawn;回复落盘,done 事件照发,在途快照收尾时清掉', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-bgturn-'))
    try {
      const chat = vi.fn()
      const provider = { id: 'claude', displayName: 'Claude Code', capabilities: {}, chat } as unknown as AgentProvider
      const events: ChatEvent[] = []
      let live: string | undefined
      const msg = await sendTurn({ ...payload(ws), text: '' }, {
        provider, env: {}, emit: (e) => events.push(e),
        adopt: (cb: ChatCallbacks) => {
          cb.onAssistantDelta('后台跑完了')
          live = readLive(ws, 's1')?.text
          setTimeout(() => cb.onDone({ elapsed: 1 }), 0)
          return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }
        },
      })
      expect(chat).not.toHaveBeenCalled()
      expect(msg.text).toBe('后台跑完了')
      expect(live).toBe('后台跑完了')
      expect(readLive(ws, 's1')).toBeUndefined()
      expect(events.some(e => e.type === 'user')).toBe(false)
      expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['assistant-start', 'assistant-delta', 'done']))
      expect(readMessages(ws, 's1').map(m => [m.who, m.text])).toEqual([['ai', '后台跑完了']])
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('#11 后台子代理卡片:收尾时保持运行中,完成通知到了改盘上那一条,消息不变回流式', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-bgturn-'))
    try {
      let saved: ChatCallbacks | null = null
      const provider = {
        id: 'claude', displayName: 'Claude Code', capabilities: {},
        chat(_t: ChatTask, cb: ChatCallbacks) {
          saved = cb
          cb.onSubagent?.({ id: 'tu1', phase: 'start', description: '调研' })
          cb.onSubagent?.({ id: 'tu1', phase: 'update', step: '已转入后台运行', background: true })
          cb.onSubagent?.({ id: 'fg', phase: 'start', description: '前台' })
          cb.onAssistantDelta('还在跑')
          setTimeout(() => cb.onDone({ elapsed: 0 }), 0)
          return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }
        },
      } as unknown as AgentProvider
      const events: ChatEvent[] = []
      const msg = await sendTurn(payload(ws), { provider, env: {}, emit: (e) => events.push(e) })
      expect(msg.subagents?.find(c => c.id === 'tu1')?.state).toBe('running')
      expect(msg.subagents?.find(c => c.id === 'fg')?.state).toBe('done')     // 前台的照旧收掉
      expect(history(ws, 's1').find(m => m.id === msg.id)?.subagents?.find(c => c.id === 'tu1')?.state).toBe('running')
      saved!.onSubagent?.({ id: 'tu1', phase: 'done', result: '调研完了', isError: false })
      const after = readMessages(ws, 's1').find(m => m.id === msg.id)?.subagents?.find(c => c.id === 'tu1')
      expect(after).toMatchObject({ state: 'done', result: '调研完了' })
      expect(after?.background).toBeUndefined()
      expect(events[events.length - 1]).toMatchObject({ type: 'subagent-settled', id: msg.id })
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('#11 重启后再也等不到通知的后台卡片:历史里显示已中断,不会一直转', () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-bgturn-'))
    try {
      appendMessage(ws, 's1', { id: 'old', who: 'ai', text: 't', ts: '', subagents: [{ id: 'gone', state: 'running', background: true }] })
      expect(history(ws, 's1')[0].subagents?.[0]).toMatchObject({ state: 'error', result: '已中断' })
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('#10 discard:工作区封存后不再落盘,界面照常收尾', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-bgturn-'))
    try {
      const provider = { id: 'claude', displayName: 'Claude Code', capabilities: {}, chat: vi.fn() } as unknown as AgentProvider
      const events: ChatEvent[] = []
      await sendTurn({ ...payload(ws), text: '' }, {
        provider, env: {}, emit: (e) => events.push(e), discard: () => true,
        adopt: (cb: ChatCallbacks) => { cb.onAssistantDelta('x'); setTimeout(() => cb.onDone({ elapsed: 0 }), 0); return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
      })
      expect(readMessages(ws, 's1')).toEqual([])
      expect(events.some(e => e.type === 'done')).toBe(true)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })

  it('普通一轮把 background 钩子带进 ChatTask', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cs-bgturn-'))
    try {
      let seen: ChatTask | null = null
      const provider = {
        id: 'claude', displayName: 'Claude Code', capabilities: {},
        chat(task: ChatTask, cb: ChatCallbacks) { seen = task; setTimeout(() => cb.onDone({ elapsed: 0 }), 0); return { id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) } },
      } as unknown as AgentProvider
      const background: ChatBackgroundHooks = { onRunning: () => {}, openTurn: () => {} }
      await sendTurn(payload(ws), { provider, env: {}, emit: () => {}, background })
      expect(seen!.background).toBe(background)
    } finally { rmSync(ws, { recursive: true, force: true }) }
  })
})
