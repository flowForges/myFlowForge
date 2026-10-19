import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn, addTurnAnswer } from './chatService'
import { readMessages } from './chatStore'
import { readLive } from './liveTurns'
import type { AgentProvider } from '../agents/types'
import type { ChatEvent, ChatMessage } from '@shared/types'

/**
 * ★「你的选择」要落在**问题被回答的那个位置**,不是整轮回复之后另起一条。
 *  原来是 handlers 里 emitNote 追加一条系统消息到会话末尾,而这一轮后面吐的字仍然流进上面那条回复 ——
 *  于是光标和答完之后的所有输出都排在「你的选择」**之前**,读起来是倒着的。
 */
let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'svc-answers-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const payload = (sid = 's1') => ({ workspacePath: ws, sessionId: sid, agent: 'claude', agentLabel: 'Claude Code', model: 'opus', text: 'hi', attachments: [] })

/** 先说一段 → 停在一道门上(测试的 confirm 里作答)→ 门答完后接着说。 */
function askingProvider(opts: { endWith?: 'done' | 'error' } = {}): AgentProvider {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    chat: (_task, cb) => {
      ;(async () => {
        cb.onAssistantDelta('先问一句。')
        await cb.onConfirm!({ title: '请回答', questions: [{ question: 'Q?', header: 'Q', options: [], multiSelect: false }] } as any)
        cb.onAssistantDelta('好的,接着做。')
        if (opts.endWith === 'error') cb.onError(new Error('boom'))
        else cb.onDone({ elapsed: 1 })
      })()
      return { id: 'a', cancel() {}, done: Promise.resolve({ ok: true }) }
    },
  } as AgentProvider
}

describe('addTurnAnswer —— 选择锚在在途回复里', () => {
  it('答在一轮中途:记在当时正文的位置,发 answer-note,在途镜像和落档消息都带着', async () => {
    const events: ChatEvent[] = []
    let ok: boolean | undefined
    let live: ChatMessage | undefined
    const msg = await sendTurn(payload(), {
      provider: askingProvider(),
      env: process.env,
      emit: (e) => events.push(e),
      confirm: async () => {
        ok = addTurnAnswer(ws, 's1', '📝 你的选择\n\n**Q?**\n- A')
        live = readLive(ws, 's1')
        return 'allow'
      },
    })
    expect(ok).toBe(true)
    const at = '先问一句。'.length
    const ev = events.find((e) => e.type === 'answer-note') as Extract<ChatEvent, { type: 'answer-note' }>
    expect(ev).toMatchObject({ id: msg.id, at, text: '📝 你的选择\n\n**Q?**\n- A' })
    expect(live?.answers).toEqual([{ at, text: '📝 你的选择\n\n**Q?**\n- A' }])
    expect(msg.text).toBe('先问一句。好的,接着做。')
    expect(msg.answers).toEqual([{ at, text: '📝 你的选择\n\n**Q?**\n- A' }])
    const persisted = readMessages(ws, 's1').find((m) => m.id === msg.id)
    expect(persisted?.answers).toEqual([{ at, text: '📝 你的选择\n\n**Q?**\n- A' }])
    // done 带的那份也有 —— 渲染端用它整个替换流式那份
    const done = events.find((e) => e.type === 'done') as Extract<ChatEvent, { type: 'done' }>
    expect(done.message.answers).toEqual([{ at, text: '📝 你的选择\n\n**Q?**\n- A' }])
  })

  it('错误收尾的那一轮也把选择落档', async () => {
    const msg = await sendTurn(payload(), {
      provider: askingProvider({ endWith: 'error' }),
      env: process.env,
      emit: () => {},
      confirm: async () => { addTurnAnswer(ws, 's1', 'N'); return 'allow' },
    })
    expect(msg.answers).toEqual([{ at: '先问一句。'.length, text: 'N' }])
    expect(readMessages(ws, 's1').find((m) => m.id === msg.id)?.answers).toHaveLength(1)
  })

  it('没有在途轮次时返回 false(调用方回落成单独一条记录)', async () => {
    expect(addTurnAnswer(ws, 's1', 'N')).toBe(false)
    await sendTurn(payload(), { provider: askingProvider(), env: process.env, emit: () => {}, confirm: async () => 'allow' })
    // 轮次结束之后也不再收
    expect(addTurnAnswer(ws, 's1', 'N')).toBe(false)
  })

  it('只认同一个会话的在途轮次', async () => {
    let other: boolean | undefined
    await sendTurn(payload('s1'), {
      provider: askingProvider(),
      env: process.env,
      emit: () => {},
      confirm: async () => { other = addTurnAnswer(ws, 's2', 'N'); return 'allow' },
    })
    expect(other).toBe(false)
  })
})
