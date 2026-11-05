// 第三方 JS 进工作进程的唯一入口(09 spec §12)。整棵树只有这里有动态 import,boundary.test.ts 守着。
// 进程内的代码什么都能做:这里不是隔离,只保证载的是用户批过的那份字节,以及载崩了还能把它关掉
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from '../kernel/pluginHost'
import { scrub } from '../lib/memory/scrub'
import { MAX_DEV_MAIN_BYTES, readDevIndex, readOnce, type DevEntry } from '../lib/plugins/devStore'
import { clip } from '../lib/plugins/types'

/** 活过这么久就不算它崩的。熔断要 5 分钟 10 次,活过 30 s 的崩溃加上退避触发不了 */
export const DEV_LOADED_AFTER_MS = 30_000
const MARKER = 'dev-loading'

interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
}

export interface DevLoad {
  plugins: Plugin[]
  skipped?: 'dev_crashed'
  /** 删标记。worker 的 stop 也调:启动 30 s 内正常退出不是崩溃 */
  markLoaded(): void
  /** 激活完才调:30 s 后 markLoaded */
  armMarkLoaded(): void
}

export interface LoadDevOpts {
  dataDir: string
  runDir: string
  log: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void }
  importer?: (url: string) => Promise<unknown>
  timers?: Timers
}

/** 激活时才抛:这样它在 status 里是 failed、有 plugin.failed,别的插件不受影响 */
const failing = (id: string, message: string): Plugin => ({
  manifest: { id, version: '0.0.0', kernel: '*' },
  async activate() {
    throw new Error(message)
  },
})

const describeError = (err: unknown) => clip(scrub(err instanceof Error ? err.message : String(err)).text, 500)

async function loadOne(entry: DevEntry, importer: (url: string) => Promise<unknown>, log: LoadDevOpts['log']): Promise<Plugin> {
  const copy = readOnce(entry.file, MAX_DEV_MAIN_BYTES)
  if (!copy.ok || createHash('sha256').update(copy.bytes).digest('hex') !== entry.hash) {
    log.warn('dev plugin not loaded', { id: entry.id, error: 'hash_mismatch' })
    return failing(entry.id, 'hash_mismatch')
  }
  try {
    const mod = (await importer(pathToFileURL(entry.file).href)) as { default?: { manifest?: Plugin['manifest']; activate?: unknown } }
    const def = mod.default
    const manifest = def?.manifest
    if (manifest?.id !== entry.id) throw new Error('manifest id differs from the approved one')
    if (typeof def?.activate !== 'function') throw new Error('default export has no activate')
    const real = def as Plugin
    return {
      // 只查一次,之后用查过的这份
      manifest: { ...manifest, id: entry.id },
      async activate(ctx) {
        await real.activate(ctx)
        ctx.append({ type: 'plugins.dev.loaded', payload: { id: entry.id, hash: entry.hash } })
      },
    }
  } catch (err) {
    const message = describeError(err)
    log.warn('dev plugin not loaded', { id: entry.id, error: message })
    return failing(entry.id, message)
  }
}

export async function loadDevPlugins(o: LoadDevOpts): Promise<DevLoad> {
  const importer = o.importer ?? ((u: string) => import(/* @vite-ignore */ u))
  const timers = o.timers ?? realTimers
  const marker = join(o.runDir, MARKER)
  const present = () => {
    try {
      return lstatSync(marker, { throwIfNoEntry: false }) !== undefined
    } catch {
      return false // run 不是目录:下面写标记会失败,那条路不载
    }
  }
  let timer: unknown
  const markLoaded = () => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
    try {
      if (present()) rmSync(marker, { force: true, recursive: true })
    } catch (err) {
      o.log.warn('dev marker not removed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }
  const armMarkLoaded = () => {
    if (timer !== undefined) return
    timer = timers.setTimeout(() => {
      timer = undefined
      markLoaded()
    }, DEV_LOADED_AFTER_MS)
  }
  const result = (plugins: Plugin[], skipped?: 'dev_crashed'): DevLoad => ({ plugins, ...(skipped && { skipped }), markLoaded, armMarkLoaded })

  const entries = readDevIndex(o.dataDir, o.log)
  if (entries.length === 0) {
    // 上次崩了,这之间已经把插件移除了:没有可跳过的
    markLoaded()
    return result([])
  }
  if (present()) {
    o.log.warn('dev plugins skipped: the last start did not survive loading them')
    return result([], 'dev_crashed')
  }
  try {
    mkdirSync(o.runDir, { recursive: true, mode: 0o700 })
    writeFileSync(marker, '', { mode: 0o600 })
  } catch (err) {
    // 没有标记就没有崩溃保护:process.exit 的插件会让熔断锁死,连 RPC 都起不来
    o.log.warn('dev plugins not loaded: marker not written', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    return result(entries.map(e => failing(e.id, 'dev_guard_unavailable')))
  }
  const plugins: Plugin[] = []
  for (const e of entries) plugins.push(await loadOne(e, importer, o.log))
  return result(plugins)
}
