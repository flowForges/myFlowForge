import { describe, it, expect } from 'vitest'
import { makeIdleWatchdog } from './idleWatchdog'

/**
 * 静默之后该干什么。
 *
 * ★★原来的行为是:240 秒没有任何输出 → **无声地 SIGTERM 掉这一轮**。三个错误叠在一起:
 *   ① 静默是有歧义的 —— 可能在算,也可能在等一个 Forge 看不见的人(外部钩子、浏览器 OAuth、
 *      sudo 密码、git 凭据、MCP elicitation);
 *   ② 我们选了最不可逆的那个解释;
 *   ③ 杀完不说话 —— 用户体验到的是「我明明授权了,它却什么都没干」。
 *  2026-09-07 用户就是这么撞上的:他装的 PermissionRequest 钩子超时是 **24 小时**,而我们 4 分钟就杀。
 *  两个数字差 360 倍,撞车是迟早的事。
 *
 * 现在:静默先**报告**,过了硬上限才动手。Forge 不需要知道为什么静默 ——
 * 它只需要别替用户做那个不可逆的决定。
 */
const mk = () => {
  const q: { fn: () => void; ms: number }[] = []
  return {
    timers: { set: (fn: () => void, ms: number) => { q.push({ fn, ms }); return q.length }, clear: (h: unknown) => { const i = (h as number) - 1; if (q[i]) q[i] = { fn: () => {}, ms: 0 } } },
    /** 跑掉排在最前面、还没跑过的那个定时器。 */
    tick(ms?: number) { const i = q.findIndex(x => x.ms > 0 && (ms === undefined || x.ms === ms)); if (i < 0) throw new Error(`没有 ${ms}ms 的定时器`); const f = q[i].fn; q[i] = { fn: () => {}, ms: 0 }; f() },
    has(ms: number) { return q.some(x => x.ms === ms) },
  }
}

describe('静默先报告,不直接杀', () => {
  it('★★静默到期 → 调 onIdle 报告,**不**调 onDeadline', () => {
    const t = mk()
    let idle = 0, killed = 0
    makeIdleWatchdog(240, () => idle++, t.timers, { hardMs: 1800, onDeadline: () => killed++ })
    t.tick(240)
    expect(idle).toBe(1)
    expect(killed, '报告的时候就把进程杀了 —— 正是要修的那件事').toBe(0)
  })

  it('★★报告之后**硬上限**才动手 —— 真卡死的进程不能永远挂着', () => {
    const t = mk()
    let killed = 0
    makeIdleWatchdog(240, () => {}, t.timers, { hardMs: 1800, onDeadline: () => killed++ })
    t.tick(240)
    expect(t.has(1800), '没有安排硬上限 → 卡死的进程永远不回收').toBe(true)
    t.tick(1800)
    expect(killed).toBe(1)
  })

  it('★报告之后又来输出了 → 硬上限取消,这一轮当没事发生', () => {
    const t = mk()
    let killed = 0
    const wd = makeIdleWatchdog(240, () => {}, t.timers, { hardMs: 1800, onDeadline: () => killed++ })
    t.tick(240)
    wd.beat()
    expect(() => t.tick(1800)).toThrow()   // 硬上限已被撤掉
    expect(killed).toBe(0)
  })

  it('★恢复输出后再次静默 → 能再报一次(不是一轮只报一次就哑了)', () => {
    const t = mk()
    let idle = 0
    const wd = makeIdleWatchdog(240, () => idle++, t.timers, { hardMs: 1800, onDeadline: () => {} })
    t.tick(240)
    wd.beat()
    t.tick(240)
    expect(idle).toBe(2)
  })

  it('★clear() 之后硬上限也不许再烧 —— 轮次正常结束了还杀进程是灾难', () => {
    const t = mk()
    let killed = 0
    const wd = makeIdleWatchdog(240, () => {}, t.timers, { hardMs: 1800, onDeadline: () => killed++ })
    t.tick(240)
    wd.clear()
    expect(() => t.tick(1800)).toThrow()
    expect(killed).toBe(0)
  })

  it('★人在门上做决定时 pause() 依旧压住一切 —— 等人不是卡死', () => {
    const t = mk()
    let idle = 0
    const wd = makeIdleWatchdog(240, () => idle++, t.timers, { hardMs: 1800, onDeadline: () => {} })
    wd.pause()
    expect(() => t.tick(240)).toThrow()
    expect(idle).toBe(0)
  })

  it('★不传硬上限 = 老行为(onIdle 就是终局),给无人值守的场景留的', () => {
    const t = mk()
    let idle = 0
    makeIdleWatchdog(240, () => idle++, t.timers)
    t.tick(240)
    expect(idle).toBe(1)
    expect(t.has(1800)).toBe(false)
  })
})
