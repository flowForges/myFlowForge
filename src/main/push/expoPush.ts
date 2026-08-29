/**
 * Expo Push Service 的最小客户端 —— daemon **直接** POST 过去,由 Expo 去对接 APNs 和 FCM。
 *
 * 决策 7:推送不经过中转,也不需要自建推送后端。代价是正文明文经过 Expo,
 * 所以正文里没有任何对话内容(约束落在 `@shared/push/message.ts`,不在这儿)。
 *
 * ★这个文件里**一处都不许抛**。它跑在广播总线的路径上,一次推送失败(没网、Expo 挂了、
 *  令牌过期)绝不能把事件流带崩 —— 那会变成「手机推送没配好,结果电脑上的对话也卡住」。
 *  所有错误都压成返回值里的一行字。
 */

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** Expo 一次最多收 100 条。多了它整个请求报错,不是只丢多出来的那些。 */
export const EXPO_BATCH = 100

const TIMEOUT_MS = 15_000

export type ExpoMessage = {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  /** Android 上要有 channel 才响得出声;这个 id 由手机端建(见 mobile/src/push)。 */
  channelId?: string
}

export type SendResult = {
  sent: number
  failed: number
  /**
   * 该从设备表里摘掉的令牌。
   * ★`DeviceNotRegistered` 是**终态** —— app 被卸了/令牌换了,再推一万次也是这个结果。
   *  不摘的话这枚死令牌会永远留在表里,每次推送都白跑一趟。
   */
  dropTokens: string[]
  /** 给日志看的人话。不进界面。 */
  errors: string[]
}

/** `ExponentPushToken[...]` / `ExpoPushToken[...]`。★格式不对的令牌根本不发出去 —— 整批会被 Expo 拒掉。 */
export function isExpoPushToken(t: string): boolean {
  return /^Expo(nent)?PushToken\[[^\s\]]+\]$/.test(t.trim())
}

export function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

type Ticket = { status?: string; message?: string; details?: { error?: string } }

export type SendDeps = {
  /** 注进来是为了测试能不真的联网。生产走全局 fetch(Node 18+ 自带)。 */
  fetchImpl?: typeof fetch
  onLog?: (msg: string) => void
}

export async function sendExpoPush(messages: readonly ExpoMessage[], deps: SendDeps = {}): Promise<SendResult> {
  const log = deps.onLog ?? (() => {})
  const res: SendResult = { sent: 0, failed: 0, dropTokens: [], errors: [] }

  const good = messages.filter((m) => isExpoPushToken(m.to))
  for (const m of messages) {
    if (!isExpoPushToken(m.to)) {
      // 格式就不对的,当场摘掉:它绝不可能因为网络好转而变得能用。
      res.failed++
      res.dropTokens.push(m.to)
      res.errors.push(`令牌格式不对,已摘掉: ${m.to.slice(0, 24)}`)
    }
  }
  if (!good.length) return res

  const doFetch = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  if (!doFetch) {
    res.failed += good.length
    res.errors.push('这个运行时没有 fetch,发不了推送')
    return res
  }

  for (const batch of chunk(good, EXPO_BATCH)) {
    // ★每一批自己超时。没有超时的话,一个不回包的代理能让这个 await 挂到天荒地老,
    //  而它坐在广播回调里。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const r = await doFetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(batch),
        signal: ac.signal,
      })
      if (!r.ok) {
        res.failed += batch.length
        res.errors.push(`Expo 回了 ${r.status}`)
        continue
      }
      const json = (await r.json()) as { data?: Ticket[]; errors?: Array<{ message?: string }> }
      if (json.errors?.length) {
        res.failed += batch.length
        res.errors.push(...json.errors.map((e) => e.message ?? '未知错误'))
        continue
      }
      const tickets = json.data ?? []
      batch.forEach((m, i) => {
        // ★票据按**下标**跟请求对齐。Expo 少回几条时,对不上的那些当失败处理 ——
        //  绝不能拿别人的票据当成自己的结果(那会摘错令牌)。
        const t = tickets[i]
        if (!t) { res.failed++; res.errors.push('Expo 少回了一条票据'); return }
        if (t.status === 'ok') { res.sent++; return }
        res.failed++
        const code = t.details?.error ?? ''
        if (code === 'DeviceNotRegistered') res.dropTokens.push(m.to)
        res.errors.push(`${code || '推送失败'}: ${t.message ?? ''}`.trim())
      })
    } catch (e) {
      res.failed += batch.length
      const why = e instanceof Error ? e.message : String(e)
      res.errors.push(ac.signal.aborted ? '连 Expo 超时' : why)
    } finally {
      clearTimeout(timer)
    }
  }

  if (res.errors.length) log(`推送: 成功 ${res.sent} 失败 ${res.failed} — ${res.errors.slice(0, 3).join(' / ')}`)
  return res
}
