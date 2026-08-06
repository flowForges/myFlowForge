import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 事故背景:每个项目目录是 ~/.myFlowForge/repos/<id>.git 的 git worktree,.git 只是个指向那里的指针。
// 用户重装 app 时删掉 ~/.myFlowForge(很自然的动作)→ 所有项目 git 永久失效;而重建所需的 repoUrl
// 只存在于同样被删掉的全局注册表里,于是**无法自动恢复**。
// 对策:把 repoUrl 也存一份进工作区自己的 .forge/workspace.json —— 它不在被删范围内。
let tmp: string
vi.mock('./paths', async (orig) => {
  const actual = await orig<typeof import('./paths')>()
  return { ...actual, SYS_DIR: '__REPLACED__', sysFile: (n: string) => join((globalThis as any).__SYS__, n) }
})

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'forge-repourl-')); ;(globalThis as any).__SYS__ = tmp })
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const wsFile = (wsPath: string) => join(wsPath, '.forge', 'workspace.json')

function writeRawWorkspace(wsPath: string, projects: unknown[]) {
  mkdirSync(join(wsPath, '.forge'), { recursive: true })
  writeFileSync(wsFile(wsPath), JSON.stringify({
    name: 'ws', path: wsPath, workflowId: '', stages: [], workflows: [],
    projects, status: 'idle', plugins: [], stepPlugins: [],
  }), 'utf8')
}

describe('workspace.json 里的 repoUrl 副本', () => {
  it('老工作区(没有 repoUrl 字段)照常能解析 —— 不能让新字段把存量文件读挂', async () => {
    const { readWorkspace } = await import('./store')
    const wsPath = join(tmp, 'ws-legacy')
    writeRawWorkspace(wsPath, [{ repoId: 'api', name: 'api', branch: 'main', provider: '', model: '' }])
    const ws = readWorkspace(wsPath)
    expect(ws).not.toBeNull()
    expect(ws!.projects[0].repoId).toBe('api')
  })

  it('注册表还在时,读取会把地址回填进工作区并落盘(趁还能拿到)', async () => {
    const { readWorkspace, writeProjects } = await import('./store')
    writeProjects({ projects: [{ id: 'api', name: 'api', repoUrl: 'https://git.example/api.git', defaultBranch: 'main' }] })
    const wsPath = join(tmp, 'ws-backfill')
    writeRawWorkspace(wsPath, [{ repoId: 'api', name: 'api', branch: 'main', provider: '', model: '' }])

    const ws = readWorkspace(wsPath)
    expect(ws!.projects[0].repoUrl).toBe('https://git.example/api.git')
    // 必须真的写回盘 —— 只在内存里补等于没补,注册表一删就又没了
    const onDisk = JSON.parse(readFileSync(wsFile(wsPath), 'utf8'))
    expect(onDisk.projects[0].repoUrl).toBe('https://git.example/api.git')
  })

  it('★ 回填之后,即使注册表被整个删掉,地址依然读得到 —— 这正是这条改动要防的事故', async () => {
    const { readWorkspace, writeProjects } = await import('./store')
    writeProjects({ projects: [{ id: 'api', name: 'api', repoUrl: 'https://git.example/api.git', defaultBranch: 'main' }] })
    const wsPath = join(tmp, 'ws-survive')
    writeRawWorkspace(wsPath, [{ repoId: 'api', name: 'api', branch: 'main', provider: '', model: '' }])
    readWorkspace(wsPath)                       // 触发回填

    writeProjects({ projects: [] })             // 模拟 ~/.myFlowForge 被删(注册表没了)
    const after = readWorkspace(wsPath)
    expect(after!.projects[0].repoUrl).toBe('https://git.example/api.git')
  })

  it('注册表里没有该项目时保持空,不瞎猜地址', async () => {
    const { readWorkspace } = await import('./store')
    const wsPath = join(tmp, 'ws-unknown')
    writeRawWorkspace(wsPath, [{ repoId: 'gone', name: 'gone', branch: 'main', provider: '', model: '' }])
    expect(readWorkspace(wsPath)!.projects[0].repoUrl ?? '').toBe('')
  })

  it('inPlace 项目不回填(它本来就没有注册表条目,是用户自己的仓库)', async () => {
    const { readWorkspace, writeProjects } = await import('./store')
    writeProjects({ projects: [{ id: 'api', name: 'api', repoUrl: 'https://git.example/api.git', defaultBranch: 'main' }] })
    const wsPath = join(tmp, 'ws-inplace')
    writeRawWorkspace(wsPath, [{ repoId: 'api', name: 'api', branch: 'main', provider: '', model: '', inPlace: true }])
    expect(readWorkspace(wsPath)!.projects[0].repoUrl ?? '').toBe('')
  })

  it('已经有地址的工作区不会被重复写盘(回填只在真的缺失时发生)', async () => {
    const { readWorkspace, writeProjects } = await import('./store')
    writeProjects({ projects: [{ id: 'api', name: 'api', repoUrl: 'https://new.example/api.git', defaultBranch: 'main' }] })
    const wsPath = join(tmp, 'ws-keep')
    writeRawWorkspace(wsPath, [{ repoId: 'api', name: 'api', branch: 'main', provider: '', model: '', repoUrl: 'https://old.example/api.git' }])
    // 工作区里已有的值优先,不被注册表覆盖 —— 用户可能有意改过,回填只补空缺
    expect(readWorkspace(wsPath)!.projects[0].repoUrl).toBe('https://old.example/api.git')
  })
})
