import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { AgentSession } from '../types'

/**
 * 端到端(假 CLI 回放真实事件形状):浏览器工具的两种真实表现,2026-10-04 对 claude 2.1.285
 * `--chrome` 实测:
 *  · 会改变状态的工具(navigate)会先升起 can_use_tool 门,拒绝真的拦得住;
 *  · 只读工具(list_connected_browsers)【不】经过门 —— 由 CLI 判定,Forge 不能假设每个浏览器
 *    动作都有门,工具卡仍然要出现。
 *
 * 门事件的字段形状严格照抄 `claudeControl.ts` 的 `parseCanUseTool`(request_id / request.subtype /
 * request.tool_name / request.tool_use_id / request.input),和 `claude.chat.gate.test.ts` 里已经
 * 跑得通的真机原样报文一致 —— 不是 task-6-brief.md 里 `gate()` 的手写猜测形状。
 */
let dir: string
let live: AgentSession | null = null
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-bue2e-')) })
afterEach(() => { try { live?.cancel() } catch { /* 已经没了 */ } live = null; rmSync(dir, { recursive: true, force: true }) })

function scriptBin(lines: object[]): string {
  const cli = join(dir, 'e2e.js')
  writeFileSync(cli, `#!/usr/bin/env node
for (const l of ${JSON.stringify(lines)}) process.stdout.write(JSON.stringify(l) + '\\n')
process.stdin.resume()
setInterval(() => {}, 1000)
`)
  chmodSync(cli, 0o755)
  return cli
}

const S = 's1'
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant', session_id: S,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
})
// 形状照抄 parseCanUseTool 实际解析的字段:request_id(顶层) / request.subtype / request.tool_name /
// request.tool_use_id / request.input。
const gate = (id: string, name: string, input: unknown) => ({
  type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: name, tool_use_id: id, input },
})
const result = { type: 'result', subtype: 'success', is_error: false, session_id: S }

describe('浏览器动作的端到端表现', () => {
  it('★会改页面的动作要升门;拒绝之后不应被当成成功', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [scriptBin([
      gate('t1', 'mcp__claude-in-chrome__navigate', { url: 'https://example.com' }),
      toolUse('t1', 'mcp__claude-in-chrome__navigate', { url: 'https://example.com' }),
      result,
    ])], defaultModels: [] })
    const gated: string[] = []
    const tools: { title?: string }[] = []
    live = provider.chat!(
      { id: 'c1', prompt: 'x', model: 'opus-4.8', cwd: dir, browserUse: 'ask' },
      {
        onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
        onConfirm: async (req) => { gated.push(req.toolName ?? ''); return 'deny' },
        onToolActivity: (t) => { if (t.phase === 'start') tools.push({ title: t.title }) },
        onDone: () => {}, onError: () => {},
      },
      process.env,
    )
    await live.done
    expect(gated).toContain('mcp__claude-in-chrome__navigate')
    expect(tools[0]?.title).toContain('浏览器 · 打开页面')
  })

  it('★只读工具不升门,但工具卡照样要出现 —— UI 不能假设每个浏览器动作都有门', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [scriptBin([
      toolUse('t2', 'mcp__claude-in-chrome__list_connected_browsers', {}),
      result,
    ])], defaultModels: [] })
    const gated: string[] = []
    const tools: { title?: string }[] = []
    live = provider.chat!(
      { id: 'c2', prompt: 'x', model: 'opus-4.8', cwd: dir, browserUse: 'ask' },
      {
        onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {},
        onConfirm: async (req) => { gated.push(req.toolName ?? ''); return 'allow' },
        onToolActivity: (t) => { if (t.phase === 'start') tools.push({ title: t.title }) },
        onDone: () => {}, onError: () => {},
      },
      process.env,
    )
    await live.done
    expect(gated).toHaveLength(0)
    expect(tools[0]?.title).toContain('浏览器 · 列出浏览器')
  })
})
