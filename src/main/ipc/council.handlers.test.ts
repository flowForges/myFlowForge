import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import type { InvokeCtx, MethodTable } from './invokeCtx'
import type { CouncilConfig, CouncilSeat, CouncilState } from '@shared/council'
import type { ChatMessage } from '@shared/types'

// 脚手架照抄 handlers.fast.test.ts。共商这边:席位用假的 runSeat(默认挂着不结束,测试手动放行),
// 检测结果、项目列表都是假的;状态文件真的落在临时工作区里(store 不 mock)。

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, dialog: {}, app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp' } }))
vi.mock('../update/updateChecker', () => ({
  createUpdateChecker: () => ({ start: vi.fn(), stop: vi.fn(), check: vi.fn(async () => {}), current: () => null }),
}))
vi.mock('../run/runStore', () => ({
  RunStore: class { get runDir() { return '/tmp' } getContext() { return null } setContext() {} appendMessage() {} writeArtifact() { return { path: '/tmp/a', kind: 'file' } } saveState() {} }
}))
vi.mock('../mcp/forgeBridge', () => ({ startBridge: vi.fn(() => Promise.resolve({ socketPath: '/tmp/forge.sock', close: () => Promise.resolve() })) }))
vi.mock('../workspace/workspaceList', () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock('../workspace/workspaceRun', () => ({ workspaceToStartRunOpts: vi.fn() }))
vi.mock('../bot/botBridge', () => ({
  botBridge: { attach: vi.fn(), observe: vi.fn(), getStatuses: () => [], connect: vi.fn(), disconnect: vi.fn() },
  genPairing: () => 'PAIR',
}))

const sendTurnMock = vi.fn()
vi.mock('../chat/chatService', () => ({ sendTurn: (...a: any[]) => sendTurnMock(...a), history: vi.fn(() => []) }))
vi.mock('../skills/installSkill', () => ({ removeWorkspaceSkill: vi.fn() }))
const appended: ChatMessage[] = []
vi.mock('../chat/chatStore', () => ({
  appendMessage: vi.fn((_ws: string, _sid: string, m: ChatMessage) => { appended.push(m) }),
  readMessages: vi.fn(() => []),
  readSession: vi.fn(() => undefined),
  sessionLastMessageMtime: vi.fn(() => undefined),
}))
vi.mock('../chat/delegate', () => ({ makeRunDelegate: () => vi.fn(), cancelWorkspaceDelegates: vi.fn(), listActiveDelegates: () => [] }))
const sessionFile = () => ({ sessions: [{ id: 's1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's1' })
vi.mock('../chat/sessionStore', () => ({
  readSessions: vi.fn(() => sessionFile()),
  getSession: vi.fn(() => sessionFile().sessions[0]),
  setSessionPermission: vi.fn(() => sessionFile()), setSessionWorkflow: vi.fn(() => sessionFile()),
  newSession: vi.fn(() => sessionFile()), switchSession: vi.fn(() => sessionFile()),
  closeSession: vi.fn(() => sessionFile()), renameSession: vi.fn(() => sessionFile()),
  setSessionMode: vi.fn(() => sessionFile()), setSessionModel: vi.fn(() => sessionFile()),
  setSessionBrowserUse: vi.fn(() => sessionFile()), setSessionFast: vi.fn(() => sessionFile()),
  continueFrom: vi.fn(() => sessionFile()), autoNameIfDefault: vi.fn(),
}))
vi.mock('../config/store', () => ({
  readSettings: () => ({ agentProxy: '', appProxy: '', pinnedWorkspaces: [], fullAccessAck: {}, botBridge: {} }),
  writeSettings: vi.fn(),
  readProjects: () => ({ projects: [] }), writeProjects: vi.fn(),
  readWorkflows: () => ({ workflows: [] }), writeWorkflows: vi.fn(),
  readCustomStages: () => ({ stages: [] }), upsertCustomStage: vi.fn(() => []), deleteCustomStage: vi.fn(() => []),
  registerWorkspace: vi.fn(), readWorkspace: vi.fn(), writeWorkspace: vi.fn(),
  readWorkspaceRegistry: () => [],
  readAgentsConfig: () => ({ providers: [], custom: [] }),
  isFullAccessAcked: () => false, ackFullAccess: vi.fn(),
}))
vi.mock('../workspace/workspaceService', () => ({ createWorkspace: vi.fn(), editWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn() }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))
vi.mock('../plugins/pluginStore', () => ({ installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []) }))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn(), setProviderModels: vi.fn(), setProviderTimezone: vi.fn() }))

// 检测:claude / codex / gemini 装了,qwen 没装
const detected = [
  { id: 'claude', displayName: 'Claude', installed: true, models: [] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [] },
  { id: 'gemini', displayName: 'Gemini', installed: true, models: [] },
  { id: 'qwen', displayName: 'Qwen', installed: false, models: [] },
  { id: 'cursor', displayName: 'Cursor', installed: true, models: [] },
]
vi.mock('../agents/detectCache', () => ({ cachedDetectProviders: vi.fn(async () => detected), invalidateDetectCache: vi.fn() }))

const PROJECT = '/repo/app'
const collectMaterialsMock = vi.fn(async (_m?: unknown) => '')
vi.mock('../council/materials', () => ({
  listCouncilProjects: vi.fn(() => [{ name: 'app', cwd: PROJECT }]),
  collectMaterials: (m?: unknown) => collectMaterialsMock(m),
}))

// 假席位:onStart 后挂着,直到测试调用 release()
type Pending = { seat: string; finish: () => void }
const pending: Pending[] = []
const seatCwds: string[] = []
vi.mock('../council/seatRunner', async (orig) => {
  const real = await orig<typeof import('../council/seatRunner')>()
  return {
    ...real,
    runSeat: (_cid: string, seat: CouncilSeat, _prompt: string, deps: { cwd: string }, cb: { onStart(id: string): void }) => {
      const msgId = `m-${seat.id}-${pending.length}`
      seatCwds.push(deps.cwd)
      cb.onStart(msgId)
      let settle!: (r: unknown) => void
      const done = new Promise(r => { settle = r })
      pending.push({ seat: seat.id, finish: () => settle({ ok: true, msgId, text: `${seat.id} says` }) })
      return { done, cancel: () => settle({ ok: false, msgId, error: 'cancelled' }), resumed: false }
    },
  }
})

const seat = (id: string, provider = 'codex', model = `m-${id}`): CouncilSeat => ({ id, provider, model, label: `${provider} · ${id}` })
const cfg = (over: Partial<CouncilConfig> = {}): CouncilConfig => ({
  topic: '怎么设计缓存', attachments: [],
  seats: [seat('A'), seat('B', 'gemini')], leader: seat('L', 'claude'),
  mode: { kind: 'rounds', rounds: 2 },
  ...over,
})

const LOCAL: InvokeCtx = { emit: () => {}, client: { id: 'local', label: '本机' } }
const PHONE: InvokeCtx = { emit: () => {}, client: { id: 'phone-1', label: 'iPhone' } }

let ws: string
let events: { ch: string; payload: any }[]
let table: MethodTable
let mod: typeof import('./handlers')

async function boot() {
  vi.resetModules()
  events = []
  mod = await import('./handlers')
  table = mod.registerIpc((ch, payload) => { events.push({ ch, payload }) }, {}, fakeHost())
}
// async:同步抛的错和 ipcMain.handle 一样变成 reject
const call = async (ch: string, a: unknown, ctx: InvokeCtx = LOCAL) => table[ch](ctx, a)
const flush = () => new Promise(r => setTimeout(r, 5))
const releaseAll = async () => { for (const p of pending.splice(0)) p.finish(); await flush() }

beforeEach(async () => {
  ws = mkdtempSync(join(tmpdir(), 'council-ipc-'))
  appended.length = 0
  pending.length = 0
  seatCwds.length = 0
  sendTurnMock.mockReset().mockResolvedValue(undefined)
  collectMaterialsMock.mockReset().mockResolvedValue('')
  await boot()
})
afterEach(() => {
  mod.shutdownCouncils()
  rmSync(ws, { recursive: true, force: true })
})

describe('council:start', () => {
  it('rejects an invalid config with its error code', async () => {
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg({ topic: '  ' }) })).rejects.toThrow('topic-empty')
  })

  it('rejects a cursor seat (not a council CLI) even though it is installed', async () => {
    const config = cfg({ seats: [seat('A'), seat('B', 'cursor')] })
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config })).rejects.toThrow('seat-provider-invalid')
  })

  it('rejects a seat or leader whose CLI is not installed', async () => {
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg({ seats: [seat('A'), seat('B', 'qwen')] }) }))
      .rejects.toThrow('provider-not-installed')
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg({ leader: seat('L', 'qwen') }) }))
      .rejects.toThrow('provider-not-installed')
  })

  it('rejects a materials project that is not one of the workspace projects', async () => {
    const config = cfg({ materials: { projectCwd: '/etc' } })
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config })).rejects.toThrow('project-invalid')
  })

  it('rejects materials-invalid when the materials cannot be collected, and starts nothing', async () => {
    collectMaterialsMock.mockRejectedValueOnce(new Error('invalid git range: HEAD~3'))
    const config = cfg({ materials: { projectCwd: PROJECT, diff: { range: 'HEAD~3' } } })
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config })).rejects.toThrow('materials-invalid')
    expect(collectMaterialsMock).toHaveBeenCalledWith(config.materials)
    await flush()
    expect(await call(CH.councilList, { workspacePath: ws, sessionId: 's1' })).toEqual([])
    expect(appended).toEqual([])
  })

  it('rejects with busy while a chat turn is running or queued in the session', async () => {
    sendTurnMock.mockReturnValue(new Promise(() => {}))
    await call(CH.chatSend, { workspacePath: ws, sessionId: 's1', agent: 'codex', agentLabel: 'Codex', model: 'x', text: 'hi', attachments: [] })
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })).rejects.toThrow('busy')
    // 别的会话不受影响
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's2', config: cfg() })).resolves.toEqual(expect.any(String))
  })

  it('rejects with busy while a workflow run is active or queued in the workspace (R13)', async () => {
    const { Run2Manager } = await import('../run/manager')
    const spy = vi.spyOn(Run2Manager.prototype, 'isActive').mockImplementation((w: string) => w === ws)
    try {
      await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })).rejects.toThrow('busy')
    } finally { spy.mockRestore() }
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })).resolves.toEqual(expect.any(String))
  })

  it('starts without waiting for the council, list shows it running, state is broadcast, last config is saved', async () => {
    const config = cfg({ materials: { projectCwd: PROJECT } })
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config }) as string
    expect(typeof id).toBe('string')
    await flush()
    const list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list.map(s => [s.id, s.status])).toEqual([[id, 'running']])
    expect(events.some(e => e.ch === CH.councilState && e.payload.id === id)).toBe(true)
    expect(events.some(e => e.ch === CH.chatEvent && e.payload.sessionId === 's1')).toBe(true)
    // 选了项目就在项目目录里跑
    expect(seatCwds.length).toBeGreaterThan(0)
    expect(seatCwds.every(c => c === PROJECT)).toBe(true)
    const last = await call(CH.councilLastConfig, { workspacePath: ws }) as Record<string, unknown>
    expect(last).toMatchObject({ seats: config.seats, leader: config.leader, mode: config.mode })
    expect(last.topic).toBeUndefined()
    // 同一会话再开 → busy
    await expect(call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config })).rejects.toThrow('busy')
  })
})

