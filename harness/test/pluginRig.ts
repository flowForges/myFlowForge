// 插件测试夹具(09):插件目录和本地仓库都建在临时目录里,内核是真的,模型是假的。
// 不读 ~/.claude,不上网:真实的形状都手写在用例里。plugin-manager 由用例经 manager 给(Task 5 之前没有它)
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createKernel, type Kernel, type KernelOpts } from '../src/kernel/kernel'
import type { Logger } from '../src/kernel/log'
import type { Plugin } from '../src/kernel/pluginHost'
import { createGit } from '../src/lib/git/snapshot'
import { pluginStoreRootOf } from '../src/lib/fs/paths'
import { createLoopDefault } from '../src/plugins/loop-default'
import toolsRegistry from '../src/plugins/tools-registry'
import type { Grants, KernelEvent, SessionOrigin, WorkerResult } from '../src/protocol/index'
import type { SandboxStatus } from '../src/protocol/rpc'
import { fakeModels, type FakeModels, type FakeModelsOpts, type Req } from './memoryRig'

export const FAKE_MCP = join(__dirname, 'fixtures', 'plugins', 'fake-mcp.mjs')

type Text = string | { mode: number; text: string }
export type SkillSpec = string | { description?: string; frontmatter?: string; body: string }

export interface PluginSpec {
  /** claude:.claude-plugin/plugin.json;native:mff-plugin.json;bare:没有清单 */
  format: 'claude' | 'native' | 'bare'
  id: string
  version?: string
  skills?: Record<string, SkillSpec>
  commands?: Record<string, string>
  /** 写进 .mcp.json(native 写进清单的 mcpServers) */
  mcp?: Record<string, unknown>
  /** hooks/hooks.json 的 hooks 段 */
  hooks?: Record<string, unknown>
  /** 合进清单 */
  manifest?: Record<string, unknown>
  /** 相对插件根的路径 → 内容 */
  extra?: Record<string, Text>
}

function put(root: string, rel: string, value: Text): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' ? value : value.text)
  if (typeof value !== 'string') chmodSync(file, value.mode)
}

const skillText = (name: string, s: SkillSpec) => {
  if (typeof s === 'string') return `---\nname: ${name}\ndescription: ${name} skill\n---\n${s}\n`
  return `---\nname: ${name}\ndescription: ${s.description ?? `${name} skill`}\n${s.frontmatter ?? ''}---\n${s.body}\n`
}

/** 建在 dir/<id>,返回这个路径 */
export function buildPlugin(dir: string, spec: PluginSpec): string {
  const root = join(dir, spec.id)
  mkdirSync(root, { recursive: true })
  const version = spec.version ?? '1.0.0'
  for (const [name, s] of Object.entries(spec.skills ?? {})) put(root, `skills/${name}/SKILL.md`, skillText(name, s))
  for (const [name, text] of Object.entries(spec.commands ?? {})) put(root, `commands/${name}.md`, text)
  if (spec.hooks) put(root, 'hooks/hooks.json', JSON.stringify({ hooks: spec.hooks }))
  if (spec.format === 'native') {
    put(root, 'mff-plugin.json', JSON.stringify({
      id: spec.id, version, kernel: '^0.1.0', name: spec.id,
      ...(spec.skills && { skills: './skills' }),
      ...(spec.commands && { commands: './commands' }),
      ...(spec.mcp && { mcpServers: spec.mcp }),
      ...spec.manifest,
    }))
  } else {
    if (spec.format === 'claude') put(root, '.claude-plugin/plugin.json', JSON.stringify({ name: spec.id, version, ...spec.manifest }))
    if (spec.mcp) put(root, '.mcp.json', JSON.stringify({ mcpServers: spec.mcp }))
  }
  for (const [rel, value] of Object.entries(spec.extra ?? {})) put(root, rel, value)
  return root
}

/** 把假服务和剧本放进 dir/<sub>,返回那个目录;程序名是 fake-mcp.mjs */
export function installFakeMcp(dir: string, scenario: object = {}, sub = 'server'): string {
  const target = join(dir, sub)
  mkdirSync(target, { recursive: true })
  copyFileSync(FAKE_MCP, join(target, 'fake-mcp.mjs'))
  writeFileSync(join(target, 'scenario.json'), JSON.stringify(scenario))
  return target
}

