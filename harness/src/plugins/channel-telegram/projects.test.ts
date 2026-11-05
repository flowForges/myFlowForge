// 项目(07 spec §8.1、Review Focus 3 插件这一半):真 git,临时目录,私聊走到底。
// git 全经 extraEnv 给配置:createGit 去掉 base 里的 GIT_*,放 base 里全局配置等于没读
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imWorktreeRootOf } from '../../lib/git/imWorktree'
import { createGit, type Git } from '../../lib/git/snapshot'
import { ERR_BUSY } from '../../protocol/index'
import { CODEX_OK, delegate, untilGo } from '../../../test/executorRig'
import { cleanupFakes, installFake } from '../../../test/fakeCli'
import { calling, say, type Script } from '../../../test/memoryRig'
import { chatOf, events, flow, gatedScript, handled, gatedStream, onDisk, online, pairedRig, stateFile, texts, users, type ChatRigOpts } from '../../../test/telegramChats'
import type { TelegramRig } from '../../../test/telegramRig'
import { createExecutorCli } from '../executor-cli/index'
import { createLoopDefault } from '../loop-default'
import { createToolsCoding } from '../tools-coding'
import toolsRegistry from '../tools-registry'
import { TelegramState } from './state'

const BUSY = '这轮还在跑,先 /cancel'
const PATH = process.env.PATH ?? '/usr/bin:/bin'

let base: string
let repo: string
let home: string
let systemTmp: string
let git: Git
const rigs: TelegramRig[] = []

const shEnv = () => ({ PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base })
const sh = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, env: shEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-tgproj-')))
  repo = join(base, 'repo')
  home = join(base, 'home')
  systemTmp = join(base, 'systmp')
  for (const d of [repo, home, systemTmp]) mkdirSync(d)
  writeFileSync(join(base, 'gitconfig'), '[user]\n\tname = t\n\temail = t@example.invalid\n[commit]\n\tgpgSign = false\n[init]\n\tdefaultBranch = main\n')
  sh(['init', '-q'])
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'sub', 'b.txt'), 'b\n')
  sh(['add', '-A'])
  sh(['commit', '-qm', 'init'])
  git = createGit({ base: { PATH, HOME: home }, extraEnv: { GIT_CONFIG_GLOBAL: join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: base } })
})

afterEach(async () => {
  await Promise.all(rigs.splice(0).map(r => r.close()))
  cleanupFakes()
  rmSync(base, { recursive: true, force: true })
})

type Project = { name: string; path: string; auto?: boolean }
type Rig = ChatRigOpts & { projects?: Project[] }

const coding = (env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home }) => [
  toolsRegistry,
  createToolsCoding({ shellEnv: env, loginPath: async () => '', git: async () => { throw new Error('no git') } }),
]

async function rig(o: Rig = {}): Promise<TelegramRig> {
  const { projects = [{ name: 'api', path: repo }], config, channel, plugins, ...rest } = o
  const r = await pairedRig({
    ...rest,
    config: { ...config, channels: { telegram: { projects } } },
    channel: { git, home, systemTmp, ...channel },
    plugins: plugins ?? (() => [...coding(), createLoopDefault({ git })]),
  })
  rigs.push(r)
  return r
}

/** 真 git 比轮询慢得多:等它落盘,再让假时间走 */
async function done(r: TelegramRig, id: number) {
  await handled(r, id, 20_000)
  await flow(r)
}
async function send(r: TelegramRig, text: string) {
  const id = r.dm(text)
  await done(r, id)
  return id
}
async function turnEnds(r: TelegramRig, n: number) {
  await expect
    .poll(
      async () => {
        await flow(r, 1200)
        return events(r, 'turn.ended').length + events(r, 'turn.failed').length
      },
      { timeout: 20_000, interval: 5 },
    )
    .toBeGreaterThanOrEqual(n)
  await flow(r)
}

