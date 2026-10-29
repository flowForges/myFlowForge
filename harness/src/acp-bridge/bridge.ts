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

/** ACP(agent 侧)↔ 工作进程。只连接,绝不拉起后台进程。 */
export async function runBridge(opts: { stream: Stream; connect: () => Promise<MffaiClient> }): Promise<void> {
  let worker: MffaiClient | undefined
  let closed = false
  const turns = new Map<string, Turn>()
  const early = new Map<string, KernelEvent[]>() // prompt 响应前就到的事件
  const cancelled = new Set<string>() // 已请求取消的 sessionId

  const need = (): MffaiClient => {
    if (!worker || closed) throw new RequestError(-32603, 'mff-ai 连接已断开')
    return worker
  }

  function dispatch(t: Turn, e: KernelEvent): void {
    const p = e.payload as { text?: string; reason?: string }
    if (e.type === 'message.assistant.delta' && typeof p.text === 'string') {
      const text = p.text
      t.deltas = t.deltas.then(() =>
        t.notify('session/update', {
          sessionId: t.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        }),
      )
    } else if (e.type === 'turn.ended') t.done({ ok: true })
    else if (e.type === 'turn.failed') t.done({ ok: false, reason: p.reason ?? 'turn failed' })
  }

  function onEvent(e: KernelEvent): void {
    if (e.type !== 'message.assistant.delta' && e.type !== 'turn.ended' && e.type !== 'turn.failed') return
    const id = turnIdOf(e)
    if (!id) return
    const t = turns.get(id)
    if (t) dispatch(t, e)
    else early.set(id, [...(early.get(id) ?? []), e])
  }

  function onGone(): void {
    closed = true
    for (const t of [...turns.values()]) t.done({ ok: false, reason: 'mff-ai 连接已断开' })
  }

  const app = agent({ name: 'mff-ai' })
    .onRequest('initialize', async () => {
      if (!worker) {
        try {
          const c = await opts.connect()
          const { lastSeq } = await c.call('snapshot')
          c.onClose(onGone)
          c.onEvent(onEvent)
          await c.call('events.subscribe', { after: lastSeq })
          worker = c
        } catch {
          throw new RequestError(-32603, 'mff-ai 未运行')
        }
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
      const res = await w.call('session.prompt', { commandId: randomUUID(), sessionId, text }).catch((e: Error) => {
        throw new RequestError(-32603, e.message)
      })
      if (!res.accepted) throw new RequestError(-32603, 'mff-ai 拒绝了这次请求')

      let t!: Turn
      const finished = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
        t = { sessionId, deltas: Promise.resolve(), notify: ctx.client.notify.bind(ctx.client) as AgentContext['notify'], done: resolve }
      })
      turns.set(res.turnId, t)
      for (const e of early.get(res.turnId) ?? []) dispatch(t, e)
      early.delete(res.turnId)
      if (closed) t.done({ ok: false, reason: 'mff-ai 连接已断开' })
      const abort = () => void w.call('session.cancel', { commandId: randomUUID(), sessionId }).catch(() => {})
      ctx.signal.addEventListener('abort', abort, { once: true })
      try {
        const r = await finished
        await t.deltas
        if (r.ok) return { stopReason: 'end_turn' as const }
        if (cancelled.has(sessionId)) return { stopReason: 'cancelled' as const }
        throw new RequestError(-32603, r.reason)
      } finally {
        turns.delete(res.turnId)
        ctx.signal.removeEventListener('abort', abort)
      }
    })
    .onNotification('session/cancel', async (ctx) => {
      cancelled.add(ctx.params.sessionId)
      await need().call('session.cancel', { commandId: randomUUID(), sessionId: ctx.params.sessionId }).catch(() => {})
    })

  const conn = app.connect(opts.stream)
  await conn.closed
  worker?.close()
}
