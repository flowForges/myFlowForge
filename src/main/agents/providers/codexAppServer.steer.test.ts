import { describe, it, expect, vi, afterEach } from 'vitest'
import { driveCodexTurn, codexThreadReaped, HANDSHAKE_TIMEOUT_MS, EXIT_WAIT_TERM_MS, EXIT_WAIT_KILL_MS, type CodexChild, type CodexTurnCallbacks } from './codexAppServer'

// Same scriptable fake as codexAppServer.test.ts: capture writes, push stdout lines, fire close/error.
// kill(sig) is recorded; by default the fake "exits" (fires close) on any signal, like a real child.
// ignoreTerm: only SIGKILL makes it exit; exitOnKill:false: never exits on its own (test fires close).
function fakeChild(o: { ignoreTerm?: boolean; exitOnKill?: boolean } = {}) {
  const signals: string[] = []
  let onData: ((c: Buffer) => void) | undefined
  let onErr: ((c: Buffer) => void) | undefined
  const listeners: Record<string, ((a?: unknown) => void) | undefined> = {}
  const writes: any[] = []
  const child: CodexChild = {
    stdin: { write: (s: string) => { for (const ln of s.split('\n')) if (ln.trim()) writes.push(JSON.parse(ln)) } },
    stdout: { on: (_e, cb) => { onData = cb } },
    stderr: { on: (_e, cb) => { onErr = cb } },
    on: (e, cb) => { listeners[e] = cb },
    kill: (sig?: NodeJS.Signals) => {
      signals.push(sig ?? 'SIGTERM')
      if (o.exitOnKill === false) return
      if (o.ignoreTerm && sig !== 'SIGKILL') return
      queueMicrotask(() => listeners.close?.())
    },
  }
  const push = (o: any) => onData?.(Buffer.from(JSON.stringify(o) + '\n'))
  return { child, writes, signals, push, stderr: (t: string) => onErr?.(Buffer.from(t)), close: () => listeners.close?.(), error: (e: unknown) => listeners.error?.(e) }
}

const OPTS = { cwd: '/ws', prompt: 'go', modelArgs: [], configArgs: [], sandbox: 'read-only', approvalPolicy: 'on-request' }
const cbs = (over: Partial<CodexTurnCallbacks> = {}): CodexTurnCallbacks =>
  ({ onEvent: () => {}, onApproval: async () => 'allow', onSession: () => {}, onError: () => {}, ...over })
const tick = () => new Promise(r => setTimeout(r, 0))

// handshake + thread/start, optionally ack turn/start with a turn id
function begin(f: ReturnType<typeof fakeChild>, turnId?: string) {
  f.push({ id: f.writes[0].id, result: {} })
  const start = f.writes.find(w => w.method === 'thread/start' || w.method === 'thread/resume')
  f.push({ id: start.id, result: { thread: { id: 'th1' } } })
  const turn = f.writes.find(w => w.method === 'turn/start')
  if (turnId) f.push({ id: turn.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } })
  return turn
}

