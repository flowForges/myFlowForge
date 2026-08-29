import { attentionOf, type Presence, type PushTarget } from '@shared/push/attention'
import { buildPush, pushKey, NEEDS_YOU, type PushEvent, type PushKind } from '@shared/push/message'
import { pushEventFrom } from '@shared/push/fromEvent'
import type { ExpoMessage, SendResult } from './expoPush'
import type { PushDevice } from './pushStore'

/**
 * 把 app 的广播总线接到推送上。
 *
 * ★形状照着 `botBridge.observe` 来 —— 那份已经把四路门信号的边角踩完了
 * (`chat:event` 的 confirm/ask/done、`run2:event` 的 gate 和三种泳道问题)。
 * 两边看的是**同一批事件**,再发明一套只会漏掉其中一路。
 *
 * ★★这里**只发远程推送**。手机 app 开着的时候不归它管:那种情况下事件本来就通过 socket
 *  到了手机上,由手机自己弹一条本地通知(判据是同一个 `attentionOf`)。
 *  两边靠 `attending / inapp / away` 三档天然互斥,所以同一件事不会弹两条。
 */

/** Android 上的通知渠道 id。要和手机端建的那个一致,否则安卓上静默无声。 */
export const ANDROID_CHANNEL = 'default'

/**
 * 同一个键在这么长时间内只推一次。
 *
 * 门有自己的唯一 id,天然不会重;这个窗口真正挡的是「跑完了」——
 * 一条会话连着结束两轮时,人还没看第一条呢,第二条就是纯噪音。
 */
export const DEDUPE_MS = 60_000

/** 去重表的上限。★不设的话它跟着运行时长单调增长,一台常年不关的 daemon 上就是个内存泄漏。 */
const DEDUPE_MAX = 500

export type PushCfg = { enabled: boolean; gate: boolean; done: boolean }

export type PushBridgeDeps = {
  cfg: () => PushCfg
  devices: () => PushDevice[]
  send: (msgs: ExpoMessage[]) => Promise<SendResult>
  /** Expo 说某枚令牌已经死了,从设备表里摘掉。 */
  dropTokens: (tokens: string[]) => void
  /** 路径 → 工作区名。推送标题里只有它(决策 7)。 */
  workspaceName: (path: string) => string
  now: () => number
  onLog?: (msg: string) => void
}

export type PushBridge = {
  observe(channel: string, payload: unknown): void
  /** 某台设备报了一次在场。★`token` 认不出来时照样记 —— 注册和上报是两条独立的路。 */
  setPresence(token: string, p: Presence): void
  clearPresence(token: string): void
  presenceOf(token: string): Presence | null
  /** 设置里那个「发一条测试推送」。绕开在场判定和开关,否则测出来的永远是「没反应」。 */
  sendTest(): Promise<SendResult>
}

export function createPushBridge(deps: PushBridgeDeps): PushBridge {
  const presence = new Map<string, Presence>()
  const sentAt = new Map<string, number>()
  const log = deps.onLog ?? (() => {})

  const dedupe = (e: PushEvent, now: number): boolean => {
    const k = pushKey(e)
    const last = sentAt.get(k)
    if (last !== undefined && now - last < DEDUPE_MS) return false
    sentAt.set(k, now)
    if (sentAt.size > DEDUPE_MAX) {
      // 最早插进来的先走。Map 保证插入序,所以取第一个键就够。
      const oldest = sentAt.keys().next().value
      if (oldest !== undefined) sentAt.delete(oldest)
    }
    return true
  }

  const fire = (kind: PushKind, target: PushTarget, eventId?: string) => {
    const cfg = deps.cfg()
    if (!cfg.enabled) return
    if (NEEDS_YOU.has(kind) ? !cfg.gate : !cfg.done) return
    if (!target.workspacePath) return

    const now = deps.now()
    const e: PushEvent = { kind, target, eventId, workspaceName: deps.workspaceName(target.workspacePath) }
    if (!dedupe(e, now)) return

    // ★只推「不在场」的设备。手机开着的那台由它自己弹本地通知 —— 两边判据同一份。
    const targets = deps.devices().filter((d) => attentionOf(presence.get(d.token), target, now) === 'away')
    if (!targets.length) return

    const m = buildPush(e)
    const msgs: ExpoMessage[] = targets.map((d) => ({
      to: d.token,
      title: m.title,
      body: m.body,
      data: m.data,
      channelId: ANDROID_CHANNEL,
    }))
    // fire-and-forget:观察者坐在广播路径上,绝不能因为等一个 HTTP 往返把事件流卡住。
    void deps.send(msgs)
      .then((r) => { if (r.dropTokens.length) deps.dropTokens(r.dropTokens) })
      .catch((err) => log(`推送发送异常: ${err instanceof Error ? err.message : String(err)}`))
  }

  return {
    observe(channel, payload) {
      // 一条畸形 payload 绝不能把广播总线带崩 —— 它上面挂着整个界面的事件流。
      try {
        // ★映射是**两端共用**的那一份(`@shared/push/fromEvent`):手机拿同一份决定弹不弹
        //  本地通知。各写一套的话某一路信号会在一端漏掉,而症状只是「有时候有提醒」。
        const src = pushEventFrom(channel, payload)
        if (src) fire(src.kind, src.target, src.eventId)
      } catch (e) {
        log(`推送观察者吞掉一个异常: ${e instanceof Error ? e.message : String(e)}`)
      }
    },
    setPresence(token, p) { if (token) presence.set(token, p) },
    clearPresence(token) { presence.delete(token) },
    presenceOf(token) { return presence.get(token) ?? null },
    async sendTest() {
      const devices = deps.devices()
      if (!devices.length) return { sent: 0, failed: 0, dropTokens: [], errors: ['还没有手机登记过推送'] }
      const r = await deps.send(devices.map((d) => ({
        to: d.token,
        title: 'myFlowForge · 测试推送',
        body: '看到这条就说明推送通了。真实推送只在手机不在跟前时才发。',
        data: { wsPath: '', sessionId: null, kind: 'done' as const },
        channelId: ANDROID_CHANNEL,
      })))
      if (r.dropTokens.length) deps.dropTokens(r.dropTokens)
      return r
    },
  }
}
