/**
 * 轮次时间分隔线的**纯逻辑**(原型 `d.css` 的 `.tsep`:两条细线中间一个时间)。
 *
 * ★为什么是分隔线而不是每条消息带时间戳:方向 C 给每条消息配了一条时间轴,在 390px 上每条
 *  多吃 46px,一屏只剩两条消息 —— 定 D 版时正是因为这个把它退回成「只在轮次之间来一根」。
 *
 * ★不用 `toLocaleTimeString` / `Intl`。Hermes(尤其是 Android 上)的 Intl 支持和浏览器不是一回事,
 *  同一条消息在 web 上验过的格式到真机上可能变样。手工格式化就没有这个问题。
 */

/** 一条消息上能拿到的时间线索。都取自 `ChatMessage`,不新发明字段。 */
export type TimeSource = { ts?: string; startedAt?: number }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 本地零点的 epoch ms。用来判「今天 / 昨天」,不涉及时区换算的坑。 */
function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 一条消息的分隔线文案。拿不到可靠时间就返回 `null` —— **宁可不画,也不画一个编出来的时间**。
 *
 * 认三种线索(`ChatMessage` 上真实存在的全部形态):
 *   ① `startedAt` —— epoch 毫秒,最可靠,能判出是哪一天
 *   ② `ts` 是 ISO(`2026-06-30T11:05:58.897Z`)—— 老消息是这种
 *   ③ `ts` 是 `HH:MM:SS` / `HH:MM` —— 现在的 `now()` 写的就是这种。
 *      **只有时刻没有日期**,所以这一支只给 `23:04`,绝不补一个「今天」上去。
 */
export function sepLabel(m: TimeSource, now: number): string | null {
  const at = epochOf(m)
  if (at != null) {
    const day = startOfDay(at)
    const today = startOfDay(now)
    const d = new Date(at)
    const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    if (day === today) return `今天 ${hm}`
    if (day === today - 86400000) return `昨天 ${hm}`
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  const t = (m.ts ?? '').trim()
  const clock = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t)
  if (clock) return `${pad2(Number(clock[1]))}:${clock[2]}`
  return null
}

/**
 * 这个串是不是 ISO 时间戳。
 *
 * ★**只有它说是,才准交给 `Date.parse`**。`23:04:11` 这种只有时刻的串,V8 上 `Date.parse` 返回 NaN
 *  (于是看起来没事),但那是 V8 的行为 —— Hermes 不保证一样。一旦某个引擎把它解析成了「今年某天的
 *  23:04」,分隔线上那个「今天」就是**编出来的**:昨天的会话打开来会写着今天。
 *  这条谓词被单独导出并单测,正是因为在 Node 上跑的变异测试照不出这个差异。
 */
export function isIsoTimestamp(t: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(t.trim())
}

/** epoch 毫秒,拿不到返回 null。 */
function epochOf(m: TimeSource): number | null {
  if (typeof m.startedAt === 'number' && Number.isFinite(m.startedAt) && m.startedAt > 0) return m.startedAt
  const t = (m.ts ?? '').trim()
  if (isIsoTimestamp(t)) {
    const n = Date.parse(t)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * 只有 `HH:MM` 的那条,借同一轮里代理那条的日期,拼出完整时刻。
 *
 * 为什么可以借:用户消息和紧跟着的那条回复**属于同一轮**,中间隔的是几秒。
 * 为什么还要减一天的那一步:23:59 发的消息,回复可能是第二天 00:00 才开始的 ——
 * 直接拿回复的日期会把昨天的消息标成今天。用户那条**不可能晚于回复开始**,
 * 拼出来比锚点还晚就说明跨了午夜,退一天。
 */
function borrowDay(clock: { h: number; m: number }, anchor: number): number {
  const d = new Date(anchor)
  d.setHours(clock.h, clock.m, 0, 0)
  const t = d.getTime()
  return t > anchor ? t - 86400000 : t
}

/** `HH:MM` / `HH:MM:SS` → 时分。不是这个形状就返回 null。 */
function parseClock(ts: string): { h: number; m: number } | null {
  const c = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(ts.trim())
  if (!c) return null
  const h = Number(c[1])
  const m = Number(c[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

/**
 * 给整条消息流算出「每条消息前面要不要来一根分隔线」。
 *
 * 规则:**只在轮次开头**(= 用户发言那条)考虑,并且和上一根标签相同就不重复画。
 * 于是一分钟内连发三条不会得到三根线,而隔了几分钟的下一轮会得到自己的时间。
 *
 * ★用户那条身上通常**只有 `HH:MM:SS`**(`chatService.now()` 写的就是这个),没有日期。
 *  所以先试着从紧跟着的那条回复借日期(见 `borrowDay`);借不到才退成光秃秃的时刻。
 */
export function sepsFor(msgs: (TimeSource & { id: string; who: 'user' | 'ai' })[], now: number): Map<string, string> {
  const out = new Map<string, string>()
  let last: string | null = null
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.who !== 'user') continue
    let label = sepLabel(m, now)
    // 自己只有时刻 → 找同一轮里代理那条的 epoch 当锚点。
    if (label && !hasDate(m)) {
      const clock = parseClock(m.ts ?? '')
      const anchor = clock ? nextEpoch(msgs, i + 1) : null
      if (clock && anchor != null) label = sepLabel({ startedAt: borrowDay(clock, anchor) }, now)
    }
    if (!label || label === last) continue
    out.set(m.id, label)
    last = label
  }
  return out
}

/** 这条消息自己就带得出日期吗。 */
function hasDate(m: TimeSource): boolean {
  return epochOf(m) != null
}

/** 从 `from` 起往后第一条能给出 epoch 的消息;下一条用户发言之前就停(那已经是别的轮次了)。 */
function nextEpoch(msgs: (TimeSource & { who: 'user' | 'ai' })[], from: number): number | null {
  for (let i = from; i < msgs.length; i++) {
    if (msgs[i].who === 'user') return null
    const e = epochOf(msgs[i])
    if (e != null) return e
  }
  return null
}
