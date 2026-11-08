// 记忆测试夹具(06):真内核 + 假模型(以插件提供 models)+ 假时钟;临时 home,不碰真网络、真钥匙串
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel, type KernelOpts } from '../src/kernel/kernel'
import type { Plugin } from '../src/kernel/pluginHost'
import { createGit } from '../src/lib/git/snapshot'
import type { ModelEvent, ModelRequest, ModelsService, Quota } from '../src/lib/models/types'
import type { AccountState, AccountView, CatalogView, ModelEntry, ModelRef, PresetView } from '../src/protocol/models'
import { NO_SANDBOX } from './sandboxStub'

export type Req = Omit<ModelRequest, 'model'>
export type Script = (n: number, req: Req, ref: ModelRef) => AsyncIterable<ModelEvent>

async function* seq(...evs: ModelEvent[]): AsyncIterable<ModelEvent> {
  for (const e of evs) yield e
}
export const done = (reason: 'stop' | 'tool_calls' = 'stop'): ModelEvent => ({ type: 'done', reason })
export const say = (text: string, usage = { input: 1, output: 1 }) => seq({ type: 'text', delta: text }, { type: 'usage', ...usage }, done())
export const calling = (id: string, name: string, args: object) => seq({ type: 'tool_call', id, name, argsDelta: JSON.stringify(args) }, done('tool_calls'))

export interface FakeAccount {
  id: string
  presetId?: string
  billing?: PresetView['billing']
  restriction?: PresetView['restriction']
  /** 08 §4.7:账号自己标的限制(自定义账号),进 accounts() 的视图 */
  accountRestriction?: AccountView['restriction']
  state?: AccountState
  /** 只有 id 是必填;cost、deprecated、context 按用例给 */
  models: (Partial<ModelEntry> & { id: string })[]
}

export interface ModelCall {
  /** 'default' 已解析成实际的账号和模型 */
  ref: ModelRef
  /** messages 是调用时的副本;signal 原样留着,测试能看它有没有中止 */
  req: Req
}

export interface FakeModelsOpts {
  accounts?: FakeAccount[]
  /** 不给 = 第一个账号的第一个模型 */
  default?: ModelRef
  script?: Script
  onRequest?(call: ModelCall): void
  quota?(accountId: string): Quota | null | Promise<Quota | null>
  /** 这个账号有用量接口,但这次探测失败了 */
  quotaFailed?(accountId: string): boolean
}

export interface FakeModels {
  plugin: Plugin
  service: ModelsService
  /** 前台和后台的请求,按调用顺序 */
  calls: ModelCall[]
  foreground(): ModelCall[]
  background(): ModelCall[]
}

const FAKE_ACCOUNT: FakeAccount = { id: 'acc', models: [{ id: 'gpt-5' }] }

const entry = (m: FakeAccount['models'][number]): ModelEntry => ({ name: m.id, context: 100_000, output: 4000, image: false, reasoning: 'none', toolCall: true, ...m })
const presetIdOf = (a: FakeAccount) => a.presetId ?? `preset-${a.id}`

/** accounts 不复制:用例改了账号或模型,下一次 catalog() 就看得到 */
export function fakeModels(opts: FakeModelsOpts = {}): FakeModels {
  const accounts = opts.accounts ?? [FAKE_ACCOUNT]
  const script: Script = opts.script ?? (() => say('ok'))
  const defaultRef = (): ModelRef | undefined => opts.default ?? (accounts[0]?.models[0] && { accountId: accounts[0].id, modelId: accounts[0].models[0].id })
  const calls: ModelCall[] = []
  const service = {
    catalog: (): CatalogView => ({
      presets: accounts.map(a => ({
        id: presetIdOf(a), label: a.id, billing: a.billing ?? 'metered', restriction: a.restriction ?? 'none', auth: 'api-key', protocols: ['openai-chat'], docsUrl: '',
      })),
      models: Object.fromEntries(accounts.map(a => [presetIdOf(a), a.models.map(entry)])),
      default: defaultRef(),
    }),
    accounts: (): AccountView[] => accounts.map(a => ({ id: a.id, presetId: presetIdOf(a), label: a.id, state: a.state ?? 'ok', models: a.models.map(entry), ...(a.accountRestriction && { restriction: a.accountRestriction }) })),
    stream(ref: ModelRef | 'default', req: Req) {
      const resolved = ref === 'default' ? defaultRef() : ref
      if (!resolved) throw new Error('fakeModels: no default model')
      const call: ModelCall = { ref: resolved, req: { ...req, messages: structuredClone(req.messages) } }
      calls.push(call)
      opts.onRequest?.(call)
      return script(calls.length, req, resolved)
    },
    quota: async (accountId: string) => (await opts.quota?.(accountId)) ?? null,
    quotaRead: async (accountId: string) => ({ quota: (await opts.quota?.(accountId)) ?? null, failed: opts.quotaFailed?.(accountId) ?? false }),
  } as unknown as ModelsService
  return {
    plugin: { manifest: { id: 'fake-models', version: '0', kernel: '^0.1.0', provides: ['models'] }, activate: ctx => ctx.services.provide('models', service) },
    service,
    calls,
    foreground: () => calls.filter(c => c.req.interactive),
    background: () => calls.filter(c => !c.req.interactive),
  }
}

