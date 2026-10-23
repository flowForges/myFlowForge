import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGeminiProvider } from '../providers/gemini'
import { makeQwenProvider } from '../providers/qwen'
import { makeCopilotProvider } from '../providers/copilot'
import { makeKimiProvider } from '../providers/kimi'
import { providerGatesEachOperation, providerSupportsPermissions, providerUsesCommandShim, permissionAppliesMidRun } from '@shared/permissions'
import { shimEnv, shimmedPath } from '../commandShim'
import { acpKnownUnavailable, withAcpAvailability } from './acpAvailability'
import { fakeTransport, standardAgent, recorder, send } from './acpTestKit'
import { isAcpUnavailable, type AcpSpec } from './acpChat'
import { runAsChat } from './acpProvider'
import type { AgentProvider, ChatTask } from '../types'
import { resetAcpAvailability } from './acpAvailability'

beforeEach(() => resetAcpAvailability())

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

/** 交互聊天那一轮的回落关口:已授权(见 ChatTask.beforeFallback)。 */
const ALLOW = async () => true

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
    await p.chat!({ id: 'k1', prompt: 'hi', model: 'kimi-k2.5', cwd: dir, beforeFallback: ALLOW }, cb, process.env).done
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
    const r = await p.chat!({ id: 'q1', prompt: 'hi', model: 'qwen3-coder-plus', cwd: dir, beforeFallback: ALLOW }, cb, process.env).done
    expect(r.ok).toBe(true)
    expect(ev).toEqual(['text:第一行', 'text:\n第二行', 'done'])
  })
})

/** 照 ipc/handlers.ts 的做法装好 shim 的 env(PATH 前插 shim 目录 + shimEnv)。 */
function shimmed(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shimDir = join(dir, 'run', 'shims')
  return { ...base, PATH: shimmedPath(shimDir, base.PATH), ...shimEnv(join(dir, 'run'), shimDir, base.ZDOTDIR) }
}

describe('★★回落关口:run() 那条没有门,没人点头就不跑', () => {
  const refusing = () => fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('unknown method') })).transport
  const make = [
    (open: never) => makeGeminiProvider({ bin: cli, defaultModels: [], acp: { open } }),
    (open: never) => makeQwenProvider({ bin: cli, defaultModels: [], acp: { open } }),
    (open: never) => makeCopilotProvider({ bin: cli, defaultModels: [], acp: { open } }),
    (open: never) => makeKimiProvider({ bin: cli, defaultModels: [], acp: { open } }),
  ]

  it('关口拒绝 → run() 不跑(假 CLI 的输出一行都没有),这一轮按停止收尾', async () => {
    for (const m of make) {
      resetAcpAvailability()
      const { ev, cb } = recorder()
      const r = await m(refusing as never).chat!({ id: 'x', prompt: 'hi', model: 'default', cwd: dir, beforeFallback: async () => false }, cb, process.env).done
      expect(r.ok).toBe(false)
      expect(ev).toEqual(['done'])
    }
  })

  it('没给关口(一次性调用)→ run() 不跑,按「没有 chat()」失败', async () => {
    for (const m of make) {
      resetAcpAvailability()
      const errors: Error[] = []
      const { ev, cb } = recorder({ onError: (e) => errors.push(e) })
      await m(refusing as never).chat!({ id: 'x', prompt: 'hi', model: 'default', cwd: dir }, cb, process.env).done
      expect(ev).toEqual([])
      expect(errors.map(isAcpUnavailable)).toEqual([true])
    }
    // kimi 选了具体模型那条本来就直接走 run() —— 一样要关口
    const errors: Error[] = []
    await makeKimiProvider({ bin: cli, defaultModels: [] }).chat!({ id: 'k', prompt: 'hi', model: 'kimi-k2.5', cwd: dir }, recorder({ onError: (e) => errors.push(e) }).cb, process.env).done
    expect(errors.map(isAcpUnavailable)).toEqual([true])
  })

  it('关口答应 → run() 照跑', async () => {
    const { ev, cb } = recorder()
    await makeGeminiProvider({ bin: cli, defaultModels: [], acp: { open: refusing } }).chat!({ id: 'g', prompt: 'hi', model: 'default', cwd: dir, beforeFallback: ALLOW }, cb, process.env).done
    expect(ev).toEqual(['text:第一行', 'text:\n第二行', 'done'])
  })
})

