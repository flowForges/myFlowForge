// plugin-manager 用例共用的小工具(09 Task 5 起):经 RPC 走完准备、等状态、确认,判"什么都没留下"
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin, PluginContext } from '../src/kernel/pluginHost'
import { pluginStoreRootOf } from '../src/lib/fs/paths'
import type { ModelEvent } from '../src/lib/models/types'
import type { Tool, ToolsService } from '../src/lib/tools/types'
import { createPluginManager, type PluginManagerOpts } from '../src/plugins/plugin-manager'
import type { PluginSourceParam, WorkerResult } from '../src/protocol/index'
import { say, type Req, type Script } from './memoryRig'
import type { PluginEnvInjected, PluginKernelOpts, PluginRig } from './pluginRig'

export const RESERVED = () => new Set(['memory-default', 'tools-registry', 'plugin-manager'])

/** 测试用的 manager:git 只能走 file://,环境是注入的 */
export const withManager = (o: PluginManagerOpts = {}): Pick<PluginKernelOpts, 'manager'> => ({
  manager: (e: PluginEnvInjected) => createPluginManager({ allowFileProtocol: true, env: e.env, reservedIds: RESERVED, ...o }),
})

export const call = (rig: PluginRig, method: string, params: unknown = {}): Promise<any> => rig.kernel.handle(method as never, params as never) as Promise<any>

/** 拒绝的稳定代码;没拒绝是 'no error' */
export const refused = (p: Promise<unknown>): Promise<string> => p.then(() => 'no error', e => (e as Error).message)

const POLL_MS = 5
const WAIT_MS = 15_000

export async function settled(rig: PluginRig, stagingId: string): Promise<WorkerResult<'plugins.install.status'> & { path?: string }> {
  const end = Date.now() + WAIT_MS
  for (;;) {
    const st = await call(rig, 'plugins.install.status', { stagingId })
    if (st.state !== 'fetching') return st
    if (Date.now() > end) throw new Error('staging never settled')
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

export async function prepare(rig: PluginRig, source: PluginSourceParam) {
  const { stagingId } = await call(rig, 'plugins.install.prepare', { source })
  return { stagingId: stagingId as string, ...(await settled(rig, stagingId)) }
}

let confirms = 0
export const confirm = (rig: PluginRig, st: { stagingId: string; consentHash?: string }, over: Record<string, unknown> = {}) =>
  call(rig, 'plugins.install.confirm', { commandId: `confirm-${++confirms}`, stagingId: st.stagingId, consentHash: st.consentHash ?? 'none', grants: { servers: {} }, enable: true, ...over })

export const storeOf = (rig: PluginRig) => pluginStoreRootOf(rig.dataDir)
export const installedFile = (rig: PluginRig) => join(rig.dataDir, 'plugins', 'plugin-manager', 'installed.json')
export const types = (rig: PluginRig) => rig.kernel.events.after(0).map(e => e.type)
export const eventsOf = (rig: PluginRig, type: string) => rig.kernel.events.after(0).filter(e => e.type === type)

/** 一棵树的字节快照:路径 → 类型、权限、内容哈希。不在 = 空对象 */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (abs: string, rel: string) => {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) out[rel] = `link:${readlinkSync(abs)}`
    else if (st.isDirectory()) {
      out[rel] = 'dir'
      for (const n of readdirSync(abs)) visit(join(abs, n), rel === '' ? n : `${rel}/${n}`)
    } else out[rel] = `${(st.mode & 0o777).toString(8)}:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`
  }
  if (existsSync(root) || isLink(root)) visit(root, '')
  return out
}
const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 真的进程,但等 gate 文件出现才 exec:进程组、kill 都是真的,不造假 pid */
export function gatedSpawn(gate: string, pids: number[] = [], calls: string[][] = []): typeof nodeSpawn {
  return ((cmd: string, args: string[], o: Parameters<typeof nodeSpawn>[2]) => {
    calls.push([cmd, ...args])
    const child = nodeSpawn('/bin/sh', ['-c', 'while [ ! -e "$0" ]; do sleep 0.02; done; exec "$@"', gate, cmd, ...args], o)
    if (child.pid !== undefined) pids.push(child.pid)
    return child
  }) as unknown as typeof nodeSpawn
}

export const spySpawn = (calls: string[][]): typeof nodeSpawn =>
  ((cmd: string, args: string[], o: Parameters<typeof nodeSpawn>[2]) => {
    calls.push([cmd, ...args])
    return nodeSpawn(cmd, args, o)
  }) as unknown as typeof nodeSpawn

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function until(cond: () => boolean, ms = WAIT_MS): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition never held')
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

/** 剧本队列:前台请求按顺序取下一步,取完了回 ok;后台请求不占队列 */
export function scriptQueue(): { script: Script; push(...steps: AsyncIterable<ModelEvent>[]): void } {
  const steps: AsyncIterable<ModelEvent>[] = []
  return {
    script: (_n, req) => (req.interactive ? (steps.shift() ?? say('ok')) : say('{}')),
    push: (...s) => void steps.push(...s),
  }
}

/** 这个请求里最后一条工具结果的文字 */
export function lastResult(req: Req): string {
  const part = req.messages.filter(m => m.role === 'tool').at(-1)?.parts.at(-1)
  return part?.type === 'tool_result' ? String(part.content) : ''
}

/** 只拿到插件的 ctx 和注册几个工具:用例要自己写事件、放假工具时用 */
export function stubPlugin(tools: Tool[] = [], onActivate?: (ctx: PluginContext) => void): Plugin {
  return {
    manifest: { id: 'stub-tools', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      const service = ctx.services.get<ToolsService>('tools')!
      for (const t of tools) ctx.effect(service.register(t))
      onActivate?.(ctx)
    },
  }
}

export const stubTool = (name: string, over: Partial<Tool> = {}): Tool => ({
  name,
  description: `${name} stub`,
  parameters: { type: 'object', properties: {} },
  permission: () => [{ actor: 'tools', action: 'memory' }],
  run: async () => ({ content: `${name} ran` }),
  ...over,
})
