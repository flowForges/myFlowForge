// 伪流式:把「一整坨突然出现」的回复摊成逐段浮现。
//
// 为什么需要:chatStream.ts 有两条并存路径 —— `stream_event`/`text_delta` 是逐 token 的真流式,
// 而完整的 `assistant` 消息是整条一次性。只有 claude 传了 --include-partial-messages 走前者;
// codex(assistant-final)、cursor、opencode 的粒度完全取决于上游 CLI 给多大块。我们忠实转发上游
// 的粒度,CLI 不流式我们就流式不了 —— 界面上就是「思考很久,然后几千字轰一下全出来」。
//
// ★两条设计决定,改之前先看懂:
//
// 1) **不按 provider 配名单,按分片大小自适应。** 小于 MIN_CHUNK 的分片直接放行,所以真流式的
//    provider 零延迟穿过去,只有整坨才被摊开。省掉一张要跟着新 provider 维护的表。
//
// 2) **不是「每秒 N 字」,是「整个待放队列在固定时长内放完」。** 固定速率下一条几万字的回复要念
//    好几分钟,把「完成」硬生生拖成「卡住」,比不做还糟。所以帧数有上限(MAX_TICKS),队列越大每片
//    越粗、放得越快,总时长恒定封顶。
//
// 代价(明确写在这里):onDone 会被推迟到放完为止,所以一轮对话的「完成」时刻会晚 ~1 秒。这是有意的 ——
// 内容其实早就到齐了,我们压着慢慢放。中断(onError)则立即全放,不让用户等一个他已经喊停的东西。

import type { ChatCallbacks } from './types'

export const PACE = {
  /** 小于这个长度的分片直接放行:上游本来就在流式,再排队只会平白加延迟。 */
  MIN_CHUNK: 120,
  /** 两片之间的间隔。再小就没有逐段浮现的观感了,也没必要每帧一次 IPC。 */
  TICK_MS: 40,
  /** 放完整个待放队列最多用多少帧。40ms × 30 ≈ 1.2s —— 无论队列多大都不超过这个时长。 */
  MAX_TICKS: 30,
} as const

/**
 * 在 [min, max] 里找一个「读起来是个自然停顿」的切点,优先级:换行 > 句末标点 > 空格 > 硬切。
 * 不在标点处切的话,markdown 会短暂露出半个 `**`、半个链接,闪一下很脏。
 */
export function sliceAt(text: string, min: number, max: number): number {
  const hi = Math.min(max, text.length)
  if (hi >= text.length) return text.length
  const lo = Math.max(1, Math.min(min, hi))
  const win = text.slice(lo, hi)
  for (const re of [/\n(?![\s\S]*\n)/, /[。！？；.!?;](?![\s\S]*[。！？；.!?;])/, /\s(?![\s\S]*\s)/]) {
    const m = re.exec(win)
    if (m) return lo + m.index + 1
  }
  return hi
}

/** 把整个待放队列切成 n 片(片数由剩余帧数决定),每片都落在自然停顿处。 */
export function planSlices(pending: string, ticks: number): string[] {
  if (!pending) return []
  const n = Math.max(1, Math.min(ticks, PACE.MAX_TICKS))
  const target = Math.ceil(pending.length / n)
  const out: string[] = []
  let rest = pending
  while (rest) {
    if (out.length === n - 1) { out.push(rest); break }
    // 下界给 60%:切点允许在目标附近浮动,好落在标点上,但别缩得太短否则片数会失控。
    const cut = sliceAt(rest, Math.ceil(target * 0.6), target)
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return out
}

export interface PaceTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

/** 包出来的回调多一个 flushPaced:调用方(比如「停止」按钮)可以要求立刻把剩下的全放完。 */
export type PacedCallbacks = ChatCallbacks & { flushPaced(): void }

/**
 * 包一层 ChatCallbacks:大块的 assistant 文本改成逐段放出。其余回调原样透传。
 * timers 可注入,好让测试不依赖真实时钟。
 */
export function paceAssistantDeltas(
  inner: ChatCallbacks,
  timers: PaceTimers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
): PacedCallbacks {
  let queue = ''
  let timer: unknown = null
  // 本轮还剩几帧。★必须是递减的计数,不能每帧都拿 MAX_TICKS 重算 —— 那样每帧只取走剩余的 1/30,
  // 剩下的下一帧又取 1/30,是个芝诺悖论:30 帧之后还剩 36%,片数根本封不住(实测切出 201 片)。
  let ticksLeft = 0
  // onDone 在放完之前到达时先扣下,放完再转发 —— 否则「完成」会跑到内容前面,消息落盘时正文还没放完。
  let pendingDone: (() => void) | null = null

  const stop = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null } }
  const flushAll = () => {
    stop()
    if (queue) { const q = queue; queue = ''; inner.onAssistantDelta(q) }
  }
  const finish = () => { const d = pendingDone; pendingDone = null; if (d) d() }

  const tick = () => {
    timer = null
    if (!queue) { finish(); return }
    // 按「剩下的队列 ÷ 剩下的帧数」算这一片:放的过程中新进队的内容会自动并进来,而帧数照常递减,
    // 所以总时长恒定封顶,最后一帧无论剩多少都一次给完。
    const [head, ...rest] = planSlices(queue, Math.max(1, ticksLeft))
    ticksLeft = Math.max(0, ticksLeft - 1)
    queue = rest.join('')
    inner.onAssistantDelta(head)
    if (queue) timer = timers.setTimeout(tick, PACE.TICK_MS)
    else finish()
  }

  return {
    ...inner,
    // 用户按了「停止」:立刻把剩下的全放完并放行扣着的 onDone。喊了停还在一个字一个字往外冒,
    // 比不做伪流式更让人火大。
    flushPaced: () => { flushAll(); finish() },
    onAssistantDelta: (t: string) => {
      if (!t) return
      // 上游本来就在流式(小分片)且没有积压 → 原样直放,一点延迟都不加。
      if (t.length < PACE.MIN_CHUNK && !queue) { inner.onAssistantDelta(t); return }
      queue += t
      // 开始新一轮释放时才重置帧预算;正在放的过程中进队的内容并入本轮,不另给时间。
      if (timer === null) { ticksLeft = PACE.MAX_TICKS; timer = timers.setTimeout(tick, 0) }
    },
    // 覆盖式重写是权威值(qoder 用它修分段),直接丢掉队列、原样转发,别让排队的旧内容再追加上去。
    onAssistantReplace: inner.onAssistantReplace
      ? (full: string) => { stop(); queue = ''; inner.onAssistantReplace!(full) }
      : undefined,
    onDone: (r) => {
      if (!queue) { inner.onDone(r); return }
      pendingDone = () => inner.onDone(r)
    },
    // 出错/用户中断:立刻全放,不让人等一个自己已经喊停的东西。
    onError: (e) => { flushAll(); pendingDone = null; inner.onError(e) },
  }
}