const created = (r: TelegramRig) => events(r, 'session.created').map(e => ({ sessionId: e.sessionId!, ...(e.payload as Record<string, unknown>) })) as ({ sessionId: string; cwd?: string; title: string; approvalMode: string; model?: unknown; repo?: { top: string } } & Record<string, unknown>)[]
const imRoot = (r: TelegramRig) => realpathOr(imWorktreeRootOf(r.dataDir))
function realpathOr(p: string) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const onDiskWorktrees = (r: TelegramRig) => {
  const root = imRoot(r)
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap(g => readdirSync(join(root, g)).map(id => join(root, g, id)))
}
const gitWorktrees = () => sh(['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length))
const listed = async (r: TelegramRig) => (await r.k.handle('channel.telegram.chats', {})) as { chats: { sessionId: string; project?: string }[]; worktrees: { id: string; project: string; path: string; sessionIds: string[]; createdAt: number; usedByChat?: string }[] }

const userState = () => [
  sh(['status', '--porcelain']),
  sh(['for-each-ref', '--format=%(refname) %(objectname)', '--exclude=refs/mffai/**']),
  readFileSync(join(repo, '.git', 'HEAD')).toString('hex'),
  readFileSync(join(repo, '.git', 'index')).toString('hex'),
  sh(['rev-parse', 'HEAD']),
  readFileSync(join(repo, 'a.txt'), 'utf8'),
  readdirSync(repo).sort().join(','),
]

const nothingOpened = (r: TelegramRig) => {
  expect(created(r)).toEqual([])
  expect(onDiskWorktrees(r)).toEqual([])
  expect(gitWorktrees()).toEqual([repo])
  expect(chatOf(r)?.project).toBeUndefined()
  expect(r.models.calls).toEqual([])
}

describe('/project: what session.create gets', () => {
  it('ask, im, owner, a cwd in the IM root; the commandId carries the update', async () => {
    const r = await rig({ botId: 555 })
    const id = await send(r, '/project api')
    const [s] = created(r)
    expect(created(r)).toHaveLength(1)
    const path = join(imRoot(r), readdirSync(imRoot(r))[0], `wt_${id}`)
    const { sessionId: _s, repo: pin, ...rest } = s
    expect(rest).toEqual({ title: 'Telegram · api', cwd: path, approvalMode: 'ask', origin: 'im', audience: 'owner', projectTop: repo })
    expect(pin).toMatchObject({ kind: 'repo', top: path, commonDir: join(repo, '.git') })
    expect(r.rawBytes().includes(`tg:555:${id}:project`)).toBe(true)
    expect(chatOf(r)).toMatchObject({ sessionId: s.sessionId, project: 'api', worktreeId: `wt_${id}` })
    expect(texts(r).at(-1)).toContain('api')
    expect(texts(r).join('\n')).not.toContain(base)
  })

  it('the record survives a restart: the next message runs in the project', async () => {
    const r = await rig({ models: { script: () => say('in the project') } })
    await send(r, '/project api')
    const { sessionId } = chatOf(r)
    await r.restart({ kill: true })
    await online(r)
    expect(chatOf(r)).toMatchObject({ project: 'api', sessionId })
    await send(r, 'hello')
    await turnEnds(r, 1)
    expect(events(r, 'message.user').map(e => e.sessionId)).toEqual([sessionId])
  })

  it.each([
    ['auto, full', true, 'full', 'auto'],
    ['auto, partial', true, 'partial', 'ask'],
    ['auto, none', true, 'none', 'ask'],
    ['no auto, full', false, 'full', 'ask'],
  ] as const)('%s', async (_n, auto, level, expected) => {
    const r = await rig({ level, projects: [{ name: 'api', path: repo, auto }] })
    await send(r, '/project api')
    expect(created(r)[0].approvalMode).toBe(expected)
  })

  it('allowUnsandboxedAuto does not make auto at none', async () => {
    const r = await rig({ level: 'none', projects: [{ name: 'api', path: repo, auto: true }], config: { permissions: { allowUnsandboxedAuto: true } } })
    await send(r, '/project api')
    expect(created(r)[0].approvalMode).toBe('ask')
  })

  it('/new re-reads the setting: auto switched off in the app, the next session asks', async () => {
    const r = await rig({ level: 'full', projects: [{ name: 'api', path: repo, auto: true }] })
    await send(r, '/project api')
    expect(created(r)[0].approvalMode).toBe('auto')
    await r.k.handle('channel.telegram.config.set', { commandId: 'c1', config: { enabled: true, staleMinutes: 10, projects: [{ name: 'api', path: repo, auto: false }] } })
    await send(r, '/new')
    expect(created(r)[1].approvalMode).toBe('ask')
  })

  it('a project in a subdirectory: cwd is the same subdirectory of the worktree', async () => {
    const sub = join(repo, 'sub')
    const r = await rig({ projects: [{ name: 'web', path: sub }] })
    const id = await send(r, '/project web')
    const cwd = created(r)[0].cwd!
    expect(cwd.endsWith(join(`wt_${id}`, 'sub'))).toBe(true)
    expect(existsSync(join(cwd, 'b.txt'))).toBe(true)
  })

  it('/model first: the project session has it', async () => {
    const r = await rig({ models: { accounts: [{ id: 'acct', models: [{ id: 'one' }, { id: 'two' }] }] } })
    await send(r, '/model 2')
    await send(r, '/project api')
    expect(created(r)[0].model).toEqual({ accountId: 'acct', modelId: 'two' })
  })

  it('/project alone lists the aliases, and no path', async () => {
    const r = await rig({ projects: [{ name: 'api', path: repo }, { name: 'web', path: join(repo, 'sub') }] })
    await send(r, '/project')
    expect(texts(r).at(-1)).toContain('api')
    expect(texts(r).at(-1)).toContain('web')
    expect(texts(r).at(-1)).not.toContain(base)
    expect(created(r)).toEqual([])
  })
})

describe('/project: refused, no session, no worktree, never in place', () => {
  it.each(['nope', '..', '../repo', 'api/..', '~', '.', 'API', '__proto__', 'constructor', 'api extra', 'api approvalMode=auto'])('%j', async arg => {
    const r = await rig()
    await send(r, `/project ${arg}`)
    expect(texts(r).at(-1)).toContain('没有这个项目')
    nothingOpened(r)
  })

  it('a raw path as the argument', async () => {
    const r = await rig()
    await send(r, `/project ${repo}`)
    expect(texts(r).at(-1)).toContain('没有这个项目')
    nothingOpened(r)
  })

  it('not a git repository', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    const r = await rig({ projects: [{ name: 'plain', path: plain }] })
    await send(r, '/project plain')
    expect(texts(r).at(-1)).toContain('不是 git 仓库')
    expect(created(r)).toEqual([])
    expect(readdirSync(plain)).toEqual([])
    expect(onDiskWorktrees(r)).toEqual([])
  })

  it('a repository with no commits', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty)
    sh(['init', '-q'], empty)
    const r = await rig({ projects: [{ name: 'empty', path: empty }] })
    await send(r, '/project empty')
    expect(texts(r).at(-1)).toContain('没有提交')
    expect(created(r)).toEqual([])
    expect(onDiskWorktrees(r)).toEqual([])
  })

  it('an alias whose path became a symlink into a credential root', async () => {
    const dir = join(base, 'moved')
    mkdirSync(dir)
    const r = await rig({ projects: [] })
    await r.k.handle('channel.telegram.config.set', { commandId: 'c1', config: { enabled: true, staleMinutes: 10, projects: [{ name: 'moved', path: dir, auto: false }] } })
    const ssh = join(r.home, '.ssh')
    mkdirSync(ssh)
    sh(['init', '-q'], ssh)
    rmSync(dir, { recursive: true })
    symlinkSync(ssh, dir)
    await send(r, '/project moved')
    expect(texts(r).at(-1)).toContain('用不了')
    expect(created(r)).toEqual([])
    expect(onDiskWorktrees(r)).toEqual([])
  })

  it('no model: nothing is created', async () => {
    const r = await rig({ models: { accounts: [] } })
    await send(r, '/project api')
    expect(texts(r).at(-1)).toContain('模型')
    expect(created(r)).toEqual([])
    expect(onDiskWorktrees(r)).toEqual([])
  })

  it('no aliases configured: says so', async () => {
    const r = await rig({ projects: [] })
    await send(r, '/project')
    expect(texts(r).at(-1)).toContain('还没有配置项目')
  })
})

describe('createImWorktree gets what it needs', () => {
  const smudge = (program: string) => {
    writeFileSync(join(program), '#!/bin/sh\necho ran > "$0.ran"\ncat\n')
    chmodSync(program, 0o755)
    writeFileSync(join(base, 'gitconfig'), `[user]\n\tname = t\n\temail = t@example.invalid\n[filter "x"]\n\tsmudge = ${program}\n`)
    writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n')
    sh(['add', '-A'])
    sh(['commit', '-qm', 'attrs'])
  }

  // 只有叫 git-lfs、git-crypt 的程序才可能算安全,所以这个名字才考得到"在不在可写根里"
  it.each([
    ['the system tmp', () => join(systemTmp, 'git-lfs')],
    ['~/.qoder', () => {
      mkdirSync(join(home, '.qoder'))
      return join(home, '.qoder', 'git-lfs')
    }],
  ])('a filter from the global config in %s: refused, never ran', async (_n, where) => {
    const program = where()
    smudge(program)
    const r = await rig()
    await send(r, '/project api')
    expect(texts(r).at(-1)).toContain('过滤器')
    expect(created(r)).toEqual([])
    expect(onDiskWorktrees(r)).toEqual([])
    expect(existsSync(`${program}.ran`)).toBe(false)
  })

  it('the same filter somewhere the sandbox cannot write opens, and ran: the global config really reached git', async () => {
    mkdirSync(join(base, 'safe'))
    const program = join(base, 'safe', 'git-lfs')
    smudge(program)
    const r = await rig()
    await send(r, '/project api')
    expect(created(r)).toHaveLength(1)
    expect(existsSync(`${program}.ran`)).toBe(true)
  })

  it('a `deny read` root in the project has no copy in the worktree', async () => {
    mkdirSync(join(repo, 'hidden'))
    writeFileSync(join(repo, 'hidden', 's.txt'), 'secret\n')
    sh(['add', '-A'])
    sh(['commit', '-qm', 'hidden'])
    const r = await rig({ config: { permissions: { rules: [{ effect: 'deny', rule: 'read(hidden/**)' }] } } })
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
    expect(existsSync(join(cwd, 'hidden'))).toBe(false)
    expect(existsSync(join(repo, 'hidden', 's.txt'))).toBe(true)
  })

  it('an uncommitted edit and an untracked .env are absent from the worktree', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    writeFileSync(join(repo, '.env'), 'TOKEN=1\n')
    const r = await rig()
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(cwd, '.env'))).toBe(false)
  })
})

