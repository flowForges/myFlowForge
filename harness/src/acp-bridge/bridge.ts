import { randomUUID } from 'node:crypto'
import { agent, PROTOCOL_VERSION, RequestError, type AgentContext, type PermissionOption, type SessionUpdate, type Stream, type ToolKind } from '@agentclientprotocol/sdk'
import type { KernelEvent, MffaiClient } from '../protocol/index'

interface Turn {
  sessionId: string
  deltas: Promise<void>
  client: AgentContext
  done(r: { ok: true } | { ok: false; reason: string }): void
}

const turnIdOf = (e: KernelEvent): string | undefined => {
  const id = (e.payload as { turnId?: unknown } | null | undefined)?.turnId
  return typeof id === 'string' ? id : undefined
}

const EARLY_MAX_TURNS = 16
const ROUTED = new Set(['message.assistant.delta', 'tool.started', 'tool.ended', 'approval.requested', 'turn.ended', 'turn.failed'])

const TOOL_KIND: Record<string, ToolKind> = {
  read: 'read', list: 'read', glob: 'search', grep: 'search',
  write: 'edit', edit: 'edit', apply_patch: 'edit', shell: 'execute',
}

type Decision = 'allow' | 'allow_session' | 'deny' // optionId 即 approval.respond 的 decision
const PERMISSION_OPTIONS: Array<PermissionOption & { optionId: Decision }> = [
  { optionId: 'allow', name: '允许', kind: 'allow_once' },
  { optionId: 'allow_session', name: '本会话允许', kind: 'allow_always' },
  { optionId: 'deny', name: '拒绝', kind: 'reject_once' },
]

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** prompt 响应(才带 turnId)之前就到的事件的暂存:只在有 prompt 在途时收,按 turnId 限量,丢最旧的 */
export class EarlyBuffer {
  private inflight = 0
  private map = new Map<string, KernelEvent[]>()
  get size(): number { return this.map.size }
  begin(): void { this.inflight++ }
  end(): void {
    if (--this.inflight <= 0) { this.inflight = 0; this.map.clear() }
  }
  add(id: string, e: KernelEvent): void {
    if (this.inflight === 0) return
    const list = this.map.get(id)
    if (list) { list.push(e); return }
    this.map.set(id, [e])
    if (this.map.size > EARLY_MAX_TURNS) this.map.delete(this.map.keys().next().value as string)
  }
  take(id: string): KernelEvent[] {
    const list = this.map.get(id) ?? []
    this.map.delete(id)
    return list
  }
}

