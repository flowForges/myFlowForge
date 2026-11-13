import { describe, it, expect, vi, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CuStatus } from '@shared/computerUse'
import { COMPUTER_TOOLS } from '@shared/computerUse'
import { defaultComputerUse, type ComputerUseSettings } from '../config/schema'
import { forgeMcpArgs } from '../agents/mcpConfig'
import { fakeDriver } from './fakeDriver'
import type { PostAction, PostResult } from './driver'
import type { PermissionProbe } from './permissions'
import type { ActionLog, CuEvent, CuGate, CuSessionKey, CuResult, Executor, GateDecision, ServiceInternals } from './types'
import { createComputerUseService, ensurePrivateDir } from './service'

const A: CuSessionKey = { workspacePath: '/w/a', sessionId: 's-a' }
const B: CuSessionKey = { workspacePath: '/w/b', sessionId: 's-b' }
const LOCAL = { local: true }
const REMOTE = { local: false }
const FIVE_MIN = 5 * 60_000

const OK_STATUS: CuStatus = { supported: true, osOK: true, helper: 'ok', screen: true, ax: true }

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve() }

type Run = (svc: ServiceInternals, key: CuSessionKey, op: string, args: unknown) => Promise<CuResult>

function setup(o: {
  phys?: boolean
  live?: { disclaimed: boolean }[]
  idle?: { mouseDown?: number; keyDown?: number; any?: number }
  status?: Partial<CuStatus>
  settings?: Partial<ComputerUseSettings>
  run?: Run
  noExecutor?: boolean
  configDir?: string | null
  random?: () => string
  probeHold?: Promise<void>
} = {}) {
  const driver = fakeDriver()
  const idle = { mouseDown: 60, keyDown: 60, any: 60, ...o.idle }
  const idleCalls: string[] = []
  driver.idleSeconds = async (k: 'any' | 'mouseDown' | 'keyDown' = 'any') => { idleCalls.push(k); return idle[k] }
  let statusCalls = 0
  const realStatus = driver.status.bind(driver)
  driver.status = async () => { statusCalls++; return realStatus() }

  const events: CuEvent[] = []
  const notes: { key: CuSessionKey; text: string }[] = []
  const stoppedTurns: CuSessionKey[] = []
  const saved: Partial<ComputerUseSettings>[] = []
  let settings: ComputerUseSettings = { ...defaultComputerUse(), ...o.settings }
  let clock = 1_000_000
  const timers: { at: number; fn: () => void; dead: boolean }[] = []
  let n = 0
  const runs: { key: CuSessionKey; op: string; args: unknown }[] = []
  let internals: ServiceInternals | null = null
  const probe: PermissionProbe = {
    status: async () => { if (o.probeHold) await o.probeHold; return { ...OK_STATUS, ...o.status } },
    request: async () => {}, openPane: async () => {},
  }
  const log: ActionLog = {
    append: async (_k, e) => e, list: async () => [], thumb: async () => null, remove: async () => {},
  }
  const live = o.live ?? []
  const svc = createComputerUseService({
    driver, probe,
    now: () => clock,
    random: o.random ?? (() => `R${(++n).toString().padStart(16, '0')}`),
    emit: (e) => events.push(e),
    note: (key, text) => notes.push({ key, text }),
    stopTurn: (key) => stoppedTurns.push(key),
    titleOf: (k) => `T-${k.sessionId}`,
    settings: () => settings,
    ownPid: 4242,
    ownAccelerators: () => [],
    log,
    executorFactory: o.noExecutor ? undefined : (s: ServiceInternals): Executor => {
      internals = s
      return {
        run: async (key, op, args) => {
          runs.push({ key, op, args })
          // test hook: a call whose only job is to open one gate (gates can only be opened from inside a call, M-4)
          const a = args as { __gate?: Omit<CuGate, 'id' | 'ts'>; __onDecision?: (d: GateDecision) => void }
          if (a && a.__gate) {
            const dec = await s.openGate(a.__gate)
            a.__onDecision?.(dec)
            return { ok: true, text: dec }
          }
          if (o.run) return o.run(s, key, op, args)
          return { ok: true, text: `ran ${op}` }
        },
      }
    },
    liveAgentChildren: () => live,
    hidIsPhysical: () => o.phys ?? false,
    saveSettings: (p) => { saved.push(p); settings = { ...settings, ...p } },
    configDir: () => (o.configDir === undefined ? null : o.configDir),
    setTimer: (fn, ms) => {
      const t = { at: clock + ms, fn, dead: false }
      timers.push(t)
      return () => { t.dead = true }
    },
  })
  const advance = (ms: number) => {
    clock += ms
    for (const t of timers) if (!t.dead && t.at <= clock) { t.dead = true; t.fn() }
  }
  const jump = (ms: number) => { clock += ms }
  /** open a gate from inside a running call; resolves to [decision, the call's result] */
  const gate = async (g: Omit<CuGate, 'id' | 'ts' | 'key'> & { key?: CuSessionKey }) => {
    const key = g.key ?? A
    const dd = deferred<GateDecision>()
    const call = svc.handle(svc.tokenFor(key) as string, 'click', { __gate: { ...g, key }, __onDecision: dd.resolve }, {})
    await flush(30)
    return [dd.promise, call] as const
  }
  const on = async (key = A, mode: 'ask' | 'allow' = 'ask') => {
    const r = await svc.setMode(key, mode, LOCAL)
    expect(r).toEqual({ ok: true })
    return svc.tokenFor(key) as string
  }
  return {
    svc, driver, events, notes, stoppedTurns, saved, runs, idle, idleCalls, advance, jump, gate, on, live,
    get statusCalls() { return statusCalls },
    get internals() { return internals as unknown as ServiceInternals },
    get settings() { return settings },
  }
}

afterEach(() => { vi.restoreAllMocks() })

// ───────────────────────── setMode ─────────────────────────