describe('config.set', () => {
  const set = (r: TelegramRig, id: string, projects: object[]) => r.k.handle('channel.telegram.config.set', { commandId: id, config: { enabled: true, staleMinutes: 10, projects } })

  it.each(['none', 'partial'] as const)('auto:true at %s is rejected', async level => {
    const r = await rig({ level, projects: [] })
    await expect(set(r, 'c1', [{ name: 'api', path: repo, auto: true }])).rejects.toMatchObject({ code: -32602, message: 'auto_requires_full' })
    expect((await r.k.handle('channel.telegram.config.get', {})) as object).toMatchObject({ projects: [] })
  })

  it('auto:true at full is accepted, the path stored as its realpath', async () => {
    const r = await rig({ level: 'full', projects: [] })
    symlinkSync(repo, join(base, 'link'))
    await set(r, 'c1', [{ name: 'api', path: join(base, 'link'), auto: true }])
    expect((await r.k.handle('channel.telegram.config.get', {})) as object).toMatchObject({ projects: [{ name: 'api', path: repo, auto: true }] })
  })

  it.each([
    ['a path into a credential root', (r: TelegramRig) => {
      mkdirSync(join(r.home, '.ssh'))
      return [{ name: 'x', path: join(r.home, '.ssh') }]
    }, 'invalid_project'],
    ['the data directory', (r: TelegramRig) => [{ name: 'x', path: r.dataDir }], 'invalid_project'],
    ['the IM root', (r: TelegramRig) => {
      mkdirSync(imWorktreeRootOf(r.dataDir))
      return [{ name: 'x', path: imWorktreeRootOf(r.dataDir) }]
    }, 'invalid_project'],
    ['a missing path', () => [{ name: 'x', path: join(base, 'nope') }], 'invalid_project'],
    ['a relative path', () => [{ name: 'x', path: 'repo' }], 'invalid_project'],
    ['an alias with ..', () => [{ name: '..', path: repo }], 'invalid_config'],
    ['an alias with a slash', () => [{ name: 'a/b', path: repo }], 'invalid_config'],
    ['an alias named off', () => [{ name: 'off', path: repo }], 'invalid_config'],
    ['two with one name', () => [{ name: 'a', path: repo }, { name: 'a', path: repo }], 'invalid_config'],
  ] as const)('%s is rejected', async (_n, projects, code) => {
    const r = await rig({ projects: [] })
    await expect(set(r, 'c1', projects(r) as object[])).rejects.toMatchObject({ code: -32602, message: code })
  })
})

describe('an IM session never writes to the user’s repo', () => {
  const script: Script = n => {
    if (n === 1) return calling('c1', 'write', { path: 'new.txt', content: 'from the model\n' })
    if (n === 2) return calling('c2', 'edit', { path: 'a.txt', old: 'a', new: 'edited' })
    if (n === 3) return calling('c3', 'shell', { command: 'echo x > f' })
    return say('done')
  }

  it('write, edit, shell: the project is byte-identical, the change is in the worktree', async () => {
    const r = await rig({ models: { script } })
    const before = userState()
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    await send(r, 'do it')
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'approval.requested').length
    }, { timeout: 15_000, interval: 5 }).toBe(1)
    const { approvalId } = events(r, 'approval.requested')[0].payload as { approvalId: string }
    await r.k.handle('approval.respond', { approvalId, decision: 'allow' })
    await turnEnds(r, 1)
    expect(events(r, 'turn.ended')).toHaveLength(1)
    expect(readFileSync(join(cwd, 'new.txt'), 'utf8')).toBe('from the model\n')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(join(cwd, 'f'), 'utf8')).toBe('x\n')
    expect(userState()).toEqual(before)
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
  })

  it('/project and /new record the checkout; a project in a subdirectory records the repo top', async () => {
    mkdirSync(join(repo, 'pkg'))
    writeFileSync(join(repo, 'pkg', 'b.txt'), 'b\n')
    sh(['add', '-A'])
    sh(['commit', '-qm', 'pkg'])
    const r = await rig({ config: { channels: { telegram: { projects: [{ name: 'api', path: join(repo, 'pkg') }] } } } })
    await send(r, '/project api')
    await send(r, '/new')
    expect(created(r).map(c => c.projectTop)).toEqual([repo, repo])
    expect(events(r, 'session.created').length).toBe(2)
  })

  const seatbelt = process.platform === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
  it.skipIf(!seatbelt)('through the kernel: the model reaches neither the untracked .env nor the rest of the checkout, git works', async () => {
    const SECRET = 'UNTRACKED-ENV-VALUE'
    writeFileSync(join(repo, '.env'), `TOKEN=${SECRET}\n`)
    const envFile = join(repo, '.env')
    const r = await rig({
      level: 'full',
      models: {
        script: n => {
          if (n === 1) return calling('c1', 'read', { path: envFile })
          if (n === 2) return calling('c2', 'shell', { command: `cat ${JSON.stringify(envFile)}; echo "cat=$?"; git log -1 --format=log-%s; echo "git=$?"` })
          return say('done')
        },
      },
    })
    const before = userState()
    await send(r, '/project api')
    await send(r, 'do it')
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'approval.requested').length
    }, { timeout: 15_000, interval: 5 }).toBe(1)
    const { approvalId } = events(r, 'approval.requested')[0].payload as { approvalId: string }
    await r.k.handle('approval.respond', { approvalId, decision: 'allow' })
    await turnEnds(r, 1)
    const ended = events(r, 'tool.ended').map(e => e.payload as { name: string; ok: boolean })
    expect(ended.find(e => e.name === 'read')?.ok).toBe(false)
    const all = JSON.stringify(r.k.events.after(0))
    expect(all).not.toContain(SECRET)
    const out = JSON.stringify(events(r, 'tool.ended').find(e => (e.payload as { name: string }).name === 'shell')?.payload)
    expect(out).toMatch(/cat=1/)
    expect(out).toMatch(/log-init/)
    expect(out).toMatch(/git=0/)
    expect(userState()).toEqual(before)
  })

  it('delegate_codex with the fake CLI: in place, the project is byte-identical', async () => {
    const f = installFake({ lines: CODEX_OK, writeFiles: { 'a.txt': 'from codex\n', 'codex.txt': 'new\n' } }, 'codex')
    const env = { PATH: `${f.dir}:/usr/bin:/bin`, HOME: home }
    const r = await rig({
      config: { executors: { disabled: ['qoder'] } },
      models: { script: n => (n === 1 ? delegate() : n === 2 ? say('started') : say('summary')) },
      plugins: () => [...coding(env), createExecutorCli({ env, loginPath: async () => '', git }), createLoopDefault({ git })],
    })
    await expect.poll(async () => ((await r.k.handle('executor.list', {})) as { executors: { missing: string[] }[] }).executors.some(x => x.missing.includes('detecting')), { timeout: 40_000, interval: 10 }).toBe(false)
    const before = userState()
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    await send(r, 'do it')
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'approval.requested').length
    }, { timeout: 15_000, interval: 5 }).toBe(1)
    const { approvalId } = events(r, 'approval.requested')[0].payload as { approvalId: string }
    await r.k.handle('approval.respond', { approvalId, decision: 'allow' })
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'executor.run.ended').length
    }, { timeout: 15_000, interval: 5 }).toBe(1)
    await turnEnds(r, 1)
    expect(readFileSync(join(cwd, 'codex.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('from codex\n')
    expect(existsSync(`${r.dataDir}-worktrees`)).toBe(false)
    expect(userState()).toEqual(before)
  })
})

