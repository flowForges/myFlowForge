import { describe, it, expect, vi } from 'vitest'
import { agent, ndJsonStream, RequestError, type AgentApp, type AgentContext, type RequestPermissionResponse, type SessionNotification } from '@agentclientprotocol/sdk'
import { runAcpChat, chatWithAcpFallback, AcpUnavailableError, isAcpUnavailable, type AcpTransport, type AcpSpec } from './acpChat'
import type { ChatCallbacks, ChatTask, ConfirmDecision, ConfirmReq } from '../types'

// ── 假 agent:用 SDK 自己的 agent 端,跑在内存流上 ──────────────────────────────
// 两条 TransformStream 交叉接成一对 ndjson 流 —— 和真进程的 stdin/stdout 走的是同一套编解码,
// 只是不起进程。kill() 关掉连接并让 exited 落地,模拟进程被杀。

function fakeTransport(build: (app: AgentApp) => AgentApp) {
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  const conn = build(agent({ name: 'fake-agent' })).connect(ndJsonStream(a2c.writable, c2a.readable))
  let exit!: (r: { code?: number | null; message?: string }) => void
  const exited = new Promise<{ code?: number | null; message?: string }>((r) => { exit = r })
  const kill = vi.fn(() => { conn.close(); exit({ code: null }) })
  const transport: AcpTransport = { stream: ndJsonStream(c2a.writable, a2c.readable), kill, exited }
  return { transport, kill, exit, conn }
}

const SPEC: AcpSpec = { bin: 'fake', args: ['--acp'], env: {}, cwd: '/ws' }
const TASK: ChatTask = { id: 'c1', prompt: '你好', model: 'm', cwd: '/ws' }

function recorder(over: Partial<ChatCallbacks> = {}) {
  const ev: string[] = []
  const cb: ChatCallbacks = {
    onSession: (id) => ev.push(`session:${id}`),
    onAssistantDelta: (t) => ev.push(`text:${t}`),
    onThinkDelta: (t) => ev.push(`think:${t}`),
    onStatus: (t) => ev.push(`status:${t}`),
    onUsage: (u) => ev.push(`usage:${u.used}/${u.window}`),
    onTurnTokens: (t) => ev.push(`tokens:${t.input}/${t.output}`),
    onToolActivity: (e) => ev.push(`tool:${e.phase}:${e.id}:${e.title ?? ''}${e.output !== undefined ? `:${e.output}` : ''}${e.isError ? ':err' : ''}`),
    onDone: () => ev.push('done'),
    onError: (e) => ev.push(`error:${e.message}`),
    ...over,
  }
  return { ev, cb }
}

const send = (cx: AgentContext, sessionId: string, update: SessionNotification['update']) =>
  cx.notify('session/update', { sessionId, update })

