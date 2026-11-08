import { describe, it, expect, beforeEach } from 'vitest'
import type { KernelEvent } from '@mffai/protocol'
import { emptyView, fromState, reduce, rollbackable, type SessionView } from './reduce'
import { ev, resetSeq } from '../test/events'
import { summary } from '../test/sessions'

const S = 's1'
const e = (type: Parameters<typeof ev>[0], payload: unknown, seq?: number) => ev(type, payload, { sessionId: S, ...(seq !== undefined && { seq }) })
const fold = (events: KernelEvent[], v: SessionView = emptyView()) => events.reduce(reduce, v)
const turn = (v: SessionView, id = 't1') => v.turns.find((t) => t.turnId === id)!
const user = (turnId = 't1', text = 'hi', extra: object = {}) => e('message.user', { turnId, text, ...extra })
const ended = (turnId = 't1') => e('turn.ended', { turnId })
const run = (runId: string, turnId = 't1') => ({ runId, turnId })

beforeEach(() => resetSeq())

type Row = { name: string; events: () => KernelEvent[]; check: (v: SessionView) => void }

const ROWS: Row[] = [
  {
    name: 'message.user opens a turn with one user line',
    events: () => [user('t1', 'hello')],
    check: (v) => {
      expect(v.turns.map((t) => t.turnId)).toEqual(['t1'])
      expect(turn(v).users).toEqual([{ text: 'hello', followUp: false, external: false, seq: 1, ts: 1_700_000_000_001 }])
      expect(v.open).toEqual({ turnId: 't1', parked: false })
    },
  },
  {
    name: 'a followUp message is its own line in the same turn; external is kept',
    events: () => [user('t1', 'a'), e('turn.parked', { turnId: 't1', step: 1, active: 1, pending: 0 }), user('t1', 'b', { followUp: true, external: true })],
    check: (v) => {
      expect(turn(v).users.map((u) => [u.text, u.followUp, u.external])).toEqual([['a', false, false], ['b', true, true]])
      expect(v.open).toEqual({ turnId: 't1', parked: true })
    },
  },
  {
    name: 'deltas build the step text until the final replaces it; later deltas are ignored',
    events: () => [
      user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'He' }), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'llo' }),
    ],
    check: (v) => expect(turn(v).steps).toEqual([expect.objectContaining({ key: 't1:1', text: 'Hello', final: false, reasoning: '', tools: [] })]),
  },
  {
    name: 'message.assistant is the final text of its step',
    events: () => [
      user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'draft' }), e('message.assistant', { turnId: 't1', step: 1, text: 'Final' }),
      e('message.assistant.delta', { turnId: 't1', step: 1, text: 'late' }),
    ],
    check: (v) => expect(turn(v).steps.map((s) => [s.text, s.final])).toEqual([['Final', true]]),
  },
  {
    name: 'steps are keyed by turnId + step; loop-direct (no step) by turnId',
    events: () => [
      user(), e('message.assistant', { turnId: 't1', step: 1, text: 'one' }), e('message.assistant', { turnId: 't1', step: 2, text: 'two' }),
      user('t2'), e('message.assistant.delta', { turnId: 't2', text: 'x' }), e('message.assistant', { turnId: 't2', text: 'direct' }),
    ],
    check: (v) => {
      expect(turn(v).steps.map((s) => [s.key, s.text])).toEqual([['t1:1', 'one'], ['t1:2', 'two']])
      expect(turn(v, 't2').steps.map((s) => [s.key, s.text])).toEqual([['t2:', 'direct']])
    },
  },
  {
    name: 'reasoning deltas go to the step reasoning',
    events: () => [user(), e('message.reasoning.delta', { turnId: 't1', step: 1, text: 'think ' }), e('message.reasoning.delta', { turnId: 't1', step: 1, text: 'more' })],
    check: (v) => expect(turn(v).steps[0].reasoning).toBe('think more'),
  },
  {
    name: 'tool start/end attach to the latest step; output inline, truncated kept, failure is error',
    events: () => [
      user(), e('message.assistant', { turnId: 't1', step: 1, text: 'look' }),
      e('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: 'a.ts' }),
      e('tool.started', { turnId: 't1', callId: 'c2', name: 'shell', argsPreview: 'ls' }),
      e('tool.ended', { turnId: 't1', callId: 'c1', name: 'read', ok: true, ms: 3, content: 'body', truncated: true }),
      e('tool.ended', { turnId: 't1', callId: 'c2', name: 'shell', ok: false, ms: 3, content: 'boom', isError: true }),
    ],
    check: (v) => {
      const tools = turn(v).steps[0].tools
      expect(tools.map((t) => [t.id, t.title, t.status, t.output, t.truncated ?? false])).toEqual([
        ['c1', 'read a.ts', 'ok', 'body', true],
        ['c2', 'shell ls', 'error', 'boom', false],
      ])
      expect(tools.some((t) => 'outputOmitted' in t)).toBe(false)
    },
  },
  {
    name: 'a running tool has status run and no output',
    events: () => [user(), e('message.assistant', { turnId: 't1', step: 1, text: '' }), e('tool.started', { turnId: 't1', callId: 'c1', name: 'read', argsPreview: '' })],
    check: (v) => expect(turn(v).steps[0].tools).toEqual([expect.objectContaining({ id: 'c1', title: 'read', status: 'run' })]),
  },
  {
    name: 'parked then resumed',
    events: () => [user(), e('turn.parked', { turnId: 't1', step: 1, active: 2, pending: 1 }), e('turn.resumed', { turnId: 't1', step: 1, cause: 'notice' })],
    check: (v) => expect(v.open).toEqual({ turnId: 't1', parked: false }),
  },
  {
    name: 'turn.ended closes the turn',
    events: () => [user(), ended()],
    check: (v) => {
      expect(v.open).toBeUndefined()
      expect(turn(v).terminal).toEqual({ type: 'turn.ended' })
    },
  },
  {
    name: 'turn.failed keeps the reason',
    events: () => [user(), e('turn.failed', { turnId: 't1', reason: 'cancelled', message: 'x' })],
    check: (v) => {
      expect(v.open).toBeUndefined()
      expect(turn(v).terminal).toEqual({ type: 'turn.failed', reason: 'cancelled' })
    },
  },
  {
    name: 'approval requested then resolved with via',
    events: () => [
      user(), e('approval.requested', { approvalId: 'p1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'rm -rf x', key: 'shell:rm', unsandboxed: true }),
      e('approval.requested', { approvalId: 'p2', turnId: 't1', callId: 'c2', tool: 'shell', summary: 'ls' }),
      e('approval.resolved', { approvalId: 'p1', decision: 'allow', by: 'user', via: 'telegram:7' }),
    ],
    check: (v) => {
      const [a, b] = turn(v).approvals
      expect(a).toMatchObject({ approvalId: 'p1', tool: 'shell', summary: 'rm -rf x', key: 'shell:rm', unsandboxed: true, resolved: { decision: 'allow', by: 'user', via: 'telegram:7' } })
      expect(b).toMatchObject({ approvalId: 'p2', summary: 'ls' })
      expect(b.resolved).toBeUndefined()
      expect(b.key).toBeUndefined()
    },
  },
  {
    name: 'run queued -> started -> progress -> ended with dropped and truncated lists',
    events: () => [
      user(),
      e('executor.run.queued', { ...run('r1'), callId: 'c1', executor: 'codex', summary: 'fix it', readOnly: false, isolation: 'wrapped', position: 2 }),
      e('executor.run.started', { ...run('r1'), executor: 'codex', cwd: '/repo', isolation: 'wrapped', worktree: '/wt/r1', untranslatedRules: 3 }),
      e('executor.run.progress', { ...run('r1'), kind: 'tool', text: 'ran ls' }),
      e('executor.run.progress', { ...run('r1'), kind: 'file', text: 'a.ts' }),
      e('executor.run.ended', {
        ...run('r1'), executor: 'codex', status: 'ok', ms: 1200, exit: 0, usage: { input: 10, output: 20 },
        changed: { files: ['a.ts'], source: 'git', filesTruncated: 4 }, violations: ['net'], violationsTruncated: 2, rawLog: '/raw/r1.log', droppedProgress: 7, worktree: '/wt/r1',
      }),
    ],
    check: (v) => {
      const r = turn(v).runs.get('r1')!
      expect(r).toMatchObject({ runId: 'r1', executor: 'codex', phase: 'ended', position: 2, readOnly: false, isolation: 'wrapped', cwd: '/repo', worktree: '/wt/r1', untranslatedRules: 3, summary: 'fix it' })
      expect(r.progress.map((p) => [p.kind, p.text])).toEqual([['tool', 'ran ls'], ['file', 'a.ts']])
      expect(r.ended).toMatchObject({ status: 'ok', droppedProgress: 7, violationsTruncated: 2, changed: { filesTruncated: 4 } })
    },
  },
  {
    name: 'queued and running phases',
    events: () => [
      user(),
      e('executor.run.queued', { ...run('q'), callId: 'c', executor: 'claude', summary: 's', readOnly: true, isolation: 'own', position: 1 }),
      e('executor.run.queued', { ...run('r'), callId: 'c', executor: 'claude', summary: 's', readOnly: true, isolation: 'own', position: 1 }),
      e('executor.run.started', { ...run('r'), executor: 'claude', cwd: '/c', isolation: 'own' }),
    ],
    check: (v) => expect([...turn(v).runs.values()].map((r) => [r.runId, r.phase])).toEqual([['q', 'queued'], ['r', 'running']]),
  },
  {
    name: 'executor.worktree.merged marks the run merged',
    events: () => [
      user(), e('executor.run.started', { ...run('r1'), executor: 'codex', cwd: '/c', isolation: 'own', worktree: '/w' }), ended(),
      e('executor.worktree.merged', { runId: 'r1', files: 3 }),
    ],
    check: (v) => expect(turn(v).runs.get('r1')!.merged).toEqual({ files: 3 }),
  },
  {
    name: 'snapshot start and end refs with changed',
    events: () => [user(), e('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'refs/a' }), e('turn.snapshot', { turnId: 't1', phase: 'end', ref: 'refs/b', changed: 4 })],
    check: (v) => expect(turn(v).snapshot).toEqual({ start: 'refs/a', end: 'refs/b', changed: 4 }),
  },
  {
    name: 'a snapshot that was not taken keeps its reason',
    events: () => [user(), e('turn.snapshot', { turnId: 't1', phase: 'start', reason: 'unsafe_filter' })],
    check: (v) => expect(turn(v).snapshot).toEqual({ reason: 'unsafe_filter' }),
  },
  {
    name: 'rolledBack with skipped',
    events: () => [user(), ended(), e('turn.rolledBack', { turnId: 't1', files: 2, skipped: ['sub'] })],
    check: (v) => expect(turn(v).rolledBack).toEqual({ files: 2, skipped: ['sub'] }),
  },
  {
    name: 'memory.injected items of both kinds, deduped; truncated kept',
    events: () => [
      user(), e('memory.injected', { turnId: 't1', kind: 'session', text: 'x', items: ['n_a', 'n_b'] }),
      e('memory.injected', { turnId: 't1', kind: 'turn', text: 'y', items: ['n_b', 'r_1'], truncated: true }),
    ],
    check: (v) => expect(turn(v).injected).toEqual({ items: ['n_a', 'n_b', 'r_1'], truncated: true }),
  },
  {
    name: 'plugins.injected',
    events: () => [user(), e('plugins.injected', { turnId: 't1', text: 'idx', skill: true, mcp: false })],
    check: (v) => expect(turn(v).plugins).toBe(true),
  },
  {
    name: 'context.rebuilt',
    events: () => [user(), e('context.rebuilt', { turnId: 't1', step: 2, checkpointSeq: 1, throughSeq: 1, before: 9000, after: 3000 })],
    check: (v) => expect(turn(v).rebuilt).toEqual([{ turnId: 't1', step: 2, checkpointSeq: 1, throughSeq: 1, before: 9000, after: 3000 }]),
  },
  {
    name: 'sandbox.netDenied lands on the latest turn',
    events: () => [user('t1'), ended('t1'), user('t2'), e('sandbox.netDenied', { host: 'evil.example', port: 443, reason: 'not_allowed' })],
    check: (v) => {
      expect(turn(v, 't1').netDenied).toEqual([])
      expect(turn(v, 't2').netDenied).toEqual(['evil.example:443'])
    },
  },
  {
    name: 'session.approvalNarrowed',
    events: () => [user(), e('session.approvalNarrowed', { approvalMode: 'ask' })],
    check: (v) => {
      expect(v.narrowed).toBe(true)
      expect(turn(v).narrowed).toBe(true)
    },
  },
  {
    name: 'turn.usage adds up over steps',
    events: () => [user(), e('turn.usage', { turnId: 't1', step: 1, input: 10, output: 2, cacheRead: 5 }), e('turn.usage', { turnId: 't1', step: 2, input: 1, output: 1 })],
    check: (v) => expect(turn(v).usage).toEqual({ turnId: 't1', input: 11, output: 3, cacheRead: 5 }),
  },
  {
    name: 'turns are ordered by first event; seqs tracked',
    events: () => [user('t1'), ended('t1'), user('t2')],
    check: (v) => {
      expect(v.turns.map((t) => t.turnId)).toEqual(['t1', 't2'])
      expect([v.firstSeq, v.lastSeq]).toEqual([1, 3])
    },
  },
]

describe('reduce', () => {
  for (const row of ROWS) it(row.name, () => row.check(fold(row.events())))

  it('an unknown type is ignored', () => {
    const v = fold([user()])
    const odd = { seq: 9, ts: 1, type: 'future.thing', sessionId: S, payload: { turnId: 't1' } } as unknown as KernelEvent
    const w = reduce(v, odd)
    expect(w.turns).toBe(v.turns)
    expect(() => reduce(v, { seq: 10, ts: 1, type: 'message.assistant', payload: null } as KernelEvent)).not.toThrow()
  })

  it('a duplicate or older seq is ignored and returns the same view', () => {
    const v = fold([user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'a' })])
    const dup = ev('message.assistant.delta', { turnId: 't1', step: 1, text: 'b' }, { sessionId: S, seq: 2 })
    expect(reduce(v, dup)).toBe(v)
    expect(turn(v).steps[0].text).toBe('a')
  })

  it('is pure: the input view is not changed', () => {
    const v = fold([user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'a' })])
    const before = JSON.stringify(v, (_, x) => (x instanceof Map ? [...x] : x))
    reduce(v, e('message.assistant.delta', { turnId: 't1', step: 1, text: 'b' }))
    reduce(v, e('executor.run.started', { ...run('r1'), executor: 'c', cwd: '/', isolation: 'own' }))
    expect(JSON.stringify(v, (_, x) => (x instanceof Map ? [...x] : x))).toBe(before)
  })
})

