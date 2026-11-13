import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CH } from './channels'
import { fakeHost } from '../host/fakeHost'
import { tableCalls } from './testTable'
import { NOOP_CTX, type InvokeCtx, type MethodTable } from './invokeCtx'
import { CLIENT_ONLY, daemonTable } from './channelRouting'
import { COMPUTER_TOOLS, type CuStatus } from '@shared/computerUse'
import type { WorkflowSessionState } from '@shared/workflowSession'
import type { ComputerUseHost } from '../host/capabilities'

/**
 * Computer use, chat turn and IPC side (spec §5.2, V1, V12; Review Focus 2, 3, 5, 15).
 *
 * The real service runs on fakeDriver. The probe, log and bridge are stubs. sendTurn is mocked, so the env each turn
 * would spawn with is read straight off its second argument.
 */

const session: any = { id: 's1', title: '会话一', mode: 'chat', createdAt: 0, permissionMode: 'auto' }
const sessionFile = () => ({ sessions: [session], activeSessionId: 's1' })

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

const botDeps: any = {}
vi.mock('../bot/botBridge', () => ({
  botBridge: {
    attach: (d: any) => Object.assign(botDeps, d),
    observe: vi.fn(), getStatuses: () => [], connect: vi.fn(), disconnect: vi.fn(),
  },
  genPairing: () => 'PAIR',
}))

const sendTurnMock = vi.fn()
vi.mock('../chat/chatService', () => ({ sendTurn: (...a: any[]) => sendTurnMock(...a), history: vi.fn(() => []) }))
vi.mock('../skills/installSkill', () => ({ removeWorkspaceSkill: vi.fn() }))
const appendMessageMock = vi.fn()
vi.mock('../chat/chatStore', () => ({ appendMessage: (...a: any[]) => appendMessageMock(...a), readMessages: vi.fn(() => []), sessionLastMessageMtime: vi.fn(() => undefined) }))
vi.mock('../chat/delegate', () => ({ makeRunDelegate: () => vi.fn(), cancelWorkspaceDelegates: vi.fn() }))
const closeSessionMock = vi.fn(() => sessionFile())
const setSessionPermissionMock = vi.fn(() => sessionFile())
vi.mock('../chat/sessionStore', () => ({
  readSessions: vi.fn(() => sessionFile()),
  getSession: vi.fn((_ws: string, id: string) => (id === 's1' ? session : undefined)),
  setSessionPermission: (...a: any[]) => (setSessionPermissionMock as any)(...a),
  setSessionWorkflow: vi.fn(() => sessionFile()),
  newSession: vi.fn(() => sessionFile()), switchSession: vi.fn(() => sessionFile()),
  closeSession: (...a: any[]) => (closeSessionMock as any)(...a), renameSession: vi.fn(() => sessionFile()),
  setSessionMode: vi.fn(() => sessionFile()), setSessionModel: vi.fn(() => sessionFile()),
  setSessionBrowserUse: vi.fn(() => sessionFile()), setSessionFast: vi.fn(() => sessionFile()),
  continueFrom: vi.fn(() => sessionFile()),
  autoNameIfDefault: vi.fn(),
}))
const writeSettingsMock = vi.fn()
vi.mock('../config/store', () => ({
  readSettings: () => ({ agentProxy: '', appProxy: '', pinnedWorkspaces: [], fullAccessAck: {}, botBridge: {}, computerUse: { provisioned: true, requested: { screen: false, ax: false }, extraBlocked: [], extraAskAlways: [] } }),
  writeSettings: (...a: any[]) => writeSettingsMock(...a),
  readProjects: () => ({ projects: [] }),
  writeProjects: vi.fn(),
  readWorkflows: () => ({ workflows: [] }),
  writeWorkflows: vi.fn(),
  readCustomStages: () => ({ stages: [] }),
  upsertCustomStage: vi.fn(() => []),
  deleteCustomStage: vi.fn(() => []),
  registerWorkspace: vi.fn(),
  unregisterWorkspace: vi.fn(),
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
  readWorkspaceRegistry: () => [],
  readAgentsConfig: () => ({ providers: [], custom: [] }),
  isFullAccessAcked: () => false,
  ackFullAccess: vi.fn(),
}))
vi.mock('../workspace/workspaceService', () => ({ createWorkspace: vi.fn(), editWorkspace: vi.fn() }))
vi.mock('../workspace/workspaceSetup', () => ({ runWorkspaceSetup: vi.fn() }))
vi.mock('../workspace/archiveOps', () => ({ archiveWorkspaceLifecycle: vi.fn(), restoreWorkspaceLifecycle: vi.fn() }))
vi.mock('../workspace/archivedGuard', () => ({ isArchivedWorkspace: vi.fn(() => false) }))
vi.mock('../workspace/deleteWorkspace', () => ({ deleteWorkspace: vi.fn(async () => ({ ok: true })) }))
vi.mock('../workspace/workspaceLifecycle', () => ({ setWorkspaceLifecycle: vi.fn() }))
vi.mock('../plugins/pluginStore', () => ({ installPlugin: vi.fn(), uninstallPlugin: vi.fn(), setPluginEnabled: vi.fn(), readPlugins: vi.fn(() => []) }))
vi.mock('../plugins/pluginSchedulerRef', () => ({
  getPluginScheduler: () => ({ snapshot: vi.fn(() => ({ plugins: [], results: {} })), reconcile: vi.fn(), refresh: vi.fn(() => Promise.resolve()) }),
}))
vi.mock('../plugins/officialCatalog', () => ({ listCatalog: () => [], installOfficial: vi.fn() }))
vi.mock('../agents/refreshModels', () => ({ refreshProviderModels: vi.fn() }))

