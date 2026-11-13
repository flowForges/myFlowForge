/**
 * Task 12 integration: the whole main-side chain at once, on fakeDriver.
 * MCP client → forgeMcp (createForgeServer + connectBridge) → cu.sock (startCuBridge) → service → executor → driver,
 * with the real action log in a temp dir. Each row crosses every layer so a seam that only one unit test pins can't
 * drift unnoticed. Review Focus 1, 2, 4, 8, 9, 10, 12, 20 end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { COMPUTER_TOOLS, OWN_BUNDLE_PREFIX, computerToolLabel } from '@shared/computerUse'
import { createForgeServer, connectBridge, listForgeTools } from '../mcp/forgeMcp'
import { startCuBridge, cuServiceHandler, type CuBridge } from './cuBridge'
import { createComputerUseService } from './service'
import { executorFactoryFor } from './executor'
import { createActionLog } from './actionLog'
import { fakeDriver } from './fakeDriver'
import { defaultComputerUse } from '../config/schema'
import { clearAppLog, formatAppLog } from '../log/appLog'
import type { CuEvent, CuGate, CuSessionKey } from './types'

const KEY: CuSessionKey = { workspacePath: '/w/int', sessionId: 's-int' }
const LOCAL = { local: true }
const NOTES = { pid: 777, bundleId: 'com.example.notes', name: 'Notes', layer: 0, windowId: 9 }
const MARKER = 'MARKER-hunter2-MARKER'
type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>
const text = (r: unknown) => ((r as { content: Content }).content)[0]?.text ?? ''
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

let root: string
let bridge: CuBridge | undefined
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cu-int-')); clearAppLog() })
afterEach(async () => {
  if (bridge) await bridge.close()
  bridge = undefined
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function stack(o: { front?: typeof NOTES; hit?: typeof NOTES } = {}) {
  const driver = fakeDriver({ front: o.front ?? NOTES, hits: o.hit ?? NOTES, capture: { width: 1280, height: 800 } })
  let clock = 5_000_000
  const now = () => clock
  const sleep = async (ms: number) => { clock += ms }
  const events: CuEvent[] = []
  const notes: string[] = []
  const stoppedTurns: CuSessionKey[] = []
  const settings = () => defaultComputerUse()
  const log = createActionLog(join(root, 'log'))
  let n = 0
  const svc = createComputerUseService({
    driver,
    probe: { status: async () => ({ supported: true, osOK: true, helper: 'ok', screen: true, ax: true }), request: async () => {}, openPane: async () => {} },
    now,
    random: () => `R${(++n).toString().padStart(16, '0')}`,
    emit: (e) => { events.push(e) },
    note: (_k, t) => { notes.push(t) },
    stopTurn: (k) => { stoppedTurns.push(k) },
    titleOf: () => 'Notes 会话',
    settings, ownPid: process.pid, ownAccelerators: () => ['Control+Alt+Command+Escape'], log,
    executorFactory: executorFactoryFor({ now, sleep, settings, ownPid: process.pid, ownAccelerators: () => ['Control+Alt+Command+Escape'], log, hidIsPhysical: () => false }),
    liveAgentChildren: () => [], hidIsPhysical: () => false, saveSettings: () => {},
    configDir: () => bridge?.configDir ?? null,
  })
  bridge = await startCuBridge(join(root, 'computer-use'), cuServiceHandler(svc))
  const mcp = async (token: string) => {
    const server = createForgeServer(connectBridge(bridge!.socketPath, token).send, new Set(listForgeTools(COMPUTER_TOOLS.join(','))))
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'claude-code', version: '9.9.9' })
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }
  const gates = () => events.filter((e): e is { type: 'gate'; gate: CuGate } => e.type === 'gate').map((e) => e.gate)
  /** turn the session on (local), open a local turn, take the first shot and read the vision code */
  const live = async (mode: 'ask' | 'allow') => {
    expect(await svc.setMode(KEY, mode, LOCAL)).toEqual({ ok: true })
    svc.beginTurn(KEY, 'local')
    const c = await mcp(svc.tokenFor(KEY)!)
    const shot = await c.callTool({ name: 'computer_screenshot', arguments: {} })
    expect(shot.isError).toBeFalsy()
    expect(text(shot).startsWith('<untrusted_screen shot="')).toBe(true)
    expect((shot.content as Content)[1]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' })
    const code = driver.captures[0].code!
    expect(code).toMatch(/^[A-Z0-9]{4}$/)
    return { c, code }
  }
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
  return { svc, driver, events, notes, stoppedTurns, gates, live, mcp, walk }
}