describe('setMode (Review Focus 3, 14, 21; V3, V5)', () => {
  it('a non-local caller gets not_local and nothing changes', async () => {
    const t = setup()
    expect(await t.svc.setMode(A, 'allow', REMOTE)).toEqual({ ok: false, code: 'not_local' })
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.svc.tokenFor(A)).toBeNull()
    expect(t.events).toEqual([])
    expect(t.saved).toEqual([])
    // not even turning it off
    await t.on(A)
    expect(await t.svc.setMode(A, 'off', REMOTE)).toEqual({ ok: false, code: 'not_local' })
    expect(t.svc.modeOf(A)).toBe('ask')
  })

  it('local off→ask enables, mints a cu.<16> token, persists provisioned and emits state', async () => {
    const t = setup()
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    expect(t.svc.modeOf(A)).toBe('ask')
    expect(t.svc.tokenFor(A)).toMatch(/^cu\.[A-Za-z0-9]{16}$/)
    expect(t.saved).toEqual([{ provisioned: true }])
    expect(t.events.at(-1)).toEqual({ type: 'state', sessions: [{ ...A, mode: 'ask', title: 'T-s-a' }] })
  })

  it('provisioned already true is not re-saved', async () => {
    const t = setup({ settings: { provisioned: true } })
    await t.on(A)
    expect(t.saved).toEqual([])
  })

  it('an unsupported probe gives unsupported', async () => {
    const t = setup({ status: { supported: false } })
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: false, code: 'unsupported' })
    expect(t.svc.modeOf(A)).toBe('off')
  })

  it('a live undisclaimed agent child gives restart_required; provisioned is still saved so the next start disclaims', async () => {
    const t = setup({ live: [{ disclaimed: true }, { disclaimed: false }] })
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: false, code: 'restart_required' })
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.svc.tokenFor(A)).toBeNull()
    expect(t.saved).toEqual([{ provisioned: true }])
    t.live.splice(1, 1)   // that child exited
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
  })

  it('switching ask↔allow keeps the token; →off revokes it', async () => {
    const t = setup()
    const tok = await t.on(A, 'ask')
    expect(await t.svc.setMode(A, 'allow', LOCAL)).toEqual({ ok: true })
    expect(t.svc.tokenFor(A)).toBe(tok)
    expect(await t.svc.setMode(A, 'off', LOCAL)).toEqual({ ok: true })
    expect(t.svc.tokenFor(A)).toBeNull()
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.events.at(-1)).toEqual({ type: 'state', sessions: [] })
  })

  it('V5: with hidIsPhysical, enabling needs a physical mouseDown/keyDown within 1 s', async () => {
    const t = setup({ phys: true, idle: { mouseDown: 3, keyDown: 5 } })
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: false, code: 'no_physical' })
    expect(t.svc.modeOf(A)).toBe('off')
    t.idle.mouseDown = 0.4
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    await t.svc.setMode(A, 'off', LOCAL)
    t.idle.mouseDown = 9; t.idle.keyDown = 0.2
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
  })

  it('V5: escalating ask→allow also needs physical input; allow→ask and →off never do', async () => {
    const t = setup({ phys: true, idle: { mouseDown: 0.1 } })
    await t.on(A, 'ask')
    t.idle.mouseDown = 3
    expect(await t.svc.setMode(A, 'allow', LOCAL)).toEqual({ ok: false, code: 'no_physical' })
    expect(t.svc.modeOf(A)).toBe('ask')
    t.idle.mouseDown = 0.1
    expect(await t.svc.setMode(A, 'allow', LOCAL)).toEqual({ ok: true })
    t.idle.mouseDown = 30
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    expect(await t.svc.setMode(A, 'off', LOCAL)).toEqual({ ok: true })
  })

  it('V5: a failing idle read fails closed', async () => {
    const t = setup({ phys: true })
    t.driver.idleSeconds = async () => { throw new Error('helper down') }
    expect(await t.svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: false, code: 'no_physical' })
  })

  it('V5: with hidIsPhysical false (default) idle is never consulted', async () => {
    const t = setup({ idle: { mouseDown: 999, keyDown: 999 } })
    await t.on(A)
    expect(t.idleCalls).toEqual([])
  })
})

describe('one session at a time (Review Focus 14)', () => {
  it('B while A is on gives busy with A\'s title; after A goes off B can enable', async () => {
    const t = setup()
    await t.on(A)
    expect(await t.svc.setMode(B, 'ask', LOCAL)).toEqual({ ok: false, code: 'busy', busy: { ...A, title: 'T-s-a' } })
    expect(t.svc.modeOf(B)).toBe('off')
    await t.svc.setMode(A, 'off', LOCAL)
    expect(await t.svc.setMode(B, 'allow', LOCAL)).toEqual({ ok: true })
  })

  it('stopping A frees the lease', async () => {
    const t = setup()
    await t.on(A)
    t.svc.stop(A, 'user')
    expect(await t.svc.setMode(B, 'ask', LOCAL)).toEqual({ ok: true })
  })

  it('forgetting A (delete/archive) frees the lease, revokes the token and writes no note', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.forget(A)
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.notes).toEqual([])
    expect((await t.svc.handle(tok, 'screenshot', {}, {})).ok).toBe(false)
    expect(await t.svc.setMode(B, 'ask', LOCAL)).toEqual({ ok: true })
    expect(t.events).toContainEqual({ type: 'stopped', key: A, why: 'deleted' })
  })
})

// ───────────────────────── turns ─────────────────────────

describe('beginTurn / endTurn', () => {
  it('tools only for a local turn with the mode on', async () => {
    const t = setup()
    expect(t.svc.beginTurn(A, 'local')).toEqual({ tools: false })   // mode off
    t.svc.endTurn(A)
    await t.on(A)
    for (const origin of ['remote', 'bot', 'pet', 'workflow'] as const) {
      expect(t.svc.beginTurn(A, origin)).toEqual({ tools: false })
      t.svc.endTurn(A)
    }
    // an unstamped payload counts as non-local (V12)
    expect(t.svc.beginTurn(A, undefined as unknown as 'local')).toEqual({ tools: false })
    t.svc.endTurn(A)
    expect(t.svc.beginTurn(A, 'local')).toEqual({ tools: true })
  })

  it('a non-local turn cannot use the token (no_turn), and the driver is untouched', async () => {
    const t = setup()
    const tok = await t.on(A)
    for (const origin of ['remote', 'bot', 'pet', 'workflow'] as const) {
      t.svc.beginTurn(A, origin)
      expect(await t.svc.handle(tok, 'click', { x: 1, y: 1 }, {})).toMatchObject({ ok: false, code: 'no_turn' })
      t.svc.endTurn(A)
    }
    expect(t.runs).toEqual([])
    expect(t.statusCalls).toBe(0)
  })

  it('endTurn denies the turn\'s gates', async () => {
    const t = setup()
    await t.on(A)
    t.svc.beginTurn(A, 'local')
    const [p] = await t.gate({ kind: 'action', action: { kind: 'click', at: { x: 1, y: 2 } } })
    expect(t.svc.pendingGates()).toHaveLength(1)
    const id = t.svc.pendingGates()[0].id
    t.svc.endTurn(A)
    expect(await p).toBe('deny')
    expect(t.svc.pendingGates()).toEqual([])
    expect(t.events).toContainEqual({ type: 'gate-resolved', id, decision: 'deny' })
  })

  it('after endTurn the token gives no_turn', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
    t.svc.endTurn(A)
    expect(await t.svc.handle(tok, 'cursor', {}, {})).toMatchObject({ ok: false, code: 'no_turn' })
  })

  it('turnSeq / enableSeq change per turn and per enable period', async () => {
    const t = setup()
    await t.on(A)
    const e1 = t.internals.enableSeq(A)
    expect(e1).toBeGreaterThan(0)
    t.svc.beginTurn(A, 'local')
    const s1 = t.internals.turnSeq(A)
    t.svc.endTurn(A)
    expect(t.internals.turnSeq(A)).toBe(0)
    t.svc.beginTurn(A, 'local')
    expect(t.internals.turnSeq(A)).toBeGreaterThan(s1)
    await t.svc.setMode(A, 'off', LOCAL)
    expect(t.internals.enableSeq(A)).toBe(0)
    await t.on(A)
    expect(t.internals.enableSeq(A)).toBeGreaterThan(e1)
  })
})

