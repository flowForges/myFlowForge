// 暂存、同意、落盘(09 spec §6)。prepare 立刻返回,活在后台:不赌客户端 5 s 的超时。里面的东西一个都不执行:
// 本地来源是普通拷贝,不调 git;git 来源只跑 fetchGit。readPlugin 只读文本和 JSON
import type { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import { HARNESS_VERSION } from '../../kernel/version'
import { isInside, pluginStoreRootOf } from '../../lib/fs/paths'
import type { PgidRegistry } from '../../lib/proc/pgids'
import { buildConsent, consentHash, effectiveGrants, intersectOnUpgrade, type Declared, type Effective } from '../../lib/plugins/consent'
import { checkGitUrl, checkRef, fetchGit, normalizeSubpath, type FetchTimers } from '../../lib/plugins/fetchGit'
import { readPlugin } from '../../lib/plugins/read'
import { integrityOf, TreeError, walkTree, copyTree } from '../../lib/plugins/tree'
import type { ParsedPlugin, Warning } from '../../lib/plugins/types'
import type { SessionCommands } from '../../lib/tools/types'
import type { Grants, KernelEvent, PluginConsent, PluginSource, PluginSourceParam, WorkerResult } from '../../protocol/index'
import { versionDirName, type InstalledRecord, type PluginStore } from './store'

const INVALID_PARAMS = -32602
const STAGING_TTL_MS = 60 * 60 * 1000
const MAX_STAGINGS = 3
/** 失败的只留状态,不占磁盘;status 还要答得上来 */
const MAX_TOMBSTONES = 32
/** 关闭时等拉取收尾的上限。git 已被 SIGKILL,不该等到这么久 */
const CLOSE_WAIT_MS = 2000

export const fail = (code: string) => new RpcError(INVALID_PARAMS, code)

type Resolved = { kind: 'path'; path: string } | { kind: 'git'; url: string; ref?: string; subpath?: string }

interface Ready {
  id: string
  version: string
  format: ParsedPlugin['format']
  consent: PluginConsent
  hash: string
  integrity: string
  source: PluginSource
  commit?: string
  /** 算差异时已装版本的完整性;没有已装版本是 null */
  against: string | null
  declared: Record<string, Declared | null>
  textHashes: Record<string, string>
  config: InstalledRecord['config']
  servers: InstalledRecord['servers']
}

interface Job {
  id: string
  source: Resolved
  /** plugins.upgrade.prepare 的目标 */
  upgradeOf?: string
  state: 'fetching' | 'ready' | 'failed'
  error?: string
  /** 违规的相对路径:第三方文字,只进 status,不进事件和日志 */
  path?: string
  createdAt: number
  ready?: Ready
  groups: Set<number>
  done?: Promise<void>
  /** confirm 已经过了检查,在落盘:到期扫描不能再动它 */
  landing?: boolean
}

export interface InstallerDeps {
  store: PluginStore
  commands: Pick<SessionCommands, 'validateCwd'>
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  log: Logger
  dataDir: string
  home: string
  env: NodeJS.ProcessEnv
  now(): number
  timers: FetchTimers
  reservedIds(): Set<string>
  killPluginProcesses(id: string): Promise<void>
  pgids?: Pick<PgidRegistry, 'add' | 'settle'>
  spawn?: typeof nodeSpawn
  sizeOf?: (dir: string) => number
  allowFileProtocol?: boolean
}

const sourceKey = (s: PluginSource) => JSON.stringify(s.kind === 'path' ? ['path', s.path] : ['git', s.url, s.subpath ?? null])

const killGroup = (pgid: number) => {
  if (pgid <= 1) return
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    /* 已经没了 */
  }
}

const realOr = (p: string) => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

function nameHintOf(s: Resolved): string {
  if (s.kind === 'path') return basename(s.path)
  if (s.subpath !== undefined) return basename(s.subpath)
  let last = ''
  try {
    last = basename(new URL(s.url).pathname)
  } catch {
    /* 形状已查过 */
  }
  return last.replace(/\.git$/i, '') || 'plugin'
}

export class Installer {
  private readonly jobs = new Map<string, Job>()
  private closed = false
  private expiry: unknown

  constructor(private readonly d: InstallerDeps) {}

