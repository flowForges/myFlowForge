// executor-cli:把任务委派给本机已登录的 CLI(04 spec)。一个执行器一个工具;探测在后台跑,不挡启动
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PermissionGate, PermissionRequest } from '../../kernel/permissionGate'
import type { Plugin, PluginContext } from '../../kernel/pluginHost'
import { RpcError } from '../../kernel/rpcError'
import type { Sessions } from '../../kernel/sessions'
import { createGit, type Git } from '../../lib/git/snapshot'
import { worktreeRootOf } from '../../lib/git/worktree'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { clip, formatFailure } from '../../lib/tools/diagnostics'
import { redact } from '../../lib/tools/redact'
import { loginShellPath, shellEnv } from '../../lib/tools/shellEnv'
import { argsOf, type BackgroundRuns, type SandboxService, type Tool, type ToolContext, type ToolResult, type ToolsService } from '../../lib/tools/types'
import type { ExecutorListResult, WorkerParams } from '../../protocol/index'
import type { ExecutorIsolation, ExecutorRunReason } from '../../protocol/tools'
import { codexAdapter } from './adapters/codex'
import { qoderAdapter } from './adapters/qoder'
import { ModelSchema, type Adapter } from './adapters/types'
import { binaryChanged, checkAuth, detectExecutor, isolationOf, runProbe, type DetectDeps, type ExecutorInfo } from './detect'
import { manifestFor } from './manifest'
import { mustAsk } from './policy'
import { parseExecutorsConfig, RunManager } from './runs'

export { manifestFor }

/** 审批摘要:IM 卡片上看不全就不能批。runs.ts 里 executor.run.queued 的 300 是另一回事 */
const SUMMARY_MAX = 2000
/** spec §11:结果缓存 30 秒,missing 每次重探 */
const AUTH_CACHE_MS = 30_000
/** 内核已经限时等过 abandonAll:这里不能再加一轮等待,否则超出停机预算 */
const DISPOSE_WAIT_MS = 500

const Args = z.object({
  prompt: z.string().min(1).max(64_000),
  readOnly: z.boolean().optional(),
  model: ModelSchema.optional(),
  timeoutMinutes: z.number().min(1).max(120).optional(),
})

const description = (label: string) =>
  `Run a sub-task with the user's local ${label} CLI, on the user's own subscription. Do not delegate unless the user asked for it. Returns at once with a run id; the outcome arrives later as an \`<executor-notice>\` in this conversation, so do not poll. You may keep working or finish your reply: the turn stays open until every run ends. Sub-tasks that run at the same time must not write overlapping files. The prompt must stand alone, because the CLI cannot see this conversation. A failed sub-task is reported in the notice, not as an error of yours; decide what to do next. The user may message you while you wait; running sub-tasks keep running. Set readOnly for reviews and questions.`

/** 插件之间不能 import,tools-coding 的 jsonSchema 用不了 */
const parameters = (() => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(Args) as Record<string, unknown>
  return rest
})()

const SUBMIT_FAILURES: Partial<Record<ExecutorRunReason, string>> = {
  not_installed: 'Not started: the CLI is not installed.',
  too_many_runs: 'Not started: too many sub-tasks in this turn.',
  queue_full: 'Not started: too many sub-tasks are queued. Try again after one ends.',
  kernel_stopping: 'Not started: the background service is stopping.',
  cancelled: 'Not started: this turn was cancelled.',
}
const BINARY_CHANGED = 'Not started: the CLI program changed since it was checked, or is not trusted. It is being re-checked; try again shortly.'

export interface ExecutorCliOpts {
  adapters?: Adapter[]
  /** 启动时的环境;默认 process.env,测试注入隔离环境 */
  env?: NodeJS.ProcessEnv
  /** 登录 shell 的 PATH;默认探测一次,测试注入 `async () => ''` */
  loginPath?: () => Promise<string>
  git?: Git
  worktreeRoot?: string
  /** 找程序用的名字(按执行器 id);测试用来避开机器上真的那个 */
  bins?: Record<string, string>
  /** 探测怎么跑进程;测试注入 */
  run?: DetectDeps['run']
  platform?: NodeJS.Platform
  now?: () => number
}

const UNSUPPORTED = (id: string) => ({ id, installed: false, auth: 'unknown' as const, isolation: 'none' as const, missing: ['unsupported'] })

