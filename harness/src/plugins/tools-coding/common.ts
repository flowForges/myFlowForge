// 各编码工具共用:依赖、参数 schema、路径请求
import { z, type ZodType } from 'zod'
import type { PermissionGate } from '../../kernel/permissionGate'
import { argsOf, type PermissionRequest, type ToolContext } from '../../lib/tools/types'
import type { GitRunner } from './files'
import { pathFor } from './safeFs'

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

/** 批量过门(glob / grep 的逐个文件):只留 allow 的 */
export function allowedReads(deps: CodingDeps, ctx: ToolContext, files: string[]): string[] {
  const decisions = deps.gate.checkMany(files.map(f => ({ actor: 'tools', action: 'read', resource: f, sessionId: ctx.sessionId })))
  return files.filter((_, i) => decisions[i] === 'allow')
}
