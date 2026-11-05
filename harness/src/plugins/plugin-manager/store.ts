// 已装插件的记录和磁盘布局(09 spec §4、§13)。记录是 installed.json,0600,临时文件 + 改名;没有插件时这个文件不存在。
// 磁盘听记录的:打开时、第一次用之前对账,记录不认识的都删。存储根在沙箱写保护之下(M13),但 bwrap 上它还不存在时
// cwd = ~ 的会话建得出来,所以根、.staging、<id> 都可能是别人放的目录或链接,一律 lstat,不跟随
import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeSync, type Stats } from 'node:fs'
import { join } from 'node:path'
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

export class PluginStore {
  readonly problems: string[] = []
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
    const recovered = store.load()
    try {
      store.reconcile(recovered)
    } catch (err) {
      // 读不了目录也不能让管理者起不来:RPC 还要答,启用的那些下面会过完整性检查
      log.warn('plugin store not reconciled', { code: (err as NodeJS.ErrnoException).code ?? 'unknown' })
    }
    // 这次留下的代码和数据不算别人放的:ensure 不再对账,否则第一次安装就把它们删了
    store.ownRoot = recovered
    return store
  }

  /** @returns 文件坏了、刚放到一边 */
  private load(): boolean {
    rmSync(`${this.file}.tmp`, { force: true, recursive: true })
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      return this.recover()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return this.recover()
    }
    const result = FileSchema.safeParse(parsed)
    if (!result.success) return this.recover()
    for (const r of result.data.plugins) this.records.set(r.id, r)
    return false
  }

  /** 失败方向是关:没有插件启用。不记原因的细节:zod 的问题和解析错误里可能带文件内容 */
  private recover(): true {
    try {
      renameSync(this.file, `${this.file}.bad-${Date.now()}`)
      this.log.warn('plugin records unreadable, starting empty')
    } catch (err) {
      this.log.warn('plugin records unreadable, could not set them aside', { code: (err as NodeJS.ErrnoException).code })
    }
    this.problems.push('store_recovered')
    return true
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
   * 记录不认识的都删。没有存储根时只多两次 lstat。
   * keepUnknown:这次是记录坏了,认不出来不等于不要:只清暂存区,代码和数据留到下一次干净的打开
   */
  private reconcile(keepUnknown = false): void {
    const st = lstatOf(this.root)
    if (st && !st.isDirectory()) this.drop(this.root)
    else if (st) {
      for (const name of readdirSync(this.root)) {
        const abs = join(this.root, name)
        if (name === STAGING) this.drop(abs)
        else if (!keepUnknown) this.reconcileId(name, abs)
      }
      this.removeEmpty(this.root)
    }
    const data = lstatOf(this.dataRoot)
    if (data && !data.isDirectory()) this.drop(this.dataRoot)
    else if (data && !keepUnknown) {
      for (const name of readdirSync(this.dataRoot)) if (!this.records.has(name)) this.drop(join(this.dataRoot, name))
      this.removeEmpty(this.dataRoot)
    }
  }

  private reconcileId(name: string, abs: string): void {
    const rec = this.records.get(name)
    if (!rec || !this.isDir(abs)) {
      this.drop(abs)
      return
    }
    const keep = versionDirName(rec.integrity)
    for (const v of readdirSync(abs)) if (v !== keep || !this.isDir(join(abs, v))) this.drop(join(abs, v))
  }

  /** 要往存储里放东西之前调。根和 .staging 是真目录;第一次见到的根先对账,别人放的进不来 */
  ensure(): void {
    if (!this.ownRoot) this.reconcile()
    if (lstatOf(this.root)?.isDirectory() !== true) this.drop(this.root)
    mkdirSync(this.root, { recursive: true, mode: 0o755 })
    this.ownRoot = true
    const staging = join(this.root, STAGING)
    if (lstatOf(staging)?.isDirectory() !== true) this.drop(staging)
    mkdirSync(staging, { recursive: true, mode: 0o700 })
  }

  /** 放好 <id> 这一层:是别人放的链接或文件就换掉 */
  ensureCodeDir(id: string): void {
    const dir = this.codeDir(id)
    if (!this.isDir(dir)) this.drop(dir)
    mkdirSync(dir, { recursive: true, mode: 0o755 })
  }

  /** 空的层级不留:没有插件时,这些目录就不该存在 */
  tidy(): void {
    this.removeEmpty(join(this.root, STAGING))
    this.removeEmpty(this.root)
    if (!lstatOf(this.root)) this.ownRoot = false
    this.removeEmpty(this.dataRoot)
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

  /** 临时文件 + 改名,0600。没有插件就没有文件。抛错时旧文件不动 */
  save(): void {
    if (this.records.size === 0) {
      rmSync(this.file, { force: true })
      return
    }
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
      const w = walkTree(dir)
      return w.ok && integrityOf(dir, w.files) === rec.integrity
    } catch {
      return false
    }
  }
}
