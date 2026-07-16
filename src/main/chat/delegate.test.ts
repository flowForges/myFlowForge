import { describe, it, expect, vi } from 'vitest'
import { makeRunDelegate, cancelWorkspaceDelegates, DELEGATE_IDLE_KILL_MS, WATCHDOG_TICK_MS, type DelegateResult } from './delegate'

// runDelegate 现在【立即返回「已派发」确认】,真实聚合产出经 onComplete 异步回调。测试用它拿最终结果。
function awaitDelegate(run: ReturnType<typeof makeRunDelegate>, opts: Parameters<ReturnType<typeof makeRunDelegate>>[0]): Promise<DelegateResult> {
  return new Promise<DelegateResult>((resolve) => { void run({ ...opts, onComplete: resolve }) })
}
import { listDelegateAgents } from './delegateRegistry'
import type { AgentProvider, AgentResult, AgentTask, AgentCallbacks } from '../agents/types'
import type { Workspace } from '../config/schema'

// A fake provider whose run() reports a handoff (or, optionally, only log output) then completes.
function fakeProvider(opts: { handoff?: (name: string) => string; output?: (name: string) => string; outputDeltas?: (name: string) => string[] } = {}): AgentProvider {
  return {
    id: 'fake', displayName: 'Fake', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    detect: async () => true, listModels: async () => [],
    run(task: AgentTask, cb: AgentCallbacks) {
      // Assistant answer streamed as delta chunks (kind 'output'), as real CLIs emit it.
      if (opts.outputDeltas) for (const d of opts.outputDeltas(task.name)) cb.onLog({ ts: '', text: d, level: 'accent', kind: 'output' })
      if (opts.output) cb.onLog({ ts: '', text: opts.output(task.name), level: 'ok' })
      if (opts.handoff) cb.onHandoff?.({ summary: opts.handoff(task.name) })
      cb.onDone({ ok: true })
      return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) }
    },
  }
}

// A provider that records the permissionMode its sub-agent was launched with (for gate assertions).
function capProvider(id: string, seen: Record<string, string | undefined>): AgentProvider {
  return {
    id, displayName: id, capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    detect: async () => true, listModels: async () => [],
    run(task, cb) { seen[task.name] = task.permissionMode; cb.onHandoff?.({ summary: 'ok' }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) } },
  }
}
const depsFor = (key: string, provider: AgentProvider, workspace: Workspace) => ({
  providers: { [key]: provider }, proxy: () => '', mcpEntry: undefined, readWorkspace: () => workspace,
})

function ws(projects: string[]): Workspace {
  return {
    name: 'w', path: '/ws', agent: 'fake', projects: projects.map(n => ({ repoId: n, name: n, branch: 'main' })),
    stages: [], plugins: [], stepPlugins: [], workflows: [],
  } as unknown as Workspace
}

const deps = (provider: AgentProvider, workspace: Workspace) => ({
  providers: { fake: provider }, proxy: () => '', mcpEntry: undefined,
  readWorkspace: () => workspace,
})