describe('fromState', () => {
  const state = (events: KernelEvent[], extra: object = {}) =>
    fromState({ session: summary(S), events, hasMore: false, lastSeq: 500, ...extra } as never)

  it('open from the state wins: a turn without a terminal but no open is ended', () => {
    const v = state([user(), e('message.assistant.delta', { turnId: 't1', step: 1, text: 'x' })])
    expect(v.open).toBeUndefined()
    expect(v.lastSeq).toBe(500)
    expect(v.firstSeq).toBe(1)
  })

  it('open parked from the state; pending approvals outside approvalIds are stale', () => {
    const v = state([
      user(), e('approval.requested', { approvalId: 'p1', turnId: 't1', callId: 'c', tool: 'x', summary: 's' }),
      e('approval.requested', { approvalId: 'p2', turnId: 't1', callId: 'c', tool: 'x', summary: 's' }),
    ], { open: { turnId: 't1', parked: true, approvalIds: ['p2'] }, hasMore: true })
    expect(v.open).toEqual({ turnId: 't1', parked: true })
    expect(v.hasMore).toBe(true)
    expect(turn(v).approvals.map((a) => [a.approvalId, !!a.stale])).toEqual([['p1', true], ['p2', false]])
  })

  it('live events after the state: seq <= lastSeq dropped', () => {
    const v = state([user()], { open: { turnId: 't1', parked: false, approvalIds: [] } })
    expect(reduce(v, ev('turn.ended', { turnId: 't1' }, { sessionId: S, seq: 400 }))).toBe(v)
    const w = reduce(v, ev('turn.ended', { turnId: 't1' }, { sessionId: S, seq: 501 }))
    expect(w.open).toBeUndefined()
    expect(w.lastSeq).toBe(501)
  })
})

