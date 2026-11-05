// 已装插件的记录和磁盘布局(09 spec §4、§13)。记录是 installed.json,0600,临时文件 + 改名。
// 这个文件在 = 存储是我们的,记录没提到的东西才能删(崩溃留下的)。文件读不了、坏了、被人删了而目录还在:
// 什么都不删,每次启动都报 store_recovered,只有 plugins.store.discard 能删。一个坏字节不该换来全部代码和数据。
// 存储根在沙箱写保护之下(M13),但 bwrap 上它还不存在时 cwd = ~ 的会话建得出来,所以根、.staging、<id> 都可能是
// 别人放的目录或链接:一律 lstat,不跟随。认不出来的目录不读不用,新装同 id 时才换掉
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../../kernel/log'
import { pluginStoreRootOf } from '../../lib/fs/paths'
import { USER_CONFIG_KEY_RE } from '../../lib/plugins/manifest'
import { integrityOf, walkTree } from '../../lib/plugins/tree'
import { GrantsSchema, MCP_SERVER_NAME, PLUGIN_ID, PluginConsentSchema, PluginFormatSchema, PluginSourceSchema } from '../../protocol/index'

const INTEGRITY = /^sha256:[0-9a-f]{64}$/
const VERSION_DIR_CHARS = 12
const STAGING = '.staging'

export const versionDirName = (integrity: string) => integrity.slice('sha256:'.length, 'sha256:'.length + VERSION_DIR_CHARS)

const RecordSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID),
    version: z.string(),
    format: PluginFormatSchema,
    enabled: z.boolean(),
    /** 真实来源,升级从这里取;显示用 consent.source */
    source: PluginSourceSchema,
    integrity: z.string().regex(INTEGRITY),
    commit: z.string().optional(),
    installedAt: z.number(),
    grants: GrantsSchema,
    /** 只有不敏感的值。敏感的在 secrets 里,这里只有键名 */
    settings: z.record(z.string(), z.string()),
    secretKeys: z.array(z.string().regex(USER_CONFIG_KEY_RE)),
    state: z.enum(['ok', 'integrity_failed']),
    /** 相对存储根:<id>/<完整性前 12 位>。下面的 refine 钉死它,记录被改也指不到别处 */
    dir: z.string(),
    /** 用户同意的那份。升级的差异从它算 */
    consent: PluginConsentSchema,
    /** `skill:<名>`、`command:<名>` → 正文哈希。不存的话每次升级所有技能都算"变了" */
    textHashes: z.record(z.string(), z.string()),
    /** 全部配置键。同意页的 config 可能被截,这里不截 */
    config: z.array(z.object({ key: z.string().regex(USER_CONFIG_KEY_RE), sensitive: z.boolean(), required: z.boolean() })),
    servers: z.array(z.object({ name: z.string(), configRefs: z.array(z.string()) })),
  })
  .refine(r => r.dir === `${r.id}/${versionDirName(r.integrity)}`)

export type InstalledRecord = z.infer<typeof RecordSchema>

const FileSchema = z.object({ version: z.literal(1), plugins: z.array(RecordSchema) }).refine(f => new Set(f.plugins.map(p => p.id)).size === f.plugins.length)

const lstatOf = (p: string): Stats | undefined => {
  try {
    return lstatSync(p)
  } catch {
    return undefined
  }
}

const isGitName = (name: string) => name.toLowerCase() === '.git'

/** 任何深度、任何大小写的 `.git`。遍历和完整性都跳过它,所以要单独查:存储里不该有 */
function holdsGit(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    if (isGitName(name)) return true
    const abs = join(dir, name)
    if (lstatSync(abs).isDirectory() && holdsGit(abs)) return true
  }
  return false
}

/** 这棵树就是同意的那一份。读不了、有链接、有 .git 都算不是 */
export function treeMatches(dir: string, integrity: string): boolean {
  try {
    const w = walkTree(dir)
    return w.ok && !holdsGit(dir) && integrityOf(dir, w.files) === integrity
  } catch {
    return false
  }
}

const ASIDE = '.old-'

export class PluginStore {
  readonly problems: string[] = []
  /** 文件在但读不出来:记录还在里面,不能覆盖,也不能删目录 */
  unreadable = false
  /** 文件没了而目录还在,标记又写不下去时,这一次运行还记得 */
  private foreign = false
  private readonly root: string
  private readonly dataRoot: string
  private readonly file: string
  private readonly records = new Map<string, InstalledRecord>()
  /** 根是这个进程建的或对过账的。tidy 删掉根后回到 false:再出现的就是别人放的 */
  private ownRoot = false