const WS = '/ws/a'
const KEY = { workspacePath: WS, sessionId: 's1' }
const OK: CuStatus = { supported: true, osOK: true, helper: 'ok', screen: true, ax: true }
const CU_CHANNELS = [
  CH.cuStatus, CH.cuState, CH.cuSetMode, CH.cuResolve, CH.cuStop, CH.cuLog, CH.cuThumb,
  CH.cuRequestPermission, CH.cuOpenSettings, CH.cuRunningApps, CH.cuCollapseMain,
]
const FORGE_KEYS = ['FORGE_SOCKET', 'FORGE_MCP_DIR', 'FORGE_AGENT_ID', 'FORGE_MCP_ENTRY', 'FORGE_TOOLS']
const REMOTE_CTX: InvokeCtx = { emit: () => {}, client: { id: 'phone-1', label: '手机' } }

const chattingWorkflow = (): WorkflowSessionState => ({
  flowId: 'f1', flowName: '需求开发',
  stages: [
    { key: 'a', name: '需求澄清', provider: 'claude', model: 'opus-4.8', scope: 'root' },
    { key: 'b', name: '技术方案', provider: 'claude', model: 'opus-4.8', scope: 'root' },
  ],
  currentIndex: 0, phase: 'chatting', projects: [],
})

let cfgDir = ''
let cwd = ''
beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'cu-h-cfg-'))
  cwd = mkdtempSync(join(tmpdir(), 'cu-h-cwd-'))
  session.permissionMode = 'auto'
  session.workflowSession = undefined
  appendMessageMock.mockReset()
  closeSessionMock.mockReset().mockImplementation(() => sessionFile())
  setSessionPermissionMock.mockReset().mockImplementation(() => sessionFile())
  writeSettingsMock.mockReset()
})
afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