describe('rollbackable', () => {
  const snap = (turnId: string, changed = 1) => [
    e('turn.snapshot', { turnId, phase: 'start', ref: `refs/${turnId}-start` }),
    e('turn.snapshot', { turnId, phase: 'end', ref: `refs/${turnId}-end`, changed }),
  ]
  it('the newest snapshotted turn that is not rolled back', () => {
    expect(rollbackable(fold([user('t1'), ...snap('t1'), ended('t1'), user('t2'), ...snap('t2'), ended('t2')]))).toBe('t2')
  })
  it('not while a turn is open', () => {
    expect(rollbackable(fold([user('t1'), ...snap('t1'), ended('t1'), user('t2')]))).toBeUndefined()
  })
  it('after the newest is rolled back, the one before it is next (loop-default skips rolled-back turns)', () => {
    expect(rollbackable(fold([user('t1'), ...snap('t1'), ended('t1'), user('t2'), ...snap('t2'), ended('t2'), e('turn.rolledBack', { turnId: 't2', files: 1 })]))).toBe('t1')
  })
  it('a newer turn whose snapshot failed blocks it; a turn without any snapshot does not', () => {
    expect(rollbackable(fold([user('t1'), ...snap('t1'), ended('t1'), user('t2'), e('turn.snapshot', { turnId: 't2', phase: 'start', reason: 'not_git' }), ended('t2')]))).toBeUndefined()
    expect(rollbackable(fold([user('t1'), ...snap('t1'), ended('t1'), user('t2'), ended('t2')]))).toBe('t1')
  })
  it('needs both refs', () => {
    expect(rollbackable(fold([user('t1'), e('turn.snapshot', { turnId: 't1', phase: 'start', ref: 'r' }), ended('t1')]))).toBeUndefined()
  })
  it('a crash-ended turn (not open per state, no terminal) counts as ended', () => {
    const v = fromState({ session: summary(S), events: [user('t1'), ...snap('t1')], hasMore: false, lastSeq: 10 } as never)
    expect(rollbackable(v)).toBe('t1')
  })
})
