import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { ChatCallbacks, ConfirmReq } from '../types'

/**
 * 聊天里的确认门必须带上 `tool_use_id`。
 *
 * ★★这是「自动放行的提示跑到 LLM 正文里」那个 bug 的**根因**:上层(chatService)只在门带得出
 *  tool_use_id 时才把「自动放行」记到那张工具卡上,拿不到就回落成往对话流里插一条「系统 · 回答」消息。
 *  2026-09-04 那次修复只给 run() 那条路接上了 toolUseId,**chat() 这条路漏了** —— 而聊天恰恰是
 *  用户天天看的那条路,于是修完照旧每放行一次就冒一条假回答。用户原话:
 *  「系统回答 不应该出现在这个位置吧，这个bug挺严重的」。
 *
 * 下面的假 CLI 用的是 2026-09-07 从 claude 2.1.263 真机上抓下来的原样报文:can_use_tool 的
 * `tool_use_id` 和 assistant 消息里那个 `tool_use` 块的 `id` 是**同一个值** —— 工具卡就是按后者建行的,
 * 所以两边必须能对上号,断言里一起验。
 */

let dir: string, cli: string

const CLI = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.on('data', (b) => {
  for (const line of b.toString().split('\\n')) {
    if (!line.trim()) continue
    const o = JSON.parse(line)
    if (o.type === 'control_response') { out({ type: 'result', subtype: 'success', result: '好' }); setTimeout(() => process.exit(0), 20) }
  }
})
out({ type: 'assistant', message: { role: 'assistant', content: [
  { type: 'tool_use', id: 'toolu_019y1WbuBFRapC52Hyot8SXv', name: 'Bash', input: { command: 'curl -s https://example.com', description: '拉一下' } },
] } })
out({ type: 'control_request', request_id: '1e38ad10-d107-4cf6-8cd6-d157bec3566c', request: {
  subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash',
  input: { command: 'curl -s https://example.com', description: '拉一下' },
  decision_reason_type: 'subcommandResults',
  tool_use_id: 'toolu_019y1WbuBFRapC52Hyot8SXv',
} })
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-gate-'))
  cli = join(dir, 'claude.js'); writeFileSync(cli, CLI); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run() {
  const gates: ConfirmReq[] = []
  const toolIds: string[] = []
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
    onDone: () => {}, onError: () => {},
    onToolActivity: (e) => { if (e.phase === 'start') toolIds.push(e.id) },
    onConfirm: async (req) => { gates.push(req); return 'allow' },
  }
  const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
  const session = provider.chat!({ id: 't1', cwd: dir, model: 'opus-4.8', text: '拉一下', history: [], attachments: [] } as never, cb, process.env)
  await session.done
  return { gates, toolIds }
}

describe('claude chat: 确认门带 tool_use_id', () => {
  it('★★门要带 toolUseId —— 没有它,自动放行就只能往对话流里插一条假的「系统回答」', async () => {
    const { gates } = await run()
    expect(gates).toHaveLength(1)
    expect(gates[0].toolUseId).toBe('toolu_019y1WbuBFRapC52Hyot8SXv')
  })

  it('★门上的 toolUseId 就是那张工具卡的行 id —— 对不上号等于标到隔壁那条上', async () => {
    const { gates, toolIds } = await run()
    expect(toolIds).toContain(gates[0].toolUseId)
  })
})
