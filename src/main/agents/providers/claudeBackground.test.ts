import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeBackgroundGate, parseTaskNotification, BG_GRACE_MS } from './claudeBackground'

// 事件形状全部取自真 claude 2.1.285 的 stream-json(2026-10-03 实测,见 claudeBackground.ts 顶部注释)。
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, session_id: 's', ...extra })
const tasksChanged = (...ids: string[]) => sys('background_tasks_changed', { tasks: ids.map(task_id => ({ task_id, task_type: 'local_agent', description: 'd' })) })
const started = (task_id: string, tool_use_id: string, extra: object = {}) => sys('task_started', { task_id, tool_use_id, is_backgrounded: true, task_type: 'local_agent', ...extra })
const notified = (task_id: string, tool_use_id: string, status = 'completed', summary = 'S') => sys('task_notification', { task_id, tool_use_id, status, summary })
const requesting = () => sys('status', { status: 'requesting' })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('makeBackgroundGate — 一轮结束时后台任务还在不在跑', () => {
  it('没有后台任务:result 立即收尾(老行为不变)', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(requesting())
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
    expect(g.parked).toBe(false)
  })

  it('★后台子代理还在跑:result 不收尾,停车;下一轮的 result 才收尾', () => {
    const finish = vi.fn(); const park = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish, onPark: park })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1'))
    g.result()
    expect(finish).not.toHaveBeenCalled()
    expect(g.parked).toBe(true)
    expect(park).toHaveBeenCalledWith(1)
    // 子代理跑完 → CLI 自己起下一轮
    g.feed(tasksChanged()); g.feed(notified('a1', 'tu1'))
    g.feed(sys('init')); g.feed(requesting())
    expect(g.parked).toBe(false)
    vi.advanceTimersByTime(BG_GRACE_MS * 3)
    expect(finish).not.toHaveBeenCalled()          // 新一轮在跑,宽限计时器不该误杀
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('子代理在本轮内就完成并被消化(通知后又发起过请求):result 立即收尾', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1'))
    g.feed(tasksChanged()); g.feed(notified('a1', 'tu1'))
    g.feed(requesting())                              // 通知已随下一次请求送给模型
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('★通知到了但还没被任何请求带走(最后一次请求期间才完成):停车等它起新一轮', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1')); g.feed(requesting())
    g.feed(tasksChanged()); g.feed(notified('a1', 'tu1'))
    g.result()
    expect(finish).not.toHaveBeenCalled()
    g.feed(sys('init')); g.feed(requesting())
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('停车后任务都没了、CLI 却没起新一轮:宽限期满兜底收尾(不会永远 busy)', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1'))
    g.result()
    g.feed(tasksChanged())                            // 任务消失,但没有通知、没有新一轮
    vi.advanceTimersByTime(BG_GRACE_MS - 1)
    expect(finish).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('宽限期内又冒出新的后台任务:取消宽限,继续等', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1'))
    g.result()
    g.feed(tasksChanged())
    g.feed(tasksChanged('a2'))
    vi.advanceTimersByTime(BG_GRACE_MS * 2)
    expect(finish).not.toHaveBeenCalled()
  })

  it('子代理自己开的后台命令:计入「还在跑」,但它的通知归子代理,不算主代理待消化', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(tasksChanged('a1')); g.feed(started('a1', 'tu1')); g.feed(requesting())
    g.feed(tasksChanged('a1', 'b1')); g.feed(started('b1', 'tu2', { owned_by_subagent: true, task_type: 'local_bash' }))
    g.feed(tasksChanged('a1')); g.feed(notified('b1', 'tu2'))
    g.feed(tasksChanged()); g.feed(notified('a1', 'tu1'))
    g.feed(requesting())                              // 主代理把 a1 的通知带走了
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)           // b1 的通知没有让它白等
  })

  it('前台工具也会发 task_started/task_notification(is_backgrounded:false):不算后台任务', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(started('b9', 'tu9', { is_backgrounded: false, task_type: 'local_bash' }))
    g.feed(notified('b9', 'tu9'))
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('老版本 CLI 不发 background_tasks_changed:靠 task_started/task_notification 也能跟踪', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(started('a1', 'tu1'))
    g.result()
    expect(finish).not.toHaveBeenCalled()
    g.feed(notified('a1', 'tu1')); g.feed(sys('init')); g.feed(requesting())
    g.result()
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('子代理内部的事件(带 parent_tool_use_id)的 status 不算主代理发起请求', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.feed(started('a1', 'tu1')); g.feed(requesting())
    g.feed(notified('a1', 'tu1'))
    g.feed({ ...requesting(), parent_tool_use_id: 'tu1' })
    g.result()
    expect(finish).not.toHaveBeenCalled()
  })

  it('result 只收尾一次;clear() 之后宽限计时器不再触发', () => {
    const finish = vi.fn()
    const g = makeBackgroundGate({ onFinish: finish })
    g.result(); g.result()
    expect(finish).toHaveBeenCalledTimes(1)
    const finish2 = vi.fn()
    const g2 = makeBackgroundGate({ onFinish: finish2 })
    g2.feed(started('a1', 'tu1')); g2.result(); g2.feed(tasksChanged())
    g2.clear()
    vi.advanceTimersByTime(BG_GRACE_MS * 2)
    expect(finish2).not.toHaveBeenCalled()
  })

  it('isBackgroundLaunch:认得后台启动的 tool_use_id(用来把「已启动」回执和真正完成区分开)', () => {
    const g = makeBackgroundGate({ onFinish: () => {} })
    g.feed(started('a1', 'tu1'))
    g.feed(started('b9', 'tu9', { is_backgrounded: false }))
    expect(g.isBackgroundLaunch('tu1')).toBe(true)
    expect(g.isBackgroundLaunch('tu9')).toBe(false)
    expect(g.isBackgroundLaunch('nope')).toBe(false)
    // task_started 还没到时,靠回执原文兜底;普通子代理的真结果不会被误认
    expect(g.isBackgroundLaunch('late', 'Async agent launched successfully. (This tool result is internal metadata …)\nagentId: x')).toBe(true)
    expect(g.isBackgroundLaunch('late', '调研结论:Snapseed 有 29 个工具')).toBe(false)
  })
})

describe('parseTaskNotification', () => {
  it('取出 tool_use_id / 状态 / 摘要', () => {
    expect(parseTaskNotification(notified('a1', 'tu1', 'completed', 'BG-DONE'))).toEqual({ taskId: 'a1', toolUseId: 'tu1', ok: true, summary: 'BG-DONE' })
    expect(parseTaskNotification(notified('a1', 'tu1', 'failed', 'boom'))).toEqual({ taskId: 'a1', toolUseId: 'tu1', ok: false, summary: 'boom' })
  })
  it('不是 task_notification 返回 null', () => {
    expect(parseTaskNotification(requesting())).toBeNull()
    expect(parseTaskNotification(null)).toBeNull()
  })
})