  private emit(e: Omit<KernelEvent, 'seq' | 'ts'>): void {
    if (!this.closed) this.d.append(e)
  }

  private setState(job: Job): void {
    this.emit({ type: 'plugins.install.state', payload: { stagingId: job.id, state: job.state, ...(job.error !== undefined && { error: job.error }) } })
  }

  private clean(job: Job): void {
    try {
      rmSync(this.d.store.stagingDir(job.id), { recursive: true, force: true })
    } catch (err) {
      this.d.log.warn('staging cleanup failed', { code: (err as NodeJS.ErrnoException).code })
    }
    this.d.store.tidy()
  }

  /** 进入失败态:磁盘不留,进程不留,状态留给 status */
  private toFailed(job: Job, error: string, path?: string): void {
    job.state = 'failed'
    job.error = error
    if (path !== undefined) job.path = path
    job.ready = undefined
    for (const pgid of job.groups) killGroup(pgid)
    this.clean(job)
    this.setState(job)
    this.prune()
  }

  private prune(): void {
    const dead = [...this.jobs.values()].filter(j => j.state === 'failed')
    for (const j of dead.slice(0, Math.max(0, dead.length - MAX_TOMBSTONES))) this.jobs.delete(j.id)
  }

  private sweep(): void {
    const now = this.d.now()
    for (const job of this.jobs.values()) if (job.state !== 'failed' && !job.landing && now - job.createdAt >= STAGING_TTL_MS) this.toFailed(job, 'expired')
    this.arm()
  }

  /** 下一个到期的暂存:没人再问,也要清掉磁盘 */
  private arm(): void {
    this.d.timers.clearTimeout(this.expiry)
    this.expiry = undefined
    const live = [...this.jobs.values()].filter(j => j.state !== 'failed')
    if (live.length === 0 || this.closed) return
    const next = Math.min(...live.map(j => j.createdAt + STAGING_TTL_MS))
    this.expiry = this.d.timers.setTimeout(() => this.sweep(), Math.max(0, next - this.d.now()))
  }

  /** 拉取之前的全部检查:拒绝时一个进程都不起,一个字节都不写 */
  private resolve(source: PluginSourceParam): Resolved {
    if (source.kind === 'git') {
      if (!checkGitUrl(source.url, { allowFileProtocol: this.d.allowFileProtocol === true }).ok) throw fail('bad_url')
      if (source.ref !== undefined && !checkRef(source.ref)) throw fail('bad_ref')
      const subpath = source.subpath === undefined ? undefined : normalizeSubpath(source.subpath)
      if (source.subpath !== undefined && subpath === undefined) throw fail('bad_path')
      return { kind: 'git', url: source.url, ...(source.ref !== undefined && { ref: source.ref }), ...(subpath !== undefined && { subpath }) }
    }
    let real: string
    try {
      real = this.d.commands.validateCwd(source.path)
    } catch {
      throw fail('path_refused')
    }
    // validateCwd 只拒黑名单和它们里面。包住家目录或数据目录的来源,拷进来的就是凭据,自己的存储也在里面
    const tops = [this.d.home, this.d.dataDir, pluginStoreRootOf(this.d.dataDir)]
    for (const top of tops) for (const t of new Set([top, realOr(top)])) if (isInside(t, real, process.platform)) throw fail('path_refused')
    return { kind: 'path', path: real }
  }