describe('runDelegate', () => {
  it('派每个目标项目一个子代理并按项目汇总各自 handoff', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: (n) => `${n} 的结论` }), ws(['a', 'b'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: '看看登录逻辑', projects: ['a', 'b'], provider: 'fake', model: 'm' })
    expect(r.per.map(p => p.project).sort()).toEqual(['a', 'b'])
    expect(r.per.every(p => p.ok)).toBe(true)
    expect(r.text).toContain('a 的结论')
    expect(r.text).toContain('b 的结论')
  })

  it('无 handoff 时把流式输出 delta 原样拼接(不插 \\n),不破坏 markdown', async () => {
    // Regression: deltas used to be '\n'-joined, inserting a hard break at every chunk boundary —
    // shattering **bold**/lists mid-token when rendered. They must concatenate faithfully.
    const runDelegate = makeRunDelegate(deps(fakeProvider({ outputDeltas: () => ['语言：**Go 1.', '12** + **Gin**', '，数据库 MySQL。'] }), ws(['a'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per[0].summary).toBe('语言：**Go 1.12** + **Gin**，数据库 MySQL。')
    expect(r.per[0].summary).not.toContain('\n')
  })

  it('level:ok 完整结果覆盖流式 delta(优先用干净的完整消息)', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ outputDeltas: () => ['部分', '片段'], output: () => '完整的干净结果' }), ws(['a'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per[0].summary).toBe('完整的干净结果')
  })

  it('projects 过滤只在指定项目执行', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: (n) => `${n}!` }), ws(['a', 'b', 'c'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', projects: ['b'], provider: 'fake', model: 'm' })
    expect(r.per.map(p => p.project)).toEqual(['b'])
  })

  it('无 handoff 时退回用日志输出作为 summary', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ output: (n) => `${n} 输出内容` }), ws(['a'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', projects: ['a'], provider: 'fake', model: 'm' })
    expect(r.per[0].summary).toContain('a 输出内容')
  })

  it('工作区无项目时在工作区根跑单个子代理', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: () => 'root done' }), ws([])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per).toHaveLength(1)
    expect(r.per[0].project).toBe('workspace')
    expect(r.text).toContain('root done')
  })

  it('运行中通过 onAgentState 实时回传执行动作(activity)与状态,终态带产出', async () => {
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) {
        cb.onLog({ ts: '', text: 'Read src/login.ts', level: 'accent', kind: 'file' })  // → activity
        cb.onLog({ ts: '', text: '部分产出…', level: 'accent', kind: 'output' })          // 产出 delta(不该污染 activity)
        cb.onHandoff?.({ summary: 'done' })
        cb.onDone({ ok: true })
        return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) }
      },
    }
    const runDelegate = makeRunDelegate(deps(provider, ws([])))
    const states: { status: string; activity?: string; output?: string }[] = []
    await new Promise<void>((resolve) => {
      void runDelegate({ workspacePath: '/ws', task: 't', provider: 'fake', model: 'm',
        onAgentState: (_r, _id, status, output, activity) => { states.push({ status, activity, output }) },
        onComplete: () => resolve() })
    })
    // 运行中至少有一条 'run' 回传,带最近动作行(且没被 output delta 覆盖成答案文本)
    expect(states.some(s => s.status === 'run' && s.activity === 'Read src/login.ts')).toBe(true)
    // 终态回传完成 + 产出
    expect(states.some(s => s.status === 'ok' && s.output === 'done')).toBe(true)
  })

  // 过度委派修复:省略 projects 不再铺满所有项目,只派一个工作区根代理(cwd=工作区根,能看到所有项目子目录)。
  it('省略 projects → 只派一个工作区根代理(不再每项目一个)', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: (n) => `${n} done` }), ws(['a', 'b', 'c'])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/wsroot', task: '读一个文件', provider: 'fake', model: 'm' })
    expect(r.per).toHaveLength(1)
    expect(r.per[0].project).toBe('workspace')
  })

  it('权限盾牌下沉:write=false→子代理 readonly;write=true→用会话盾牌', async () => {
    const seen: Record<string, string | undefined> = {}
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) { seen[task.name] = task.permissionMode; cb.onHandoff?.({ summary: 'ok' }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) } },
    }
    await makeRunDelegate(deps(provider, ws(['a'])))({ workspacePath: '/ws', task: 't', projects: ['a'], write: false, provider: 'fake', model: 'm' })
    expect(seen['a']).toBe('readonly')
    await makeRunDelegate(deps(provider, ws(['b'])))({ workspacePath: '/ws', task: 't', projects: ['b'], write: true, permissionMode: 'full', provider: 'fake', model: 'm' })
    expect(seen['b']).toBe('full')
  })

  // 兜底回传:codex 子代理把最终回答作为整段 agent_message(level 'accent',非 delta)发出;既非 handoff 也非
  // 'ok'/'output' delta。原来会退化成空「完成」——现在捞 accent 作兜底,让只读探查即便调不了 forge_handoff 也有结果。
  it('无 handoff/output 时用最后一条 agent_message(accent)兜底当 summary', async () => {
    const provider: AgentProvider = {
      id: 'codex', displayName: 'C', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) {
        cb.onLog({ ts: '', text: '读取中…', level: 'info' })
        cb.onLog({ ts: '', text: '结论：后端用的是 Gin + MySQL', level: 'accent' })
        cb.onDone({ ok: true })
        return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) }
      },
    }
    const r = await awaitDelegate(makeRunDelegate(depsFor('codex', provider, ws(['a']))), { workspacePath: '/ws', task: 't', provider: 'codex', model: 'm' })
    expect(r.per[0].summary).toBe('结论：后端用的是 Gin + MySQL')
  })

  // 派发前权限门(形态二):codex + 写类 + 盾牌未到「完全」时,先弹门本次授权。授权本次 → 子代理用 full。
  it('codex + 写 + 盾牌<完全 → 弹门;授权本次 → 子代理 permissionMode=full', async () => {
    const seen: Record<string, string | undefined> = {}
    const asked: { projects: string[]; write: boolean }[] = []
    const runDelegate = makeRunDelegate(depsFor('codex', capProvider('codex', seen), ws(['a'])))
    await new Promise<void>((resolve) => void runDelegate({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'codex', model: 'm', permissionMode: 'auto',
      askPermission: async (info) => { asked.push(info); return 'full' }, onComplete: () => resolve(),
    }))
    expect(asked).toHaveLength(1)
    expect(asked[0].projects).toEqual(['a'])
    expect(seen['a']).toBe('full')
  })

  it('codex + 写 + 选「仅当前权限」→ 子代理沿用盾牌(auto),不升 full', async () => {
    const seen: Record<string, string | undefined> = {}
    const runDelegate = makeRunDelegate(depsFor('codex', capProvider('codex', seen), ws(['a'])))
    await new Promise<void>((resolve) => void runDelegate({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'codex', model: 'm', permissionMode: 'auto',
      askPermission: async () => 'default', onComplete: () => resolve(),
    }))
    expect(seen['a']).toBe('auto')
  })

  it('codex 读类(write=false)不弹门,子代理仍 readonly', async () => {
    const seen: Record<string, string | undefined> = {}
    let asked = 0
    const runDelegate = makeRunDelegate(depsFor('codex', capProvider('codex', seen), ws(['a'])))
    await new Promise<void>((resolve) => void runDelegate({
      workspacePath: '/ws', task: 't', projects: ['a'], write: false, provider: 'codex', model: 'm', permissionMode: 'auto',
      askPermission: async () => { asked++; return 'full' }, onComplete: () => resolve(),
    }))
    expect(asked).toBe(0)
    expect(seen['a']).toBe('readonly')
  })

  it('非 codex 的写类委派不弹门(其它 CLI 无 MCP↔沙箱绑定限制)', async () => {
    const seen: Record<string, string | undefined> = {}
    let asked = 0
    const runDelegate = makeRunDelegate(depsFor('claude', capProvider('claude', seen), ws(['a'])))
    await new Promise<void>((resolve) => void runDelegate({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'claude', model: 'm', permissionMode: 'auto',
      askPermission: async () => { asked++; return 'full' }, onComplete: () => resolve(),
    }))
    expect(asked).toBe(0)
    expect(seen['a']).toBe('auto')
  })

  it('codex + 写 + 盾牌已是 full → 不弹门(已够权限)', async () => {
    const seen: Record<string, string | undefined> = {}
    let asked = 0
    const runDelegate = makeRunDelegate(depsFor('codex', capProvider('codex', seen), ws(['a'])))
    await new Promise<void>((resolve) => void runDelegate({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'codex', model: 'm', permissionMode: 'full',
      askPermission: async () => { asked++; return 'full' }, onComplete: () => resolve(),
    }))
    expect(asked).toBe(0)
    expect(seen['a']).toBe('full')
  })

  // handoff 被沙箱取消修复:codex 只有 danger-full-access(permMode 'full')才能调 MCP;read-only/workspace-write 下
  // forge_handoff 会被取消。所以非完全权限的 codex 子代理 prompt 不再教它调 forge,改让它直接把结论写成最后一条回答。
  function promptCapProvider(id: string, seen: Record<string, string>): AgentProvider {
    return {
      id, displayName: id, capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) { seen[task.name] = task.prompt; cb.onLog({ ts: '', text: '结论', level: 'accent' }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) } },
    }
  }

  it('codex 只读子代理:prompt 不教它调 forge_handoff(沙箱会取消),改让它直接写成最后一条回答', async () => {
    const seen: Record<string, string> = {}
    await new Promise<void>((resolve) => void makeRunDelegate(depsFor('codex', promptCapProvider('codex', seen), ws(['a'])))({
      workspacePath: '/ws', task: 't', projects: ['a'], write: false, provider: 'codex', model: 'm', onComplete: () => resolve(),
    }))
    expect(seen['a']).not.toContain('必须调用 forge_handoff')
    expect(seen['a']).toContain('不要尝试调用')
    expect(seen['a']).toContain('最后一条完整')
  })

  it('codex 写 + 授权本次 full → prompt 恢复教它调 forge_handoff(full-access 下 MCP 可用)', async () => {
    const seen: Record<string, string> = {}
    await new Promise<void>((resolve) => void makeRunDelegate(depsFor('codex', promptCapProvider('codex', seen), ws(['a'])))({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'codex', model: 'm', permissionMode: 'auto',
      askPermission: async () => 'full', onComplete: () => resolve(),
    }))
    expect(seen['a']).toContain('必须调用 forge_handoff')
  })

  it('codex 写 + 仅当前权限(auto)→ 仍不教它调 forge_handoff(workspace-write 下 MCP 照样被取消)', async () => {
    const seen: Record<string, string> = {}
    await new Promise<void>((resolve) => void makeRunDelegate(depsFor('codex', promptCapProvider('codex', seen), ws(['a'])))({
      workspacePath: '/ws', task: 't', projects: ['a'], write: true, provider: 'codex', model: 'm', permissionMode: 'auto',
      askPermission: async () => 'default', onComplete: () => resolve(),
    }))
    expect(seen['a']).not.toContain('必须调用 forge_handoff')
  })

  it('非 codex 子代理(claude)即使只读也照常教它调 forge_handoff(其 MCP 不绑沙箱)', async () => {
    const seen: Record<string, string> = {}
    await new Promise<void>((resolve) => void makeRunDelegate(depsFor('claude', promptCapProvider('claude', seen), ws(['a'])))({
      workspacePath: '/ws', task: 't', projects: ['a'], write: false, provider: 'claude', model: 'm', onComplete: () => resolve(),
    }))
    expect(seen['a']).toContain('必须调用 forge_handoff')
  })

  // 对话区实时进度块:派发即 onBatchStart(全部 'run'),各子代理完成时 onAgentState('ok')。
  it('派发即 onBatchStart(列出全部子代理),子代理完成触发 onAgentState(ok)', async () => {
    const started: { runId: string; agents: { agentId: string; name: string; provider: string }[] }[] = []
    const states: { agentId: string; status: string; output?: string }[] = []
    await new Promise<void>((resolve) => void makeRunDelegate(deps(fakeProvider({ handoff: (n) => `${n}!` }), ws(['a', 'b'])))({
      workspacePath: '/ws', task: 't', projects: ['a', 'b'], provider: 'fake', model: 'm',
      onBatchStart: (runId, agents) => started.push({ runId, agents }),
      onAgentState: (_runId, agentId, status, output) => states.push({ agentId, status, output }),
      onComplete: () => resolve(),
    }))
    expect(started).toHaveLength(1)
    expect(started[0].agents.map(a => a.name).sort()).toEqual(['a', 'b'])
    expect(started[0].runId).toMatch(/^delegate-/)
    const ok = states.filter(s => s.status === 'ok')
    expect(ok.map(s => s.agentId).sort()).toEqual(['delegate:a', 'delegate:b'])
    // 完成时带上子代理产出(供进度块展开的「输出」)
    expect(ok.find(s => s.agentId === 'delegate:a')?.output).toBe('a!')
  })

  it('传 sessionId 时把子代理登记进 delegateRegistry(供 IDs 面板),完成后置 ok', async () => {
    await makeRunDelegate(deps(fakeProvider({ handoff: () => 'x' }), ws(['a', 'b'])))({ workspacePath: '/wsreg', task: 't', projects: ['a', 'b'], provider: 'fake', model: 'm', sessionId: 's1' })
    const rows = listDelegateAgents('/wsreg', 's1')
    expect(rows.map(r => r.name).sort()).toEqual(['a', 'b'])
    expect(rows.every(r => r.status === 'ok')).toBe(true)
  })

  it('孙 agent(子代理内置 Task)登记为 depth:2,挂在对应子代理下', async () => {
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) { cb.onSubagent?.({ id: 'g1', phase: 'start', description: '读子模块' }); cb.onHandoff?.({ summary: 'x' }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) } },
    }
    await makeRunDelegate(deps(provider, ws(['a'])))({ workspacePath: '/wsg', task: 't', projects: ['a'], provider: 'fake', model: 'm', sessionId: 's1' })
    const grand = listDelegateAgents('/wsg', 's1').find(r => r.depth === 2)
    expect(grand?.name).toBe('读子模块')
    expect(grand?.parentId).toBe('delegate:a')
  })

  it('cancelWorkspaceDelegates 取消后台在跑的子代理(fire-and-forget 后「停止」仍杀得掉,修孤儿缺口)', async () => {
    let cancelled = false
    let rej: ((e: unknown) => void) | undefined
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task) {
        const done = new Promise<AgentResult>((_res, reject) => { rej = reject })
        return { id: task.agentId, cancel() { cancelled = true; rej?.(new Error('cancelled')) }, done }
      },
    }
    const ack = await makeRunDelegate(deps(provider, ws(['a'])))({ workspacePath: '/wscancel', task: 't', provider: 'fake', model: 'm' })
    expect(ack.text).toContain('已在后台派发')          // 立即返回,子代理仍在后台跑(done 未 resolve)
    expect(cancelWorkspaceDelegates('/wscancel')).toBe(1) // 跨轮取消表里能找到并杀掉它
    expect(cancelled).toBe(true)
    await new Promise((r) => setTimeout(r, 0))            // 让后台 finally(untrack)跑完
    expect(cancelWorkspaceDelegates('/wscancel')).toBe(0) // 已 untrack,不会重复取消
  })

  it('子代理异常时 onComplete 仍触发、text 标注失败(fire-and-forget 下失败不会石沉大海)', async () => {
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task) { return { id: task.agentId, cancel() {}, done: Promise.reject(new Error('boom')) } },
    }
    const r = await awaitDelegate(makeRunDelegate(deps(provider, ws(['a']))), { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per).toHaveLength(1)
    expect(r.per[0].ok).toBe(false)
    expect(r.text).toContain('失败')
    expect(r.text).toContain('boom')
  })

  it('fire-and-forget:立即返回「已派发」确认(per 空),真实产出经 onComplete 异步回呈', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: () => '结论X' }), ws(['a'])))
    let completed: DelegateResult | null = null
    const ack = await runDelegate({ workspacePath: '/ws', task: 't', provider: 'fake', model: 'm', onComplete: (r) => { completed = r } })
    // 立即返回的是「已派发」确认:不含真实产出(per 空),不阻塞主代理 → 不会撞 codex 180s tool 超时。
    expect(ack.per).toEqual([])
    expect(ack.text).toContain('已在后台派发')
    // 真实聚合产出在后台完成后经 onComplete 到达。
    await new Promise((r) => setTimeout(r, 0))
    expect(completed).not.toBeNull()
    expect((completed as unknown as DelegateResult).per).toHaveLength(1)
    expect((completed as unknown as DelegateResult).text).toContain('结论X')
  })

  // 探查卡死修复:子代理长时间零输出(codex 卡在自身 models 刷新/网络读)→ 空闲看门狗超时杀掉它,其 done 随即
  // reject → Promise.all 不再被永久拖死,整批仍能 onComplete 回呈(该项目标注超时失败)。
  it('子代理长时间无输出 → 空闲看门狗超时终止,不拖死整批「汇总回呈」', async () => {
    vi.useFakeTimers()
    try {
      let cancelled = false
      let rej: ((e: unknown) => void) | undefined
      const provider: AgentProvider = {
        id: 'codex', displayName: 'C', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
        detect: async () => true, listModels: async () => [],
        run(task) {
          const done = new Promise<AgentResult>((_r, reject) => { rej = reject })
          return { id: task.agentId, cancel() { cancelled = true; rej?.(new Error('killed')) }, done }
        },
      }
      let completed: DelegateResult | null = null
      void makeRunDelegate(depsFor('codex', provider, ws(['a'])))({ workspacePath: '/wsidle', task: 't', projects: ['a'], provider: 'codex', model: 'm', onComplete: (r) => { completed = r } })
      // 子代理从不产出任何活动 → 推进到超过空闲阈值,看门狗应 cancel 它,整批随后完成。
      await vi.advanceTimersByTimeAsync(DELEGATE_IDLE_KILL_MS + WATCHDOG_TICK_MS * 2)
      expect(cancelled).toBe(true)
      expect(completed).not.toBeNull()
      expect((completed as unknown as DelegateResult).per).toHaveLength(1)
      expect((completed as unknown as DelegateResult).per[0].ok).toBe(false)
      expect((completed as unknown as DelegateResult).per[0].summary).toContain('超时')
    } finally { vi.useRealTimers() }
  })
})
