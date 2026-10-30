import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, transaction, EventLog } from './eventLog'
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