describe('chat:send while a council runs (M2)', () => {
  const send = (sessionId: string) =>
    call(CH.chatSend, { workspacePath: ws, sessionId, agent: 'codex', agentLabel: 'Codex', model: 'x', text: 'hi', attachments: [] })

  it('rejects busy in the session of a running council; other sessions and paused councils are fine', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await expect(send('s1')).rejects.toThrow('busy')
    await expect(send('s2')).resolves.toBeUndefined()
    await call(CH.councilPause, { councilId: id })
    await releaseAll()
    await expect(send('s1')).resolves.toBeUndefined()
  })
})

describe('council controls', () => {
  it('interject from a remote client carries via; from this machine it does not', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await call(CH.councilInterject, { councilId: id, text: '手机上插一句' }, PHONE)
    await call(CH.councilInterject, { councilId: id, text: '本机插一句' }, LOCAL)
    const inter = appended.filter(m => m.council?.stage === 'interject')
    expect(inter.map(m => [m.text, m.via])).toEqual([['手机上插一句', 'iPhone'], ['本机插一句', undefined]])
  })

  it('interject is accepted while waiting between rounds and lands in the next round; resume clears the wait', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await releaseAll()   // 第 1 轮 A、B 说完 → 领导者总结
    await releaseAll()   // 总结完 → 轮间等用户
    let st = (await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]).find(s => s.id === id)!
    expect(st).toMatchObject({ status: 'paused', waitingForUser: true, round: 2 })
    await call(CH.councilInterject, { councilId: id, text: '补一句' })
    expect(appended.filter(m => m.council?.stage === 'interject').map(m => [m.text, m.council!.round])).toEqual([['补一句', 2]])
    await call(CH.councilResume, { councilId: id })
    await flush()
    st = (await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]).find(s => s.id === id)!
    expect(st.status).toBe('running')
    expect(st.waitingForUser).toBeFalsy()
  })

  it('interject is still ignored while paused by the user', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await call(CH.councilPause, { councilId: id })
    await releaseAll()
    await call(CH.councilInterject, { councilId: id, text: '暂停中' })
    expect(appended.some(m => m.council?.stage === 'interject')).toBe(false)
  })

  it('unknown council id → rejects', async () => {
    await expect(call(CH.councilPause, { councilId: 'nope' })).rejects.toThrow('council-not-found')
  })

  it('resume is busy while another council in the same session is running (R9)', async () => {
    const a = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await call(CH.councilPause, { councilId: a })
    await releaseAll()   // 第 1 轮这一批说完 → 暂停生效
    let list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list.find(s => s.id === a)!.status).toBe('paused')
    const b = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await expect(call(CH.councilResume, { councilId: a })).rejects.toThrow('busy')
    await call(CH.councilStop, { councilId: b, mode: 'abort' })
    await call(CH.councilResume, { councilId: a })
    await flush()
    list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list.find(s => s.id === a)!.status).toBe('running')
  })

  it('resume with a new leader checks eligibility the same way start does', async () => {
    const a = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    await call(CH.councilPause, { councilId: a })
    await releaseAll()
    await expect(call(CH.councilResume, { councilId: a, newLeader: seat('L2', 'cursor') })).rejects.toThrow('leader-invalid')
    await expect(call(CH.councilResume, { councilId: a, newLeader: seat('L2', 'qwen') })).rejects.toThrow('provider-not-installed')
    await call(CH.councilResume, { councilId: a, newLeader: seat('L2', 'gemini') })
    await flush()
    const list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list[0]).toMatchObject({ status: 'running', config: { leader: { id: 'L2', provider: 'gemini' } } })
  })

  it('followup before the council is done → rejects', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await expect(call(CH.councilFollowup, { councilId: id, question: '?', target: 'all' })).rejects.toThrow('not-done')
  })
})