// ───────────────────────── tokens ─────────────────────────

describe('tokens are the authority (Review Focus 4)', () => {
  const untouched = (t: ReturnType<typeof setup>) => {
    expect(t.runs).toEqual([])
    expect(t.statusCalls).toBe(0)
    expect(t.driver.posts).toEqual([])
    expect(t.driver.captures).toEqual([])
  }

  it('an unknown token gives not_enabled', async () => {
    const t = setup()
    await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.handle('cu.nope', 'screenshot', {}, {})).toMatchObject({ ok: false, code: 'not_enabled' })
    untouched(t)
  })

  for (const [name, kill] of [
    ['off', (t: ReturnType<typeof setup>) => t.svc.setMode(A, 'off', LOCAL)],
    ['stop', (t: ReturnType<typeof setup>) => t.svc.stop(A, 'user')],
    ['lock', (t: ReturnType<typeof setup>) => t.svc.onLock()],
    ['forget', (t: ReturnType<typeof setup>) => t.svc.forget(A)],
  ] as const) {
    it(`a token from before ${name} gives not_enabled, even after re-enabling`, async () => {
      const t = setup()
      const tok = await t.on(A)
      await kill(t)
      t.svc.beginTurn(A, 'local')
      expect(await t.svc.handle(tok, 'click', { x: 1, y: 1 }, {})).toMatchObject({ ok: false, code: 'not_enabled' })
      t.svc.endTurn(A)
      const tok2 = await t.on(A)
      expect(tok2).not.toBe(tok)
      t.svc.beginTurn(A, 'local')
      expect(await t.svc.handle(tok, 'click', { x: 1, y: 1 }, {})).toMatchObject({ ok: false, code: 'not_enabled' })
      untouched(t)
    })
  }

  it('a valid token with no open local turn gives no_turn', async () => {
    const t = setup()
    const tok = await t.on(A)
    expect(await t.svc.handle(tok, 'click', { x: 1, y: 1 }, {})).toMatchObject({ ok: false, code: 'no_turn' })
    untouched(t)
  })

  it('an unknown op gives invalid_args without touching the executor', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.handle(tok, 'exec', {}, {})).toMatchObject({ ok: false, code: 'invalid_args' })
    untouched(t)
  })

  it('tokens stay unique even when random repeats', async () => {
    const t = setup({ random: () => 'AAAAAAAAAAAAAAAA' })
    const t1 = await t.on(A)
    await t.svc.setMode(A, 'off', LOCAL)
    const t2 = await t.on(A)
    expect(t2).not.toBe(t1)
    await t.svc.setMode(A, 'off', LOCAL)
    t.svc.beginTurn(B, 'local')
    expect(await t.svc.handle(t1, 'cursor', {}, {})).toMatchObject({ code: 'not_enabled' })
  })

  it('results carry the CU_ERR sentence', async () => {
    const t = setup()
    const r = await t.svc.handle('cu.x', 'cursor', {}, {})
    expect(r).toEqual({ ok: false, code: 'not_enabled', text: '电脑操作没有开启' })
  })

  it('a valid local call reaches the executor with key, op, args and meta', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.handle(tok, 'click', { x: 3, y: 4 }, { client: { name: 'claude-code', version: '2' } })).toEqual({ ok: true, text: 'ran click' })
    expect(t.runs).toEqual([{ key: A, op: 'click', args: { x: 3, y: 4 } }])
  })

  it('without an executorFactory every call is unsupported (no driver call)', async () => {
    const t = setup({ noExecutor: true })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.handle(tok, 'click', { x: 3, y: 4 }, {})).toMatchObject({ ok: false, code: 'unsupported' })
    expect(t.driver.posts).toEqual([])
  })
})