/** 一个标准的假 agent:握手 → 建会话 → prompt 时跑 `turn`。 */
function standardAgent(turn: (cx: AgentContext, sessionId: string, prompt: unknown) => Promise<unknown>, opts: { loadSession?: boolean; loadFails?: boolean; seen?: Record<string, unknown[]> } = {}) {
  const seen = opts.seen ?? {}
  const rec = (m: string, p: unknown) => { (seen[m] ??= []).push(p) }
  return (app: AgentApp) => app
    .onRequest('initialize', (ctx) => { rec('initialize', ctx.params); return { protocolVersion: 1, agentCapabilities: { loadSession: !!opts.loadSession } } })
    .onRequest('session/new', (ctx) => { rec('session/new', ctx.params); return { sessionId: 's-new' } })
    .onRequest('session/load', async (ctx) => {
      rec('session/load', ctx.params)
      if (opts.loadFails) throw RequestError.resourceNotFound(ctx.params.sessionId)
      // ★按协议,load 时 agent 会把历史整段重放一遍 —— 这些不能当成这一轮的输出。
      await send(ctx.client, ctx.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧回答' } })
      return {}
    })
    .onRequest('session/prompt', async (ctx) => { rec('session/prompt', ctx.params); return (await turn(ctx.client, ctx.params.sessionId, ctx.params.prompt)) as never })
    .onNotification('session/cancel', (ctx) => { rec('session/cancel', ctx.params) })
}

describe('runAcpChat — 映射', () => {
  it('正文 / 思考 → delta,会话 id 上报,轮末 onDone;握手声明不提供 fs/terminal', async () => {
    const seen: Record<string, unknown[]> = {}
    const { transport, kill } = fakeTransport(standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一想' } })
      await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } })
      await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } })
      return { stopReason: 'end_turn' }
    }, { seen }))
    const { ev, cb } = recorder()
    const s = runAcpChat(SPEC, { ...TASK, attachments: [{ path: '/ws/a.png' } as never] }, cb, { open: () => transport })
    const r = await s.done
    expect(r.ok).toBe(true)
    expect(ev).toEqual(['session:s-new', 'think:想一想', 'text:你', 'text:好', 'done'])
    expect(seen.initialize[0]).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    // 附件按今天的做法以路径文本带上
    expect(seen['session/prompt'][0]).toMatchObject({ sessionId: 's-new', prompt: [{ type: 'text', text: '你好\n\n附件:\n- /ws/a.png' }] })
    expect(kill).toHaveBeenCalled()
  })

  it('session/new 带 cwd 和 forge MCP(有 FORGE_* 时)', async () => {
    const seen: Record<string, unknown[]> = {}
    const { transport } = fakeTransport(standardAgent(async () => ({ stopReason: 'end_turn' }), { seen }))
    const env = { FORGE_SOCKET: '/tmp/s', FORGE_AGENT_ID: 'a1', FORGE_MCP_ENTRY: '/x/forgeMcp.js' }
    await runAcpChat({ ...SPEC, env }, TASK, recorder().cb, { open: () => transport }).done
    const req = seen['session/new'][0] as { cwd: string; mcpServers: { name: string; command: string; args: string[]; env: { name: string; value: string }[] }[] }
    expect(req.cwd).toBe('/ws')
    expect(req.mcpServers).toHaveLength(1)
    expect(req.mcpServers[0]).toMatchObject({ name: 'forge', command: process.execPath, args: ['/x/forgeMcp.js'] })
    expect(req.mcpServers[0].env).toEqual(expect.arrayContaining([{ name: 'FORGE_SOCKET', value: '/tmp/s' }, { name: 'FORGE_AGENT_ID', value: 'a1' }]))
  })

  it('tool_call / tool_call_update → 执行块 start/done(带输出、失败标记);工具之后的正文另起一段', async () => {
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '我先看看。' } })
      await send(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'ls', kind: 'execute', status: 'pending' })
      // 输出先到、收尾那条只带 status —— 卡片上仍要有输出
      await send(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] })
      await send(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
      await send(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'cat b', kind: 'read' })
      await send(cx, sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed', rawOutput: 'no such file' })
      await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看完了' } })
      return { stopReason: 'end_turn' }
    }))
    const { ev, cb } = recorder()
    await runAcpChat(SPEC, TASK, cb, { open: () => transport }).done
    expect(ev).toEqual([
      'session:s-new', 'text:我先看看。',
      'tool:start:t1:ls', 'tool:done:t1:ls:a.txt',
      'tool:start:t2:cat b', 'tool:done:t2:cat b:no such file:err',
      'text:\n\n看完了', 'done',
    ])
  })

  it('usage_update → onUsage(used/size);prompt 响应里的 usage → onTurnTokens', async () => {
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'usage_update', used: 1200, size: 200000 })
      await send(cx, sid, { sessionUpdate: 'usage_update', used: 1200, size: 200000 })   // 没变化 → 不重复上报
      await send(cx, sid, { sessionUpdate: 'usage_update', used: 3400, size: 200000 })
      return { stopReason: 'end_turn', usage: { totalTokens: 50, inputTokens: 40, outputTokens: 10 } }
    }))
    const { ev, cb } = recorder()
    await runAcpChat(SPEC, TASK, cb, { open: () => transport }).done
    expect(ev).toEqual(['session:s-new', 'usage:1200/200000', 'usage:3400/200000', 'tokens:40/10', 'done'])
  })
})

