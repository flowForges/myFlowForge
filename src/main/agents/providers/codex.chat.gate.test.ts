import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatCallbacks, ConfirmReq } from '../types'

/**
 * codex 聊天里的确认门必须带上 `itemId`(= 那次调用的工具卡行 id)。
 *
 * ★★这是「bash 的内容跑到 LLM 正文里」那个 bug 在 **codex** 上的根因。上层(chatService)只在门带得出
 *  `toolUseId` 时才把「已自动放行」记到那张工具卡上;拿不到就回落成往对话流里插一条
 *  `who:'ai'` 的「系统 · 回答」消息 —— 而那条消息的正文就是 **原样的 shell 命令**(gateNote 把它包进
 *  代码围栏)。用户看到的就是「bash 的内容出现在了 LLM 输出的地方」。
 *  2026-09-04 / 09-07 两次修复只接了 claude 的 run() 和 chat(),**codex 两条路都漏了**。
 *
 * ★还有一个从这里长出来的怪现象:那条系统消息是在门升起的**当下**就落盘的,而这一轮的助手消息要等
 *  收尾才落盘 —— 于是**实时看**它在回答下面(append 到消息数组末尾),**切走再切回来**读的是落盘顺序,
 *  它就跑到回答上面去了。位置会变,是因为它压根不该存在。
 *
 * 下面的假 codex 说的是 app-server 的真协议(codex-cli 0.153.4 的
 * `codex app-server generate-json-schema` 亲口给的:三个 requestApproval 的 params 里 `itemId` 都是
 * **required**,而它就是 item/started 里那个 item 的 `id`)。
 */

// readSettings 是 app-server 这条路唯一的开关(默认 'exec')。codex.ts 是唯一 import 它的模块。
vi.mock('../../config/store', () => ({ readSettings: () => ({ codexTransport: 'app-server' }) }))

let dir: string
let oldPath: string | undefined

// 一个只会说 app-server 协议的假 codex:握手 → 开线程 → 收到 turn/start 后先报一条 commandExecution
// item(工具卡按它的 id 建行),再就**同一个 itemId** 升起审批门;拿到回复就收尾。
// ★ driveCodexTurn 写死 spawn('codex', …)(Windows 上 codex 可能是 .cmd 包装,必须走 execa 解析),
//   所以这里靠 PATH 把假的塞进去,而不是 spec.bin —— 也正因为写死,这条路没法用 preArgs 造假 CLI。
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
        item: { id: 'item_5', type: 'commandExecution', command: 'go vet ./internal/...' } } })
      out({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: {
        threadId: 'th1', turnId: 'tu1', itemId: 'item_5', startedAtMs: 0, command: 'go vet ./internal/...' } })
    }
    else if (m.id === 99) {
      out({ jsonrpc: '2.0', method: 'turn/completed', params: {} })
      setTimeout(() => process.exit(0), 20)
    }
  }
})
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-gate-'))
  const bin = join(dir, 'codex')
  writeFileSync(bin, FAKE)
  chmodSync(bin, 0o755)
  oldPath = process.env.PATH
  process.env.PATH = `${dir}:${oldPath ?? ''}`
})
afterEach(() => {
  process.env.PATH = oldPath
  rmSync(dir, { recursive: true, force: true })
})

async function run(): Promise<{ gates: ConfirmReq[]; toolIds: string[] }> {
  const { makeCodexProvider } = await import('./codex')
  const gates: ConfirmReq[] = []
  const toolIds: string[] = []
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
    onDone: () => {}, onError: () => {},
    onToolActivity: (e) => { if (e.phase === 'start') toolIds.push(e.id) },
    onConfirm: async (req) => { gates.push(req); return 'allow' },
  }
  const provider = makeCodexProvider({ bin: 'codex', defaultModels: [] })
  const session = provider.chat!(
    { id: 't1', cwd: dir, model: 'gpt-5.6', text: '跑一下 vet', history: [], attachments: [] } as never,
    cb, { ...process.env },
  )
  await session.done
  return { gates, toolIds }
}

describe('codex chat(app-server): 审批门带 itemId', () => {
  it('★★门要带 toolUseId —— 没有它,自动放行只能往对话流里插一条带着原样命令的假「系统回答」', async () => {
    const { gates } = await run()
    expect(gates).toHaveLength(1)
    expect(gates[0].toolUseId).toBe('item_5')
  })

  it('★门上的 toolUseId 就是那张工具卡的行 id —— 对不上号等于把盾牌标到隔壁那条上', async () => {
    const { gates, toolIds } = await run()
    expect(toolIds).toContain(gates[0].toolUseId)
  })
})
