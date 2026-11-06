// 08 §4.1–4.3:session.list / state / events / rename 和内核的墓碑(markDeleted)
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import type { Plugin, PluginContext } from './pluginHost'
import type { Approvals } from './approvals'
import type { SessionCommands, TurnInbox } from '../lib/tools/types'
import { WorkerMethods, type KernelEvent, type WorkerResult } from '../protocol/index'
import { WIRE_CONTENT_MAX } from './wire'
import { NO_SANDBOX } from '../../test/sandboxStub'

let dir: string
let kernels: Kernel[] = []
let ctx: PluginContext
/** 测试设定:某会话还有几个活着的委派运行 */
const live = new Map<string, number>()
/** 插件方法实际收到的调用(默认分支的拒绝测试用) */
const handled: string[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mffai-srpc-'))
  live.clear()
  handled.length = 0
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
})

type Req = { sessionId: string; turnId: string; text: string; signal: AbortSignal; inbox: TurnInbox }

/**
 * `park N`:写 N 条进度、要一次审批、然后挂起直到被取消。`tool`:一条很长的 tool.ended,然后结束。其他:直接结束
 */
const parker: Plugin = {
  manifest: { id: 'parker', version: '0', kernel: '^0.1.0' },
  activate(c) {
    ctx = c
    c.services.provide('executors', {
      active: () => 0, pending: () => 0, take: () => [], wait: async () => {}, abandon: async () => {},
      liveFor: (sid: string) => live.get(sid) ?? 0,
    })
    for (const method of ['turn.changes', 'executor.cancel', 'session.delete'] as const) {
      c.rpc.register(method, async params => {
        handled.push(method)
        return method === 'turn.changes' ? { files: [] } : method === 'session.delete' ? { ok: true, redacted: 0, notes: [] } : { ok: true }
      })
    }
    c.events.on('session.prompt', async ({ sessionId, turnId, text, signal, inbox }: Req) => {
      if (text === 'linger') {
        // 终态写了,处理者还没回来:还在 activeBySession 里,但不算开着
        c.append({ type: 'turn.ended', sessionId, payload: { turnId } })
        await new Promise<void>(r => signal.addEventListener('abort', () => r(), { once: true }))
        return true
      }
      if (text === 'two approvals') {
        const approvals = c.services.get<Approvals>('approvals')!
        approvals.request({ sessionId, turnId, callId: 'mine', tool: 'shell', summary: 'a', signal }).catch(() => {})
        approvals.request({ sessionId, turnId: 'older-turn', callId: 'stale', tool: 'shell', summary: 'b', signal }).catch(() => {})
        while (!signal.aborted) await inbox.park()
        return true
      }
      const m = /^park (\d+)$/.exec(text)
      if (m) {
        c.append({ type: 'turn.started', sessionId, payload: { turnId } })
        for (let i = 0; i < Number(m[1]); i++) c.append({ type: 'executor.run.progress', sessionId, payload: { turnId, runId: 'r1', kind: 'text', text: `p${i}` } })
        const approvals = c.services.get<Approvals>('approvals')!
        approvals.request({ sessionId, turnId, callId: 'call1', tool: 'shell', summary: 'echo hi', signal }).catch(() => {})
        while (!signal.aborted) await inbox.park()
        return true
      }
      if (text === 'tool') c.append({ type: 'tool.ended', sessionId, payload: { turnId, callId: 'x', content: 'y'.repeat(WIRE_CONTENT_MAX + 10), isError: false } })
      c.append({ type: 'turn.ended', sessionId, payload: { turnId } })
      return true
    })
  },
}

