// 第三方 JS 进工作进程的唯一入口(09 spec §12)。整棵树只有这里有动态 import,boundary.test.ts 守着。
// 进程内的代码什么都能做:这里不是隔离,只保证载的是用户批过的那份字节,以及载崩了还能把它关掉
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from '../kernel/pluginHost'
import { DEV_CRASHED, DEV_LOADING, MAX_DEV_MAIN_BYTES, readDevIndex, readOnce, type DevEntry } from '../lib/plugins/devStore'

export interface DevLoad {
  plugins: Plugin[]
  skipped?: 'dev_crashed'
}

export interface LoadDevOpts {
  dataDir: string
  runDir: string
  log: { info(m: string, d?: unknown): void; warn(m: string, d?: unknown): void }
  importer?: (url: string) => Promise<unknown>
}

type Log = LoadDevOpts['log']

/** 激活时才抛:这样它在 status 里是 failed、有 plugin.failed,别的插件不受影响。只有稳定代码,导入器的原话里有路径 */
const failing = (id: string, code: string): Plugin => ({
  manifest: { id, version: '0.0.0', kernel: '*' },
  async activate() {
    throw new Error(code)
  },
})

const exists = (p: string) => {
  try {
    return lstatSync(p, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false // run 不是目录:下面写标记会失败,那条路不载
  }
}

const removeMarker = (p: string, log: Log) => {
  try {
    if (exists(p)) rmSync(p, { force: true, recursive: true })
  } catch (err) {
    log.warn('dev marker not removed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
  }
}

/**
 * 正常停机:载过开发插件的这次没崩。只看路径,不要 loadDevPlugins 的结果:停机来得多早都一样。
 * 跳过的标记不动,它只认再确认和移除
 */
export function cleanStop(runDir: string, log: Log): void {
  removeMarker(join(runDir, DEV_LOADING), log)
}

async function loadOne(entry: DevEntry, importer: (url: string) => Promise<unknown>, log: Log): Promise<Plugin> {
  const copy = readOnce(entry.file, MAX_DEV_MAIN_BYTES)
  if (!copy.ok || createHash('sha256').update(copy.bytes).digest('hex') !== entry.hash) {
    log.warn('dev plugin not loaded', { id: entry.id, error: 'dev_hash_mismatch' })
    return failing(entry.id, 'dev_hash_mismatch')
  }
  let mod: { default?: { manifest?: Plugin['manifest']; activate?: unknown } }
  let def: (typeof mod)['default']
  try {
    // 载的就是刚算过哈希的这份字节,不再读盘(final review I-2)。data: URL 没有目录:
    // 裸导入不会往上找 node_modules(cwd = ~ 的会话写得到 ~/node_modules),相对导入也解析不了;node: 内置照常
    mod = (await importer(`data:text/javascript;base64,${copy.bytes.toString('base64')}`)) as typeof mod
    def = mod.default
  } catch (err) {
    log.warn('dev plugin not loaded', { id: entry.id, error: 'dev_import_failed', name: err instanceof Error ? err.name : typeof err })
    return failing(entry.id, 'dev_import_failed')
  }
  const manifest = typeof def === 'object' && def !== null ? def.manifest : undefined
  if (manifest?.id !== entry.id) {
    log.warn('dev plugin not loaded', { id: entry.id, error: 'dev_manifest_mismatch' })
    return failing(entry.id, 'dev_manifest_mismatch')
  }
  if (typeof def?.activate !== 'function') {
    log.warn('dev plugin not loaded', { id: entry.id, error: 'dev_no_activate' })
    return failing(entry.id, 'dev_no_activate')
  }
  const real = def as Plugin
  return {
    // 只查一次,之后用查过的这份
    manifest: { ...manifest, id: entry.id },
    async activate(ctx) {
      await real.activate(ctx)
      ctx.append({ type: 'plugins.dev.loaded', payload: { id: entry.id, hash: entry.hash } })
    },
  }
}

export async function loadDevPlugins(o: LoadDevOpts): Promise<DevLoad> {
  const importer = o.importer ?? ((u: string) => import(/* @vite-ignore */ u))
  const loading = join(o.runDir, DEV_LOADING)
  const crashed = join(o.runDir, DEV_CRASHED)

  const entries = readDevIndex(o.dataDir, o.log)
  if (entries.length === 0) {
    // 上次崩了,这之间已经把插件移除了:没有可跳过的
    removeMarker(loading, o.log)
    removeMarker(crashed, o.log)
    return { plugins: [] }
  }
  if (exists(loading)) {
    // 上次载了它们,没有正常停:什么时候崩的都算(启动 30 s 之后也算)。记成一直跳过
    try {
      renameSync(loading, crashed)
    } catch (err) {
      o.log.warn('dev crash not recorded', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }
  if (exists(crashed) || exists(loading)) {
    o.log.warn('dev plugins skipped: a start that loaded them did not stop cleanly')
    return { plugins: [], skipped: 'dev_crashed' }
  }
  try {
    mkdirSync(o.runDir, { recursive: true, mode: 0o700 })
    writeFileSync(loading, '', { mode: 0o600 })
  } catch (err) {
    // 没有标记就没有崩溃保护:process.exit 的插件会让熔断锁死,连 RPC 都起不来
    o.log.warn('dev plugins not loaded: marker not written', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    return { plugins: entries.map(e => failing(e.id, 'dev_guard_unavailable')) }
  }
  const plugins: Plugin[] = []
  for (const e of entries) plugins.push(await loadOne(e, importer, o.log))
  return { plugins }
}
