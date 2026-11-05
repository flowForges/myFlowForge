// 命令(07 spec §11)。闭合清单:这个形状的文字不进模型,不认识的回帮助,不花钱。转发和 via_bot 的文字到不了这里(R15)。
// 进内核的都带 commandId = tg:<botId>:<updateId>:<名字>,重投靠回执,没有第二次效果
import type { Sessions } from '../../kernel/sessions'
import { RpcError } from '../../kernel/rpcError'
import { sanitizeLine } from '../../lib/memory/wrap'
import type { ModelsService } from '../../lib/models/types'
import type { SandboxService, SessionCommands } from '../../lib/tools/types'
import { ERR_BUSY, type KernelEvent, type ModelRef } from '../../protocol/index'
import { CODING_ONLY_LINE, NO_MODEL_LINE, type Chats } from './chats'
import type { DmInbound } from './inbound'
import { codeOf } from './poller'
import type { Projects } from './projects'

export const BUSY_LINE = '这轮还在跑,先 /cancel'
const HELP = ['/status 现在的状态', '/new 新对话', '/project [名字|off] 进项目,或回纯对话', '/model [序号] 换模型,下次新会话起用', '/cancel 停这一轮,清排队', '/rollback 回滚这个会话最近一轮', '/unpair confirm 解除配对', '/help 这张表'].join('\n')
const NO_PROJECT_LINE = '没有这个项目'
const CHAT_ROLLBACK_LINE = '纯对话没有文件可回滚'
const NOTHING_TO_ROLLBACK_LINE = '没有可回滚的'
const ROLLBACK_FAILED_LINE = '回滚没成功,文件以 worktree 里的为准'
const COMMAND_FAILED_LINE = '这条命令没执行成功,再发一次'
const UNPAIR_HINT_LINE = '要解除配对,发 /unpair confirm'
const UNPAIRED_LINE = '已解除配对'
const UNPAIR_UNSAVED_LINE = '已解除配对,但没存上盘,后台重启后可能又配上。回 app 再撤销一次'
const IN_CHAT_LINE = '回到纯对话了'
const MODEL_LIST_MAX = 30

const LEVEL_WORD = { full: '完整', partial: '部分', none: '未隔离' } as const

const OPEN_FAILED: Record<string, string> = {
  invalid_path: '项目路径现在用不了,回 app 看一下',
  not_git: '这个目录不是 git 仓库,开不了',
  no_commits: '这个仓库还没有提交,开不了',
  unsafe_repo: '这个仓库配了不安全的过滤器,不能远程开',
  root_conflict: '这个项目和 worktree 目录重叠,开不了',
  worktree_limit: 'worktree 满了(20 个),先在 app 里丢弃一些',
  worktree_failed: '建 worktree 失败了,再试一次',
}

