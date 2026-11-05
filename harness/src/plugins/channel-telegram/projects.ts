// 项目别名 → worktree(07 spec §8.1)。cwd 只能从 app 配的别名来;worktree 的记录在 state.json,磁盘上的以启动时对账为准。
// 这里只碰 IM 根下面的两层目录和这些 worktree 自己的 git 条目、快照引用。用户的 worktree 不碰,所以不跑 git worktree prune
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod'
import type { Logger } from '../../kernel/log'
import { RpcError } from '../../kernel/rpcError'
import type { Sessions } from '../../kernel/sessions'
import { lexists } from '../../lib/fs/safeFs'
import { createImWorktree, imWorktreeRootOf, removeImWorktree, type ImWorktreeError } from '../../lib/git/imWorktree'
import { pinIntact, pinRepo, pruneRefs, refBase, type Git, type RepoPin } from '../../lib/git/snapshot'
import { worktreePin } from '../../lib/git/worktree'
import { denyReadCopies, treePolicy } from '../../lib/tools/treePolicy'
import type { SandboxService, SessionCommands } from '../../lib/tools/types'
import { ERR_BUSY, type ApprovalMode, type KernelEvent, type TelegramChats } from '../../protocol/index'
import type { TelegramConfig } from '../../protocol/rpc'
import type { Chats, NewSessionResult, SessionTarget } from './chats'
import { codeOf } from './poller'
import type { TelegramState } from './state'

const WorktreeSchema = z.object({
  id: z.string(),
  project: z.string(),
  /** 建的时候别名指向的 realpath。别名改了指向,/new 就不再沿用 */
  projectPath: z.string(),
  path: z.string(),
  cwd: z.string(),
  sessionIds: z.array(z.string()),
  createdAt: z.number(),
})
type Worktree = z.infer<typeof WorktreeSchema>

interface Orphan {
  id: string
  path: string
  createdAt: number
}

export type OpenResult = { ok: true; sessionId: string } | { ok: false; reason: 'busy' | 'unknown' | 'no_model' | 'coding_only' | 'invalid_path' | ImWorktreeError }
export type RenewResult = { ok: true; project?: string; /** 项目已经不在配置里,回了纯对话 */ lost?: string } | Extract<NewSessionResult, { ok: false }>

const SCAN_PAGE = 5000
const FALLBACK_LINE = '这个项目的 worktree 在 app 里丢弃了,回到纯对话'

export interface ProjectsOpts {
  /** 内核的数据目录,不是插件的 */
  dataDir: string
  tmpDir: string
  home: string
  systemTmp: string
  git: Git
  state: Pick<TelegramState, 'data'>
  chats: Pick<Chats, 'isOpen' | 'newSession' | 'leave' | 'status' | 'chatUsing' | 'projectRefusal'>
  commands: Pick<SessionCommands, 'validateCwd'>
  sandbox: Pick<SandboxService, 'status' | 'execPolicy'>
  sessions: Pick<Sessions, 'get'>
  config(): TelegramConfig
  history(sessionId: string): KernelEvent[]
  /** 整个日志,按页。丢了 state.json 之后找孤儿的会话用 */
  eventsAfter(seq: number, limit: number): KernelEvent[]
  save(): boolean
  notify(chatId: string, text: string): void
  now(): number
  log: Logger
}

const groupOf = (chatId: string) => `c${createHash('sha256').update(chatId).digest('hex').slice(0, 16)}`

const hasTurn = (events: KernelEvent[]) => events.some(e => e.type === 'message.user')

/** 写了 message.user 还没有终态的轮。内核启动时已把没结束的写成 interrupted */
function hasOpenTurn(events: KernelEvent[]): boolean {
  const open = new Set<string>()
  for (const e of events) {
    const turnId = (e.payload as { turnId?: unknown } | undefined)?.turnId
    if (typeof turnId !== 'string') continue
    if (e.type === 'message.user') open.add(turnId)
    else if (e.type === 'turn.ended' || e.type === 'turn.failed') open.delete(turnId)
  }
  return open.size > 0
}