describe('ask mode, end to end over MCP', () => {
  it('screenshot → typed marker → gate → local allow → exactly one guarded post; the marker is on the card and nowhere else', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const t = await stack()
    const { c, code } = await t.live('ask')

    const pending = c.callTool({ name: 'computer_type', arguments: { text: MARKER, visionCode: code } })
    await vi.waitFor(() => expect(t.gates()).toHaveLength(1))
    const g = t.gates()[0]
    expect(g.kind).toBe('action')
    expect(g.action!.text).toBe(MARKER)
    expect(t.driver.posts).toHaveLength(0)
    // a remote client can't answer it; the local one can
    expect(await t.svc.resolve(g.id, 'allow', { local: false })).toBe(false)
    expect(t.driver.posts).toHaveLength(0)
    expect(await t.svc.resolve(g.id, 'allow', LOCAL)).toBe(true)
    const r = await pending
    expect(r.isError).toBeFalsy()

    expect(t.driver.posts).toHaveLength(1)
    const { action, guard } = t.driver.posts[0]
    expect(action).toMatchObject({ kind: 'type', text: MARKER })
    expect(guard.denyPids).toContain(process.pid)
    expect(guard.denyBundlePrefixes).toContain(OWN_BUNDLE_PREFIX)
    expect(guard.expectPid).toBe(NOTES.pid)
    expect(t.driver.captures[0].maskPids).toContain(process.pid)

    // nowhere but the card: MCP result, console, app log, every file on disk, the tool card title
    expect(JSON.stringify(r)).not.toContain(MARKER)
    for (const sp of spies) expect(JSON.stringify(sp.mock.calls)).not.toContain(MARKER)
    expect(formatAppLog()).not.toContain(MARKER)
    const files = t.walk(root)
    expect(files.some((f) => f.endsWith('actions.jsonl'))).toBe(true)
    for (const f of files) {
      if (statSync(f).isFile() && !f.endsWith('.sock')) expect(readFileSync(f, 'utf8')).not.toContain(MARKER)
    }
    expect(computerToolLabel('mcp__forge__computer_type', { text: MARKER })).toBe(`电脑 · 输入 ${MARKER.length} 字`)
    const onDisk = readFileSync(files.find((f) => f.endsWith('actions.jsonl'))!, 'utf8')
    expect(onDisk).toContain(`"textLen":${MARKER.length}`)
  })

  it('the first input without the vision code is refused before any gate or post', async () => {
    const t = await stack()
    const { c } = await t.live('ask')
    const r = await c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('vision_code')
    expect(t.gates()).toHaveLength(0)
    expect(t.driver.posts).toHaveLength(0)
  })

  it('a click on our own window is own_window with zero posts and no gate', async () => {
    const own = { ...NOTES, pid: process.pid, bundleId: 'com.zghua.myflowforge.test', name: 'myFlowForge Test' }
    const t = await stack({ hit: own })
    const { c, code } = await t.live('allow')
    const r = await c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10, visionCode: code } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('own_window')
    expect(t.gates()).toHaveLength(0)
    expect(t.driver.posts).toHaveLength(0)
  })

  it('two calls sent together: the second waits behind the first one\'s gate and posts nothing until it is answered', async () => {
    const t = await stack()
    const { c, code } = await t.live('ask')
    const p1 = c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10, visionCode: code } })
    const p2 = c.callTool({ name: 'computer_click', arguments: { x: 20, y: 20, visionCode: code } })
    await vi.waitFor(() => expect(t.gates()).toHaveLength(1))
    await flush()
    expect(t.gates()).toHaveLength(1)
    expect(t.driver.posts).toHaveLength(0)
    await t.svc.resolve(t.gates()[0].id, 'allow', LOCAL)
    expect((await p1).isError).toBeFalsy()
    await vi.waitFor(() => expect(t.gates()).toHaveLength(2))
    expect(t.driver.posts).toHaveLength(1)
    await t.svc.resolve(t.gates()[1].id, 'deny', LOCAL)
    const r2 = await p2
    expect(r2.isError).toBe(true)
    expect(text(r2)).toContain('denied')
    expect(t.driver.posts).toHaveLength(1)
  })
})

