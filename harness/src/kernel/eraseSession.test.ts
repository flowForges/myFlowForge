// 08 §4.3 第 4 步(R3):整会话抹除。每条事件只留 id 字段和 erased,session.created 另留结构字段
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from './kernel'
import type { Plugin, PluginContext } from './pluginHost'
import type { SessionCommands } from '../lib/tools/types'
import { NO_SANDBOX } from '../../test/sandboxStub'

let dir: string
let kernels: Kernel[] = []
let red: PluginContext // 有抹除权限的(id 是 EVENT_REDACTORS 里的)
let other: PluginContext
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-erase-')) })
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(dir, { recursive: true, force: true })
})

const redactor: Plugin = { manifest: { id: 'memory-default', version: '0', kernel: '^0.1.0' }, activate: c => { red = c } }
const outsider: Plugin = { manifest: { id: 'outsider', version: '0', kernel: '^0.1.0' }, activate: c => { other = c } }

async function boot(): Promise<Kernel> {
  const k = await createKernel({ sandbox: NO_SANDBOX, dataDir: dir, plugins: [redactor, outsider], secrets: { osBackend: false } })
  kernels.push(k)
  return k
}

// 测试里的标记在运行时拼:源码里不出现整串
const MARK = ['zq', 'erase', 'mark', String(process.pid)].join('-')
const REPO = { kind: 'git', gitDir: '/w/.git', top: '/w', identity: 'abc' }

/** 每种带文本的事件都埋一个标记;返回会话 id */
async function seed(k: Kernel, sessionId: string, mark: string) {
  const a = (type: Parameters<PluginContext['append']>[0]['type'], payload: unknown) => red.append({ type, sessionId, payload })
  a('session.created', { title: mark, cwd: '/w', repo: REPO, origin: 'im', audience: 'group', projectTop: '/p', approvalMode: 'ask', toolset: 'patch', model: { accountId: 'acc', modelId: 'mod' } })
  a('message.user', { turnId: 't1', text: `hi ${mark}` })
  a('turn.started', { turnId: 't1' })
  a('tool.started', { turnId: 't1', callId: 'c1', name: 'shell', argsPreview: mark })
  a('approval.requested', { approvalId: 'ap1', turnId: 't1', callId: 'c1', tool: 'shell', summary: `echo ${mark}`, key: mark })
  a('approval.resolved', { approvalId: 'ap1', turnId: 't1', callId: 'c1', decision: 'allow', by: 'user' })
  a('tool.ended', { turnId: 't1', callId: 'c1', content: mark, isError: false })
  a('executor.run.progress', { turnId: 't1', runId: 'run1', kind: 'text', text: mark })
  a('executor.run.ended', { turnId: 't1', runId: 'run1', status: 'failed', changed: { files: [`${mark}.ts`] } })
  a('message.assistant', { turnId: 't1', text: mark, parts: [{ type: 'text', text: mark }] })
  a('memory.checkpoint', { throughSeq: 1, asOfSeq: 1, text: mark, model: 'm', tokens: 1, covers: 1 })
  a('turn.failed', { turnId: 't1', reason: 'error', message: mark })
  await k.handle('session.rename', { commandId: `rn-${sessionId}`, sessionId, title: `新 ${mark}` })
}

const rawRows = (sid: string) => {
  const db = new DatabaseSync(join(dir, 'db', 'events.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT seq, ts, type, session_id, payload FROM events WHERE session_id = ? ORDER BY seq').all(sid) as { seq: number; ts: number; type: string; session_id: string; payload: string }[]
  } finally { db.close() }
}
const bytes = () => ['', '-wal'].map(s => join(dir, 'db', `events.sqlite${s}`)).filter(existsSync).map(f => readFileSync(f).toString('latin1')).join('')

