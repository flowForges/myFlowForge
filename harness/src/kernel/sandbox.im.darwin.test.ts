// 真跑 sandbox-exec(07 spec §8.2,Review Focus 3):IM 会话的 shell 改不了用户的分支,app 会话不受影响。
// 测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
const projectTops = new Map<string, string>()

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

/** 跑完给退出码和输出,用来同时看"读不到"和"读到了什么" */
async function run(sessionId: string, cwd: string, command: string): Promise<{ code: number | null; out: string }> {
  const plan = await svc.plan(command, { sessionId, cwd, spillDir: join(data, 'sessions', sessionId, 'spill') }, env())
  expect(plan.sandboxed).toBe(true)
  return collect(plan, cwd)
}

/** xcrun 的壳没命中共享缓存、写新缓存被沙箱拒时打的那一行(见文件末尾那条用例);只去掉这一行,别的输出原样比 */
const XCRUN_DENIED = /^[\w.-]+: error: couldn't create cache file '[^'\n]*\/xcrun_db-[A-Za-z0-9]+' \(errno=Operation not permitted\)\n/gm

async function collect(plan: { file: string; args: string[]; env: NodeJS.ProcessEnv; release(): void }, cwd: string): Promise<{ code: number | null; out: string }> {
  try {
    return await new Promise((resolve, reject) => {
      const c = spawn(plan.file, plan.args, { cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      c.stdout.on('data', d => (out += d))
      c.stderr.on('data', d => (out += d))
      c.on('error', reject)
      c.on('close', code => resolve({ code, out: out.replace(XCRUN_DENIED, '') }))
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
  projectTops.set('im', repo)
  svc = createSandboxService({
    platform: 'darwin', dataDir: data, home, env: { HOME: home, PATH: env().PATH }, detected: { level: 'full', missing: [] },
    permissions: () => ({ rules: [], network: { allow: [] }, allowUnsandboxedAuto: false, sandbox: { enabled: true, allowLoopback: false } }),
    rules: () => [], append: () => {}, repoPin: sid => pins.get(sid), originOf: sid => origins.get(sid), projectTopOf: sid => projectTops.get(sid), upstream: undefined,
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

const SECRET = 'UNTRACKED-ENV-VALUE'

describe.skipIf(!usable)('Seatbelt, IM session and the checkout it came from (§8.1)', () => {
  beforeEach(() => {
    writeFileSync(join(repo, '.env'), `TOKEN=${SECRET}\n`)
  })

  it('the control: an app session in the project reads the untracked .env', async () => {
    expect(await run('app', repo, 'cat .env')).toEqual({ code: 0, out: `TOKEN=${SECRET}\n` })
  })

  it('the .env really is not in the worktree', () => {
    expect(existsSync(join(wtCwd, '.env'))).toBe(false)
  })

  it.each<[string, () => string]>([
    ['cat', () => `cat ${JSON.stringify(join(repo, '.env'))}`],
    ['a tracked file with no copy problem', () => `cat ${JSON.stringify(join(repo, 'a.txt'))}`],
    ['listing the project', () => `ls -a ${JSON.stringify(repo)}`],
    ['a hard link into the cwd', () => `ln ${JSON.stringify(join(repo, '.env'))} leak && cat leak`],
    ['a symlink in the cwd', () => `ln -s ${JSON.stringify(join(repo, '.env'))} leak && cat leak`],
    ['copy to the session tmp', () => `cp ${JSON.stringify(join(repo, '.env'))} "$TMPDIR/leak" && cat "$TMPDIR/leak"`],
    ['the path found from the git file', () => 'cat "$(dirname "$(git rev-parse --git-common-dir)")/.env"'],
  ])('at full: %s fails and shows nothing', async (_name, command) => {
    const r = await run('im', wtCwd, command())
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain(SECRET)
    expect(r.out).not.toContain('.env\n')
  })

  // git only lstats its way through the top and can't open it, so these exit 0 with an empty view
  it.each<[string, () => string]>([
    ['git run against the project', () => `git -C ${JSON.stringify(repo)} status --porcelain --ignored`],
    ['git with the project as work tree', () => `git --work-tree=${JSON.stringify(repo)} ls-files --others`],
  ])('at full: %s does not see the untracked file', async (_name, command) => {
    const r = await run('im', wtCwd, command())
    expect(r.out).not.toContain(SECRET)
    expect(r.out).not.toContain('.env')
  })

  it('git status, log, diff and show still work in the worktree', async () => {
    expect(await run('im', wtCwd, 'git status --porcelain')).toEqual({ code: 0, out: '' })
    const log = await run('im', wtCwd, 'git log --format=%s')
    expect(log).toEqual({ code: 0, out: 'two\none\n' })
    expect(await run('im', wtCwd, 'git show HEAD:a.txt')).toEqual({ code: 0, out: '2\n' })
    expect(await run('im', wtCwd, 'echo 3 > a.txt && git diff --stat')).toMatchObject({ code: 0, out: expect.stringContaining('a.txt') })
    expect((await run('im', wtCwd, 'git status --porcelain')).out).toContain('a.txt')
  })

  it('what stays readable: tracked .env-like files in the worktree, and other files outside credentials', async () => {
    writeFileSync(join(repo, '.env.example'), 'TRACKED=1\n')
    ug(['add', '.env.example'])
    ug(['commit', '-qm', 'three'])
    ug(['reset', '-q', '--hard', 'HEAD'], wtCwd)
    ug(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'main~0'], wtCwd)
    expect(await run('im', wtCwd, 'cat .env.example')).toEqual({ code: 0, out: 'TRACKED=1\n' })
    const elsewhere = join(home, 'notes.txt')
    writeFileSync(elsewhere, 'note\n')
    expect(await run('im', wtCwd, `cat ${JSON.stringify(elsewhere)}`)).toEqual({ code: 0, out: 'note\n' })
  })

  it('a delegated run through planExec gets the same deny, and git still works', async () => {
    const opts = { allowRead: [], allowWrite: [], allowHosts: [], proxyScope: 'r1', readOnly: false, denyRead: [], denyWrite: [] }
    const spillDir = join(data, 'sessions', 'im', 'spill')
    const denied = await collect(await svc.planExec('/bin/cat', [join(repo, '.env')], { sessionId: 'im', cwd: wtCwd, spillDir }, env(), opts), wtCwd)
    expect(denied.code).not.toBe(0)
    expect(denied.out).not.toContain(SECRET)
    const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    expect(await collect(await svc.planExec(git, ['log', '--format=%s'], { sessionId: 'im', cwd: wtCwd, spillDir }, env(), { ...opts, proxyScope: 'r2' }), wtCwd)).toEqual({ code: 0, out: 'two\none\n' })
    // the policy Codex translates carries it too
    const policy = svc.execPolicy('im', wtCwd, 'codex')
    expect(policy.denyRead).toContain(repo)
    expect(policy.keepRead).toContain(join(repo, '.git'))
    expect(svc.execPolicy('app', repo, 'codex').denyRead).not.toContain(repo)
  })

  // 09 Task 11 抓到的偶发失败:/usr/bin/git 是 xcrun 的壳。共享的 xcrun_db 在用户临时目录里,别的进程随时在重写;
  // 沙箱里的壳没命中就想写一份新的,被拒,往 stderr 打一行,退出码还是 0。写不进去是对的:能写这份缓存就能替没沙箱的进程改工具路径
  it('xcrun shim: a cache miss in the sandbox cannot write the shared cache, and its one line is all that differs', async () => {
    const userTmp = realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim())
    const caches = () => readdirSync(userTmp).filter(n => n.startsWith('xcrun_db')).sort()
    const before = caches()
    const opts = { allowRead: [], allowWrite: [], allowHosts: [], proxyScope: 'x1', readOnly: false, denyRead: [], denyWrite: [] }
    // 没见过的 TOOLCHAINS:缓存里一定没有这个键
    const missEnv = { ...env(), TOOLCHAINS: `mffai-miss-${process.pid}-${Date.now()}` }
    const plan = await svc.planExec('/usr/bin/git', ['--version'], { sessionId: 'im', cwd: wtCwd, spillDir: join(data, 'sessions', 'im', 'spill') }, missEnv, opts)
    const r = await collect(plan, wtCwd)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/^git version \S+.*\n$/)
    expect(caches()).toEqual(before)
  })

  it('a project that is itself a linked worktree: that checkout and the main one are both hidden, git works', async () => {
    const linked = join(home, 'linked')
    ug(['worktree', 'add', '-q', '-b', 'side', linked])
    writeFileSync(join(linked, '.env'), `TOKEN=${SECRET}-linked\n`)
    projectTops.set('im', linked)
    for (const f of [join(linked, '.env'), join(repo, '.env')]) {
      const r = await run('im', wtCwd, `cat ${JSON.stringify(f)}`)
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain(SECRET)
    }
    expect(await run('im', wtCwd, 'git log -1 --format=%s')).toEqual({ code: 0, out: 'two\n' })
  })

  it('a symlink to the project spelled another way is still hidden', async () => {
    const alias = join(home, 'alias')
    symlinkSync(repo, alias)
    const r = await run('im', wtCwd, `cat ${JSON.stringify(join(alias, '.env'))}`)
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain(SECRET)
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
