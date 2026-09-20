import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { App } from './App'
import type { ChatQueueEvent, SessionsFile, WorkspaceMeta } from '@shared/types'

/**
 * 切主机之后,侧栏里那些**按工作区路径累积的事件状态**必须清掉。
 *
 * ★★这一条防的是 2026-09-09 那个 P0 的**第二半**。第一半是工作区列表本身不跟着换
 * (`useHome`,已修);这一半是「运行中」圆点、「N 道门等你」角标、会话列表 ——
 * 它们全是按 `workspacePath` 攒在 App 内存里的,而**两台机器上的工作区路径可以一模一样**
 * (同一个人、同样的目录习惯;自测时更是同一台机器上的同一个路径)。
 * 不清的话:切过去之后新主机的工作区上挂着上一台的圆点和门角标 —— 那是**假的**,
 * 而且比空白危险:人会照着那枚角标点进去找一道根本不存在的门。
 *
 * ★这些状态的唯一来源是**当前这台主机推过来的事件**(连着远程时 `router.localEvent`
 *  只放行「描述这台设备本身」的那几条),所以换主机后重头攒是对的,不是丢数据。
 */

const WS_PATH = '/Users/me/work/ds'   // ★两台机器上同名的那种路径 —— 这条测试的前提

const queueCbs: ((e: ChatQueueEvent) => void)[] = []
const fireQueueEvent = (e: ChatQueueEvent) => { for (const cb of queueCbs) cb(e) }
/** host 状态是**一组**订阅者(useHost / useHostReadySeq / HostSwitcher …),只留最后一个会漏掉别人。 */
const hostCbs: ((s: unknown) => void)[] = []
const pushHost = (s: unknown) => { for (const cb of hostCbs) cb(s) }

const ws = (name: string, path: string): WorkspaceMeta => ({
  name, path, projectCount: 1, workflowId: 'standard', status: 'idle',
  pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '',
} as WorkspaceMeta)

const sessionsFile: SessionsFile = {
  sessions: [{ id: 's1', title: '会话A', mode: 'chat', createdAt: 0 }],
  activeSessionId: 's1',
}

let listWorkspaces: ReturnType<typeof vi.fn>

beforeEach(() => {
  queueCbs.length = 0
  hostCbs.length = 0
  listWorkspaces = vi.fn(async () => [ws('本机那个', WS_PATH)])
  ;(window as any).forge = {
    listWorkspaces,
    openWorkspaceDir: async () => [],
    homeStats: async () => ({}),
    onEngineEvent: () => () => {},
    onNavigateWorkspace: () => () => {},
    onSetupEvent: () => () => {},
    listProjects: async () => [], listWorkflows: async () => [],
    detectProviders: async () => [],
    addProject: async () => [], deleteProject: async () => [],
    createWorkspace: vi.fn(), startRun: vi.fn(async () => ({})), resolve: () => {},
    getSettings: async () => ({}), setSettings: async (s: any) => s, onSettingsChanged: () => () => {},
    getWorkspace: async () => null, runWorkspace: vi.fn(async () => {}),
    lastRun: vi.fn(async () => null),
    sessionList: vi.fn(async () => sessionsFile),
    chatHistory: async () => [], sendChat: async () => ({}), onChatEvent: () => () => {},
    onChatQueueEvent: (cb: (e: ChatQueueEvent) => void) => {
      queueCbs.push(cb)
      return () => { const i = queueCbs.indexOf(cb); if (i >= 0) queueCbs.splice(i, 1) }
    },
    onHostStatus: (cb: (s: unknown) => void) => {
      hostCbs.push(cb)
      return () => { const i = hostCbs.indexOf(cb); if (i >= 0) hostCbs.splice(i, 1) }
    },
    hostsStatus: async () => ({ hostId: null, label: '本机', state: { status: 'local' } }),
    hostsList: async () => [],
    openFiles: async () => [], savePaste: vi.fn(),
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    getUpdate: async () => ({ currentVersion: '1.0.0', info: null }),
    checkUpdate: async () => {}, startUpdate: async () => {}, onUpdateEvent: () => () => {},
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], installExamplePlugin: async () => {},
    onPluginsChanged: () => () => {},
  }
})

const busyOn = (path: string): ChatQueueEvent => ({
  workspacePath: path, busy: true, queue: [],
  running: { id: 't1', text: 'do a', sessionId: 's1' },
  runningTurns: [{ id: 't1', text: 'do a', sessionId: 's1' }],
  runningSessionId: 's1', runningSessionIds: ['s1'],
} as ChatQueueEvent)

describe('切主机之后,上一台的状态不许留在屏幕上', () => {
  it('★★「运行中」不许跟着路径漂到新主机的同名工作区上', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(screen.queryAllByText('本机那个').length).toBeGreaterThan(0))
    await waitFor(() => expect(queueCbs.length).toBeGreaterThan(0))

    act(() => fireQueueEvent(busyOn(WS_PATH)))
    await waitFor(() => expect(container.querySelectorAll('.ws-item.is-running').length).toBeGreaterThan(0))

    // 切到另一台机器 —— 它上面**同一个路径**也有一个工作区(自测时就是这样)。
    listWorkspaces.mockImplementation(async () => [ws('那台上的', WS_PATH)])
    act(() => pushHost({ hostId: 'h1', label: '那台', state: { status: 'ready', methods: [] } }))

    await waitFor(() => expect(screen.queryAllByText('那台上的').length).toBeGreaterThan(0))
    expect(
      container.querySelectorAll('.ws-item.is-running').length,
      '上一台那个「运行中」圆点跟着路径漂过来了 —— 屏幕在说一件那台机器上没发生的事',
    ).toBe(0)
  })

  it('工作区列表本身也换成新主机那份(useHome 那一半)', async () => {
    render(<App />)
    await waitFor(() => expect(screen.queryAllByText('本机那个').length).toBeGreaterThan(0))

    listWorkspaces.mockImplementation(async () => [ws('那台上的', WS_PATH)])
    act(() => pushHost({ hostId: 'h1', label: '那台', state: { status: 'ready', methods: [] } }))

    await waitFor(() => expect(screen.queryAllByText('那台上的').length).toBeGreaterThan(0))
    expect(screen.queryAllByText('本机那个')).toHaveLength(0)
  })
})
