import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Titlebar } from './Titlebar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import type { AgentState } from '@shared/types'
import { AGENT_LOGO_SVG } from '../components/agentLogos'

// ── Titlebar ─────────────────────────────────────────────────────────────────

describe('Titlebar', () => {
  const baseProps = {
  onOpenHosts: vi.fn(),
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

  it('marks an idle workspace as running (rail + status badge) when live (an agent is executing)', () => {
    const liveGroups = [{ key: 'recent', label: '最近', items: [
      { id: 'a', name: '空闲区', sub: 's', status: 'idle' as AgentState },
      { id: 'b', name: '执行区', sub: 's', status: 'idle' as AgentState, live: true, statusBadge: { kind: 'run' as const, count: 1 } },
    ] }]
    const { container } = render(<Sidebar {...baseProps} groups={liveGroups} activeId="" />)
    const items = container.querySelectorAll('.ws-item')
    // Idle workspaces carry NO marker at all (gray dot removed); only the live one is is-running.
    expect(items[0].className).not.toContain('is-running')
    expect(items[1].className).toContain('is-running')
    expect(container.querySelectorAll('.ws-status-badge.run').length).toBe(1)
  })

  it('moves the date off the workspace row onto each session row', () => {
    const groups2 = [{ key: 'recent', label: '最近', items: [
      { id: 'a', name: 'WS', sub: 's', status: 'idle' as AgentState, lastActivity: '5 分钟前' },
    ] }]
    const { container } = render(
      <Sidebar {...baseProps} groups={groups2} activeId=""
        expandedIds={new Set(['a'])}
        sessionsByWs={{ a: [{ id: 's1', title: '会话', mode: 'chat', createdAt: 1704067200000 }] }}
      />
    )
    // The workspace row no longer carries the last-activity time…
    expect(screen.queryByText('5 分钟前')).not.toBeInTheDocument()
    // …the time now lives on the (expanded) session row.
    expect(container.querySelector('.ws-sess-time')?.textContent?.trim()).toBeTruthy()
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

  it('renders the official SVG logo for a known provider (claude)', () => {
    const { container } = render(<StatusBar providers={[
      { id: 'claude', displayName: 'Claude Code', installed: true, models: [] },
    ]} />)
    // The claude pill should have an svg element inside .mc-logo-sm
    const logo = container.querySelector('.mc-logo-sm')
    expect(logo).not.toBeNull()
    expect(logo!.querySelector('svg')).not.toBeNull()
  })

  it('renders glyph/first-letter fallback for unknown provider id — no crash', () => {
    // 'foo' has no official logo and is not in the catalog, should fall back to 'F' (displayName[0])
    const { container } = render(<StatusBar providers={[
      { id: 'foo', displayName: 'FooAgent', installed: true, models: [] },
    ]} />)
    const logo = container.querySelector('.mc-logo-sm')
    expect(logo).not.toBeNull()
    // No svg, just text
    expect(logo!.querySelector('svg')).toBeNull()
    expect(logo!.textContent).toBe('F')
  })

  // ── 状态栏用的就是 agentLogos 里那份官方图标 ─────────
  for (const providerId of ['claude', 'codex', 'gemini', 'qoder', 'cursor']) {
    it(`renders the official logo for provider "${providerId}"`, () => {
      const { container } = render(<StatusBar providers={[
        { id: providerId, displayName: providerId, installed: true, models: [] },
      ]} />)
      const svg = container.querySelector(`.mc-logo-sm [data-agent-logo="${providerId}"]`)
      expect(svg?.innerHTML).toBe(AGENT_LOGO_SVG[providerId])
    })
  }
})
