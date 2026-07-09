import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Titlebar } from './Titlebar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import type { AgentState } from '@shared/types'

// ── Titlebar ─────────────────────────────────────────────────────────────────

describe('Titlebar', () => {
  const baseProps = {
    collapsed: false,
    onToggleSidebar: vi.fn(),
    view: 'ws' as const,
    onView: vi.fn(),
    crumb: 'design-system',
    notifs: [],
    updateAvailable: false,
    notifOpen: false,
    onToggleNotif: vi.fn(),
    onOpenUpgrade: vi.fn(),
    onMarkAllRead: vi.fn(),
    onClearAllNotif: vi.fn(),
  }

  it('renders 首页 and 工作区 segment buttons', () => {
    render(<Titlebar {...baseProps} />)
    expect(screen.getByText('首页')).toBeInTheDocument()
    expect(screen.getByText('工作区')).toBeInTheDocument()
  })

  it('clicking the sidebar-toggle calls onToggleSidebar', () => {
    const onToggleSidebar = vi.fn()
    render(<Titlebar {...baseProps} onToggleSidebar={onToggleSidebar} />)
    const toggleBtn = screen.getByTitle('折叠侧栏')
    fireEvent.click(toggleBtn)
    expect(onToggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('clicking 工作区 calls onView("ws")', () => {
    const onView = vi.fn()
    render(<Titlebar {...baseProps} view="home" onView={onView} />)
    fireEvent.click(screen.getByText('工作区'))
    expect(onView).toHaveBeenCalledWith('ws')
  })

  it('clicking 首页 calls onView("home")', () => {
    const onView = vi.fn()
    render(<Titlebar {...baseProps} view="ws" onView={onView} />)
    fireEvent.click(screen.getByText('首页'))
    expect(onView).toHaveBeenCalledWith('home')
  })

  it('active segment button has "on" class', () => {
    render(<Titlebar {...baseProps} view="ws" />)
    const wsBtn = screen.getByText('工作区')
    expect(wsBtn).toHaveClass('on')
    expect(screen.getByText('首页')).not.toHaveClass('on')
  })

  it('renders crumb text', () => {
    render(<Titlebar {...baseProps} crumb="my-feature" />)
    expect(screen.getByText(/my-feature/)).toBeInTheDocument()
  })

  it('renders inspector-toggle button', () => {
    render(<Titlebar {...baseProps} />)
    expect(screen.getByTitle('折叠面板')).toBeInTheDocument()
  })

  it('renders settings-gear button', () => {
    render(<Titlebar {...baseProps} />)
    expect(screen.getByTitle('设置')).toBeInTheDocument()
  })

  it('renders the notification bell button', () => {
    render(<Titlebar {...baseProps} />)
    expect(screen.getByTitle('通知')).toBeInTheDocument()
  })

  it('settings button calls onOpenSettings when provided', () => {
    const onOpenSettings = vi.fn()
    render(<Titlebar {...baseProps} onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByTitle('设置'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('inspector-toggle button calls onToggleInspector when provided', () => {
    const onToggleInspector = vi.fn()
    render(<Titlebar {...baseProps} onToggleInspector={onToggleInspector} />)
    fireEvent.click(screen.getByTitle('折叠面板'))
    expect(onToggleInspector).toHaveBeenCalledTimes(1)
  })
})

// ── Sidebar ───────────────────────────────────────────────────────────────────

describe('Sidebar', () => {
  const groups = [
    {
      key: 'active',
      label: '进行中',
      items: [
        { id: 'ws-1', name: 'design-system', sub: 'feat/tokens', status: 'run' as AgentState },
      ],
    },
    {
      key: 'recent',
      label: '最近',
      items: [],
    },
  ]

  const baseProps = {
    groups,
    activeId: 'ws-1',
    onSelect: vi.fn(),
    onNew: vi.fn(),
    collapsed: false,
  }

  it('renders 进行中 group label', () => {
    render(<Sidebar {...baseProps} />)
    expect(screen.getByText('进行中')).toBeInTheDocument()
  })

  it('renders 最近 group label', () => {
    render(<Sidebar {...baseProps} />)
    expect(screen.getByText('最近')).toBeInTheDocument()
  })

  it('renders workspace item by name', () => {
    render(<Sidebar {...baseProps} />)
    expect(screen.getByText('design-system')).toBeInTheDocument()
  })

  it('marks an idle workspace as running (rail + 运行中 pill) when live (an agent is executing)', () => {
    const liveGroups = [{ key: 'recent', label: '最近', items: [
      { id: 'a', name: '空闲区', sub: 's', status: 'idle' as AgentState },
      { id: 'b', name: '执行区', sub: 's', status: 'idle' as AgentState, live: true },
    ] }]
    const { container } = render(<Sidebar {...baseProps} groups={liveGroups} activeId="" />)
    const items = container.querySelectorAll('.ws-item')
    // Idle workspaces carry NO marker at all (gray dot removed); only the live one is is-running.
    expect(items[0].className).not.toContain('is-running')
    expect(items[1].className).toContain('is-running')
    expect(container.querySelectorAll('.ws-run-pill').length).toBe(1)
  })

  it('shows the last-activity time when provided', () => {
    const groups2 = [{ key: 'recent', label: '最近', items: [
      { id: 'a', name: 'WS', sub: 's', status: 'idle' as AgentState, lastActivity: '5 分钟前' },
    ] }]
    render(<Sidebar {...baseProps} groups={groups2} activeId="" />)
    expect(screen.getByText('5 分钟前')).toBeInTheDocument()
  })

  it('clicking a workspace item calls onSelect(id)', () => {
    const onSelect = vi.fn()
    render(<Sidebar {...baseProps} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('design-system'))
    expect(onSelect).toHaveBeenCalledWith('ws-1')
  })

  it('the new-workspace button calls onNew', () => {
    const onNew = vi.fn()
    render(<Sidebar {...baseProps} onNew={onNew} />)
    const newBtn = screen.getByTitle('新建工作区')
    fireEvent.click(newBtn)
    expect(onNew).toHaveBeenCalledTimes(1)
  })

  it('active item has "on" class', () => {
    render(<Sidebar {...baseProps} activeId="ws-1" />)
    const item = screen.getByText('design-system').closest('button')
    expect(item).toHaveClass('on')
  })

  it('renders 工作区 header', () => {
    render(<Sidebar {...baseProps} />)
    expect(screen.getByText('工作区')).toBeInTheDocument()
  })

})

// ── StatusBar ─────────────────────────────────────────────────────────────────

describe('StatusBar', () => {
  it('shows only providers actually installed on this machine (hides the rest)', () => {
    render(<StatusBar providers={[
      { id: 'claude', displayName: 'Claude Code', installed: true, models: [] },
      { id: 'gemini', displayName: 'Gemini CLI', installed: false, models: [] },
    ]} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Gemini CLI')).not.toBeInTheDocument()
  })

  it('renders SVG icon for a known provider (claude) — from SVG_OVERRIDE', () => {
    const { container } = render(<StatusBar providers={[
      { id: 'claude', displayName: 'Claude Code', installed: true, models: [] },
    ]} />)
    // The claude pill should have an svg element inside .mc-logo-sm
    const logo = container.querySelector('.mc-logo-sm')
    expect(logo).not.toBeNull()
    expect(logo!.querySelector('svg')).not.toBeNull()
  })

  it('renders glyph/first-letter fallback for unknown provider id — no crash', () => {
    // 'foo' is not in SVG_OVERRIDE or catalog, should fall back to 'F' (displayName[0])
    const { container } = render(<StatusBar providers={[
      { id: 'foo', displayName: 'FooAgent', installed: true, models: [] },
    ]} />)
    const logo = container.querySelector('.mc-logo-sm')
    expect(logo).not.toBeNull()
    // No svg, just text
    expect(logo!.querySelector('svg')).toBeNull()
    expect(logo!.textContent).toBe('F')
  })

  // ── SVG path snapshot — locks brand icons against future refactors ─────────
  // These are the verbatim `path d` values from the original prototype BRAND_SVG.
  // If any of these fail, the visual icon has been corrupted and must be restored.
  const EXPECTED_PATHS: Record<string, string[]> = {
    claude: ['M12 3v18M3 12h18M5.64 5.64l12.72 12.72M18.36 5.64L5.64 18.36'],
    codex: ['M12 4.2c2.2-1.6 5.2-.4 5.6 2.3 2.7.4 3.9 3.4 2.3 5.6 1.6 2.2.4 5.2-2.3 5.6-.4 2.7-3.4 3.9-5.6 2.3-2.2 1.6-5.2.4-5.6-2.3-2.7-.4-3.9-3.4-2.3-5.6C2.5 9.9 3.7 6.9 6.4 6.5 6.8 3.8 9.8 2.6 12 4.2Z'],
    gemini: ['M12 2c.55 5.2 2.8 7.45 8 8-5.2.55-7.45 2.8-8 8-.55-5.2-2.8-7.45-8-8 5.2-.55 7.45-2.8 8-8Z'],
    qoder: ['M15.5 15.5 19 19'],
    cursor: ['M12 2.6 20.4 7v10L12 21.4 3.6 17V7z', 'M12 2.6V21.4M3.6 7l8.4 5 8.4-5'],
  }

  for (const [providerId, expectedDs] of Object.entries(EXPECTED_PATHS)) {
    it(`locks SVG path d for provider "${providerId}" against refactor corruption`, () => {
      const displayName = providerId.charAt(0).toUpperCase() + providerId.slice(1)
      const { container } = render(<StatusBar providers={[
        { id: providerId, displayName, installed: true, models: [] },
      ]} />)
      const logo = container.querySelector('.mc-logo-sm')
      expect(logo).not.toBeNull()
      const paths = logo!.querySelectorAll('svg path')
      const actualDs = Array.from(paths).map(p => p.getAttribute('d') ?? '')
      expect(actualDs).toEqual(expectedDs)
    })
  }
})