export interface FakeTimer {
  unref(): FakeTimer
}

export interface FakeClock {
  now(): number
  /** 往前走,途中到期的定时器按到期顺序跑;回调里新排的只要落在这段里也跑 */
  advance(ms: number): void
  timers: { setTimeout(fn: () => void, ms: number): FakeTimer; clearTimeout(t: FakeTimer): void }
}

/** 默认起点是本地时间的中午:本地日期由注入的 now 算,TZ 不动 */
export function fakeClock(start: number = new Date(2026, 10, 4, 12).getTime()): FakeClock {
  let t = start
  let order = 0
  const pending = new Map<FakeTimer, { at: number; order: number; fn: () => void }>()
  const next = (until: number) => {
    let best: [FakeTimer, { at: number; order: number; fn: () => void }] | undefined
    for (const item of pending) {
      if (item[1].at > until) continue
      if (!best || item[1].at < best[1].at || (item[1].at === best[1].at && item[1].order < best[1].order)) best = item
    }
    return best
  }
  return {
    now: () => t,
    advance(ms) {
      const until = t + ms
      for (let due = next(until); due; due = next(until)) {
        pending.delete(due[0])
        t = Math.max(t, due[1].at)
        due[1].fn()
      }
      t = until
    },
    timers: {
      setTimeout(fn, ms) {
        const handle: FakeTimer = { unref: () => handle }
        pending.set(handle, { at: t + ms, order: order++, fn })
        return handle
      },
      clearTimeout: h => void pending.delete(h),
    },
  }
}

export interface MemoryKernelOpts {
  /** 给函数:restart() 时重新建插件(插件自己有状态的时候) */
  plugins?: Plugin[] | (() => Plugin[])
  /** 排在 plugins 前面 */
  models?: FakeModels
  /** 写进 config.json 的初始内容 */
  config?: Record<string, unknown>
  kernel?: Partial<Omit<KernelOpts, 'dataDir' | 'plugins' | 'home' | 'secrets'>>
}

export interface MemoryRig {
  k: Kernel
  root: string
  dataDir: string
  home: string
  /** 一个空目录(不是 git 仓库),给要 cwd 的会话 */
  cwd: string
  /** 关掉内核再用同一份数据目录开一个;rig.k 换成新的 */
  restart(): Promise<Kernel>
  /** 关内核、删临时目录 */
  close(): Promise<void>
}

export async function memoryKernel(opts: MemoryKernelOpts = {}): Promise<MemoryRig> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-memory-')))
  const dataDir = join(root, 'data')
  const home = join(root, 'home')
  const cwd = join(root, 'work')
  for (const d of [dataDir, home, cwd]) mkdirSync(d)
  writeFileSync(join(root, 'gitconfig'), '')
  const env = { PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  if (opts.config) writeFileSync(join(dataDir, 'config.json'), JSON.stringify(opts.config))
  const open = () => {
    const plugins = typeof opts.plugins === 'function' ? opts.plugins() : (opts.plugins ?? [])
    return createKernel({
      env,
      sandbox: { ...NO_SANDBOX, git: createGit({ base: env }) },
      ...opts.kernel,
      dataDir,
      home,
      plugins: [...(opts.models ? [opts.models.plugin] : []), ...plugins],
      secrets: { osBackend: false },
    })
  }
  let k: Kernel
  try {
    k = await open()
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
  const rig: MemoryRig = {
    k,
    root,
    dataDir,
    home,
    cwd,
    async restart() {
      await rig.k.close()
      rig.k = await open()
      return rig.k
    },
    async close() {
      // 用例中途失败时内核可能已经关过,再关会同步抛错:临时目录照样要删
      try {
        await rig.k.close()
      } catch {
        /* 已关 */
      }
      rmSync(root, { recursive: true, force: true })
    },
  }
  return rig
}
