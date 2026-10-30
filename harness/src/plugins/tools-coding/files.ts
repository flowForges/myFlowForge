// glob / grep 的文件来源(spec §7):git 工作树里用 `git ls-files -co --exclude-standard`(尊重 .gitignore),
// 否则自己遍历,跳过 node_modules 与 .git;不跟随符号链接;最多 max 个
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 跑 git,返回 stdout;非 0 退出 → reject */
export type GitRunner = (args: string[], cwd: string) => Promise<string>

/** 默认 git:不弹交互、不抢索引锁 */
export const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 256 << 20, windowsHide: true },
      (err, out) => (err ? reject(err) : resolve(out)),
    ),
  )

/** fsmonitor 钩子会让一次 ls-files 跑仓库配置里的命令 → 关掉 */
const LS_FILES = ['-c', 'core.fsmonitor=false', 'ls-files', '-co', '--exclude-standard', '-z']
const SKIP_DIRS = new Set(['node_modules', '.git'])

export interface ListOpts {
  signal: AbortSignal
  max: number
  git?: GitRunner
}

/** root 下的文件(相对 root,`/` 分隔) */
export async function listFiles(root: string, opts: ListOpts): Promise<{ files: string[]; truncated: boolean }> {
  const git = opts.git ?? defaultGit
  let out: string | undefined
  try {
    out = await git(LS_FILES, root)
  } catch {
    out = undefined // 不是 git 工作树,或没装 git
  }
  if (opts.signal.aborted) throw new Error('已取消')
  if (out !== undefined) {
    const seen = new Set<string>()
    for (const f of out.split('\0')) {
      if (f === '' || seen.has(f)) continue // 冲突中的文件会列多次
      if (seen.size >= opts.max) return { files: [...seen], truncated: true }
      seen.add(f)
    }
    return { files: [...seen], truncated: false }
  }
  return walk(root, opts)
}

function walk(root: string, opts: ListOpts): { files: string[]; truncated: boolean } {
  const files: string[] = []
  const stack: string[] = ['']
  while (stack.length) {
    if (opts.signal.aborted) throw new Error('已取消')
    const rel = stack.pop()!
    let entries
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })
    } catch {
      continue // 读不了的目录跳过
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)) // 倒序入栈 → 按名字顺序出栈
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p)
      } else if (e.isFile()) {
        if (files.length >= opts.max) return { files, truncated: true }
        files.push(p)
      } // 符号链接、设备等不列也不跟随
    }
  }
  return { files, truncated: false }
}