  private start(source: Resolved, upgradeOf?: string): { stagingId: string } {
    this.sweep()
    if ([...this.jobs.values()].filter(j => j.state !== 'failed').length >= MAX_STAGINGS) throw fail('too_many_stagings')
    const job: Job = { id: `st_${randomBytes(12).toString('hex')}`, source, state: 'fetching', createdAt: this.d.now(), groups: new Set(), ...(upgradeOf !== undefined && { upgradeOf }) }
    this.jobs.set(job.id, job)
    this.setState(job)
    this.arm()
    job.done = this.stage(job).catch(err => {
      // stage 不抛;到这里是写事件失败之类
      this.d.log.error('staging crashed', { code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' })
    })
    return { stagingId: job.id }
  }

  prepare(source: PluginSourceParam): { stagingId: string } {
    return this.start(this.resolve(source))
  }

  /** 和安装同一条路,再带差异。来源是记录里的那个,照样再查一遍 */
  prepareUpgrade(id: string, ref?: string): { stagingId: string } {
    const rec = this.d.store.get(id)
    if (!rec) throw fail('plugin_not_installed')
    if (rec.source.kind === 'path') {
      if (ref !== undefined) throw fail('bad_ref')
      return this.start(this.resolve({ kind: 'path', path: rec.source.path }), id)
    }
    const { url, subpath } = rec.source
    const useRef = ref ?? rec.source.ref
    return this.start(this.resolve({ kind: 'git', url, ...(useRef !== undefined && { ref: useRef }), ...(subpath !== undefined && { subpath }) }), id)
  }

  private async stage(job: Job): Promise<void> {
    // prepare 的回答先走:拷贝和哈希是同步的
    await new Promise(res => setImmediate(res))
    if (job.state !== 'fetching') return
    try {
      await this.fill(job)
    } catch (err) {
      if (job.state !== 'fetching') {
        this.clean(job) // 取消时暂存被删,fetchGit 写不下去抛错:它建的目录还要清一次
        return
      }
      // copyTree 的 ENOSPC、EACCES 带暂存区的绝对路径:消息不外传,日志也只记代码
      if (err instanceof TreeError) this.toFailed(job, err.code, err.path)
      else {
        this.d.log.warn('staging failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
        this.toFailed(job, 'store_error')
      }
    }
  }

  private async fill(job: Job): Promise<void> {
    const { store } = this.d
    store.ensure()
    const dir = store.stagingDir(job.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tree = join(dir, 'tree')
    let commit: string | undefined
    const extra: Warning[] = []
    if (job.source.kind === 'path') {
      copyTree(job.source.path, tree)
      extra.push('unpinned_source')
    } else {
      const r = await fetchGit({
        url: job.source.url,
        ...(job.source.ref !== undefined && { ref: job.source.ref }),
        ...(job.source.subpath !== undefined && { subpath: job.source.subpath }),
        into: tree,
        tmpHome: join(dir, 'home'),
        baseEnv: this.d.env,
        timers: this.d.timers,
        onGroup: (pgid, ended) => this.onGroup(job, pgid, ended),
        ...(this.d.spawn && { spawn: this.d.spawn }),
        ...(this.d.sizeOf && { sizeOf: this.d.sizeOf }),
        ...(this.d.allowFileProtocol === true && { allowFileProtocol: true }),
      })
      // 取消也让 git 失败,报的是 network:这时候状态已经是 cancelled,不再改
      if (job.state !== 'fetching') {
        this.clean(job)
        return
      }
      if (!r.ok) return this.toFailed(job, r.error, r.path)
      commit = r.commit
      extra.push(...r.warnings)
      rmSync(join(dir, 'home'), { recursive: true, force: true })
    }

    const walked = walkTree(tree)
    if (!walked.ok) return this.toFailed(job, walked.error, walked.path)
    // 只哈希暂存的这一份。之后落盘的也是这一份,confirm 时再算一遍
    const integrity = integrityOf(tree, walked.files)
    const read = readPlugin(tree, { nameHint: nameHintOf(job.source), reservedIds: this.d.reservedIds(), kernelVersion: HARNESS_VERSION, home: this.d.home })
    if (!read.ok) return this.toFailed(job, read.error)
    const plugin = read.plugin
    plugin.warnings = [...new Set([...plugin.warnings, ...extra])]

    const source: PluginSource = job.source.kind === 'path' ? { kind: 'path', path: job.source.path } : { kind: 'git', url: job.source.url, ...(job.source.ref !== undefined && { ref: job.source.ref }), commit: commit!, ...(job.source.subpath !== undefined && { subpath: job.source.subpath }) }
    // 换了 id 的升级不算差异:confirm 回 id_changed
    const prior = job.upgradeOf !== undefined && job.upgradeOf !== plugin.id ? undefined : store.get(plugin.id)
    // 同意页说的是"落地了什么",不是"仓库里有什么":大小写相撞的一对、非 UTF-8 的文件名可能在检出时少一个文件,
    // fetchGit 仍回 ok。commit 不保证每个 blob 都落了地,完整性和这份同意页只覆盖落地的这些
    const built = buildConsent(plugin, { source, integrity, files: walked.files.length, bytes: walked.bytes, ...(commit !== undefined && { commit }) }, prior && { consent: prior.consent, textHashes: new Map(Object.entries(prior.textHashes)) })
    if (!built.ok) return this.toFailed(job, built.error)
    // 差异比的是显示的文字,而显示的地址可能被打码:两个不同的来源都显示成 ***。这里比真实的,算哈希之前改
    if (prior && built.consent.diff && !built.consent.diff.sourceChanged && sourceKey(prior.source) !== sourceKey(source)) {
      built.consent.diff.sourceChanged = true
      built.consent.warnings = [...new Set([...built.consent.warnings, 'source_changed' as const])].sort()
    }

    job.ready = {
      id: plugin.id,
      version: built.consent.version,
      format: plugin.format,
      consent: built.consent,
      hash: consentHash(built.consent),
      integrity,
      source,
      ...(commit !== undefined && { commit }),
      against: store.get(plugin.id)?.integrity ?? null,
      declared: Object.fromEntries(plugin.servers.map(s => [s.name, s.declared])),
      textHashes: Object.fromEntries([...plugin.skills.map(x => [`skill:${x.name}`, x.bodyHash]), ...plugin.commands.map(x => [`command:${x.name}`, x.bodyHash])]),
      config: plugin.config.map(c => ({ key: c.key, sensitive: c.sensitive, required: c.required })),
      servers: plugin.servers.map(s => ({ name: s.name, configRefs: s.configRefs })),
    }
    job.state = 'ready'
    this.setState(job)
  }

  private onGroup(job: Job, pgid: number, ended: boolean): void {
    if (ended) {
      job.groups.delete(pgid)
      this.d.pgids?.settle(pgid)
      return
    }
    job.groups.add(pgid)
    this.d.pgids?.add(pgid)
    // 取消落在两条 git 之间:fetchGit 没有取消参数,下一条起来就杀
    if (job.state !== 'fetching') killGroup(pgid)
  }

  status(stagingId: string): WorkerResult<'plugins.install.status'> {
    this.sweep()
    const job = this.jobs.get(stagingId)
    if (!job) throw fail('staging_not_found')
    return {
      state: job.state,
      ...(job.error !== undefined && { error: job.error }),
      ...(job.path !== undefined && { path: job.path }),
      ...(job.ready && { consent: job.ready.consent, consentHash: job.ready.hash }),
    }
  }

  cancel(stagingId: string): { ok: boolean } {
    const job = this.jobs.get(stagingId)
    if (job && job.state !== 'failed') this.toFailed(job, 'cancelled')
    this.arm()
    return { ok: true }
  }

  /** 串行:由 index 的队列保证,所以这里没有并发的 confirm */
  async confirm(p: { stagingId: string; consentHash: string; grants: Grants; enable: boolean }): Promise<{ ok: boolean; id: string }> {
    this.sweep()
    const job = this.jobs.get(p.stagingId)
    const ready = job?.ready
    if (!job || job.state !== 'ready' || !ready) throw fail('consent_stale')
    // 内容变了只能重来,所以这几种都丢掉暂存
    const refuse = (code: string) => {
      this.toFailed(job, code)
      return fail(code)
    }
    const { store } = this.d
    if (p.consentHash !== ready.hash) throw refuse('consent_stale')
    store.ensure() // 根或 .staging 被换成链接:这里删掉链接,下面就走不到别处的那棵树
    const tree = join(store.stagingDir(job.id), 'tree')
    // consentHash 里取不出完整性(M11):比内存里的哈希,再比重算的完整性
    let integrity: string | undefined
    try {
      const walked = walkTree(tree)
      if (walked.ok) integrity = integrityOf(tree, walked.files)
    } catch {
      /* 换进了链接之类:和不一样同样处理 */
    }
    if (integrity !== ready.integrity) throw refuse('consent_stale')
    if (job.upgradeOf !== undefined && job.upgradeOf !== ready.id) throw refuse('id_changed')
    const prev = store.get(ready.id)
    if ((prev?.integrity ?? null) !== ready.against) throw refuse('consent_stale')

    const given = effectiveGrants(ready.declared, p.grants)
    if (!given.ok) throw fail(given.error) // 暂存没问题,改了 grants 还能确认
    const grants = prev ? mergeGrants(intersectOnUpgrade(prev.grants, ready.declared), given.grants, p.grants) : given.grants

    const record: InstalledRecord = {
      id: ready.id,
      version: ready.version,
      format: ready.format,
      enabled: p.enable,
      source: ready.source,
      integrity: ready.integrity,
      ...(ready.commit !== undefined && { commit: ready.commit }),
      installedAt: this.d.now(),
      grants,
      settings: prev?.settings ?? {},
      secretKeys: prev?.secretKeys ?? [],
      state: 'ok',
      dir: `${ready.id}/${versionDirName(ready.integrity)}`,
      consent: ready.consent,
      textHashes: ready.textHashes,
      config: ready.config,
      servers: ready.servers,
    }
    job.landing = true
    await this.land(job, tree, record, prev)

    const sourceKind = ready.source.kind
    const payload = { id: record.id, version: record.version, integrity: record.integrity, format: record.format, sourceKind }
    this.emit({ type: prev ? 'plugins.upgraded' : 'plugins.installed', payload })
    if (record.enabled && !prev?.enabled) this.emit({ type: 'plugins.enabled', payload: { id: record.id } })
    if (!record.enabled && prev?.enabled) this.emit({ type: 'plugins.disabled', payload: { id: record.id } })

    this.jobs.delete(job.id)
    this.clean(job)
    this.arm()
    return { ok: true, id: record.id }
  }

  /** 新目录 → 记录 → 杀旧进程 → 删旧目录(§6.4)。崩在中间的由打开时对账收拾 */
  private async land(job: Job, tree: string, record: InstalledRecord, prev: InstalledRecord | undefined): Promise<void> {
    const { store } = this.d
    const target = store.versionDir(record)
    const inPlace = prev !== undefined && versionDirName(prev.integrity) === versionDirName(record.integrity)
    if (inPlace) await this.kill(record.id) // 同一个目录要换掉:先停
    try {
      store.ensureCodeDir(record.id)
      rmSync(target, { recursive: true, force: true }) // 别人放的,或完全相同的旧版
      if (!prev) rmSync(store.pluginDataRoot(record.id), { recursive: true, force: true }) // 记录坏过时留下的:新装的不继承
      renameSync(tree, target)
      store.put(record)
      store.save()
    } catch (err) {
      this.d.log.warn('plugin install failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      if (prev) store.put(prev)
      else store.remove(record.id)
      if (!inPlace) rmSync(target, { recursive: true, force: true })
      if (!prev) rmSync(store.codeDir(record.id), { recursive: true, force: true })
      this.toFailed(job, 'store_error')
      throw fail('store_error')
    }
    if (prev && !inPlace) {
      await this.kill(record.id)
      rmSync(store.versionDir(prev), { recursive: true, force: true })
    }
  }

  private async kill(id: string): Promise<void> {
    try {
      await this.d.killPluginProcesses(id)
    } catch (err) {
      this.d.log.warn('killing plugin processes failed', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  /** kernel.close:杀掉拉取,不留暂存。之后不再写事件 */
  async close(): Promise<void> {
    this.closed = true
    this.d.timers.clearTimeout(this.expiry)
    const pending: Promise<void>[] = []
    for (const job of this.jobs.values()) {
      if (job.state === 'fetching') {
        job.state = 'failed'
        job.error = 'cancelled'
        for (const pgid of job.groups) killGroup(pgid)
      }
      if (job.done) pending.push(job.done)
    }
    let timer: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(pending), new Promise<void>(res => { timer = setTimeout(res, CLOSE_WAIT_MS) })])
    clearTimeout(timer)
    for (const job of this.jobs.values()) this.clean(job)
    this.jobs.clear()
  }
}

/** 升级后的授权:旧授权 ∩ 新声明;用户这次勾了的服务,以用户这次勾的为准(已经对新声明查过) */
function mergeGrants(kept: Effective, given: Effective, raw: Grants): Effective {
  const servers: Effective['servers'] = { ...kept.servers }
  for (const name of Object.keys(raw.servers)) if (Object.hasOwn(given.servers, name)) servers[name] = given.servers[name]
  return { servers }
}
