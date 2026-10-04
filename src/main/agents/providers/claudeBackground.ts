/**
 * 一轮结束(`result`)时,claude 还有没有后台任务没跑完 —— 决定「现在杀进程」还是「停车等下一轮」。
 *
 * ★★背景(用户 2026-10-03 撞上):Agent 工具默认 `run_in_background`,子代理在后台跑,主代理当场
 *  就拿到一张「Async agent launched successfully」回执,接着说一句「两路调研还在跑」就输出 `result`。
 *  chat()/run() 一见 `result` 就 killTree —— 后台子代理跟着进程一起死,用户只能再说一遍。
 *  界面上那张卡还显示「已完成」,因为它把**启动回执**当成了完成。
 *
 * ★实测(真 claude 2.1.285,headless `-p --input-format stream-json`,不杀进程只记录):
 *  - 后台任务的生命周期全在流上:`system/task_started`(is_backgrounded、owned_by_subagent、tool_use_id)、
 *    `system/background_tasks_changed`(**当前还在跑的完整列表**)、`system/task_notification`(完成)。
 *  - 后台子代理比主代理这一轮活得久时:result #1 之后进程不退;子代理完成 → `task_notification` →
 *    CLI **自己**再起一轮(`system/init` + `status: requesting`)→ 主代理拿着结果继续回复 → result #2。
 *  - 子代理在主代理这一轮**中途**就完成:通知随主代理下一次请求(`status: requesting`)送进模型,
 *    同一轮里就消化掉了,只有一个 result,之后不会再起新一轮。
 *  - 前台工具也发 task_started/task_notification,但 is_backgrounded:false —— 不算。
 *  - 子代理自己开的后台命令 owned_by_subagent:true,它的通知归子代理,不会让主代理起新一轮。
 *
 * 所以 result 时:还有后台任务在跑,或者有主代理的后台任务通知**还没被任何请求带走** → 停车不杀;
 * 下一轮开始就解除停车,那一轮的 result 再按同样规则判。停车后任务全没了、CLI 却迟迟不起新一轮
 * (比如任务被别处停掉、没发通知)→ 宽限期满兜底收尾,绝不让这一轮永远 busy。
 * 老版本 CLI 不发这些事件 → 什么都没记录 → result 立即收尾,和原来的行为一模一样。
 */

/** 停车后后台任务已经全部结束、但 CLI 还没起新一轮时,最多再等多久。实测新一轮在通知后 ~0.2s 内开始。 */
export const BG_GRACE_MS = 15_000

/** 后台启动回执的开头(2.1.285 原文:「Async agent launched successfully. (This tool result is internal metadata …」)。 */
const LAUNCH_RECEIPT = /^\s*Async agent launched successfully/

const TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error'])

export interface TaskNotification { taskId: string; toolUseId?: string; ok: boolean; summary?: string }

export function parseTaskNotification(obj: any): TaskNotification | null {
  if (obj?.type !== 'system' || obj.subtype !== 'task_notification' || typeof obj.task_id !== 'string') return null
  return {
    taskId: obj.task_id,
    ...(typeof obj.tool_use_id === 'string' ? { toolUseId: obj.tool_use_id } : {}),
    ok: obj.status === 'completed',
    ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
  }
}

export interface BackgroundGate {
  /** 每一条解析出来的 stdout 事件都喂进来(主代理的、子代理的都要)。 */
  feed(obj: any): void
  /** 主代理的 `result` 到了:没有后台活 → onFinish;有 → 停车。 */
  result(): void
  /**
   * 这个 tool_use_id 是不是一次后台启动(它的 tool_result 只是回执,不是完成)。
   * 主依据是 task_started(实测总比回执早到);回执原文作兜底,防 CLI 哪天调换了顺序。
   */
  isBackgroundLaunch(toolUseId: string, resultText?: string): boolean
  readonly parked: boolean
  /** 还在跑的后台任务数。 */
  readonly running: number
  clear(): void
}

export function makeBackgroundGate(opts: {
  onFinish: () => void
  /** 停车时报一声(参数:还在跑的后台任务数)。 */
  onPark?: (running: number) => void
  /** 停车后 CLI 起了新一轮。 */
  onResume?: () => void
  graceMs?: number
}): BackgroundGate {
  const graceMs = opts.graceMs ?? BG_GRACE_MS
  const running = new Set<string>()
  const ownedBySub = new Set<string>()
  const topLevelBg = new Set<string>()       // 主代理自己开的后台任务
  const bgToolUseIds = new Set<string>()
  const undelivered = new Set<string>()      // 主代理后台任务的通知已到、还没被任何请求带走
  let parked = false
  let finished = false
  let grace: ReturnType<typeof setTimeout> | null = null

  const cancelGrace = () => { if (grace) { clearTimeout(grace); grace = null } }
  const finish = () => {
    if (finished) return
    finished = true; parked = false; cancelGrace()
    opts.onFinish()
  }
  // 停车期间:后台活全干完了还没起新一轮 → 起宽限计时;又有活了 → 撤掉。
  const reviewGrace = () => {
    if (!parked) return
    if (running.size === 0 && undelivered.size === 0) { if (!grace) grace = setTimeout(finish, graceMs) }
    else cancelGrace()
  }

  return {
    feed(obj: any) {
      if (finished || obj?.type !== 'system') return
      const sub = !!obj.parent_tool_use_id
      switch (obj.subtype) {
        case 'task_started': {
          if (typeof obj.task_id !== 'string' || obj.is_backgrounded !== true) break
          running.add(obj.task_id)
          if (obj.owned_by_subagent === true) ownedBySub.add(obj.task_id)
          else topLevelBg.add(obj.task_id)
          if (typeof obj.tool_use_id === 'string') bgToolUseIds.add(obj.tool_use_id)
          break
        }
        case 'background_tasks_changed': {
          if (!Array.isArray(obj.tasks)) break
          // 权威列表:整体替换。中途才转入后台的任务也会出现在这里。
          running.clear()
          for (const t of obj.tasks) if (typeof t?.task_id === 'string') {
            running.add(t.task_id)
            if (!ownedBySub.has(t.task_id)) topLevelBg.add(t.task_id)
          }
          break
        }
        case 'task_updated': {
          const st = obj.patch?.status
          if (typeof obj.task_id === 'string' && typeof st === 'string' && TERMINAL.has(st)) running.delete(obj.task_id)
          break
        }
        case 'task_notification': {
          if (typeof obj.task_id !== 'string') break
          running.delete(obj.task_id)
          if (topLevelBg.has(obj.task_id) && !ownedBySub.has(obj.task_id)) undelivered.add(obj.task_id)
          break
        }
        case 'init':
        case 'status': {
          if (sub) break
          // 主代理发起一次请求 = 之前到的通知都已经随这次请求送进模型。
          if (obj.subtype === 'status' && obj.status === 'requesting') undelivered.clear()
          // 停车中看到新一轮开始 → 解除停车,这一轮的 result 再重新判。
          if (parked && (obj.subtype === 'init' || obj.status === 'requesting')) {
            parked = false; cancelGrace(); opts.onResume?.()
          }
          break
        }
      }
      reviewGrace()
    },
    result() {
      if (finished) return
      if (running.size === 0 && undelivered.size === 0) { finish(); return }
      if (!parked) { parked = true; opts.onPark?.(running.size) }
      reviewGrace()
    },
    isBackgroundLaunch: (id, text) => bgToolUseIds.has(id) || (typeof text === 'string' && LAUNCH_RECEIPT.test(text)),
    get parked() { return parked },
    get running() { return running.size },
    clear() { finished = true; parked = false; cancelGrace() },
  }
}
