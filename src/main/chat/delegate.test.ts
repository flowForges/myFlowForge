import { describe, it, expect } from 'vitest'
import { makeRunDelegate } from './delegate'
import type { AgentProvider, AgentResult, AgentTask, AgentCallbacks } from '../agents/types'
import type { Workspace } from '../config/schema'

// A fake provider whose run() reports a handoff (or, optionally, only log output) then completes.
function fakeProvider(opts: { handoff?: (name: string) => string; output?: (name: string) => string } = {}): AgentProvider {
  return {
    id: 'fake', displayName: 'Fake', capabilities: { structuredOutput: false, permissionHook: false, pty: false },
    detect: async () => true, listModels: async () => [],
    run(task: AgentTask, cb: AgentCallbacks) {
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
    const r = await runDelegate({ workspacePath: '/ws', task: '看看登录逻辑', provider: 'fake', model: 'm' })
    expect(r.per.map(p => p.project).sort()).toEqual(['a', 'b'])
    expect(r.per.every(p => p.ok)).toBe(true)
    expect(r.text).toContain('a 的结论')
    expect(r.text).toContain('b 的结论')
  })

  it('projects 过滤只在指定项目执行', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: (n) => `${n}!` }), ws(['a', 'b', 'c'])))
    const r = await runDelegate({ workspacePath: '/ws', task: 't', projects: ['b'], provider: 'fake', model: 'm' })
    expect(r.per.map(p => p.project)).toEqual(['b'])
  })

  it('无 handoff 时退回用日志输出作为 summary', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ output: (n) => `${n} 输出内容` }), ws(['a'])))
    const r = await runDelegate({ workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
    expect(r.per[0].summary).toContain('a 输出内容')
  })

  it('工作区无项目时在工作区根跑单个子代理', async () => {
    const runDelegate = makeRunDelegate(deps(fakeProvider({ handoff: () => 'root done' }), ws([])))
    const r = await runDelegate({ workspacePath: '/ws', task: 't', provider: 'fake', model: 'm' })
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
})