describe('PATH shim:ACP 那条拆掉,回落那条留着', () => {
  it('ACP 子进程拿到的 env 里没有 shim(PATH 去掉 shim 目录、ZDOTDIR 还原),调用方那份不动', async () => {
    const env = shimmed({ PATH: '/usr/bin:/bin', ZDOTDIR: '/home/me/.zsh' })
    for (const make of [
      (acp: never) => makeCopilotProvider({ bin: 'copilot', defaultModels: [], acp }),
      (acp: never) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }),
      (acp: never) => makeKimiProvider({ bin: 'kimi', defaultModels: [], acp }),
    ]) {
      const { spec } = await acpTurn(make as never, {}, env)
      expect(spec.env.PATH).toBe('/usr/bin:/bin')
      expect(spec.env.ZDOTDIR).toBe('/home/me/.zsh')
      expect(spec.env.FORGE_SHIM_DIR).toBeUndefined()
      expect(spec.env.FORGE_ORIG_ZDOTDIR).toBeUndefined()
    }
    expect(env.FORGE_SHIM_DIR).toBe(join(dir, 'run', 'shims'))
    expect(env.PATH!.startsWith(join(dir, 'run', 'shims'))).toBe(true)
  })

  it('copilot 握手不成回落到 run() → 那一轮仍带着 shim', async () => {
    const envCli = join(dir, 'env.js')
    writeFileSync(envCli, `#!/usr/bin/env node\nprocess.stdout.write('SHIM=' + (process.env.FORGE_SHIM_DIR || '') + '\\n')\nprocess.stdout.write('PATH0=' + process.env.PATH.split(':')[0] + '\\n')\n`)
    chmodSync(envCli, 0o755)
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('unknown method') }))
    const p = makeCopilotProvider({ bin: envCli, defaultModels: [], acp: { open: () => transport } })
    const { ev, cb } = recorder()
    const env = shimmed({ ...process.env })
    await p.chat!({ id: 'c1', prompt: 'hi', model: 'default', cwd: dir, beforeFallback: ALLOW }, cb, env).done
    const shimDir = join(dir, 'run', 'shims')
    expect(ev).toEqual([`text:SHIM=${shimDir}`, `text:\nPATH0=${shimDir}`, 'done'])
  })
})

describe('ACP 可用性按 bin 记住', () => {
  it('握手失败一次 → 本次运行里同一个 bin 不再试 ACP,直接回落;成功的 bin 不受影响', async () => {
    const opens: string[] = []
    const bad = () => fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('nope') })).transport
    const p = makeQwenProvider({ bin: cli, defaultModels: [], acp: { open: (spec) => { opens.push(spec.bin); return bad() } } })
    const turn = async () => { const { ev, cb } = recorder(); await p.chat!({ id: 'q', prompt: 'hi', model: 'm', cwd: dir, beforeFallback: ALLOW }, cb, process.env).done; return ev }
    expect(await turn()).toEqual(['text:第一行', 'text:\n第二行', 'done'])
    expect(acpKnownUnavailable(cli)).toBe(true)
    expect(await turn()).toEqual(['text:第一行', 'text:\n第二行', 'done'])
    expect(opens).toEqual([cli])   // 第二轮没再起 ACP
    await acpTurn((acp) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }))
    expect(acpKnownUnavailable('gemini')).toBe(false)
  })

  it('detect 结果按 bin 补上 acpUnavailable', async () => {
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('nope') }))
    await makeCopilotProvider({ bin: cli, defaultModels: [], acp: { open: () => transport } }).chat!({ id: 'c', prompt: 'hi', model: 'default', cwd: dir }, recorder().cb, process.env).done
    const list = withAcpAvailability([{ id: 'copilot' }, { id: 'gemini' }], { copilot: { bin: cli }, gemini: { bin: 'gemini' } })
    expect(list).toEqual([{ id: 'copilot', acpUnavailable: true }, { id: 'gemini' }])
  })
})

