import { describe, it, expect, vi, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPUTER_TOOLS } from '@shared/computerUse'
import { defaultSettings, type Settings } from '../config/schema'
import { forgeMcpArgs } from '../agents/mcpConfig'
import { fakeDriver, type FakeDriver } from './fakeDriver'
import type { WinHit } from './driver'
import { createCuRuntime, cuRandom, mergeComputerUse, ownAccelerators, resolveHelperPath, type CuRuntimeDeps } from './runtime'
import type { CuEvent, CuGate, CuSessionKey } from './types'

const A: CuSessionKey = { workspacePath: '/w/a', sessionId: 's-a' }
const B: CuSessionKey = { workspacePath: '/w/b', sessionId: 's-b' }
const LOCAL = { local: true }
const APP: WinHit = { pid: 500, bundleId: 'com.example.app', name: 'Example', layer: 0, windowId: 77 }
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve() }

const roots: string[] = []
const tmp = (p = 'cu-rt-') => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d }
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); vi.restoreAllMocks() })

function setup(o: {
  platform?: NodeJS.Platform
  settings?: (s: Settings) => Settings
  grants?: boolean
  dirExists?: boolean
  bridgeFails?: boolean
  driver?: FakeDriver
  random?: () => string
} = {}) {
  const root = tmp()
  const dir = join(root, 'computer-use')
  if (o.dirExists) mkdirSync(dir, { recursive: true })
  const driver = o.driver ?? fakeDriver({ front: APP, hits: APP, capture: { width: 1280, height: 800 } })
  let settings: Settings = o.settings ? o.settings(defaultSettings()) : defaultSettings()
  const writes: Settings[] = []
  const events: CuEvent[] = []
  const notes: { key: CuSessionKey; text: string }[] = []
  const stopped: CuSessionKey[] = []
  let made = 0
  let clock = 1_000_000
  const bridges: { dir: string; closed: boolean }[] = []
  const collapse = vi.fn()
  const deps: CuRuntimeDeps = {
    platform: o.platform ?? 'darwin',
    dir,
    ownPid: 4242,
    helperPath: () => '/fake/forge-cu',
    makeDriver: () => { made++; return driver },
    startBridge: async (d) => {
      if (o.bridgeFails) throw new Error('EADDRINUSE')
      const b = { dir: d, closed: false }
      bridges.push(b)
      return { socketPath: join(d, 'cu.sock'), configDir: d, close: async () => { b.closed = true } }
    },
    openExternal: async () => {},
    emit: (e) => events.push(e),
    note: (key, text) => notes.push({ key, text }),
    stopTurn: (key) => stopped.push(key),
    titleOf: (k) => `T-${k.sessionId}`,
    readSettings: () => settings,
    writeSettings: (s) => { writes.push(s); settings = s },
    ownAccelerators: () => ['Control+Alt+Command+Escape'],
    liveAgentChildren: () => [],
    grantsHeld: () => o.grants ?? false,
    collapseMain: collapse,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    random: o.random,
  }
  const rt = createCuRuntime(deps)
  return {
    rt, driver, dir, events, notes, stopped, writes, bridges, collapse, deps,
    get made() { return made },
    get settings() { return settings },
  }
}

describe('resolveHelperPath', () => {
  it('packaged: Resources/native/forge-cu; dev: <repo>/build/native/darwin/forge-cu; missing → null', () => {
    const res = tmp('cu-res-')
    const repo = tmp('cu-repo-')
    expect(resolveHelperPath(true, { resourcesPath: res, devRoot: repo })).toBeNull()
    expect(resolveHelperPath(false, { resourcesPath: res, devRoot: repo })).toBeNull()
    mkdirSync(join(res, 'native'), { recursive: true })
    writeFileSync(join(res, 'native', 'forge-cu'), '#!/bin/sh\n')
    expect(resolveHelperPath(true, { resourcesPath: res, devRoot: repo })).toBeNull()   // not executable
    chmodSync(join(res, 'native', 'forge-cu'), 0o755)
    expect(resolveHelperPath(true, { resourcesPath: res, devRoot: repo })).toBe(join(res, 'native', 'forge-cu'))
    mkdirSync(join(repo, 'build', 'native', 'darwin'), { recursive: true })
    writeFileSync(join(repo, 'build', 'native', 'darwin', 'forge-cu'), '#!/bin/sh\n', { mode: 0o755 })
    expect(resolveHelperPath(false, { resourcesPath: res, devRoot: repo })).toBe(join(repo, 'build', 'native', 'darwin', 'forge-cu'))
  })
})

