// tools-registry:提供 `tools` 服务(spec §6)
// 解析参数 → 权限门(必要时等审批)→ 执行 → 截断 / 落盘 → 写事件;永不抛错。
// 模型拿到原文;写进事件的参数与输出一律打码
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent } from '../../protocol/index'
import type { Approvals } from '../../kernel/approvals'
import type { Logger } from '../../kernel/log'
import type { PermissionGate } from '../../kernel/permissionGate'
import type { Plugin } from '../../kernel/pluginHost'
import { OUTSIDE } from '../../lib/fs/paths'
import { sessionKey } from '../../lib/tools/commandKey'
import { redact } from '../../lib/tools/redact'
import type { PermissionRequest, Tool, ToolContext, ToolResult, ToolsService } from '../../lib/tools/types'
import { manifest } from './manifest'

const MAX_CONTENT = 30_000
const KEEP = 12_000
const ARGS_PREVIEW = 2_000
const DENIED_BY_USER = '用户拒绝了该操作'

/** result 给模型(原文);logged 写进 tool.ended(打码) */
type Outcome = { result: ToolResult; logged: string }

interface Deps {
  gate: Pick<PermissionGate, 'check'>
  approvals: Pick<Approvals, 'request'>
  append(e: Omit<KernelEvent, 'seq' | 'ts'>): unknown
  log: Logger
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const failed = (content: string): Outcome => ({ result: { content, isError: true }, logged: redact(content) })
/** 落盘文件名只留安全字符:callId 来自模型,不能带 `/`、`..` 跑出 spillDir */
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
const shown = (resource: string | undefined) => (resource === undefined ? '' : ` ${resource === OUTSIDE ? '(无法解析的路径)' : resource}`)
const cut = (s: string, marker: string) => s.slice(0, KEEP) + marker + s.slice(-KEEP)

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
    const t0 = Date.now()
    const raw = typeof rawArgs === 'string' ? rawArgs : String(rawArgs)
    const base = { turnId: ctx.turnId, callId: ctx.callId, name }
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

    for (const req of reqs) {
      const denied = await this.authorize(req, tool.name, ctx)
      if (denied) return failed(denied)
    }
    if (ctx.signal.aborted) return failed('已取消')

    let result: ToolResult
    try {
      result = await tool.run(args, ctx)
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

  /** 放行 → undefined;否则返回给模型的拒绝说明 */
  private async authorize(req: PermissionRequest, tool: string, ctx: ToolContext): Promise<string | undefined> {
    // actor 与会话一律由注册表定:工具不能自称 kernel,也不能借别的会话的 cwd
    const r: PermissionRequest = { action: req.action, resource: req.resource, actor: 'tools', sessionId: ctx.sessionId }
    let decision: string
    try {
      decision = this.deps.gate.check(r)
    } catch (e) {
      this.deps.log.error('permission check failed', { error: message(e) })
      decision = 'deny'
    }
    if (decision === 'allow') return undefined
    if (decision !== 'ask') return `拒绝:${r.action}${shown(r.resource)}`
    try {
      const d = await this.deps.approvals.request({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        callId: ctx.callId,
        tool,
        summary: redact(r.resource ?? tool),
        key: r.action === 'exec' && r.resource !== undefined ? sessionKey(r.resource) : undefined,
        signal: ctx.signal,
      })
      return d === 'allow' ? undefined : DENIED_BY_USER
    } catch (e) {
      this.deps.log.error('approval request failed', { error: message(e) }) // 写不了 requested → 按拒绝
      return DENIED_BY_USER
    }
  }

  /** 完整内容写 spillDir,模型拿开头 + 结尾 + 绝对路径;事件里是先打码再截断(PEM 不会被截成两半漏出) */
  private spill(content: string, name: string, ctx: ToolContext, shape: (c: string) => ToolResult): Outcome {
    let marker: string
    try {
      mkdirSync(ctx.spillDir, { recursive: true, mode: 0o700 })
      const file = join(realpathSync.native(ctx.spillDir), `${safeName(ctx.callId)}-${safeName(name)}.txt`)
      writeFileSync(file, content, { mode: 0o600 })
      marker = `\n…[已截断,完整输出:${file}]…\n`
    } catch (e) {
      this.deps.log.error('tool output spill failed', { error: message(e) })
      marker = '\n…[已截断,完整输出未能保存]…\n'
    }
    const red = redact(content)
    return { result: shape(cut(content, marker)), logged: red.length > MAX_CONTENT ? cut(red, marker) : red }
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
    ctx.services.provide<ToolsService>('tools', new ToolsRegistry({ gate, approvals, append: e => ctx.append(e), log: ctx.log }))
  },
}

export default toolsRegistry
