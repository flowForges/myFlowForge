import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkspaceView } from './WorkspaceView'
import type { EngineApi } from '../state/useEngine'
import type { ProviderInfo, ChatMessage } from '@shared/types'

// P-C2/T3 (disk-resume recovery UI): on workspace open, useRun2 calls run2.resumable(ws) — if it
// returns a summary (a workflow was interrupted by a previous app exit/crash and nothing is currently
// driving it — see Run2Manager.resumable's doc), WorkspaceView offers a 继续/丢弃 prompt. Never
// auto-resumes.

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
]

const wsConfig = {
  name: 'ws', path: '/ws', workflowId: 'standard', status: 'idle',
  stages: [{ key: 'requirement', provider: 'claude', model: 'opus-4.8' }],
  projects: [{ repoId: 'r1', name: 'web', branch: 'feat/cool', provider: 'claude', model: 'opus-4.8' }],
  workflows: [{ id: 'wf1', name: '快速修复', stages: [] }],
}

const conversation: ChatMessage[] = [
  { id: 'm1', who: 'user', text: '做个登录页', ts: '1' } as ChatMessage,
]

const resumableSummary = {
  runId: 'run-x', resumeStageKey: 'develop', resumeStageName: '开发', totalStages: 3, doneCount: 1,
}

const resumableMock = vi.fn(async () => null as typeof resumableSummary | null)
const resumeFromDiskMock = vi.fn(async () => ({}))
const discardResumableMock = vi.fn(async () => true)

const forgeBase = {
  chatHistory: vi.fn(async () => conversation),
  chatAppendLaunchGate: vi.fn(async () => ({})),
  chatAppendRunCard: vi.fn(async () => ({})),
  sendChat: vi.fn(async () => ({})), openFiles: async () => [], savePaste: vi.fn(),
  onChatEvent: () => () => {}, onChatQueueEvent: () => () => {},
  sessionList: async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' }),
  sessionSwitch: vi.fn(), sessionNew: vi.fn(), sessionClose: vi.fn(), sessionRename: vi.fn(),
  watchChanges: async () => [], watchStop: async () => {}, fsTree: async () => [],
  gitDiff: async () => [], gitFile: async () => ({ text: '', lang: 'ts' }),
  onChangesEvent: () => () => {},
  changesMulti: vi.fn(async () => ({ total: 0, byProject: [] })),
  lastRun: async () => null,
  getWorkspace: vi.fn(async () => wsConfig),
  runWorkspace: vi.fn(async () => {}),
  commandsList: vi.fn(async () => []),
  run2: {
    getState: vi.fn(async () => null),
    onUpdate: (_cb: any) => () => {},
    onLog: (_cb: any) => () => {},
    onQueue: (_cb: any) => () => {},
    resolveGate: vi.fn(),
    resolveLane: vi.fn(),
    addFeedback: vi.fn(),
    editFeedback: vi.fn(),
    removeFeedback: vi.fn(),
    abort: vi.fn(),
    launchInfo: vi.fn(async () => ({ workflows: [], projects: [] })),
    launchStart: vi.fn(async () => ({})),
    startWorkflow: vi.fn(),
    resumable: resumableMock,
    resumeFromDisk: resumeFromDiskMock,
    discardResumable: discardResumableMock,
  },
}

beforeEach(() => {
  resumableMock.mockClear()
  resumeFromDiskMock.mockClear()
  discardResumableMock.mockClear()
  resumableMock.mockImplementation(async () => null)
  ;(window as any).forge = { ...forgeBase, run2: { ...forgeBase.run2 } }
  ;(window as any).confirm = vi.fn(() => true)
})

const idleEngine: EngineApi = { run: null, pending: [], resolve: () => {}, cancel: () => {} }