describe('host() is cheap (caps.computerUse() runs on every turn and every session close)', () => {
  it('non-darwin: undefined, nothing built', () => {
    const t = setup({ platform: 'win32' })
    expect(t.rt.host()).toBeUndefined()
    expect(t.made).toBe(0)
  })

  it('darwin: one build, the same object every call, and no helper request, bridge, file or setting', () => {
    const t = setup()
    const statusSpy = vi.spyOn(t.driver, 'status')
    const h = t.rt.host()
    expect(h).toBeDefined()
    for (let i = 0; i < 50; i++) expect(t.rt.host()).toBe(h)
    expect(t.made).toBe(1)
    expect(statusSpy).not.toHaveBeenCalled()
    expect(t.bridges).toEqual([])
    expect(existsSync(t.dir)).toBe(false)
    expect(t.writes).toEqual([])
    // the per-turn calls handlers.ts makes on a session that's off
    h!.service.beginTurn(A, 'local')
    h!.service.endTurn(A)
    h!.service.forget(A)
    expect(statusSpy).not.toHaveBeenCalled()
    expect(t.stopped).toEqual([])
    expect(t.notes).toEqual([])
  })

  it('isBuilt / onLock / stopAll / dispose before anything was built build nothing', async () => {
    const t = setup()
    expect(t.rt.isBuilt()).toBe(false)
    t.rt.onLock()
    t.rt.stopAll()
    await t.rt.dispose()
    expect(t.made).toBe(0)
  })
})

