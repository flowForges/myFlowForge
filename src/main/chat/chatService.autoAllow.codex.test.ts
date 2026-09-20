import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendTurn } from './chatService'
import type { ConfirmReq } from '../agents/types'

/**
 * codex 的整条链路:**真的** codex provider(假 app-server 说真协议)→ sendTurn → 一个照抄
 * handlers.toolConfirm 的门。断言的是用户真正看得见的那两件事:
 *   ① 对话流里**没有**那条「🛡 已按当前权限档「完全访问」自动放行」的假回答(它的正文是原样的 shell
 *     命令,用户看到的就是「bash 的内容跑到 LLM 输出的地方」);
 *   ② 盾牌落在**那一次调用的工具卡**上。
 *
 * ★★为什么非要真 provider:claude 那边已经栽过一次「两头各自全绿、中间那截是断的」
 *   (见同目录 chatService.autoAllow.test.ts 末尾那一段)。codex 更险 —— 它有 run() 和 chat()
 *   **两个**调用方,历史上就因为各抄一份而只修好一半(见 [[trap-two-call-sites-run-vs-chat]])。
 */

// app-server 是这条路唯一的开关(默认 exec),其余设置走真实值。
vi.mock('../config/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/store')>()
  return { ...actual, readSettings: () => ({ ...actual.readSettings(), codexTransport: 'app-server' as const }) }
})

let ws: string
let oldPath: string | undefined

// 假 codex:报一条 commandExecution item(工具卡按它的 id 建行)→ 就**同一个 itemId** 升审批门
// → 收到回复后给一句正文并收尾。
const FAKE = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', (b) => {
  buf += b.toString()
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: {} })
    else if (m.method === 'thread/start' || m.method === 'thread/resume') out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'th1' } } })
    else if (m.method === 'turn/start') {
      out({ jsonrpc: '2.0', id: m.id, result: {} })
      out({ jsonrpc: '2.0', method: 'item/started', params: { threadId: 'th1', turnId: 'tu1', startedAtMs: 0,
        item: { id: 'item_real1', type: 'commandExecution', command: 'go vet ./internal/...' } } })
      out({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'th1', turnId: 'tu1', itemId: 'item_real1', startedAtMs: 0, command: 'go vet ./internal/...' } })
    }
    else if (m.id === 99) {
      out({ jsonrpc: '2.0', method: 'item/completed', params: { threadId: 'th1', turnId: 'tu1', completedAtMs: 1,
        item: { id: 'item_real1', type: 'commandExecution', command: 'go vet ./internal/...', aggregated_output: '', exit_code: 0 } } })
      out({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: '跑完了' } })
      out({ jsonrpc: '2.0', method: 'turn/completed', params: {} })
      setTimeout(() => process.exit(0), 20)
    }
  }
})
`

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'svc-auto-codex-'))
  // driveCodexTurn 写死 spawn('codex', …),所以假 codex 只能从 PATH 进去(不能走 spec.bin/preArgs)。
  const bin = join(ws, 'codex')
  writeFileSync(bin, FAKE); chmodSync(bin, 0o755)
  oldPath = process.env.PATH
  process.env.PATH = `${ws}:${oldPath ?? ''}`
})
afterEach(() => {
  process.env.PATH = oldPath
  rmSync(ws, { recursive: true, force: true })
})

describe('真 codex provider(app-server)→ sendTurn → 门(整条链路)', () => {
  it('★★自动放行不再往对话流里插一条带着原样命令的「系统 · 回答」,而是挂在那张 shell 卡上', async () => {
    const { makeCodexProvider } = await import('../agents/providers/codex')

    // handlers.toolConfirm 的行为:能挂卡就挂卡,挂不上才发消息。把「发消息」记下来当断言用。
    const notes: string[] = []
    const toolConfirm = async (req: ConfirmReq) => {
      if (req.onAutoAllow) req.onAutoAllow()
      else notes.push(`🛡 已按当前权限档「完全访问」自动放行：${req.title}\n${req.where ?? ''}`)
      return 'allow' as const
    }
    const m = await sendTurn(
      { workspacePath: ws, sessionId: 's1', agent: 'codex', agentLabel: 'Codex', model: 'default', text: '跑一下 vet', attachments: [] },
      {
        provider: makeCodexProvider({ bin: 'codex', defaultModels: [] }),
        env: process.env, emit: () => {}, confirm: toolConfirm,
      },
    )
    expect(notes, '又把「自动放行」写成了一条假回答,正文还是那条 shell 命令').toEqual([])
    expect(m.tools?.find(t => t.id === 'item_real1')?.autoAllowed).toBe(true)
  })
})