describe('moving between sessions', () => {
  it('/new keeps the worktree, /project makes a new one', async () => {
    const r = await rig()
    const id = await send(r, '/project api')
    await send(r, 'hello')
    await turnEnds(r, 1)
    await send(r, '/new')
    expect(created(r)).toHaveLength(2)
    expect(created(r)[1].cwd).toBe(created(r)[0].cwd)
    expect(created(r)[1].title).toBe('Telegram · api')
    expect(chatOf(r).worktreeId).toBe(`wt_${id}`)
    expect((await listed(r)).worktrees[0].sessionIds).toEqual(created(r).map(s => s.sessionId))

    const second = await send(r, '/project api')
    expect(created(r)[2].cwd).not.toBe(created(r)[0].cwd)
    expect(chatOf(r).worktreeId).toBe(`wt_${second}`)
    expect(onDiskWorktrees(r)).toHaveLength(2)
  })

  it('leaving a worktree nobody spoke in removes it; one with a message stays', async () => {
    const r = await rig()
    await send(r, '/project api')
    const empty = created(r)[0].cwd!
    await send(r, '/project api')
    expect(existsSync(empty)).toBe(false)
    expect(gitWorktrees()).toHaveLength(2)
    expect((await listed(r)).worktrees).toHaveLength(1)

    await send(r, 'hello')
    await turnEnds(r, 1)
    const used = created(r)[1].cwd!
    await send(r, '/project off')
    expect(existsSync(used)).toBe(true)
    expect((await listed(r)).worktrees.map(w => w.path)).toEqual([used])
    expect((await listed(r)).worktrees[0].usedByChat).toBeUndefined()
  })

  it('a directory gone while running: /new goes to chat mode plus a line', async () => {
    const r = await rig()
    await send(r, '/project api')
    rmSync(created(r)[0].cwd!, { recursive: true })
    await send(r, '/new')
    expect(created(r)[1].cwd).toBeUndefined()
    expect(texts(r).at(-1)).toContain('纯对话')
  })

  it('a coding-tools-only account opens a project, and keeps it across /new', async () => {
    const r = await rig({ models: { accounts: [{ id: 'sub', restriction: 'coding-tools-only', models: [{ id: 'm' }] }] } })
    await send(r, '/project api')
    expect(created(r)).toHaveLength(1)
    await send(r, '/new')
    expect(created(r)[1].cwd).toBe(created(r)[0].cwd)
    await send(r, '/project off')
    await send(r, '/new')
    expect(texts(r).at(-1)).toContain('/project')
    expect(created(r)).toHaveLength(2)
  })

  it('/project off: chat mode; the next message has no cwd', async () => {
    const r = await rig()
    await send(r, '/project api')
    const sid = created(r)[0].sessionId
    await send(r, '/project off')
    expect(texts(r).at(-1)).toContain('纯对话')
    expect(chatOf(r).project).toBeUndefined()
    expect(chatOf(r).worktreeId).toBeUndefined()
    expect(chatOf(r).sessionId).toBeUndefined()
    await send(r, 'hello')
    await turnEnds(r, 1)
    expect(created(r)).toHaveLength(2)
    expect(created(r)[1].cwd).toBeUndefined()
    expect(events(r, 'message.user')[0].sessionId).not.toBe(sid)
  })

  it('/project off when already in chat mode: a line, nothing else', async () => {
    const r = await rig()
    await send(r, '/project off')
    expect(texts(r).at(-1)).toContain('纯对话')
    expect(created(r)).toEqual([])
  })

  it('a removed alias on /new: chat mode plus a line', async () => {
    const r = await rig()
    await send(r, '/project api')
    await send(r, 'hello')
    await turnEnds(r, 1)
    await r.k.handle('channel.telegram.config.set', { commandId: 'c1', config: { enabled: true, staleMinutes: 10, projects: [] } })
    await send(r, '/new')
    expect(created(r)).toHaveLength(2)
    expect(created(r)[1].cwd).toBeUndefined()
    expect(created(r)[1].title).toBe('Telegram')
    expect(chatOf(r).project).toBeUndefined()
    expect(chatOf(r).worktreeId).toBeUndefined()
    expect(texts(r).at(-1)).toContain('api')
    expect(texts(r).at(-1)).toContain('纯对话')
    expect((await listed(r)).worktrees).toHaveLength(1)
  })

  it('an alias that now points at another repo on /new: the same', async () => {
    const other = join(base, 'other')
    mkdirSync(other)
    const r = await rig()
    await send(r, '/project api')
    await r.k.handle('channel.telegram.config.set', { commandId: 'c1', config: { enabled: true, staleMinutes: 10, projects: [{ name: 'api', path: other, auto: false }] } })
    await send(r, '/new')
    expect(created(r)[1].cwd).toBeUndefined()
    expect(texts(r).at(-1)).toContain('纯对话')
  })

  describe('refused with an open turn', () => {
    it.each(['/new', '/project api', '/project off'])('%s during a running turn', async text => {
      const gated = gatedStream('thinking', ' done')
      const r = await rig({ models: { script: gatedScript(gated) } })
      await send(r, '/project api')
      await send(r, 'go')
      const worktrees = onDiskWorktrees(r)
      const before = chatOf(r).sessionId
      await send(r, text)
      expect(texts(r).at(-1)).toBe(BUSY)
      expect(chatOf(r)).toMatchObject({ sessionId: before, project: 'api' })
      expect(created(r)).toHaveLength(1)
      expect(onDiskWorktrees(r)).toEqual(worktrees)
      gated.open()
      await turnEnds(r, 1)
    })

    it.each(['/new', '/project api', '/project off', '/rollback'])('%s during a parked turn', async text => {
      const go = join(base, 'go')
      const f = installFake(untilGo(go), 'codex')
      const env = { PATH: `${f.dir}:/usr/bin:/bin`, HOME: home }
      const r = await rig({
        config: { executors: { disabled: ['qoder'] } },
        models: { script: n => (n === 1 ? calling('c1', 'delegate_codex', { prompt: 'do it', readOnly: true }) : say(n === 2 ? 'started' : 'summary')) },
        plugins: () => [...coding(env), createExecutorCli({ env, loginPath: async () => '', git }), createLoopDefault({ git })],
      })
      await expect.poll(async () => ((await r.k.handle('executor.list', {})) as { executors: { missing: string[] }[] }).executors.some(x => x.missing.includes('detecting')), { timeout: 40_000, interval: 10 }).toBe(false)
      await send(r, '/project api')
      await send(r, 'go')
      await expect.poll(async () => {
        await flow(r, 1200)
        return events(r, 'approval.requested').length
      }, { timeout: 15_000, interval: 5 }).toBe(1)
      const { approvalId } = events(r, 'approval.requested')[0].payload as { approvalId: string }
      await r.k.handle('approval.respond', { approvalId, decision: 'allow' })
      await expect.poll(async () => {
        await flow(r, 1200)
        return events(r, 'turn.parked').length
      }, { timeout: 15_000, interval: 5 }).toBe(1)
      const before = chatOf(r).sessionId
      await send(r, text)
      expect(texts(r).at(-1)).toBe(BUSY)
      expect(chatOf(r)).toMatchObject({ sessionId: before, project: 'api' })
      expect(created(r)).toHaveLength(1)
      writeFileSync(go, '')
      await turnEnds(r, 1)
    })
  })
})