describe('council followup pre-flight', () => {
  async function doneCouncil(): Promise<string> {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg({ mode: { kind: 'rounds', rounds: 1 } }) }) as string
    await flush()
    for (let i = 0; i < 5; i++) {
      const list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
      if (list.find(s => s.id === id)!.status === 'done') return id
      await releaseAll()
    }
    throw new Error('council did not finish')
  }

  it('rejects busy while a follow-up is being answered', async () => {
    const id = await doneCouncil()
    await call(CH.councilFollowup, { councilId: id, question: '再说说', target: 'all' })
    await flush()
    await expect(call(CH.councilFollowup, { councilId: id, question: '又一问', target: 'all' })).rejects.toThrow('busy')
    await releaseAll(); await releaseAll()
    await expect(call(CH.councilFollowup, { councilId: id, question: '又一问', target: 'A' })).resolves.toBeUndefined()
  })

  it('rejects target-invalid for an unknown seat', async () => {
    const id = await doneCouncil()
    await expect(call(CH.councilFollowup, { councilId: id, question: '?', target: 'nobody' })).rejects.toThrow('target-invalid')
  })
})

describe('council list / restore / shutdown', () => {
  it('after an app restart the first list restores councils from disk as paused and they can be resumed', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    // 「崩溃」:丢下这张方法表,重开一份
    pending.length = 0
    await boot()
    const list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list.map(s => [s.id, s.status])).toEqual([[id, 'paused']])
    await call(CH.councilResume, { councilId: id })
    await flush()
    const again = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(again[0].status).toBe('running')
  })

  it('shutdownCouncils pauses running councils and persists them', async () => {
    const id = await call(CH.councilStart, { workspacePath: ws, sessionId: 's1', config: cfg() })
    await flush()
    mod.shutdownCouncils()
    await boot()
    const list = await call(CH.councilList, { workspacePath: ws, sessionId: 's1' }) as CouncilState[]
    expect(list.map(s => [s.id, s.status])).toEqual([[id, 'paused']])
  })

  it('council:projects lists the workspace projects', async () => {
    await expect(call(CH.councilProjects, { workspacePath: ws })).resolves.toEqual([{ name: 'app', cwd: PROJECT }])
  })
})
