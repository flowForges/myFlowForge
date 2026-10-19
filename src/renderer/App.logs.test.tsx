import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import type { ChatEvent } from '@shared/types'

// ★ 实时日志的状态不能挂在 App 上:以前每个 token 都 setLogs → 整个 App 重渲。这里用 App 直接渲染、
// 且只靠 App 的 props 驱动的 TerminalPanel 当「App 渲染计数器」—— 100 条日志进来,它一次都不该多渲。
const termRenders = vi.hoisted(() => ({ n: 0 }))
vi.mock('./views/terminal/TerminalPanel', () => ({
  TerminalPanel: () => { termRenders.n++; return null },
}))

import { App } from './App'

const chatCbs: ((e: ChatEvent) => void)[] = []
const fireChat = (e: ChatEvent) => { for (const cb of [...chatCbs]) cb(e) }

beforeEach(() => {
  chatCbs.length = 0
  termRenders.n = 0
  ;(window as any).forge = {
    listWorkspaces: async () => [],
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
    sessionList: vi.fn(async () => ({ sessions: [], activeSessionId: null })),
    chatHistory: async () => [], sendChat: async () => ({}),
    onChatEvent: (cb: (e: ChatEvent) => void) => {
      chatCbs.push(cb)
      return () => { const i = chatCbs.indexOf(cb); if (i >= 0) chatCbs.splice(i, 1) }
    },
    onChatQueueEvent: () => () => {},
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

describe('App · 实时日志不走 App 渲染', () => {
  it('★ 100 条日志事件进来,App 不重渲,日志台照样显示', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(chatCbs.length).toBeGreaterThan(0))
    // 让挂载期的异步加载(设置、插件、更新…)都落定,再取基线。
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    const base = termRenders.n

    // 每条事件各自一个 act —— 和真实 IPC 一样一条一条到,不让 act 的批处理替旧实现遮丑。
    act(() => { fireChat({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'm1', model: 'x' }) })
    for (let i = 0; i < 99; i++) {
      act(() => { fireChat({ workspacePath: '/ws', sessionId: 's1', type: 'assistant-delta', id: 'm1', text: `tok${i} ` }) })
    }
    await waitFor(() => expect(container.querySelector('.logcon-body')?.textContent).toContain('tok98'))
    expect(termRenders.n).toBe(base)
    // 状态栏的「有日志」小点照样亮(它自己订阅,不经 App)。
    expect(container.querySelector('.sb-log.has')).not.toBeNull()
    expect(screen.getByRole('log')).toBeTruthy()
  })
})