describe('token revoke deletes mcp.<token>.json (V12)', () => {
  it('the file forgeMcpArgs wrote for the token is removed on off, stop, lock and forget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-svc-'))
    try {
      for (const kill of ['off', 'stop', 'lock', 'forget'] as const) {
        const t = setup({ configDir: dir })
        const tok = await t.on(A)
        const args = forgeMcpArgs({
          FORGE_SOCKET: join(dir, 'cu.sock'), FORGE_MCP_DIR: dir, FORGE_AGENT_ID: tok,
          FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: COMPUTER_TOOLS.join(','),
        })
        const file = args[1]
        expect(existsSync(file)).toBe(true)
        expect(readFileSync(file, 'utf8')).toContain(tok)
        if (kill === 'off') await t.svc.setMode(A, 'off', LOCAL)
        if (kill === 'stop') t.svc.stop(A, 'user')
        if (kill === 'lock') t.svc.onLock()
        if (kill === 'forget') t.svc.forget(A)
        expect(existsSync(file)).toBe(false)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('ensurePrivateDir creates the cu config dir 0700 and tightens an existing one', () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-dir-'))
    try {
      const d = join(root, 'computer-use', 'cfg')
      ensurePrivateDir(d)
      expect(statSync(d).mode & 0o777).toBe(0o700)
      chmodSync(d, 0o755)
      ensurePrivateDir(d)
      expect(statSync(d).mode & 0o777).toBe(0o700)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

// ───────────────────────── gates ─────────────────────────

describe('gates are app-side (Review Focus 2; V5)', () => {
  async function gated(o: Parameters<typeof setup>[0] = {}) {
    const t = setup(o)
    await t.on(A)
    t.svc.beginTurn(A, 'local')
    const [p] = await t.gate({ kind: 'action', action: { kind: 'click', at: { x: 5, y: 6 } }, crop: 'Q1JPUA==' })
    const g = t.svc.pendingGates()[0]
    return { t, p, g }
  }

  it('openGate emits the gate (id + ts) and lists it as pending', async () => {
    const { t, g } = await gated()
    expect(g).toMatchObject({ key: A, kind: 'action', crop: 'Q1JPUA==', ts: 1_000_000 })
    expect(typeof g.id).toBe('string')
    expect(t.events).toContainEqual({ type: 'gate', gate: g })
  })

  it('a non-local resolve returns false and the gate stays pending', async () => {
    const { t, g } = await gated()
    expect(await t.svc.resolve(g.id, 'allow', REMOTE)).toBe(false)
    expect(await t.svc.resolve(g.id, 'deny', REMOTE)).toBe(false)
    expect(await t.svc.resolve(g.id, 'stop', REMOTE)).toBe(false)
    expect(t.svc.pendingGates()).toHaveLength(1)
    expect(t.svc.modeOf(A)).toBe('ask')
  })

  it('a local allow resolves it', async () => {
    const { t, p, g } = await gated()
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
    expect(await p).toBe('allow')
    expect(t.svc.pendingGates()).toEqual([])
    expect(t.events).toContainEqual({ type: 'gate-resolved', id: g.id, decision: 'allow' })
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(false)   // already answered
    expect(await t.svc.resolve('nope', 'allow', LOCAL)).toBe(false)
  })

  it('deny resolves deny; stop resolves stop and stops the session', async () => {
    const a = await gated()
    expect(await a.t.svc.resolve(a.g.id, 'deny', LOCAL)).toBe(true)
    expect(await a.p).toBe('deny')
    expect(a.t.svc.modeOf(A)).toBe('ask')
    const b = await gated()
    expect(await b.t.svc.resolve(b.g.id, 'stop', LOCAL)).toBe(true)
    expect(await b.p).toBe('stop')
    expect(b.t.svc.modeOf(A)).toBe('off')
    expect(b.t.stoppedTurns).toEqual([A])
  })

  it('times out at 5 minutes on the fake clock', async () => {
    const { t, p, g } = await gated()
    t.advance(FIVE_MIN - 1)
    expect(t.svc.pendingGates()).toHaveLength(1)
    t.advance(1)
    expect(await p).toBe('timeout')
    expect(t.svc.pendingGates()).toEqual([])
    expect(t.events).toContainEqual({ type: 'gate-resolved', id: g.id, decision: 'timeout' })
  })

  it('an allow arriving on a gate older than 5 min (clock jumped, timer not yet fired) is refused and the gate times out', async () => {
    const { t, p, g } = await gated()
    t.jump(FIVE_MIN + 10)   // a sleeping machine: wall clock moved, timer callback hasn't run
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(false)
    expect(await p).toBe('timeout')
    expect(t.svc.pendingGates()).toEqual([])
  })

  it('V5: with hidIsPhysical, allow needs a physical press within 1 s; deny/stop never do', async () => {
    const { t, p, g } = await gated({ phys: true, idle: { mouseDown: 0.1 } })
    t.idle.mouseDown = 3; t.idle.keyDown = 3
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(false)
    expect(t.svc.pendingGates()).toHaveLength(1)
    t.idle.mouseDown = 0.4
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
    expect(await p).toBe('allow')

    const d = await gated({ phys: true, idle: { mouseDown: 0.1 } })
    d.t.idle.mouseDown = 99; d.t.idle.keyDown = 99
    expect(await d.t.svc.resolve(d.g.id, 'deny', LOCAL)).toBe(true)
    const s = await gated({ phys: true, idle: { mouseDown: 0.1 } })
    s.t.idle.mouseDown = 99; s.t.idle.keyDown = 99
    expect(await s.t.svc.resolve(s.g.id, 'stop', LOCAL)).toBe(true)
  })

  it('V5: a continue gate\'s allow needs physical input too', async () => {
    const t = setup({ phys: true, idle: { mouseDown: 0.1 } })
    await t.on(A)
    t.svc.beginTurn(A, 'local')
    const [p] = await t.gate({ kind: 'continue', reason: '已执行 100 步' })
    const g = t.svc.pendingGates()[0]
    t.idle.mouseDown = 2
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(false)
    t.idle.keyDown = 0.3
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
    expect(await p).toBe('allow')
  })

  it('V5: with hidIsPhysical false idle is never read on resolve', async () => {
    const { t, g } = await gated({ idle: { mouseDown: 99, keyDown: 99 } })
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
    expect(t.idleCalls).toEqual([])
  })

  it('a gate for a session that is off, or has no open turn, is denied at once and never shown', async () => {
    const t = setup()
    expect(await t.svc.openGate({ key: A, kind: 'action' })).toBe('deny')
    await t.on(A)
    expect(await t.svc.openGate({ key: A, kind: 'action' })).toBe('deny')
    // M-4: even with the mode on and a local turn open, a gate opened outside a running call is denied
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.openGate({ key: A, kind: 'action' })).toBe('deny')
    expect(t.events.some((e) => e.type === 'gate')).toBe(false)
  })

  it('nothing but resolve / endTurn / stop / lock / timeout answers a gate (no permission-mode input exists)', async () => {
    const { t } = await gated()
    // switching ask→allow (the computer-use analogue of 完全访问) does not drain it
    await t.svc.setMode(A, 'allow', LOCAL)
    expect(t.svc.pendingGates()).toHaveLength(1)
  })
})

// ───────────────────────── serial FIFO (V6) ─────────────────────────

describe('one call at a time (Review Focus 20, V6)', () => {
  it('the second call\'s driver work starts only after the first returns', async () => {
    const order: string[] = []
    const first = deferred<void>()
    const t = setup({
      run: async (s, _k, op) => {
        order.push(`start ${op}`)
        if (op === 'click') await first.promise
        await s.driver.post({ kind: 'move', x: 1, y: 1 }, { denyPids: [4242], denyBundlePrefixes: [] })
        order.push(`end ${op}`)
        return { ok: true, text: op }
      },
    })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, {})
    await flush(20)
    expect(order).toEqual(['start click'])
    expect(t.driver.posts).toEqual([])
    first.resolve()
    expect(await p1).toEqual({ ok: true, text: 'click' })
    expect(await p2).toEqual({ ok: true, text: 'move' })
    expect(order).toEqual(['start click', 'end click', 'start move', 'end move'])
  })

  it('while a gate is pending, a second call\'s post does not happen', async () => {
    const t = setup({
      run: async (s, key, op) => {
        if (op === 'click') {
          const d = await s.openGate({ key, kind: 'action', action: { kind: 'click' } })
          if (d !== 'allow') return { ok: false, code: 'denied', text: 'x' }
        }
        await s.driver.post({ kind: 'move', x: 1, y: 1 }, { denyPids: [4242], denyBundlePrefixes: [] })
        return { ok: true, text: op }
      },
    })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, {})
    await flush(20)
    expect(t.svc.pendingGates()).toHaveLength(1)
    expect(t.driver.posts).toEqual([])
    await t.svc.resolve(t.svc.pendingGates()[0].id, 'allow', LOCAL)
    await p1; await p2
    expect(t.driver.posts).toHaveLength(2)
  })

  it('the guarded driver refuses to post while any gate is pending', async () => {
    let res: PostResult | null = null
    const t = setup({
      run: async (s, key) => {
        void s.openGate({ key, kind: 'action' })   // an executor that forgot to await its gate
        res = await s.driver.post({ kind: 'move', x: 1, y: 1 }, { denyPids: [4242], denyBundlePrefixes: [] })
        return { ok: true, text: 'x' }
      },
    })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'move', {}, {})
    await flush(30)
    t.svc.endTurn(A)
    await call
    expect(res).toEqual({ ok: false, code: 'target_changed' })
    expect(t.driver.posts).toEqual([])
  })

  it('a call queued past the end of its turn gets no_turn at dequeue', async () => {
    const first = deferred<void>()
    const t = setup({ run: async (_s, _k, op) => { if (op === 'click') await first.promise; return { ok: true, text: op } } })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, {})
    await flush()
    t.svc.endTurn(A)
    first.resolve()
    expect(await p1).toMatchObject({ ok: false, code: 'no_turn' })
    expect(await p2).toMatchObject({ ok: false, code: 'no_turn' })
    expect(t.runs.map((r) => r.op)).toEqual(['click'])
  })

  it('an executor that throws gives helper_failed and the queue keeps going', async () => {
    const t = setup({ run: async (_s, _k, op) => { if (op === 'click') throw new Error('boom'); return { ok: true, text: op } } })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, {})
    expect(await p1).toMatchObject({ ok: false, code: 'helper_failed' })
    expect(await p2).toEqual({ ok: true, text: 'move' })
  })
})

