import type { TimelineEntry } from './timeline'

/**
 * 一次最多渲染多少条消息。更早的收进「加载更早」按钮里。
 *
 * ★★为什么要有这个(2026-10-03 用户报「点开会话都要加载一下」):当时的实现把**整条时间线**
 *  一次性 map 出来。实测用户那个 1.2MB 的真会话 —— 98 条消息 / 238 张工具卡 —— 一次渲染
 *  约 700ms(jsdom),这段时间主线程是堵死的,表现就是「点进去先转一下圈才有内容」。
 *  同一份数据只渲染最后 20 条是 145ms。
 * ★导入的历史(MessageStream)一直是窗口化的(60 条),**只有当前这条对话漏了** ——
 *  两个调用点只改了一个,又是 [[trap-two-call-sites-run-vs-chat]] 那一类。
 * ★取 40 不取 60:上面那条曲线大约每条 7ms,40 条 ≈ 280ms 还能接受,而 40 条回复
 *  往回翻已经很深了。不够看就点一次「加载更早」。
 */
export const LIVE_WINDOW = 40
/** 点一次「加载更早」多放出来多少条。 */
export const LIVE_WINDOW_STEP = 40

/**
 * 还在等人处理的卡片 —— **任何情况下都不许被窗口藏掉**。
 *
 * ★★这是这个文件里唯一会出人命的地方:门/方案/启动闸是主进程里一个**正阻塞着 provider 的
 *  Promise**,卡片是它在界面上唯一的出口。一旦被窗口切掉,用户就再也点不到「允许/拒绝」,
 *  那一轮会一直挂到 CLI 超时 —— 而侧栏还在喊「待确认」。所以这里宁可多留,不可少留。
 * ★run-card 只有**活跃**(带 event,还在 inbox 里等处理)的才保活;已冻结的那种是历史记录,
 *  和消息一样可以收起来。
 */
function mustKeep(e: TimelineEntry, liveCouncils?: ReadonlySet<string>): boolean {
  // ★进行中(running/paused/finalizing)的共商区块里有暂停/继续/结束 —— 和门一样不许被收掉;结束了的就是历史。
  if (e.kind === 'council') return !!liveCouncils?.has(e.id)
  if (e.kind === 'pending' || e.kind === 'confirm' || e.kind === 'plan' || e.kind === 'launch-gate') return true
  return e.kind === 'run-card' && e.event != null
}

export interface WindowedTimeline {
  visible: TimelineEntry[]
  /** 被收起来的**消息**条数(按钮上那个数字)。保活的卡片不算在内。 */
  hiddenCount: number
  /**
   * 第一条渲染出来的消息在 `messages` 数组里的下标;没收起任何东西时是 0。
   *
   * ★★给 ChatJumpRail 用:它靠 `[data-user-msg="<index>"]` 找 DOM 来滚动。窗口切掉的消息
   *  **没有对应的 DOM**,锚点还画着的话点下去什么也不会发生 —— 静默失灵比没有这个锚点更糟。
   */
  fromIndex: number
}

/**
 * 只保留最后 `limit` 条消息(以及所有还在等人处理的卡片)。`limit` 非正/非法 = 不限制。
 * `liveCouncils`:进行中的共商 id,这些区块同样保活。
 */
export function windowTimeline(entries: TimelineEntry[], limit: number, liveCouncils?: ReadonlySet<string>): WindowedTimeline {
  if (!Number.isFinite(limit) || limit <= 0) return { visible: entries, hiddenCount: 0, fromIndex: 0 }
  const msgPositions: number[] = []
  for (let i = 0; i < entries.length; i++) if (entries[i].kind === 'message') msgPositions.push(i)
  if (msgPositions.length <= limit) return { visible: entries, hiddenCount: 0, fromIndex: 0 }
  const hiddenCount = msgPositions.length - limit
  const cut = msgPositions[hiddenCount]          // 第一条要留下的消息在数组里的位置
  const first = entries[cut] as Extract<TimelineEntry, { kind: 'message' }>
  const visible: TimelineEntry[] = []
  // cut 之前的东西里,只有「还在等人处理的卡片」留下来,其余(消息、分割线、冻结卡)全收起。
  for (let i = 0; i < cut; i++) if (mustKeep(entries[i], liveCouncils)) visible.push(entries[i])
  for (let i = cut; i < entries.length; i++) visible.push(entries[i])
  return { visible, hiddenCount, fromIndex: first.index }
}
