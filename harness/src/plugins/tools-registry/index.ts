// tools-registry:提供 `tools` 服务(spec §6)
// 解析参数 → 权限门(必要时等审批)→ 执行 → 截断 / 落盘 → 写事件;永不抛错。
// 模型拿到原文;写进事件的参数与输出一律打码
import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent } from '../../protocol/index'
import type { Approvals } from '../../kernel/approvals'
import type { Logger } from '../../kernel/log'
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Plugin } from '../../kernel/pluginHost'
import { OUTSIDE } from '../../lib/fs/paths'
import { sessionKey } from '../../lib/tools/commandKey'
import { SUMMARY_CLIP_MARK } from '../../lib/tools/diagnostics'
import { redact } from '../../lib/tools/redact'
import type { SandboxStatus } from '../../protocol/index'
import type { PermissionRequest, SandboxService, Tool, ToolContext, ToolResult, ToolsService } from '../../lib/tools/types'
import { manifest } from './manifest'

const MAX_CONTENT = 30_000
const KEEP = 12_000
const ARGS_PREVIEW = 2_000
/** 错误文本与审批摘要的上限 */
const SHORT = 2_000
const NAME_MAX = 200
const DENIED_BY_USER = '用户拒绝了该操作'

/** result 给模型(原文);logged 写进 tool.ended(打码) */
type Outcome = { result: ToolResult; logged: string }

interface Deps {
  gate: Pick<PermissionGate, 'check'>
  approvals: Pick<Approvals, 'request'>
  /** 内核 sandbox 服务:exec 审批据它标 unsandboxed;不在 / 出错 = 没有沙箱 */
  sandbox?: Pick<SandboxService, 'status'>
  /** 会话的来源:IM 的本会话放行只在完整沙箱算数 */
  sessions?: { get(id: string): { origin: string } | undefined }
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  log: Logger
}

/** 抛出的任意值转文本;String() 本身也可能抛(Object.create(null)) */
const message = (e: unknown): string => {
  if (e instanceof Error) return e.message
  try {
    return String(e)
  } catch {
    return 'unknown error'
  }
}
/** 截成至多 max 个字符,保留开头与结尾 */
const clip = (s: string, max: number): string => {
  if (s.length <= max) return s
  const mark = `\n…${SUMMARY_CLIP_MARK}…\n`
  const half = Math.floor((max - mark.length) / 2)
  return s.slice(0, half) + mark + s.slice(-half)
}
/** 错误结果:模型拿原文,事件里先打码再截(不会把密钥截成两半漏出) */
const failed = (content: string): Outcome => ({ result: { content: clip(content, SHORT), isError: true }, logged: clip(redact(content), SHORT) })
/** 落盘文件名只留安全字符:callId 来自模型,不能带 `/`、`..` 跑出 spillDir */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
const shown = (resource: string | undefined) => (resource === undefined ? '' : ` ${resource === OUTSIDE ? '(无法解析的路径)' : resource}`)
const cut = (s: string, marker: string) => s.slice(0, KEEP) + marker + s.slice(-KEEP)

/** 独占新建(`wx`:不覆盖、不跟随已有链接);重名(含 safeName 折叠后的)加随机后缀 */
function writeUnique(dir: string, stem: string, content: string): string {
  for (let i = 0; ; i++) {
    const file = join(dir, `${stem}${i === 0 ? '' : `-${randomBytes(4).toString('hex')}`}.txt`)
    try {
      writeFileSync(file, content, { mode: 0o600, flag: 'wx' })
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 8) throw e
    }
  }
}

export class ToolsRegistry implements ToolsService {
  private tools = new Map<string, Tool>()

  constructor(private deps: Deps) {}