describe('runAcpChat — 权限', () => {
  const OPTIONS = [
    { optionId: 'yes-always', name: 'Always', kind: 'allow_always' as const },
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
  ]
  function permAgent(outcomes: unknown[]) {
    return standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } })
      const r: RequestPermissionResponse = await cx.request('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1' }, options: OPTIONS })
      outcomes.push(r.outcome)
      return { stopReason: 'end_turn' }
    })
  }

  it('放行 → 选 allow_once(不替用户选「总是允许」);门上带工具卡 id 和命令', async () => {
    const outcomes: unknown[] = []
    const { transport } = fakeTransport(permAgent(outcomes))
    const reqs: ConfirmReq[] = []
    const { cb } = recorder({ onConfirm: async (r) => { reqs.push(r); return 'allow' } })
    await runAcpChat(SPEC, TASK, cb, { open: () => transport }).done
    expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'yes' }])
    expect(reqs[0]).toMatchObject({ title: 'rm -rf build', where: 'rm -rf build', toolUseId: 't1', readOnly: false })
  })

  it('拒绝 → 选 reject_once;没有确认门 → 失败即拦', async () => {
    for (const onConfirm of [async (): Promise<ConfirmDecision> => 'deny', undefined]) {
      const outcomes: unknown[] = []
      const { transport } = fakeTransport(permAgent(outcomes))
      const { cb } = recorder({ onConfirm })
      await runAcpChat(SPEC, TASK, cb, { open: () => transport }).done
      expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'no' }])
    }
  })

  it('只有「总是允许」可选时,放行就选它', async () => {
    const outcomes: unknown[] = []
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      const r: RequestPermissionResponse = await cx.request('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't9', title: 'x' }, options: [OPTIONS[0], OPTIONS[2]] })
      outcomes.push(r.outcome)
      return { stopReason: 'end_turn' }
    }))
    await runAcpChat(SPEC, TASK, recorder({ onConfirm: async () => 'allow' }).cb, { open: () => transport }).done
    expect(outcomes).toEqual([{ outcome: 'selected', optionId: 'yes-always' }])
  })

  it('agent 自己标为 read/search 的工具 → readOnly(交给上层按权限档放行)', async () => {
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'tool_call', toolCallId: 'r1', title: 'Read a.ts', kind: 'read', locations: [{ path: '/ws/a.ts' }] })
      await cx.request('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'r1' }, options: OPTIONS })
      return { stopReason: 'end_turn' }
    }))
    const reqs: ConfirmReq[] = []
    await runAcpChat(SPEC, TASK, recorder({ onConfirm: async (r) => { reqs.push(r); return 'allow' } }).cb, { open: () => transport }).done
    expect(reqs[0]).toMatchObject({ readOnly: true, where: '/ws/a.ts', toolUseId: 'r1' })
  })
})