async function boot(o: { status?: Partial<CuStatus>; noCu?: boolean; gateOnRun?: boolean } = {}) {
  vi.resetModules()
  sendTurnMock.mockReset().mockResolvedValue(undefined)
  for (const k of Object.keys(botDeps)) delete botDeps[k]
  const { createComputerUseService } = await import('../computerUse/service')
  const { fakeDriver } = await import('../computerUse/fakeDriver')
  const { defaultComputerUse } = await import('../config/schema')
  const logRemoved: unknown[] = []
  const log = {
    append: vi.fn(async (_k: unknown, e: any) => e),
    list: vi.fn(async () => []),
    thumb: vi.fn(async () => 'THUMB'),
    remove: vi.fn(async (k: unknown) => { logRemoved.push(k) }),
  }
  const probe = {
    status: vi.fn(async () => ({ ...OK, ...o.status })),
    request: vi.fn(async () => {}),
    openPane: vi.fn(async () => {}),
  }
  const gateHolder: { decision?: Promise<string> } = {}
  const service = createComputerUseService({
    driver: fakeDriver(), probe, now: () => Date.now(),
    random: (() => { let n = 0; return () => `R${(++n).toString().padStart(16, '0')}` })(),
    emit: () => {}, note: () => {}, stopTurn: () => {}, titleOf: (k) => `T-${k.sessionId}`,
    settings: () => ({ ...defaultComputerUse(), provisioned: true }),
    ownPid: 4242, ownAccelerators: () => [], log,
    executorFactory: (s) => ({
      run: async (key) => {
        if (o.gateOnRun) {
          const p = s.openGate({ key, kind: 'action', action: { kind: 'click', x: 1, y: 1 } as any })
          gateHolder.decision = p
          return { ok: true, text: await p }
        }
        return { ok: true, text: 'ran' }
      },
    }),
    liveAgentChildren: () => [], hidIsPhysical: () => false, saveSettings: () => {},
    configDir: () => cfgDir,
  })
  const beginTurn = vi.spyOn(service, 'beginTurn')
  const endTurn = vi.spyOn(service, 'endTurn')
  const forget = vi.spyOn(service, 'forget')
  const bridge = vi.fn(async () => ({ socketPath: join(cfgDir, 'forge.sock'), configDir: cfgDir }))
  const collapseMain = vi.fn()
  const runningApps = vi.fn(async () => [{ bundleId: 'com.apple.TextEdit', name: 'TextEdit' }])
  const order: string[] = []
  const provision = vi.fn(() => { order.push('provision') })
  probe.request.mockImplementation(async () => { order.push('request') })
  const cu: ComputerUseHost = { service, probe, bridge, log, collapseMain, runningApps, provision }
  const broadcast = vi.fn()
  const { registerIpc } = await import('./handlers')
  const table: MethodTable = registerIpc(broadcast, {}, fakeHost(o.noCu ? {} : { computerUse: () => cu }))
  const calls = tableCalls(table)
  const call = (ch: string) => {
    const c = calls.find((x: any[]) => x[0] === ch)
    if (!c) throw new Error(`No handler for channel: ${ch}`)
    return c[1]
  }
  const remote = (ch: string, ...a: unknown[]) => table[ch](REMOTE_CTX, ...a)
  const notes = () => broadcast.mock.calls
    .filter((c) => c[0] === CH.chatEvent && c[1]?.type === 'done' && c[1]?.message?.model === '系统')
    .map((c) => c[1].message.text as string)
  return { call, remote, table, service, probe, log, logRemoved, bridge, collapseMain, runningApps, beginTurn, endTurn, forget, notes, broadcast, gateHolder, provision, order }
}

const lastSend = () => sendTurnMock.mock.calls.at(-1)
const lastEnv = (): NodeJS.ProcessEnv => lastSend()?.[1]?.env
const lastPayload = () => lastSend()?.[0]
const sent = (n = 1) => vi.waitFor(() => expect(sendTurnMock).toHaveBeenCalledTimes(n))
const tick = () => new Promise((r) => setTimeout(r, 0))
const msg = (o: Record<string, unknown> = {}) => ({ workspacePath: WS, sessionId: 's1', agent: 'claude', agentLabel: 'Claude', model: 'opus', text: 'hi', attachments: [], ...o })
const noForge = (env: NodeJS.ProcessEnv) => {
  expect(env.FORGE_SOCKET).toBeUndefined()
  expect(env.FORGE_AGENT_ID).toBeUndefined()
  expect(env.FORGE_MCP_DIR).toBeUndefined()
  expect(String(env.FORGE_TOOLS ?? '')).not.toContain('computer_')
}