describe('/rollback', () => {
  const twoTurns: Script = n => {
    if (n === 1) return calling('c1', 'write', { path: 'one.txt', content: '1\n' })
    if (n === 2) return say('one done')
    if (n === 3) return calling('c2', 'write', { path: 'two.txt', content: '2\n' })
    return say('two done')
  }

  it('undoes the last turn in the worktree, and the project is untouched', async () => {
    const r = await rig({ models: { script: twoTurns } })
    const before = userState()
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    await send(r, 'one')
    await turnEnds(r, 1)
    await send(r, 'two')
    await turnEnds(r, 2)
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('已回滚 1 个文件')
    expect(existsSync(join(cwd, 'two.txt'))).toBe(false)
    expect(existsSync(join(cwd, 'one.txt'))).toBe(true)
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('已回滚 1 个文件')
    expect(existsSync(join(cwd, 'one.txt'))).toBe(false)
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('没有可回滚的')
    expect(userState()).toEqual(before)
  })

  it('with nothing to roll back', async () => {
    const r = await rig()
    await send(r, '/project api')
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe('没有可回滚的')
    expect(events(r, 'turn.rolledBack')).toEqual([])
  })

  it('during a turn', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) } })
    await send(r, '/project api')
    await send(r, 'go')
    await send(r, '/rollback')
    expect(texts(r).at(-1)).toBe(BUSY)
    expect(events(r, 'turn.rolledBack')).toEqual([])
    gated.open()
    await turnEnds(r, 1)
  })

  it('redelivered after a crash: the receipt answers, the turn before it stays', async () => {
    const r = await rig({ models: { script: twoTurns } })
    await send(r, '/project api')
    const cwd = created(r)[0].cwd!
    await send(r, 'one')
    await turnEnds(r, 1)
    await send(r, 'two')
    await turnEnds(r, 2)
    const saved = readFileSync(stateFile(r))
    const id = await send(r, '/rollback')
    expect(events(r, 'turn.rolledBack')).toHaveLength(1)
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    r.fake.push({ update_id: id, message: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text: '/rollback' } })
    await online(r)
    await done(r, id)
    expect(events(r, 'turn.rolledBack')).toHaveLength(1)
    expect(existsSync(join(cwd, 'one.txt'))).toBe(true)
    expect(texts(r).at(-1)).toBe('已回滚 1 个文件')
  })
})

describe('/rollback redelivered, the only turn', () => {
  it('nothing is left to find, and the receipt still answers', async () => {
    const r = await rig({ models: { script: n => (n === 1 ? calling('c1', 'write', { path: 'one.txt', content: '1\n' }) : say('done')) } })
    await send(r, '/project api')
    await send(r, 'one')
    await turnEnds(r, 1)
    const saved = readFileSync(stateFile(r))
    const id = await send(r, '/rollback')
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    r.fake.push({ update_id: id, message: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text: '/rollback' } })
    await online(r)
    await done(r, id)
    expect(events(r, 'turn.rolledBack')).toHaveLength(1)
    expect(texts(r).at(-1)).toBe('已回滚 1 个文件')
  })
})

describe('a command does not hold the poll loop', () => {
  /** 一次 worktree add 按住不放。git 卡多久都行,别的都该接着走 */
  function holdAdd() {
    let open = () => {}
    const gate = new Promise<void>(res => (open = res))
    const h = {
      held: true,
      reached: false,
      git: ((args, o) => {
        if (h.held && args.includes('worktree') && args.includes('add')) {
          h.reached = true
          return gate.then(() => git(args, o))
        }
        return git(args, o)
      }) as Git,
      release() {
        h.held = false
        open()
      },
    }
    return h
  }
  const reached = (h: { reached: boolean }) => expect.poll(() => h.reached, { timeout: 15_000, interval: 5 }).toBe(true)
  const offset = (r: TelegramRig, id: number) => expect.poll(() => onDisk(r).offset, { timeout: 5000, interval: 2 }).toBeGreaterThan(id)

  it('during a held /project: the poller reads on, other chats answer, a message waits and lands in the project', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git }, models: { script: () => say('in the project') } })
    const seeded = onDisk(r)
    seeded.pairings.push({ accountId: '3001', name: 'Other', pairedAt: 1 })
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)

    r.dm('/project api')
    await reached(h)
    const message = r.dm('hello project')
    await offset(r, message)
    const other = r.dm('/help', { from: 3001 })
    await offset(r, other)
    await flow(r)
    expect(r.fake.outbox(3001).at(-1)?.text).toContain('/rollback')
    expect(users(r)).toEqual([])
    expect(created(r)).toEqual([])

    h.release()
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'turn.ended').length
    }, { timeout: 20_000, interval: 5 }).toBe(1)
    expect(created(r)).toHaveLength(1)
    expect(events(r, 'message.user').map(e => e.sessionId)).toEqual([created(r)[0].sessionId])
    expect(chatOf(r).project).toBe('api')
    expect(chatOf(r).commands).toBeUndefined()
  })

  it('commands in one chat stay in order: /status after a held /project sees the project', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git } })
    r.dm('/project api')
    await reached(h)
    const id = r.dm('/status')
    await offset(r, id)
    await flow(r)
    expect(texts(r).join('\n')).not.toContain('机器人')
    h.release()
    await done(r, id)
    expect(texts(r).at(-1)).toContain('项目 api')
  })

  it('a message before the command still refuses it', async () => {
    const r = await rig()
    await handled(r, r.dm('first'))
    await handled(r, r.dm('/project api'))
    await flow(r)
    expect(texts(r)).toContain(BUSY)
    expect(created(r).every(s => s.cwd === undefined)).toBe(true)
  })

  it('the app unpairs during the git work: no session, no mapping, nothing sent to him, no worktree left', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git } })
    const id = r.dm('/project api')
    await reached(h)
    await offset(r, id)
    await r.k.handle('channel.telegram.unpair', { commandId: 'u1', accountId: String(r.owner) })
    const before = texts(r).length
    h.release()
    await expect.poll(() => onDiskWorktrees(r).length + (gitWorktrees().length - 1), { timeout: 40_000, interval: 10 }).toBe(0)
    await flow(r)
    expect(created(r)).toEqual([])
    expect(chatOf(r)?.project).toBeUndefined()
    expect(chatOf(r)?.commands).toBeUndefined()
    expect(texts(r).length).toBe(before)
    expect((await listed(r)).worktrees).toEqual([])
  })

  it('a crash during the git work: it runs after restart, one worktree, one session', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git } })
    r.dm('/project api')
    await reached(h)
    expect(chatOf(r).commands).toHaveLength(1)
    h.held = false
    // 旧进程按住的那次 git 永远不放:真的崩溃了它也回不来
    await r.restart({ kill: true })
    await online(r)
    await expect.poll(() => chatOf(r)?.commands?.length ?? 0, { timeout: 20_000, interval: 5 }).toBe(0)
    await flow(r)
    expect(created(r)).toHaveLength(1)
    expect(chatOf(r).project).toBe('api')
    expect(texts(r).at(-1)).toContain('api')
    expect((await listed(r)).worktrees).toHaveLength(1)
  })

  it('a crash, and back after the stale limit: not run, one line', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git } })
    r.dm('/project api')
    await reached(h)
    h.held = false
    r.clock.advance(11 * 60_000)
    await r.restart({ kill: true })
    await online(r)
    await flow(r)
    expect(texts(r).at(-1)).toBe('离线期间的 1 条没有执行,要的话重发。')
    expect(chatOf(r)?.commands).toBeUndefined()
    expect(chatOf(r)?.project).toBeUndefined()
    expect(created(r)).toEqual([])
  })

  it('a clean close during the git work: the kernel closes in bounded time, the command runs on the next start', async () => {
    const h = holdAdd()
    const r = await rig({ channel: { git: h.git } })
    r.dm('/project api')
    await reached(h)
    h.held = false
    await r.restart()
    await online(r)
    await expect.poll(() => chatOf(r)?.commands?.length ?? 0, { timeout: 20_000, interval: 5 }).toBe(0)
    await flow(r)
    expect(created(r)).toHaveLength(1)
    expect(chatOf(r).project).toBe('api')
  })
})