// ───────────────────────── stop (Review Focus 12, V7g) ─────────────────────────

describe('stop', () => {
  /** an executor whose click posts through a driver post that hangs until released */
  function hanging(postResult: PostResult = { ok: false, code: 'stopped' }) {
    const posting = deferred<void>()
    const finishPost = deferred<PostResult>()
    const t = setup({
      run: async (s, _k, op) => {
        if (op === 'click') {
          const r = await s.driver.post({ kind: 'click', x: 1, y: 1, button: 'right', count: 1, mods: ['cmd', 'shift'] }, { denyPids: [4242], denyBundlePrefixes: [] })
          const r2 = await s.driver.post({ kind: 'move', x: 2, y: 2 }, { denyPids: [4242], denyBundlePrefixes: [] })
          return { ok: r.ok && r2.ok, text: 'click', ...(r.ok && r2.ok ? {} : { code: 'stopped' as const }) } as CuResult
        }
        return { ok: true, text: op }
      },
    })
    const realPost = t.driver.post.bind(t.driver)
    t.driver.post = async (a: PostAction, g) => {
      if (a.kind === 'click') { posting.resolve(); await realPost(a, g); return finishPost.promise }
      return realPost(a, g)
    }
    return { t, posting, finishPost, postResult }
  }

  it('turns the mode off, revokes the token, denies gates, rejects queued calls, aborts, stops the turn, emits and notes', async () => {
    const { t, posting, finishPost } = hanging()
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, {})
    const p3 = t.svc.handle(tok, 'screenshot', {}, {})
    await posting.promise
    t.svc.stop(A, 'user')
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.svc.tokenFor(A)).toBeNull()
    expect(await p2).toMatchObject({ ok: false, code: 'stopped' })
    expect(await p3).toMatchObject({ ok: false, code: 'stopped' })
    await flush()
    expect(t.driver.aborted).toBe(1)
    expect(t.stoppedTurns).toEqual([A])
    expect(t.events).toContainEqual({ type: 'stopped', key: A, why: 'user' })
    expect(t.notes).toEqual([{ key: A, text: '电脑操作已停止' }])
    finishPost.resolve({ ok: false, code: 'stopped' })
    expect(await p1).toMatchObject({ ok: false, code: 'stopped' })
    // the in-flight call's follow-up post never reached the driver
    expect(t.driver.posts.map((p) => p.action.kind)).toEqual(['click'])
    expect(t.runs.map((r) => r.op)).toEqual(['click'])
  })

  it('abort answered "stopped" → no release; "killed" → release{mods,button} of the in-flight action', async () => {
    for (const outcome of ['stopped', 'killed'] as const) {
      const { t, posting, finishPost } = hanging()
      t.driver.abort = async () => { t.driver.aborted++; return outcome }
      const tok = await t.on(A, 'allow')
      t.svc.beginTurn(A, 'local')
      const p1 = t.svc.handle(tok, 'click', {}, {})
      await posting.promise
      t.svc.stop(A, 'hotkey')
      await flush(20)
      expect(t.driver.aborted).toBe(1)
      expect(t.driver.released).toEqual(outcome === 'killed' ? [{ mods: ['cmd', 'shift'], button: 'right' }] : [])
      finishPost.resolve({ ok: false, code: 'helper_failed' })
      expect(await p1).toMatchObject({ ok: false, code: 'stopped' })
    }
  })

  it('no post in flight → no abort (an idle helper is not signalled)', async () => {
    const t = setup()
    await t.on(A)
    t.svc.stop(A, 'user')
    await flush()
    expect(t.driver.aborted).toBe(0)
    expect(t.driver.killed).toBe(0)
  })

  it('stop() with no key stops every enabled session only', async () => {
    const t = setup()
    await t.on(A)
    t.svc.beginTurn(B, 'local')
    t.svc.stop(undefined, 'hotkey')
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.stoppedTurns).toEqual([A])
    expect(t.events).toContainEqual({ type: 'stopped', key: A, why: 'hotkey' })
    expect(t.notes).toEqual([{ key: A, text: '电脑操作已停止' }])
  })

  it('stop() with nothing enabled is a no-op', async () => {
    const t = setup()
    t.svc.stop(undefined, 'hotkey')
    expect(t.events).toEqual([])
    expect(t.stoppedTurns).toEqual([])
  })

  it('why-specific notes: vision and limit', async () => {
    const v = setup(); await v.on(A); v.svc.stop(A, 'vision')
    expect(v.notes).toEqual([{ key: A, text: '当前模型看不到截图 · 已关闭电脑操作' }])
    const l = setup(); await l.on(A); l.svc.stop(A, 'limit')
    expect(l.notes).toEqual([{ key: A, text: '本次开启已执行 2000 步 · 已关闭电脑操作' }])
  })

  it('the executor can stop its own session through internals', async () => {
    const t = setup({ run: async (s, key) => { s.stop(key, 'vision'); return { ok: false, code: 'vision_code', text: 'x' } } })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    expect(await t.svc.handle(tok, 'click', {}, {})).toMatchObject({ ok: false, code: 'stopped' })
    expect(t.svc.modeOf(A)).toBe('off')
  })
})

// ───────────────────────── lock (Review Focus 12, R16, V10) ─────────────────────────

describe('lock', () => {
  it('onLock turns every session off, denies gates, revokes tokens and notes 屏幕已锁定', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const [g] = await t.gate({ kind: 'action' })
    t.svc.onLock()
    expect(await g).toBe('stop')
    expect(t.svc.modeOf(A)).toBe('off')
    expect(t.svc.pendingGates()).toEqual([])
    expect(await t.svc.handle(tok, 'cursor', {}, {})).toMatchObject({ code: 'not_enabled' })
    expect(t.notes).toEqual([{ key: A, text: '屏幕已锁定 · 电脑操作已关闭' }])
    expect(t.events).toContainEqual({ type: 'stopped', key: A, why: 'lock' })
    expect(t.stoppedTurns).toEqual([A])
  })

  for (const [name, s] of [
    ['locked', { locked: true }], ['fast user switching (onConsole:false)', { onConsole: false }], ['asleep', { asleep: true }],
  ] as const) {
    it(`a ${name} screen refuses the call with locked, before the executor runs`, async () => {
      const t = setup()
      const tok = await t.on(A, 'allow')
      t.svc.beginTurn(A, 'local')
      t.driver.setStatus(s)
      expect(await t.svc.handle(tok, 'click', { x: 1, y: 1 }, {})).toMatchObject({ ok: false, code: 'locked' })
      expect(t.runs).toEqual([])
      expect(t.driver.posts).toEqual([])
    })
  }

  it('a status read that fails refuses with helper_failed', async () => {
    const t = setup()
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    t.driver.status = async () => { throw new Error('gone') }
    expect(await t.svc.handle(tok, 'click', {}, {})).toMatchObject({ ok: false, code: 'helper_failed' })
    expect(t.runs).toEqual([])
  })
})

