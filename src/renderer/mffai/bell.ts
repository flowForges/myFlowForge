// mff-ai 进 app 的铃铛(08 §13.6)。App 只在 settings.mffai.enabled 为真时动态 import 这个模块。
// 三类来源:等你处理(审批、待确认记忆、推荐、配对)、完成(委派运行)、出问题(渠道、插件、MCP 服务)。
// Notif.t 是 HTML:每个插值都先过 sanitize()(评审修订 R1),工具名、插件 id、Telegram 名字是第三方给的。
// 配对码、令牌、记忆正文、命令全文、错误原文不进通知:只用事件里的 id、名字和状态码。
import type {
  ApprovalRequestedPayload, ApprovalResolvedPayload, ChannelPairedPayload, ChannelStatusPayload, ChannelUnpairedPayload,
  EventType, ExecutorRunEndedPayload, KernelEvent, MemoryRecommendationPayload, PluginIdPayload, PluginsMcpStatusPayload,
} from '@mffai/protocol'
import { sanitize, type Notif } from '../shell/notifications'
import { onMffaiEvent, onMffaiReset } from './events'
import { call, cmd, isUnsupported, retryable, toCallError } from './rpc'
import { route } from './route'
import { label } from './labels'

export interface BellSink {
  upsert(n: Notif): void
  remove(key: string): void
  /** 动作要跳到 mff-ai 页时调(开会话):App 切到 mff-ai 标签并收起弹层 */
  open?(): void
}

const PROPOSALS_DEBOUNCE_MS = 300
const PROPOSALS_KEY = 'mffai:proposals'
const META = 'mff-ai'

const TYPES: readonly EventType[] = [
  'approval.requested', 'approval.resolved', 'memory.proposal', 'memory.updated', 'memory.recommendation',
  'channel.paired', 'channel.unpaired', 'channel.pairing.burned', 'channel.status', 'executor.run.ended',
  'plugin.failed', 'plugins.integrity.failed', 'plugins.mcp.status',
]

const channelName = (c: string) => (c === 'telegram' ? 'Telegram' : sanitize(c))

