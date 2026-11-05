// MCP 用例共用(09 Task 9):真内核、假模型、假服务;沙箱默认是记录选项的 stub,真 Seatbelt 的行在 mcp.darwin.test.ts。
// 每个 spawn 都记 pid,dispose 证明它们都没了
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent } from '../src/protocol/index'
import type { ExecPlanOpts, ExecPolicy, SandboxService, ShellPlan } from '../src/lib/tools/types'
import { createPluginManager, type PluginManagerOpts } from '../src/plugins/plugin-manager'
import type { McpHost } from '../src/plugins/plugin-manager/mcpHost'
import { alive, call, lastResult, RESERVED, scriptQueue, until } from './managerRig'
import { calling, say, type FakeClock } from './memoryRig'
import { installFakeMcp, pluginKernel, type PluginKernelOpts, type PluginRig } from './pluginRig'

export interface PlanRecord {
  file: string
  args: string[]
  s: { sessionId: string; cwd: string; spillDir: string }
  env: NodeJS.ProcessEnv
  x: ExecPlanOpts
}

export interface StubSandbox extends SandboxService {
  plans: PlanRecord[]
  released: number
  set(o: Partial<StubOpts>): void
}

export interface StubOpts {
  level: 'none' | 'partial' | 'full'
  missing: string[]
  /** 假装计划没有包沙箱:宿主不能跑 */
  sandboxed: boolean
  planError: boolean
  /** 真进程用的 TMPDIR 是计划里的 tmpDir */
  ruleDenyRead: string[]
  ruleDenyWrite: string[]
  untranslatedPaths: number
  untranslatedRules: number
}

export function stubSandbox(over: Partial<StubOpts> = {}): StubSandbox {
  const o: StubOpts = { level: 'full', missing: [], sandboxed: true, planError: false, ruleDenyRead: [], ruleDenyWrite: [], untranslatedPaths: 0, untranslatedRules: 0, ...over }
  const svc: StubSandbox = {
    plans: [],
    released: 0,
    set: more => void Object.assign(o, more),
    status: () => ({ level: o.level, missing: o.missing as never, autoDegraded: false }),
    plan: async () => {
      throw new Error('the shell plan is not for MCP')
    },
    execPolicy: (): ExecPolicy => ({ denyRead: [], persistence: [], dataDir: '/nowhere', level: o.level, ruleDenyRead: o.ruleDenyRead, ruleDenyWrite: o.ruleDenyWrite, untranslatedRules: o.untranslatedRules, untranslatedPaths: o.untranslatedPaths, totalRules: 0 }),
    planExec: async (file, args, s, env, x): Promise<ShellPlan> => {
      svc.plans.push({ file, args, s, env, x })
      if (o.planError) throw new Error('sandbox: kept path holds a hidden root')
      let done = false
      return { file, args, env, sandboxed: o.sandboxed, level: o.level === 'none' ? 'none' : o.level, release: () => void (done || ((done = true), svc.released++)) } as ShellPlan
    },
    close: async () => {},
  }
  return svc
}

export const trackSpawn = (pids: number[], calls: string[][]): typeof nodeSpawn =>
  ((cmd: string, args: string[], o: Parameters<typeof nodeSpawn>[2]) => {
    calls.push([cmd, ...args])
    const child = nodeSpawn(cmd, args, o)
    if (child.pid !== undefined) pids.push(child.pid)
    return child
  }) as unknown as typeof nodeSpawn

export interface McpRigOpts extends Pick<PluginKernelOpts, 'config' | 'before' | 'after' | 'kernel' | 'layout'> {
  level?: 'none' | 'partial' | 'full'
  /** false:用内核真的沙箱服务 */
  stub?: Partial<StubOpts> | false
  clock?: FakeClock
  manager?: PluginManagerOpts
}

export interface McpRig {
  r: PluginRig
  sandbox: StubSandbox | undefined
  /** 现在这个内核的宿主 */
  host(): McpHost
  /** 这个内核起过的全部进程 */
  pids: number[]
  spawns: string[][]
  queue: ReturnType<typeof scriptQueue>
  /** 模型调一次 mcp,等这一轮结束;有卡片就按 decide 答。默认 allow */
  mcp(sid: string, args: object, o?: { decide?: Decide; call?: string }): Promise<{ text: string; cards: CardPayload[] }>
  /** 这个会话的审批卡 */
  cards(sid: string): CardPayload[]
  /** 活着的 pid */
  live(): number[]
  dispose(): Promise<void>
}

