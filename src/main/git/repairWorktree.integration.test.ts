// 真 git 集成测试 —— 这类破坏性 git 操作用假 GitRunner 测等于没测(本仓库有前科:tempBranch 的
// 假 runner 让一个"丢改动"的致命 bug 连过四轮评审)。这里全程用真仓库、真 worktree、真删目录。
//
// 覆盖的事故:用户建了工作区拉了几个项目 → 手动删掉 ~/.myFlowForge → 所有项目 git 失效。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './gitRunner'
import { diagnoseRepo, repairDanglingRepo, readGitdirPointer } from './repairWorktree'

let gitAvailable = true
try { execSync('git --version', { stdio: 'ignore' }) } catch { gitAvailable = false }

describe.skipIf(!gitAvailable)('删掉 ~/.myFlowForge 后的 git 失效:检测与就地修复', () => {
  let root = ''
  let origin = ''
  let sys = ''
  let proj = ''

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'repair-'))
    origin = join(root, 'origin')
    sys = join(root, 'sys', 'repos')       // 扮演 ~/.myFlowForge/repos
    const ws = join(root, 'ws')
    proj = join(ws, 'proj')
    mkdirSync(origin, { recursive: true }); mkdirSync(sys, { recursive: true }); mkdirSync(ws, { recursive: true })

    // 远端
    await git(['init', '-b', 'main', '.'], { cwd: origin })
    await git(['config', 'user.email', 't@t'], { cwd: origin })
    await git(['config', 'user.name', 't'], { cwd: origin })
    writeFileSync(join(origin, 'a.txt'), 'upstream\n')
    await git(['add', '-A'], { cwd: origin })
    await git(['commit', '-m', 'init'], { cwd: origin })

    // Forge 的做法:bare mirror + worktree
    const mirror = join(sys, 'proj.git')
    await git(['clone', '--bare', origin, mirror], { cwd: sys })
    await git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { cwd: mirror })
    await git(['fetch', '--prune', 'origin'], { cwd: mirror })
    await git(['worktree', 'add', '-B', 'forge/proj', proj, 'main'], { cwd: mirror })
  })
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

  const nukeSysDir = () => rmSync(join(root, 'sys'), { recursive: true, force: true })

  it('健康的 worktree 判为 ok', async () => {
    expect(await diagnoseRepo(proj)).toEqual({ state: 'ok' })
  })

  it('项目里的 .git 是【文件】,内容指向工作区之外的 mirror —— 这就是事故的结构性原因', () => {
    const dot = join(proj, '.git')
    expect(statSync(dot).isFile()).toBe(true)
    const ptr = readGitdirPointer(proj)!
    expect(ptr).toContain('proj.git')
    expect(ptr.startsWith(join(root, 'ws'))).toBe(false)   // 在工作区之外 → 删 ~/.myFlowForge 就没了
  })

  it('删掉 sys 目录后判为 dangling,而不是笼统的 broken', async () => {
    nukeSysDir()
    const h = await diagnoseRepo(proj)
    expect(h.state).toBe('dangling')
    if (h.state === 'dangling') expect(existsSync(h.gitdir)).toBe(false)
  })

  it('修复后:git 恢复可用、历史回来、未提交改动与未跟踪文件全部保留', async () => {
    // 用户这几天干的活:改了已有文件 + 新增了文件
    writeFileSync(join(proj, 'a.txt'), 'upstream\nmy days of work\n')
    writeFileSync(join(proj, 'new-feature.ts'), 'export const x = 1\n')
    nukeSysDir()

    const r = await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'main' })
    expect(r).toMatchObject({ ok: true, branch: 'forge/proj', baseBranch: 'main' })

    expect(await diagnoseRepo(proj)).toEqual({ state: 'ok' })
    // 历史回来了
    const log = await git(['log', '--oneline'], { cwd: proj })
    expect(log).toContain('init')
    // ★ 用户的文件一个字都没动
    expect(readFileSync(join(proj, 'a.txt'), 'utf8')).toBe('upstream\nmy days of work\n')
    expect(readFileSync(join(proj, 'new-feature.ts'), 'utf8')).toBe('export const x = 1\n')
    // 且被正确识别成「已修改 / 未跟踪」,而不是凭空消失
    const st = await git(['status', '--short'], { cwd: proj })
    expect(st).toMatch(/M\s+a\.txt/)
    expect(st).toMatch(/\?\?\s+new-feature\.ts/)
  })

  it('修复后上游指向 origin/<base>,「变更」才能正确对比基线', async () => {
    nukeSysDir()
    await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'main' })
    const st = await git(['status', '--short', '-b'], { cwd: proj })
    expect(st).toContain('forge/proj...origin/main')
  })

  it('基线分支名对不上时退到 FETCH_HEAD,不留下空 HEAD', async () => {
    writeFileSync(join(proj, 'keep.txt'), 'keep\n')
    nukeSysDir()
    const r = await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'no-such-branch' })
    expect(r.ok).toBe(true)
    // HEAD 有提交(不是空仓库),文件也还在
    await expect(git(['rev-parse', 'HEAD'], { cwd: proj })).resolves.toBeTruthy()
    expect(existsSync(join(proj, 'keep.txt'))).toBe(true)
  })

  it('幂等:对已修好的仓库再点一次修复会被拒绝,不会二次破坏', async () => {
    nukeSysDir()
    await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'main' })
    const again = await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'main' })
    expect(again).toMatchObject({ ok: false })
    expect(await diagnoseRepo(proj)).toEqual({ state: 'ok' })
  })

  it('拒绝对健康仓库动手(防止误点把好仓库的元数据洗掉)', async () => {
    const r = await repairDanglingRepo({ cwd: proj, repoUrl: origin, baseBranch: 'main' })
    expect(r).toMatchObject({ ok: false })
    expect(await diagnoseRepo(proj)).toEqual({ state: 'ok' })
    // .git 仍是原来的 worktree 指针文件,没被删
    expect(statSync(join(proj, '.git')).isFile()).toBe(true)
  })

  it('没有仓库地址时直接报错,不半途把 .git 删了留个更烂的现场', async () => {
    nukeSysDir()
    const r = await repairDanglingRepo({ cwd: proj, repoUrl: '  ', baseBranch: 'main' })
    expect(r).toMatchObject({ ok: false })
    expect(existsSync(join(proj, '.git'))).toBe(true)   // 现场未被破坏
  })
})