describe('driveCodexTurn · turn/steer 插话', () => {
  it('turnId 拿到后 steer 发 turn/steer {threadId, expectedTurnId, input},成功即 true,这一轮继续流', async () => {
    const f = fakeChild()
    const events: any[] = []
    const started: string[] = []
    const h = driveCodexTurn(OPTS, cbs({ onEvent: e => events.push(e), onTurnStarted: id => started.push(id) }), { spawn: () => f.child })
    begin(f, 'turn-1')
    expect(started).toEqual(['turn-1'])
    const p = h.steer('再看一下 b.txt')
    const steer = f.writes.find(w => w.method === 'turn/steer')
    expect(steer.params).toEqual({ threadId: 'th1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '再看一下 b.txt' }] })
    f.push({ id: steer.id, result: { turnId: 'turn-1' } })
    await expect(p).resolves.toBe(true)
    f.push({ method: 'item/agentMessage/delta', params: { delta: 'more' } })
    expect(events.at(-1)).toEqual({ msg: { type: 'agent_message_delta', delta: 'more' } })
    f.push({ method: 'turn/completed', params: {} })
    await expect(h.done).resolves.toEqual({ ok: true })
  })

  it('turn/started 通知也能给出 turnId', async () => {
    const f = fakeChild()
    const started: string[] = []
    const h = driveCodexTurn(OPTS, cbs({ onTurnStarted: id => started.push(id) }), { spawn: () => f.child })
    begin(f)
    f.push({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'turn-9', status: 'inProgress', items: [] } } })
    expect(started).toEqual(['turn-9'])
    void h.steer('x')
    expect(f.writes.find(w => w.method === 'turn/steer').params.expectedTurnId).toBe('turn-9')
  })

  it('还没拿到 turnId → false,什么都不发', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f)
    await expect(h.steer('x')).resolves.toBe(false)
    expect(f.writes.some(w => w.method === 'turn/steer')).toBe(false)
  })

  it('expectedTurnId 不匹配 / 该轮已不在 → codex 回错误 → false', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    const p = h.steer('x')
    const steer = f.writes.find(w => w.method === 'turn/steer')
    f.push({ id: steer.id, error: { code: -32600, message: 'expected turn mismatch' } })
    await expect(p).resolves.toBe(false)
  })

  it('这一轮已完成 → false,什么都不发', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    f.push({ method: 'turn/completed', params: {} })
    await h.done
    const n = f.writes.length
    await expect(h.steer('x')).resolves.toBe(false)
    expect(f.writes.length).toBe(n)
  })

  it('★steer 还没回话时 turn/completed 先到:等它回话再收尾,不提前杀进程(否则插进去的话会被当成失败再发一次)', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    const p = h.steer('x')
    const steer = f.writes.find(w => w.method === 'turn/steer')
    f.push({ method: 'turn/completed', params: {} })
    let settled = false
    void h.done.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    f.push({ id: steer.id, result: { turnId: 'turn-1' } })
    await expect(p).resolves.toBe(true)
    await expect(h.done).resolves.toEqual({ ok: true })
  })

  it('进程中途没了:等着的 steer 得 false', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    const p = h.steer('x')
    f.close()
    await expect(p).resolves.toBe(false)
  })

  it('停止:turn/interrupt 带上 turnId(schema 必填)', async () => {
    const f = fakeChild()
    const h = driveCodexTurn(OPTS, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    h.cancel()
    expect(f.writes.find(w => w.method === 'turn/interrupt').params).toEqual({ threadId: 'th1', turnId: 'turn-1' })
    await expect(h.done).resolves.toEqual({ ok: false })
  })
})

describe('driveCodexTurn · 启动失败可回落(fallbackOnStartFailure)', () => {
  it('握手前进程就没了 → done 带 startFailed,不报 onError', async () => {
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    f.error(new Error('spawn ENOENT'))
    const r = await h.done
    expect(r.ok).toBe(false)
    expect(r.startFailed).toBe(true)
    expect(r.error).toContain('ENOENT')
    expect(errs).toEqual([])
  })

  it('initialize 回错 → startFailed', async () => {
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, error: { message: 'unknown subcommand app-server' } })
    const r = await h.done
    expect(r.startFailed).toBe(true)
    expect(errs).toEqual([])
  })

  it('这一轮已经开始后才失败 → 照常报错,不回落(不重跑已做的工作)', async () => {
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    begin(f, 'turn-1')
    f.push({ method: 'error', params: { error: { message: '400 bad model' } } })
    const r = await h.done
    expect(r).toEqual({ ok: false })
    expect(errs[0]).toContain('400')
  })

  it('用户在握手阶段就点了停止 → 不回落', async () => {
    const f = fakeChild()
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    h.cancel()
    expect((await h.done).startFailed).toBeUndefined()
  })
})