describe('turning auto off reaches the session already open', () => {
  const on = [{ name: 'api', path: '', auto: true }]
  const setAuto = (r: TelegramRig, id: string, auto: boolean) => r.k.handle('channel.telegram.config.set', { commandId: id, config: { enabled: true, staleMinutes: 10, projects: [{ name: 'api', path: repo, auto }] } })
  const shellDefault = async (r: TelegramRig, sessionId: string) => ((await r.k.handle('permissions.get', { sessionId })) as { defaults: string[] }).defaults.find(d => d.endsWith('shell(*)'))
  const autoRig = (o: Rig = {}) => rig({ level: 'full', projects: on.map(p => ({ ...p, path: repo })), ...o })

  it('off in the app: the next shell asks; no spawn, no /new; the chat hears one line', async () => {
    const r = await autoRig({ models: { script: n => (n === 1 ? calling('c1', 'shell', { command: 'echo hi' }) : say('done')) } })
    await send(r, '/project api')
    const { sessionId } = created(r)[0]
    expect(await shellDefault(r, sessionId)).toBe('allow shell(*)')
    await setAuto(r, 'c1', false)
    expect(await shellDefault(r, sessionId)).toBe('ask shell(*)')
    await flow(r)
    expect(texts(r).at(-1)).toContain('自动放行关了')
    await send(r, 'run')
    await expect.poll(async () => {
      await flow(r, 1200)
      return events(r, 'approval.requested').length
    }, { timeout: 15_000, interval: 5 }).toBe(1)
    expect(chatOf(r).sessionId).toBe(sessionId)
    const { approvalId } = events(r, 'approval.requested')[0].payload as { approvalId: string }
    await r.k.handle('approval.respond', { approvalId, decision: 'deny' })
    await turnEnds(r, 1)
  })

  it('it survives a restart; on again does not widen it, and /new does', async () => {
    const r = await autoRig()
    await send(r, '/project api')
    const { sessionId } = created(r)[0]
    await setAuto(r, 'c1', false)
    await r.restart({ kill: true })
    await online(r)
    expect(await shellDefault(r, sessionId)).toBe('ask shell(*)')
    await setAuto(r, 'c2', true)
    expect(await shellDefault(r, sessionId)).toBe('ask shell(*)')
    await send(r, '/new')
    expect(created(r)[1].approvalMode).toBe('auto')
    expect(await shellDefault(r, created(r)[1].sessionId)).toBe('allow shell(*)')
  })

  it('the alias removed: the same, every session of that worktree', async () => {
    const r = await autoRig()
    await send(r, '/project api')
    await send(r, '/new')
    await r.k.handle('channel.telegram.config.set', { commandId: 'c1', config: { enabled: true, staleMinutes: 10, projects: [] } })
    for (const s of created(r)) expect(await shellDefault(r, s.sessionId)).toBe('ask shell(*)')
    expect(events(r, 'session.approvalNarrowed')).toHaveLength(2)
  })

  it('config.json edited while the daemon was down: narrowed before the first turn', async () => {
    const r = await autoRig()
    await send(r, '/project api')
    const { sessionId } = created(r)[0]
    await r.restart()
    const file = join(r.dataDir, 'config.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.channels.telegram.projects[0].auto = false
    writeFileSync(file, JSON.stringify(config))
    await r.restart()
    await online(r)
    expect(await shellDefault(r, sessionId)).toBe('ask shell(*)')
  })

  it('auto stays where it is still allowed: a config.set that keeps it narrows nothing', async () => {
    const r = await autoRig()
    await send(r, '/project api')
    await setAuto(r, 'c1', true)
    expect(await shellDefault(r, created(r)[0].sessionId)).toBe('allow shell(*)')
    expect(events(r, 'session.approvalNarrowed')).toEqual([])
  })

  it('the service only narrows IM sessions: an app session on auto is untouched', async () => {
    let service: { narrowApproval(id: string): void } | undefined
    const r = await autoRig({
      plugins: () => [...coding(), createLoopDefault({ git }), { manifest: { id: 'spy', version: '0', kernel: '^0.1.0', inject: ['sessionCommands'] }, activate: ctx => void (service = ctx.services.get('sessionCommands')) }],
    })
    const { sessionId } = (await r.k.handle('session.create', { commandId: 'a1', approvalMode: 'auto', cwd: repo })) as { sessionId: string }
    service!.narrowApproval(sessionId)
    expect(await shellDefault(r, sessionId)).toBe('allow shell(*)')
    expect(events(r, 'session.approvalNarrowed')).toEqual([])
  })
})

describe('a worktree with content is not deleted on a guess', () => {
  it('on disk, the chat mapping never appears without the session in the record', async () => {
    const real = TelegramState.prototype.save
    const seen: boolean[] = []
    const spy = vi.spyOn(TelegramState.prototype, 'save').mockImplementation(function (this: TelegramState) {
      for (const raw of Object.values(this.data.chats)) {
        const chat = raw as { worktreeId?: string; sessionId?: string }
        if (chat.worktreeId === undefined) continue
        const record = this.data.worktrees[chat.worktreeId] as { sessionIds: string[]; opened?: boolean }
        seen.push(record.opened === true && record.sessionIds.includes(chat.sessionId!))
      }
      real.call(this)
    })
    const r = await rig()
    await send(r, '/project api')
    await send(r, '/new')
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    spy.mockRestore()
  })

  it.each([
    ['no session ids, no opened flag (a crash between two writes in an older state file)', (w: { sessionIds: string[]; opened?: boolean }, _other: string) => {
      w.sessionIds = []
      delete w.opened
    }],
    // 记录里的会话是真的、也没说过话:只有"他刚离开的不在里面"这一条挡得住
    ['the session he just left is not in the record', (w: { sessionIds: string[] }, other: string) => {
      w.sessionIds = [other]
    }],
  ])('%s: /project off keeps it and says so in the log; it stays listed', async (_n, edit) => {
    const r = await rig({ models: { script: n => (n === 1 ? calling('c1', 'write', { path: 'work.txt', content: 'work\n' }) : say('done')) } })
    const id = await send(r, '/project api')
    await send(r, 'do it')
    await turnEnds(r, 1)
    const cwd = created(r)[0].cwd!
    const { sessionId: other } = (await r.k.handle('session.create', { commandId: 'x1', origin: 'im', audience: 'owner', cwd: repo })) as { sessionId: string }
    const seeded = onDisk(r)
    edit(seeded.worktrees[`wt_${id}`], other)
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await send(r, '/project off')
    expect(readFileSync(join(cwd, 'work.txt'), 'utf8')).toBe('work\n')
    expect((await listed(r)).worktrees.map(w => w.id)).toEqual([`wt_${id}`])
    expect(r.logs.join('\n')).toContain('kept')
  })

  it('a record still opening (crash before the session): never removed on leaving, the chat is not in it', async () => {
    const r = await rig()
    const id = await send(r, '/project api')
    const seeded = onDisk(r)
    delete seeded.worktrees[`wt_${id}`].opened
    seeded.worktrees[`wt_${id}`].sessionIds = []
    delete seeded.chats[String(r.owner)].project
    delete seeded.chats[String(r.owner)].worktreeId
    delete seeded.chats[String(r.owner)].sessionId
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await send(r, '/project off')
    expect((await listed(r)).worktrees.map(w => w.id)).toEqual([`wt_${id}`])
    expect(existsSync(created(r)[0].cwd!)).toBe(true)
  })
})

describe('redelivery', () => {
  it('a redelivered /project makes one worktree and one session', async () => {
    const r = await rig()
    const saved = readFileSync(stateFile(r))
    const id = await send(r, '/project api')
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    r.fake.push({ update_id: id, message: { chat: { id: r.owner, type: 'private' }, from: { id: r.owner, is_bot: false, first_name: 'Owner' }, text: '/project api' } })
    await online(r)
    await done(r, id)
    expect(created(r)).toHaveLength(1)
    expect(onDiskWorktrees(r)).toHaveLength(1)
    expect(gitWorktrees()).toHaveLength(2)
    expect((await listed(r)).worktrees.map(w => w.id)).toEqual([`wt_${id}`])
    expect(chatOf(r)).toMatchObject({ project: 'api', worktreeId: `wt_${id}`, sessionId: created(r)[0].sessionId })
  })
})

describe('reconciliation at activation', () => {
  const C1 = `c${'1'.repeat(16)}`
  const C2 = `c${'2'.repeat(16)}`
  const plant = (r: TelegramRig, group: string, id: string, file?: string) => {
    const path = join(imWorktreeRootOf(r.dataDir), group, id)
    mkdirSync(path, { recursive: true })
    if (file) writeFileSync(join(path, file), 'x')
    return path
  }

  it('an empty reservation is removed; an unknown directory is listed as an orphan and discardable', async () => {
    const r = await rig()
    const empty = plant(r, C1, 'wt_empty')
    const orphan = plant(r, C2, 'wt_orphan', 'left.txt')
    await r.restart()
    await online(r)
    expect(existsSync(empty)).toBe(false)
    expect(existsSync(join(imWorktreeRootOf(r.dataDir), C1))).toBe(false)
    const { worktrees } = await listed(r)
    expect(worktrees).toEqual([{ id: 'wt_orphan', project: '', path: realpathSync(orphan), sessionIds: [], createdAt: expect.any(Number) }])
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: 'wt_orphan' })
    expect(existsSync(orphan)).toBe(false)
    expect((await listed(r)).worktrees).toEqual([])
  })

  it('a known worktree is not an orphan, and survives', async () => {
    const r = await rig()
    await send(r, '/project api')
    const path = created(r)[0].cwd!
    await r.restart()
    await online(r)
    expect(existsSync(path)).toBe(true)
    expect((await listed(r)).worktrees.map(w => w.project)).toEqual(['api'])
  })

  it('state.json lost: the worktree is an orphan; discarding it finds its sessions, drops their refs and its git entry', async () => {
    const r = await rig()
    const saved = readFileSync(stateFile(r))
    await send(r, '/project api')
    await send(r, 'hello')
    await turnEnds(r, 1)
    const { sessionId, cwd } = created(r)[0]
    expect(sh(['for-each-ref', `refs/mffai/snapshots/${sessionId}/`])).not.toBe('')
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    await online(r)
    const { worktrees } = await listed(r)
    expect(worktrees.map(w => [w.project, w.path])).toEqual([['', cwd]])
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })
    expect(existsSync(cwd!)).toBe(false)
    expect(sh(['for-each-ref', 'refs/mffai/snapshots/'])).toBe('')
    expect(gitWorktrees()).toEqual([repo])
  })

  it('an orphan from a crash before the session: the configured project is found by its .git', async () => {
    const r = await rig()
    const saved = readFileSync(stateFile(r))
    await send(r, '/project api')
    const { cwd } = created(r)[0]
    // 磁盘上只留 worktree:没有 state、没有这个会话的事件也一样,靠 config 里的项目认
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    await online(r)
    const { worktrees } = await listed(r)
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })
    expect(existsSync(cwd!)).toBe(false)
    expect(gitWorktrees()).toEqual([repo])
  })

  it('twenty orphans fill the quota: /project says so, a discard makes room', async () => {
    const r = await rig()
    for (let i = 0; i < 20; i++) plant(r, C2, `wt_o${i}`, 'x')
    await r.restart()
    await online(r)
    await send(r, '/project api')
    expect(texts(r).at(-1)).toContain('worktree 满了')
    expect(created(r)).toEqual([])
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: 'wt_o0' })
    await send(r, '/project api')
    expect(created(r)).toHaveLength(1)
  })

  it('a worktree whose directory is gone: the chat is back in chat mode, the record stays discardable', async () => {
    const r = await rig()
    await send(r, '/project api')
    await send(r, 'hello')
    await turnEnds(r, 1)
    const { cwd, sessionId } = created(r)[0]
    rmSync(cwd!, { recursive: true })
    await r.restart()
    await online(r)
    expect(chatOf(r).project).toBeUndefined()
    const { worktrees } = await listed(r)
    expect(worktrees.map(w => w.path)).toEqual([cwd])
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })
    expect(sh(['for-each-ref', `refs/mffai/snapshots/${sessionId}/`])).toBe('')
    expect((await listed(r)).worktrees).toEqual([])
  })

  it('symlinks and files in the IM root are left alone', async () => {
    const r = await rig()
    const root = imWorktreeRootOf(r.dataDir)
    mkdirSync(join(root, C1), { recursive: true })
    const target = join(base, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    symlinkSync(target, join(root, C1, 'wt_link'))
    writeFileSync(join(root, C1, 'file'), 'x')
    await r.restart()
    await online(r)
    expect((await listed(r)).worktrees).toEqual([])
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(root, C1, 'file'))).toBe(true)
  })

  it('names we never made are not ours: neither removed nor listed', async () => {
    const r = await rig()
    const emptyGroup = join(imWorktreeRootOf(r.dataDir), 'notes')
    mkdirSync(emptyGroup, { recursive: true })
    const emptyId = plant(r, C1, 'keepme')
    const full = plant(r, 'backup', 'wt_1', 'x')
    await r.restart()
    await online(r)
    expect((await listed(r)).worktrees).toEqual([])
    for (const p of [emptyGroup, emptyId, full]) expect(existsSync(p)).toBe(true)
  })

  it('a symlinked root is not followed: nothing removed, nothing listed, a discard refuses', async () => {
    const r = await rig()
    await send(r, '/project api')
    const { worktrees } = await listed(r)
    const away = join(base, 'away')
    const root = imWorktreeRootOf(r.dataDir)
    mkdirSync(join(away, C1, 'wt_empty'), { recursive: true })
    mkdirSync(join(away, C2, 'wt_full'), { recursive: true })
    writeFileSync(join(away, C2, 'wt_full', 'x'), 'x')
    rmSync(worktrees[0].path, { recursive: true })
    sh(['worktree', 'prune'])
    rmSync(root, { recursive: true })
    symlinkSync(away, root)
    await r.restart()
    await online(r)
    expect(existsSync(join(away, C1, 'wt_empty'))).toBe(true)
    expect((await listed(r)).worktrees.map(w => w.id)).toEqual([worktrees[0].id])
    expect(r.logs.join('\n')).toContain('symlink')
    await expect(r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })).rejects.toBeDefined()
    expect(readFileSync(join(away, C2, 'wt_full', 'x'), 'utf8')).toBe('x')
  })

  it.skipIf(process.platform !== 'darwin')('a record spelled in another case is the same directory, not an orphan', async () => {
    const r = await rig()
    const id = await send(r, '/project api')
    const seeded = onDisk(r)
    seeded.worktrees[`wt_${id}`].path = seeded.worktrees[`wt_${id}`].path.replace(/wt_/, 'WT_')
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    expect((await listed(r)).worktrees.map(w => w.id)).toEqual([`wt_${id}`])
  })

  it('an orphan with a turn open: ERR_BUSY', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) } })
    const saved = readFileSync(stateFile(r))
    await send(r, '/project api')
    const { sessionId, cwd } = created(r)[0]
    writeFileSync(stateFile(r), saved)
    await r.restart({ kill: true })
    await online(r)
    await r.k.handle('session.prompt', { commandId: 'p1', sessionId, text: 'from the app' })
    await expect.poll(() => events(r, 'message.user').length, { timeout: 5000, interval: 5 }).toBe(1)
    const { worktrees } = await listed(r)
    await expect(r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })).rejects.toMatchObject({ code: ERR_BUSY })
    expect(existsSync(cwd!)).toBe(true)
    gated.open()
    await turnEnds(r, 1)
  })
})