describe('service wiring', () => {
  it('configDir is the cu dir: revoking a token deletes its mcp.<token>.json there', async () => {
    const t = setup()
    const h = t.rt.host()!
    expect(await h.service.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    const tok = h.service.tokenFor(A)!
    const file = forgeMcpArgs({
      FORGE_SOCKET: join(t.dir, 'cu.sock'), FORGE_MCP_DIR: t.dir, FORGE_AGENT_ID: tok,
      FORGE_MCP_ENTRY: '/x/forgeMcp.js', FORGE_TOOLS: COMPUTER_TOOLS.join(','),
    })[1]
    expect(existsSync(file)).toBe(true)
    await h.service.setMode(A, 'off', LOCAL)
    expect(existsSync(file)).toBe(false)
  })

  it('random is a CSPRNG source (cuRandom), and the service uses the injected one', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const r = cuRandom()
      expect(r).toMatch(/^[A-Z2-7]{16}$/)
      seen.add(r)
    }
    expect(seen.size).toBe(200)
    const bytes = vi.fn((n: number) => Buffer.alloc(n, 1))
    expect(cuRandom(bytes)).toBe('B'.repeat(16))
    expect(bytes).toHaveBeenCalledWith(16)

    const t = setup()
    await t.rt.host()!.service.setMode(A, 'ask', LOCAL)
    expect(t.rt.host()!.service.tokenFor(A)).toMatch(/^cu\.[A-Z2-7]{16}$/)
    const t2 = setup({ random: () => 'QWERTYUIOPASDFGH' })
    await t2.rt.host()!.service.setMode(A, 'ask', LOCAL)
    expect(t2.rt.host()!.service.tokenFor(A)).toBe('cu.QWERTYUIOPASDFGH')
  })

  it('saveSettings merges into computerUse deeply: the first enable keeps the user lists and requested flags', async () => {
    const t = setup({
      settings: (s) => ({ ...s, agentProxy: 'http://p', computerUse: { ...s.computerUse, requested: { screen: true, ax: false }, extraBlocked: ['com.x'], extraAskAlways: ['com.y'] } }),
    })
    expect(await t.rt.host()!.service.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    expect(t.writes).toHaveLength(1)
    expect(t.writes[0].agentProxy).toBe('http://p')
    expect(t.writes[0].computerUse).toEqual({
      provisioned: true, requested: { screen: true, ax: false }, extraBlocked: ['com.x'], extraAskAlways: ['com.y'],
    })
  })

  it('mergeComputerUse: nested objects merge, arrays replace', () => {
    const base = defaultSettings().computerUse
    const cur = { ...base, requested: { screen: true, ax: false }, extraBlocked: ['a', 'b'] }
    expect(mergeComputerUse(cur, { requested: { ax: true } as never })).toEqual({ ...cur, requested: { screen: true, ax: true } })
    expect(mergeComputerUse(cur, { extraBlocked: ['c'] })).toEqual({ ...cur, extraBlocked: ['c'] })
    expect(mergeComputerUse(undefined as never, { provisioned: true })).toMatchObject({ provisioned: true })
  })

  it('saving provisioned also creates the private cu dir (the startup grant latch looks for it)', async () => {
    const t = setup()
    await t.rt.host()!.service.setMode(A, 'ask', LOCAL)
    expect(statSync(t.dir).mode & 0o777).toBe(0o700)
  })

  it('stopTurn reaches the chat only for a session that was on', async () => {
    const t = setup()
    const svc = t.rt.host()!.service
    svc.forget(B)
    svc.stop(B, 'user')
    expect(t.stopped).toEqual([])
    await svc.setMode(A, 'ask', LOCAL)
    svc.stop(A, 'user')
    expect(t.stopped).toEqual([A])
  })

  it('the stop hotkey (stopAll) and the lock path turn every session off with their notes', async () => {
    const t = setup()
    const svc = t.rt.host()!.service
    await svc.setMode(A, 'ask', LOCAL)
    t.rt.stopAll()
    expect(svc.modeOf(A)).toBe('off')
    expect(t.events).toContainEqual({ type: 'stopped', key: A, why: 'hotkey' })
    await svc.setMode(A, 'allow', LOCAL)
    t.rt.onLock()
    expect(svc.modeOf(A)).toBe('off')
    expect(t.notes.map((n) => n.text)).toContain('屏幕已锁定 · 电脑操作已关闭')
  })

  it('bridge(): started once on demand in the cu dir; a failure is retried next time; dispose closes it and the driver', async () => {
    const t = setup({ bridgeFails: true })
    const h = t.rt.host()!
    await expect(h.bridge()).rejects.toThrow()
    const t2 = setup()
    const h2 = t2.rt.host()!
    const [x, y] = await Promise.all([h2.bridge(), h2.bridge()])
    expect(x).toEqual({ socketPath: join(t2.dir, 'cu.sock'), configDir: t2.dir })
    expect(y).toEqual(x)
    expect(t2.bridges).toHaveLength(1)
    await t2.rt.dispose()
    expect(t2.bridges[0].closed).toBe(true)
    expect(t2.driver.disposed).toBe(true)
  })

  it('runningApps comes from the driver; collapseMain from the shell', async () => {
    const t = setup({ driver: fakeDriver({ apps: [{ bundleId: 'com.a', name: 'A' }] }) })
    const h = t.rt.host()!
    expect(await h.runningApps!()).toEqual([{ bundleId: 'com.a', name: 'A' }])
    h.collapseMain!()
    expect(t.collapse).toHaveBeenCalledTimes(1)
  })

  it('ownAccelerators lists every global binding after overrides, the stop one included', () => {
    expect(ownAccelerators({})).toEqual(['CommandOrControl+Alt+F', 'CommandOrControl+Shift+P', 'Control+Alt+Command+Escape'])
    expect(ownAccelerators({ 'toggle-pet': '', 'computer-use-stop': 'Control+Alt+Command+F12' })).toEqual(['CommandOrControl+Alt+F', 'Control+Alt+Command+F12'])
  })
})