describe('driveCodexTurn · 与 exec 对齐的启动参数', () => {
  it('用传进来的 bin / cwd / env 起进程(FORGE_AGENT_ID 靠 env 传给 MCP 子进程)', () => {
    const f = fakeChild()
    const seen: any[] = []
    driveCodexTurn({ ...OPTS, bin: '/opt/codex', env: { FORGE_AGENT_ID: 'cu-1' } }, cbs(), {
      spawn: (cmd, args, o) => { seen.push({ cmd, args, o }); return f.child },
    })
    expect(seen[0].cmd).toBe('/opt/codex')
    expect(seen[0].args.at(-1)).toBe('app-server')
    expect(seen[0].o).toEqual({ cwd: '/ws', env: { FORGE_AGENT_ID: 'cu-1' } })
  })

  it('thread/resume 也带上权限档(sandbox / approvalPolicy / cwd):续接的每一轮都要按当前档跑', () => {
    const f = fakeChild()
    driveCodexTurn({ ...OPTS, sandbox: 'danger-full-access', approvalPolicy: 'never', resumeThreadId: 'th-old' }, cbs(), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })
    const resume = f.writes.find(w => w.method === 'thread/resume')
    expect(resume.params).toEqual({ threadId: 'th-old', approvalPolicy: 'never', sandbox: 'danger-full-access', cwd: '/ws' })
  })
})

describe('driveCodexTurn · 意外退出 / 握手超时', () => {
  afterEach(() => { vi.useRealTimers() })

  it('这一轮开始后进程意外退出:报错(带 stderr 尾巴),不是一条空回复', async () => {
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    begin(f, 'turn-1')
    f.stderr('thread panicked: out of memory\n')
    f.close()
    expect(await h.done).toEqual({ ok: false })
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('codex app-server 意外退出')
    expect(errs[0]).toContain('out of memory')
  })

  it('用户停止导致的退出不报错', async () => {
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn(OPTS, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    begin(f, 'turn-1')
    h.cancel(); f.close()
    await h.done
    expect(errs).toEqual([])
  })

  it('握手阶段退出:startFailed 的原因里带上 stderr', async () => {
    const f = fakeChild()
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    f.stderr("error: unrecognized subcommand 'app-server'\n")
    f.close()
    const r = await h.done
    expect(r.startFailed).toBe(true)
    expect(r.error).toContain('unrecognized subcommand')
  })

  it(`握手 ${HANDSHAKE_TIMEOUT_MS / 1000}s 没完成 → startFailed(回落 exec),不是取消`, async () => {
    vi.useFakeTimers()
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })   // initialize ok, thread/start never answered
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS - 1)
    let settled = false
    void h.done.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    const r = await h.done
    expect(r.startFailed).toBe(true)
    expect(r.error).toContain('超时')
    expect(errs).toEqual([])
  })

  it('握手按时完成:之后再久也不会因超时收尾', async () => {
    vi.useFakeTimers()
    const f = fakeChild()
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    begin(f, 'turn-1')
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 3)
    let settled = false
    void h.done.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.push({ method: 'turn/completed', params: {} })
    expect(await h.done).toEqual({ ok: true })
  })
})

