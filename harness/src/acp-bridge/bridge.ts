import { randomUUID } from 'node:crypto'
import { agent, PROTOCOL_VERSION, RequestError, type AgentContext, type Stream } from '@agentclientprotocol/sdk'
import type { KernelEvent, MffaiClient } from '../protocol/index'

interface Turn {
  sessionId: string
  deltas: Promise<void>
  notify: AgentContext['notify']
  done(r: { ok: true } | { ok: false; reason: string }): void
}

const turnIdOf = (e: KernelEvent): string | undefined => {
  const id = (e.payload as { turnId?: unknown } | null | undefined)?.turnId
  return typeof id === 'string' ? id : undefined
}

const EARLY_MAX_TURNS = 16

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

  function dispatch(t: Turn, e: KernelEvent): void {
    const p = e.payload as { text?: string; reason?: string; message?: string }
    if (e.type === 'message.assistant.delta' && typeof p.text === 'string') {
      const text = p.text
      t.deltas = t.deltas.then(() =>
        t.notify('session/update', {
          sessionId: t.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        }),
      )
    } else if (e.type === 'turn.ended') t.done({ ok: true })
    else if (e.type === 'turn.failed') t.done({ ok: false, reason: p.message ?? p.reason ?? 'turn failed' })
  }

  function onEvent(e: KernelEvent): void {
    if (e.type !== 'message.assistant.delta' && e.type !== 'turn.ended' && e.type !== 'turn.failed') return
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
    .onRequest('session/new', async () => {
      const { sessionId } = await need().call('session.create', { commandId: randomUUID() })
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
          t = { sessionId, deltas: Promise.resolve(), notify: ctx.client.notify.bind(ctx.client) as AgentContext['notify'], done: resolve }
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