async function boot(): Promise<Kernel> {
  const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [parker], secrets: { osBackend: false } })
  kernels.push(k)
  return k
}
const cmds = () => ctx.services.get<SessionCommands>('sessionCommands')!
const create = async (k: Kernel, extra: object = {}, commandId = `c-${Math.random()}`) => (await k.handle('session.create', { commandId, ...extra })) as { sessionId: string }
const prompt = (k: Kernel, sessionId: string, text: string, commandId = `p-${Math.random()}`) => k.handle('session.prompt', { commandId, sessionId, text }) as Promise<{ turnId: string }>
const codeOf = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: number }) => e.code)
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise(r => setTimeout(r, 5))
  expect(fn()).toBe(true)
}
const list = async (k: Kernel) => ((await k.handle('session.list', {})) as WorkerResult<'session.list'>).sessions
const state = (k: Kernel, sessionId: string, limit?: number) => k.handle('session.state', { sessionId, ...(limit && { limit }) }) as Promise<WorkerResult<'session.state'>>
const all = (k: Kernel, sid: string) => k.events.after(0).filter(e => e.sessionId === sid)

describe('session.list (08 §4.1)', () => {
  it('lists every live session with its options, open turn, pending approvals, narrowed mode and renamed title', async () => {
    const k = await boot()
    const a = await create(k, { title: '甲', model: { accountId: 'acc', modelId: 'm' }, toolset: 'patch' })
    const im = await create(k, { origin: 'im', audience: 'group', approvalMode: 'auto' })
    const plain = await create(k)
    cmds().narrowApproval(im.sessionId)
    await k.handle('session.rename', { commandId: 'rn', sessionId: plain.sessionId, title: '改过的' })
    const { turnId } = await prompt(k, a.sessionId, 'park 3')
    await waitFor(() => all(k, a.sessionId).some(e => e.type === 'approval.requested'))
    const rows = await list(k)
    expect(WorkerMethods['session.list'].result.safeParse({ sessions: rows }).success).toBe(true)
    const byId = new Map(rows.map(r => [r.id, r]))
    expect(byId.get(a.sessionId)).toMatchObject({ title: '甲', origin: 'app', audience: 'owner', approvalMode: 'ask', toolset: 'patch', model: { accountId: 'acc', modelId: 'm' }, open: { turnId, parked: true }, pendingApprovals: 1 })
    expect(byId.get(im.sessionId)).toMatchObject({ title: '新会话', origin: 'im', audience: 'group', approvalMode: 'ask', pendingApprovals: 0 })
    expect(byId.get(im.sessionId)).not.toHaveProperty('open')
    expect(byId.get(plain.sessionId)!.title).toBe('改过的')
    const created = all(k, a.sessionId)[0]
    expect(byId.get(a.sessionId)!.createdAt).toBe(created.ts)
    expect(byId.get(a.sessionId)!.updatedAt).toBeGreaterThanOrEqual(created.ts)
    // 最近有动静的在前
    expect(rows[0].id).toBe(a.sessionId)
  })

  it('answers while draining: it only reads', async () => {
    const k = await boot()
    await create(k)
    void k.drain(10)
    expect(await list(k)).toHaveLength(1)
  })
})