describe('origin stamping and env injection (Review Focus 3)', () => {
  it('a local composer turn gets the five FORGE_* keys and exactly the computer tools, between beginTurn and endTurn', async () => {
    const h = await boot()
    expect(await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })).toEqual({ ok: true })
    sendTurnMock.mockImplementation(async () => {
      expect(h.beginTurn).toHaveBeenCalledTimes(1)
      expect(h.endTurn).not.toHaveBeenCalled()
    })
    await h.call(CH.chatSend)({}, msg({ origin: 'remote' }))
    await sent()
    const env = lastEnv()
    for (const k of FORGE_KEYS) expect(env[k], k).toBeTruthy()
    expect(env.FORGE_TOOLS).toBe(COMPUTER_TOOLS.join(','))
    expect(env.FORGE_AGENT_ID).toBe(h.service.tokenFor(KEY))
    expect(env.FORGE_MCP_DIR).toBe(cfgDir)
    expect(env.FORGE_SOCKET).toBe(join(cfgDir, 'forge.sock'))
    expect(lastPayload().origin).toBe('local')
    expect(h.beginTurn).toHaveBeenCalledWith(KEY, 'local')
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledWith(KEY))
    expect(h.notes().filter((t) => t.includes('这一轮来自'))).toEqual([])
  })

  it('the local claude turn args carry --allowedTools with all ten mcp__forge__computer_* and --mcp-config', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    await h.call(CH.chatSend)({}, msg())
    await sent()
    const { buildClaudeChatArgs } = await import('../agents/providers/claude')
    const args = buildClaudeChatArgs({ ...lastPayload(), cwd } as any, lastEnv(), 'p')
    const i = args.indexOf('--allowedTools')
    expect(i).toBeGreaterThan(-1)
    const allowed = args.slice(i + 1).filter((a) => a.startsWith('mcp__forge__'))
    expect(allowed).toEqual(COMPUTER_TOOLS.map((t) => `mcp__forge__${t}`))
    const j = args.indexOf('--mcp-config')
    expect(j).toBeGreaterThan(-1)
    expect(args[j + 1].startsWith(cfgDir)).toBe(true)
    expect(existsSync(args[j + 1])).toBe(true)
  })

  it('a remote chatSend with a forged origin:local is stamped remote, gets no tools and one origin note', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    await h.table[CH.chatSend](REMOTE_CTX, msg({ origin: 'local' }))
    await sent()
    noForge(lastEnv())
    expect(lastPayload().origin).toBe('remote')
    expect(h.beginTurn).toHaveBeenCalledWith(KEY, 'remote')
    expect(h.notes().filter((t) => /^这一轮来自 .+ · 电脑操作只对本机输入框发出的消息生效$/.test(t))).toHaveLength(1)
  })

  it('a pet turn (source 宠物) is stamped pet and gets no tools', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    await h.call(CH.chatSend)({}, msg({ origin: 'local' }), '宠物')
    await sent()
    noForge(lastEnv())
    expect(lastPayload().origin).toBe('pet')
    expect(h.notes().filter((t) => t.startsWith('这一轮来自'))).toHaveLength(1)
  })

  it('a bot enqueue is stamped bot and gets no tools', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    botDeps.enqueue(msg({ origin: 'local' }), '飞书')
    await sent()
    noForge(lastEnv())
    expect(lastPayload().origin).toBe('bot')
    expect(h.notes().filter((t) => t.startsWith('这一轮来自'))).toHaveLength(1)
  })

  it('a workflow kick is stamped workflow and gets no tools', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    session.workflowSession = chattingWorkflow()
    await h.call(CH.workflowAdvance)({}, { workspacePath: WS, sessionId: 's1' })
    await sent()
    noForge(lastEnv())
    expect(lastPayload().origin).toBe('workflow')
    expect(h.notes().filter((t) => t.startsWith('这一轮来自'))).toHaveLength(1)
  })

  it('no origin note while the mode is off', async () => {
    const h = await boot()
    botDeps.enqueue(msg(), '飞书')
    await sent()
    noForge(lastEnv())
    expect(h.notes().filter((t) => t.startsWith('这一轮来自'))).toEqual([])
  })

  it('an unstamped payload is non-local: no tools (default-deny, V12)', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    const { cuPreflight, cuBeginTurn } = await import('../computerUse/chatTurn')
    const cu = (await import('../host/fakeHost')).fakeHost({ computerUse: () => ({ service: h.service, probe: h.probe, bridge: h.bridge, log: h.log, provision: h.provision }) }).computerUse!()!
    const pre = await cuPreflight(cu, KEY, { origin: undefined, agent: 'claude', perm: 'full' })
    expect(pre).toEqual({ conflict: null, armed: null })
    const env: NodeJS.ProcessEnv = {}
    const notes: string[] = []
    const end = cuBeginTurn(cu, KEY, { origin: undefined, agent: 'claude', armed: pre.armed, env, mcpEntry: '/x/forgeMcp.js', note: (t) => notes.push(t) })
    noForge(env)
    expect(notes).toHaveLength(1)
    end()
    expect(h.endTurn).toHaveBeenCalledWith(KEY)
  })

  it('a local cursor turn with the mode on gets no FORGE_*, and provisioning writes no .cursor/mcp.json (F30)', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    await h.call(CH.chatSend)({}, msg({ agent: 'cursor', permissionMode: 'full' }))
    await sent()
    noForge(lastEnv())
    expect(lastEnv().FORGE_MCP_ENTRY).toBeUndefined()
    const { provisionForgeMcp } = await import('../agents/forgeMcpProvision')
    provisionForgeMcp('cursor', lastEnv(), cwd)
    expect(existsSync(join(cwd, '.cursor', 'mcp.json'))).toBe(false)
    expect(h.bridge).not.toHaveBeenCalled()
  })

  it('turning the mode off between two turns: the second env has no FORGE_*', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    await h.call(CH.chatSend)({}, msg())
    await sent(1)
    expect(lastEnv().FORGE_AGENT_ID).toBeTruthy()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(1))
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'off' })
    await h.call(CH.chatSend)({}, msg({ text: 'again' }))
    await sent(2)
    noForge(lastEnv())
    expect(lastEnv().FORGE_MCP_ENTRY).toBeUndefined()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(2))
  })

  it('a turn that fails still ends the service turn', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    sendTurnMock.mockRejectedValueOnce(new Error('boom'))
    await h.call(CH.chatSend)({}, msg())
    await sent()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledWith(KEY))
  })

  it('a host without computerUse runs the turn unchanged', async () => {
    const h = await boot({ noCu: true })
    await h.call(CH.chatSend)({}, msg())
    await sent()
    noForge(lastEnv())
    expect(lastEnv().FORGE_MCP_ENTRY).toBeUndefined()
  })
})