export type Decide = 'allow' | 'allow_session' | 'deny'
export interface CardPayload {
  approvalId: string
  summary: string
  key?: string
}

const cardsOf = (events: KernelEvent[]) => events.filter(e => e.type === 'approval.requested').map(e => e.payload as CardPayload)

let calls = 0
export async function mcpRig(o: McpRigOpts = {}): Promise<McpRig> {
  const sandbox = o.stub === false ? undefined : stubSandbox(o.stub)
  const queue = scriptQueue()
  const pids: number[] = []
  const spawns: string[][] = []
  let host: McpHost | undefined
  const r = await pluginKernel({
    level: o.level ?? 'full',
    models: { script: queue.script },
    ...(o.config && { config: o.config }),
    ...(o.before && { before: o.before }),
    ...(o.after && { after: o.after }),
    ...(o.kernel && { kernel: o.kernel }),
    ...(o.layout && { layout: o.layout }),
    manager: e =>
      createPluginManager({
        allowFileProtocol: true,
        env: e.env,
        reservedIds: RESERVED,
        spawn: trackSpawn(pids, spawns),
        loginPath: async () => '',
        onMcpHost: h => void (host = h),
        ...(sandbox && { mcpSandbox: sandbox }),
        ...(o.clock && { now: o.clock.now, timers: o.clock.timers }),
        ...o.manager,
      }),
  })
  const rig: McpRig = {
    r,
    sandbox,
    host: () => host!,
    pids,
    spawns,
    queue,
    cards: sid => cardsOf(r.events(sid)),
    live: () => pids.filter(alive),
    async mcp(sid, args, m = {}) {
      const seen = cardsOf(r.events(sid)).length
      queue.push(calling(m.call ?? `mcp-${++calls}`, 'mcp', args), say('done'))
      let ended = false
      const turn = r.turn(sid, 'go').finally(() => {
        ended = true
      })
      let answered = seen
      while (!ended) {
        const now = cardsOf(r.events(sid))
        for (; answered < now.length; answered++) await call(r, 'approval.respond', { approvalId: now[answered].approvalId, decision: m.decide ?? 'allow' })
        await new Promise(res => setTimeout(res, 3))
      }
      await turn
      const reqs = r.models.foreground()
      return { text: lastResult(reqs.at(-1)!.req), cards: cardsOf(r.events(sid)).slice(seen) }
    },
    async dispose() {
      await r.close()
      // 泄漏就是失败:这里只杀自己起的 pid,杀完才报
      await until(() => pids.every(p => !alive(p)), 6000).catch(() => {
        for (const p of pids.filter(alive)) {
          try {
            process.kill(-p, 'SIGKILL')
          } catch {
            /* 组已经没了 */
          }
        }
        throw new Error(`server process left behind: ${pids.filter(alive).join(',')}`)
      })
    },
  }
  return rig
}

/** 假服务放在存储外面:stub 沙箱下它真能写 calls.jsonl,写进存储就过不了下一次完整性检查 */
export function fakeOutside(dir: string, scenario: object = {}, sub?: string): { dir: string; entry: (more?: object) => object; calls(method?: string): { method: string; params: any; argv: string[]; envNames: string[]; cwd: string }[] } {
  const target = installFakeMcp(dir, scenario, sub)
  return {
    dir: target,
    entry: (more = {}) => ({ command: process.execPath, args: [join(target, 'fake-mcp.mjs')], ...more }),
    calls(method) {
      const f = join(target, 'calls.jsonl')
      if (!existsSync(f)) return []
      const all = readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      return method ? all.filter(c => c.method === method) : all
    },
  }
}

export const statusOf = async (r: PluginRig, sessionId?: string) => (await call(r, 'plugins.mcp.status', sessionId === undefined ? {} : { sessionId })).servers as { plugin: string; server: string; sessionId: string; state: string; reason?: string; pid?: number }[]
export const statusEvents = (r: PluginRig, sid?: string) => r.kernel.events.after(0).filter(e => e.type === 'plugins.mcp.status' && (sid === undefined || e.sessionId === sid)).map(e => e.payload as { plugin: string; server: string; state: string; reason?: string })