export function startBell(sink: BellSink): () => void {
  let stopped = false
  const keys = new Set<string>()
  const responding = new Set<string>()
  const unpairing = new Set<string>()
  const unpairRetry = retryable()
  let proposalsShown = 0
  let readGen = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const put = (n: Notif & { key: string }) => {
    if (stopped) return
    keys.add(n.key)
    sink.upsert(n)
  }
  const drop = (key: string) => {
    if (stopped || !keys.delete(key)) return
    sink.remove(key)
  }
  const problem = (key: string, t: string, onOpen: () => void) =>
    put({ key, ic: 'warn', cls: 'ni-warn', t, m: META, unread: true, view: 'mffai', onOpen })

  const readProposals = () => {
    const gen = ++readGen
    void call('memory.proposals.list', { status: 'pending' }).then(
      (r) => {
        if (stopped || gen !== readGen) return
        const n = r.items.length
        if (n === proposalsShown) return
        proposalsShown = n
        if (n === 0) { drop(PROPOSALS_KEY); return }
        put({
          key: PROPOSALS_KEY, ic: 'file', cls: 'ni-file', t: `待确认记忆 ${n}`, m: META, unread: true, view: 'mffai',
          onOpen: () => route.set({ page: 'memory' }),
        })
      },
      (e) => { if (!stopped && !isUnsupported(e)) console.error('mffai bell memory.proposals.list', toCallError(e)) },
    )
  }
  const scheduleProposals = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; if (!stopped) readProposals() }, PROPOSALS_DEBOUNCE_MS)
  }

  const respond = (approvalId: string, decision: 'allow' | 'deny') => {
    if (stopped || responding.has(approvalId)) return
    responding.add(approvalId)
    void call('approval.respond', { approvalId, decision }).then(
      // ok:false:后台已经不认这个审批(别处答过、重启后),留着只会再点一次失败
      (r) => { if (!r.ok) drop(`mffai:approval:${approvalId}`) },
      (e) => console.error('mffai bell approval.respond', toCallError(e)),
    ).finally(() => { responding.delete(approvalId) })
  }

  const unpair = (accountId: string) => {
    if (stopped || unpairing.has(accountId)) return
    unpairing.add(accountId)
    void call('channel.telegram.unpair', { commandId: unpairRetry.id(accountId), accountId }).then(
      () => { unpairRetry.done(accountId); drop(`mffai:paired:${accountId}`) },
      (e) => console.error('mffai bell channel.telegram.unpair', toCallError(e)),
    ).finally(() => { unpairing.delete(accountId) })
  }

  const onEvent = (e: KernelEvent) => {
    switch (e.type) {
      case 'approval.requested': {
        const p = e.payload as ApprovalRequestedPayload
        const sessionId = e.sessionId
        put({
          key: `mffai:approval:${p.approvalId}`, ic: 'warn', cls: 'ni-warn', t: `<b>${sanitize(p.tool)}</b> 待审批`, m: META, unread: true,
          view: 'mffai', onOpen: () => route.set({ page: 'chat', ...(sessionId && { sessionId }) }),
          actions: [
            { label: '允许', run: () => respond(p.approvalId, 'allow') },
            { label: '拒绝', run: () => respond(p.approvalId, 'deny'), danger: true },
          ],
        })
        return
      }
      case 'approval.resolved':
        drop(`mffai:approval:${(e.payload as ApprovalResolvedPayload).approvalId}`)
        return
      case 'memory.proposal':
      case 'memory.updated':
        scheduleProposals()
        return
      case 'memory.recommendation': {
        const p = e.payload as MemoryRecommendationPayload
        const key = `mffai:rec:${p.id}`
        const openSession = () => {
          route.set({ page: 'chat', newSession: { cwd: p.cwd } })
          drop(key)
          sink.open?.()
        }
        put({
          key, ic: 'file', cls: 'ni-file', t: sanitize(p.text), m: META, unread: true, view: 'mffai',
          onOpen: () => route.set({ page: 'chat', newSession: { cwd: p.cwd } }),
          actions: [{ label: '开会话', run: openSession }],
        })
        return
      }
      case 'channel.paired': {
        const p = e.payload as ChannelPairedPayload
        put({
          key: `mffai:paired:${p.accountId}`, ic: 'ok', cls: 'ni-ok', t: `${channelName(p.channel)} 已配对 <b>${sanitize(p.name)}</b>`, m: META,
          unread: true, view: 'mffai', onOpen: () => route.set({ page: 'conn' }),
          actions: [{ label: '撤销', run: () => unpair(p.accountId), danger: true }],
        })
        return
      }
      case 'channel.unpaired': {
        const p = e.payload as ChannelUnpairedPayload
        drop(`mffai:paired:${p.accountId}`)
        if (p.by === 'im') problem(`mffai:unpaired:${p.accountId}`, `<b>${channelName(p.channel)}</b> 对方已解除配对`, () => route.set({ page: 'conn' }))
        return
      }
      case 'channel.pairing.burned': {
        const c = (e.payload as { channel: string }).channel
        problem(`mffai:burned:${c}`, `<b>${channelName(c)}</b> 配对码已作废`, () => route.set({ page: 'conn' }))
        return
      }
      case 'channel.status': {
        const p = e.payload as ChannelStatusPayload
        if (p.state !== 'unauthorized' && p.state !== 'conflict') return
        problem(`mffai:channel:${p.channel}`, `<b>${channelName(p.channel)}</b> ${sanitize(label('channelState', p.state))}`, () => route.set({ page: 'conn' }))
        return
      }
      case 'executor.run.ended': {
        const p = e.payload as ExecutorRunEndedPayload
        const sessionId = e.sessionId
        const ok = p.status === 'ok'
        put({
          key: `mffai:run:${p.runId}`, ic: ok ? 'ok' : 'warn', cls: ok ? 'ni-ok' : 'ni-warn',
          t: `<b>${sanitize(p.executor)}</b> ${sanitize(label('runStatus', p.status))}`, m: META, unread: true, view: 'mffai',
          onOpen: () => route.set({ page: 'chat', ...(sessionId && { sessionId }), runId: p.runId }),
        })
        return
      }
      case 'plugin.failed':
      case 'plugins.integrity.failed': {
        const id = (e.payload as PluginIdPayload).id
        problem(`mffai:plugin:${id}`, `<b>${sanitize(id)}</b> ${e.type === 'plugin.failed' ? '启动失败' : '校验失败'}`, () => route.set({ page: 'plugins' }))
        return
      }
      case 'plugins.mcp.status': {
        const p = e.payload as PluginsMcpStatusPayload
        if (p.state !== 'server_failed' && p.state !== 'integrity_failed') return
        problem(`mffai:mcp:${p.plugin}:${p.server}`, `<b>${sanitize(p.plugin)} · ${sanitize(p.server)}</b> ${sanitize(label('mcpState', p.state))}`,
          () => route.set({ page: 'plugins' }))
        return
      }
    }
  }

  const offEvent = onMffaiEvent({ types: TYPES }, onEvent)
  const offReset = onMffaiReset(scheduleProposals)
  readProposals()

  return () => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    offEvent()
    offReset()
    // 停用后这些通知的按钮都调不通了:一起摘掉
    for (const k of keys) sink.remove(k)
    keys.clear()
    stopped = true
  }
}