  private constructor(
    dataDir: string,
    private readonly log: Logger,
  ) {
    this.root = pluginStoreRootOf(dataDir)
    this.dataRoot = join(dataDir, 'plugin-data')
    this.file = join(dataDir, 'plugins', 'plugin-manager', 'installed.json')
  }

  static open(root: { dataDir: string }, log: Logger): PluginStore {
    const store = new PluginStore(root.dataDir, log)
    store.load()
    store.safeReconcile()
    store.noteProblem()
    store.tidy() // 崩在卸载最后一个插件时:空文件和目录都清完了,文件也不留
    return store
  }

  private load(): void {
    rmSync(`${this.file}.tmp`, { force: true, recursive: true })
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      // 读不了不等于坏了:权限改回来就都还在。不改名,不覆盖
      this.unreadable = true
      this.log.warn('plugin records not readable', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return this.setAside()
    }
    const result = FileSchema.safeParse(parsed)
    if (!result.success) return this.setAside()
    for (const r of result.data.plugins) this.records.set(r.id, r)
  }

  /** 失败方向是关:没有插件启用。不记原因的细节:zod 的问题和解析错误里可能带文件内容 */
  private setAside(): void {
    try {
      renameSync(this.file, `${this.file}.bad-${Date.now()}`)
      this.log.warn('plugin records corrupt, set aside')
    } catch (err) {
      this.unreadable = true
      this.log.warn('plugin records corrupt, could not set them aside', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  private badFiles(): string[] {
    const dir = dirname(this.file)
    const prefix = `${basename(this.file)}.bad-`
    try {
      return readdirSync(dir).filter(n => n.startsWith(prefix)).map(n => join(dir, n))
    } catch {
      return []
    }
  }

  private hasRecordsFile(): boolean {
    return lstatOf(this.file) !== undefined
  }

  /** 真目录,暂存不算。根和数据根里的 */
  private pluginDirCount(): number {
    const count = (top: string, skip?: string) => {
      if (!this.isDir(top)) return 0
      return readdirSync(top).filter(n => n !== skip && this.isDir(join(top, n))).length
    }
    return count(this.root, STAGING) + count(this.dataRoot)
  }

  /** 这次不能删认不出来的目录:记录读不了、放到了一边,或者文件没了而目录还在(后者留个标记,之后写了新文件也还算) */
  private keepUnknown(): boolean {
    if (this.unreadable || this.foreign || this.badFiles().length > 0) return true
    if (this.records.size > 0 || this.hasRecordsFile()) return false
    const count = this.pluginDirCount()
    if (count === 0) return false
    this.foreign = true
    this.log.warn('plugin records missing, keeping directories', { count })
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.file}.bad-${Date.now()}`, JSON.stringify({ missing: true }), { mode: 0o600 })
    } catch (err) {
      this.log.warn('plugin records marker not written', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
    return true
  }

  private noteProblem(): void {
    const on = this.unreadable || this.foreign || this.badFiles().length > 0
    this.problems.length = 0
    if (on) this.problems.push('store_recovered')
  }

  /** 读不了目录也不能让管理者起不来:RPC 还要答,启用的那些之后过完整性检查 */
  private safeReconcile(force = false): void {
    try {
      this.reconcile(force)
    } catch (err) {
      this.log.warn('plugin store not reconciled', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  private drop(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true }) // 链接删的是链接
    } catch (err) {
      this.log.warn('plugin store cleanup failed', { code: (err as NodeJS.ErrnoException).code })
    }
  }

  private isDir(path: string): boolean {
    return lstatOf(path)?.isDirectory() === true
  }

  private removeEmpty(path: string): void {
    try {
      rmdirSync(path)
    } catch {
      /* 不空或不在 */
    }
  }

  /**
   * 记录不认识的都删;keepUnknown 时只删暂存、链接和文件,以及已记录插件自己多出来的版本。force 只给 discard。
   * 只记数量:目录名是第三方文字
   */
  private reconcile(force: boolean): void {
    let removed = 0
    const remove = (path: string) => {
      this.drop(path)
      removed++
    }
    const st = lstatOf(this.root)
    if (st && !st.isDirectory()) remove(this.root)
    const data = lstatOf(this.dataRoot)
    if (data && !data.isDirectory()) remove(this.dataRoot)
    const keep = !force && this.keepUnknown()
    if (st?.isDirectory()) {
      for (const name of readdirSync(this.root)) {
        const abs = join(this.root, name)
        if (name === STAGING) this.drop(abs) // 暂存不算数,也从来不是谁的数据
        else if (this.records.has(name)) removed += this.reconcileId(name, abs)
        else if (!keep || !this.isDir(abs)) remove(abs)
      }
      this.removeEmpty(this.root)
    }
    if (data?.isDirectory()) {
      for (const name of readdirSync(this.dataRoot)) {
        const abs = join(this.dataRoot, name)
        if (!this.isDir(abs) || (!keep && !this.records.has(name))) remove(abs)
      }
      this.removeEmpty(this.dataRoot)
    }
    if (removed > 0) this.log.info('plugin store reconciled', { removed })
  }

  private reconcileId(name: string, abs: string): number {
    const rec = this.records.get(name)!
    if (!this.isDir(abs)) {
      this.drop(abs)
      return 1
    }
    const keep = versionDirName(rec.integrity)
    const current = join(abs, keep)
    // 同内容重装时崩在两次改名之间:放到一边的就是记录说的那份
    if (!this.isDir(current)) {
      const aside = readdirSync(abs).find(v => v.startsWith(`${keep}${ASIDE}`) && this.isDir(join(abs, v)))
      if (aside) renameSync(join(abs, aside), current)
    }
    let removed = 0
    for (const v of readdirSync(abs)) {
      if (v !== keep || !this.isDir(join(abs, v))) {
        this.drop(join(abs, v))
        removed++
      }
    }
    return removed
  }

  /** 要往存储里放东西之前调。根和 .staging 是真目录;第一次见到的根先对账,别人放的进不来 */
  ensure(): void {
    if (!this.ownRoot) {
      this.safeReconcile()
      this.noteProblem()
    }
    if (lstatOf(this.root)?.isDirectory() !== true) this.drop(this.root)
    mkdirSync(this.root, { recursive: true, mode: 0o755 })
    this.ownRoot = true
    const staging = join(this.root, STAGING)
    if (lstatOf(staging)?.isDirectory() !== true) this.drop(staging)
    mkdirSync(staging, { recursive: true, mode: 0o700 })
  }

  /** 放好 <id> 这一层:根或 <id> 是别人放的链接或文件就换掉 */
  ensureCodeDir(id: string): void {
    if (lstatOf(this.root)?.isDirectory() !== true) this.drop(this.root)
    mkdirSync(this.root, { recursive: true, mode: 0o755 })
    const dir = this.codeDir(id)
    if (!this.isDir(dir)) this.drop(dir)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
  }

  /**
   * top/<segs...> 删掉,从不穿过链接:rmSync 不跟随最后一段,但会跟随路径中间的。
   * 路上哪一层不是真目录,就只摘掉那一层。不抛错:删不掉的,对账下次再来
   */
  private removeUnder(top: string, ...segs: string[]): void {
    let cur = top
    for (const seg of segs) {
      const st = lstatOf(cur)
      if (!st) return
      if (!st.isDirectory()) {
        this.drop(cur)
        return
      }
      cur = join(cur, seg)
    }
    this.drop(cur)
  }

  /** 这个插件的代码和数据 */
  removeFiles(id: string): void {
    this.removeCode(id)
    this.removeData(id)
  }

  removeCode(id: string): void {
    if (PLUGIN_ID.test(id)) this.removeUnder(this.root, id)
  }

  removeData(id: string): void {
    if (PLUGIN_ID.test(id)) this.removeUnder(this.dataRoot, id)
  }

  removeVersion(rec: Pick<InstalledRecord, 'id' | 'integrity'>): void {
    this.removeUnder(this.root, rec.id, versionDirName(rec.integrity))
  }

  removeStaging(stagingId: string, sub?: string): void {
    this.removeUnder(this.root, STAGING, ...(sub === undefined ? [stagingId] : [stagingId, sub]))
  }

  /** 同内容重装:旧目录改名放一边,新的出问题还能放回去。放不回去的由对账处理 */
  moveAside(rec: Pick<InstalledRecord, 'id' | 'integrity'>): string | undefined {
    const current = this.versionDir(rec)
    if (!lstatOf(current)) return undefined
    const name = `${versionDirName(rec.integrity)}${ASIDE}${Date.now()}`
    renameSync(current, join(this.codeDir(rec.id), name))
    return name
  }

  restoreAside(rec: Pick<InstalledRecord, 'id' | 'integrity'>, name: string): void {
    try {
      renameSync(join(this.codeDir(rec.id), name), this.versionDir(rec))
    } catch (err) {
      this.log.warn('plugin code not restored', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
  }

  removeAside(id: string, name: string): void {
    this.removeUnder(this.root, id, name)
  }

  /** 空的层级不留:没有插件时,这些目录和记录文件都不该存在 */
  tidy(): void {
    this.removeEmpty(join(this.root, STAGING))
    this.removeEmpty(this.root)
    if (!lstatOf(this.root)) this.ownRoot = false
    this.removeEmpty(this.dataRoot)
    if (this.records.size === 0 && !this.unreadable && !lstatOf(this.root) && !lstatOf(this.dataRoot)) rmSync(this.file, { force: true })
  }

  /** 放到一边的记录里列的 secret 键,跳过现在装着的插件。那个文件校验没过,所以逐条查形状 */
  badSecrets(): { id: string; key: string }[] {
    const out: { id: string; key: string }[] = []
    for (const f of this.badFiles()) {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(f, 'utf8'))
      } catch {
        continue
      }
      const plugins = (parsed as { plugins?: unknown } | null)?.plugins
      if (!Array.isArray(plugins)) continue
      for (const p of plugins as { id?: unknown; secretKeys?: unknown }[]) {
        if (typeof p?.id !== 'string' || !PLUGIN_ID.test(p.id) || this.records.has(p.id) || !Array.isArray(p.secretKeys)) continue
        for (const key of p.secretKeys) if (typeof key === 'string' && USER_CONFIG_KEY_RE.test(key)) out.push({ id: p.id, key })
      }
    }
    return out
  }

  /** 用户明确说不要了:认不出来的目录删掉,标记最后删,中途失败还能重试 */
  discardUnknown(): void {
    this.safeReconcile(true)
    for (const f of this.badFiles()) rmSync(f, { force: true })
    this.foreign = false
    this.noteProblem()
    this.tidy()
  }

  list(): InstalledRecord[] {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  get(id: string): InstalledRecord | undefined {
    return this.records.get(id)
  }

  put(record: InstalledRecord): void {
    this.records.set(record.id, record)
  }

  remove(id: string): void {
    this.records.delete(id)
  }

  /** 第一次往存储里落代码之前调:崩在中间时,文件在就说明留下的东西是我们的 */
  claim(): void {
    if (!this.hasRecordsFile()) this.save()
  }

  /** 临时文件 + 改名,0600。抛错时旧文件不动。读不了的旧文件不覆盖。没有插件时的空文件由 tidy 收走 */
  save(): void {
    if (this.unreadable) throw new Error('plugin records not readable')
    const tmp = `${this.file}.tmp`
    try {
      mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
      const fd = openSync(tmp, 'w', 0o600)
      try {
        fchmodSync(fd, 0o600)
        writeSync(fd, JSON.stringify({ version: 1, plugins: this.list() }))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true, recursive: true })
      throw err
    }
  }

  codeDir(id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error('bad plugin id')
    return join(this.root, id)
  }

  /** 这个记录的代码目录 */
  versionDir(rec: Pick<InstalledRecord, 'id' | 'integrity'>): string {
    return join(this.codeDir(rec.id), versionDirName(rec.integrity))
  }

  stagingDir(stagingId: string): string {
    return join(this.root, STAGING, stagingId)
  }

  pluginDataRoot(id: string): string {
    if (!PLUGIN_ID.test(id)) throw new Error('bad plugin id')
    return join(this.dataRoot, id)
  }

  /** 按服务分(M17)。读取时已拒大小写相撞的名字,这里再比一次:不分大小写的卷上,两个名字就是一个目录 */
  dataDirOf(id: string, server: string): string {
    if (!MCP_SERVER_NAME.test(server) || server === '.' || server === '..') throw new Error('bad server name')
    const dir = this.pluginDataRoot(id)
    const folded = server.toLowerCase()
    for (const s of this.records.get(id)?.servers ?? []) if (s.name !== server && s.name.toLowerCase() === folded) throw new Error('server names collide')
    return join(dir, server)
  }

  /** 磁盘上的代码还是同意的那一份。每一层都不能是链接 */
  verify(rec: Pick<InstalledRecord, 'id' | 'integrity'>): boolean {
    try {
      const dir = this.versionDir(rec)
      if (!this.isDir(this.root) || !this.isDir(this.codeDir(rec.id)) || !this.isDir(dir)) return false
      return treeMatches(dir, rec.integrity)
    } catch {
      return false
    }
  }
}
