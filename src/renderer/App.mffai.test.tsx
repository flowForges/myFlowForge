import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from './App'
import { route } from './mffai/route'

// 铃铛模块只在启用时才被 import(08 §13.6、§15):工厂每被调用一次就是一次 import
const bell = vi.hoisted(() => ({ imports: 0 }))
vi.mock('./mffai/bell', async (importOriginal) => {
  bell.imports++
  return await importOriginal()
})

let alertCb: (a: any) => void
let alertCbs: Set<(a: any) => void>
let settingsCb: (s: any) => void
let eventCbs: Set<(e: any) => void>
let initialSettings: any
const emit = (e: any) => { for (const cb of [...eventCbs]) cb(e) }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  alertCbs = new Set()
  // preload 的 onAlert 每个订阅者都收到(铃铛也订 reset)
  alertCb = (a) => { for (const cb of [...alertCbs]) cb(a) }
  settingsCb = () => {}
  eventCbs = new Set()
  initialSettings = {}
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [], homeStats: async () => ({}),
    onNavigateWorkspace: () => () => {}, onSetupEvent: () => () => {}, cancelSetup: async () => {},
    listProjects: async () => [], listWorkflows: async () => [],
    detectProviders: async () => [], getSettings: async () => initialSettings, setSettings: async () => ({}), onSettingsChanged: (cb: any) => { settingsCb = cb; return () => {} },
    getWorkspace: async () => null, onChatEvent: () => () => {}, onChatQueueEvent: () => () => {}, chatHistory: async () => [],
    onChangesEvent: () => () => {}, getUpdate: async () => ({ currentVersion: '1.0.0', info: null }), onUpdateEvent: () => () => {},
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], onPluginsChanged: () => () => {},
    mffai: {
      state: vi.fn(async () => ({ enabled: false, autostart: true, running: false, dataDir: '/d' })),
      onAlert: (cb: any) => { alertCbs.add(cb); return () => { alertCbs.delete(cb) } },
      onEvent: vi.fn((cb: any) => { eventCbs.add(cb); return () => { eventCbs.delete(cb) } }), tail: async () => ({ events: [] }),
      call: vi.fn(async (method: string) => method === 'memory.proposals.list' ? { items: [] } : { ok: true }),
    },
  }
})

describe('App mff-ai', () => {
  it('tab opens the lazy page', async () => {
    const { container } = render(<App />)
    fireEvent.click(container.querySelector('button[data-go="mffai"]')!)
    expect(await screen.findByText('启用')).toBeInTheDocument()
  })

  it('alert adds a bell notification that switches to the page', async () => {
    const { container } = render(<App />)
    act(() => alertCb({ kind: 'tripped', reason: 'crash-loop' }))
    fireEvent.click(container.querySelector('.tb-bell')!)
    const row = await screen.findByText('已熔断')
    expect(row.closest('.ni-t')?.innerHTML).toContain('<b>mff-ai</b>')
    fireEvent.click(row)
    expect(await screen.findByText('启用')).toBeInTheDocument()
  })

  it('a reset alert creates no notification (R11: pages refetch, the bell stays quiet)', async () => {
    const { container } = render(<App />)
    act(() => alertCb({ kind: 'reset' }))
    act(() => alertCb({ kind: 'restarting' }))
    fireEvent.click(container.querySelector('.tb-bell')!)
    await screen.findByText('重启中')
    expect(container.ownerDocument.querySelectorAll('.ni-t').length).toBe(1)
  })

  it('disabled: mffai.call and mffai.onEvent are never called and the bell module is never imported', async () => {
    const imports = bell.imports
    const { container } = render(<App />)
    await flush()
    fireEvent.click(container.querySelector('.tb-bell')!)
    await flush()
    const m = (window as any).forge.mffai
    expect(m.call).not.toHaveBeenCalled()
    expect(m.onEvent).not.toHaveBeenCalled()
    expect(bell.imports).toBe(imports)
  })

  it('enabled: an approval lands in the bell, 允许 answers it there, approval.resolved removes it; a click routes to its session', async () => {
    initialSettings = { mffai: { enabled: true, autostart: true } }
    route.set({ page: 'debug' })
    const { container } = render(<App />)
    await flush()
    const m = (window as any).forge.mffai
    await waitFor(() => expect(m.onEvent).toHaveBeenCalledTimes(1))
    expect(m.call).toHaveBeenCalledWith('memory.proposals.list', { status: 'pending' })
    act(() => emit({ seq: 1, ts: 1, type: 'approval.requested', sessionId: 's1', payload: { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'echo hi' } }))
    act(() => emit({ seq: 2, ts: 2, type: 'approval.requested', sessionId: 's2', payload: { approvalId: 'a2', turnId: 't1', callId: 'c1', tool: 'write', summary: 'x' } }))
    fireEvent.click(container.querySelector('.tb-bell')!)
    const row = (await screen.findByText('shell')).closest('.notif-item') as HTMLElement
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: '允许' })) })
    expect(m.call).toHaveBeenCalledWith('approval.respond', { approvalId: 'a1', decision: 'allow' })
    expect(screen.getByText('shell')).toBeInTheDocument()
    act(() => emit({ seq: 3, ts: 3, type: 'approval.resolved', sessionId: 's1', payload: { approvalId: 'a1', decision: 'allow', by: 'user' } }))
    expect(screen.queryByText('shell')).toBeNull()
    fireEvent.click(screen.getByText('write'))
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's2' })
    expect(container.querySelector('button[data-go="mffai"]')!.className).toContain('on')
  })

  it('disabling at runtime stops the bell: unsubscribed, its notifications gone, the app own ones kept', async () => {
    initialSettings = { mffai: { enabled: true, autostart: true } }
    const { container } = render(<App />)
    await waitFor(() => expect(eventCbs.size).toBe(1))
    act(() => alertCb({ kind: 'tripped', reason: 'crash-loop' }))
    act(() => emit({ seq: 1, ts: 1, type: 'approval.requested', sessionId: 's1', payload: { approvalId: 'a1', turnId: 't1', callId: 'c1', tool: 'shell', summary: 'x' } }))
    fireEvent.click(container.querySelector('.tb-bell')!)
    await screen.findByText('shell')
    act(() => settingsCb({ mffai: { enabled: false, autostart: true } }))
    await flush()
    expect(eventCbs.size).toBe(0)
    expect(screen.queryByText('shell')).toBeNull()
    expect(screen.getByText('已熔断')).toBeInTheDocument()
  })
})
