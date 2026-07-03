import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './gitRunner'
import type { DiffLine, FilePreview } from '@shared/types'

export function parseUnifiedDiff(out: string): DiffLine[] {
  const res: DiffLine[] = []
  let oldLn = 0, newLn = 0, inHunk = false
  for (const l of out.split('\n')) {
    if (l.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (m) { oldLn = Number(m[1]); newLn = Number(m[2]); inHunk = true }
      continue
    }
    if (!inHunk) continue
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) res.push({ kind: 'add', ln: newLn++, text: l.slice(1) })
    else if (l.startsWith('-')) res.push({ kind: 'del', ln: oldLn++, text: l.slice(1) })
    else if (l.startsWith('\\')) { /* "\ No newline at end of file" */ }
    else { res.push({ kind: 'ctx', ln: newLn, text: l.startsWith(' ') ? l.slice(1) : l }); newLn++; oldLn++ }
  }
  return res
}

const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html',
  py: 'py', sh: 'sh', bash: 'sh', zsh: 'sh', md: 'md', markdown: 'md',
  go: 'go', vue: 'vue', sql: 'sql', yaml: 'yaml', yml: 'yaml'
}
export function langFromPath(file: string): string {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return 'text'
  return EXT_LANG[file.slice(dot + 1).toLowerCase()] ?? 'text'
}

export async function readDiff(cwd: string, file: string, proxy = ''): Promise<DiffLine[]> {
  let out = ''
  try { out = await git(['diff', 'HEAD', '--', file], { cwd, proxy }) } catch { out = '' }
  if (out.trim()) return parseUnifiedDiff(out)
  try {
    const text = readFileSync(join(cwd, file), 'utf8').replace(/\n$/, '')
    return text.split('\n').map((t, i) => ({ kind: 'add' as const, ln: i + 1, text: t }))
  } catch { return [] }
}

export async function readFile(cwd: string, file: string, proxy = ''): Promise<FilePreview> {
  const lang = langFromPath(file)
  try { return { text: readFileSync(join(cwd, file), 'utf8'), lang } }
  catch {
    try { return { text: await git(['show', `HEAD:${file}`], { cwd, proxy }), lang } }
    catch { return { text: '', lang } }
  }
}
