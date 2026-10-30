// apply_patch:Codex `*** Begin Patch` 格式(spec §7)。
// permission() 解析补丁、解析每个涉及的路径(含 Move 目标),每个一条 write;
// run() 只碰这些放行过的路径:先全部算出新内容,无错再统一复查,然后经 safeFs 写 / 删
import { lstatSync } from 'node:fs'
import { z } from 'zod'
import { parsePatch, patchPaths, planPatch, type PatchOp } from '../../lib/patch/applyPatch'
import type { Tool, ToolContext } from '../../lib/tools/types'
import { argsOf } from '../../lib/tools/types'
import { type CodingDeps, jsonSchema, request } from './common'
import { deleteChecked, pathFor, readNoFollow, samePath, shownPath, stillSame, writeChecked } from './safeFs'
import { writeAgain } from './write'

const Args = z.object({
  patch: z.string().describe('The patch, from "*** Begin Patch" to "*** End Patch"'),
})

const MAX_PATCH_FILE_BYTES = 10 * 1024 * 1024

const DESCRIPTION = `Edit files with a patch. Format:
*** Begin Patch
*** Add File: path/new.txt
+line of the new file
*** Delete File: path/old.txt
*** Update File: path/file.py
*** Move to: path/renamed.py   (optional)
@@ def some_function():        (optional line to locate the hunk)
 context line
-removed line
+added line
*** End Patch
Each hunk line starts with a space (context), - or +. Use about 3 lines of context. Add "*** End of File" after a hunk that ends at the end of the file. All changes are checked first; if any fails, nothing is written.`

/** 补丁 + 每个原始路径解析出的绝对路径(permission 与 run 用同一个 args 对象 → 同一组值) */
function resolved(raw: unknown, ctx: ToolContext): { ops: PatchOp[]; abs: Map<string, string> } {
  const { patch } = argsOf(Args, raw)
  const ops = parsePatch(patch)
  if (!Array.isArray(ops)) throw new Error(ops.error)
  const abs = new Map<string, string>()
  for (const p of patchPaths(ops)) {
    const a = pathFor(raw as object, ctx, p)
    for (const [q, b] of abs) if (samePath(a, b)) throw new Error(`${p} 与 ${q} 是同一个文件,在补丁里出现了多次`)
    abs.set(p, a)
  }
  return { ops, abs }
}

const missing = (e: unknown) => ['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')

export function applyPatchTool(deps: CodingDeps): Tool {
  return {
    name: 'apply_patch',
    description: DESCRIPTION,
    parameters: jsonSchema(Args),
    permission: (raw, ctx) => [...resolved(raw, ctx).abs.values()].map(a => request('write', a)),
    async run(raw, ctx) {
      const { ops, abs } = resolved(raw, ctx)
      for (const [p, a] of abs) stillSame(ctx, p, a)
      const sources = new Set(ops.flatMap(op => (op.kind === 'update' ? [op.path] : [])))
      const deletes = new Set(ops.flatMap(op => (op.kind === 'delete' ? [op.path] : [])))

      // 只读:要改的文件读内容;其他只看在不在(要删的必须是普通文件)
      const read = (p: string): string | undefined => {
        const a = abs.get(p)!
        if (sources.has(p)) {
          let buf: Buffer
          try {
            buf = readNoFollow(a, MAX_PATCH_FILE_BYTES)
          } catch (e) {
            if (missing(e)) return undefined
            throw e
          }
          if (buf.subarray(0, 8192).includes(0)) throw new Error(`${shownPath(ctx, a)} 是二进制文件,不能打补丁`)
          return buf.toString('utf8')
        }
        try {
          const st = lstatSync(a)
          if (deletes.has(p) && !st.isFile()) throw new Error(`不是普通文件,不删:${shownPath(ctx, a)}`)
          return ''
        } catch (e) {
          if (missing(e)) return undefined
          throw e
        }
      }
      const plan = planPatch(ops, read)
      if ('error' in plan) return { content: plan.error, isError: true }

      // 写任何东西之前,每个路径都再解析、再过一次权限门
      const again = new Map([...abs].map(([p, a]) => [p, writeAgain(deps, ctx, p, a)]))
      for (const [p, ok] of again) if (!ok()) throw new Error(`路径在权限检查之后发生了变化,未执行:${p}`)
      // 先写后删:中途失败时不会只删了源文件
      for (const w of plan.writes) if (w.content !== null) writeChecked(abs.get(w.path)!, w.content, again.get(w.path)!)
      for (const w of plan.writes) if (w.content === null) deleteChecked(abs.get(w.path)!, again.get(w.path)!)

      const shown = (p: string) => shownPath(ctx, abs.get(p)!)
      const lines = ops.map(op => (op.kind === 'add' ? `A ${shown(op.path)}` : op.kind === 'delete' ? `D ${shown(op.path)}` : `M ${shown(op.moveTo ?? op.path)}`))
      return { content: lines.join('\n') }
    },
  }
}