/**
 * 把 plugin 拷到 dir/repo 再 init + commit:插件目录还是一棵普通的树,两种来源都能用。
 * git 的环境是注入的:HOME、全局配置都在 dir 里,系统配置关掉,不看机器上的代理和钩子
 */
export function buildRepo(dir: string, plugin: string): { url: string; commit: string } {
  mkdirSync(dir, { recursive: true })
  const repo = join(dir, 'repo')
  cpSync(plugin, repo, { recursive: true, verbatimSymlinks: true })
  const gitconfig = join(dir, 'gitconfig')
  writeFileSync(gitconfig, '[user]\n\tname = t\n\temail = t@example.invalid\n[init]\n\tdefaultBranch = main\n')
  const env = { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', HOME: dir, USERPROFILE: dir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: dirname(dir) }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { url: `file://${repo}`, commit: git('rev-parse', 'HEAD').trim() }
}

export interface PluginEnvInjected {
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
}

export interface PluginKernelOpts {
  /** 被测的 plugin-manager;每次开内核都调一次(插件有自己的状态) */
  manager?: (env: PluginEnvInjected) => Plugin
  /** 排在 manager 前面的;默认 tools-registry */
  before?: (env: PluginEnvInjected) => Plugin[]
  /** 排在 manager 后面的;默认 loop-default */
  after?: (env: PluginEnvInjected) => Plugin[]
  models?: FakeModelsOpts
  config?: Record<string, unknown>
  /** 内核看到的沙箱级别,默认 none。注入 full、partial 又真跑命令的用例要带平台 skipIf */
  level?: SandboxStatus['level']
  kernel?: Partial<Omit<KernelOpts, 'dataDir' | 'plugins' | 'home' | 'secrets' | 'log'>>
  /** production:数据目录和存储都在临时 home 里(<home>/.myFlowForge、-plugins),cwd 是 <home>/work/proj,和真机一样 */
  layout?: 'production'
}

export interface PluginRig {
  kernel: Kernel
  root: string
  home: string
  dataDir: string
  /** 一个空目录(不是 git 仓库) */
  cwd: string
  env: NodeJS.ProcessEnv
  models: FakeModels
  /** 模型收到的每个前台和后台请求,按调用顺序 */
  requests: Req[]
  logs: string[]
  /** 判"不在里面"用的字节:数据目录和存储根的每个文件(sqlite 先 checkpoint)+ 每行日志。凭据文件除外:osBackend:false 时密钥本来就存在那里 */
  rawBytes(): Buffer
  /** kill:按崩溃算,新内核看到的是这一刻的磁盘。不给:正常 close */
  restart(o?: { kill?: boolean }): Promise<Kernel>
  /** prepare → 等 ready → confirm。没给 grants = 什么都不给 */
  install(path: string, grants?: Grants): Promise<WorkerResult<'plugins.install.confirm'>>
  session(o?: { approvalMode?: 'ask' | 'auto'; origin?: SessionOrigin; cwd?: string }): Promise<string>
  /** 发一句话,等这一轮结束;返回 turnId */
  turn(sessionId: string, text: string): Promise<string>
  /** 本会话的事件 */
  events(sessionId: string): KernelEvent[]
  close(): Promise<void>
}

const CREDENTIAL_FILES = new Set(['credentials.json', 'credentials.enc'])
const TURN_TIMEOUT_MS = 15_000
const POLL_MS = 5

const walk = (dir: string): string[] =>
  !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []))

