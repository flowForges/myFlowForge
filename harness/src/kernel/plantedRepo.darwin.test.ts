// 真跑 sandbox-exec(final review C-1、I-2):沙箱里种一个 `.git` 和跑代码的过滤器,沙箱外的 git 不能认它。
// 走的是评审复现的路线:沙箱内 shell 写文件 → 沙箱外拍快照。标记文件在 cwd 外,沙箱里写不到,只有逃出去才会出现。
// 临时 HOME / git 配置;测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGit, NO_REPO, pinFromPaths, pinRepo, takeSnapshot, type Git, type RepoPin } from '../lib/git/snapshot'
import type { SandboxService } from '../lib/tools/types'
import { endSnapshot, rollbackTurn, startSnapshot, turnChanges, type SnapshotDeps } from '../plugins/loop-default/snapshots'
import type { KernelEvent } from '../protocol/index'
import { createSandboxService } from './sandbox'

const usable = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0

const SID = 's1'
let root = ''
let home = ''
let data = ''
let repo = ''
let outside = ''
let marker = ''
let pin: RepoPin = NO_REPO
let svc: SandboxService
let git: Git
let gitCalls = 0
let events: KernelEvent[] = []

const gitEnv = () => ({ PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
const ug = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: gitEnv() }).toString()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-plant-')))
  home = join(root, 'home')
  data = join(root, 'data')
  repo = join(root, 'repo')
  outside = join(root, 'outside')
  marker = join(outside, 'ESCAPED')
  for (const d of [home, data, repo, outside]) mkdirSync(d)
  writeFileSync(join(home, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n')
  ug(['init', '-q'])
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'keep.txt'), 'k\n')
  ug(['add', '-A'])
  ug(['commit', '-qm', 'init'])
  const real = createGit({ base: gitEnv() })
  gitCalls = 0
  git = (a, o) => { gitCalls++; return real(a, o) }
  events = [{ type: 'message.user', sessionId: SID, seq: 0, ts: 0, payload: { turnId: 't1', text: 'x' } } as unknown as KernelEvent]
  svc = createSandboxService({
    platform: 'darwin', dataDir: data, home, env: { HOME: home }, detected: { level: 'full', missing: [] },
    permissions: () => ({ rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }),
    rules: () => [],
    append: () => {},
    repoPin: () => pin,
  })
})
afterEach(async () => {
  await svc.close()
  rmSync(root, { recursive: true, force: true })
})

const deps = (): SnapshotDeps => ({
  git,
  tmpDir: (mkdirSync(join(root, 'snap'), { recursive: true }), join(root, 'snap')),
  log: { info() {}, warn() {}, error() {} },
  append: e => void events.push({ ...e, seq: events.length, ts: 0 } as KernelEvent),
})

/** 会话的 shell 工具:真的进 Seatbelt */
async function shell(command: string, cwd: string): Promise<number | null> {
  const plan = await svc.plan(command, { sessionId: SID, cwd, spillDir: join(data, 'sessions', SID, 'spill') }, { PATH: '/usr/bin:/bin', HOME: home })
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

/** 评审的 PoC,除了 `.git`:clean = tclsh,程序从 stdin 读,就是 payload 的内容 */
const plantScript = (filter = 'tclsh') => [
  `mkdir -p evil/objects evil/refs`,
  `printf 'ref: refs/heads/main\\n' > evil/HEAD`,
  `printf '[filter "x"]\\n\\tclean = ${filter}\\n' > evil/config`,
  `printf 'payload filter=x\\n' > .gitattributes`,
  `printf 'exec /usr/bin/touch ${marker}\\n' > payload`,
].join(' && ')

/**
 * 沙箱里写得出来的都写;`.git` 本身 Seatbelt 不让建(R1-I1),这里断言。
 * 之后从沙箱外补上:代表 Seatbelt 管不到的来路(Codex 的 sub/.git、bwrap、修复之前种下的)
 */
async function plant(cwd: string, filter?: string): Promise<void> {
  // 对照:沙箱确实拦着直接写
  expect(await shell(`/usr/bin/touch ${JSON.stringify(marker)}`, cwd)).not.toBe(0)
  expect(existsSync(marker)).toBe(false)
  expect(await shell(plantScript(filter), cwd)).toBe(0)
  expect(await shell(`printf 'gitdir: evil\\n' > .git`, cwd)).not.toBe(0)
  expect(existsSync(join(cwd, '.git'))).toBe(false)
  writeFileSync(join(cwd, '.git'), 'gitdir: evil\n')
  expect(lstatSync(join(cwd, '.git')).isFile()).toBe(true)
  expect(existsSync(join(cwd, 'evil', 'config'))).toBe(true)
}

const snapshots = () => events.filter(e => e.type === 'turn.snapshot').map(e => e.payload as { phase: string; ref?: string; reason?: string })

describe.skipIf(!usable)('a planted .git, real Seatbelt (final review C-1)', () => {
  it('control: the fixture is live. Plain git that discovers the repo from the cwd does run the payload', async () => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    pin = NO_REPO
    await plant(cwd)
    ug(['add', '-A'], cwd)
    expect(existsSync(marker)).toBe(true)
  })

  it('session in a repo subdirectory: every git call stays on the pinned repo, the payload never runs', async () => {
    const cwd = join(repo, 'sub')
    pin = await pinRepo(cwd, git)
    expect(pin).toMatchObject({ kind: 'repo', top: repo })
    const t = { sessionId: SID, cwd, pin }
    const start = await startSnapshot(deps(), t, 't1')
    expect(start).toBeDefined()
    await plant(cwd)
    await endSnapshot(deps(), t, 't1', start)
    await startSnapshot(deps(), t, 't2')
    await turnChanges(deps(), t, events, 't1').catch(() => {})
    await rollbackTurn(deps(), t, events, 't1').catch(() => {})
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(cwd, 'evil', 'refs', 'mffai'))).toBe(false)
  })

  it('session in a non-git cwd: pinned "none", git never runs at all, not at the next turn either', async () => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    pin = await pinRepo(cwd, git)
    expect(pin).toEqual(NO_REPO)
    gitCalls = 0
    const t = { sessionId: SID, cwd, pin }
    const start = await startSnapshot(deps(), t, 't1')
    await plant(cwd)
    await endSnapshot(deps(), t, 't1', start)
    await startSnapshot(deps(), t, 't2')
    expect(snapshots().map(s => s.reason)).toEqual(['not_git', 'not_git', 'not_git'])
    expect(gitCalls).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('the next session in that cwd does not pin the planted repo, from a non-git cwd or a repo subdirectory', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    pin = NO_REPO
    await plant(plain)
    expect(await pinRepo(plain, git)).toEqual(NO_REPO)
    const sub = join(repo, 'sub')
    pin = await pinRepo(sub, git)
    await plant(sub)
    gitCalls = 0
    const next = await pinRepo(sub, git)
    expect(next).toEqual(NO_REPO)
    expect(await takeSnapshot(sub, 'refs/mffai/x/t-start', git, { pin: next })).toEqual({ reason: 'not_git' })
    expect(existsSync(marker)).toBe(false)
  })

  it.each(['tclsh', 'osascript', 'sqlite3', 'expect', '/usr/bin/tclsh'])('second layer, if a planted repo were pinned anyway: the allowlist refuses %s', async filter => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    pin = NO_REPO
    await plant(cwd, filter)
    const later = pinFromPaths(cwd, join(cwd, 'evil'), join(cwd, 'evil'))
    expect(await takeSnapshot(cwd, 'refs/mffai/x/t-start', git, { pin: later })).toEqual({ reason: 'unsafe_filter' })
    expect(existsSync(marker)).toBe(false)
  })

  it('from inside the sandbox, a commondir file in the real git dir can not be written', async () => {
    pin = await pinRepo(repo, git)
    expect(await shell(`printf 'evil\\n' > .git/commondir`, repo)).not.toBe(0)
    expect(existsSync(join(repo, '.git', 'commondir'))).toBe(false)
    expect(await shell(`printf 'x\\n' > .git/description`, repo)).toBe(0) // 对照:git 目录的其余部分照常可写
  })
})