describe('driveCodexTurn · 回落前等 app-server 真退出(R5)', () => {
  afterEach(() => { vi.useRealTimers() })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('turn/start 已发出、没回话时超时 → 报「启动超时」,不回落(否则 exec resume 和还活着的 app-server 抢同一个线程)', async () => {
    vi.useFakeTimers()
    const f = fakeChild()
    const errs: string[] = []
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs({ onError: m => errs.push(m) }), { spawn: () => f.child })
    begin(f)   // thread/start ok → turn/start sent, never acked
    expect(f.writes.some(w => w.method === 'turn/start')).toBe(true)
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)
    const r = await h.done
    expect(r).toEqual({ ok: false })
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('codex app-server 启动超时')
  })

  it('turn/start 之前超时 → startFailed,但要等假进程真的退出才交出去', async () => {
    vi.useFakeTimers()
    const f = fakeChild({ exitOnKill: false })
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, result: {} })   // initialize ok, thread/start never answered
    let settled = false
    void h.done.then(() => { settled = true })
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)
    await flush()
    expect(f.signals).toEqual(['SIGTERM'])
    expect(settled).toBe(false)
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS - 10)
    await flush()
    expect(settled).toBe(false)
    f.close()   // the child's exit event
    const r = await h.done
    expect(r.startFailed).toBe(true)
    expect(f.signals).toEqual(['SIGTERM'])
  })

  it('不理 SIGTERM 的进程:2s 后补 SIGKILL,退了才交出去', async () => {
    vi.useFakeTimers()
    const f = fakeChild({ ignoreTerm: true })
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, error: { message: 'boom' } })   // handshake error → startFailed path
    let settled = false
    void h.done.then(() => { settled = true })
    await flush()
    expect(f.signals).toEqual(['SIGTERM'])
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS - 1)
    await flush()
    expect(f.signals).toEqual(['SIGTERM'])
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    await flush()
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    const r = await h.done
    expect(r.startFailed).toBe(true)
  })

  it('SIGKILL 之后还不退:最多再等 1s 就交出去,不会永远挂住', async () => {
    vi.useFakeTimers()
    const f = fakeChild({ exitOnKill: false })
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    f.push({ id: f.writes[0].id, error: { message: 'boom' } })
    let settled = false
    void h.done.then(() => { settled = true })
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS)
    await flush()
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    vi.advanceTimersByTime(EXIT_WAIT_KILL_MS - 1)
    await flush()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    expect((await h.done).startFailed).toBe(true)
  })
})

