// write:建父目录,覆盖写(spec §7)
import { z } from 'zod'
import type { Tool, ToolContext } from '../../lib/tools/types'
import { resolveToolPath } from '../../lib/fs/paths'
import { type CodingDeps, jsonSchema, parsed, request } from './common'
import { samePath, shownPath, stillSame, writeChecked } from './safeFs'

const Args = z.object({
  path: z.string().describe('File path, relative to the working directory or absolute'),
  content: z.string().describe('Full new content of the file'),
})

/** 建完父目录、写之前:再解析一次仍是放行的那个路径,且权限门仍放行写(还在 cwd 内、不在黑名单、不在 .git 里) */
export function writeAgain(deps: CodingDeps, ctx: ToolContext, rawPath: string, abs: string): () => boolean {
  return () => samePath(resolveToolPath(ctx.cwd, rawPath), abs) && deps.gate.check({ ...request('write', abs), sessionId: ctx.sessionId }) === 'allow'
}

export function writeTool(deps: CodingDeps): Tool {
  return {
    name: 'write',
    description: 'Write a file, replacing it if it exists. Parent directories are created.',
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('write', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { args, raw: rawPath, abs } = parsed(Args, raw, ctx)
      stillSame(ctx, rawPath, abs)
      writeChecked(abs, args.content, writeAgain(deps, ctx, rawPath, abs))
      const lines = args.content === '' ? 0 : args.content.split('\n').length - (args.content.endsWith('\n') ? 1 : 0)
      return { content: `已写入 ${shownPath(ctx, abs)}(${lines} 行)` }
    },
  }
}