describe('WorkspaceView: disk-resume 恢复提示 (P-C2/T3)', () => {
  it('resumable() 返回摘要时,显示继续/丢弃提示,文案含阶段名', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)

    await waitFor(() => expect(resumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())
    expect(screen.getByText(/上次有工作流未完成/)).toBeInTheDocument()
    expect(screen.getByText(/开发/)).toBeInTheDocument()
    // Task 8:「丢弃」在这个上下文里读起来像"扔掉代码",但这个按钮实际只清一条磁盘记录,从不碰
    // forge/run-<runId> 分支——改名「不用管了」并附一句 title 说清楚(见 WorkspaceView.tsx)。
    expect(screen.getByText('不用管了')).toBeInTheDocument()
  })

  // 真实事故(2026-08-12):所有阶段跑完、合并临时分支失败,用户看到的却是「上次有工作流未完成,从**代码CR**
  // 继续?」——代码CR 早跑完了。该重来的是收尾。
  // Task 8:原始 git 报错(哪个项目、哪个文件冲突)不再嵌进这句安心话——那是点「继续」重新收尾时弹出的
  // FinalizeFailureCard(Tasks 1-7)的活;这句只负责点名分支、说清楚代码没丢,所以断言改成了检查
  // "没有"原始报错文本、以及说清分支名与"未丢失"这两件事。
  it('收尾失败时说的是"重新收尾"并点名分支,不说"从某阶段继续",也不在这句里复述原始 git 报错', async () => {
    resumableMock.mockImplementation(async () => ({
      runId: 'run-fin', resumeStageKey: '__finalize__', resumeStageName: '收尾（合并临时分支）',
      totalStages: 4, doneCount: 4, finalizeOnly: true,
      error: '合并临时分支失败 — web: CONFLICT (content): Merge conflict in src/x.ts',
    }) as never)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)

    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())
    expect(screen.getByText(/收尾/)).toBeInTheDocument()
    expect(screen.queryByText(/从「/)).toBeNull()
    // 原始 git 报错(冲突文件路径等)不再出现在这条安心话里 —— 那句话现在完全不引用 run2.resumable.error。
    expect(screen.queryByText(/Merge conflict/)).toBeNull()
    // #7 fix round 1 (F4): the honest reassurance — the branch survives, only the record is at risk.
    // Task 8:这句话只在"还没做出丢弃决定"的 resumable 态下渲染(真丢弃过,这条记录早被清掉、根本不会
    // 显示这条横幅),所以"完整保留"在这里是无条件成立的事实,不需要再打折扣的"通常"/"不会丢"式措辞。
    expect(screen.getByText(/forge\/run-run-fin/)).toBeInTheDocument()
    expect(screen.getByText(/完整保留/)).toBeInTheDocument()
  })

  // #7 fix round 1 (F4): the finalizeOnly banner's 不用管了(原「丢弃」)confirm must say the SAME thing
  // the copy above it already says — deleting the record, not the work — not the generic
  // "无法恢复到当前进度" wording the ordinary mid-run-interrupted case uses (that one really would lose
  // in-flight progress).
  it('finalizeOnly 的确认文案说的是"记录"不是"进度"，且不无条件断言改动不受影响', async () => {
    resumableMock.mockImplementation(async () => ({
      runId: 'run-fin', resumeStageKey: '__finalize__', resumeStageName: '收尾（合并临时分支）',
      totalStages: 4, doneCount: 4, finalizeOnly: true,
      error: '合并临时分支失败 — web: CONFLICT (content): Merge conflict in src/x.ts',
    }) as never)
    const { container } = render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('不用管了')).toBeInTheDocument())

    fireEvent.click(screen.getByText('不用管了'))

    expect(screen.getByText(/这条运行记录/)).toBeInTheDocument()
    // #7 fix round 2 (N4): both the banner and this confirm line say the SAME hedged thing — never
    // an unconditional "仍完整保留"/"不受影响" without the "除非当时选的是丢弃" caveat.
    expect(screen.getAllByText(/通常/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/无法恢复到当前进度/)).toBeNull()
    expect(container.textContent).not.toMatch(/不受影响，仍完整保留/)
  })

  it('resumable() 返回 null 时,不显示提示', async () => {
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(resumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(document.querySelector('#composerInput')).toBeInTheDocument())
    expect(screen.queryByText(/上次有工作流未完成/)).toBeNull()
  })

  it('点击继续调用 run2.resumeFromDisk 并隐藏提示', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('继续')).toBeInTheDocument())

    fireEvent.click(screen.getByText('继续'))

    await waitFor(() => expect(resumeFromDiskMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.queryByText(/上次有工作流未完成/)).toBeNull())
    expect(discardResumableMock).not.toHaveBeenCalled()
  })

  // #7 fix round 1 (F4): 丢弃(Task 8 改名「不用管了」) now genuinely deletes the saved run record
  // (persist.ts's discardResumableRun fix, same task), so a bare click no longer fires it directly —
  // it takes a second, explicit 确认丢弃 click first (same two-click pattern as RunEventCard.tsx's
  // finalize-gate 彻底丢弃这次改动).
  it('点击不用管了 → 确认丢弃 调用 run2.discardResumable 并隐藏提示；第一次点击只展开确认', async () => {
    resumableMock.mockImplementation(async () => resumableSummary)
    render(<WorkspaceView engine={idleEngine} providers={providers} workspacePath="/ws" />)
    await waitFor(() => expect(screen.getByText('不用管了')).toBeInTheDocument())

    fireEvent.click(screen.getByText('不用管了'))
    expect(discardResumableMock).not.toHaveBeenCalled()
    expect(screen.getByText('确认丢弃')).toBeInTheDocument()

    fireEvent.click(screen.getByText('确认丢弃'))

    await waitFor(() => expect(discardResumableMock).toHaveBeenCalledWith('/ws'))
    await waitFor(() => expect(screen.queryByText(/上次有工作流未完成/)).toBeNull())
    expect(resumeFromDiskMock).not.toHaveBeenCalled()
  })
})
