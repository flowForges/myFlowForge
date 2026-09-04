import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import type { AgentProvider, ConfirmReq } from '../agents/types'
import type { ChatMessage } from '@shared/types'

/**
 * 「这次调用是被『完全访问』自动放行的」这件事,要落在**那一次调用的工具卡**上。
 *
 * ★★以前它是对话流里一条独立消息(`who:'ai'` + 「系统」头像 +「回答」标签),长得和模型的回答
 *  一模一样,还夹在工具卡和真正的回答中间 —— 用户原话:「bash 的结果应该在 bash 的那个折叠里,
 *  不应该出现在 LLM 输出的内容界面啊」。
 * ★关联是**精确**的,不是按命令文本猜:门收到的 `can_use_tool` 带 `tool_use_id`,而工具卡的 id
 *  就是那个 `tool_use` 块的 id,两边同一个值。下面每条用例都拿两次调用来验「没串到隔壁那条」。
 */

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'svc-auto-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

/** 按给定脚本驱动一轮:`order` 决定门和 tool_use 谁先到。 */
function provider(order: 'gate-first' | 'tool-first'): AgentProvider {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: { structuredOutput: true, permissionHook: true, pty: false, mcpTools: true },
    detect: async () => true,
    listModels: async () => [],
    run: () => ({ id: 'x', cancel() {}, done: Promise.resolve({ ok: true }) }),
    chat: (_task, cb) => {
      ;(async () => {
        const gate = async (id: string) => cb.onConfirm?.({ title: 'Bash 请求执行', where: 'ls -la', toolUseId: id })
        const start = (id: string, title: string) => cb.onToolActivity?.({ id, phase: 'start', name: 'Bash', title })
        const done = (id: string) => cb.onToolActivity?.({ id, phase: 'done', output: 'ok' })
        if (order === 'tool-first') { start('toolu_a', '调用 Bash a'); await gate('toolu_a') }
        else { await gate('toolu_a'); start('toolu_a', '调用 Bash a') }
        done('toolu_a')
        // 第二次调用**不过门**(比如被具体规则允许了),它不该被标上
        start('toolu_b', '调用 Bash b'); done('toolu_b')
        cb.onAssistantDelta('好了')
        cb.onDone({ elapsed: 1 })
      })()
      return { id: 'a', cancel() {}, done: Promise.resolve({ ok: true }) }
    },
  } as AgentProvider
}

/** deps.confirm 的实现:模仿 handlers 的 toolConfirm —— 有 onAutoAllow 就调它,并且不发消息。 */
const autoAllowing = async (req: ConfirmReq) => { req.onAutoAllow?.(); return 'allow' as const }

const run = async (order: 'gate-first' | 'tool-first', confirm = autoAllowing) =>
  sendTurn(
    { workspacePath: ws, sessionId: 's1', agent: 'claude', agentLabel: 'Claude Code', model: 'opus', text: 'hi', attachments: [] },
    { provider: provider(order), env: process.env, emit: () => {}, confirm },
  )

const tool = (m: ChatMessage, id: string) => m.tools?.find(t => t.id === id)

describe('自动放行的标记落在工具卡上', () => {
  it('★工具卡先建、门后到 —— 标记要补上去', async () => {
    const m = await run('tool-first')
    expect(tool(m, 'toolu_a')?.autoAllowed).toBe(true)
  })

  it('★★门先到、工具卡后建 —— 同样要标上(到达顺序由 CLI 决定,不归我们管)', async () => {
    // 这条是分开记一个集合的全部理由:门到的时候 `tools` 里还没有这一行,直接改会丢。
    const m = await run('gate-first')
    expect(tool(m, 'toolu_a')?.autoAllowed).toBe(true)
  })

  it('★★没过门的那次调用不许被标 —— 标错等于谎报「这条没问过你」', async () => {
    for (const order of ['tool-first', 'gate-first'] as const) {
      const m = await run(order)
      expect(tool(m, 'toolu_b')?.autoAllowed, `${order}: 串到隔壁那条了`).toBeUndefined()
    }
  })

  it('标记随消息落盘 —— 重开会话仍然看得见这次是自动放行的', async () => {
    const m = await run('tool-first')
    const { history } = await import('./chatService')
    const saved = history(ws, 's1').find(x => x.id === m.id)
    expect(saved?.tools?.find(t => t.id === 'toolu_a')?.autoAllowed).toBe(true)
  })

  it('★没自动放行(门真弹了、人点的允许)就不该有这枚标记', async () => {
    // 这里的 confirm 不调 onAutoAllow —— 模仿「弹了门,用户点了允许」。
    const m = await run('tool-first', async () => 'allow' as const)
    expect(tool(m, 'toolu_a')?.autoAllowed).toBeUndefined()
  })

  it('★门必须收到 toolUseId —— 没有它,上层只能回落成发消息', async () => {
    let seen: ConfirmReq | null = null
    await run('tool-first', async (req) => { seen = req; req.onAutoAllow?.(); return 'allow' as const })
    expect(seen!.toolUseId).toBe('toolu_a')
    expect(typeof seen!.onAutoAllow).toBe('function')
  })
})
