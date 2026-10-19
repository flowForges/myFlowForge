import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGeminiProvider } from '../providers/gemini'
import { makeQwenProvider } from '../providers/qwen'
import { makeCopilotProvider } from '../providers/copilot'
import { makeKimiProvider } from '../providers/kimi'
import { providerGatesEachOperation } from '@shared/permissions'
import { fakeTransport, standardAgent, recorder, send } from './acpTestKit'
import type { AcpSpec } from './acpChat'
import type { AgentProvider, ChatTask } from '../types'

// provider 层:chat() 用对了 ACP 开关、没碰 per-project MCP 落盘、不续接会话、握手不成就回落到 run()。

let dir: string, cli: string
// 回落用的假 CLI:不认 ACP,当成老的一次性调用跑 —— 打两行输出就退出。
const FAKE = `#!/usr/bin/env node
process.stdout.write('第一行\\n')
process.stdout.write('第二行\\n')
process.exit(0)
`
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acp-prov-'))
  cli = join(dir, 'fake.js'); writeFileSync(cli, FAKE); chmodSync(cli, 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const FORGE_ENV = { FORGE_SOCKET: '/tmp/s', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/forgeMcp.js' }

/** 用假 ACP agent 跑一轮 provider.chat(),记下起进程时拿到的 spec 和 agent 收到的请求。 */
async function acpTurn(make: (acp: { open: (spec: AcpSpec) => ReturnType<typeof fakeTransport>['transport'] }) => AgentProvider, task: Partial<ChatTask> = {}, env: NodeJS.ProcessEnv = {}) {
  const seen: Record<string, unknown[]> = {}
  const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
    await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } })
    return { stopReason: 'end_turn' }
  }, { loadSession: true, seen }))
  const specs: AcpSpec[] = []
  const provider = make({ open: (spec) => { specs.push(spec); return transport } })
  const { ev, cb } = recorder()
  const r = await provider.chat!({ id: 'c1', prompt: '你好', model: 'default', cwd: dir, ...task }, cb, env).done
  return { r, ev, seen, spec: specs[0] }
}

describe('ACP 聊天 — 各 provider 的启动参数', () => {
  it('gemini:--acp + 钉死 default 审批档 + -m;流式正文、正常收尾', async () => {
    const { r, ev, spec } = await acpTurn((acp) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }), { model: 'gemini-2.5-pro' })
    expect(r.ok).toBe(true)
    expect(spec.bin).toBe('gemini')
    expect(spec.args).toEqual(['--acp', '--approval-mode', 'default', '-m', 'gemini-2.5-pro'])
    expect(spec.cwd).toBe(dir)
    expect(ev).toEqual(['text:pong', 'done'])
  })

  it('qwen:--acp + 钉死 default 审批档 + -m', async () => {
    const { spec } = await acpTurn((acp) => makeQwenProvider({ bin: 'qwen', defaultModels: [], acp }), { model: 'qwen3-coder-plus' })
    expect(spec.args).toEqual(['--acp', '--approval-mode', 'default', '-m', 'qwen3-coder-plus'])
  })

  it('copilot:只有 --acp(不带 --allow-all-tools),账号默认不带 --model;去掉 COPILOT_ALLOW_ALL 但不改调用方的 env', async () => {
    const env = { COPILOT_ALLOW_ALL: 'true', KEEP: '1' }
    const { spec } = await acpTurn((acp) => makeCopilotProvider({ bin: 'copilot', defaultModels: [], acp }), { model: 'default' }, env)
    expect(spec.args).toEqual(['--acp'])
    expect(spec.env.COPILOT_ALLOW_ALL).toBeUndefined()
    expect(spec.env.KEEP).toBe('1')
    expect(env.COPILOT_ALLOW_ALL).toBe('true')
    const withModel = await acpTurn((acp) => makeCopilotProvider({ bin: 'copilot', defaultModels: [], acp }), { model: 'gpt-5' })
    expect(withModel.spec.args).toEqual(['--acp', '--model', 'gpt-5'])
  })

  it('kimi:账号默认走 `kimi acp`', async () => {
    const { spec, r } = await acpTurn((acp) => makeKimiProvider({ bin: 'kimi', defaultModels: [], acp }))
    expect(r.ok).toBe(true)
    expect(spec.args).toEqual(['acp'])
  })

  it('kimi:选了具体模型 → 不走 ACP(`kimi acp` 不吃 --model),直接 run()', async () => {
    const open = vi.fn()
    const p = makeKimiProvider({ bin: cli, defaultModels: [], acp: { open } })
    const { ev, cb } = recorder()
    await p.chat!({ id: 'k1', prompt: 'hi', model: 'kimi-k2.5', cwd: dir }, cb, process.env).done
    expect(open).not.toHaveBeenCalled()
    expect(ev).toEqual(['text:第一行', 'text:\n第二行', 'done'])
  })
})

describe('ACP 聊天 — 会话与 MCP', () => {
  it('不续接:即使有旧 id、agent 也支持 loadSession,也是 session/new,且不把 ACP 会话 id 报给 chatService', async () => {
    const { ev, seen } = await acpTurn((acp) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }), { sessionId: 'old-1' })
    expect(seen['session/load']).toBeUndefined()
    expect(seen['session/new']).toHaveLength(1)
    expect(ev.some((e) => e.startsWith('session:'))).toBe(false)
  })

  it('forge MCP 走 session/new,不往项目里写 .gemini / .qwen 配置', async () => {
    const g = await acpTurn((acp) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }), {}, FORGE_ENV)
    expect((g.seen['session/new'][0] as { mcpServers: { name: string }[] }).mcpServers.map((m) => m.name)).toEqual(['forge'])
    await acpTurn((acp) => makeQwenProvider({ bin: 'qwen', defaultModels: [], acp }), {}, FORGE_ENV)
    expect(existsSync(join(dir, '.gemini'))).toBe(false)
    expect(existsSync(join(dir, '.qwen'))).toBe(false)
    const c = await acpTurn((acp) => makeCopilotProvider({ bin: 'copilot', defaultModels: [], acp }), {}, FORGE_ENV)
    expect(c.spec.args.join(' ')).not.toContain('--additional-mcp-config')
  })
})

describe('ACP 聊天 — 握手不成就回落到 run()', () => {
  it('initialize 报错 → 透明回落:run() 的输出按降级路映射成正文(行间补换行),onDone 收尾,不报错', async () => {
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('unknown method') }))
    const p = makeQwenProvider({ bin: cli, defaultModels: [], acp: { open: () => transport } })
    const { ev, cb } = recorder()
    const r = await p.chat!({ id: 'q1', prompt: 'hi', model: 'qwen3-coder-plus', cwd: dir }, cb, process.env).done
    expect(r.ok).toBe(true)
    expect(ev).toEqual(['text:第一行', 'text:\n第二行', 'done'])
  })
})

describe('权限门', () => {
  it('gemini / qwen / copilot 的聊天逐操作升门;kimi 不算(选具体模型时走 run(),没有门)', () => {
    expect(providerGatesEachOperation('gemini')).toBe(true)
    expect(providerGatesEachOperation('qwen')).toBe(true)
    expect(providerGatesEachOperation('copilot')).toBe(true)
    expect(providerGatesEachOperation('kimi')).toBe(false)
  })
})