// ───────────────────────── outlets (Review Focus 15) ─────────────────────────

describe('emit is the only outlet', () => {
  it('crop bytes and typed text reach emit and nothing else', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const t = setup()
    await t.on(A)
    t.svc.beginTurn(A, 'local')
    const [p] = await t.gate({ kind: 'action', action: { kind: 'type', text: 'SECRET-TEXT-MARK' }, crop: 'SECRET-CROP-MARK' })
    await t.svc.resolve(t.svc.pendingGates()[0].id, 'allow', LOCAL)
    await p
    t.svc.stop(A, 'user')
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toMatch(/SECRET-/)
    expect(JSON.stringify(t.notes)).not.toMatch(/SECRET-/)
    expect(JSON.stringify(t.saved)).not.toMatch(/SECRET-/)
    expect(JSON.stringify(t.events)).toMatch(/SECRET-CROP-MARK/)
  })

  it('modes live only in memory: a fresh service starts off, and service.ts never touches sessions.json', async () => {
    const t1 = setup()
    await t1.on(A, 'allow')
    const t2 = setup()
    expect(t2.svc.modeOf(A)).toBe('off')
    const src = readFileSync(join(__dirname, 'service.ts'), 'utf8')
    expect(src).not.toMatch(/sessions\.json|sessionStore|from '\.\.\/(chat|session)/)
  })

  it('emitAction forwards an action event for the key', async () => {
    const t = setup()
    await t.on(A)
    t.internals.emitAction(A, { ts: 1, turn: 1, op: 'click', result: 'auto' })
    expect(t.events.at(-1)).toEqual({ type: 'action', key: A, entry: { ts: 1, turn: 1, op: 'click', result: 'auto' } })
  })
})

// ───────────────────────── review fixes (I-1, I-2, I-4, M-1 … M-6) ─────────────────────────

const G = { denyPids: [4242], denyBundlePrefixes: [] }
const CLICK: PostAction = { kind: 'click', x: 1, y: 1, button: 'left', count: 1, mods: [] }

