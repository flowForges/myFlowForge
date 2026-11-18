import { describe, it, expect, vi } from 'vitest'
import { defaultComputerUse, type ComputerUseSettings } from '../config/schema'
import { fakeDriver, type AxApp } from './fakeDriver'
import { createExecutor, type ExecutorDeps } from './executor'
import { runSemantic } from './semantic'
import { cuHiderFor } from './runtime'
import type { CuGate, CuLogEntry, CuSessionKey, GateDecision, ServiceInternals } from './types'

const K: CuSessionKey = { workspacePath: '/w/a', sessionId: 's-a' }
const OWN_PID = 4242
type GateIn = Omit<CuGate, 'id' | 'ts'>

const WB: AxApp = {
  instance: { pid: 600, start: '100.000001' }, bundleId: 'com.example.workbuddy', name: 'WorkBuddy',
  windows: [{ number: 31, title: 'WorkBuddy' }],
  tree: [
    { ref: 'e1', depth: 0, role: 'button', name: '新建会话', states: [], actions: ['click'], bounds: { x: 100, y: 200, w: 80, h: 30 } },
    { ref: 'e2', depth: 0, role: 'textfield', name: '输入消息', value: '', states: [], actions: ['type', 'focus'] },
  ],
}
const OWN: AxApp = {
  instance: { pid: 4243, start: '1.0' }, bundleId: 'com.zghua.myflowforge.test', name: 'myFlowForge',
  windows: [{ number: 1, title: '会话' }],
  tree: [{ ref: 'e1', depth: 0, role: 'button', name: '发送', states: [], actions: ['click'] }],
}
const PW: AxApp = {
  instance: { pid: 700, start: '2.0' }, bundleId: 'com.1password.1password', name: '1Password',
  windows: [{ number: 2, title: 'Vault' }],
  tree: [{ ref: 'e1', depth: 0, role: 'textfield', name: 'password', states: [], actions: ['type'] }],
}
const TERM: AxApp = {
  instance: { pid: 800, start: '3.0' }, bundleId: 'com.apple.Terminal', name: 'Terminal',
  windows: [{ number: 3, title: 'zsh' }],
  tree: [{ ref: 'e1', depth: 0, role: 'textfield', name: 'shell', states: [], actions: ['type'] }],
}

function setup(o: { mode?: 'ask' | 'allow'; settings?: Partial<ComputerUseSettings>; physical?: boolean; realHider?: boolean } = {}) {
  const apps = [WB, OWN, PW, TERM]
  const driver = fakeDriver({
    ax: { apps },
    apps: [
      ...apps.map((a) => ({ bundleId: a.bundleId, name: a.name, pid: a.instance.pid, active: false })),
      { bundleId: 'com.zghua.myflowforge', name: 'myFlowForge', pid: OWN_PID, active: true },
    ],
  })
  let clock = 1_000_000
  const gates: GateIn[] = []
  const decisions: GateDecision[] = []
  let onGate: ((g: GateIn) => void) | undefined
  const st = { mode: o.mode ?? 'allow' as 'ask' | 'allow' | 'off', turn: 1, enable: 1 }
  const entries: CuLogEntry[] = []
  const calls: string[] = []
  const hider = o.realHider
    ? cuHiderFor({ driver, ownPid: OWN_PID, windows: () => [] })
    : { beforeMutation: vi.fn(async () => { calls.push('hide') }) }
  for (const m of ['act', 'launch', 'focusWindow', 'appKey', 'snapshot', 'waitFor'] as const) {
    const real = (driver[m] as (...a: unknown[]) => Promise<unknown>).bind(driver)
    ;(driver as Record<string, unknown>)[m] = async (...a: unknown[]) => { calls.push(m); return real(...a) }
  }
  const stops: string[] = []
  const svc: ServiceInternals = {
    driver,
    modeOf: () => st.mode,
    turnSeq: () => st.turn,
    enableSeq: () => (st.mode === 'off' ? 0 : st.enable),
    openGate: vi.fn(async (g: GateIn) => { gates.push(g); onGate?.(g); return decisions.shift() ?? 'allow' }),
    hasPendingGate: () => false,
    emitAction: () => {},
    note: () => {},
    stop: (_k, why) => { stops.push(why) },
  }
  const deps: ExecutorDeps = {
    svc, driver, now: () => clock,
    sleep: async (ms) => { clock += ms },
    settings: () => ({ ...defaultComputerUse(), ...o.settings }),
    ownPid: OWN_PID, ownAccelerators: () => ['CommandOrControl+Alt+F'],
    log: {
      async append(_k, e) { entries.push({ ...e }); return e },
      async list() { return entries }, async thumb() { return null }, async remove() {},
    },
    hidIsPhysical: () => o.physical ?? false,
    hider,
  }
  const ex = createExecutor(deps)
  const run = (op: Parameters<typeof ex.run>[1], args: unknown = {}) => ex.run(K, op, args, {})
  /** a fresh WorkBuddy snapshot, made straight on the fake (no executor bookkeeping) */
  const refOf = async (app: AxApp, local = 'e1') => {
    const r = await driver.snapshot({ app: { bundleId: app.bundleId }, mode: 'skeleton' })
    driver.snapshots.length = 0
    return r.nodes.find((n) => n.ref === `@${r.snapId}:${local}`)!.ref!
  }
  return {
    driver, deps, ex, run, st, gates, decisions, entries, hider, calls, stops, refOf,
    onGate: (f: (g: GateIn) => void) => { onGate = f },
    advance: (ms: number) => { clock += ms },
  }
}

