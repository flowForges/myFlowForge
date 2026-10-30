// apply_patch:Codex `*** Begin Patch` 格式(spec §7)。
// permission() 解析补丁、解析每个涉及的路径(含 Move 目标),每个一条 write;
// run() 只碰这些放行过的路径:先全部算出新内容,无错再统一复查,然后经 safeFs 写 / 删
import { lstatSync } from 'node:fs'
import { z } from 'zod'
import { parsePatch, patchPaths, planPatch, type PatchOp } from '../../lib/patch/applyPatch'
import type { Tool, ToolContext } from '../../lib/tools/types'
import { argsOf } from '../../lib/tools/types'
import { type CodingDeps, jsonSchema, request } from './common'
import { deleteChecked, parentIsDir, pathFor, readRegular, samePath, shownPath, stillSame, writeChecked } from './safeFs'
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
    if (abs.has(p)) continue // Delete 后 Add 同一路径(解析器已核对只有这一种重复)
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
      const adds = new Set(ops.flatMap(op => (op.kind === 'add' ? [op.path] : op.kind === 'update' && op.moveTo !== undefined ? [op.moveTo] : [])))

      // 只读阶段:凡是写的时候会被拒的情况都在这里拒掉,保证"全部校验通过才落盘"
      const read = (p: string): string | undefined => {
        const a = abs.get(p)!
        if (sources.has(p)) {
          const buf = readRegular(a, MAX_PATCH_FILE_BYTES)
          if (buf === undefined) return undefined
          if (buf.subarray(0, 8192).includes(0)) throw new Error(`${shownPath(ctx, a)} 是二进制文件,不能打补丁`)
          const text = buf.toString('utf8')
          if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${shownPath(ctx, a)} 不是 UTF-8 文本,不能打补丁`)
          return text
        }
        let st
        try {
          st = lstatSync(a)
        } catch (e) {
          if (!missing(e)) throw e
          if (adds.has(p)) parentIsDir(a)
          return undefined
        }
        if (deletes.has(p) && !st.isFile()) throw new Error(`不是普通文件,不删:${shownPath(ctx, a)}`)
        // Delete 后 Add = 覆盖写回同一个文件,条件同 writeChecked
        if (deletes.has(p) && adds.has(p) && st.nlink > 1) throw new Error(`文件有多个硬链接,不写:${shownPath(ctx, a)}`)
        return ''
      }
      const plan = planPatch(ops, read)
      if ('error' in plan) return { content: plan.error, isError: true }

      // 写任何东西之前,每个路径都再解析、再过一次权限门
      const again = new Map([...abs].map(([p, a]) => [p, writeAgain(deps, ctx, p, a)]))
      for (const [p, ok] of again) if (!ok()) throw new Error(`路径在权限检查之后发生了变化,未执行:${p}`)
      const shown = (p: string) => shownPath(ctx, abs.get(p)!)
      // 先写后删:中途失败时不会只删了源文件;万一失败,告诉模型哪些已经落盘
      const done: string[] = []
      try {
        const ordered = [...plan.writes.filter(w => w.content !== null), ...plan.writes.filter(w => w.content === null)]
        for (const w of ordered) {
          if (w.content === null) deleteChecked(abs.get(w.path)!, again.get(w.path)!)
          else writeChecked(abs.get(w.path)!, w.content, again.get(w.path)!)
          done.push(`${w.content === null ? '删除' : '写入'} ${shown(w.path)}`)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(done.length ? `${msg}\n补丁只应用了一部分,已完成:${done.join('、')}` : msg)
      }

      const rewritten = new Set([...deletes].filter(p => adds.has(p)))
      const lines = ops.flatMap(op => {
        if (op.kind === 'delete') return rewritten.has(op.path) ? [] : [`D ${shown(op.path)}`]
        if (op.kind === 'add') return [`${rewritten.has(op.path) ? 'M' : 'A'} ${shown(op.path)}`]
        return [`M ${shown(op.moveTo ?? op.path)}`]
      })
      return { content: lines.join('\n') }
    },
  }
}
