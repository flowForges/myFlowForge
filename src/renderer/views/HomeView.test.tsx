import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { HomeView } from './HomeView'
import type { WorkspaceMeta, HomeStats } from '@shared/types'

const workspaces: WorkspaceMeta[] = [
  { name: 'design-system', path: '~/code/ds', projectCount: 2, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
  { name: 'api-gw', path: '~/code/api', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' }
]
const stats: HomeStats = {
  '~/code/ds': { branch: 'forge/design', changes: { a: 3, e: 7, d: 1 }, updatedAt: Date.now() - 5 * 60_000, lastMessageAt: Date.now() - 5 * 60_000 },
  '~/code/api': { branch: 'forge/api', changes: { a: 0, e: 0, d: 0 }, updatedAt: Date.now() - 3 * 3600_000, lastMessageAt: 0 },
}

beforeEach(() => {
  // InstallBanner (rendered inside HomeView) calls detectProviders; mock it to return an installed provider
  // so the banner is hidden and does not interfere with HomeView-specific assertions.
  ;(window as any).forge = { detectProviders: async () => [{ id: 'claude', displayName: 'Claude Code', installed: true, models: [] }] }
  // This jsdom environment has no localStorage; stub a fresh minimal store per test so the
  // quick-start dismiss persistence is testable (same approach as useResizable/expandedWs tests).
  const store: Record<string, string> = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  })
})

