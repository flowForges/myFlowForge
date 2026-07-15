import { describe, it, expect } from 'vitest'
import { makeRunDelegate, cancelWorkspaceDelegates, type DelegateResult } from './delegate'

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
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: '看看登录逻辑', provider: 'fake', model: 'm' })
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
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per[0].summary).toContain('a 输出内容')
  })

  it('工作区无项目时在工作区根跑单个子代理', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: () => 'root done' }), ws([])))
    const r = await awaitDelegate(runDelegate, { workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per).toHaveLength(1)
    expect(r.per[0].project).toBe('workspace')
    expect(r.text).toContain('root done')
  })

  it('权限盾牌下沉:write=false→子代理 readonly;write=true→用会话盾牌', async () => {
    const seen: Record<string, string | undefined> = {}
    const provider: AgentProvider = {
      id: 'fake', displayName: 'F', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
      detect: async () => true, listModels: async () => [],
      run(task, cb) { seen[task.name] = task.permissionMode; cb.onHandoff?.({ summary: 'ok' }); cb.onDone({ ok: true }); return { id: task.agentId, cancel() {}, done: Promise.resolve({ ok: true } as AgentResult) } },
    }
    await makeRunDelegate(deps(provider, ws(['a'])))({ workspacePath: '/ws', task: 't', write: false, provider: 'fake', model: 'm' })
    expect(seen['a']).toBe('readonly')
    await makeRunDelegate(deps(provider, ws(['b'])))({ workspacePath: '/ws', task: 't', write: true, permissionMode: 'full', provider: 'fake', model: 'm' })
    expect(seen['b']).toBe('full')
  })

  it('传 sessionId 时把子代理登记进 delegateRegistry(供 IDs 面板),完成后置 ok', async () => {
    await makeRunDelegate(deps(fakeProvider({ handoff: () => 'x' }), ws(['a', 'b'])))({ workspacePath: '/wsreg', task: 't', provider: 'fake', model: 'm', sessionId: 's1' })
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
    await makeRunDelegate(deps(provider, ws(['a'])))({ workspacePath: '/wsg', task: 't', provider: 'fake', model: 'm', sessionId: 's1' })
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
})