describe('I-1: the token file is short-lived', () => {
  it('the first call that arrives with the token deletes its mcp config file; a bad token deletes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-first-'))
    try {
      const t = setup({ configDir: dir })
      const tok = await t.on(A)
      const file = forgeMcpArgs({
        FORGE_SOCKET: join(dir, 'cu.sock'), FORGE_MCP_DIR: dir, FORGE_AGENT_ID: tok,
        FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: COMPUTER_TOOLS.join(','),
      })[1]
      expect(file).not.toContain(tok.slice(3))
      t.svc.beginTurn(A, 'local')
      await t.svc.handle('cu.WRONGWRONGWRONGW', 'cursor', {}, {})
      expect(existsSync(file)).toBe(true)
      expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
      expect(existsSync(file)).toBe(false)
      // the token itself keeps working
      expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('endTurn deletes the per-token mcp config again (Task 8, V16 ②)', () => {
  it('a later turn rewrites mcp.cu-<hash>.json; endTurn removes it and the token keeps working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-end-'))
    try {
      const t = setup({ configDir: dir })
      const tok = await t.on(A)
      const write = () => forgeMcpArgs({
        FORGE_SOCKET: join(dir, 'cu.sock'), FORGE_MCP_DIR: dir, FORGE_AGENT_ID: tok,
        FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: COMPUTER_TOOLS.join(','),
      })[1]
      write()
      t.svc.beginTurn(A, 'local')
      expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
      t.svc.endTurn(A)
      // turn 2: buildClaudeChatArgs writes the file again before spawning; whatever the calls do, endTurn leaves none
      const file = write()
      t.svc.beginTurn(A, 'local')
      expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
      write()
      expect(existsSync(file)).toBe(true)
      t.svc.endTurn(A)
      expect(existsSync(file)).toBe(false)
      expect(t.svc.tokenFor(A)).toBe(tok)
      t.svc.beginTurn(A, 'local')
      expect((await t.svc.handle(tok, 'cursor', {}, {})).ok).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('endTurn of a session that is off, or with no config dir, touches nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-end-'))
    try {
      const t = setup({ configDir: dir })
      t.svc.beginTurn(B, 'local')
      expect(() => t.svc.endTurn(B)).not.toThrow()
      const t2 = setup({ configDir: null })
      await t2.on(A)
      t2.svc.beginTurn(A, 'local')
      expect(() => t2.svc.endTurn(A)).not.toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('I-2: stop / lock / off during setMode\'s awaits win', () => {
  for (const [name, ev] of [
    ['lock', (t: ReturnType<typeof setup>) => t.svc.onLock()],
    ['stop (hotkey)', (t: ReturnType<typeof setup>) => t.svc.stop(undefined, 'hotkey')],
    ['stop (this key)', (t: ReturnType<typeof setup>) => t.svc.stop(A, 'user')],
    ['off', (t: ReturnType<typeof setup>) => t.svc.setMode(A, 'off', LOCAL)],
  ] as const) {
    it(`off→ask: ${name} while the probe is pending leaves it off`, async () => {
      const hold = deferred<void>()
      const t = setup({ probeHold: hold.promise })
      const r = t.svc.setMode(A, 'ask', LOCAL)
      await flush()
      await ev(t)
      hold.resolve()
      expect(await r).toEqual({ ok: false, code: 'stopped' })
      expect(t.svc.modeOf(A)).toBe('off')
      expect(t.svc.tokenFor(A)).toBeNull()
    })

    it(`ask→allow: ${name} while the physical check is pending leaves it off and mints nothing`, async () => {
      const t = setup({ phys: true, idle: { mouseDown: 0.1 } })
      await t.on(A, 'ask')
      const hold = deferred<number>()
      t.driver.idleSeconds = async () => hold.promise
      const r = t.svc.setMode(A, 'allow', LOCAL)
      await flush()
      await ev(t)
      hold.resolve(0.1)
      expect(await r).toEqual({ ok: false, code: 'stopped' })
      expect(t.svc.modeOf(A)).toBe('off')
      expect(t.svc.tokenFor(A)).toBeNull()
    })
  }
})

describe('I-4: every post re-checks the screen', () => {
  for (const [name, st] of [['locked', { locked: true }], ['onConsole:false', { onConsole: false }], ['asleep', { asleep: true }]] as const) {
    it(`a screen that became ${name} between the call's start and its post refuses with locked`, async () => {
      let res: PostResult | null = null
      const t = setup({
        run: async (s) => {
          t.driver.setStatus(st)
          res = await s.driver.post(CLICK, G)
          return { ok: true, text: 'x' }
        },
      })
      const tok = await t.on(A, 'allow')
      t.svc.beginTurn(A, 'local')
      await t.svc.handle(tok, 'click', {}, {})
      expect(res).toEqual({ ok: false, code: 'locked' })
      expect(t.driver.posts).toEqual([])
    })
  }

  it('a status read that throws inside post refuses with locked', async () => {
    let res: PostResult | null = null
    const t = setup({
      run: async (s) => {
        t.driver.status = async () => { throw new Error('gone') }
        res = await s.driver.post(CLICK, G)
        return { ok: true, text: 'x' }
      },
    })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(res).toEqual({ ok: false, code: 'locked' })
    expect(t.driver.posts).toEqual([])
  })

  it('a stop that lands while post awaits status still prevents the post', async () => {
    let res: PostResult | null = null
    const hold = deferred<void>()
    const t = setup({
      run: async (s) => {
        const real = t.driver.status
        let n = 0
        t.driver.status = async () => { if (n++ === 0) await hold.promise; return real() }
        res = await s.driver.post(CLICK, G)
        return { ok: true, text: 'x' }
      },
    })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'click', {}, {})
    await flush(30)
    t.svc.stop(A, 'user')
    hold.resolve()
    await call
    await flush(30)
    expect(res).toEqual({ ok: false, code: 'stopped' })
    expect(t.driver.posts).toEqual([])
  })
})

describe('M-1: in ask mode a post needs a matching one-shot approval ticket', () => {
  function asker(script: (s: ServiceInternals, key: CuSessionKey) => Promise<PostResult[]>) {
    let out: PostResult[] = []
    const t = setup({ run: async (s, key) => { out = await script(s, key); return { ok: true, text: 'x' } } })
    return { t, results: () => out }
  }
  const approve = async (t: ReturnType<typeof setup>) => {
    await flush(30)
    const g = t.svc.pendingGates()[0]
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
  }

  it('no approval → denied, no post', async () => {
    const { t, results } = asker(async (s) => [await s.driver.post(CLICK, G)])
    const tok = await t.on(A, 'ask')
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(results()).toEqual([{ ok: false, code: 'denied' }])
    expect(t.driver.posts).toEqual([])
  })

  it('an approved click posts once; the ticket is consumed', async () => {
    const { t, results } = asker(async (s, key) => {
      await s.openGate({ key, kind: 'action', action: { kind: 'click', button: 'left', count: 1, mods: [] } })
      return [await s.driver.post(CLICK, G), await s.driver.post(CLICK, G)]
    })
    const tok = await t.on(A, 'ask')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'click', {}, {})
    await approve(t)
    await call
    expect(results()).toEqual([{ ok: true }, { ok: false, code: 'denied' }])
    expect(t.driver.posts).toHaveLength(1)
  })

  it('a ticket for one action does not cover a different one', async () => {
    const { t, results } = asker(async (s, key) => {
      await s.openGate({ key, kind: 'action', action: { kind: 'type', text: 'hello' } })
      return [
        await s.driver.post(CLICK, G),
        await s.driver.post({ kind: 'type', text: 'rm -rf ~\n' }, G),
        await s.driver.post({ kind: 'click', x: 1, y: 1, button: 'right', count: 1, mods: [] }, G),
        await s.driver.post({ kind: 'type', text: 'hello' }, G),
      ]
    })
    const tok = await t.on(A, 'ask')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'type', {}, {})
    await approve(t)
    await call
    expect(results()).toEqual([
      { ok: false, code: 'denied' }, { ok: false, code: 'denied' }, { ok: false, code: 'denied' }, { ok: true },
    ])
    expect(t.driver.posts.map((p) => p.action.kind)).toEqual(['type'])
  })

  it('click mods / count / button and key repeat / mods must match the approved view', async () => {
    const { t, results } = asker(async (s, key) => {
      await s.openGate({ key, kind: 'action', action: { kind: 'click', button: 'left', count: 1, mods: [] } })
      const a = await s.driver.post({ ...CLICK, mods: ['cmd'] } as PostAction, G)
      const b = await s.driver.post({ ...CLICK, count: 2 } as PostAction, G)
      await s.openGate({ key, kind: 'action', action: { kind: 'key', combo: '⌘V', repeat: 1, mods: ['cmd'] } })
      const c = await s.driver.post({ kind: 'key', char: 'v', mods: ['cmd'], repeat: 5 }, G)
      const d = await s.driver.post({ kind: 'key', char: 'v', mods: ['cmd'], repeat: 1 }, G)
      return [a, b, c, d]
    })
    const tok = await t.on(A, 'ask')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'click', {}, {})
    await approve(t)
    await flush(30)
    await approve(t)
    await call
    expect(results()).toEqual([{ ok: false, code: 'denied' }, { ok: false, code: 'denied' }, { ok: false, code: 'denied' }, { ok: true }])
  })

  it('move needs no ticket in ask; a continue approval mints none; a leftover ticket dies with its call', async () => {
    const t = setup({
      run: async (s, key, op) => {
        if (op === 'click') {
          await s.openGate({ key, kind: 'action', action: { kind: 'click', button: 'left', count: 1, mods: [] } })
          return { ok: true, text: 'approved, never posted' }
        }
        if (op === 'key') {
          await s.openGate({ key, kind: 'continue', reason: '已执行 100 步' })
          const r = await s.driver.post({ kind: 'key', char: 'a', mods: [], repeat: 1 }, G)
          return { ok: r.ok, text: JSON.stringify(r) } as CuResult
        }
        const m = await s.driver.post({ kind: 'move', x: 1, y: 1 }, G)
        const c = await s.driver.post(CLICK, G)
        return { ok: true, text: JSON.stringify([m, c]) }
      },
    })
    const tok = await t.on(A, 'ask')
    t.svc.beginTurn(A, 'local')
    const c1 = t.svc.handle(tok, 'click', {}, {})
    await flush(30)
    await t.svc.resolve(t.svc.pendingGates()[0].id, 'allow', LOCAL)
    await c1
    expect((await t.svc.handle(tok, 'move', {}, {})).text).toBe(JSON.stringify([{ ok: true }, { ok: false, code: 'denied' }]))
    const c3 = t.svc.handle(tok, 'key', {}, {})
    await flush(30)
    await t.svc.resolve(t.svc.pendingGates()[0].id, 'allow', LOCAL)
    expect((await c3).text).toBe(JSON.stringify({ ok: false, code: 'denied' }))
  })

  it('allow mode posts without a ticket', async () => {
    const { t, results } = asker(async (s) => [await s.driver.post(CLICK, G)])
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(results()).toEqual([{ ok: true }])
  })

  it('M-6: post re-reads the mode — allow switched to ask mid-call now needs a ticket', async () => {
    let res: PostResult | null = null
    const t = setup({
      run: async (s) => {
        await t.svc.setMode(A, 'ask', LOCAL)
        res = await s.driver.post(CLICK, G)
        return { ok: true, text: 'x' }
      },
    })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(res).toEqual({ ok: false, code: 'denied' })
    expect(t.driver.posts).toEqual([])
  })
})