  register(tool: Tool): () => void {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`)
    this.tools.set(tool.name, tool)
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name)
    }
  }

  list(filter?: (t: Tool) => boolean): Tool[] {
    const all = [...this.tools.values()]
    return filter ? all.filter(filter) : all
  }

  async call(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    try {
      return await this.callChecked(name, rawArgs, ctx)
    } catch (e) {
      this.deps.log.error('tool call failed', { error: message(e) }) // 只有不合约的 ctx 会走到这里
      return { content: '工具调用失败', isError: true }
    }
  }

  private async callChecked(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
    const t0 = Date.now()
    const raw = typeof rawArgs === 'string' ? rawArgs : '' // 非字符串 → JSON 解析失败
    const base = { turnId: ctx.turnId, callId: ctx.callId, name: redact(String(name)).slice(0, NAME_MAX) }
    let out: Outcome
    // 记不下 started 就不执行:不留审计记录的副作用不做
    if (!this.emit(ctx, 'tool.started', { ...base, argsPreview: redact(raw).slice(0, ARGS_PREVIEW) })) {
      out = failed('无法记录工具调用,未执行')
    } else {
      try {
        out = await this.execute(name, raw, ctx)
      } catch (e) {
        out = failed(message(e)) // execute 自己不抛;兜底
      }
    }
    const isError = out.result.isError === true
    this.emit(ctx, 'tool.ended', { ...base, ok: !isError, ms: Date.now() - t0, content: out.logged, ...(isError && { isError: true }) })
    return out.result
  }

  private async execute(name: string, raw: string, ctx: ToolContext): Promise<Outcome> {
    const tool = this.tools.get(name)
    if (!tool) return failed(`未知工具:${name}`)

    let args: unknown
    try {
      args = JSON.parse(raw)
    } catch (e) {
      return failed(`参数不是合法的 JSON:${message(e)}`)
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return failed('参数必须是 JSON 对象')

    let reqs: PermissionRequest[]
    try {
      reqs = tool.permission(args, ctx)
      if (!Array.isArray(reqs)) throw new Error('permission 必须返回数组')
    } catch (e) {
      return failed(message(e))
    }
    if (reqs.length === 0) return failed('工具未声明权限请求,未执行') // 空数组 = 拒绝:漏写一行不能绕过权限门

    // 级别与权限门同步读(门里 exec 的判定看的就是这个级别);审批时再读一次,以卡片上显示的为准
    let seen = this.levelNow(ctx.sessionId)
    // 先过完全部权限门,任何一个 deny 就不再去问用户
    const checked: { req: PermissionRequest; decision: string }[] = []
    for (const req of reqs) {
      const r = this.normalize(req, tool, ctx)
      const decision = this.check(r)
      if (decision !== 'allow' && decision !== 'ask') return failed(`拒绝:${r.action}${shown(r.resource)}`)
      checked.push({ req: r, decision })
    }
    let asked = false
    for (const { req, decision } of checked) {
      if (decision !== 'ask') continue
      asked = true
      if (req.action === 'exec') seen = this.levelNow(ctx.sessionId)
      // 只有 exec 会标;工具显式给的(这次运行的实际隔离)优先于会话级别
      if (!(await this.approve(req, tool.name, ctx, req.action === 'exec' && (req.unsandboxed ?? seen === 'none')))) return failed(DENIED_BY_USER)
    }
    if (ctx.signal.aborted) return failed('已取消')
    // 等审批期间权限配置可能变了(permissions.set):新加的 deny 照样生效;原来直接放行、现在要问的,没人批过,也不跑
    if (asked) {
      for (const { req, decision } of checked) {
        const now = this.check(req)
        if (now === 'deny' || (decision === 'allow' && now !== 'allow')) return failed(`拒绝:${req.action}${shown(req.resource)}`)
      }
    }

    let result: ToolResult
    try {
      result = await tool.run(args, { ...ctx, sandboxLevel: seen })
    } catch (e) {
      return failed(message(e))
    }
    const content = typeof result?.content === 'string' ? result.content : String(result?.content ?? '')
    const isError = result?.isError === true
    const meta = result?.meta
    const shape = (c: string): ToolResult => ({ content: c, ...(isError && { isError: true }), ...(meta !== undefined && { meta }) })
    if (content.length <= MAX_CONTENT) return { result: shape(content), logged: redact(content) }
    return this.spill(content, name, ctx, shape)
  }

  /**
   * actor 与会话一律由注册表定:工具不能自称 kernel,也不能借别的会话的 cwd。
   * 本会话放行的键和这次运行的隔离,只认委派工具的 exec;键也认声明了 ownsKey 的工具的 exec(09 §10.4);其他工具按会话级别与 sessionKey(04 spec §6)
   */
  private normalize(req: PermissionRequest, tool: Tool, ctx: ToolContext): PermissionRequest {
    const delegated = tool.delegate === true && req.action === 'exec'
    const keyed = tool.ownsKey === true && req.action === 'exec'
    return {
      action: req.action,
      resource: req.resource,
      summary: req.summary,
      mustAsk: req.mustAsk,
      confirm: req.confirm,
      ...(keyed && { key: req.key }),
      ...(delegated && { key: req.key, unsandboxed: req.unsandboxed }),
      actor: 'tools',
      sessionId: ctx.sessionId,
    }
  }

  private check(r: PermissionRequest): string {
    try {
      return this.deps.gate.check(r)
    } catch (e) {
      this.deps.log.error('permission check failed', { error: message(e) })
      return 'deny'
    }
  }

  /** 本会话现在的沙箱级别;服务不在或出错 = none(exec 审批卡标 `未隔离`,spec §13、R13) */
  private levelNow(sessionId: string): SandboxStatus['level'] {
    if (!this.deps.sandbox) return 'none'
    try {
      return this.deps.sandbox.status(sessionId).level
    } catch (e) {
      this.deps.log.error('sandbox status failed', { error: message(e) })
      return 'none'
    }
  }

  /** 用户放行 → true;拒绝、取消、超时、写不了 requested(reject)→ false */
  private async approve(r: PermissionRequest, tool: string, ctx: ToolContext, unsandboxed: boolean): Promise<boolean> {
    try {
      // 权限门说 ask 之后,存着的键会直接放行,门就白判了。远程消息 + 不是完整沙箱:每条都要人(07 spec §8.3、R19),不用也不留
      const remoteBelowFull = this.deps.sessions?.get(ctx.sessionId)?.origin === 'im' && this.levelNow(ctx.sessionId) !== 'full'
      const d = await this.deps.approvals.request({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        callId: ctx.callId,
        tool,
        summary: clip(redact(r.summary ?? r.resource ?? tool), SHORT),
        // 有规则落实不了、或这次运行明说没有隔离:每次都问,不留也不用本会话放行
        key: r.mustAsk || r.unsandboxed || remoteBelowFull ? undefined : r.key ?? (r.action === 'exec' && r.resource !== undefined ? sessionKey(r.resource) : undefined),
        ...(unsandboxed && { unsandboxed: true }),
        signal: ctx.signal,
      })
      return d === 'allow'
    } catch (e) {
      this.deps.log.error('approval request failed', { error: message(e) })
      return false
    }
  }

  /** 完整内容写 spillDir,模型拿开头 + 结尾 + 绝对路径;事件里是先打码再截断(PEM 不会被截成两半漏出) */
  private spill(content: string, name: string, ctx: ToolContext, shape: (c: string) => ToolResult): Outcome {
    let marker: string
    try {
      mkdirSync(ctx.spillDir, { recursive: true, mode: 0o700 })
      const file = writeUnique(realpathSync.native(ctx.spillDir), `${safeName(ctx.callId)}-${safeName(name)}`, content)
      marker = `\n…[已截断,完整输出:${file}]…\n`
    } catch (e) {
      this.deps.log.error('tool output spill failed', { error: message(e) })
      marker = '\n…[已截断,完整输出未能保存]…\n'
    }
    const red = redact(content)
    // 打码后变短也要留标记与路径:之后的轮从事件重建时要找得到落盘文件
    return { result: shape(cut(content, marker)), logged: red.length > 2 * KEEP ? cut(red, marker) : red + marker }
  }

  private emit(ctx: ToolContext, type: 'tool.started' | 'tool.ended', payload: Record<string, unknown>): boolean {
    try {
      this.deps.append({ type, sessionId: ctx.sessionId, payload })
      return true
    } catch (e) {
      this.deps.log.error(`${type} append failed`, { error: message(e) })
      return false
    }
  }
}

const toolsRegistry: Plugin = {
  manifest,
  activate(ctx) {
    const gate = ctx.services.get<PermissionGate>('permissionGate')
    const approvals = ctx.services.get<Approvals>('approvals')
    if (!gate || !approvals) throw new Error('permissionGate / approvals service missing')
    // 内核在插件激活前提供;不在 → exec 审批一律标 unsandboxed
    const sandbox = ctx.services.get<SandboxService>('sandbox')
    ctx.services.provide<ToolsService>('tools', new ToolsRegistry({ gate, approvals, sandbox, sessions: ctx.services.get<{ get(id: string): { origin: string } | undefined }>('sessions'), append: e => ctx.append(e), log: ctx.log }))
  },
}

export default toolsRegistry