/** win32:工具不注册,RPC 如实回 */
function activateUnsupported(ctx: PluginContext, adapters: Adapter[]): void {
  const list = async (): Promise<ExecutorListResult> => ({ executors: adapters.map(a => UNSUPPORTED(a.id)) })
  ctx.rpc.register('executor.list', list)
  ctx.rpc.register('executor.refresh', list)
  ctx.rpc.register('executor.cancel', async () => ({ ok: false }))
  ctx.rpc.register('executor.worktree.discard', async () => ({ ok: false }))
  ctx.rpc.register('executor.changes', async () => {
    throw new RpcError(-32602, 'unknown run')
  })
}

export function createExecutorCli(opts: ExecutorCliOpts = {}): Plugin {
  const platform = opts.platform ?? process.platform
  return {
    manifest: manifestFor(platform),
    activate(ctx) {
      const adapters = (opts.adapters ?? [codexAdapter, qoderAdapter]).map(a => (opts.bins?.[a.id] ? { ...a, bin: opts.bins[a.id] } : a))
      if (platform === 'win32') return activateUnsupported(ctx, adapters)

      const tools = ctx.services.get<ToolsService>('tools')
      const sessions = ctx.services.get<Sessions>('sessions')
      const sandbox = ctx.services.get<SandboxService>('sandbox')
      const gate = ctx.services.get<PermissionGate>('permissionGate')
      if (!tools || !sessions || !sandbox || !gate) throw new Error('tools / sessions / sandbox / permissionGate service missing')
      const registry = ctx.services.get<PgidRegistry>('pgids')

      const env = opts.env ?? { ...process.env }
      const home = env.HOME ?? homedir()
      const now = opts.now ?? Date.now
      const git = opts.git ?? createGit()
      const tmpDir = join(ctx.dataDir, 'tmp')
      mkdirSync(tmpDir, { recursive: true })
      const warn = (message: string) => ctx.log.warn(message)
      // 只在激活时读:改了要重启,重启后探测本来就是新的
      const cfg = parseExecutorsConfig(ctx.config.executors, warn)

      const byId = new Map(adapters.map(a => [a.id as string, a]))
      const infos = new Map<string, ExecutorInfo>(adapters.map(a => [a.id, { id: a.id, installed: false, auth: 'unknown', isolation: 'none', missing: ['detecting'] }]))
      const authAt = new Map<string, number>()
      const registered = new Map<string, () => void>()
      const inflight = new Map<string, Promise<ExecutorInfo>>()
      const probes = new AbortController()
      let disposed = false

      let login: Promise<string> | undefined
      /** permission() 是同步的:探测之前工具还没注册,用到时已经有值 */
      let loginNow = ''
      const loginPath = () => {
        login ??= (opts.loginPath ?? (() => loginShellPath()))().catch(() => '').then(p => (loginNow = p))
        return login
      }

      const detectDeps = async (a: Adapter, force: boolean, signal: AbortSignal = probes.signal): Promise<DetectDeps> => {
        // 关掉的执行器什么都不跑,登录 shell(用户的 rc 文件)也不例外
        const base = shellEnv(env, { platform, home, loginPath: cfg.disabled.includes(a.id) ? '' : await loginPath() })
        for (const k of a.passEnv) if (env[k] !== undefined) base[k] = env[k]
        return {
          env: base,
          run: opts.run ?? runProbe,
          sandboxLevel: () => sandbox.status().level,
          platform,
          // 不能在数据目录里:数据目录在 denyRead 里,自检永远过不了
          tmp: () => realpathSync(tmpdir()),
          policy: () => ({ denyRead: sandbox.execPolicy('', '/', a.id).denyRead }),
          config: () => cfg,
          signal,
          pgids: registry,
          force,
        }
      }

      const syncTool = (a: Adapter, info: ExecutorInfo) => {
        const off = registered.get(a.id)
        if (info.installed && !off) registered.set(a.id, tools.register(toolFor(a)))
        else if (!info.installed && off) {
          off()
          registered.delete(a.id)
        }
      }

      /**
       * 同一个执行器同时只探测一次。fresh:正在跑的那次可能早于这次变化,排在它后面再跑一次。
       * info 先更新再 resolve:等它的运行(redetect)接着就要读
       */
      const detect = (a: Adapter, o: { fresh?: boolean; force?: boolean } = {}): Promise<ExecutorInfo> => {
        const running = inflight.get(a.id)
        if (running && !o.fresh) return running
        const p: Promise<ExecutorInfo> = (running ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => detectDeps(a, o.force === true))
          .then(deps => detectExecutor(a, deps))
          .then(info => {
            if (!disposed) {
              infos.set(a.id, info)
              authAt.set(a.id, now())
              syncTool(a, info)
            }
            return info
          })
          .finally(() => {
            if (inflight.get(a.id) === p) inflight.delete(a.id)
          })
        inflight.set(a.id, p)
        return p
      }
      const inBackground = (a: Adapter) =>
        void detect(a).catch(e => ctx.log.warn('detection failed', { id: a.id, error: e instanceof Error ? redact(e.message) : 'unknown' }))

      const manager = new RunManager({
        append: e => ctx.append(e),
        sessions,
        sandbox,
        gate,
        git,
        log: ctx.log,
        env,
        loginPath,
        registry,
        adapters: byId as Map<string, Adapter>,
        info: id => infos.get(id)!,
        config: () => cfg,
        history: sid => ctx.events.history(sid),
        // ctx.dataDir 是 <数据目录>/plugins/<id>:数据目录在凭据黑名单里,worktree 要放在它外面
        worktreeRoot: opts.worktreeRoot ?? worktreeRootOf(dirname(dirname(ctx.dataDir))),
        dataDir: dirname(dirname(ctx.dataDir)),
        redetect: id => detect(byId.get(id)!),
        tmpDir,
        home,
        platform,
      })

      /** 这次批准时看到的:args 对象在 permission 和 run 之间是同一个 */
      const approved = new WeakMap<object, { exec: PermissionRequest; isolation: ExecutorIsolation; binaryKey?: string }>()

      /** 同步。批准和运行必须看同一份 */
      const execRequest = (a: Adapter, args: z.infer<typeof Args>, raw: object, ctx: ToolContext) => {
        const info = infos.get(a.id)!
        // 不认识的来源不能当 app,和 submit 同样的兜底
        const view = manager.preview(a.id, info, { sessionId: ctx.sessionId, cwd: ctx.cwd, spillDir: ctx.spillDir, origin: sessions.get(ctx.sessionId)?.origin ?? 'schedule' }, loginNow)
        const must = mustAsk(view.policy, view.isolation)
        const unsandboxed = view.isolation === 'none'
        const exec: PermissionRequest = {
          actor: 'tools',
          action: 'exec',
          resource: a.id,
          sessionId: ctx.sessionId,
          // 只读还是可写是模型选的,人要看得到;前缀在提示前面,提示写不进来
          summary: `${a.id} · ${args.readOnly ? '只读' : '可写'}${args.model !== undefined ? ` · ${args.model}` : ''}: ${clip(redact(args.prompt), SUMMARY_MAX)}`,
          // 落实不了的规则、无隔离的运行:每次都问,不给本会话放行
          ...(!must && !unsandboxed && { key: `executor:${a.id}:${args.readOnly ? 'ro' : 'rw'}` }),
          unsandboxed,
          mustAsk: must,
        }
        const record = { exec, isolation: view.isolation, binaryKey: info.binaryKey }
        approved.set(raw, record)
        return { record, info, view }
      }

      const authNow = async (a: Adapter, info: ExecutorInfo, signal: AbortSignal): Promise<ExecutorInfo['auth']> => {
        if (info.path === undefined) return info.auth
        if (info.auth !== 'missing' && now() - (authAt.get(a.id) ?? 0) < AUTH_CACHE_MS) return info.auth
        const auth = await checkAuth(a, info.path, await detectDeps(a, false, AbortSignal.any([probes.signal, signal])))
        authAt.set(a.id, now())
        const current = infos.get(a.id)!
        if (current.path === info.path) infos.set(a.id, { ...current, auth })
        return auth
      }

      const toolFor = (a: Adapter): Tool => ({
        name: a.toolName,
        description: description(a.label),
        parameters,
        delegate: true,
        permission(raw, tc) {
          const args = argsOf(Args, raw)
          const { record, info, view } = execRequest(a, args, raw as object, tc)
          // 这时候问人,问的是一个没验证过的文件:不出卡片,重新探测,模型重试
          if (binaryChanged(info) || view.missing.includes('untrusted_binary')) {
            inBackground(a)
            throw new Error(formatFailure('untrusted_binary', { id: a.id, isolation: view.isolation, message: BINARY_CHANGED }))
          }
          const base = { actor: 'tools', sessionId: tc.sessionId }
          return [
            record.exec,
            { ...base, action: 'read', resource: tc.cwd },
            ...(args.readOnly ? [] : [{ ...base, action: 'write', resource: tc.cwd }]),
          ]
        },
        async run(raw, tc): Promise<ToolResult> {
          const args = argsOf(Args, raw)
          const known = approved.get(raw as object)
          // 没走 permission 的调用没人批过:asked 是 false,出队时要问的一律拒绝
          const record = known ?? execRequest(a, args, raw as object, tc).record
          // 第一个 await 之前:之后才加的 ask 规则没人批过,不能算进去
          const asked = known !== undefined && gate.check(record.exec) === 'ask'
          const fail = (reason: ExecutorRunReason, message: string): ToolResult => ({
            content: formatFailure(reason, { id: a.id, isolation: record.isolation, message }),
            isError: true,
          })
          const info = infos.get(a.id)!
          // 程序变了就不跑它,出队时重新探测
          const auth = binaryChanged(info) ? info.auth : await authNow(a, info, tc.signal)
          if (tc.signal.aborted) return fail('cancelled', 'Not started: this turn was cancelled.')
          if (auth === 'missing') return fail('auth_missing', `Not started: the ${a.label} CLI is not logged in. The user has to log in first.`)
          const r = manager.submit({
            adapter: a.id,
            prompt: args.prompt,
            model: args.model,
            readOnly: args.readOnly === true,
            timeoutMs: (args.timeoutMinutes ?? cfg.timeoutMinutes) * 60_000,
            sessionId: tc.sessionId,
            turnId: tc.turnId,
            callId: tc.callId,
            cwd: tc.cwd,
            spillDir: tc.spillDir,
            // 不认识的来源不能当 app:那样写运行就在地跑了
            origin: sessions.get(tc.sessionId)?.origin ?? 'schedule',
            isolation: record.isolation,
            asked,
            approvedBinary: record.binaryKey,
          })
          if ('failure' in r) return fail(r.failure, SUBMIT_FAILURES[r.failure] ?? 'Not started.')
          const state = r.queued ? `已排队 ${r.runId}(${a.id}),第 ${r.position + 1} 位` : `已启动 ${r.runId}(${a.id})`
          return { content: `${state}。结果会以 <executor-notice> 送达,不用轮询。`, meta: { runId: r.runId, isolation: record.isolation } }
        },
      })

      /** 内核关闭或插件停用:探测不再起新的,也不再注册工具 */
      const stop = () => {
        disposed = true
        probes.abort()
      }

      const service: BackgroundRuns = {
        active: t => manager.active(t),
        pending: t => manager.pending(t),
        take: t => manager.take(t),
        wait: (t, s) => manager.wait(t, s),
        abandon: (t, r) => manager.abandon(t, r),
        abandonAll: reason => {
          stop()
          return manager.abandonAll(reason)
        },
      }
      ctx.services.provide('executors', service)

      const wire = (a: Adapter): ExecutorListResult['executors'][number] => {
        const info = infos.get(a.id)!
        const { isolation, missing } = isolationOf(a, info, sandbox.status().level, cfg, undefined)
        // path、binaryKey 不上线
        return { id: a.id, installed: info.installed, ...(info.version !== undefined && { version: info.version }), auth: info.auth, isolation, missing }
      }
      const list = (): ExecutorListResult => ({ executors: adapters.map(wire) })
      ctx.rpc.register('executor.list', async () => list())
      ctx.rpc.register('executor.refresh', async () => {
        await Promise.all(adapters.map(a => detect(a, { fresh: true, force: true })))
        return list()
      })
      ctx.rpc.register('executor.cancel', async params => {
        const { sessionId, runId } = params as WorkerParams<'executor.cancel'>
        return { ok: manager.cancel(sessionId, runId) }
      })
      ctx.rpc.register('executor.changes', async params => {
        const { sessionId, runId } = params as WorkerParams<'executor.changes'>
        return manager.changes(sessionId, runId)
      })
      ctx.rpc.register('executor.worktree.discard', async params => {
        const { sessionId, runId } = params as WorkerParams<'executor.worktree.discard'>
        return manager.discard(sessionId, runId)
      })

      // 最后注册、最先释放:先挡住还在路上的探测结果
      ctx.effect(async () => {
        stop()
        for (const off of registered.values()) off()
        registered.clear()
        let timer: NodeJS.Timeout | undefined
        await Promise.race([
          manager.abandonAll('kernel_stopping'),
          new Promise<void>(res => {
            timer = setTimeout(res, DISPOSE_WAIT_MS)
          }),
        ])
        clearTimeout(timer)
      })

      // 不等:探测最坏每个执行器约 50 s
      for (const a of adapters) inBackground(a)
    },
  }
}

export default createExecutorCli()
