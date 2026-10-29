import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectControlClient } from '../protocol/index'
import { startControlServer } from './controlServer'
import type { Supervisor } from './supervisor'

let dir: string
let closers: Array<() => unknown> = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mffai-ctl-')); closers = [] })
afterEach(async () => {
  for (const c of closers.reverse()) await Promise.resolve(c()).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
})
const addr = () => (process.platform === 'win32' ? `\\\\.\\pipe\\mffai-ctl-${process.pid}-${Date.now()}` : join(dir, 'c.sock'))

describe('control server', () => {
  it('status carries the supervisor pid; deferred shutdown/restart failures are logged', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const sup = {
      state: () => ({ state: 'running', restarts: 0, version: 'v', protocolVersion: 1 }),
      restart: async () => { throw new Error('restart boom') },
      shutdown: async () => {},
      resetTrip: () => {},
    } as unknown as Supervisor
    const a = addr()
    const s = await startControlServer({ addr: a, token: 't', supervisor: sup, log, onShutdown: async () => { throw new Error('stop boom') } })
    closers.push(() => s.close())
    const c = await connectControlClient({ addr: a, token: 't' })
    closers.push(() => c.close())
    expect(await c.call('status')).toMatchObject({ state: 'running', pid: process.pid })
    expect(await c.call('restart')).toEqual({ ok: true })
    expect(await c.call('shutdown')).toEqual({ ok: true })
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2))
    expect(log.error).toHaveBeenCalledWith('restart failed', { error: 'Error: restart boom' })
    expect(log.error).toHaveBeenCalledWith('shutdown failed', { error: 'Error: stop boom' })
  })
})