describe.skipIf(!usable)('nothing named .git can be created in the sandbox (re-review R1-I1)', () => {
  it.each([
    ['a file', `printf 'gitdir: evil\\n' > .git`],
    ['a directory', 'mkdir .git'],
    ['a symlink', 'ln -s evil .git'],
    ['a rename', 'mkdir z && mv z .git'],
    ['another letter case', 'mkdir .GIT'],
    ['a nested file', `mkdir -p a/b && printf 'gitdir: evil\\n' > a/b/.git`],
  ])('%s fails', async (_name, command) => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    pin = NO_REPO
    expect(await shell(command, cwd)).not.toBe(0)
    expect(existsSync(join(cwd, '.git'))).toBe(false)
    expect(existsSync(join(cwd, 'a', 'b', '.git'))).toBe(false)
  })

  it('.gitignore, .github, .gitattributes and x.git still work', async () => {
    const cwd = join(root, 'plain')
    mkdirSync(cwd)
    pin = NO_REPO
    expect(await shell('printf x > .gitignore && mkdir .github && printf x > .gitattributes && mkdir x.git && printf x > a.git', cwd)).toBe(0)
  })

  it('pin "none" over a real repo: moving .git aside, planting a hook and moving it back fails at the move back', async () => {
    pin = NO_REPO
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    expect(await shell('mv .git g; mkdir -p g/hooks; printf x > g/hooks/pre-commit; mv g .git', repo)).not.toBe(0)
    expect(existsSync(hook)).toBe(false)
    expect(existsSync(join(repo, '.git'))).toBe(false)
  })
})

describe.skipIf(!usable)('CLI config dirs in the cwd, real Seatbelt (final review I-2)', () => {
  it.each([
    ['mkdir .codex'],
    ['mkdir .qoder'],
    ['mkdir .CODEX'],
    ['mkdir .Qoder'],
    ['mkdir x && ln -s x .codex'],
    ['mkdir y && printf z > y/config.toml && mv y .codex'],
  ])('%s fails', async command => {
    pin = await pinRepo(repo, git)
    expect(await shell(`${command}`, repo)).not.toBe(0)
    expect(existsSync(join(repo, '.codex'))).toBe(false)
    expect(existsSync(join(repo, '.qoder'))).toBe(false)
  })

  it('an existing .codex stays read-only and can not be moved; a normal write next to it works', async () => {
    pin = await pinRepo(repo, git)
    mkdirSync(join(repo, '.codex'))
    writeFileSync(join(repo, '.codex', 'config.toml'), 'keep\n')
    expect(await shell(`printf x >> .codex/config.toml`, repo)).not.toBe(0)
    expect(await shell(`printf x > .codex/hooks.json`, repo)).not.toBe(0)
    expect(await shell(`mv .codex gone`, repo)).not.toBe(0)
    expect(await shell(`cat .codex/config.toml > /dev/null`, repo)).toBe(0)
    expect(await shell(`printf x > ok.txt`, repo)).toBe(0)
    expect(existsSync(join(repo, 'ok.txt'))).toBe(true)
  })
})