describe('reads: snapshot is classified by app (spec §7.1 step 3, R-10)', () => {
  it('our own app → own_window, nothing read', async () => {
    const s = setup()
    expect(await s.run('snapshot', { app: 'myFlowForge' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(await s.run('snapshot', { app: 'com.zghua.myflowforge.test' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(s.driver.snapshots).toHaveLength(0)
  })

  it('a blocked app (1Password) → blocked_app, nothing read', async () => {
    const s = setup({ mode: 'allow' })
    expect(await s.run('snapshot', { app: '1Password' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(s.driver.snapshots).toHaveLength(0)
  })

  it('an ask-always app (Terminal) in ask mode is read without a gate', async () => {
    const s = setup({ mode: 'ask' })
    const r = await s.run('snapshot', { app: 'Terminal' })
    expect(r.ok).toBe(true)
    expect(s.gates).toHaveLength(0)
  })

  it('WorkBuddy: the rendered tree with @s1:e refs, opened by the untrusted notice', async () => {
    const s = setup({ mode: 'ask' })
    const r = await s.run('snapshot', { app: 'WorkBuddy' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text.startsWith('<untrusted_screen snap="s1" app="WorkBuddy">')).toBe(true)
    expect(r.text).toContain('- button "新建会话" @s1:e1 [click]')
    expect(r.text).toContain('@s1:e')
    expect(s.driver.snapshots[0]).toMatchObject({ app: { pid: 600 }, mode: 'skeleton' })
    expect(s.driver.snapshots[0].guard?.denyPids).toContain(OWN_PID)
    expect(s.gates).toHaveLength(0)
    expect(s.hider.beforeMutation).not.toHaveBeenCalled()
  })

  it('full / depth / window / root are passed through; a root from another app is refused', async () => {
    const s = setup()
    await s.run('snapshot', { app: 'WorkBuddy', full: true, depth: 5, window: 31 })
    expect(s.driver.snapshots[0]).toMatchObject({ mode: 'full', maxDepth: 5, window: 31 })
    const termRef = await s.refOf(TERM)
    // forge-cu walks from the root ref's element, whichever app it belongs to
    const real = s.driver.snapshot.bind(s.driver)
    ;(s.driver as Record<string, unknown>).snapshot = (o: Parameters<typeof real>[0]) =>
      real(o.root ? { ...o, app: { bundleId: TERM.bundleId } } : o)
    const r = await s.run('snapshot', { app: 'WorkBuddy', root: termRef })
    expect(r).toMatchObject({ ok: false, code: 'invalid_args' })
    if (!r.ok) expect(r.text).not.toContain('shell')
  })

  it('an unknown app → not_found; two apps with that name → ambiguous_target', async () => {
    const s = setup()
    expect(await s.run('snapshot', { app: 'Nope' })).toMatchObject({ ok: false, code: 'not_found' })
    const dup = { ...WB, instance: { pid: 601, start: '9.0' }, bundleId: 'com.example.workbuddy2' }
    const s2 = setup()
    s2.driver.setAxApps([WB, dup])
    ;(s2.driver as { runningApps: () => Promise<unknown> }).runningApps = async () => [
      { bundleId: WB.bundleId, name: 'WorkBuddy', pid: 600, active: false },
      { bundleId: dup.bundleId, name: 'WorkBuddy', pid: 601, active: false },
    ]
    expect(await s2.run('snapshot', { app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'ambiguous_target' })
    expect((await s2.run('snapshot', { app: dup.bundleId })).ok).toBe(true)
  })

  it('the snapshot result is re-classified: a reply about our own app is withheld', async () => {
    const s = setup()
    const real = s.driver.snapshot.bind(s.driver)
    ;(s.driver as Record<string, unknown>).snapshot = async (o: Parameters<typeof real>[0]) => {
      const r = await real(o)
      return { ...r, app: { bundleId: 'com.zghua.myflowforge', name: 'x' } }
    }
    const r = await s.run('snapshot', { app: 'WorkBuddy' })
    expect(r).toMatchObject({ ok: false, code: 'own_window' })
  })
})

describe('act (spec §7.1): resolve → classify → gate → hide → act', () => {
  it('act on own app ref is refused after resolve', async () => {
    const s = setup()
    const ref = await s.refOf(OWN)
    expect(await s.run('act', { ref, action: 'click' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(s.driver.resolves).toEqual([ref])
    expect(s.driver.acts).toHaveLength(0)
    expect(s.entries.at(-1)).toMatchObject({ op: 'act', result: 'blocked', code: 'own_window' })
  })

  it('a resolve without a bundle id is refused for writes (fail closed)', async () => {
    const s = setup()
    const ref = await s.refOf(WB)
    ;(s.driver as Record<string, unknown>).resolve = async () => ({ instance: WB.instance, role: 'button', name: 'x' })
    expect(await s.run('act', { ref, action: 'click' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(s.driver.acts).toHaveLength(0)
  })

  it('ask: a gate with the element, the app and a highlighted crop of its bounds; the act pins the resolved instance', async () => {
    const s = setup({ mode: 'ask' })
    const ref = await s.refOf(WB)
    const r = await s.run('act', { ref, action: 'click' })
    expect(r).toMatchObject({ ok: true, label: '点击「新建会话」' })
    expect(s.gates).toHaveLength(1)
    expect(s.gates[0]).toMatchObject({
      kind: 'action',
      action: { kind: 'act', element: { role: 'button', name: '新建会话' }, app: { name: 'WorkBuddy', bundleId: WB.bundleId }, actLabel: '点击' },
    })
    expect(s.gates[0].crop).toBeTruthy()
    const c = s.driver.crops[0]
    expect(c.rectPt.x).toBeLessThanOrEqual(100)
    expect(c.rectPt.y).toBeLessThanOrEqual(200)
    expect(c.rectPt.x + c.rectPt.w).toBeGreaterThanOrEqual(180)
    expect(c.rectPt.y + c.rectPt.h).toBeGreaterThanOrEqual(230)
    expect(c.marker).toEqual([{ x: 140, y: 215 }])
    expect(c.maskPids).toContain(OWN_PID)
    expect(s.driver.acts).toHaveLength(1)
    expect(s.driver.acts[0].guard.expectInstance).toEqual(WB.instance)
    expect(s.driver.acts[0].guard.denyPids).toContain(OWN_PID)
    expect(s.driver.acts[0].req).toEqual({ ref, action: 'click' })
  })

  it('ask: no bounds → a gate without a crop', async () => {
    const s = setup({ mode: 'ask' })
    const ref = await s.refOf(WB, 'e2')
    await s.run('act', { ref, action: 'type', text: '你好' })
    expect(s.gates[0].crop).toBeUndefined()
    expect(s.gates[0].action).toMatchObject({ kind: 'act', text: '你好', element: { role: 'textfield', name: '输入消息' } })
    expect(s.driver.crops).toHaveLength(0)
    expect(s.driver.acts[0].req).toEqual({ ref, action: 'type', text: '你好' })
  })

  it('a denied gate never acts and is recorded as denied', async () => {
    const s = setup({ mode: 'ask' })
    s.decisions.push('deny')
    const ref = await s.refOf(WB)
    expect(await s.run('act', { ref, action: 'click' })).toMatchObject({ ok: false, code: 'denied', retry: 'safe' })
    expect(s.driver.acts).toHaveLength(0)
    expect(s.hider.beforeMutation).not.toHaveBeenCalled()
    expect(s.entries.at(-1)).toMatchObject({ op: 'act', result: 'denied', element: { role: 'button', name: '新建会话' }, actLabel: '点击' })
  })

  it('allow: Terminal still asks (askAlways); WorkBuddy does not', async () => {
    const s = setup({ mode: 'allow' })
    await s.run('act', { ref: await s.refOf(TERM), action: 'type', text: 'ls' })
    expect(s.gates).toHaveLength(1)
    expect(s.gates[0].reason).toBe('终端')
    await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(s.gates).toHaveLength(1)
    expect(s.driver.acts).toHaveLength(2)
  })

  it('a blocked app ref → blocked_app, no act', async () => {
    const s = setup()
    expect(await s.run('act', { ref: await s.refOf(PW), action: 'type', text: 'x' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(s.driver.acts).toHaveLength(0)
  })

  it('uncertain → unsafe, never repeat', async () => {
    const s = setup()
    s.driver.setActError({ code: 'uncertain', delivery: 'uncertain' })
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r).toMatchObject({ ok: false, code: 'uncertain', retry: 'unsafe', delivery: 'uncertain' })
    if (!r.ok) expect(r.text).toContain('不要重复')
    expect(s.entries.at(-1)).toMatchObject({ result: 'failed', code: 'uncertain', delivery: 'uncertain' })
  })

  it('a helper failure after the act may have landed (delivery uncertain) is unsafe too', async () => {
    const s = setup()
    s.driver.setActError({ code: 'timeout', delivery: 'uncertain' })
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r).toMatchObject({ ok: false, code: 'timeout', retry: 'unsafe' })
    if (!r.ok) expect(r.text).toContain('不要重复')
  })

  it('a failure names its delivery with the short words the success side uses', async () => {
    const s = setup()
    s.driver.setActError({ code: 'helper_failed', delivery: 'delivered_unverified' })
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r.text).toContain('delivery=unverified')
    expect(r.text).not.toContain('delivered_')
  })

  it('an act error without a delivery is unsafe unless the code itself means nothing happened', async () => {
    const s = setup()
    s.driver.setActError({ code: 'helper_failed' })
    expect(await s.run('act', { ref: await s.refOf(WB), action: 'click' })).toMatchObject({ ok: false, code: 'helper_failed', retry: 'unsafe' })
    s.driver.setActError({ code: 'ambiguous_target' })
    expect(await s.run('act', { ref: await s.refOf(WB), action: 'click' })).toMatchObject({ ok: false, code: 'ambiguous_target', retry: 'safe' })
    s.driver.setActError({ code: 'weird_code', delivery: 'not_delivered' })
    expect(await s.run('act', { ref: await s.refOf(WB), action: 'click' })).toMatchObject({ ok: false, code: 'helper_failed', retry: 'safe' })
  })

  it('stale_ref (from the act or from resolve) → safe, re-snapshot', async () => {
    const s = setup()
    s.driver.setActError({ code: 'stale_ref', delivery: 'not_delivered' })
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r).toMatchObject({ ok: false, code: 'stale_ref', retry: 'safe' })
    if (!r.ok) expect(r.text).toContain('重新 snapshot')
    s.driver.setActError(null)
    const r2 = await s.run('act', { ref: '@s99:e1', action: 'click' })
    expect(r2).toMatchObject({ ok: false, code: 'stale_ref', retry: 'safe' })
  })

  it('unsupported without physical hints physical:true', async () => {
    const s = setup()
    s.driver.setActError({ code: 'unsupported', delivery: 'not_delivered' })
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r).toMatchObject({ ok: false, code: 'unsupported', retry: 'safe' })
    if (!r.ok) expect(r.text).toContain('physical:true')
  })

  it('delivered_unverified → ok, 未确认; delivered_verified → ok, 已确认', async () => {
    const s = setup()
    s.driver.setActResult({ delivery: 'delivered_unverified', steps: [] })
    const a = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(a).toMatchObject({ ok: true, delivery: 'delivered_unverified' })
    if (a.ok) expect(a.text).toContain('未确认')
    s.driver.setActResult({ delivery: 'delivered_verified', steps: [] })
    const b = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(b).toMatchObject({ ok: true, delivery: 'delivered_verified' })
    if (b.ok) {
      expect(b.text).toContain('已确认')
      expect(b.text).toContain('已点击 按钮 <untrusted_screen_text>新建会话</untrusted_screen_text> · 目标 <untrusted_screen_text>WorkBuddy</untrusted_screen_text>')
    }
    expect(s.entries.at(-1)).toMatchObject({ op: 'act', result: 'auto', app: 'WorkBuddy', bundleId: WB.bundleId, delivery: 'delivered_verified', element: { role: 'button', name: '新建会话' }, actLabel: '点击' })
  })

  it('an uncertain reply that came back as a result is still a failure, unsafe', async () => {
    const s = setup()
    s.driver.setActResult({ delivery: 'uncertain', steps: [] })
    expect(await s.run('act', { ref: await s.refOf(WB), action: 'click' })).toMatchObject({ ok: false, code: 'uncertain', retry: 'unsafe' })
  })

  it('no pixel-signature re-gate: allowed 20 s later, the crop is taken once', async () => {
    const s = setup({ mode: 'ask' })
    s.onGate(() => s.advance(20_000))
    s.driver.setCropSig('BBBB')
    const r = await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(r.ok).toBe(true)
    expect(s.driver.crops).toHaveLength(1)
    expect(s.gates).toHaveLength(1)
  })

  it('type into a field while secure input is on → secure_input, no act', async () => {
    const s = setup()
    s.driver.setStatus({ secureInput: true })
    expect(await s.run('act', { ref: await s.refOf(WB, 'e2'), action: 'type', text: 'x' })).toMatchObject({ ok: false, code: 'secure_input', retry: 'safe' })
    expect(s.driver.acts).toHaveLength(0)
  })

  it('the type text is logged as a length only (V11)', async () => {
    const s = setup()
    await s.run('act', { ref: await s.refOf(WB, 'e2'), action: 'type', text: 'hunter2' })
    expect(s.entries.at(-1)).toMatchObject({ textLen: 7 })
    expect(JSON.stringify(s.entries.at(-1))).not.toContain('hunter2')
  })

  it('semantic tools need no visionCode, and no prior screenshot', async () => {
    const s = setup()
    expect((await s.run('act', { ref: await s.refOf(WB), action: 'click' })).ok).toBe(true)
    expect(s.driver.captures).toHaveLength(0)
  })
})

describe('launch / focus / key(app)', () => {
  it('launch of a blocked app → blocked_app, no launch', async () => {
    const s = setup()
    expect(await s.run('launch', { app: 'com.1password.1password' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(await s.run('launch', { app: 'com.zghua.myflowforge' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(s.driver.launches).toHaveLength(0)
  })

  it('launch of an ask-always app opens a gate, even in allow', async () => {
    const s = setup({ mode: 'allow' })
    const r = await s.run('launch', { app: 'com.apple.Terminal' })
    expect(r.ok).toBe(true)
    expect(s.gates[0]).toMatchObject({ kind: 'action', action: { kind: 'launch', app: { name: 'Terminal', bundleId: 'com.apple.Terminal' }, actLabel: '打开' } })
    expect(s.driver.launches[0]).toMatchObject({ bundleId: 'com.apple.Terminal', activate: false })
  })

  it('launch by bundle id; the reply lists windows; a plain app in allow is not asked', async () => {
    const s = setup({ mode: 'allow' })
    s.driver.setAxApps([WB])
    ;(s.driver as Record<string, unknown>).runningApps = async () => []
    const r = await s.run('launch', { app: WB.bundleId, activate: true })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('WorkBuddy')
    expect(s.driver.launches[0]).toMatchObject({ bundleId: WB.bundleId, activate: true })
    expect(s.gates).toHaveLength(0)
    expect(s.calls.indexOf('hide')).toBeLessThan(s.calls.indexOf('launch'))
  })

  it('allow: a launch by a bare name that is not running always asks, with the name on the card', async () => {
    const s = setup({ mode: 'allow' })
    ;(s.driver as Record<string, unknown>).runningApps = async () => []
    s.decisions.push('deny')
    expect(await s.run('launch', { app: 'iTerm' })).toMatchObject({ ok: false, code: 'denied', retry: 'safe' })
    expect(s.gates[0]).toMatchObject({ kind: 'action', reason: '始终询问', action: { kind: 'launch', app: { name: 'iTerm' } } })
    expect(s.driver.launches).toHaveLength(0)
    // allowed, it launches by that name
    s.driver.setAxApps([WB])
    expect((await s.run('launch', { app: 'WorkBuddy' })).ok).toBe(true)
    expect(s.gates).toHaveLength(2)
    expect(s.driver.launches[0]).toMatchObject({ name: 'WorkBuddy' })
  })

  it('a launch by name that turns out to be a blocked app is withheld — and unsafe, it is open now', async () => {
    const s = setup({ mode: 'allow' })
    ;(s.driver as Record<string, unknown>).runningApps = async () => []
    const r = await s.run('launch', { app: '1Password' })
    expect(r).toMatchObject({ ok: false, code: 'blocked_app', retry: 'unsafe', delivery: 'delivered_unverified' })
    if (!r.ok) expect(r.text).not.toContain('Vault')
    expect(s.driver.launches[0].guard?.denyBundlePrefixes).toContain('com.1password.1password')
    expect(s.entries.at(-1)).toMatchObject({ op: 'launch', result: 'blocked', code: 'blocked_app', delivery: 'delivered_unverified' })
  })

  it('the act card shows physical / replace / direction / amount', async () => {
    const s = setup({ mode: 'ask' })
    await s.run('act', { ref: await s.refOf(WB, 'e2'), action: 'type', text: 'x', replace: true })
    await s.run('act', { ref: await s.refOf(WB), action: 'click', physical: true })
    await s.run('act', { ref: await s.refOf(WB), action: 'scroll', direction: 'down', amount: 3 })
    expect(s.gates[0].action).toMatchObject({ kind: 'act', replace: true, text: 'x' })
    expect(s.gates[1].action).toMatchObject({ kind: 'act', physical: true })
    expect(s.gates[2].action).toMatchObject({ kind: 'act', direction: 'down', amount: 3 })
    expect(s.gates[0].action?.physical).toBeUndefined()
  })

  it('computer_focus hides us first, then focuses the window', async () => {
    const s = setup({ mode: 'allow' })
    const r = await s.run('focus', { app: 'WorkBuddy', window: 31 })
    expect(r.ok).toBe(true)
    expect(s.calls).toEqual(['hide', 'focusWindow'])
    expect(s.driver.focusWindows[0]).toMatchObject({ pid: 600, windowNumber: 31 })
  })

  it('ask: focus asks with a focus view', async () => {
    const s = setup({ mode: 'ask' })
    await s.run('focus', { app: 'WorkBuddy' })
    expect(s.gates[0].action).toMatchObject({ kind: 'focus', app: { name: 'WorkBuddy' }, actLabel: '聚焦' })
  })

  it('computer_key with app → driver.appKey on that pid; without app it stays on the v1 path', async () => {
    const s = setup({ mode: 'allow' })
    s.driver.setAppKeyResult({ via: 'menu', delivery: 'delivered_verified' })
    const r = await s.run('key', { combo: 'cmd+t', app: 'WorkBuddy' })
    expect(r).toMatchObject({ ok: true, delivery: 'delivered_verified' })
    expect(s.driver.appKeys[0]).toMatchObject({ pid: 600, mods: ['cmd'], key: { char: 't' }, repeat: 1 })
    expect(s.calls).toEqual(['hide', 'appKey'])
    const v1 = await s.run('key', { combo: 'cmd+t' })
    expect(v1).toMatchObject({ ok: false, code: 'need_screenshot' })
    expect(s.driver.appKeys).toHaveLength(1)
  })

  it('cmd+q to an app → blocked_combo, the driver never called', async () => {
    const s = setup()
    expect(await s.run('key', { combo: 'cmd+q', app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'blocked_combo', retry: 'safe' })
    expect(await s.run('key', { combo: 'cmd+alt+shift+q', app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'blocked_combo' })
    expect(s.driver.appKeys).toHaveLength(0)
    expect(s.hider.beforeMutation).not.toHaveBeenCalled()
  })

  it('key(app) to our own app, or a blocked app, is refused', async () => {
    const s = setup()
    expect(await s.run('key', { combo: 'return', app: 'myFlowForge' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(await s.run('key', { combo: 'return', app: '1Password' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(s.driver.appKeys).toHaveLength(0)
  })

  it('ask: key(app) asks with the combo and the app', async () => {
    const s = setup({ mode: 'ask' })
    await s.run('key', { combo: 'cmd+shift+t', app: 'WorkBuddy', repeat: 2 })
    expect(s.gates[0].action).toMatchObject({ kind: 'appKey', combo: '⌘⇧T', repeat: 2, app: { name: 'WorkBuddy' }, actLabel: '按键' })
  })

  it('an appKey that may have landed is unsafe', async () => {
    const s = setup()
    s.driver.setAppKeyResult({ via: 'pid', delivery: 'uncertain' })
    expect(await s.run('key', { combo: 'cmd+t', app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'uncertain', retry: 'unsafe' })
  })
})

describe('wait_for / windows / apps', () => {
  it('wait_for maps to driver.waitFor on the app pid, and renders the found node under the notice', async () => {
    const s = setup()
    s.driver.setWaitForResult({ found: true, snapId: 's5', node: { ref: '@s5:e1', depth: 0, role: 'button', name: '发送', states: [], actions: ['click'] } })
    const r = await s.run('wait_for', { app: 'WorkBuddy', role: 'button', nameContains: '发', timeoutMs: 2000 })
    expect(s.driver.waitFors[0]).toMatchObject({ pid: 600, match: { role: 'button', nameContains: '发' }, gone: false, timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text.startsWith('<untrusted_screen snap="s5" app="WorkBuddy">')).toBe(true)
      expect(r.text).toContain('- button "发送" @s5:e1 [click]')
    }
  })

  it('wait_for not found is an answer, not an error; blocked / own apps are refused', async () => {
    const s = setup()
    s.driver.setWaitForResult({ found: false })
    expect((await s.run('wait_for', { app: 'WorkBuddy', name: 'x' })).ok).toBe(true)
    expect(await s.run('wait_for', { app: '1Password', name: 'x' })).toMatchObject({ ok: false, code: 'blocked_app' })
    expect(await s.run('wait_for', { app: 'myFlowForge', name: 'x' })).toMatchObject({ ok: false, code: 'own_window' })
    expect(s.driver.waitFors).toHaveLength(1)
  })

  it('windows: our own and blocked apps never listed; titles wrapped as untrusted', async () => {
    const s = setup()
    const r = await s.run('windows', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('<untrusted_screen_text>WorkBuddy</untrusted_screen_text>')
    expect(r.text).not.toContain('Vault')
    expect(r.text).not.toContain('会话')
    expect(await s.run('windows', { app: 'myFlowForge' })).toMatchObject({ ok: false, code: 'own_window' })
  })

  it('apps: our own app is not listed', async () => {
    const s = setup()
    const r = await s.run('apps', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.text).toContain('com.example.workbuddy')
    expect(r.text).not.toContain('com.zghua.myflowforge')
  })
})

describe('counting and pacing (spec §7.3)', () => {
  it('act / launch / focus / appKey count as inputs: the 101st asks to continue', async () => {
    const s = setup()
    const ref = await s.refOf(WB)
    for (let i = 0; i < 97; i++) expect((await s.run('act', { ref, action: 'click' })).ok).toBe(true)
    expect((await s.run('launch', { app: 'WorkBuddy' })).ok).toBe(true)
    expect((await s.run('focus', { app: 'WorkBuddy' })).ok).toBe(true)
    expect((await s.run('key', { combo: 'cmd+t', app: 'WorkBuddy' })).ok).toBe(true)
    expect(s.gates).toHaveLength(0)
    s.decisions.push('deny')
    expect(await s.run('act', { ref, action: 'click' })).toMatchObject({ ok: false, code: 'step_limit' })
    expect(s.gates).toEqual([expect.objectContaining({ kind: 'continue' })])
    expect(s.driver.acts).toHaveLength(97)
  })

  it('snapshot / wait_for count against the 300 screenshots per turn; a new turn resets it', async () => {
    const s = setup()
    for (let i = 0; i < 299; i++) expect((await s.run('snapshot', { app: 'WorkBuddy' })).ok).toBe(true)
    expect((await s.run('wait_for', { app: 'WorkBuddy', name: 'x' })).ok).toBe(true)
    expect(await s.run('snapshot', { app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'step_limit' })
    expect(await s.run('screenshot')).toMatchObject({ ok: false, code: 'step_limit' })
    s.st.turn = 2
    expect((await s.run('snapshot', { app: 'WorkBuddy' })).ok).toBe(true)
  })

  it('hider.beforeMutation is called once per mutating action, never for reads', async () => {
    const s = setup()
    await s.run('snapshot', { app: 'WorkBuddy' })
    await s.run('wait_for', { app: 'WorkBuddy', name: 'x' })
    await s.run('windows', {})
    await s.run('apps', {})
    expect(s.hider.beforeMutation).not.toHaveBeenCalled()
    await s.run('act', { ref: await s.refOf(WB), action: 'click' })
    expect(s.hider.beforeMutation).toHaveBeenCalledTimes(1)
    expect(s.hider.beforeMutation).toHaveBeenCalledWith(WB.instance)
    expect(s.calls.slice(-2)).toEqual(['hide', 'act'])
  })
})

describe('I1: launch first, then act — the front still leaves us (spec §9.1)', () => {
  it('launch (no target) → act click → act type: focusWindow(WorkBuddy) exactly once, before the type', async () => {
    const s = setup({ realHider: true })
    s.driver.setFront({ pid: OWN_PID, layer: 0 })
    const real = s.driver.focusWindow.bind(s.driver)
    ;(s.driver as Record<string, unknown>).focusWindow = async (fo: Parameters<typeof real>[0]) => {
      s.calls.push(`focus:${fo.pid}`)
      await real(fo)
      s.driver.setFront({ pid: fo.pid, layer: 0 })
    }
    s.driver.setAxApps([WB])
    ;(s.driver as Record<string, unknown>).runningApps = async () => []
    expect((await s.run('launch', { app: WB.bundleId, activate: true })).ok).toBe(true)
    s.driver.setFront({ pid: OWN_PID, layer: 0 })
    expect((await s.run('act', { ref: await s.refOf(WB), action: 'click' })).ok).toBe(true)
    expect((await s.run('act', { ref: await s.refOf(WB, 'e2'), action: 'type', text: 'hi' })).ok).toBe(true)
    const focuses = s.calls.filter((c) => c.startsWith('focus:'))
    expect(focuses).toEqual([`focus:${WB.instance.pid}`])
    expect(s.calls.indexOf(focuses[0])).toBeLessThan(s.calls.lastIndexOf('act'))
  })

  it('launch with activate:false hands the launched instance to the hider: the front moves to it', async () => {
    const s = setup({ realHider: true })
    s.driver.setFront({ pid: OWN_PID, layer: 0 })
    s.driver.setAxApps([WB])
    ;(s.driver as Record<string, unknown>).runningApps = async () => []
    expect((await s.run('launch', { app: WB.bundleId })).ok).toBe(true)
    expect(s.driver.focusWindows.map((f) => f.pid)).toEqual([WB.instance.pid])
  })
})

describe('environment and enablement are shared with v1', () => {
  it('off / no turn / locked / no permission refuse before the driver is touched', async () => {
    const s = setup()
    s.st.mode = 'off'
    expect(await s.run('snapshot', { app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'not_enabled' })
    s.st.mode = 'allow'
    s.st.turn = 0
    expect(await s.run('act', { ref: '@s1:e1', action: 'click' })).toMatchObject({ ok: false, code: 'no_turn' })
    s.st.turn = 1
    s.driver.setStatus({ locked: true })
    expect(await s.run('apps', {})).toMatchObject({ ok: false, code: 'locked' })
    s.driver.setStatus({ locked: false, ax: false })
    expect(await s.run('launch', { app: 'WorkBuddy' })).toMatchObject({ ok: false, code: 'no_permission' })
    expect(s.driver.resolves).toHaveLength(0)
    expect(s.driver.launches).toHaveLength(0)
    expect(s.driver.snapshots).toHaveLength(0)
  })

  it('bad args → invalid_args (strict schemas)', async () => {
    const s = setup()
    expect(await s.run('act', { ref: 'e1', action: 'click' })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await s.run('snapshot', { app: 'WorkBuddy', extra: 1 })).toMatchObject({ ok: false, code: 'invalid_args' })
  })

  it('runSemantic can be called directly with the executor deps and shares its counters', async () => {
    const s = setup()
    const r = await runSemantic(s.deps, K, 'computer_snapshot', { app: 'WorkBuddy' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toContain('@s1:e1')
  })
})