/** 这个形状的文字不进模型。给别的机器人的算不认识,也不进(§11) */
const SHAPE = /^\/[a-z_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/

export const isCommandShaped = (text: string) => SHAPE.test(text)

export function parseCommand(text: string, botUsername?: string): { name: string; args: string[] } | undefined {
  const m = /^\/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return undefined
  if (m[2] !== undefined && m[2].toLowerCase() !== botUsername?.toLowerCase()) return undefined
  return { name: m[1], args: (m[3] ?? '').split(/\s+/).filter(Boolean) }
}

export type CommandDm = Pick<DmInbound, 'chatId' | 'accountId' | 'updateId'>

export interface CommandDeps {
  chats: Pick<Chats, 'status' | 'cancel' | 'isOpen' | 'setModel' | 'guard'>
  projects: Pick<Projects, 'open' | 'off' | 'renew' | 'names'>
  commands: SessionCommands
  sessions: Pick<Sessions, 'get'>
  sandbox: Pick<SandboxService, 'status'>
  models(): ModelsService | undefined
  history(sessionId: string): KernelEvent[]
  channelState(): string
  /** 和 RPC 的撤销同一条路。false = 名单改了但没存上盘 */
  unpair(accountId: string): boolean
  botId(): number
  mask(text: string): string
  reply(chatId: string, text: string): void
}

interface Ctx {
  args: string[]
  dm: CommandDm
  deps: CommandDeps
  commandId: string
  reply(text: string): void
}

const shown = (c: Ctx, label: string) => c.deps.mask(sanitizeLine(label))

function modelChoices(models: ModelsService | undefined): { ref: ModelRef; label: string }[] {
  if (!models) return []
  const catalog = models.catalog()
  return models.accounts().flatMap(a =>
    a.state !== 'ok'
      ? []
      : (catalog.models[a.presetId] ?? a.models ?? []).filter(m => !m.deprecated).map(m => ({ ref: { accountId: a.id, modelId: m.id }, label: `${a.label} · ${m.name}` })),
  )
}

function modelLabel(c: Ctx, ref: ModelRef | undefined): string {
  if (!ref) return '没有'
  const hit = modelChoices(c.deps.models()).find(m => m.ref.accountId === ref.accountId && m.ref.modelId === ref.modelId)
  return shown(c, hit?.label ?? `${ref.accountId} · ${ref.modelId}`)
}

function modelList(c: Ctx): string {
  const choices = modelChoices(c.deps.models())
  if (choices.length === 0) return NO_MODEL_LINE
  const rows = choices.slice(0, MODEL_LIST_MAX).map((m, i) => `${i + 1}. ${shown(c, m.label)}`)
  if (choices.length > MODEL_LIST_MAX) rows.push(`…还有 ${choices.length - MODEL_LIST_MAX} 个`)
  return [...rows, '发 /model 序号,下次 /new 或 /project 起用'].join('\n')
}

/** 和 loop-default 的 rollbackRefs 同一规则:按 message.user 的顺序,跑过快照、没回滚过的最新一轮;失败的轮也算,它的改动也在 */
function lastRollbackable(events: KernelEvent[]): string | undefined {
  const order: string[] = []
  const snapshotted = new Set<string>()
  const rolledBack = new Set<string>()
  for (const e of events) {
    const turnId = (e.payload as { turnId?: unknown } | undefined)?.turnId
    if (typeof turnId !== 'string') continue
    if (e.type === 'message.user' && !order.includes(turnId)) order.push(turnId)
    else if (e.type === 'turn.snapshot') snapshotted.add(turnId)
    else if (e.type === 'turn.rolledBack') rolledBack.add(turnId)
  }
  return order.filter(t => snapshotted.has(t) && !rolledBack.has(t)).at(-1)
}

async function rollback(c: Ctx): Promise<void> {
  const { chats, sessions, commands, history } = c.deps
  const chatId = c.dm.chatId
  const { sessionId } = chats.status(chatId)
  if (sessionId === undefined || sessions.get(sessionId)?.cwd === undefined) return c.reply(CHAT_ROLLBACK_LINE)
  if (chats.isOpen(chatId, c.dm.updateId)) return c.reply(BUSY_LINE)
  // 重投时回执作答,内核不看 turnId;那时"最近一轮"已经是更早的一轮了,所以先看回执
  const replay = commands.hasReceipt(c.commandId)
  const turnId = lastRollbackable(history(sessionId))
  if (turnId === undefined && !replay) return c.reply(NOTHING_TO_ROLLBACK_LINE)
  try {
    const { files } = await commands.call('turn.rollback', { commandId: c.commandId, sessionId, turnId: turnId ?? 'replayed' })
    c.reply(`已回滚 ${files} 个文件`)
  } catch (err) {
    if (err instanceof RpcError && err.code === ERR_BUSY) return c.reply(BUSY_LINE)
    // 轮的快照不全:内核说不能回滚
    c.reply(err instanceof RpcError && err.message === 'not rollbackable' ? NOTHING_TO_ROLLBACK_LINE : ROLLBACK_FAILED_LINE)
  }
}

async function project(c: Ctx): Promise<void> {
  const { projects } = c.deps
  const chatId = c.dm.chatId
  if (c.args.length === 0) {
    const names = projects.names()
    return c.reply(names.length > 0 ? `项目:${names.join(', ')}\n发 /project 名字 进入,/project off 回纯对话` : '还没有配置项目,先在 app 里加')
  }
  // 只认一个词。路径、.. 都到不了文件系统:下面只在 app 配的别名里找
  if (c.args.length > 1) return c.reply(NO_PROJECT_LINE)
  const name = c.args[0]!
  if (name === 'off') {
    const r = await projects.off(chatId, c.dm.updateId)
    return c.reply(r === 'busy' ? BUSY_LINE : IN_CHAT_LINE)
  }
  const r = await projects.open(chatId, c.dm.updateId, name)
  if (r.ok) return c.reply(`进了项目 ${name}。改动都在单独的 worktree 里,你的仓库不动`)
  if (r.reason === 'stopped') return
  if (r.reason === 'busy') return c.reply(BUSY_LINE)
  if (r.reason === 'unknown') return c.reply(NO_PROJECT_LINE)
  if (r.reason === 'no_model') return c.reply(NO_MODEL_LINE)
  c.reply(`开不了:${OPEN_FAILED[r.reason] ?? OPEN_FAILED.worktree_failed}`)
}

export const COMMANDS = {
  async help(c: Ctx) {
    c.reply(HELP)
  },

  async status(c: Ctx) {
    const { chats, sessions, sandbox, models, channelState } = c.deps
    const s = chats.status(c.dm.chatId)
    const info = s.sessionId !== undefined ? sessions.get(s.sessionId) : undefined
    const model = info?.model ?? (info ? undefined : s.model) ?? models()?.catalog().default
    const level = sandbox.status(s.sessionId).level
    c.reply(
      [
        `机器人:${channelState()}`,
        `模式:${s.project !== undefined ? `项目 ${s.project}` : '纯对话'}`,
        `模型:${modelLabel(c, model)}`,
        `这轮:${s.parked ? '挂起' : s.running ? '运行中' : '空闲'},排队 ${s.queued}`,
        `沙箱:${LEVEL_WORD[level]}`,
        `审批:${info?.approvalMode === 'auto' ? '自动' : '每次问'}`,
      ].join('\n'),
    )
  },

  async new(c: Ctx) {
    const r = await c.deps.projects.renew(c.dm.chatId, c.dm.updateId)
    if (!r.ok && r.reason === 'stopped') return
    if (!r.ok) return c.reply(r.reason === 'busy' ? BUSY_LINE : r.reason === 'no_model' ? NO_MODEL_LINE : CODING_ONLY_LINE)
    if (r.lost !== undefined) return c.reply(`项目 ${r.lost} 已经不在配置里了,回到纯对话`)
    c.reply(r.project !== undefined ? `新对话 · ${r.project}` : '新对话')
  },

  project,

  async model(c: Ctx) {
    const choices = modelChoices(c.deps.models())
    const picked = c.args.length === 1 && /^\d{1,4}$/.test(c.args[0]!) ? choices[Number(c.args[0]) - 1] : undefined
    if (!picked) return c.reply(modelList(c))
    c.deps.chats.setModel(c.dm.chatId, picked.ref)
    c.reply(`下次 /new 或 /project 起用 ${shown(c, picked.label)}`)
  },

  async cancel(c: Ctx) {
    const { chats } = c.deps
    const queued = chats.status(c.dm.chatId).queued
    const cancelled = await chats.cancel(c.dm.chatId, c.commandId)
    c.reply(cancelled ? '已取消' : queued > 0 ? '已清空排队' : '没有在跑的轮')
  },

  rollback,

  async unpair(c: Ctx) {
    if (c.args.length !== 1 || c.args[0] !== 'confirm') return c.reply(UNPAIR_HINT_LINE)
    const saved = c.deps.unpair(c.dm.accountId)
    // 名单已经改了,c.reply 不再说话;这一句是说给刚走的人听的
    c.deps.reply(c.dm.chatId, saved ? UNPAIRED_LINE : UNPAIR_UNSAVED_LINE)
  },
} as const

/** cmd 没有 = 这个形状但不认识(给别的机器人的也算) */
export async function runCommand(cmd: { name: string; args: string[] } | undefined, dm: CommandDm, deps: CommandDeps, log: { warn(m: string, d?: unknown): void }): Promise<void> {
  // 等 git 的时候撤销了:结果不能再发给他
  const ours = deps.chats.guard(dm.chatId)
  const reply = (text: string) => {
    if (ours()) deps.reply(dm.chatId, text)
  }
  if (!cmd || !Object.hasOwn(COMMANDS, cmd.name)) return reply(`不认识这个命令\n${HELP}`)
  const name = cmd.name as keyof typeof COMMANDS
  try {
    await COMMANDS[name]({ args: cmd.args, dm, deps, commandId: `tg:${deps.botId()}:${dm.updateId}:${name}`, reply })
  } catch (err) {
    log.warn('telegram command failed', { command: name, code: codeOf(err) })
    reply(COMMAND_FAILED_LINE)
  }
}
