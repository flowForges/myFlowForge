import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { FrameDecoder, connectControlClient, encodeFrame } from '../protocol/index'
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
  it('control port speaks the v3 handshake: right token works, wrong token and plaintext auth are refused', async () => {
    const sup = { state: () => ({ state: 'running', restarts: 0, version: 'v', protocolVersion: 3 }) } as unknown as Supervisor
    const a = addr()
    const s = await startControlServer({ addr: a, token: 't', supervisor: sup })
    closers.push(() => s.close())
    const c = await connectControlClient({ addr: a, token: 't' })
    closers.push(() => c.close())
    expect(await c.call('status')).toMatchObject({ state: 'running', pid: process.pid })
    await expect(connectControlClient({ addr: a, token: 'wrong' })).rejects.toThrow('unauthorized')

    const sock = net.connect(a)
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    const got: Array<{ id?: unknown; error?: { code: number } }> = []
    const dec = new FrameDecoder()
    sock.on('data', (d: string) => got.push(...(dec.push(d) as typeof got)))
    const closed = new Promise(r => sock.once('close', r))
    await new Promise(r => sock.once('connect', r))
    sock.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'auth', params: { token: 't' } }))
    await closed
    expect(got).toEqual([expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32002 }) })])
  })

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

  it('autostart plans and runs commands through the injected exec (darwin, temp home)', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const calls: string[][] = []
    const home = join(dir, 'home')
    const a = addr()
    const s = await startControlServer({
      addr: a, token: 't', supervisor: {} as unknown as Supervisor, log, platform: 'darwin', home, dataDir: join(dir, 'data'),
      exec: async (f, args) => { calls.push([f, ...args]) },
    })
    closers.push(() => s.close())
    const c = await connectControlClient({ addr: a, token: 't' })
    closers.push(() => c.close())
    const spec = { execPath: '/x/Electron', daemonJs: '/x/mffaiDaemon.js' }
    expect(await c.call('autostart', { on: true, spec })).toEqual({ ok: true, errors: [] })
    const plist = join(home, 'Library/LaunchAgents/com.myflowforge.mffai.plist')
    expect(calls.map((x) => x[1])).toEqual(['bootout', 'bootstrap'])
    expect(calls[1][3]).toBe(plist)
    expect(readFileSync(plist, 'utf8')).toContain(join(dir, 'data'))
    expect(await c.call('autostart', { on: false, spec })).toEqual({ ok: true, errors: [] })
    expect(existsSync(plist)).toBe(false)
  })

  it('autostart reports command failures without throwing', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const a = addr()
    const s = await startControlServer({
      addr: a, token: 't', supervisor: {} as unknown as Supervisor, log, platform: 'darwin', home: join(dir, 'home'), dataDir: dir,
      exec: async (_f, args) => { if (args[0] === 'bootstrap') throw new Error('denied') },
    })
    closers.push(() => s.close())
    const c = await connectControlClient({ addr: a, token: 't' })
    closers.push(() => c.close())
    const r = (await c.call('autostart', { on: true, spec: { execPath: '/e', daemonJs: '/d' } })) as { ok: boolean; errors: string[] }
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toContain('denied')
    expect(log.warn).toHaveBeenCalled()
  })

  it('autostart with invalid params -> -32602 and no exec', async () => {
    const calls: string[][] = []
    const a = addr()
    const s = await startControlServer({
      addr: a, token: 't', supervisor: {} as unknown as Supervisor, platform: 'darwin', home: join(dir, 'home'), dataDir: dir,
      exec: async (f, args) => { calls.push([f, ...args]) },
    })
    closers.push(() => s.close())
    const c = await connectControlClient({ addr: a, token: 't' })
    closers.push(() => c.close())
    expect(await c.call('autostart', { on: 'yes' } as never).catch((e) => e.code)).toBe(-32602)
    expect(calls).toEqual([])
    expect(existsSync(join(dir, 'home'))).toBe(false)
  })

  describe('MFFAI_AUTOSTART_DRY_RUN', () => {
    beforeEach(() => { vi.stubEnv('MFFAI_AUTOSTART_DRY_RUN', '1') })
    afterEach(() => { vi.unstubAllEnvs() })
    const serveDry = async (home: string) => {
      const calls: string[][] = []
      const a = addr()
      const s = await startControlServer({
        addr: a, token: 't', supervisor: {} as unknown as Supervisor, platform: 'darwin', home, dataDir: join(dir, 'data'),
        exec: async (f, args) => { calls.push([f, ...args]) },
      })
      closers.push(() => s.close())
      const c = await connectControlClient({ addr: a, token: 't' })
      closers.push(() => c.close())
      return { c, calls }
    }

    it('plans only: no commands, no writes, ok', async () => {
      const home = join(dir, 'home')
      const { c, calls } = await serveDry(home)
      const spec = { execPath: '/e', daemonJs: '/d' }
      expect(await c.call('autostart', { on: true, spec })).toEqual({ ok: true, errors: [] })
      expect(await c.call('autostart', { on: false, spec })).toEqual({ ok: true, errors: [] })
      expect(calls).toEqual([])
      expect(existsSync(home)).toBe(false)
    })

    it('refuses when home is the real home directory', async () => {
      const { c, calls } = await serveDry(userInfo().homedir)
      const r = (await c.call('autostart', { on: true, spec: { execPath: '/e', daemonJs: '/d' } })) as { ok: boolean; errors: string[] }
      expect(r.ok).toBe(false)
      expect(r.errors.join()).toMatch(/real home/)
      expect(calls).toEqual([])
    })
  })
})
