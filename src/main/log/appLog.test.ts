import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appLog, logInfo, logWarn, logError, getAppLog, clearAppLog,
  formatLine, formatAppLog, setAppLogFileSink, setAppLogEventSink,
  initAppLogFile, appLogFilePath, type AppLogEntry,
} from './appLog'

beforeEach(() => { clearAppLog(); setAppLogFileSink(null); setAppLogEventSink(null) })

describe('appLog ring buffer', () => {
  it('records entries with ts/level/scope/msg and returns a copy from getAppLog', () => {
    logInfo('codex', 'hello')
    const log = getAppLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ level: 'info', scope: 'codex', msg: 'hello' })
    expect(typeof log[0].ts).toBe('string')
    // returned array is a copy — mutating it must not affect the ring
    log.push({} as AppLogEntry)
    expect(getAppLog()).toHaveLength(1)
  })

  it('level helpers set the right level', () => {
    logWarn('a', 'w'); logError('b', 'e')
    expect(getAppLog().map(e => e.level)).toEqual(['warn', 'error'])
  })

  it('clips long detail and keeps it optional', () => {
    appLog('error', 's', 'm')
    expect(getAppLog()[0].detail).toBeUndefined()
    appLog('error', 's', 'm', 'x'.repeat(20000))
    expect(getAppLog()[1].detail!.length).toBe(8000)
  })

  it('caps the ring at 3000 newest entries', () => {
    for (let i = 0; i < 3050; i++) logInfo('s', 'm' + i)
    const log = getAppLog()
    expect(log).toHaveLength(3000)
    expect(log[log.length - 1].msg).toBe('m3049')
    expect(log[0].msg).toBe('m50')
  })

  it('clearAppLog empties the ring', () => {
    logInfo('s', 'm'); clearAppLog()
    expect(getAppLog()).toHaveLength(0)
  })
})

describe('appLog formatting + sinks', () => {
  it('formatLine renders single-line and indented multi-line detail', () => {
    expect(formatLine({ ts: 'T', level: 'info', scope: 'sc', msg: 'hi' })).toBe('T [info] [sc] hi')
    const f = formatLine({ ts: 'T', level: 'error', scope: 'codex', msg: 'fail', detail: 'line1\nline2' })
    expect(f).toBe('T [error] [codex] fail\n    line1\n    line2')
  })

  it('formatAppLog joins the ring', () => {
    logInfo('a', '1'); logWarn('b', '2')
    expect(formatAppLog().split('\n')).toHaveLength(2)
  })

  it('invokes the injected file + event sinks', () => {
    const lines: string[] = []
    const events: AppLogEntry[] = []
    setAppLogFileSink(l => lines.push(l))
    setAppLogEventSink(e => events.push(e))
    logError('codex', 'boom', 'stderr tail')
    expect(lines[0]).toContain('[error] [codex] boom')
    expect(events[0]).toMatchObject({ level: 'error', scope: 'codex', msg: 'boom', detail: 'stderr tail' })
  })

  it('never throws even if a sink throws', () => {
    setAppLogFileSink(() => { throw new Error('disk') })
    setAppLogEventSink(() => { throw new Error('ipc') })
    expect(() => logInfo('s', 'm')).not.toThrow()
    expect(getAppLog()).toHaveLength(1)
  })
})

describe('appLog disk persistence', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'forge-log-')) })
  afterEach(() => { setAppLogFileSink(null); rmSync(dir, { recursive: true, force: true }) })

  it('initAppLogFile appends formatted lines to <dir>/app.log', () => {
    const file = initAppLogFile(dir)
    expect(file).toBe(join(dir, 'app.log'))
    expect(appLogFilePath()).toBe(file)
    logInfo('boot', 'started')
    logError('codex', 'exit 1', 'detail here')
    const content = readFileSync(file, 'utf8')
    expect(content).toContain('[info] [boot] started')
    expect(content).toContain('[error] [codex] exit 1')
    expect(content).toContain('    detail here')
  })
})