describe('HomeView', () => {
  it('renders greeting, actions, stats, focus card + other-workspaces list; routes clicks', () => {
    const onNew = vi.fn(); const onOpenDir = vi.fn(); const onOpenWorkspace = vi.fn()
    render(<HomeView workspaces={workspaces} stats={stats} activeRunPath="~/code/ds" onNew={onNew} onOpenDir={onOpenDir} onQuickFolder={() => {}} onOpenWorkspace={onOpenWorkspace} onOpenSettings={() => {}} />)
    expect(screen.getByText('新建工作区')).toBeInTheDocument()
    expect(screen.getByText('打开本地目录')).toBeInTheDocument()
    expect(screen.getByText('工作区')).toBeInTheDocument()
    expect(screen.getByText('今日改动')).toBeInTheDocument()
    // design-system is the running workspace → focus card (shows its branch); api-gw → list
    expect(screen.getByText('design-system')).toBeInTheDocument()
    expect(screen.getByText('forge/design')).toBeInTheDocument()
    expect(screen.getByText('其他工作区')).toBeInTheDocument()
    expect(screen.getByText('api-gw')).toBeInTheDocument()

    fireEvent.click(screen.getByText('新建工作区'))
    expect(onNew).toHaveBeenCalled()
    fireEvent.click(screen.getByText('打开本地目录'))
    expect(onOpenDir).toHaveBeenCalled()
    fireEvent.click(screen.getByText('design-system'))
    expect(onOpenWorkspace).toHaveBeenCalledWith(workspaces[0])
    fireEvent.click(screen.getByText('api-gw'))
    expect(onOpenWorkspace).toHaveBeenCalledWith(workspaces[1])
  })

  it('only shows a status badge for the running workspace; hides 失败/已完成/空闲', () => {
    const ws: WorkspaceMeta[] = [
      { name: 'running-ws', path: '~/code/run', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
      { name: 'failed-ws', path: '~/code/fail', projectCount: 1, workflowId: 'standard', status: 'err', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
      { name: 'done-ws', path: '~/code/done', projectCount: 1, workflowId: 'standard', status: 'ok', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
    ]
    render(<HomeView workspaces={ws} stats={{}} activeRunPath="~/code/run" onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    // the active run shows 运行中; every other state shows no status text at all
    expect(screen.getByText('运行中')).toBeInTheDocument()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('已完成')).toBeNull()
    expect(screen.queryByText('空闲')).toBeNull()
  })

  it('shows per-workspace change counts and an empty marker when there are none', () => {
    render(<HomeView workspaces={workspaces} stats={stats} activeRunPath="~/code/ds" onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    // focus card (design-system) has 3 added / 7 edited / 1 deleted
    const focus = document.querySelector('.focus-card') as HTMLElement
    expect(within(focus).getByText('+3')).toBeInTheDocument()
    expect(within(focus).getByText('~7')).toBeInTheDocument()
    expect(within(focus).getByText('−1')).toBeInTheDocument()
    // api-gw row has zero changes → 无改动
    const row = document.querySelector('.wl-row') as HTMLElement
    expect(within(row).getByText('无改动')).toBeInTheDocument()
  })

  it('hides archived workspaces from the focus card, list and count', () => {
    const ws: WorkspaceMeta[] = [
      { name: 'active-ws', path: '~/code/act', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
      { name: 'archived-ws', path: '~/code/arc', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: true, archivedAt: 1, createdAt: 0, description: '已归档' },
    ]
    render(<HomeView workspaces={ws} stats={{}} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    expect(screen.getByText('active-ws')).toBeInTheDocument()
    expect(screen.queryByText('archived-ws')).toBeNull()
    // 工作区 count reflects only the non-archived workspace
    const cell = screen.getByText('工作区').closest('.hs-cell') as HTMLElement
    expect(within(cell).getByText('1')).toBeInTheDocument()
  })

  it('sorts pinned workspaces to the top (pinned becomes focus when nothing is running)', () => {
    const ws: WorkspaceMeta[] = [
      { name: 'plain-a', path: '~/code/a', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: false, archived: false, archivedAt: null, createdAt: 0, description: '' },
      { name: 'pinned-b', path: '~/code/b', projectCount: 1, workflowId: 'standard', status: 'idle', pinned: true, archived: false, archivedAt: null, createdAt: 0, description: '' },
    ]
    render(<HomeView workspaces={ws} stats={{}} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    // pinned-b sorts to the top → becomes the focus card even though it is second in the array
    const focus = document.querySelector('.focus-card') as HTMLElement
    expect(within(focus).getByText('pinned-b')).toBeInTheDocument()
  })

  it('shows the empty-state onboarding with a folder-only path when there are no workspaces', () => {
    const onQuickFolder = vi.fn()
    const onNew = vi.fn()
    render(<HomeView workspaces={[]} stats={{}} onNew={onNew} onOpenDir={() => {}} onQuickFolder={onQuickFolder} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    expect(screen.getByText('从这里开始')).toBeInTheDocument()
    fireEvent.click(screen.getByText('选个文件夹 · 直接对话'))
    expect(onQuickFolder).toHaveBeenCalled()
    fireEvent.click(screen.getByText('配置项目工作区'))
    expect(onNew).toHaveBeenCalled()
  })

  it('hides the empty-state onboarding once a workspace exists', () => {
    render(<HomeView workspaces={workspaces} stats={stats} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    expect(screen.queryByText('从这里开始')).toBeNull()
  })

  describe('quick-start guide (first-run onboarding)', () => {
    const mixedProviders = [
      { id: 'claude', displayName: 'Claude Code', installed: true, models: [], installCmd: 'curl -fsSL https://claude.ai/install.sh | bash', authCmd: 'claude' },
      { id: 'codex', displayName: 'Codex', installed: false, models: [], installCmd: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', authCmd: 'codex' },
    ]
    const renderEmpty = (over: Partial<Parameters<typeof HomeView>[0]> = {}) =>
      render(<HomeView workspaces={[]} stats={{}} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} {...over} />)

    it('renders the three-step guide in the empty state when not dismissed', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      renderEmpty()
      expect(await screen.findByText('快速开始')).toBeInTheDocument()
      expect(screen.getByText(/安装编码代理 CLI/)).toBeInTheDocument()
      expect(screen.getByText(/登录 CLI/)).toBeInTheDocument()
      expect(screen.getByText(/开始使用/)).toBeInTheDocument()
      // installed provider shows the installed check; uninstalled one shows its install command + copy
      expect(screen.getByText('✓ 已安装')).toBeInTheDocument()
      expect(screen.getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh')).toBeInTheDocument()
    })

    it('does not render once a workspace exists', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      render(<HomeView workspaces={workspaces} stats={stats} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
      await waitFor(() => expect(document.querySelector('.quickstart')).toBeNull())
      expect(screen.queryByText('快速开始')).toBeNull()
    })

    it('dismiss (不再显示) hides the card and persists to localStorage', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      renderEmpty()
      await screen.findByText('快速开始')
      fireEvent.click(screen.getByLabelText('不再显示'))
      expect(screen.queryByText('快速开始')).toBeNull()
      expect(localStorage.getItem('forge.quickstartDismissed')).toBe('1')
    })

    it('stays hidden when previously dismissed', async () => {
      localStorage.setItem('forge.quickstartDismissed', '1')
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      renderEmpty()
      await waitFor(() => expect(document.querySelector('.quickstart')).toBeNull())
    })

    it('shows the authCmd with copy for installed providers in step 2', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      renderEmpty()
      await screen.findByText('快速开始')
      const step2 = screen.getByText(/登录 CLI/).closest('.qs-step') as HTMLElement
      expect(within(step2).getByText('claude')).toBeInTheDocument()          // authCmd of the installed provider
      expect(within(step2).getByText('复制')).toBeInTheDocument()             // copy button next to it
      expect(within(step2).queryByText('codex')).toBeNull()                   // uninstalled → no login row
      expect(within(step2).getByText(/否则无法对话/)).toBeInTheDocument()
    })

    it('simplifies step 1 (no repeated install commands) when the InstallBanner already lists them', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders.map(p => ({ ...p, installed: false })) }
      renderEmpty()
      await screen.findByText('快速开始')
      const step1 = screen.getByText(/安装编码代理 CLI/).closest('.qs-step') as HTMLElement
      // InstallBanner (zero installed) already lists the commands; step 1 just points at it
      expect(within(step1).queryByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeNull()
      expect(within(step1).getByText(/上方/)).toBeInTheDocument()
    })

    it('routes the step-3 entry buttons to onQuickFolder / onNew', async () => {
      ;(window as any).forge = { detectProviders: async () => mixedProviders }
      const onQuickFolder = vi.fn(); const onNew = vi.fn()
      renderEmpty({ onQuickFolder, onNew })
      await screen.findByText('快速开始')
      fireEvent.click(screen.getByText('选择文件夹开始对话'))
      expect(onQuickFolder).toHaveBeenCalled()
      fireEvent.click(screen.getByText('创建工作区'))
      expect(onNew).toHaveBeenCalled()
    })
  })

  it('fills the focus card with live stages and agents from the engine run', () => {
    const run = {
      id: 'r1', workspaceName: 'design-system', workspacePath: '~/code/ds', status: 'run' as const,
      projects: [{ name: 'web', cwd: '~/code/ds/web' }], pending: [],
      stages: [
        { key: 'requirement', name: '需求评估', state: 'ok' as const, agents: [{ id: 'a1', name: '需求代理', role: '需求', provider: 'claude', model: 'opus-4.8', state: 'ok' as const, logs: [] }] },
        { key: 'develop', name: '代码开发', state: 'run' as const, agents: [{ id: 'a2', name: '开发代理', role: '开发', provider: 'claude', model: 'opus-4.8', state: 'run' as const, logs: [] }] },
      ],
    }
    render(<HomeView workspaces={workspaces} stats={stats} activeRunPath="~/code/ds" run={run} onNew={() => {}} onOpenDir={() => {}} onQuickFolder={() => {}} onOpenWorkspace={() => {}} onOpenSettings={() => {}} />)
    expect(screen.getByText('需求评估')).toBeInTheDocument()
    expect(screen.getByText('代码开发')).toBeInTheDocument()
    expect(screen.getByText('开发代理')).toBeInTheDocument()
  })
})
