// 各编码工具共用:依赖、参数 schema、路径请求
import { realpathSync } from 'node:fs'
import { z, type ZodType } from 'zod'
import type { PermissionGate } from '../../kernel/permissionGate'
import { argsOf, type PermissionRequest, type ToolContext } from '../../lib/tools/types'
import type { GitRunner } from './files'
import { pathFor, samePath } from './safeFs'

export interface CodingDeps {
  gate: Pick<PermissionGate, 'check' | 'checkMany'>
  git?: GitRunner
  grepTimeoutMs?: number
}

/** zod → 给模型的 JSON Schema(去掉 $schema 头) */
export function jsonSchema(schema: ZodType): object {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

/** 解析参数,并拿到(记在 args 上的)解析后路径 */
export function parsed<T extends { path?: string }>(schema: ZodType<T>, raw: unknown, ctx: ToolContext): { args: T; raw: string; abs: string } {
  const args = argsOf(schema, raw)
  const rawPath = args.path ?? '.'
  return { args, raw: rawPath, abs: pathFor(raw as object, ctx, rawPath) }
}

export const request = (action: 'read' | 'write', resource: string): PermissionRequest => ({ actor: 'tools', action, resource })

/** 主线程长循环每这么多项让出一次事件循环(cwd = 家目录时 2 万个文件) */
export const YIELD_EVERY = 500
export const yieldLoop = () => new Promise<void>(r => setImmediate(r))

/**
 * 批量过门(glob / grep 的逐个文件):只留 realpath 回自己、且权限门 allow 的。
 * git 索引里的 `d/f` 在 `d` 被换成指向外面的链接后仍会列出;按字面路径过门会放行外面的文件
 */
export async function allowedReads(deps: CodingDeps, ctx: ToolContext, files: string[]): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < files.length; i += YIELD_EVERY) {
    if (ctx.signal.aborted) throw new Error('已取消')
    const real: string[] = []
    for (const f of files.slice(i, i + YIELD_EVERY)) {
      try {
        if (samePath(realpathSync.native(f), f)) real.push(f)
      } catch {
        // 不存在 / 读不了 → 不要
      }
    }
    const decisions = deps.gate.checkMany(real.map(f => ({ actor: 'tools', action: 'read', resource: f, sessionId: ctx.sessionId })))
    real.forEach((f, k) => decisions[k] === 'allow' && out.push(f))
    await yieldLoop()
  }
  return out
}