describe('只读审阅档', () => {
  it('gemini / qwen 起手就是 plan 审批档', async () => {
    const g = await acpTurn((acp) => makeGeminiProvider({ bin: 'gemini', defaultModels: [], acp }), { model: 'gemini-2.5-pro', permissionMode: 'readonly' })
    expect(g.spec.args).toEqual(['--acp', '--approval-mode', 'plan', '-m', 'gemini-2.5-pro'])
    const q = await acpTurn((acp) => makeQwenProvider({ bin: 'qwen', defaultModels: [], acp }), { model: 'default', permissionMode: 'readonly' })
    expect(q.spec.args).toEqual(['--acp', '--approval-mode', 'plan'])
  })

  it('非只读的工具门直接拒(不去问人);agent 自己标为 read 的照常交给上层', async () => {
    const asked: string[] = []
    const outcomes: unknown[] = []
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      for (const [id, kind] of [['w', 'edit'], ['r', 'read']] as const) {
        const res = await cx.request('session/request_permission', { sessionId: sid, toolCall: { toolCallId: id, title: id, kind }, options: [{ optionId: 'ok', name: 'ok', kind: 'allow_once' }, { optionId: 'no', name: 'no', kind: 'reject_once' }] })
        outcomes.push(res.outcome)
      }
      return { stopReason: 'end_turn' }
    }))
    const p = makeCopilotProvider({ bin: 'copilot', defaultModels: [], acp: { open: () => transport } })
    const { cb } = recorder({ onConfirm: async (req) => { asked.push(req.title); return 'allow' } })
    await p.chat!({ id: 'c', prompt: 'hi', model: 'default', cwd: dir, permissionMode: 'readonly' }, cb, {}).done
    expect(asked).toEqual(['r'])
    expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'no' }, { outcome: 'selected', optionId: 'ok' }])
  })
})

describe('权限门 / 权限档', () => {
  it('gemini / qwen / copilot:没试过或握手成功 → 逐操作门 + 支持权限档;已知讲不了 ACP → 和以前一样', () => {
    for (const id of ['gemini', 'qwen', 'copilot']) {
      expect(providerGatesEachOperation(id)).toBe(true)
      expect(providerSupportsPermissions(id)).toBe(true)
      expect(permissionAppliesMidRun(id, 'full')).toBe(true)
      expect(providerGatesEachOperation(id, true)).toBe(false)
      expect(providerSupportsPermissions(id, true)).toBe(false)
      expect(permissionAppliesMidRun(id, 'full', true)).toBe(false)
      expect(permissionAppliesMidRun(id, 'full', false, 'auto')).toBe(true)
      expect(permissionAppliesMidRun(id, 'full', false, 'readonly')).toBe(false)
    }
    expect(providerGatesEachOperation('kimi')).toBe(false)
    expect(providerSupportsPermissions('kimi')).toBe(false)
    expect(providerSupportsPermissions('claude', true)).toBe(true)
  })

  it('PATH shim 不看 ACP:只有原生有门的 claude 免装', () => {
    for (const id of ['gemini', 'qwen', 'copilot', 'kimi', 'cursor', 'codex']) expect(providerUsesCommandShim(id)).toBe(true)
    expect(providerUsesCommandShim('claude')).toBe(false)
  })
})

describe('runAsChat', () => {
  it('forwards the permission mode to run() (a readonly turn must stay readonly)', async () => {
    const seen: (string | undefined)[] = []
    const run: Parameters<typeof runAsChat>[0] = (t, cb) => {
      seen.push(t.permissionMode)
      cb.onLog({ ts: '0', text: 'x', level: 'accent' })
      return { id: t.agentId, cancel() {}, done: Promise.resolve({ ok: true }) }
    }
    const cb = { onSession() {}, onAssistantDelta() {}, onThinkDelta() {}, onDone() {}, onError() {} }
    await runAsChat(run, { id: 'a', prompt: 'p', model: 'm', cwd: dir, permissionMode: 'readonly' }, cb, {}).done
    await runAsChat(run, { id: 'b', prompt: 'p', model: 'm', cwd: dir }, cb, {}).done
    expect(seen).toEqual(['readonly', undefined])
  })
})