describe('worktree.discard', () => {
  it('leaves no refs/mffai/snapshots/<session>, keeps others, and the current chat falls back to chat mode', async () => {
    const r = await rig({ models: { script: () => say('ok') } })
    await send(r, '/project api')
    await send(r, 'first')
    await turnEnds(r, 1)
    await send(r, '/project api')
    await send(r, 'second')
    await turnEnds(r, 2)
    const [one, two] = created(r)
    expect(sh(['for-each-ref', `refs/mffai/snapshots/${two.sessionId}/`])).not.toBe('')
    const { worktrees } = await listed(r)
    expect(worktrees.map(w => w.usedByChat)).toEqual([undefined, String(r.owner)])

    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[1].id })
    expect(sh(['for-each-ref', `refs/mffai/snapshots/${two.sessionId}/`])).toBe('')
    expect(sh(['for-each-ref', `refs/mffai/snapshots/${one.sessionId}/`])).not.toBe('')
    expect(existsSync(two.cwd!)).toBe(false)
    expect(existsSync(one.cwd!)).toBe(true)
    expect(chatOf(r).project).toBeUndefined()
    expect(chatOf(r).worktreeId).toBeUndefined()
    await flow(r)
    expect(texts(r).at(-1)).toContain('纯对话')

    await send(r, 'third')
    await turnEnds(r, 3)
    expect(created(r)).toHaveLength(3)
    expect(created(r)[2].cwd).toBeUndefined()
  })

  it('never touches the user’s own worktrees or a stale entry', async () => {
    const mine = join(base, 'mine')
    const gone = join(base, 'gone')
    sh(['worktree', 'add', '-q', '--detach', mine])
    sh(['worktree', 'add', '-q', '--detach', gone])
    rmSync(gone, { recursive: true })
    const r = await rig()
    await send(r, '/project api')
    await send(r, '/project api')
    const entries = () => readdirSync(join(repo, '.git', 'worktrees')).sort()
    const { worktrees } = await listed(r)
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })
    await r.restart()
    await online(r)
    expect(existsSync(mine)).toBe(true)
    expect(entries()).toEqual(['gone', 'mine'])
    expect(gitWorktrees().filter(p => p === mine || p === gone).sort()).toEqual([gone, mine])
  })

  it('while busy: ERR_BUSY, and nothing moved', async () => {
    const gated = gatedStream('thinking', ' done')
    const r = await rig({ models: { script: gatedScript(gated) } })
    await send(r, '/project api')
    await send(r, 'go')
    const { worktrees } = await listed(r)
    await expect(r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })).rejects.toMatchObject({ code: ERR_BUSY })
    expect(existsSync(worktrees[0].path)).toBe(true)
    expect(chatOf(r).project).toBe('api')
    gated.open()
    await turnEnds(r, 1)
    await r.k.handle('channel.telegram.worktree.discard', { commandId: 'd2', worktreeId: worktrees[0].id })
    expect(existsSync(worktrees[0].path)).toBe(false)
  })

  it('an unknown id: refused', async () => {
    const r = await rig()
    await expect(r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: '../../repo' })).rejects.toMatchObject({ code: -32602, message: 'unknown_worktree' })
    expect(existsSync(repo)).toBe(true)
  })

  it('a record edited to point outside the IM root is not followed', async () => {
    const r = await rig()
    await send(r, '/project api')
    const { worktrees } = await listed(r)
    const seeded = onDisk(r)
    seeded.worktrees[worktrees[0].id].path = repo
    writeFileSync(stateFile(r), JSON.stringify(seeded))
    await r.restart({ kill: true })
    await online(r)
    await expect(r.k.handle('channel.telegram.worktree.discard', { commandId: 'd1', worktreeId: worktrees[0].id })).rejects.toBeDefined()
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('channel.telegram.chats names the project of the chat', async () => {
    const r = await rig()
    await send(r, '/project api')
    const { chats } = await listed(r)
    expect(chats.map(c => c.project)).toEqual(['api'])
    expect(users(r)).toEqual([])
  })
})
