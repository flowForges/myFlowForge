import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, transaction, EventLog, REDACTED, SESSION_PAGE_SQL } from './eventLog'
import { MemoryConfigSchema, parseMemoryConfig } from '../lib/memory/types'
import { KernelConfigSchema } from './config'
import { AssistantPartSchema, type EventType } from '../protocol/index'
import { buildMessages } from '../plugins/loop-default/history'
import { Receipts } from './receipts'
import { loadConfig, saveConfig } from './config'

let dir: string
const mk = () => (dir = mkdtempSync(join(tmpdir(), 'mffai-st-')))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('event log', () => {
  it('assigns increasing seq; onAppend fires after commit; after() is strictly newer', () => {
    const db = openDb(join(mk(), 'k.db'))
    const log = new EventLog(db)
    const seen: number[] = []
    let committedAtNotify: number[] = []
    log.onAppend((e) => {
      seen.push(e.seq)
      committedAtNotify = log.after(0).map((x) => x.seq)
    })
    const a = log.append({ type: 'turn.started', sessionId: 's', payload: { a: 1 } })
    const b = log.append({ type: 'turn.ended', payload: null })
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(log.after(a.seq).map((e) => e.seq)).toEqual([b.seq])
    expect(log.lastSeq()).toBe(b.seq)
    expect(log.tail(1)[0].seq).toBe(b.seq)
    expect(log.after(0)[0]).toMatchObject({ sessionId: 's', payload: { a: 1 } })
    expect(seen).toEqual([a.seq, b.seq])
    expect(committedAtNotify).toEqual([a.seq, b.seq])
  })

  it('defers notifications until COMMIT and drops them on ROLLBACK', () => {
    const db = openDb(join(mk(), 'k.db'))
    const log = new EventLog(db)
    const seen: number[] = []
    log.onAppend((e) => seen.push(e.seq))
    transaction(db, () => {
      log.append({ type: 'turn.started', payload: 1 })
      expect(seen).toEqual([])
    })
    expect(seen).toHaveLength(1)
    expect(() =>
      transaction(db, () => {
        log.append({ type: 'turn.ended', payload: 2 })
        new Receipts(db).put('c1', 'm', 1)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(seen).toHaveLength(1)
    expect(log.after(0)).toHaveLength(1)
    expect(new Receipts(db).get('c1')).toBeUndefined()
  })

  it('failed BEGIN does not poison later transactions', () => {
    const f = join(mk(), 'k.db')
    const db = openDb(f)
    db.exec('PRAGMA busy_timeout = 0')
    const other = openDb(f)
    other.exec('BEGIN IMMEDIATE')
    expect(() => transaction(db, () => 1)).toThrow()
    other.exec('ROLLBACK')
    const log = new EventLog(db)
    expect(() =>
      transaction(db, () => {
        log.append({ type: 'turn.started', payload: 1 })
        throw new Error('x')
      }),
    ).toThrow('x')
    expect(log.after(0)).toHaveLength(0)
  })

  it('throwing listener does not break commit or other listeners', () => {
    const db = openDb(join(mk(), 'k.db'))
    const errs: unknown[] = []
    const log = new EventLog(db, { onListenerError: (e) => errs.push(e) })
    const seen: number[] = []
    log.onAppend(() => { throw new Error('bad') })
    log.onAppend((e) => seen.push(e.seq))
    expect(transaction(db, () => { log.append({ type: 'turn.started', payload: 1 }); return 'ok' })).toBe('ok')
    expect(() => log.append({ type: 'turn.ended', payload: 2 })).not.toThrow()
    expect(seen).toHaveLength(2)
    expect(errs).toHaveLength(2)
  })

  it('sessionSummaries reads titles from session.created only, and no other payload', () => {
    const db = openDb(join(mk(), 'k.db'))
    const log = new EventLog(db)
    const put = (ts: number, type: string, sid: string | null, payload: string) => db.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (?, ?, ?, ?)').run(ts, type, sid, payload)
    put(1, 'session.created', 'a', JSON.stringify({ title: '第一个' }))
    put(2, 'session.created', 'b', JSON.stringify({}))
    put(3, 'message.user', 'a', 'not json at all')
    put(4, 'memory.checkpoint', 'a', 'not json either')
    put(5, 'turn.started', null, 'nor this')
    put(6, 'message.user', 'ghost', '{}')
    expect(log.sessionSummaries()).toEqual([{ id: 'a', title: '第一个', updatedAt: 3 }, { id: 'b', title: '新会话', updatedAt: 2 }])
  })

  it('scan yields the whole log in order across pages, and sees nothing appended after it finishes', () => {
    const log = new EventLog(openDb(join(mk(), 'k.db')))
    for (let i = 0; i < 25; i++) log.append({ type: 'turn.started', payload: i })
    expect([...log.scan(10)].map(e => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect([...log.scan(25)]).toHaveLength(25)
  })

  it('unsubscribe stops notifications', () => {
    const log = new EventLog(openDb(join(mk(), 'k.db')))
    let n = 0
    const off = log.onAppend(() => n++)
    log.append({ type: 'turn.started', payload: 0 })
    off()
    log.append({ type: 'turn.started', payload: 0 })
    expect(n).toBe(1)
  })
})

describe('receipts', () => {
  it('round-trips', () => {
    const r = new Receipts(openDb(join(mk(), 'k.db')))
    expect(r.get('x')).toBeUndefined()
    r.put('x', 'session.create', { id: 's1' })
    expect(r.get('x')).toEqual({ method: 'session.create', result: { id: 's1' } })
    r.put('x', 'other', { id: 's2' })
    expect(r.get('x')).toEqual({ method: 'session.create', result: { id: 's1' } })
  })
})

describe('config', () => {
  it('writes defaults when missing and round-trips', () => {
    const f = join(mk(), 'config.json')
    expect(loadConfig(f)).toEqual({ version: 1, plugins: { disabled: [] }, models: { accounts: [] } })
    expect(existsSync(f)).toBe(true)
    saveConfig(f, { version: 1, plugins: { disabled: ['a'] }, models: { accounts: [] } })
    expect(loadConfig(f).plugins.disabled).toEqual(['a'])
    expect(readdirSync(dir).filter((n) => n.includes('tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe(1)
  })

  it('renames corrupt config and loads defaults', () => {
    const f = join(mk(), 'config.json')
    writeFileSync(f, '{nope')
    expect(loadConfig(f).plugins.disabled).toEqual([])
    expect(readdirSync(dir).some((n) => n.startsWith('config.json.bad-'))).toBe(true)
  })
})

describe('EventLog.redact (06 spec §16)', () => {
  const setup = () => {
    const file = join(mk(), 'k.db')
    const db = openDb(file)
    return { file, db, log: new EventLog(db) }
  }
  type P = Record<string, unknown>
  const payloadOf = (log: EventLog, seq: number) => log.after(seq - 1, 1)[0].payload as P

  it('the placeholder is fixed', () => {
    expect(REDACTED).toBe('[已删除]')
  })

  const fields: [EventType, P, keyof P][] = [
    ['memory.injected', { turnId: 't', kind: 'session', text: 'a SECRET b', items: ['n_a'], coreVersion: 'v' }, 'text'],
    ['tool.ended', { turnId: 't', callId: 'c', name: 'memory_get', ok: true, ms: 1, content: 'a SECRET b' }, 'content'],
    ['tool.started', { turnId: 't', callId: 'c', name: 'memory_write', argsPreview: 'a SECRET b' }, 'argsPreview'],
    ['message.user', { turnId: 't', text: 'a SECRET b' }, 'text'],
    ['message.assistant.delta', { turnId: 't', step: 1, text: 'a SECRET b' }, 'text'],
    ['message.reasoning.delta', { turnId: 't', step: 1, text: 'a SECRET b' }, 'text'],
    ['executor.notice', { turnId: 't', runId: 'r', text: 'a SECRET b' }, 'text'],
  ]
  it.each(fields)('%s whole field: replaced, every other key kept', (type, payload, field) => {
    const { log } = setup()
    const e = log.append({ type, sessionId: 's', payload })
    expect(log.redact([{ seq: e.seq }], 'memory-default')).toBe(1)
    expect(payloadOf(log, e.seq)).toEqual({ ...payload, [field]: REDACTED })
  })
  it.each(fields)('%s with a needle: only literal occurrences', (type, payload, field) => {
    const { log } = setup()
    const e = log.append({ type, sessionId: 's', payload })
    expect(log.redact([{ seq: e.seq, needle: 'SECRET' }], 'memory-default')).toBe(1)
    expect(payloadOf(log, e.seq)).toEqual({ ...payload, [field]: `a ${REDACTED} b` })
  })

  it('a needle is literal, not a pattern, and every occurrence goes', () => {
    const { log } = setup()
    const e = log.append({ type: 'message.user', payload: { turnId: 't', text: 'x.*x x.*x xyx $& ' } })
    log.redact([{ seq: e.seq, needle: 'x.*x' }], 'p')
    expect(payloadOf(log, e.seq).text).toBe(`${REDACTED} ${REDACTED} xyx $& `)
  })

  it('an empty needle is refused: it would match everywhere', () => {
    const { log } = setup()
    const e = log.append({ type: 'message.user', payload: { turnId: 't', text: 'abc' } })
    expect(() => log.redact([{ seq: e.seq, needle: '' }], 'p')).toThrow()
    expect(payloadOf(log, e.seq).text).toBe('abc')
  })

  it('memory.checkpoint: whole field also sets redacted, a needle does not', () => {
    const { log } = setup()
    const payload = { throughSeq: 1, asOfSeq: 2, text: 'a SECRET b', model: 'm', tokens: 3, covers: 4 }
    const a = log.append({ type: 'memory.checkpoint', sessionId: 's', payload })
    const b = log.append({ type: 'memory.checkpoint', sessionId: 's', payload })
    log.redact([{ seq: a.seq }, { seq: b.seq, needle: 'SECRET' }], 'p')
    expect(payloadOf(log, a.seq)).toEqual({ ...payload, text: REDACTED, redacted: true })
    expect(payloadOf(log, b.seq)).toEqual({ ...payload, text: `a ${REDACTED} b` })
  })

  const ORIGIN = { accountId: 'a', protocol: 'anthropic', modelId: 'm' }
  const step = () => ({
    turnId: 't', step: 1, text: 'a SECRET b',
    parts: [
      { type: 'reasoning', replay: { type: 'thinking', thinking: 'think SECRET', signature: 'SIG' }, ...ORIGIN },
      { type: 'text', text: 'a SECRET b' },
      { type: 'tool_call', id: 'c1', name: 'memory_write', args: JSON.stringify({ text: 'SECRET' }) },
      { type: 'tool_call', id: 'c2', name: 'shell', args: JSON.stringify({ command: 'ls' }) },
    ],
  })
  const partsOf = (p: P) => p.parts as P[]

  it('message.assistant whole field: text, parts text and every args; args stay valid JSON, structure stays', () => {
    const { log } = setup()
    const e = log.append({ type: 'message.assistant', sessionId: 's', payload: step() })
    expect(log.redact([{ seq: e.seq }], 'p')).toBe(1)
    const p = payloadOf(log, e.seq)
    expect(p.text).toBe(REDACTED)
    expect(partsOf(p).map(x => x.type)).toEqual(['reasoning', 'text', 'tool_call', 'tool_call'])
    expect(partsOf(p).map(x => x.id)).toEqual([undefined, undefined, 'c1', 'c2'])
    expect(partsOf(p)[0]).toEqual({ type: 'reasoning', ...ORIGIN })
    expect(partsOf(p)[1].text).toBe(REDACTED)
    for (const part of partsOf(p).slice(2)) expect(JSON.parse(part.args as string)).toEqual({ redacted: true })
    for (const part of partsOf(p)) expect(AssistantPartSchema.safeParse(part).success).toBe(true)
  })

  it('message.assistant with a needle: literal in the text, args only as a whole and only where it appears', () => {
    const { log } = setup()
    const e = log.append({ type: 'message.assistant', sessionId: 's', payload: step() })
    log.redact([{ seq: e.seq, needle: 'SECRET' }], 'p')
    const p = payloadOf(log, e.seq)
    expect(p.text).toBe(`a ${REDACTED} b`)
    expect(partsOf(p)[1].text).toBe(`a ${REDACTED} b`)
    expect(JSON.parse(partsOf(p)[2].args as string)).toEqual({ redacted: true })
    expect(JSON.parse(partsOf(p)[3].args as string)).toEqual({ command: 'ls' })
    expect(partsOf(p)[0]).toEqual({ type: 'reasoning', ...ORIGIN })
  })

  // lib/models 产出的真实形状:replay 里就是明文
  const REPLAYS: [string, object][] = [
    ['Anthropic thinking', { type: 'thinking', thinking: 'THOUGHT-MARK "quoted" 想法', signature: 'SIG' }],
    ['DeepSeek reasoning_content', { reasoning_content: 'THOUGHT-MARK "quoted" 想法' }],
    ['Responses summary', { id: 'rs_1', encrypted_content: 'ENC', summary: [{ type: 'summary_text', text: 'THOUGHT-MARK "quoted" 想法' }] }],
  ]
  const thinkingStep = (replay: object) => ({
    turnId: 'old', step: 1, text: 'answer',
    parts: [
      { type: 'reasoning', replay, ...ORIGIN },
      { type: 'text', text: 'answer' },
      { type: 'tool_call', id: 'c1', name: 'shell', args: '{"command":"ls"}' },
    ],
  })
  /** 下一次发给模型的内容:同一模型,replay 本来会原样回传 */
  const sent = (log: EventLog) => JSON.stringify(buildMessages(log.bySession('s'), 'now', 'next', { origin: ORIGIN }))
  const allBytes = () => readdirSync(dir).map(f => readFileSync(join(dir, f)).toString('utf8')).join('')
  const seedStep = (log: EventLog, replay: object) => {
    log.append({ type: 'message.user', sessionId: 's', payload: { turnId: 'old', text: 'q' } })
    const e = log.append({ type: 'message.assistant', sessionId: 's', payload: thinkingStep(replay) })
    log.append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 'old', callId: 'c1', name: 'shell', ok: true, ms: 1, content: 'out' } })
    log.append({ type: 'turn.ended', sessionId: 's', payload: { turnId: 'old' } })
    return e
  }

  it.each(REPLAYS)('%s: before a redact the plaintext really is sent back (the fixture is honest)', (_n, replay) => {
    const { log } = setup()
    seedStep(log, replay)
    expect(sent(log)).toContain('THOUGHT-MARK')
  })
  it.each(REPLAYS)('%s: whole field leaves neither the bytes nor the next request holding it; pairing stays', (_n, replay) => {
    const { log } = setup()
    const e = seedStep(log, replay)
    expect(log.redact([{ seq: e.seq }], 'p')).toBe(1)
    expect(allBytes()).not.toContain('THOUGHT-MARK')
    expect(sent(log)).not.toContain('THOUGHT-MARK')
    expect(sent(log)).toContain('"callId":"c1"')
    expect(log.redact([{ seq: e.seq }], 'p')).toBe(0)
  })
  const needleRows = REPLAYS.flatMap(([n, replay]) => ['THOUGHT-MARK', '"quoted"', '想法'].map(needle => [n, needle, replay] as const))
  it.each(needleRows)('%s: needle %s found in it drops the replay, also when it is only there escaped', (_n, needle, replay) => {
    const { log } = setup()
    const e = seedStep(log, replay)
    expect(log.redact([{ seq: e.seq, needle }], 'p')).toBe(1)
    expect((payloadOf(log, e.seq).parts as P[])[0]).not.toHaveProperty('replay')
    expect(sent(log)).not.toContain('THOUGHT-MARK')
  })
  it.each(REPLAYS)('%s: a needle that is not in it keeps the replay', (_n, replay) => {
    const { log } = setup()
    const e = seedStep(log, replay)
    expect(log.redact([{ seq: e.seq, needle: 'answer' }], 'p')).toBe(1)
    expect((payloadOf(log, e.seq).parts as P[])[0].replay).toEqual(replay)
    expect(sent(log)).toContain('THOUGHT-MARK')
  })

  it('args holding the needle only in escaped form are still blanked', () => {
    const { log } = setup()
    const parts = [
      { type: 'tool_call', id: 'a', name: 'memory_write', args: '{"text":"\\u5bc6\\u7801\\u5728\\u8fd9"}' },
      { type: 'tool_call', id: 'b', name: 'memory_write', args: JSON.stringify({ text: 'say "hi" now' }) },
    ]
    const a = log.append({ type: 'message.assistant', payload: { turnId: 't', text: '', parts } })
    log.redact([{ seq: a.seq, needle: '密码在这' }, { seq: a.seq, needle: 'say "hi" now' }], 'p')
    for (const part of partsOf(payloadOf(log, a.seq))) expect(JSON.parse(part.args as string)).toEqual({ redacted: true })
  })

  it('callId blanks only that tool call, and nothing else in the step', () => {
    const { log } = setup()
    const e = log.append({ type: 'message.assistant', sessionId: 's', payload: step() })
    expect(log.redact([{ seq: e.seq, callId: 'c1' }], 'p')).toBe(1)
    const p = payloadOf(log, e.seq)
    expect(p.text).toBe('a SECRET b')
    expect(partsOf(p)[1].text).toBe('a SECRET b')
    expect(JSON.parse(partsOf(p)[2].args as string)).toEqual({ redacted: true })
    expect(JSON.parse(partsOf(p)[3].args as string)).toEqual({ command: 'ls' })
    expect(log.redact([{ seq: e.seq, callId: 'nope' }], 'p')).toBe(0)
  })

  it('callId is refused on other event types and together with a needle', () => {
    const { log } = setup()
    const u = log.append({ type: 'tool.started', payload: { turnId: 't', callId: 'c1', name: 'n', argsPreview: 'x' } })
    const a = log.append({ type: 'message.assistant', payload: step() })
    expect(() => log.redact([{ seq: u.seq, callId: 'c1' }], 'p')).toThrow()
    expect(() => log.redact([{ seq: a.seq, callId: 'c1', needle: 'x' }], 'p')).toThrow()
    expect(payloadOf(log, u.seq).argsPreview).toBe('x')
  })

  it('keeps seq, ts, type and session; only touches the listed events; appends one audit event without text', () => {
    const { log } = setup()
    const a = log.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: 'SECRET' } })
    const other = log.append({ type: 'turn.started', sessionId: 's', payload: { turnId: 't' } })
    const b = log.append({ type: 'tool.ended', sessionId: 's', payload: { turnId: 't', callId: 'c', name: 'n', ok: true, ms: 1, content: 'SECRET' } })
    const before = log.after(0)
    expect(log.redact([{ seq: a.seq }, { seq: b.seq }], 'memory-default')).toBe(2)
    const after = log.after(0)
    expect(after).toHaveLength(before.length + 1)
    for (const [i, e] of before.entries()) {
      expect({ seq: after[i].seq, ts: after[i].ts, type: after[i].type, sessionId: after[i].sessionId }).toEqual({ seq: e.seq, ts: e.ts, type: e.type, sessionId: e.sessionId })
    }
    expect(after[1]).toEqual(other)
    const audit = after.at(-1)!
    expect(audit.type).toBe('events.redacted')
    expect(audit.sessionId).toBeUndefined()
    expect(audit.payload).toEqual({ by: 'memory-default', seqs: [a.seq, b.seq] })
  })

  it.each(['session.created', 'turn.started', 'turn.rolledBack', 'memory.deleted', 'events.redacted', 'turn.usage', 'permissions.updated'] as const)('%s throws and rolls the whole batch back', type => {
    const { log } = setup()
    const ok = log.append({ type: 'message.user', payload: { turnId: 't', text: 'SECRET' } })
    const bad = log.append({ type, payload: { text: 'x', content: 'x' } })
    const last = log.lastSeq()
    expect(() => log.redact([{ seq: ok.seq }, { seq: bad.seq }], 'p')).toThrow()
    expect(payloadOf(log, ok.seq).text).toBe('SECRET')
    expect(log.lastSeq()).toBe(last)
  })

  it('an unknown seq throws and rolls back', () => {
    const { log } = setup()
    const ok = log.append({ type: 'message.user', payload: { turnId: 't', text: 'SECRET' } })
    expect(() => log.redact([{ seq: ok.seq }, { seq: 999 }], 'p')).toThrow()
    expect(payloadOf(log, ok.seq).text).toBe('SECRET')
  })

  it('doing it again changes nothing and writes no second audit event', () => {
    const { log } = setup()
    const a = log.append({ type: 'memory.checkpoint', payload: { throughSeq: 1, asOfSeq: 1, text: 'SECRET', model: 'm', tokens: 1, covers: 1 } })
    const b = log.append({ type: 'message.assistant', payload: step() })
    const c = log.append({ type: 'message.user', payload: { turnId: 't', text: 'SECRET' } })
    const edits = [{ seq: a.seq }, { seq: b.seq }, { seq: c.seq, needle: 'SECRET' }]
    expect(log.redact(edits, 'p')).toBe(3)
    const last = log.lastSeq()
    expect(log.redact(edits, 'p')).toBe(0)
    expect(log.redact([], 'p')).toBe(0)
    expect(log.lastSeq()).toBe(last)
  })

  it.each(['删除', '[', REDACTED])('a needle that is part of the placeholder stays idempotent: %s', needle => {
    const { log } = setup()
    const a = log.append({ type: 'message.user', payload: { turnId: 't', text: `请${needle}它` } })
    const other = log.append({ type: 'message.user', payload: { turnId: 't', text: 'nothing here' } })
    const edits = [{ seq: a.seq, needle }, { seq: other.seq, needle }]
    expect(log.redact(edits, 'p')).toBe(1)
    expect(payloadOf(log, a.seq).text).toBe(REDACTED)
    expect(payloadOf(log, other.seq).text).toBe('nothing here')
    const last = log.lastSeq()
    expect(log.redact(edits, 'p')).toBe(0)
    expect(log.lastSeq()).toBe(last)
  })

  it('a checkpoint emptied by a needle counts as redacted, so it can no longer be used', () => {
    const { log } = setup()
    const base = { throughSeq: 1, asOfSeq: 1, model: 'm', tokens: 1, covers: 1 }
    const a = log.append({ type: 'memory.checkpoint', payload: { ...base, text: '删除' } })
    log.redact([{ seq: a.seq, needle: '删除' }], 'p')
    expect(payloadOf(log, a.seq)).toEqual({ ...base, text: REDACTED, redacted: true })
  })

  it('a checkpoint that could not run is retried by the next call, even with nothing left to change', () => {
    const { file, db } = setup()
    const warns: string[] = []
    const log = new EventLog(db, { onWarn: m => void warns.push(m) })
    db.exec('PRAGMA busy_timeout = 0')
    const marker = 'MISSED-CHECKPOINT-' + 'q'.repeat(300)
    const a = log.append({ type: 'message.user', payload: { turnId: 't', text: marker } })
    const reader = new DatabaseSync(file)
    reader.exec('BEGIN')
    reader.prepare('SELECT count(*) FROM events').get()
    expect(log.redact([{ seq: a.seq }], 'p')).toBe(1)
    expect(warns).toHaveLength(1)
    expect(allBytes()).toContain('MISSED-CHECKPOINT') // 这就是要补的
    reader.exec('COMMIT')
    reader.close()
    expect(log.redact([{ seq: a.seq }], 'p')).toBe(0)
    expect(allBytes()).not.toContain('MISSED-CHECKPOINT')
    expect(warns).toHaveLength(1)
  })

  it('two edits of one event count once and list it once', () => {
    const { log } = setup()
    const a = log.append({ type: 'message.user', payload: { turnId: 't', text: 'one two' } })
    expect(log.redact([{ seq: a.seq, needle: 'one' }, { seq: a.seq, needle: 'two' }], 'p')).toBe(1)
    expect(payloadOf(log, a.seq).text).toBe(`${REDACTED} ${REDACTED}`)
    expect(log.after(a.seq).at(-1)!.payload).toEqual({ by: 'p', seqs: [a.seq] })
  })

  it('the audit event reaches listeners after commit; a rolled-back batch notifies nobody', () => {
    const { log } = setup()
    const a = log.append({ type: 'message.user', payload: { turnId: 't', text: 'x' } })
    const bad = log.append({ type: 'turn.started', payload: {} })
    const seen: string[] = []
    let textAtNotify: unknown
    log.onAppend(e => { seen.push(e.type); textAtNotify = payloadOf(log, a.seq).text })
    expect(() => log.redact([{ seq: a.seq }, { seq: bad.seq }], 'p')).toThrow()
    expect(seen).toEqual([])
    log.redact([{ seq: a.seq }], 'p')
    expect(seen).toEqual(['events.redacted'])
    expect(textAtNotify).toBe(REDACTED)
  })

  it('the text is gone from the bytes of the database and its WAL', () => {
    const { file, log } = setup()
    const marker = 'DELETED-MARKER-' + 'q'.repeat(300)
    const a = log.append({ type: 'memory.injected', sessionId: 's', payload: { turnId: 't', kind: 'session', text: `x ${marker} y`, items: [] } })
    const d = log.append({ type: 'message.reasoning.delta', sessionId: 's', payload: { turnId: 't', step: 1, text: `x ${marker} y` } })
    log.append({ type: 'turn.started', sessionId: 's', payload: { turnId: 't' } })
    log.redact([{ seq: a.seq, needle: marker }, { seq: d.seq }], 'p')
    const bytes = readdirSync(dir).map(f => readFileSync(join(dir, f)).toString('latin1')).join('')
    expect(bytes).not.toContain('DELETED-MARKER')
    expect(existsSync(`${file}-wal`) ? readFileSync(`${file}-wal`).length : 0).toBe(0)
  })

  it('purge clears the copies page splits left in dead space: secure_delete alone cannot reach them', () => {
    const { file, db, log } = setup()
    const marker = 'STALE-COPY-MARKER'
    const sizes = [40, 300, 1200, 3500, 9000]
    let state = 1
    const next = (n: number) => (state = (state * 1103515245 + 12345) & 0x7fffffff) % n
    const hits: number[] = []
    for (let i = 0; i < 400; i++) {
      const hit = next(6) === 0
      const e = log.append({ type: 'message.user', sessionId: 's', payload: { turnId: 't', text: `${hit ? marker : 'other'} ${'x'.repeat(sizes[next(5)])}` } })
      if (hit) hits.push(e.seq)
    }
    db.prepare('INSERT INTO receipts(command_id, method, result, ts) VALUES (?, ?, ?, ?)').run('c1', 'm', '{}', 1)
    const before = log.after(0)
    log.redact(hits.map(seq => ({ seq })), 'p')
    expect(log.after(0).some(e => JSON.stringify(e.payload).includes(marker))).toBe(false)
    const raw = () => readdirSync(dir).filter(f => !f.endsWith('-shm')).map(f => readFileSync(join(dir, f)).toString('latin1')).join('')
    expect(raw()).toContain(marker) // 不做 purge 确实还在:这个用例才有意义

    log.purge()
    expect(raw()).not.toContain(marker)
    expect(readFileSync(`${file}-wal`).length).toBe(0)
    const after = log.after(0)
    expect(after.slice(0, before.length).map(e => [e.seq, e.ts, e.type])).toEqual(before.map(e => [e.seq, e.ts, e.type]))
    expect(db.prepare('SELECT command_id FROM receipts').all()).toEqual([{ command_id: 'c1' }])
    expect(log.append({ type: 'turn.started', sessionId: 's', payload: { turnId: 'n' } }).seq).toBe(after.at(-1)!.seq + 1)
  })

  it('purge inside an open transaction throws: it could not have cleaned anything', () => {
    const { db, log } = setup()
    expect(() => transaction(db, () => log.purge())).toThrow(/transaction/)
  })

  it('inside an open transaction the checkpoint failure stays quiet, and the batch joins that transaction', () => {
    const { db, log } = setup()
    const a = log.append({ type: 'message.user', payload: { turnId: 't', text: 'x' } })
    expect(() => transaction(db, () => {
      expect(log.redact([{ seq: a.seq }], 'p')).toBe(1)
      throw new Error('boom')
    })).toThrow('boom')
    expect(payloadOf(log, a.seq).text).toBe('x')
  })
})

describe('event delivery is in order and not re-entrant', () => {
  const setup = () => {
    const db = openDb(join(mk(), 'k.db'))
    return { db, log: new EventLog(db) }
  }
  /** 和 rpcServer 的推送一样:seq 不大于已发的就丢 */
  const cursor = (log: EventLog) => {
    const got: number[] = []
    let sent = 0
    log.onAppend(e => {
      if (e.seq <= sent) return
      sent = e.seq
      got.push(e.seq)
    })
    return got
  }
  const appendOnce = (log: EventLog) => {
    let once = true
    log.onAppend(() => {
      if (!once) return
      once = false
      log.append({ type: 'memory.updated', payload: { op: 'x', source: 'y' } })
    })
  }

  it('an append from a listener does not drop the outer event from a cursor', () => {
    const { log } = setup()
    appendOnce(log)
    const got = cursor(log)
    const outer = log.append({ type: 'turn.ended', payload: {} })
    expect(got).toEqual([outer.seq, outer.seq + 1])
  })

  it('the same inside a transaction with two events: a listener\'s append comes after both', () => {
    const { db, log } = setup()
    appendOnce(log)
    const got = cursor(log)
    const [a, b] = transaction(db, () => [log.append({ type: 'turn.started', payload: {} }), log.append({ type: 'turn.ended', payload: {} })])
    expect(got).toEqual([a.seq, b.seq, b.seq + 1])
  })

  it('a listener that throws neither stops delivery nor leaves it stuck', () => {
    const db = openDb(join(mk(), 'k.db'))
    const errors: unknown[] = []
    const log = new EventLog(db, { onListenerError: e => void errors.push(e) })
    log.onAppend(() => { throw new Error('boom') })
    const got = cursor(log)
    log.append({ type: 'turn.started', payload: {} })
    log.append({ type: 'turn.ended', payload: {} })
    expect(got).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })
})

describe('memory config (06)', () => {
  it('parse({}) fills every default, including the nested ones', () => {
    expect(MemoryConfigSchema.parse({})).toEqual({
      recall: true, tokensPerDay: 400_000, usdPerDay: 1, nightly: { enabled: true, hour: 3 }, recommendations: { routine: false },
    })
    const c = MemoryConfigSchema.parse({})
    expect(c.nightly.enabled).toBe(true)
    expect(c.nightly.hour).toBe(3)
  })
  it('a partial nested section keeps the other defaults', () => {
    expect(MemoryConfigSchema.parse({ nightly: { hour: 5 } }).nightly).toEqual({ enabled: true, hour: 5 })
  })
  it('a broken section falls back to defaults and warns; a missing one does not warn', () => {
    const warns: string[] = []
    const warn = (m: string) => void warns.push(m)
    const defaults = MemoryConfigSchema.parse({})
    expect(parseMemoryConfig(undefined, warn)).toEqual(defaults)
    expect(warns).toEqual([])
    expect(parseMemoryConfig({ nightly: { hour: 99 } }, warn)).toEqual(defaults)
    expect(parseMemoryConfig('nope', warn)).toEqual(defaults)
    expect(warns).toHaveLength(2)
    expect(parseMemoryConfig({ tokensPerDay: 5 }, warn).tokensPerDay).toBe(5)
    expect(warns).toHaveLength(2)
  })
  it('the kernel keeps the section as it is, even when broken', () => {
    expect(KernelConfigSchema.parse({ memory: { nightly: 'garbage' } }).memory).toEqual({ nightly: 'garbage' })
  })
})

describe('session index and paging (08 §4.2, R9)', () => {
  const indexes = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all() as { name: string }[]).map(r => r.name)

  it('openDb creates events_session; a database made before it gains it and keeps its rows', () => {
    const file = join(mk(), 'old.db')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, session_id TEXT, payload TEXT);
      CREATE TABLE receipts(command_id TEXT PRIMARY KEY, method TEXT, result TEXT, ts INTEGER);`)
    old.prepare('INSERT INTO events(ts, type, session_id, payload) VALUES (1, ?, ?, ?)').run('session.created', 's', '{}')
    expect(indexes(old)).not.toContain('events_session')
    old.close()
    const db = openDb(file)
    expect(indexes(db)).toContain('events_session')
    expect(new EventLog(db).bySession('s').map(e => e.type)).toEqual(['session.created'])
    db.close()
    const again = openDb(file) // 再开一次不报错
    expect(indexes(again).filter(n => n === 'events_session')).toHaveLength(1)
    again.close()
  })

  it('the page query uses events_session', () => {
    const db = openDb(join(mk(), 'k.db'))
    const log = new EventLog(db)
    for (let i = 0; i < 50; i++) log.append({ type: 'turn.started', sessionId: i % 2 ? 'a' : 'b', payload: {} })
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${SESSION_PAGE_SQL}`).all('a', 40, 0, 10) as { detail: string }[]).map(r => r.detail).join(' | ')
    expect(plan).toContain('events_session')
    const bySession = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? ORDER BY seq").all('a') as { detail: string }[]).map(r => r.detail).join(' | ')
    expect(bySession).toContain('events_session')
  })

  it('bySessionPage walks back without gaps or duplicates, only that session, ascending', () => {
    const log = new EventLog(openDb(join(mk(), 'k.db')))
    const mine: number[] = []
    for (let i = 0; i < 60; i++) {
      const e = log.append({ type: 'turn.started', sessionId: i % 3 ? 'a' : 'b', payload: { i } })
      if (e.sessionId === 'a') mine.push(e.seq)
    }
    const got: number[] = []
    let page = log.bySessionPage('a', { limit: 7 })
    const pages = [page]
    while (page.hasMore) {
      page = log.bySessionPage('a', { beforeSeq: page.events[0].seq, limit: 7 })
      pages.push(page)
    }
    for (const p of [...pages].reverse()) {
      expect(p.events.map(e => e.seq)).toEqual([...p.events.map(e => e.seq)].sort((x, y) => x - y))
      expect(p.events.every(e => e.sessionId === 'a')).toBe(true)
      got.push(...p.events.map(e => e.seq))
    }
    expect(got).toEqual(mine)
    expect(pages.at(-1)!.hasMore).toBe(false)
    expect(log.bySessionPage('nope', { limit: 5 })).toEqual({ events: [], hasMore: false })
  })

  it('fromSeq: everything from there on, up to limit newest; hasMore says older rows exist', () => {
    const log = new EventLog(openDb(join(mk(), 'k.db')))
    const seqs = Array.from({ length: 20 }, () => log.append({ type: 'turn.started', sessionId: 's', payload: {} }).seq)
    const p = log.bySessionPage('s', { fromSeq: seqs[5], limit: 100 })
    expect(p.events.map(e => e.seq)).toEqual(seqs.slice(5))
    expect(p.hasMore).toBe(true)
    const all = log.bySessionPage('s', { fromSeq: seqs[0], limit: 100 })
    expect(all.hasMore).toBe(false)
    const capped = log.bySessionPage('s', { fromSeq: seqs[0], limit: 4 })
    expect(capped.events.map(e => e.seq)).toEqual(seqs.slice(16))
    expect(capped.hasMore).toBe(true)
  })

  it('sessionSummaries leaves out deleted sessions; the shape stays', () => {
    const log = new EventLog(openDb(join(mk(), 'k.db')))
    log.append({ type: 'session.created', sessionId: 'a', payload: { title: 'A' } })
    log.append({ type: 'session.created', sessionId: 'b', payload: { title: 'B' } })
    log.append({ type: 'session.deleted', sessionId: 'a', payload: {} })
    const s = log.sessionSummaries()
    expect(s.map(x => x.id)).toEqual(['b'])
    expect(Object.keys(s[0]).sort()).toEqual(['id', 'title', 'updatedAt'])
  })
})
