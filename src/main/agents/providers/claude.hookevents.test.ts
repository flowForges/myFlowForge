import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { ChatCallbacks } from '../types'

/**
 * 整条链路:假 CLI 发**真实形状**的钩子事件 → claude 适配器 → onStatus。
 *
 * ★★这条是补 2026-09-07 那个 bug 的:钩子把 claude 拦住时,Forge 界面上和「模型在思考」完全一样,
 *  用户只能靠另一个软件才知道 agent 在等他授权。单测覆盖了解析和计时,但「适配器有没有把事件喂进去」
 *  是另一道缝 —— 今天早些时候那个 toolUseId 的 bug 就是从这种缝里漏过去的,所以这里用真 provider 跑。
 */
let dir: string, cli: string

/** 钩子起了就**不回**,模拟「它在别处等人」。
 *  ★挂的时长必须**真的超过** HOOK_SLOW_MS(2s)—— 用假计时器就测不到「适配器有没有把事件喂进去」
 *  这道缝,而那正是这条测试存在的理由。多花的两秒买的是真链路。 */
const CLI_STUCK = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'hook_started', hook_id: 'h1',
      hook_name: 'PermissionRequest:Bash', hook_event: 'PermissionRequest' })
setTimeout(() => { out({ type: 'result', subtype: 'success', result: '好' }); setTimeout(() => process.exit(0), 20) }, 2400)
`

/** 钩子回了,但是 error 收场(这台机器上 ping-island-bridge 的真实表现)。 */
const CLI_BROKEN = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' })
out({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse',
      outcome: 'error', output: 'PingIslandBridge error: The operation could not be completed.\\nstack line 2' })
out({ type: 'result', subtype: 'success', result: '好' })
setTimeout(() => process.exit(0), 20)
`

/** 钩子秒回 —— 一个字都不该播报。 */
const CLI_FAST = `#!/usr/bin/env node
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' })
out({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse', outcome: 'success', output: '' })
out({ type: 'result', subtype: 'success', result: '好' })
setTimeout(() => process.exit(0), 20)
`

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-hooks-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function run(src: string) {
  cli = join(dir, 'claude.js'); writeFileSync(cli, src); chmodSync(cli, 0o755)
  const status: string[] = []
  const text: string[] = []
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: (t) => text.push(t), onThinkDelta: () => {},
    onStatus: (t) => status.push(t),
    onDone: () => {}, onError: () => {},
  }
  const provider = makeClaudeProvider({ bin: 'node', preArgs: [cli], defaultModels: [] })
  const session = provider.chat!({ id: 't1', cwd: dir, model: 'opus-4.8', text: 'hi', history: [], attachments: [] } as never, cb, process.env)
  await session.done
  return { status, text }
}

describe('claude chat: 钩子把这一轮拖住时说得出是谁', () => {
  it('★★钩子挂着不回 → 播报是哪个钩子在等', async () => {
    const { status } = await run(CLI_STUCK)
    const line = status.find(s => s.includes('钩子响应'))
    expect(line, `没播报。收到的是:${JSON.stringify(status)}`).toBeTruthy()
    expect(line).toContain('PermissionRequest')
  })

  it('★钩子报错也要说 —— 这台机器上两个钩子一直在报错,用户至今不知道', async () => {
    const { status } = await run(CLI_BROKEN)
    const line = status.find(s => s.includes('钩子失败'))
    expect(line).toBeTruthy()
    expect(line).toContain('PreToolUse')
    expect(line, '把堆栈整段摆出来没人看').not.toContain('stack line 2')
  })

  it('★秒回的钩子一个字都不说 —— 一轮几十个,全播报就是噪音', async () => {
    const { status } = await run(CLI_FAST)
    expect(status.filter(s => s.includes('钩子响应'))).toEqual([])
  })

  it('★钩子事件不该漏进正文', async () => {
    const { text } = await run(CLI_BROKEN)
    expect(text.join('')).not.toContain('hook_')
    expect(text.join('')).not.toContain('PingIsland')
  })
})
