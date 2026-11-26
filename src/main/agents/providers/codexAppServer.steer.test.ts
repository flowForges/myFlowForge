import { describe, it, expect } from 'vitest'
import { driveCodexTurn, type CodexChild, type CodexTurnCallbacks } from './codexAppServer'

// Same scriptable fake as codexAppServer.test.ts: capture writes, push stdout lines, fire close/error.
function fakeChild() {
  let onData: ((c: Buffer) => void) | undefined
  const listeners: Record<string, ((a?: unknown) => void) | undefined> = {}
  const writes: any[] = []
  const child: CodexChild = {
    stdin: { write: (s: string) => { for (const ln of s.split('\n')) if (ln.trim()) writes.push(JSON.parse(ln)) } },
    stdout: { on: (_e, cb) => { onData = cb } },
    stderr: { on: () => {} },
    on: (e, cb) => { listeners[e] = cb },
    kill: () => {},
  }
  const push = (o: any) => onData?.(Buffer.from(JSON.stringify(o) + '\n'))
  return { child, writes, push, close: () => listeners.close?.(), error: (e: unknown) => listeners.error?.(e) }
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
