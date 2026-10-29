import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileLogger } from './fileLog'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-log-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('createFileLogger', () => {
  it('writes JSON lines to the daily file and drops files older than 7 days', () => {
    const now = new Date(2026, 9, 29, 12).getTime()
    for (const d of ['2026-10-21', '2026-10-22', '2026-10-28']) writeFileSync(join(dir, `worker-${d}.log`), '')
    writeFileSync(join(dir, 'supervisor-2026-10-01.log'), '')
    const log = createFileLogger(dir, 'worker', () => now)
    log.info('hello', { a: 1 })
    log.error('bad')
    expect(existsSync(join(dir, 'worker-2026-10-21.log'))).toBe(false)
    expect(existsSync(join(dir, 'worker-2026-10-22.log'))).toBe(true)
    expect(existsSync(join(dir, 'worker-2026-10-28.log'))).toBe(true)
    expect(existsSync(join(dir, 'supervisor-2026-10-01.log'))).toBe(true)
    const lines = readFileSync(join(dir, 'worker-2026-10-29.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toMatchObject([{ level: 'info', msg: 'hello', data: { a: 1 } }, { level: 'error', msg: 'bad' }])
  })

  it('prunes again when the date rolls over', () => {
    let now = new Date(2026, 9, 29, 23, 59).getTime()
    writeFileSync(join(dir, 'worker-2026-10-22.log'), '')
    const log = createFileLogger(dir, 'worker', () => now)
    log.info('a')
    expect(existsSync(join(dir, 'worker-2026-10-22.log'))).toBe(true)
    now = new Date(2026, 9, 30, 0, 1).getTime()
    log.info('b')
    expect(existsSync(join(dir, 'worker-2026-10-22.log'))).toBe(false)
    expect(existsSync(join(dir, 'worker-2026-10-30.log'))).toBe(true)
  })
})