describe('session.state / session.events (08 §4.2, Review Focus 3)', () => {
  it('a turn parked after 2500 progress events: limit 300 still starts at its message.user and carries the pending approval', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await prompt(k, sessionId, 'quick')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'turn.ended'))
    const { turnId } = await prompt(k, sessionId, 'park 2500')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'approval.requested'))
    const s = await state(k, sessionId, 300)
    expect(WorkerMethods['session.state'].result.safeParse(s).success).toBe(true)
    const first = s.events[0]
    expect(first.type).toBe('message.user')
    expect((first.payload as { turnId: string }).turnId).toBe(turnId)
    const req = s.events.find(e => e.type === 'approval.requested')!
    expect(req).toBeDefined()
    const approvalId = (req.payload as { approvalId: string }).approvalId
    expect(s.open).toEqual({ turnId, parked: true, approvalIds: [approvalId] })
    expect(s.session.open).toEqual({ turnId, parked: true })
    expect(s.session.pendingApprovals).toBe(1)
    expect(s.hasMore).toBe(true)
    expect(s.lastSeq).toBe(k.events.lastSeq())
    expect(s.events.at(-1)!.seq).toBe(all(k, sessionId).at(-1)!.seq)

    // 往回翻:没有缺口、没有重复
    const seqs = s.events.map(e => e.seq)
    let before = seqs[0]
    let more = s.hasMore
    while (more) {
      const page = (await k.handle('session.events', { sessionId, beforeSeq: before, limit: 2 })) as WorkerResult<'session.events'>
      expect(WorkerMethods['session.events'].result.safeParse(page).success).toBe(true)
      seqs.unshift(...page.events.map(e => e.seq))
      before = page.events[0]?.seq ?? before
      more = page.hasMore
    }
    expect(seqs).toEqual(all(k, sessionId).map(e => e.seq))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('without an open turn the page is the newest limit events; events are the wire view', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await prompt(k, sessionId, 'tool')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'turn.ended'))
    const s = await state(k, sessionId, 2)
    expect(s.events.map(e => e.type)).toEqual(['tool.ended', 'turn.ended'])
    expect(s.open).toBeUndefined()
    expect(s.hasMore).toBe(true)
    const tool = s.events[0].payload as { content: string; truncated?: boolean }
    expect(tool.truncated).toBe(true)
    expect(tool.content.length).toBe(WIRE_CONTENT_MAX)
    const dflt = await state(k, sessionId)
    expect(dflt.events.map(e => e.type)).toEqual(all(k, sessionId).map(e => e.type))
    expect(dflt.hasMore).toBe(false)
  })

  it('an open turn longer than 5000 events is cut at the newest 5000, with hasMore', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await prompt(k, sessionId, 'park 5100')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'approval.requested'))
    const s = await state(k, sessionId, 10)
    expect(s.events).toHaveLength(5000)
    expect(s.hasMore).toBe(true)
    expect(s.events.at(-1)!.seq).toBe(all(k, sessionId).at(-1)!.seq)
  })

  it('unknown or deleted sessions answer -32602 unknown session', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    expect(await codeOf(state(k, 'nope'))).toBe(-32602)
    expect(await codeOf(k.handle('session.events', { sessionId: 'nope', beforeSeq: 10, limit: 5 }))).toBe(-32602)
    cmds().markDeleted(sessionId)
    await expect(state(k, sessionId)).rejects.toMatchObject({ code: -32602, message: 'unknown session' })
    expect(await codeOf(k.handle('session.events', { sessionId, beforeSeq: 10, limit: 5 }))).toBe(-32602)
  })
})

describe('session.rename (08 §4.3)', () => {
  it('strips C0, C1 and bidi controls and trims; 1..120 after that', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    const rn = (title: string, commandId = `r-${Math.random()}`) => k.handle('session.rename', { commandId, sessionId, title })
    expect(await rn('  ‮ab\u0007c\u0085⁦d‏ ')).toEqual({ ok: true })
    const ev = all(k, sessionId).filter(e => e.type === 'session.renamed')
    expect(ev.map(e => e.payload)).toEqual([{ title: 'abcd' }])
    expect((await list(k))[0].title).toBe('abcd')
    for (const bad of ['', '   ', '‮‬\u0000', 'x'.repeat(121)]) expect(await codeOf(rn(bad))).toBe(-32602)
    expect(await rn('字'.repeat(120))).toEqual({ ok: true })
    expect(all(k, sessionId).filter(e => e.type === 'session.renamed')).toHaveLength(2)
  })

  it('replays its receipt; unknown and deleted sessions are refused', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await k.handle('session.rename', { commandId: 'same', sessionId, title: 'one' })
    expect(await k.handle('session.rename', { commandId: 'same', sessionId, title: 'two' })).toEqual({ ok: true })
    expect(all(k, sessionId).filter(e => e.type === 'session.renamed').map(e => e.payload)).toEqual([{ title: 'one' }])
    expect(await codeOf(k.handle('session.rename', { commandId: 'u', sessionId: 'nope', title: 'x' }))).toBe(-32602)
    cmds().markDeleted(sessionId)
    expect(await codeOf(k.handle('session.rename', { commandId: 'd', sessionId, title: 'x' }))).toBe(-32602)
  })
})