describe('M-2 … M-5', () => {
  function hangingPost(t: ReturnType<typeof setup>) {
    const posting = deferred<void>()
    const finish = deferred<PostResult>()
    const real = t.driver.post.bind(t.driver)
    t.driver.post = async (a, g) => { posting.resolve(); await real(a, g); return finish.promise }
    return { posting, finish }
  }

  it('M-2: endTurn aborts an in-flight post', async () => {
    const t = setup({ run: async (s) => { await s.driver.post({ ...CLICK, mods: ['alt'] } as PostAction, G); return { ok: true, text: 'x' } } })
    const h = hangingPost(t)
    t.driver.abort = async () => { t.driver.aborted++; return 'killed' }
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'click', {}, {})
    await h.posting.promise
    t.svc.endTurn(A)
    await flush(20)
    expect(t.driver.aborted).toBe(1)
    expect(t.driver.released).toEqual([{ mods: ['alt'], button: 'left' }])
    h.finish.resolve({ ok: false, code: 'stopped' })
    expect(await call).toMatchObject({ ok: false, code: 'no_turn' })
  })

  it('M-3: the executor\'s driver has no request; activate / release after a stop do not reach the helper', async () => {
    let actErr: unknown = null
    const t = setup({
      run: async (s, key) => {
        expect('request' in s.driver).toBe(false)
        s.stop(key, 'user')
        await s.driver.activate(99).catch((e) => { actErr = e })
        await s.driver.release({ mods: ['cmd'] })
        return { ok: true, text: 'x' }
      },
    })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(actErr).toMatchObject({ code: 'stopped' })
    expect(t.driver.activations).toEqual([])
    expect(t.driver.released).toEqual([])
  })

  it('M-4: a call whose session was stopped cannot open a gate', async () => {
    let dec: GateDecision | null = null
    const t = setup({ run: async (s, key) => { s.stop(key, 'user'); dec = await s.openGate({ key, kind: 'action' }); return { ok: true, text: 'x' } } })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    await t.svc.handle(tok, 'click', {}, {})
    expect(dec).toBe('deny')
    expect(t.events.some((e) => e.type === 'gate')).toBe(false)
  })

  it('M-5: release is attempted even when abort() rejects', async () => {
    const t = setup({ run: async (s) => { await s.driver.post({ kind: 'drag', from: { x: 0, y: 0 }, to: { x: 5, y: 5 }, button: 'left', mods: ['shift'] }, G); return { ok: true, text: 'x' } } })
    const h = hangingPost(t)
    t.driver.abort = async () => { throw new Error('signal failed') }
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const call = t.svc.handle(tok, 'drag', {}, {})
    await h.posting.promise
    t.svc.stop(A, 'user')
    await flush(20)
    expect(t.driver.released).toEqual([{ mods: ['shift'], button: 'left' }])
    h.finish.resolve({ ok: false, code: 'stopped' })
    await call
  })
})

// ───────────────────────── abandoned calls (Task 6 review item 2) ─────────────────────────

describe('a call its caller abandoned (meta.signal)', () => {
  const G = { denyPids: [4242], denyBundlePrefixes: [] }

  it('a queued call is dropped as stopped and never runs', async () => {
    const first = deferred<void>()
    const t = setup({ run: async (_s, _k, op) => { if (op === 'click') await first.promise; return { ok: true, text: op } } })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const ac = new AbortController()
    const p1 = t.svc.handle(tok, 'click', {}, {})
    const p2 = t.svc.handle(tok, 'move', {}, { signal: ac.signal })
    await flush()
    ac.abort()
    expect(await p2).toMatchObject({ ok: false, code: 'stopped' })
    first.resolve()
    expect(await p1).toEqual({ ok: true, text: 'click' })
    await flush()
    expect(t.runs.map((r) => r.op)).toEqual(['click'])
    expect(t.svc.modeOf(A)).toBe('allow')   // only that call, not the session
  })

  it('an already-aborted signal never runs', async () => {
    const t = setup()
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const ac = new AbortController(); ac.abort()
    expect(await t.svc.handle(tok, 'move', {}, { signal: ac.signal })).toMatchObject({ ok: false, code: 'stopped' })
    expect(t.runs).toEqual([])
  })

  it('a running call waiting at its gate: the gate is denied, nothing posts', async () => {
    let decision: GateDecision | null = null
    const t = setup({
      run: async (s, key) => {
        decision = await s.openGate({ key, kind: 'action', action: { kind: 'click' } })
        const r = await s.driver.post({ kind: 'move', x: 1, y: 1 }, G)
        return r.ok ? { ok: true, text: 'posted' } : { ok: false, code: 'stopped', text: 'x' }
      },
    })
    const tok = await t.on(A)
    t.svc.beginTurn(A, 'local')
    const ac = new AbortController()
    const p = t.svc.handle(tok, 'click', {}, { signal: ac.signal })
    await flush(30)
    expect(t.svc.pendingGates()).toHaveLength(1)
    ac.abort()
    expect(await p).toMatchObject({ ok: false, code: 'stopped' })
    await flush()
    expect(decision).toBe('deny')
    expect(t.svc.pendingGates()).toEqual([])
    expect(t.driver.posts).toEqual([])
  })

  it('a call already posting finishes (no abort, no release); its result is discarded', async () => {
    const posting = deferred<void>()
    const finish = deferred<PostResult>()
    const t = setup({
      run: async (s) => {
        const r = await s.driver.post({ kind: 'move', x: 1, y: 1 }, G)
        return r.ok ? { ok: true, text: 'posted' } : { ok: false, code: 'helper_failed', text: 'x' }
      },
    })
    const real = t.driver.post.bind(t.driver)
    t.driver.post = async (a, g) => { await real(a, g); posting.resolve(); return finish.promise }
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const ac = new AbortController()
    const p = t.svc.handle(tok, 'move', {}, { signal: ac.signal })
    await posting.promise
    ac.abort()
    finish.resolve({ ok: true })
    expect(await p).toMatchObject({ ok: false, code: 'stopped' })
    expect(t.driver.posts).toHaveLength(1)
    expect(t.driver.aborted).toBe(0)
    expect(t.driver.released).toEqual([])
  })
})

describe('the call queue is bounded', () => {
  it(`at most CU_QUEUE_MAX outstanding calls; the next is rate_limited at once and never runs`, async () => {
    const { CU_QUEUE_MAX } = await import('./service')
    const first = deferred<void>()
    const t = setup({ run: async (_s, _k, op) => { if (op === 'click') await first.promise; return { ok: true, text: op } } })
    const tok = await t.on(A, 'allow')
    t.svc.beginTurn(A, 'local')
    const ps = [t.svc.handle(tok, 'click', {}, {})]
    for (let i = 1; i < CU_QUEUE_MAX; i++) ps.push(t.svc.handle(tok, 'cursor', {}, {}))
    expect(await t.svc.handle(tok, 'move', {}, {})).toMatchObject({ ok: false, code: 'rate_limited' })
    first.resolve()
    for (const p of ps) expect((await p).ok).toBe(true)
    expect(t.runs.map((r) => r.op)).not.toContain('move')
    expect(CU_QUEUE_MAX).toBeGreaterThanOrEqual(3)
  })
})
