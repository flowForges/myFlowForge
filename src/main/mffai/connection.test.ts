import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION, runtimePaths } from '@mffai/protocol'
import { CH } from '../ipc/channels'
import { createWorkerConnection } from './connection'

/** 一个只在内存里的工作进程:subscribe 第一次回 reset 或 ok */
function fakeWorker(reset: boolean) {
  const calls: Array<[string, unknown]> = []
  let subs = 0
  const w = {
    async call(method: string, params?: unknown) {
      calls.push([method, params])
      switch (method) {
        case 'hello': return { version: '0.1.0', protocolVersion: PROTOCOL_VERSION, compatible: true }
        case 'snapshot': return { lastSeq: 50 }
        case 'events.subscribe': return reset && subs++ === 0 ? { reset: true, lastSeq: 7 } : { ok: true }
      }
      throw new Error(`unexpected ${method}`)
    },
    onEvent: () => () => {},
    onClose: () => () => {},
    close() {},
  }
  return { w, calls }
}

let base: string | undefined
afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = undefined })

function setup(reset: boolean) {
  base = mkdtempSync(join(tmpdir(), 'mffai-conn-'))
  const paths = runtimePaths(join(base, 'mff-ai'))
  mkdirSync(dirname(paths.token), { recursive: true })
  writeFileSync(paths.token, 'a'.repeat(64))
  const fw = fakeWorker(reset)
  const sent: Array<[string, unknown]> = []
  const onReset = vi.fn()
  const conn = createWorkerConnection({
    paths,
    connectWorker: vi.fn(async () => fw.w) as never,
    clientVersion: '9.9.9',
    send: (ch, p) => { sent.push([ch, p]) },
    status: async () => undefined,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
    onReset,
  })
  return { conn, sent, onReset, calls: fw.calls }
}

describe('worker connection reset (R11)', () => {
  it('a subscribe answering reset emits exactly one {kind:"reset"} alert and resubscribes from its lastSeq', async () => {
    const t = setup(true)
    await t.conn.connect()
    const alerts = t.sent.filter(([ch]) => ch === CH.mffaiAlert).map(([, p]) => p)
    expect(alerts).toEqual([{ kind: 'reset' }])
    expect(t.onReset).toHaveBeenCalledTimes(1)
    expect(t.calls.filter(([m]) => m === 'events.subscribe')).toEqual([['events.subscribe', { after: 50 }], ['events.subscribe', { after: 7 }]])
  })

  it('no reset → no reset alert', async () => {
    const t = setup(false)
    await t.conn.connect()
    expect(t.sent.filter(([ch]) => ch === CH.mffaiAlert)).toEqual([])
    expect(t.onReset).not.toHaveBeenCalled()
  })
})