describe('sessionCommands.markDeleted (08 §4.3, R3)', () => {
  it('busy with an open turn: -32003 and nothing written', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await prompt(k, sessionId, 'park 1')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'approval.requested'))
    const n = k.events.lastSeq()
    expect(() => cmds().markDeleted(sessionId)).toThrow(expect.objectContaining({ code: -32003 }))
    expect(k.events.lastSeq()).toBe(n)
  })

  it('busy with a live delegated run: -32003', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    live.set(sessionId, 1)
    expect(() => cmds().markDeleted(sessionId)).toThrow(expect.objectContaining({ code: -32003 }))
    expect(all(k, sessionId).map(e => e.type)).toEqual(['session.created'])
    live.set(sessionId, 0)
    cmds().markDeleted(sessionId)
    expect(all(k, sessionId).map(e => e.type)).toEqual(['session.created', 'session.deleted'])
  })

  it('writes one session.deleted; a second call is a no-op; an unknown session is -32602', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    cmds().markDeleted(sessionId)
    cmds().markDeleted(sessionId)
    expect(all(k, sessionId).filter(e => e.type === 'session.deleted').map(e => e.payload)).toEqual([{}])
    expect(() => cmds().markDeleted('nope')).toThrow(expect.objectContaining({ code: -32602 }))
  })

  it('a deleted session is gone from list and snapshot, and prompt / cancel to it are unknown session; a never-created id keeps today\'s behaviour', async () => {
    const k = await boot()
    const keep = await create(k)
    const { sessionId } = await create(k)
    cmds().markDeleted(sessionId)
    expect((await list(k)).map(s => s.id)).toEqual([keep.sessionId])
    expect(k.snapshot().sessions.map(s => s.id)).toEqual([keep.sessionId])
    await expect(prompt(k, sessionId, 'hi')).rejects.toMatchObject({ code: -32602, message: 'unknown session' })
    expect(await codeOf(k.handle('session.cancel', { commandId: 'x', sessionId }))).toBe(-32602)
    expect(await codeOf(prompt(k, 'never-made', 'quick'))).toBe('resolved')
    expect(await codeOf(k.handle('session.cancel', { commandId: 'y', sessionId: 'never-made' }))).toBe('resolved')
    // 重启之后同样
    await k.close()
    kernels = []
    const k2 = await boot()
    expect((await list(k2)).map(s => s.id)).toEqual([keep.sessionId])
    expect(await codeOf(prompt(k2, sessionId, 'hi'))).toBe(-32602)
  })

  it('removes <data>/sessions/<id> on the tombstone, and the startup sweep removes what came back', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    const other = await create(k)
    const sdir = join(dir, 'sessions', sessionId)
    const odir = join(dir, 'sessions', other.sessionId)
    for (const d of [sdir, odir]) {
      mkdirSync(join(d, 'spill'), { recursive: true })
      writeFileSync(join(d, 'spill', 'out.txt'), 'x')
    }
    cmds().markDeleted(sessionId)
    expect(existsSync(sdir)).toBe(false)
    expect(existsSync(odir)).toBe(true)
    await k.close()
    kernels = []
    mkdirSync(join(sdir, 'spill'), { recursive: true }) // 崩在中途留下的
    await boot()
    expect(existsSync(sdir)).toBe(false)
    expect(existsSync(join(odir, 'spill', 'out.txt'))).toBe(true)
  })

  it('an id that fails SAFE_ID leaves the filesystem untouched', async () => {
    const k = await boot()
    writeFileSync(join(dir, 'canary'), 'x')
    mkdirSync(join(dir, 'sessions', 'keep'), { recursive: true })
    for (const id of ['..', '../sessions', 'a/b']) {
      ctx.append({ type: 'session.created', sessionId: id, payload: {} })
      cmds().markDeleted(id)
      expect(all(k, id).map(e => e.type)).toEqual(['session.created', 'session.deleted'])
    }
    expect(existsSync(join(dir, 'canary'))).toBe(true)
    expect(readdirSync(join(dir, 'sessions'))).toEqual(['keep'])
    await k.close()
    kernels = []
    await boot() // 启动时的清扫同样跳过
    expect(existsSync(join(dir, 'canary'))).toBe(true)
    expect(existsSync(join(dir, 'sessions', 'keep'))).toBe(true)
  })
})