export class Projects {
  private readonly records = new Map<string, Worktree>()
  private readonly orphans = new Map<string, Orphan>()
  /** 同一时间只有一个动 worktree 的操作:命令走轮询这条路,discard 走 RPC */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly o: ProjectsOpts) {
    const { worktrees } = o.state.data
    for (const [id, raw] of Object.entries(worktrees)) {
      const parsed = WorktreeSchema.safeParse(raw)
      if (parsed.success && parsed.data.id === id) this.records.set(id, parsed.data)
      // 读不懂的记录当没有:目录在的话下面列成孤儿
      else delete worktrees[id]
    }
    mkdirSync(o.tmpDir, { recursive: true })
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  names(): string[] {
    return this.o.config().projects.map(p => p.name)
  }

  private store(w: Worktree): void {
    this.records.set(w.id, w)
    this.o.state.data.worktrees[w.id] = w
    this.orphans.delete(w.id)
  }

  private forget(id: string): void {
    this.records.delete(id)
    delete this.o.state.data.worktrees[id]
    this.orphans.delete(id)
  }

  private approvalModeOf(auto: boolean): ApprovalMode {
    return auto && this.o.sandbox.status(undefined).level === 'full' ? 'auto' : 'ask'
  }

  /**
   * 启动时按磁盘对账(§8.1):空占位删掉,不认识的列成孤儿。否则崩溃和 state.json 损坏会永久占名额。
   * 不跑 git:激活不能等它。链接和文件不算 worktree,不碰
   */
  reconcile(): void {
    const known = new Set([...this.records.values()].map(w => w.path))
    let root: string | undefined
    try {
      root = realpathSync.native(imWorktreeRootOf(this.o.dataDir))
    } catch {
      // 还没有根
    }
    if (root !== undefined) {
      for (const group of readdirSync(root, { withFileTypes: true })) {
        if (!group.isDirectory()) continue
        const dir = join(root, group.name)
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) this.reconcileEntry(join(dir, entry.name), entry.name, group.name, known)
        }
        if (readdirSync(dir).length === 0) rmdirSync(dir)
      }
    }
    // 目录被人删了的:会话的 cwd 没了,这个聊天回纯对话。记录留着,丢弃时还要清引用
    for (const w of this.records.values()) {
      if (lexists(w.path)) continue
      const chatId = this.o.chats.chatUsing(w.id)
      if (chatId !== undefined) this.o.chats.leave(chatId)
    }
  }

  private reconcileEntry(path: string, id: string, group: string, known: ReadonlySet<string>): void {
    if (readdirSync(path).length === 0) {
      rmdirSync(path)
      return
    }
    if (known.has(path)) return
    // 换过机器人后 update_id 可能撞:不同聊天目录下同名的,用带目录的名字,都丢弃得掉
    const key = this.records.has(id) || this.orphans.has(id) ? `${group}/${id}` : id
    this.orphans.set(key, { id: key, path, createdAt: lstatSync(path).mtimeMs })
  }

  list(): TelegramChats['worktrees'] {
    const out: TelegramChats['worktrees'] = []
    for (const w of this.records.values()) {
      const usedByChat = this.o.chats.chatUsing(w.id)
      out.push({ id: w.id, project: w.project, path: w.path, sessionIds: [...w.sessionIds], createdAt: w.createdAt, ...(usedByChat !== undefined && { usedByChat }) })
    }
    for (const orphan of this.orphans.values()) out.push({ id: orphan.id, project: '', path: orphan.path, sessionIds: [], createdAt: orphan.createdAt })
    return out
  }

  /** /project <名字>。别名是唯一的入口,路径每次都验:可能已经变成了链接(R4) */
  open(chatId: string, updateId: number, name: string): Promise<OpenResult> {
    return this.exclusive(async () => {
      const { chats, commands, git } = this.o
      if (chats.isOpen(chatId)) return { ok: false, reason: 'busy' }
      const project = this.o.config().projects.find(p => p.name === name)
      if (!project) return { ok: false, reason: 'unknown' }
      if (chats.projectRefusal(chatId)) return { ok: false, reason: 'no_model' }
      let realProject: string
      try {
        realProject = commands.validateCwd(project.path)
      } catch {
        return { ok: false, reason: 'invalid_path' }
      }
      const id = `wt_${updateId}`
      const made = await createImWorktree({
        dataDir: this.o.dataDir,
        project: realProject,
        group: groupOf(chatId),
        id,
        git,
        tmpDir: this.o.tmpDir,
        untrusted: [this.o.dataDir, this.qoderDir()],
        writableRoots: [this.o.systemTmp, this.qoderDir()],
        denyReadOf: (path, top) => denyReadCopies(treePolicy(cwd => this.o.sandbox.execPolicy('', cwd), realProject, join(path, relative(top, realProject)), { session: top, run: path }), path),
      })
      if (!made.ok) return { ok: false, reason: made.error }
      const previous = chats.status(chatId).worktreeId
      // 先记下来:之后崩溃,这是个列得出来、重投认得出来的 worktree
      const record = this.records.get(id) ?? { id, project: name, projectPath: realProject, path: made.path, cwd: made.cwd, sessionIds: [], createdAt: this.o.now() }
      this.store(record)
      this.o.save()
      const target: SessionTarget = { project: name, worktreeId: id, cwd: made.cwd, approvalMode: this.approvalModeOf(project.auto) }
      let result: NewSessionResult
      try {
        result = await chats.newSession(chatId, updateId, target, 'project')
      } catch (err) {
        await this.removeIfUnspoken(record)
        throw err
      }
      if (!result.ok) {
        await this.removeIfUnspoken(record)
        return result
      }
      if (!record.sessionIds.includes(result.sessionId)) record.sessionIds.push(result.sessionId)
      this.o.save()
      if (previous !== undefined && previous !== id) await this.leftBehind(previous)
      return { ok: true, sessionId: result.sessionId }
    })
  }

  /** /new:同一模式,沿用 worktree(§7.1)。项目不在配置里了、别名改了指向、目录没了:回纯对话 */
  renew(chatId: string, updateId: number): Promise<RenewResult> {
    return this.exclusive(async () => {
      const { chats } = this.o
      if (chats.isOpen(chatId)) return { ok: false, reason: 'busy' }
      const { project, worktreeId } = chats.status(chatId)
      const record = worktreeId !== undefined ? this.records.get(worktreeId) : undefined
      const target = project !== undefined && record ? this.stillValid(project, record) : undefined
      const result = await chats.newSession(chatId, updateId, target, 'new')
      if (!result.ok) return result
      if (target && record) {
        if (!record.sessionIds.includes(result.sessionId)) record.sessionIds.push(result.sessionId)
        this.o.save()
        return { ok: true, project: target.project }
      }
      if (worktreeId !== undefined) await this.leftBehind(worktreeId)
      return project !== undefined ? { ok: true, lost: project } : { ok: true }
    })
  }

  private stillValid(name: string, record: Worktree): SessionTarget | undefined {
    const project = this.o.config().projects.find(p => p.name === name)
    if (!project || !existsSync(record.cwd)) return undefined
    try {
      if (this.o.commands.validateCwd(project.path) !== record.projectPath) return undefined
    } catch {
      return undefined
    }
    // auto 每次现判:app 里可能关了,级别可能降了(§8.3)
    return { project: name, worktreeId: record.id, cwd: record.cwd, approvalMode: this.approvalModeOf(project.auto) }
  }

  /** /project off */
  off(chatId: string): Promise<'ok' | 'busy'> {
    return this.exclusive(async () => {
      const { chats } = this.o
      if (chats.isOpen(chatId)) return 'busy'
      const { project, worktreeId } = chats.status(chatId)
      if (project === undefined && worktreeId === undefined) return 'ok'
      chats.leave(chatId)
      if (worktreeId !== undefined) await this.leftBehind(worktreeId)
      return 'ok'
    })
  }

  /** channel.telegram.worktree.discard。开着轮 → ERR_BUSY;当前聊天用着的退回纯对话 */
  discard(worktreeId: string): Promise<void> {
    return this.exclusive(async () => {
      const record = this.records.get(worktreeId)
      const orphan = this.orphans.get(worktreeId)
      if (!record && !orphan) throw new RpcError(-32602, 'unknown_worktree')
      const path = (record ?? orphan)!.path
      const sessionIds = record ? record.sessionIds : this.sessionsIn(path)
      const usedBy = this.o.chats.chatUsing(worktreeId)
      if (sessionIds.some(s => hasOpenTurn(this.o.history(s))) || (usedBy !== undefined && this.o.chats.isOpen(usedBy))) throw new RpcError(ERR_BUSY, 'turn in progress')
      await this.remove(worktreeId, path, sessionIds, record?.projectPath)
      if (usedBy !== undefined) {
        this.o.chats.leave(usedBy)
        this.o.notify(usedBy, FALLBACK_LINE)
      }
    })
  }

  /** 离开时:所有会话都没说过话的删掉,其余留着等 08 或 RPC(不自动删有内容的,04 同一裁定) */
  private async leftBehind(id: string): Promise<void> {
    const record = this.records.get(id)
    if (record) await this.removeIfUnspoken(record)
  }

  private async removeIfUnspoken(record: Worktree): Promise<void> {
    if (this.o.chats.chatUsing(record.id) !== undefined || record.sessionIds.some(s => hasTurn(this.o.history(s)))) return
    try {
      await this.remove(record.id, record.path, record.sessionIds, record.projectPath)
    } catch (err) {
      this.o.log.warn('telegram worktree removal failed', { code: codeOf(err) })
    }
  }

  /** 先删引用:会话的钉子是链接形态,worktree 没了就不完整了。内容留在用户的对象库里,所以要删(R10) */
  private async remove(id: string, path: string, sessionIds: string[], projectPath: string | undefined): Promise<void> {
    const { git, tmpDir, dataDir } = this.o
    const pin = await this.pinFor(path, sessionIds, projectPath)
    if (pin) {
      for (const sessionId of sessionIds) {
        if (!this.o.sessions.get(sessionId)) continue
        try {
          await pruneRefs(refBase(sessionId), 0, git, { pin, tmpDir })
        } catch (err) {
          this.o.log.warn('telegram snapshot prune failed', { code: codeOf(err) })
        }
      }
    }
    await removeImWorktree({ dataDir, path, pin, git, tmpDir })
    this.forget(id)
    this.o.save()
  }

  /** 哪个仓库:会话建时钉的最可信;没有会话的,找 .git 指回来的项目(记录里的和配置里的)。都不是就不跑 git,只删目录,git 条目留给 git 自己过期 */
  private async pinFor(path: string, sessionIds: string[], projectPath: string | undefined): Promise<RepoPin | undefined> {
    for (const sessionId of sessionIds) {
      const repo = this.o.sessions.get(sessionId)?.repo
      if (repo?.kind === 'repo' && pinIntact(repo)) return repo
    }
    const candidates = new Set([...(projectPath !== undefined ? [projectPath] : []), ...this.o.config().projects.map(p => p.path)])
    for (const project of candidates) {
      const pin = await pinRepo(project, this.o.git, { tmpDir: this.o.tmpDir, untrusted: [this.o.dataDir, imWorktreeRootOf(this.o.dataDir), this.qoderDir()] })
      if (pin.kind !== 'repo') continue
      if (worktreePin(pin, path, path) || (project === projectPath && !lexists(path))) return pin
    }
    return undefined
  }

  /** 孤儿没有记录:从事件里找 cwd 在它里面的会话,它们的快照引用也要删 */
  private sessionsIn(path: string): string[] {
    const found: string[] = []
    const prefix = `${path}/`
    let seq = 0
    for (;;) {
      const page = this.o.eventsAfter(seq, SCAN_PAGE)
      for (const e of page) {
        if (e.type !== 'session.created' || !e.sessionId) continue
        const cwd = (e.payload as { cwd?: unknown } | undefined)?.cwd
        if (cwd === path || (typeof cwd === 'string' && cwd.startsWith(prefix))) found.push(e.sessionId)
      }
      if (page.length < SCAN_PAGE) return found
      seq = page[page.length - 1]!.seq
    }
  }

  private qoderDir(): string {
    return join(this.o.home, '.qoder')
  }
}