describe('stop and lock, end to end', () => {
  it('stop while a gate is pending: the call ends stopped, the gate is gone, the turn is stopped, the token is dead', async () => {
    const t = await stack()
    const { c, code } = await t.live('ask')
    const token = t.svc.tokenFor(KEY)!
    const pending = c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10, visionCode: code } })
    await vi.waitFor(() => expect(t.gates()).toHaveLength(1))
    t.svc.stop(KEY, 'user')
    const r = await pending
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('stopped')
    expect(t.svc.pendingGates()).toHaveLength(0)
    expect(t.stoppedTurns).toEqual([KEY])
    expect(t.svc.tokenFor(KEY)).toBeNull()
    expect(t.events.some((e) => e.type === 'stopped')).toBe(true)
    // the CLI's next call with the old token
    const c2 = await t.mcp(token)
    expect(text(await c2.callTool({ name: 'computer_screenshot', arguments: {} }))).toContain('not_enabled')
    expect(t.driver.posts).toHaveLength(0)
  })

  it('a lock while a gate is pending: denied, mode off, the lock note, and nothing posts afterwards', async () => {
    const t = await stack()
    const { c, code } = await t.live('allow')
    const token = t.svc.tokenFor(KEY)!
    // Terminal is ask-always, so even allow opens a gate
    t.driver.setHitMap({ ...NOTES, bundleId: 'com.apple.Terminal', name: 'Terminal' })
    const pending = c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10, visionCode: code } })
    await vi.waitFor(() => expect(t.gates()).toHaveLength(1))
    t.svc.onLock()
    const r = await pending
    expect(r.isError).toBe(true)
    expect(t.svc.pendingGates()).toHaveLength(0)
    expect(t.notes).toContain('屏幕已锁定 · 电脑操作已关闭')
    expect(t.svc.tokenFor(KEY)).toBeNull()
    const c2 = await t.mcp(token)
    expect(text(await c2.callTool({ name: 'computer_click', arguments: { x: 1, y: 1, visionCode: code } }))).toContain('not_enabled')
    expect(t.driver.posts).toHaveLength(0)
  })

  it('a screen that locks between the shot and the post refuses with locked and posts nothing', async () => {
    const t = await stack()
    const { c, code } = await t.live('allow')
    t.driver.setStatus({ locked: true })
    const r = await c.callTool({ name: 'computer_click', arguments: { x: 10, y: 10, visionCode: code } })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('locked')
    expect(t.driver.posts).toHaveLength(0)
  })
})

describe('never enabled: nothing on disk', () => {
  it('the renderer\'s mount-time log pull and a session close on a fresh machine create no computer-use dir', async () => {
    const cuRoot = join(root, 'never', 'computer-use')
    const log = createActionLog(cuRoot)
    expect(await log.list(KEY)).toEqual([])
    expect(await log.thumb(KEY, 't0001.jpg')).toBeNull()
    await log.remove(KEY)
    expect(() => statSync(join(root, 'never'))).toThrow()
  })
})