describe('Turn.firstSeq (R8)', () => {
  it('session.state pages back to the message.user that started the open turn, not a follow-up', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    const { turnId } = await prompt(k, sessionId, 'park 400')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'approval.requested'))
    const follow = (await prompt(k, sessionId, 'more')) as { followUp?: boolean }
    expect(follow.followUp).toBe(true)
    const s = await state(k, sessionId, 5)
    const users = s.events.filter((e: KernelEvent) => e.type === 'message.user')
    expect(users).toHaveLength(2)
    expect(s.events[0]).toBe(s.events.find(e => e.type === 'message.user'))
    expect((s.events[0].payload as { turnId: string; followUp?: boolean })).toEqual({ turnId, text: 'park 400' })
  })
})

describe('review fixes', () => {
  it('open.approvalIds lists only this turn\'s approvals; pendingApprovals counts the session\'s', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    const { turnId } = await prompt(k, sessionId, 'two approvals')
    await waitFor(() => all(k, sessionId).filter(e => e.type === 'approval.requested').length === 2)
    const mine = all(k, sessionId).find(e => e.type === 'approval.requested' && (e.payload as { callId: string }).callId === 'mine')!
    const s = await state(k, sessionId)
    expect(s.open).toEqual({ turnId, parked: true, approvalIds: [(mine.payload as { approvalId: string }).approvalId] })
    expect(s.session.pendingApprovals).toBe(2)
  })

  it('a turn that wrote its terminal event is not open, even while its handler is still running', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    await prompt(k, sessionId, 'linger')
    await waitFor(() => all(k, sessionId).some(e => e.type === 'turn.ended'))
    expect((await list(k))[0]).not.toHaveProperty('open')
    expect((await state(k, sessionId)).open).toBeUndefined()
  })

  it('plugin methods with a deleted sessionId are refused before the handler runs; session.delete still gets through to finish its work', async () => {
    const k = await boot()
    const { sessionId } = await create(k)
    cmds().markDeleted(sessionId)
    await expect(k.handle('turn.changes', { sessionId, turnId: 't' })).rejects.toMatchObject({ code: -32602, message: 'unknown session' })
    expect(await codeOf(k.handle('executor.cancel', { commandId: 'xc', sessionId, runId: 'r' }))).toBe(-32602)
    expect(handled).toEqual([])
    expect(await k.handle('session.delete', { commandId: 'del', sessionId })).toEqual({ ok: true, redacted: 0, notes: [] })
    // 没建过的 id 照旧交给插件
    expect(await k.handle('turn.changes', { sessionId: 'never-made', turnId: 't' })).toEqual({ files: [] })
    expect(handled).toEqual(['session.delete', 'turn.changes'])
  })

  it('session.create titles are cleaned like renames and cut to 120; nothing left means no title', async () => {
    const k = await boot()
    const a = await create(k, { title: ' \u202Eab\u2028c\u2029\u200Bd\u200C\u200De\uFEFF\u0007 ' })
    const b = await create(k, { title: '字'.repeat(130) })
    const c = await create(k, { title: '\u200B\uFEFF' })
    const payload = (sid: string) => all(k, sid)[0].payload as { title?: string }
    expect(payload(a.sessionId).title).toBe('abcde')
    expect(payload(b.sessionId).title).toBe('字'.repeat(120))
    expect(payload(c.sessionId)).not.toHaveProperty('title')
    const titles = new Map((await list(k)).map(r => [r.id, r.title]))
    expect(titles.get(c.sessionId)).toBe('新会话')
    expect(await codeOf(create(k, { title: 'x'.repeat(4097) }))).toBe(-32602)
    await k.handle('session.rename', { commandId: 'r', sessionId: a.sessionId, title: 'x\u2028y\uFEFF\u200D' })
    expect(titles.size).toBe(3)
    expect((await list(k)).find(r => r.id === a.sessionId)!.title).toBe('xy')
  })
})