describe('runAcpChat — 取消', () => {
  it('取消:先发 session/cancel 再杀进程树,悬着的权限请求按 cancelled 回答,onDone 照常', async () => {
    const seen: Record<string, unknown[]> = {}
    const outcomes: unknown[] = []
    let gateOpened!: () => void
    const opened = new Promise<void>((r) => { gateOpened = r })
    const { transport, kill } = fakeTransport(standardAgent(async (cx, sid) => {
      const r: RequestPermissionResponse = await cx.request('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 't1', title: 'x' }, options: [{ optionId: 'no', name: 'n', kind: 'reject_once' }] })
      outcomes.push(r.outcome)
      return { stopReason: 'cancelled' }
    }, { seen }))
    const { ev, cb } = recorder({ onConfirm: () => { gateOpened(); return new Promise<ConfirmDecision>(() => {}) } })
    const s = runAcpChat(SPEC, TASK, cb, { open: () => transport, cancelGraceMs: 200 })
    await opened
    s.cancel()
    const r = await s.done
    expect(r.ok).toBe(false)
    expect(ev).toEqual(['session:s-new', 'done'])
    await vi.waitFor(() => expect(kill).toHaveBeenCalled())
    expect(seen['session/cancel']).toEqual([{ sessionId: 's-new' }])
    expect(outcomes).toEqual([{ outcome: 'cancelled' }])
  })
})

describe('runAcpChat — 续接', () => {
  it('agent 声明 loadSession 且有旧 id → session/load,重放的历史不进这一轮', async () => {
    const seen: Record<string, unknown[]> = {}
    const { transport } = fakeTransport(standardAgent(async (cx, sid) => {
      await send(cx, sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新回答' } })
      return { stopReason: 'end_turn' }
    }, { seen, loadSession: true }))
    const { ev, cb } = recorder()
    await runAcpChat(SPEC, { ...TASK, sessionId: 's-old' }, cb, { open: () => transport }).done
    expect(seen['session/load'][0]).toMatchObject({ sessionId: 's-old', cwd: '/ws', mcpServers: [] })
    expect(seen['session/new']).toBeUndefined()
    expect(ev).toEqual(['session:s-old', 'text:新回答', 'done'])
  })

  it('agent 不支持 loadSession → 每次新开会话', async () => {
    const seen: Record<string, unknown[]> = {}
    const { transport } = fakeTransport(standardAgent(async () => ({ stopReason: 'end_turn' }), { seen }))
    const { ev, cb } = recorder()
    await runAcpChat(SPEC, { ...TASK, sessionId: 's-old' }, cb, { open: () => transport }).done
    expect(seen['session/load']).toBeUndefined()
    expect(ev[0]).toBe('session:s-new')
  })

  it('load 失败 → 新开会话继续这一轮', async () => {
    const { transport } = fakeTransport(standardAgent(async () => ({ stopReason: 'end_turn' }), { loadSession: true, loadFails: true }))
    const { ev, cb } = recorder()
    const r = await runAcpChat(SPEC, { ...TASK, sessionId: 's-old' }, cb, { open: () => transport }).done
    expect(r.ok).toBe(true)
    expect(ev.filter((e) => !e.startsWith('status:'))).toEqual(['session:s-new', 'done'])
  })
})

describe('runAcpChat — 握手失败 = 回落信号', () => {
  it('initialize 报错 → AcpUnavailableError 交给 onUnavailable,不走 onError、不出任何正文', async () => {
    const { transport, kill } = fakeTransport((app) => app.onRequest('initialize', () => { throw RequestError.methodNotFound('initialize') }))
    const { ev, cb } = recorder()
    const onUnavailable = vi.fn()
    const r = await runAcpChat(SPEC, TASK, cb, { open: () => transport, onUnavailable }).done
    expect(r.ok).toBe(false)
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect(onUnavailable.mock.calls[0][0]).toBeInstanceOf(AcpUnavailableError)
    expect(ev).toEqual([])
    expect(kill).toHaveBeenCalled()
  })

  it('没给 onUnavailable 时,同一个错误走 onError(可用 isAcpUnavailable 识别)', async () => {
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('boom') }))
    const errs: Error[] = []
    await runAcpChat(SPEC, TASK, recorder({ onError: (e) => errs.push(e) }).cb, { open: () => transport }).done
    expect(errs).toHaveLength(1)
    expect(isAcpUnavailable(errs[0])).toBe(true)
  })

  it('进程在握手前就退出(比如不认 --acp)→ 回落,错误里带上 stderr', async () => {
    const { transport, exit } = fakeTransport((app) => app)   // 不回 initialize
    const onUnavailable = vi.fn()
    const s = runAcpChat(SPEC, TASK, recorder().cb, {
      open: (_spec, onStderr) => { onStderr('error: unknown option --acp\n'); setTimeout(() => exit({ code: 2 }), 5); return transport },
      onUnavailable,
    })
    await s.done
    expect(onUnavailable).toHaveBeenCalledOnce()
    expect((onUnavailable.mock.calls[0][0] as Error).message).toContain('unknown option --acp')
  })

  it('握手超时(binary 起成了交互模式、一直不回)→ 回落', async () => {
    const { transport } = fakeTransport((app) => app)
    const onUnavailable = vi.fn()
    await runAcpChat(SPEC, TASK, recorder().cb, { open: () => transport, onUnavailable, handshakeMs: 30 }).done
    expect(onUnavailable).toHaveBeenCalledOnce()
  })

  it('协议版本不是 v1 → 回落', async () => {
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => ({ protocolVersion: 2 })))
    const onUnavailable = vi.fn()
    await runAcpChat(SPEC, TASK, recorder().cb, { open: () => transport, onUnavailable }).done
    expect(onUnavailable).toHaveBeenCalledOnce()
  })

  it('起进程同步抛错(找不到命令)→ 回落', async () => {
    const onUnavailable = vi.fn()
    await runAcpChat(SPEC, TASK, recorder().cb, { open: () => { throw new Error('ENOENT') }, onUnavailable }).done
    expect(onUnavailable).toHaveBeenCalledOnce()
  })

  it('握手之后的失败是普通错误,不是回落信号', async () => {
    const { transport } = fakeTransport(standardAgent(async () => { throw new Error('model exploded') }))
    const errs: Error[] = []
    const onUnavailable = vi.fn()
    const r = await runAcpChat(SPEC, TASK, recorder({ onError: (e) => errs.push(e) }).cb, { open: () => transport, onUnavailable }).done
    expect(r.ok).toBe(false)
    expect(onUnavailable).not.toHaveBeenCalled()
    expect(errs).toHaveLength(1)
    expect(isAcpUnavailable(errs[0])).toBe(false)
  })

  it('一轮中途进程退出 → 普通错误', async () => {
    let dead!: () => void
    const { transport, exit } = fakeTransport(standardAgent(() => new Promise(() => { dead() })))
    dead = () => setTimeout(() => exit({ code: 1 }), 5)
    const errs: Error[] = []
    await runAcpChat(SPEC, TASK, recorder({ onError: (e) => errs.push(e) }).cb, { open: () => transport }).done
    expect(errs).toHaveLength(1)
    expect(isAcpUnavailable(errs[0])).toBe(false)
  })
})