describe('conflicts block the whole turn (Review Focus 5)', () => {
  const blocked = async (h: Awaited<ReturnType<typeof boot>>, reason: RegExp) => {
    await vi.waitFor(() => expect(h.notes().some((t) => t.startsWith('⛔ 这一轮没有发出:'))).toBe(true))
    await tick()
    expect(sendTurnMock).not.toHaveBeenCalled()
    const note = h.notes().find((t) => t.startsWith('⛔ 这一轮没有发出:'))!
    expect(note).toMatch(reason)
    // the user's message is kept, and no session setting is touched
    expect(appendMessageMock.mock.calls.some((c) => c[2]?.who === 'user' && c[2]?.text === 'hi')).toBe(true)
    expect(setSessionPermissionMock).not.toHaveBeenCalled()
    expect(writeSettingsMock).not.toHaveBeenCalled()
    expect(h.beginTurn).not.toHaveBeenCalled()
  }

  it('codex with the session on 自动 is blocked', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    const before = JSON.stringify(session)
    await h.call(CH.chatSend)({}, msg({ agent: 'codex', permissionMode: 'auto' }))
    await blocked(h, /codex 接入电脑操作/)
    expect(JSON.stringify(session)).toBe(before)
  })

  it('codex is blocked when the payload says full but the stored session is not 完全访问', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    session.permissionMode = 'auto'
    await h.call(CH.chatSend)({}, msg({ agent: 'codex', permissionMode: 'full' }))
    await blocked(h, /codex 接入电脑操作/)
  })

  it('codex with the session already on 完全访问 runs with the tools', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    session.permissionMode = 'full'
    await h.call(CH.chatSend)({}, msg({ agent: 'codex', permissionMode: 'full' }))
    await sent()
    expect(lastEnv().FORGE_TOOLS).toBe(COMPUTER_TOOLS.join(','))
  })

  it('claude on 只读审阅 is blocked', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    session.permissionMode = 'readonly'
    await h.call(CH.chatSend)({}, msg({ permissionMode: 'readonly' }))
    await blocked(h, /只读审阅/)
  })

  it('a missing Screen Recording grant blocks the turn', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    h.probe.status.mockResolvedValue({ ...OK, screen: false })
    await h.call(CH.chatSend)({}, msg())
    await blocked(h, /屏幕录制/)
  })

  it('a probe that throws blocks the turn instead of letting it through', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    h.probe.status.mockRejectedValue(new Error('helper died'))
    await h.call(CH.chatSend)({}, msg())
    await blocked(h, /电脑操作/)
  })

  it('a bridge that fails to start blocks the turn', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'allow' })
    h.bridge.mockRejectedValue(new Error('EADDRINUSE'))
    await h.call(CH.chatSend)({}, msg())
    await blocked(h, /电脑操作组件无法启动/)
  })

  it('a non-local turn is not blocked by the conflict: it runs without the tools', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    botDeps.enqueue(msg({ agent: 'codex' }), '飞书')
    await sent()
    noForge(lastEnv())
  })
})

