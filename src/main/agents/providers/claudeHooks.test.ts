import { describe, it, expect, vi } from 'vitest'
import { parseHookEvent, makeHookWatch } from './claudeHooks'

/**
 * claude 的钩子生命周期事件。
 *
 * ★★这些事件**本来就在 stream-json 上**,Forge 一直全丢了(chatStream.ts 一条都不认)。代价是:
 *  用户装的 PermissionRequest 钩子把 claude 拦住时,界面上和「模型在思考」一模一样 ——
 *  2026-09-07 用户是靠**另一个软件**才知道 agent 在等授权的。
 * ★同样被丢掉的还有钩子**报错**:这台机器上 treland-bridge 连不上自己的 socket、
 *  ping-island-bridge 直接抛错,用户一直不知道。
 *
 * 下面的报文是 2026-09-07 从 claude 2.1.263 真机上抓的原样。
 */
const STARTED = {
  type: 'system', subtype: 'hook_started', hook_id: 'h-1',
  hook_name: 'PermissionRequest:Bash', hook_event: 'PermissionRequest',
  uuid: 'u1', session_id: 's1',
}
const OK = {
  type: 'system', subtype: 'hook_response', hook_id: 'h-1',
  hook_name: 'PermissionRequest:Bash', hook_event: 'PermissionRequest',
  output: '', stdout: '', stderr: '', exit_code: 0, outcome: 'success', uuid: 'u2', session_id: 's1',
}
const BROKEN = {
  ...OK, hook_id: 'h-2', outcome: 'error',
  output: 'PingIslandBridge error: The operation couldn’t be completed. (PingIslandBridge...)\nsecond line',
}

describe('parseHookEvent', () => {
  it('认开始和结束', () => {
    expect(parseHookEvent(STARTED)).toMatchObject({ phase: 'start', id: 'h-1', event: 'PermissionRequest', name: 'PermissionRequest:Bash' })
    expect(parseHookEvent(OK)).toMatchObject({ phase: 'end', id: 'h-1', outcome: 'success' })
  })
  it('★别的 system 事件不认(init / status / api_retry 都长这样)', () => {
    for (const o of [{ type: 'system', subtype: 'init' }, { type: 'system', subtype: 'api_retry' }, { type: 'assistant' }, null, 'x'])
      expect(parseHookEvent(o), JSON.stringify(o)).toBeNull()
  })
  it('缺 hook_id 也不炸(报文是 CLI 内部结构,防御性读)', () => {
    expect(parseHookEvent({ type: 'system', subtype: 'hook_started', hook_name: 'X' })).toMatchObject({ phase: 'start', id: 'X' })
  })
})

describe('makeHookWatch', () => {
  const setup = (slowMs = 2000) => {
    const slow: { names: string[]; seconds: number }[] = []
    const errors: { name: string; message: string }[] = []
    let fn: (() => void) | null = null
    let armed = 0
    const w = makeHookWatch({
      slowMs,
      onSlow: (names, seconds) => slow.push({ names, seconds }),
      onError: (name, message) => errors.push({ name, message }),
      timers: { set: (f: () => void) => { fn = f; armed++; return 1 }, clear: () => { fn = null } },
    })
    return { w, slow, errors, armed: () => armed, fire: () => { const f = fn; fn = null; f?.() } }
  }

  it('★钩子秒回就不吭声 —— 一轮里几十个钩子,每个都播报等于噪音', () => {
    const { w, slow, fire } = setup()
    w.feed(STARTED); w.feed(OK); fire()
    expect(slow).toEqual([])
  })

  it('★★卡住超过阈值才说话,并且说清是哪个钩子 —— 这就是用户看不到的那件事', () => {
    const { w, slow, fire } = setup()
    w.feed(STARTED)
    fire()
    expect(slow).toHaveLength(1)
    expect(slow[0].names).toEqual(['PermissionRequest'])
  })

  it('★多个钩子同时挂着 → 一条消息里全列出来(这台机器上 PermissionRequest 有 3 个)', () => {
    const { w, slow, fire } = setup()
    w.feed(STARTED)
    w.feed({ ...STARTED, hook_id: 'h-2' })
    w.feed({ ...STARTED, hook_id: 'h-3', hook_name: 'PreToolUse:Bash', hook_event: 'PreToolUse' })
    fire()
    expect(slow[0].names).toEqual(['PermissionRequest', 'PermissionRequest', 'PreToolUse'])
  })

  it('★★计时只从「第一个钩子挂上」那一刻起 —— 每来一个就重置的话,一串连着来的钩子把播报无限推后', () => {
    // 变异验证抓到过:少了这条守卫,上面那条用例照样全绿(假计时器只留最后一个回调),
    // 但真实世界里 4 个钩子接连启动 = 计时被推后 4 次,用户永远等不到那句提示。
    const { w, armed } = setup()
    w.feed(STARTED)
    w.feed({ ...STARTED, hook_id: 'h-2' })
    w.feed({ ...STARTED, hook_id: 'h-3' })
    expect(armed(), '计时器被重置了').toBe(1)
  })

  it('★钩子报错要说出来 —— treland 连不上、ping-island 抛错,用户至今不知道', () => {
    const { w, errors } = setup()
    w.feed({ ...BROKEN, hook_id: 'h-2', subtype: 'hook_started' })
    w.feed(BROKEN)
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe('PermissionRequest')
    expect(errors[0].message, '多行输出要截成一行').toBe('PingIslandBridge error: The operation couldn’t be completed. (PingIslandBridge...)')
  })

  it('成功的钩子不报错', () => {
    const { w, errors } = setup()
    w.feed(STARTED); w.feed(OK)
    expect(errors).toEqual([])
  })

  it('★pending() 给 L2 的看门狗用 —— 静默时要能说出「还有谁没回来」', () => {
    const { w } = setup()
    w.feed(STARTED)
    expect(w.pending()).toEqual(['PermissionRequest'])
    w.feed(OK)
    expect(w.pending()).toEqual([])
  })

  it('★clear() 之后不再触发 —— 轮次结束了还播报等于对着空气说话', () => {
    const { w, slow, fire } = setup()
    w.feed(STARTED)
    w.clear()
    fire()
    expect(slow).toEqual([])
  })
})