describe('EventLog.eraseSession (08 §4.3, R3)', () => {
  it('is refused until the session has a tombstone', async () => {
    const k = await boot()
    await seed(k, 'gone', MARK)
    expect(() => red.events.eraseSession('gone')).toThrow()
    expect(() => k.events.eraseSession('gone', 'x')).toThrow()
    expect(rawRows('gone').some(r => r.payload.includes(MARK))).toBe(true)
  })

  it('erases every type; ids, seq, ts, type and session.created structure survive; the markers are gone from the raw bytes after purge', async () => {
    const k = await boot()
    await seed(k, 'gone', MARK)
    const otherMark = MARK.replace('erase', 'keep')
    await seed(k, 'kept', otherMark)
    const before = rawRows('gone')
    const keptBefore = rawRows('kept')
    red.services.get<SessionCommands>('sessionCommands')!.markDeleted('gone')
    const n = red.events.eraseSession('gone')
    expect(n).toBe(before.length + 1) // 加上墓碑本身
    await red.events.purge()

    const after = rawRows('gone')
    expect(after.map(r => [r.seq, r.ts, r.type])).toEqual([...before.map(r => [r.seq, r.ts, r.type]), [after.at(-1)!.seq, after.at(-1)!.ts, 'session.deleted']])
    for (const r of after) expect(JSON.parse(r.payload).erased).toBe(true)
    const p = (type: string) => after.filter(r => r.type === type).map(r => JSON.parse(r.payload))
    expect(p('session.created')).toEqual([{ cwd: '/w', repo: REPO, origin: 'im', audience: 'group', projectTop: '/p', approvalMode: 'ask', toolset: 'patch', model: { accountId: 'acc', modelId: 'mod' }, erased: true }])
    expect(p('message.user')).toEqual([{ turnId: 't1', erased: true }])
    expect(p('approval.requested')).toEqual([{ approvalId: 'ap1', turnId: 't1', callId: 'c1', erased: true }])
    expect(p('executor.run.progress')).toEqual([{ turnId: 't1', runId: 'run1', erased: true }])
    expect(p('session.renamed')).toEqual([{ erased: true }])
    expect(p('memory.checkpoint')).toEqual([{ erased: true }])
    expect(p('session.deleted')).toEqual([{ erased: true }])

    expect(bytes()).not.toContain(MARK)
    expect(bytes()).toContain(otherMark)
    expect(rawRows('kept')).toEqual(keptBefore) // 别的会话逐字节不变

    const audit = k.events.after(0).filter(e => e.type === 'events.redacted')
    expect(audit.map(e => e.payload)).toEqual([{ by: 'memory-default', seqs: [], session: 'gone' }])
    expect(audit[0].sessionId).toBeUndefined()
  })

  it('a redo changes nothing and writes no second audit event; a restart still knows the session is deleted', async () => {
    const k = await boot()
    await seed(k, 'gone', MARK)
    red.services.get<SessionCommands>('sessionCommands')!.markDeleted('gone')
    expect(red.events.eraseSession('gone')).toBeGreaterThan(0)
    const snap = rawRows('gone')
    expect(red.events.eraseSession('gone')).toBe(0)
    expect(rawRows('gone')).toEqual(snap)
    expect(k.events.after(0).filter(e => e.type === 'events.redacted')).toHaveLength(1)
    await k.close()
    kernels = []
    const k2 = await boot()
    expect(((await k2.handle('session.list', {})) as { sessions: { id: string }[] }).sessions.map(s => s.id)).not.toContain('gone')
    expect(red.events.eraseSession('gone')).toBe(0)
  })

  it('a plugin that is not an event redactor may not call it', async () => {
    const k = await boot()
    await seed(k, 'gone', MARK)
    red.services.get<SessionCommands>('sessionCommands')!.markDeleted('gone')
    expect(() => other.events.eraseSession('gone')).toThrow(/may not/)
    expect(rawRows('gone').some(r => r.payload.includes(MARK))).toBe(true)
  })
})