describe('disclaim seam (V3, V16 ③, controller notes)', () => {
  const provisioned = (s: Settings): Settings => ({ ...s, computerUse: { ...s.computerUse, provisioned: true } })

  it('never provisioned: disclaim off, and the startup probe starts nothing', async () => {
    const t = setup()
    await t.rt.startup()
    expect(t.rt.disclaimEnabled()).toBe(false)
    expect(t.made).toBe(0)
    expect(t.writes).toEqual([])
  })

  it('provisioned: off until the helper has answered a status; then provisioned && status.disclaim !== false', async () => {
    const t = setup({ settings: provisioned })
    expect(t.rt.disclaimEnabled()).toBe(false)
    await t.rt.startup()
    expect(t.rt.disclaimEnabled()).toBe(true)
    const t2 = setup({ settings: provisioned, driver: fakeDriver({ status: { disclaim: false } }) })
    await t2.rt.startup()
    expect(t2.rt.disclaimEnabled()).toBe(false)
  })

  it('a status from setMode (first enable) also arms it', async () => {
    const t = setup()
    expect(t.rt.disclaimEnabled()).toBe(false)
    await t.rt.host()!.service.setMode(A, 'ask', LOCAL)
    expect(t.rt.disclaimEnabled()).toBe(true)
  })

  it('a probe that throws leaves it off (agents spawn plainly; enabling is refused by restart_required / the helper conflict)', async () => {
    const d = fakeDriver()
    d.status = async () => { throw new Error('helper_failed') }
    const t = setup({ settings: provisioned, driver: d })
    await t.rt.startup()
    expect(t.rt.disclaimEnabled()).toBe(false)
  })

  it('startup latch: provisioned:false but the app holds a grant and the cu dir exists → provisioned again, persisted', async () => {
    const t = setup({ grants: true, dirExists: true })
    await t.rt.startup()
    expect(t.settings.computerUse.provisioned).toBe(true)
    expect(t.rt.disclaimEnabled()).toBe(true)
  })

  it('startup latch needs both: a grant held for another reason with no cu dir stays as today', async () => {
    const t = setup({ grants: true, dirExists: false })
    await t.rt.startup()
    expect(t.settings.computerUse.provisioned).toBe(false)
    expect(t.made).toBe(0)
    const t2 = setup({ grants: false, dirExists: true })
    await t2.rt.startup()
    expect(t2.settings.computerUse.provisioned).toBe(false)
    expect(t2.made).toBe(0)
  })

  it('provisioned latches for the run: a later read of false keeps it on', async () => {
    const t = setup({ settings: provisioned })
    await t.rt.startup()
    t.deps.writeSettings({ ...t.settings, computerUse: { ...t.settings.computerUse, provisioned: false } })
    expect(t.rt.disclaimEnabled()).toBe(true)
  })
})

describe('integration: the real executor on the real service, ask mode', () => {
  async function ready(t: ReturnType<typeof setup>) {
    const svc = t.rt.host()!.service
    expect(await svc.setMode(A, 'ask', LOCAL)).toEqual({ ok: true })
    svc.beginTurn(A, 'local')
    const tok = svc.tokenFor(A)!
    const shot = await svc.handle(tok, 'screenshot', {}, {})
    expect(shot.ok).toBe(true)
    return { svc, tok, code: t.driver.captures[0].code! }
  }

  it('one approval gives exactly one post', async () => {
    const t = setup()
    const { svc, tok, code } = await ready(t)
    const call = svc.handle(tok, 'click', { x: 100, y: 100, visionCode: code }, {})
    await flush()
    const gates = t.events.filter((e): e is { type: 'gate'; gate: CuGate } => e.type === 'gate')
    expect(gates).toHaveLength(1)
    expect(t.driver.posts).toHaveLength(0)
    expect(await svc.resolve(gates[0].gate.id, 'allow', LOCAL)).toBe(true)
    const r = await call
    expect(r.ok).toBe(true)
    expect(t.driver.posts).toHaveLength(1)
    expect(t.driver.posts[0].action).toMatchObject({ kind: 'click', button: 'left', count: 1 })
    expect(t.driver.posts[0].guard.denyPids).toContain(4242)
    expect(t.events.some((e) => e.type === 'action' && e.entry.result === 'allowed')).toBe(true)
  })

  it('a denial gives none, and the next click opens its own gate', async () => {
    const t = setup()
    const { svc, tok, code } = await ready(t)
    const call = svc.handle(tok, 'click', { x: 100, y: 100, visionCode: code }, {})
    await flush()
    const g1 = t.events.filter((e): e is { type: 'gate'; gate: CuGate } => e.type === 'gate')
    await svc.resolve(g1[0].gate.id, 'deny', LOCAL)
    expect(await call).toMatchObject({ ok: false, code: 'denied' })
    expect(t.driver.posts).toHaveLength(0)
    const call2 = svc.handle(tok, 'click', { x: 100, y: 100, visionCode: code }, {})
    await flush()
    const g2 = t.events.filter((e): e is { type: 'gate'; gate: CuGate } => e.type === 'gate')
    expect(g2).toHaveLength(2)
    expect(t.driver.posts).toHaveLength(0)
    await svc.resolve(g2[1].gate.id, 'allow', LOCAL)
    await call2
    expect(t.driver.posts).toHaveLength(1)
  })
})