describe('session and workspace teardown', () => {
  it('closing (deleting) a session forgets it and removes its log', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    const token = h.service.tokenFor(KEY)
    closeSessionMock.mockImplementation(() => ({ sessions: [], activeSessionId: '' }) as any)
    await h.call(CH.sessionClose)({}, KEY)
    expect(h.forget).toHaveBeenCalledWith(KEY)
    await vi.waitFor(() => expect(h.logRemoved).toEqual([KEY]))
    expect(h.service.modeOf(KEY)).toBe('off')
    expect((await h.service.handle(token!, 'screenshot', {}, {})).ok).toBe(false)
  })

  it('archiving the workspace forgets its sessions but keeps the log', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    await h.call(CH.workspaceArchive)({}, WS)
    expect(h.forget).toHaveBeenCalledWith(KEY)
    expect(h.service.modeOf(KEY)).toBe('off')
    expect(h.log.remove).not.toHaveBeenCalled()
  })

  it('deleting the workspace forgets its sessions and removes their logs', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    await h.call(CH.workspaceDelete)({}, WS)
    expect(h.service.modeOf(KEY)).toBe('off')
    await vi.waitFor(() => expect(h.logRemoved).toEqual([KEY]))
  })
})

describe('computer-use:* handlers (Review Focus 2, 3, 15)', () => {
  it('every computer-use:* method refuses a remote client with not_local and changes nothing', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    const token = h.service.tokenFor(KEY)
    const args: Record<string, unknown> = {
      [CH.cuSetMode]: { ...KEY, mode: 'allow' }, [CH.cuResolve]: { id: 'x', decision: 'allow' },
      [CH.cuStop]: KEY, [CH.cuLog]: KEY, [CH.cuThumb]: { ...KEY, file: 't.jpg' },
      [CH.cuRequestPermission]: { kind: 'screen' }, [CH.cuOpenSettings]: { kind: 'ax' }, [CH.cuState]: KEY,
    }
    for (const ch of CU_CHANNELS) {
      expect(await h.remote(ch, args[ch]), ch).toEqual({ ok: false, code: 'not_local' })
    }
    expect(h.service.modeOf(KEY)).toBe('ask')
    expect(h.service.tokenFor(KEY)).toBe(token)
    expect(h.log.thumb).not.toHaveBeenCalled()
    expect(h.log.list).not.toHaveBeenCalled()
    expect(h.probe.request).not.toHaveBeenCalled()
    expect(h.probe.openPane).not.toHaveBeenCalled()
    expect(h.runningApps).not.toHaveBeenCalled()
    expect(h.collapseMain).not.toHaveBeenCalled()
    expect(h.provision).not.toHaveBeenCalled()
  })

  it('I-1: 授权 provisions through the runtime save before the request runs, for either kind', async () => {
    const h = await boot()
    expect(await h.call(CH.cuRequestPermission)({}, { kind: 'ax' })).toEqual({ ok: true })
    expect(h.order).toEqual(['provision', 'request'])
    await h.call(CH.cuRequestPermission)({}, { kind: 'screen' })
    expect(h.order).toEqual(['provision', 'request', 'provision', 'request'])
    expect(await h.call(CH.cuRequestPermission)({}, { kind: 'camera' })).toEqual({ ok: false, code: 'invalid_args' })
    expect(h.provision).toHaveBeenCalledTimes(2)
  })

  it('I-1: a request that rejects still leaves the install provisioned', async () => {
    const h = await boot()
    h.probe.request.mockImplementationOnce(async () => { throw new Error('helper_failed') })
    await expect(Promise.resolve(h.call(CH.cuRequestPermission)({}, { kind: 'ax' }))).rejects.toThrow()
    expect(h.provision).toHaveBeenCalledTimes(1)
  })

  it('set-mode from a remote client leaves the mode off', async () => {
    const h = await boot()
    expect(await h.remote(CH.cuSetMode, { ...KEY, mode: 'allow' })).toEqual({ ok: false, code: 'not_local' })
    expect(h.service.modeOf(KEY)).toBe('off')
  })

  it('local calls reach the service, probe, log and host hooks', async () => {
    const h = await boot()
    expect(await h.call(CH.cuStatus)({})).toEqual(OK)
    expect(await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })).toEqual({ ok: true })
    const st = await h.call(CH.cuState)({})
    expect(st.sessions).toEqual([{ ...KEY, mode: 'ask', title: 'T-s1' }])
    expect(st.gates).toEqual([])
    expect(await h.call(CH.cuThumb)({}, { ...KEY, file: 't.jpg' })).toBe('THUMB')
    expect(h.log.thumb).toHaveBeenCalledWith(KEY, 't.jpg')
    expect(await h.call(CH.cuLog)({}, KEY)).toEqual([])
    expect(await h.call(CH.cuRunningApps)({})).toEqual([{ bundleId: 'com.apple.TextEdit', name: 'TextEdit' }])
    await h.call(CH.cuCollapseMain)({})
    expect(h.collapseMain).toHaveBeenCalledTimes(1)
    await h.call(CH.cuOpenSettings)({}, { kind: 'ax' })
    expect(h.probe.openPane).toHaveBeenCalledWith('ax')
    await h.call(CH.cuRequestPermission)({}, { kind: 'screen' })
    expect(h.probe.request).toHaveBeenCalledWith('screen')
    expect(h.probe.openPane).toHaveBeenCalledWith('screen')
    expect(writeSettingsMock.mock.calls.at(-1)?.[0]?.computerUse?.requested).toEqual({ screen: true, ax: false })
    await h.call(CH.cuStop)({}, KEY)
    expect(h.service.modeOf(KEY)).toBe('off')
  })

  it('bad arguments are refused before reaching the service', async () => {
    const h = await boot()
    expect(await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'yolo' })).toEqual({ ok: false, code: 'invalid_args' })
    expect(await h.call(CH.cuSetMode)({}, { workspacePath: 1, sessionId: 's1', mode: 'ask' })).toEqual({ ok: false, code: 'invalid_args' })
    expect(await h.call(CH.cuRequestPermission)({}, { kind: 'camera' })).toEqual({ ok: false, code: 'invalid_args' })
    expect(await h.call(CH.cuResolve)({}, { id: 'x', decision: 'continue!' })).toEqual({ ok: false, code: 'invalid_args' })
    expect(h.service.modeOf(KEY)).toBe('off')
    expect(h.probe.request).not.toHaveBeenCalled()
  })

  it('a host without computerUse answers supported:false and unsupported', async () => {
    const h = await boot({ noCu: true })
    expect((await h.call(CH.cuStatus)({})).supported).toBe(false)
    expect(await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })).toEqual({ ok: false, code: 'unsupported' })
    expect(await h.call(CH.cuResolve)({}, { id: 'x', decision: 'allow' })).toEqual({ ok: false, code: 'unsupported' })
    expect(await h.call(CH.cuRunningApps)({})).toEqual([])
    expect(await h.call(CH.cuLog)({}, KEY)).toEqual([])
    expect(await h.call(CH.cuThumb)({}, { ...KEY, file: 't.jpg' })).toBeNull()
  })

  it('gates: remote resolve, chatResolve, the bot bridge and 完全访问 can not answer one; local resolve can', async () => {
    const h = await boot({ gateOnRun: true })
    session.permissionMode = 'full'
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    // open a local turn and a running call that waits on a gate
    let release!: () => void
    sendTurnMock.mockImplementation(() => new Promise<void>((r) => { release = r }))
    await h.call(CH.chatSend)({}, msg({ permissionMode: 'full' }))
    await sent()
    const call = h.service.handle(h.service.tokenFor(KEY)!, 'click', { x: 1, y: 1 }, {})
    await vi.waitFor(() => expect(h.service.pendingGates()).toHaveLength(1))
    const id = h.service.pendingGates()[0].id

    expect(await h.remote(CH.cuResolve, { id, decision: 'allow' })).toEqual({ ok: false, code: 'not_local' })
    expect(botDeps.resolveChatGate(id, 'allow')).toBe(false)
    await h.call(CH.chatResolve)({}, { id, decision: 'allow', workspacePath: WS })
    const snap = await h.call(CH.chatGateState)({}, { workspacePath: WS })
    expect(JSON.stringify(snap)).not.toContain(id)
    await h.call(CH.sessionSetPermission)({}, { ...KEY, mode: 'full' })
    await tick()
    expect(h.service.pendingGates().map((g) => g.id)).toEqual([id])
    // the chat confirm path was never asked
    expect(h.broadcast.mock.calls.some((c) => c[1]?.type === 'confirm-request')).toBe(false)

    expect(await h.call(CH.cuResolve)({}, { id, decision: 'allow' })).toEqual({ ok: true })
    expect(await call).toEqual({ ok: true, text: 'allow' })
    release()
  })
})