/** ACP(agent 侧)↔ 工作进程。只连接,绝不拉起后台进程。 */
export async function runBridge(opts: { stream: Stream; connect: () => Promise<MffaiClient> }): Promise<void> {
  let worker: MffaiClient | undefined
  let ready: Promise<MffaiClient> | undefined
  let closed = false
  const turns = new Map<string, Turn>()
  const early = new EarlyBuffer()
  const prompting = new Set<string>() // 有 prompt 在途的 sessionId
  const cancelled = new Set<string>() // 已请求取消的 sessionId

  const need = (): MffaiClient => {
    if (!worker || closed) throw new RequestError(-32603, 'mff-ai 连接已断开')
    return worker
  }

  /** 本轮的通知按事件顺序排队发出 */
  function send(t: Turn, update: SessionUpdate): void {
    t.deltas = t.deltas.then(() => t.client.notify('session/update', { sessionId: t.sessionId, update }))
  }

  /** 问客户端;取消 / 出错 / 不认识的选项 → deny。请求在队列里按序发出,但不堵住后面的通知 */
  function ask(t: Turn, approvalId: string, callId: string, summary: string): void {
    t.deltas = t.deltas.then(() => {
      void t.client
        .request('session/request_permission', {
          sessionId: t.sessionId,
          toolCall: { toolCallId: callId, title: summary },
          options: PERMISSION_OPTIONS,
        })
        .then(
          (r): Decision => {
            const id = r.outcome.outcome === 'selected' ? r.outcome.optionId : 'deny'
            return PERMISSION_OPTIONS.some((o) => o.optionId === id) ? (id as Decision) : 'deny'
          },
          (): Decision => 'deny',
        )
        .then((decision) => worker?.call('approval.respond', { approvalId, decision }))
        .catch(() => {})
    })
  }

  function dispatch(t: Turn, e: KernelEvent): void {
    const p = e.payload as Record<string, unknown> & { text?: string; reason?: string; message?: string }
    if (e.type === 'message.assistant.delta' && typeof p.text === 'string') {
      send(t, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: p.text } })
    } else if (e.type === 'tool.started') {
      const name = str(p.name)
      send(t, {
        sessionUpdate: 'tool_call',
        toolCallId: str(p.callId),
        title: `${name} ${str(p.argsPreview).slice(0, 80)}`,
        kind: TOOL_KIND[name] ?? 'other',
        status: 'in_progress',
      })
    } else if (e.type === 'tool.ended') {
      send(t, {
        sessionUpdate: 'tool_call_update',
        toolCallId: str(p.callId),
        status: p.ok === true ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: str(p.content) } }],
      })
    } else if (e.type === 'approval.requested') {
      ask(t, str(p.approvalId), str(p.callId), str(p.summary))
    } else if (e.type === 'turn.ended') t.done({ ok: true })
    else if (e.type === 'turn.failed') t.done({ ok: false, reason: p.message ?? p.reason ?? 'turn failed' })
  }

  function onEvent(e: KernelEvent): void {
    if (!ROUTED.has(e.type)) return
    const id = turnIdOf(e)
    if (!id) return
    const t = turns.get(id)
    if (t) dispatch(t, e)
    else early.add(id, e)
  }

  function onGone(): void {
    closed = true
    for (const t of [...turns.values()]) t.done({ ok: false, reason: 'mff-ai 连接已断开' })
  }

  async function open(): Promise<MffaiClient> {
    const c = await opts.connect()
    try {
      const { lastSeq } = await c.call('snapshot')
      c.onClose(onGone)
      c.onEvent(onEvent)
      await c.call('events.subscribe', { after: lastSeq })
    } catch (e) {
      c.close()
      throw e
    }
    worker = c
    return c
  }

  const app = agent({ name: 'mff-ai' })
    .onRequest('initialize', async () => {
      try {
        await (ready ??= open())
      } catch {
        ready = undefined
        throw new RequestError(-32603, 'mff-ai 未运行')
      }
      return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }
    })
    .onRequest('session/new', async (ctx) => {
      const { sessionId } = await need()
        .call('session.create', { commandId: randomUUID(), cwd: ctx.params.cwd })
        .catch((e: Error & { code?: number }) => {
          throw new RequestError(e.code === -32602 ? -32602 : -32603, e.message)
        })
      return { sessionId }
    })
    .onRequest('session/prompt', async (ctx) => {
      const w = need()
      const { sessionId } = ctx.params
      const text = ctx.params.prompt.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      cancelled.delete(sessionId)
      prompting.add(sessionId)
      early.begin()
      let turnId: string | undefined
      try {
        const res = await w.call('session.prompt', { commandId: randomUUID(), sessionId, text }).catch((e: Error) => {
          throw new RequestError(-32603, e.message)
        })
        if (!res.accepted) throw new RequestError(-32603, 'mff-ai 拒绝了这次请求')
        turnId = res.turnId

        let t!: Turn
        const finished = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
          t = { sessionId, deltas: Promise.resolve(), client: ctx.client, done: resolve }
        })
        turns.set(turnId, t)
        for (const e of early.take(turnId)) dispatch(t, e)
        if (closed) t.done({ ok: false, reason: 'mff-ai 连接已断开' })
        const abort = () => {
          cancelled.add(sessionId)
          void w.call('session.cancel', { commandId: randomUUID(), sessionId }).catch(() => {})
        }
        ctx.signal.addEventListener('abort', abort, { once: true })
        try {
          const r = await finished
          await t.deltas
          if (r.ok) return { stopReason: 'end_turn' as const }
          if (cancelled.has(sessionId)) return { stopReason: 'cancelled' as const }
          throw new RequestError(-32603, r.reason)
        } finally {
          ctx.signal.removeEventListener('abort', abort)
        }
      } finally {
        if (turnId) turns.delete(turnId)
        prompting.delete(sessionId)
        cancelled.delete(sessionId)
        early.end()
      }
    })
    .onNotification('session/cancel', async (ctx) => {
      if (prompting.has(ctx.params.sessionId)) cancelled.add(ctx.params.sessionId)
      await worker?.call('session.cancel', { commandId: randomUUID(), sessionId: ctx.params.sessionId }).catch(() => {})
    })

  const conn = app.connect(opts.stream)
  await conn.closed
  worker?.close()
}
