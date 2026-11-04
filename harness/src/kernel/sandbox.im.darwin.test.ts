// 真跑 sandbox-exec(07 spec §8.2,Review Focus 3):IM 会话的 shell 改不了用户的分支,app 会话不受影响。
// 测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGit, pinRepo } from '../lib/git/snapshot'
import type { RepoPin } from '../lib/git/snapshot'
import { createImWorktree } from '../lib/git/imWorktree'
import type { SandboxService } from '../lib/tools/types'
import type { SessionOrigin } from '../protocol/index'
import { createSandboxService } from './sandbox'

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
}
const usable = sandboxExecUsable()

let root = ''
let home = ''
let data = ''
let repo = ''
let wtCwd = ''
let svc: SandboxService
const pins = new Map<string, RepoPin>()
const origins = new Map<string, SessionOrigin>()

const env = () => ({ PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' })
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

async function shell(sessionId: string, cwd: string, command: string): Promise<number | null> {
  const plan = await svc.plan(command, { sessionId, cwd, spillDir: join(data, 'sessions', sessionId, 'spill') }, env())
  expect(plan.sandboxed).toBe(true)
  try {
    return await new Promise((resolve, reject) => {
      const c = spawn(plan.file, plan.args, { cwd, env: plan.env, stdio: 'ignore' })
      c.on('error', reject)
      c.on('close', resolve)
    })
  } finally {
    plan.release()
  }
}

const userState = () => [ug(['for-each-ref']), ug(['rev-parse', 'HEAD']), ug(['status', '--porcelain']), ug(['log', '--oneline', 'main'])]

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-imsb-')))
  home = join(root, 'home')
  data = join(root, 'data')
  repo = join(home, 'repo')
  for (const d of [home, data, repo]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n')
  ug(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'a.txt'), '1\n')
  ug(['add', '-A'])
  ug(['commit', '-qm', 'one'])
  writeFileSync(join(repo, 'a.txt'), '2\n')
  ug(['commit', '-qam', 'two'])
  ug(['branch', 'other'])
  const git = createGit({ base: { PATH: env().PATH, HOME: home }, extraEnv: { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' } })
  const tmp = join(data, 'tmp')
  mkdirSync(tmp)
  const r = await createImWorktree({ dataDir: data, project: repo, group: 'c1', id: 'wt_1', git, tmpDir: tmp, untrusted: [data], writableRoots: [], denyReadOf: () => [] })
  if (!r.ok) throw new Error(r.error)
  wtCwd = r.cwd
  pins.set('im', await pinRepo(wtCwd, git, { tmpDir: tmp }))
  pins.set('app', await pinRepo(repo, git, { tmpDir: tmp }))
  origins.set('im', 'im')
  origins.set('app', 'app')
  svc = createSandboxService({
    platform: 'darwin', dataDir: data, home, env: { HOME: home, PATH: env().PATH }, detected: { level: 'full', missing: [] },
    permissions: () => ({ rules: [], network: { allow: [] }, allowUnsandboxedAuto: false, sandbox: { enabled: true, allowLoopback: false } }),
    rules: () => [], append: () => {}, repoPin: sid => pins.get(sid), originOf: sid => origins.get(sid), upstream: undefined,
  })
})
afterEach(async () => {
  await svc?.close()
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!usable)('Seatbelt, IM session in its worktree', () => {
  // 路径要到用例里才算:root 在 beforeEach 里才有。main 检出在用户那边,git 自己也拒绝动它,所以多一行 other 才看得出沙箱
  it.each<[string, () => string]>([
    ['git branch -f on the checked-out branch', () => 'git branch -f main HEAD~1'],
    ['git branch -f on another branch', () => 'git branch -f other HEAD~1'],
    ['git update-ref', () => 'git update-ref refs/heads/main HEAD~1'],
    ['git update-ref a new ref', () => 'git update-ref refs/heads/planted HEAD'],
    ['git commit', () => 'echo x > n.txt && git add n.txt && git -c user.name=t -c user.email=t@e.invalid commit -qm x'],
    ['a direct write to the common dir', () => `echo x > ${JSON.stringify(join(repo, '.git', 'planted'))}`],
    ['a write to its own git dir', () => `echo x > ${JSON.stringify(join(repo, '.git', 'worktrees', 'wt_1', 'planted'))}`],
  ])('%s fails and the user\'s refs do not move', async (_name, command) => {
    const before = userState()
    expect(await shell('im', wtCwd, command())).not.toBe(0)
    expect(userState()).toEqual(before)
    expect(existsSync(join(repo, '.git', 'planted'))).toBe(false)
  })

  it('a file write in the cwd succeeds, the control for the rows above', async () => {
    expect(await shell('im', wtCwd, 'echo x > f.txt')).toBe(0)
    expect(ug(['status', '--porcelain'])).toBe('')
    expect(ug(['status', '--porcelain'], wtCwd)).toContain('f.txt')
  })

  it('the worktree\'s .git file can not be rewritten', async () => {
    expect(await shell('im', wtCwd, 'echo "gitdir: /tmp/evil" > .git')).not.toBe(0)
  })
})

describe.skipIf(!usable)('Seatbelt, app session: no regression', () => {
  it('the same commands still work in the user\'s repo', async () => {
    const two = ug(['rev-parse', 'HEAD'])
    expect(await shell('app', repo, 'echo x > n.txt && git add n.txt && git -c user.name=t -c user.email=t@e.invalid commit -qm x')).toBe(0)
    expect(ug(['rev-parse', 'HEAD~1'])).toBe(two)
    expect(await shell('app', repo, 'git update-ref refs/heads/planted HEAD')).toBe(0)
    expect(ug(['for-each-ref'])).toContain('refs/heads/planted')
    expect(await shell('app', repo, 'git branch -f other HEAD~1')).toBe(0)
  })
})