const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function pluginKernel(opts: PluginKernelOpts = {}): Promise<PluginRig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-plugins-')))
  const home = join(root, 'home')
  const dataDir = opts.layout === 'production' ? join(home, '.myFlowForge') : join(root, 'data')
  const cwd = opts.layout === 'production' ? join(home, 'work', 'proj') : join(root, 'work')
  for (const d of [dataDir, home, cwd]) mkdirSync(d, { recursive: true })
  writeFileSync(join(root, 'gitconfig'), '')
  // 没有代理变量:大小写两种都不传
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  if (opts.config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(opts.config))
  const models = fakeModels(opts.models)
  const logs: string[] = []
  const line = (level: string) => (m: string, d?: unknown) => void logs.push(JSON.stringify({ level, m, d }))
  const log: Logger = { info: line('info'), warn: line('warn'), error: line('error') }
  const level = opts.level ?? 'none'
  const injected: PluginEnvInjected = { dataDir, home, env }
  const git = createGit({ base: env })

  const open = () =>
    createKernel({
      env,
      sandbox: {
        detect: () => ({ level, missing: level === 'full' ? [] : level === 'partial' ? ['netns' as const] : ['platform' as const] }),
        upstream: null,
        git,
      },
      ...opts.kernel,
      log,
      dataDir,
      home,
      secrets: { osBackend: false },
      plugins: [
        models.plugin,
        ...(opts.before?.(injected) ?? [toolsRegistry]),
        ...(opts.manager ? [opts.manager(injected)] : []),
        ...(opts.after?.(injected) ?? [createLoopDefault({ git })]),
      ],
    })

  let kernel: Kernel
  try {
    kernel = await open()
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }

  const imageDirs = () => [dataDir, pluginStoreRootOf(dataDir), `${dataDir}-worktrees`].filter(d => existsSync(d))
  /** 崩溃镜像:同步拷贝,等于这一刻断电的磁盘;旧内核关闭时写的都被它盖掉 */
  const takeImage = () => {
    const image = join(root, 'crash-image')
    rmSync(image, { recursive: true, force: true })
    mkdirSync(image)
    const dirs = imageDirs()
    for (const d of dirs) cpSync(d, join(image, basename(d)), { recursive: true, verbatimSymlinks: true })
    return () => {
      for (const d of imageDirs()) rmSync(d, { recursive: true, force: true })
      for (const d of dirs) renameSync(join(image, basename(d)), d)
      rmSync(image, { recursive: true, force: true })
    }
  }
  const terminal = (sid: string) => rig.kernel.events.bySession(sid).filter(e => e.type === 'turn.ended' || e.type === 'turn.failed').length

  let ids = 0
  const rig: PluginRig = {
    kernel,
    root,
    home,
    dataDir,
    cwd,
    env,
    models,
    get requests() {
      return models.calls.map(c => c.req)
    },
    logs,
    rawBytes() {
      for (const f of walk(dataDir).filter(x => x.endsWith('.sqlite'))) {
        const db = new DatabaseSync(f)
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        } finally {
          db.close()
        }
      }
      const parts = [...walk(dataDir), ...walk(pluginStoreRootOf(dataDir))].filter(f => !CREDENTIAL_FILES.has(basename(f))).map(f => readFileSync(f))
      parts.push(Buffer.from(logs.join('\n')))
      return Buffer.concat(parts)
    },
    async restart(o = {}) {
      if (o.kill) {
        const restore = takeImage()
        await rig.kernel.close()
        restore()
      } else {
        await rig.kernel.close()
      }
      rig.kernel = await open()
      return rig.kernel
    },
    async install(path, grants = { servers: {} }) {
      const { stagingId } = (await rig.kernel.handle('plugins.install.prepare', { source: { kind: 'path', path } })) as WorkerResult<'plugins.install.prepare'>
      const end = Date.now() + TURN_TIMEOUT_MS
      for (;;) {
        const st = (await rig.kernel.handle('plugins.install.status', { stagingId })) as WorkerResult<'plugins.install.status'>
        if (st.state === 'failed') throw new Error(`install failed: ${st.error}`)
        if (st.state === 'ready') {
          return (await rig.kernel.handle('plugins.install.confirm', { commandId: `i${++ids}`, stagingId, consentHash: st.consentHash, grants, enable: true })) as WorkerResult<'plugins.install.confirm'>
        }
        if (Date.now() > end) throw new Error('install never became ready')
        await pause(POLL_MS)
      }
    },
    async session(o = {}) {
      const r = (await rig.kernel.handle('session.create', {
        commandId: `s${++ids}`, cwd: o.cwd ?? cwd, model: { accountId: 'acc', modelId: 'gpt-5' }, approvalMode: o.approvalMode ?? 'ask', ...(o.origin && { origin: o.origin }),
      })) as WorkerResult<'session.create'>
      return r.sessionId
    },
    async turn(sessionId, text) {
      const want = terminal(sessionId) + 1
      const { turnId } = (await rig.kernel.handle('session.prompt', { commandId: `p${++ids}`, sessionId, text })) as WorkerResult<'session.prompt'>
      const end = Date.now() + TURN_TIMEOUT_MS
      while (terminal(sessionId) < want) {
        if (Date.now() > end) throw new Error('turn never ended')
        await pause(POLL_MS)
      }
      return turnId
    },
    events: sessionId => rig.kernel.events.bySession(sessionId),
    async close() {
      try {
        await rig.kernel.close()
      } catch {
        /* 用例中途失败时可能已经关过 */
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return rig
}
