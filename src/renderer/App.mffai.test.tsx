import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { App } from './App'

let alertCb: (a: any) => void

beforeEach(() => {
  alertCb = () => {}
  ;(window as any).forge = {
    listWorkspaces: async () => [], openWorkspaceDir: async () => [], homeStats: async () => ({}),
    onNavigateWorkspace: () => () => {}, onSetupEvent: () => () => {}, cancelSetup: async () => {},
    listProjects: async () => [], listWorkflows: async () => [],
    detectProviders: async () => [], getSettings: async () => ({}), setSettings: async () => ({}), onSettingsChanged: () => () => {},
    getWorkspace: async () => null, onChatEvent: () => () => {}, onChatQueueEvent: () => () => {}, chatHistory: async () => [],
    onChangesEvent: () => () => {}, getUpdate: async () => ({ currentVersion: '1.0.0', info: null }), onUpdateEvent: () => () => {},
    listPlugins: async () => ({ plugins: [], results: {} }), listPluginCatalog: async () => [], onPluginsChanged: () => () => {},
    mffai: {
      state: vi.fn(async () => ({ enabled: false, autostart: true, running: false, dataDir: '/d' })),
      onAlert: (cb: any) => { alertCb = cb; return () => {} },
      onEvent: () => () => {}, tail: async () => ({ events: [] }),
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
})
