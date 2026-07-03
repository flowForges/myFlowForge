import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatEvent, RunState, AgentRuntime, AgentState } from '@shared/types'

// End-to-end gate observability chain at the UI level:
//   规划(plan-request) → 批准(chatResolve allow) → 清卡(plan-resolved)
//   → 运行过程(running agent auto-expanded, kind-tagged log) → 变更证据跳转(查看变更 → 变更 tab)
//
// Faithful to real data flow:
//   * plan/done events arrive via window.forge.onChatEvent (captured callback) → useChat
//   * run state arrives via the engine prop (EngineApi.run) → useLastRun, NOT an event

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

let chatHandler: ((e: ChatEvent) => void) | null = null
const chatResolve = vi.fn()

beforeEach(() => {
  chatHandler = null
  chatResolve.mockClear()
  ;(window as any).forge = {
    chatHistory: async () => [],
    sendChat: async () => ({}),
    openFiles: async () => [],
    savePaste: vi.fn(),
    onChatEvent: (cb: (e: ChatEvent) => void) => { chatHandler = cb; return () => {} },
    onChatQueueEvent: () => () => {},
    watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
    gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
    onChangesEvent: () => () => {},
    chatResolve,
    lastRun: async () => null,
    getWorkspace: async () => ({ name: 'ws', path: '/ws', workflowId: 'standard', stages: [], projects: [], status: 'run' }),
  }
})

function agent(id: string, state: AgentState, logs: AgentRuntime['logs']): AgentRuntime {
  return { id, name: id, role: 'r', provider: 'claude', model: 'opus-4.8', state, logs }
}

// A live run for /ws whose 开发 stage is running with a kind-tagged tool log line.
function liveRun(): RunState {
  return {
    id: 'r', workspaceName: 'ws', workspacePath: '/ws', status: 'run',
    projects: [{ name: 'web', cwd: '/ws/web' }],
    stages: [
      { key: 's1', name: '设计', state: 'ok', agents: [agent('设计师', 'ok', [{ ts: '', text: '设计已完成', level: 'ok' }])] },
      { key: 's2', name: '开发', state: 'run', agents: [agent('开发者', 'run', [
        { ts: '', text: '调用 Bash: go build', level: 'accent', kind: 'tool' },
      ])] },
    ],
    pending: [],
  }
}

function engineWith(run: RunState | null): EngineApi {
  return { run, pending: [], resolve: () => {}, cancel: () => {} }
}

describe('WorkspaceView gate observability chain (e2e)', () => {
  it('规划 → 批准 → 清卡 → 运行过程(自动展开+kind 标记) → 变更跳转', async () => {
    // Render with a live run for /ws so the run pane + chat both target the same workspace.
    const { container } = render(
      <WorkspaceView engine={engineWith(liveRun())} providers={providers} workspacePath="/ws" />,
    )
    await waitFor(() => expect(chatHandler).not.toBeNull())

    // ── Step 1: plan-request → PlanCard appears (approach + stage chips) ──────
    chatHandler!({
      workspacePath: '/ws', sessionId: 'default', type: 'plan-request', id: 'pl-1',
      approach: '先建模型再写测试', task: '加评论',
      stages: [{ name: '设计', agents: 2 }, { name: '开发', agents: 3 }],
    } as ChatEvent)

    await waitFor(() => expect(screen.getByText('方案待批准')).toBeInTheDocument())
    expect(screen.getByText('先建模型再写测试')).toBeInTheDocument()
    expect(container.querySelector('.chat-inner .msg-req[data-req="pl-1"]')).toBeTruthy()
    // stage chips reflect the two stages with parallel-agent counts
    expect(screen.getByText(/设计 · 并行2代理/)).toBeInTheDocument()
    expect(screen.getByText(/开发 · 并行3代理/)).toBeInTheDocument()

    // ── Step 2: 批准并执行 → chatResolve(allow) with the workspace path ───────
    fireEvent.click(screen.getByText('批准并执行'))
    expect(chatResolve).toHaveBeenCalledWith({ id: 'pl-1', decision: 'allow', value: undefined, workspacePath: '/ws' })

    // ── Step 3: plan-resolved → PlanCard disappears ──────────────────────────
    chatHandler!({ workspacePath: '/ws', sessionId: 'default', type: 'plan-resolved', id: 'pl-1' } as ChatEvent)
    await waitFor(() => expect(screen.queryByText('方案待批准')).toBeNull())

    // ── Step 4: running agent log is visible WITHOUT a manual toggle, kind-tagged ──
    // The 开发 stage's agent is state:'run' → auto-expanded by WorkspaceView's openIds seeding.
    expect(screen.getByText('调用 Bash: go build')).toBeInTheDocument()
    // non-running stage's log stays collapsed
    expect(screen.queryByText('设计已完成')).not.toBeInTheDocument()
    // the kind:'tool' line carries the per-kind class + icon
    const toolLine = container.querySelector('.log-line.k-tool')
    expect(toolLine).toBeTruthy()
    expect(toolLine!.querySelector('.k-ic')).toBeTruthy()
    expect(toolLine!.querySelector('.k-ic')!.textContent).toContain('⚙')

    fireEvent.click(screen.getByRole('button', { name: /开发者/ }))
    await waitFor(() => expect(screen.queryByText('调用 Bash: go build')).not.toBeInTheDocument())

    // ── Step 5: done message with changes → 查看变更 button → 变更 tab active ──
    // done replaces an existing message, so seed it via assistant-start first (real flow).
    chatHandler!({ workspacePath: '/ws', sessionId: 'default', type: 'assistant-start', id: 'm-1', model: 'opus-4.8' } as ChatEvent)
    chatHandler!({
      workspacePath: '/ws', sessionId: 'default', type: 'done',
      message: { id: 'm-1', who: 'ai', text: '完成,共改动 3 个文件', ts: '', changes: { total: 3, add: 10, del: 2 } },
    } as ChatEvent)

    const viewChangesBtn = await screen.findByText(/查看变更\(3 文件 \+10 −2\)/)
    expect(viewChangesBtn).toBeInTheDocument()

    // before clicking, the 代理 pane is active and 变更 pane is not
    expect(container.querySelector('#pane-agents')!.className).toContain('on')
    expect(container.querySelector('#pane-changes')!.className).not.toContain('on')

    fireEvent.click(viewChangesBtn)

    // after clicking, activeTab switches to 变更: its pane becomes active + renders content
    await waitFor(() => expect(container.querySelector('#pane-changes')!.className).toContain('on'))
    expect(container.querySelector('#pane-agents')!.className).not.toContain('on')
    // the 变更 tab button is now selected and the pane content (ProjectPicker/ChangesPane) mounted
    const changesTab = container.querySelector('.insp-tab[data-pane="changes"]')
    expect(changesTab!.className).toContain('on')
    expect(container.querySelector('#pane-changes')!.children.length).toBeGreaterThan(0)
  })
})