describe('driveCodexTurn · 同一个线程不许两个 app-server 同时活着', () => {
  afterEach(() => { vi.useRealTimers() })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('在 App 中继续:codexThreadReaped 等这个线程上我方的 app-server 真退出;没有在回收的就立刻好', async () => {
    vi.useFakeTimers()
    let idle = false
    await codexThreadReaped('th-none').then(() => { idle = true })
    expect(idle).toBe(true)
    const f = fakeChild({ exitOnKill: false })
    const h = driveCodexTurn({ ...OPTS, resumeThreadId: 'th-hand' }, cbs(), { spawn: () => f.child })
    begin(f, 'tu1')
    h.cancel()
    await flush()
    expect(f.signals).toEqual(['SIGTERM'])
    let reaped = false
    void codexThreadReaped('th1').then(() => { reaped = true })
    await flush()
    expect(reaped).toBe(false)
    f.close()
    await flush()
    expect(reaped).toBe(true)
  })

  it('turn/start 已发出后超时(不回落):也要 SIGTERM → 2s → SIGKILL → 等退出,之后才交出 ok:false', async () => {
    vi.useFakeTimers()
    const f = fakeChild({ ignoreTerm: true })
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    begin(f)
    let settled = false
    void h.done.then(() => { settled = true })
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS)
    await flush()
    expect(f.signals).toEqual(['SIGTERM'])
    expect(settled).toBe(false)
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS)
    await flush()
    expect(f.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await h.done).toEqual({ ok: false })
  })

  it('不回落的超时、SIGKILL 后也不退:最多再等 1s 就交出去', async () => {
    vi.useFakeTimers()
    const f = fakeChild({ exitOnKill: false })
    const h = driveCodexTurn({ ...OPTS, fallbackOnStartFailure: true }, cbs(), { spawn: () => f.child })
    begin(f)
    let settled = false
    void h.done.then(() => { settled = true })
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + EXIT_WAIT_TERM_MS)
    await flush()
    vi.advanceTimersByTime(EXIT_WAIT_KILL_MS - 1)
    await flush()
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await h.done).toEqual({ ok: false })
  })

  it('上一轮正常结束但它的 app-server 还没退:下一轮续接同一个线程,要等它退出(必要时 SIGKILL)才起新的', async () => {
    vi.useFakeTimers()
    const f1 = fakeChild({ ignoreTerm: true })
    const h1 = driveCodexTurn({ ...OPTS }, cbs(), { spawn: () => f1.child })
    begin(f1, 'turn-1')
    f1.push({ method: 'turn/completed', params: {} })
    expect(await h1.done).toEqual({ ok: true })   // 这一轮照常立即收尾,不让界面等
    expect(f1.signals).toEqual(['SIGTERM'])
    const f2 = fakeChild()
    let spawned = 0
    const h2 = driveCodexTurn({ ...OPTS, resumeThreadId: 'th1' }, cbs(), { spawn: () => { spawned++; return f2.child } })
    await flush()
    expect(spawned).toBe(0)
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS - 1)
    await flush()
    expect(spawned).toBe(0)
    vi.advanceTimersByTime(1)
    await flush()
    expect(f1.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(spawned).toBe(1)
    expect(f2.writes[0].method).toBe('initialize')
    begin(f2, 'turn-2')
    f2.push({ method: 'turn/completed', params: {} })
    expect(await h2.done).toEqual({ ok: true })
  })

  it('上一轮的 app-server 已经退了:下一轮立即起,不等', async () => {
    const f1 = fakeChild()
    const h1 = driveCodexTurn({ ...OPTS }, cbs(), { spawn: () => f1.child })
    begin(f1, 'turn-1')
    f1.push({ method: 'turn/completed', params: {} })
    expect(await h1.done).toEqual({ ok: true })
    await flush()
    const f2 = fakeChild()
    let spawned = 0
    driveCodexTurn({ ...OPTS, resumeThreadId: 'th1' }, cbs(), { spawn: () => { spawned++; return f2.child } })
    await flush()
    expect(spawned).toBe(1)
  })

  it('别的线程不受影响:立即起', async () => {
    vi.useFakeTimers()
    const f1 = fakeChild({ exitOnKill: false })
    const h1 = driveCodexTurn({ ...OPTS }, cbs(), { spawn: () => f1.child })
    begin(f1, 'turn-1')
    f1.push({ method: 'turn/completed', params: {} })
    await h1.done
    let spawned = 0
    driveCodexTurn({ ...OPTS, resumeThreadId: 'th-other' }, cbs(), { spawn: () => { spawned++; return fakeChild().child } })
    expect(spawned).toBe(1)
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS)
    await flush()
    vi.advanceTimersByTime(EXIT_WAIT_KILL_MS)
    await flush()
  })

  it('等上一轮退出时这一轮被取消:不再起进程,done 交出 ok:false', async () => {
    vi.useFakeTimers()
    const f1 = fakeChild({ exitOnKill: false })
    const h1 = driveCodexTurn({ ...OPTS }, cbs(), { spawn: () => f1.child })
    begin(f1, 'turn-1')
    f1.push({ method: 'turn/completed', params: {} })
    await h1.done
    let spawned = 0
    const h2 = driveCodexTurn({ ...OPTS, resumeThreadId: 'th1' }, cbs(), { spawn: () => { spawned++; return fakeChild().child } })
    h2.cancel()
    expect(await h2.done).toEqual({ ok: false })
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS)
    await flush()
    vi.advanceTimersByTime(EXIT_WAIT_KILL_MS)
    await flush()
    expect(spawned).toBe(0)
  })

  it('等完上一轮再 spawn 时抛错:可回落 → done 带 startFailed(调用方退回 exec),不挂住', async () => {
    vi.useFakeTimers()
    const f1 = fakeChild({ exitOnKill: false })
    const h1 = driveCodexTurn({ ...OPTS }, cbs(), { spawn: () => f1.child })
    begin(f1, 'turn-1')
    f1.push({ method: 'turn/completed', params: {} })
    await h1.done
    const h2 = driveCodexTurn({ ...OPTS, resumeThreadId: 'th1', fallbackOnStartFailure: true }, cbs(), { spawn: () => { throw new Error('ENOENT') } })
    vi.advanceTimersByTime(EXIT_WAIT_TERM_MS)
    await flush()
    vi.advanceTimersByTime(EXIT_WAIT_KILL_MS)
    await flush()
    const r = await h2.done
    expect(r.startFailed).toBe(true)
    expect(r.error).toContain('ENOENT')
  })
})
