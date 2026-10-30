// list:列一层目录(spec §7)
import { readdirSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { Tool } from '../../lib/tools/types'
import { jsonSchema, parsed, request } from './common'
import { shownPath, stillSame } from './safeFs'

const MAX = 500

const Args = z.object({ path: z.string().optional().describe('Directory, relative to the working directory (default .)') })

export function listTool(): Tool {
  return {
    name: 'list',
    description: `List one level of a directory. Directories end with /. Sorted by name, at most ${MAX} entries.`,
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [request('read', parsed(Args, raw, ctx).abs)],
    async run(raw, ctx) {
      const { raw: rawPath, abs } = parsed(Args, raw, ctx)
      stillSame(ctx, rawPath, abs)
      if (!statSync(abs).isDirectory()) return { content: `${shownPath(ctx, abs)} 不是目录`, isError: true }
      const names = readdirSync(abs, { withFileTypes: true })
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      if (names.length === 0) return { content: '(空目录)' }
      if (names.length <= MAX) return { content: names.join('\n') }
      return { content: `${names.slice(0, MAX).join('\n')}\n…(共 ${names.length} 项,只列前 ${MAX} 项)` }
    },
  }
}