describe('chatWithAcpFallback', () => {
  const fallbackSession = () => ({ id: 'fb', cancel: vi.fn<() => void>(), done: Promise.resolve({ ok: true, summary: 'fallback' }) })

  it('ACP 不可用 → 走回落路径,done 来自回落那条', async () => {
    const { transport } = fakeTransport((app) => app.onRequest('initialize', () => { throw new Error('nope') }))
    const fb = fallbackSession()
    const fallback = vi.fn(() => fb)
    const { ev, cb } = recorder()
    const s = chatWithAcpFallback(SPEC, TASK, cb, fallback, { open: () => transport })
    expect(await s.done).toEqual({ ok: true, summary: 'fallback' })
    expect(fallback).toHaveBeenCalledOnce()
    expect(ev).toEqual([])
    s.cancel()
    expect(fb.cancel).toHaveBeenCalled()
  })

  it('ACP 可用 → 不碰回落', async () => {
    const { transport } = fakeTransport(standardAgent(async () => ({ stopReason: 'end_turn' })))
    const fallback = vi.fn(fallbackSession)
    const r = await chatWithAcpFallback(SPEC, TASK, recorder().cb, fallback, { open: () => transport }).done
    expect(r.ok).toBe(true)
    expect(fallback).not.toHaveBeenCalled()
  })
})

describe('spawnAcpTransport(真子进程)', () => {
  // 一个最小的 ACP agent,用 SDK 跑在真的 node 子进程里,走 stdio —— 验证默认传输的接线(toWeb + ndjson + 杀树)。
  const AGENT_SRC = `
    import { agent, ndJsonStream } from '@agentclientprotocol/sdk'
    import { Readable, Writable } from 'node:stream'
    agent({ name: 'real' })
      .onRequest('initialize', () => ({ protocolVersion: 1 }))
      .onRequest('session/new', () => ({ sessionId: 'real-1' }))
      .onRequest('session/prompt', async (ctx) => {
        await ctx.client.notify('session/update', { sessionId: ctx.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:' + ctx.params.prompt[0].text } } })
        return { stopReason: 'end_turn' }
      })
      .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
  `
  it('真进程:握手、流出正文、收尾', async () => {
    const spec: AcpSpec = { bin: process.execPath, args: ['--input-type=module', '-e', AGENT_SRC], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: process.cwd() }
    const { ev, cb } = recorder()
    const r = await runAcpChat(spec, { ...TASK, cwd: process.cwd() }, cb).done
    expect(r.ok).toBe(true)
    expect(ev).toContain('text:echo:你好')
    expect(ev.at(-1)).toBe('done')
  }, 20_000)

  it('命令不存在 → 回落信号', async () => {
    const onUnavailable = vi.fn()
    await runAcpChat({ ...SPEC, bin: '/nonexistent/acp-agent-xyz', cwd: process.cwd() }, TASK, recorder().cb, { onUnavailable }).done
    expect(onUnavailable).toHaveBeenCalledOnce()
  })
})