describe('routing (V1, Review Focus 15)', () => {
  it('all eleven computer-use:* methods are CLIENT_ONLY and absent from daemonTable', async () => {
    const h = await boot()
    for (const ch of CU_CHANNELS) {
      expect(CLIENT_ONLY.has(ch), ch).toBe(true)
      expect(h.table[ch], ch).toBeTypeOf('function')
    }
    const d = daemonTable(h.table)
    expect(Object.keys(d).filter((k) => k.startsWith('computer-use:'))).toEqual([])
    expect(CU_CHANNELS.every((c) => c.startsWith('computer-use:'))).toBe(true)
    expect(new Set(CU_CHANNELS).size).toBe(11)
    expect(CH.cuEvent).toBe('computer-use:event')
  })

  it('computer-use:thumb called directly with a non-local client gives not_local', async () => {
    const h = await boot()
    expect(await h.table[CH.cuThumb](REMOTE_CTX, { ...KEY, file: 't.jpg' })).toEqual({ ok: false, code: 'not_local' })
    expect(await h.table[CH.cuThumb](NOOP_CTX, { ...KEY, file: 't.jpg' })).toBe('THUMB')
  })
})

describe('review fixes: token config file, adopted turns, fail-closed local check', () => {
  const cfgFile = async (token: string) => (await import('../agents/mcpConfig')).forgeMcpConfigFile(cfgDir, token)
  const writeArgs = async () => {
    const { buildClaudeChatArgs } = await import('../agents/providers/claude')
    return buildClaudeChatArgs({ ...lastPayload(), cwd } as any, lastEnv(), 'p')
  }
  const holdTurn = () => {
    let release!: () => void
    sendTurnMock.mockImplementation(() => new Promise<void>((r) => { release = r }))
    return () => release()
  }

  it('a local turn with no computer call: the config file is gone when the turn ends', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    const release = holdTurn()
    await h.call(CH.chatSend)({}, msg())
    await sent()
    await writeArgs()
    const f = await cfgFile(h.service.tokenFor(KEY)!)
    expect(existsSync(f)).toBe(true)
    release()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(1))
    expect(existsSync(f)).toBe(false)
  })

  it('the second local turn: its first computer call deletes the rewritten file again', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    const token = h.service.tokenFor(KEY)!
    const f = await cfgFile(token)
    // turn 1: first call deletes the file
    let release = holdTurn()
    await h.call(CH.chatSend)({}, msg())
    await sent(1)
    await writeArgs()
    await h.service.handle(token, 'screenshot', {}, {})
    expect(existsSync(f)).toBe(false)
    release()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(1))
    // turn 2: the spawn path writes it again; the first call of this turn deletes it too
    release = holdTurn()
    await h.call(CH.chatSend)({}, msg({ text: 'two' }))
    await sent(2)
    await writeArgs()
    expect(existsSync(f)).toBe(true)
    await h.service.handle(token, 'screenshot', {}, {})
    expect(existsSync(f)).toBe(false)
    release()
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(2))
  })

  it('an adopted turn gets a copy of env without the five FORGE_* keys and writes no config file', async () => {
    const h = await boot()
    await h.call(CH.cuSetMode)({}, { ...KEY, mode: 'ask' })
    await h.call(CH.chatSend)({}, msg())
    await sent(1)
    const turnEnv = lastEnv()
    const background = lastSend()![1].background
    await vi.waitFor(() => expect(h.endTurn).toHaveBeenCalledTimes(1))
    background.openTurn(() => {}, () => true)
    await sent(2)
    const adoptedEnv = lastEnv()
    expect(adoptedEnv).not.toBe(turnEnv)
    for (const k of FORGE_KEYS) expect(adoptedEnv[k], k).toBeUndefined()
    // the turn's own env is untouched
    expect(turnEnv.FORGE_AGENT_ID).toBe(h.service.tokenFor(KEY))
    const { buildClaudeChatArgs } = await import('../agents/providers/claude')
    const args = buildClaudeChatArgs({ ...lastPayload(), cwd } as any, adoptedEnv, 'p')
    expect(args).not.toContain('--mcp-config')
    expect(existsSync(await cfgFile(h.service.tokenFor(KEY)!))).toBe(false)
  })

  it('a caller with no client at all is refused (fail closed)', async () => {
    const h = await boot()
    const bare: InvokeCtx = { emit: () => {} }
    for (const ch of CU_CHANNELS) expect(await h.table[ch](bare, { ...KEY, mode: 'ask', file: 't', kind: 'ax', id: 'x', decision: 'deny' }), ch).toEqual({ ok: false, code: 'not_local' })
    expect(h.service.modeOf(KEY)).toBe('off')
  })
})
