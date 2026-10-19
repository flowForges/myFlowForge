import { vi } from 'vitest'
import { agent, ndJsonStream, RequestError, type AgentApp, type AgentContext, type SessionNotification } from '@agentclientprotocol/sdk'
import type { AcpTransport, AcpSpec } from './acpChat'
import type { ChatCallbacks, ChatTask } from '../types'

// ACP 测试工具(只给 *.test.ts 用,生产代码不引用)。

// ── 假 agent:用 SDK 自己的 agent 端,跑在内存流上 ──────────────────────────────
// 两条 TransformStream 交叉接成一对 ndjson 流 —— 和真进程的 stdin/stdout 走的是同一套编解码,
// 只是不起进程。kill() 关掉连接并让 exited 落地,模拟进程被杀。

export function fakeTransport(build: (app: AgentApp) => AgentApp) {
  const c2a = new TransformStream<Uint8Array, Uint8Array>()
  const a2c = new TransformStream<Uint8Array, Uint8Array>()
  const conn = build(agent({ name: 'fake-agent' })).connect(ndJsonStream(a2c.writable, c2a.readable))
  let exit!: (r: { code?: number | null; message?: string }) => void
  const exited = new Promise<{ code?: number | null; message?: string }>((r) => { exit = r })
  const kill = vi.fn(() => { conn.close(); exit({ code: null }) })
  const transport: AcpTransport = { stream: ndJsonStream(c2a.writable, a2c.readable), kill, exited }
  return { transport, kill, exit, conn }
}

export const SPEC: AcpSpec = { bin: 'fake', args: ['--acp'], env: {}, cwd: '/ws' }
export const TASK: ChatTask = { id: 'c1', prompt: '你好', model: 'm', cwd: '/ws' }

export function recorder(over: Partial<ChatCallbacks> = {}) {
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

export const send = (cx: AgentContext, sessionId: string, update: SessionNotification['update']) =>
  cx.notify('session/update', { sessionId, update })

/** 一个标准的假 agent:握手 → 建会话 → prompt 时跑 `turn`。 */
export function standardAgent(turn: (cx: AgentContext, sessionId: string, prompt: unknown) => Promise<unknown>, opts: { loadSession?: boolean; loadFails?: boolean; seen?: Record<string, unknown[]> } = {}) {
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
