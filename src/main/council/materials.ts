import { execa } from 'execa'
import { COUNCIL_DIFF_CAP_BYTES, type CouncilMaterials } from '@shared/council'
import { readWorkspace } from '../config/store'
import { workspaceToStartRunOpts } from '../workspace/workspaceRun'

const RANGE_RE = /^[\w./~^-]+\.\.[\w./~^-]+$/

export function listCouncilProjects(ws: string): { name: string; cwd: string }[] {
  const w = readWorkspace(ws)
  if (!w) return []
  return workspaceToStartRunOpts(w).developProjects.map(p => ({ name: p.name, cwd: p.cwd }))
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

async function git(cwd: string, args: string[], maxBuffer = DEFAULT_MAX_BUFFER): Promise<string> {
  // ★ 只用 args 数组、不经 shell:range 来自用户输入
  const r = await execa('git', args, { cwd, maxBuffer })
  return r.stdout
}

const isMaxBuffer = (e: unknown) =>
  !!e && typeof e === 'object' && ((e as { isMaxBuffer?: boolean }).isMaxBuffer === true || /maxBuffer/i.test(String((e as { message?: unknown }).message)))

// ★ 围栏比内容里最长的连续反引号多一个(至少 3),diff 里的 ``` 不会提前闭合围栏
function fence(lang: string, body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(r => r.length))
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}${lang}\n${body}\n${f}`
}

export async function collectMaterials(m: CouncilMaterials | undefined, capBytes = COUNCIL_DIFF_CAP_BYTES, maxBuffer = DEFAULT_MAX_BUFFER): Promise<string> {
  if (!m) return ''
  const sections: string[] = []
  if (m.diff) {
    if (!m.projectCwd) throw new Error('diff materials require a project')
    // ★ 以 '-' 开头的 range 会被 git 当成选项(如 --output=),正则本身挡不住 "-x..y"
    const spec = m.diff === 'uncommitted' ? ['HEAD'] : (() => {
      const r = m.diff.range
      if (!RANGE_RE.test(r) || r.startsWith('-')) throw new Error(`invalid git range: ${r}`)
      return [r]
    })()
    const title = m.diff === 'uncommitted' ? 'Uncommitted changes (git diff HEAD)' : `Commit range diff (${m.diff.range})`
    // ★ diff 超过 maxBuffer 时 execa 会抛错:同样按"过大"处理,退回只给统计
    let diff: string | null = null
    try { diff = await git(m.projectCwd, ['diff', ...spec, '--'], maxBuffer) } catch (e) { if (!isMaxBuffer(e)) throw e }
    if (diff === null || Buffer.byteLength(diff) > capBytes) {
      // ★ 过大时只给统计,不截断 diff 正文(截断会造成误判),让讨论方自己去读
      const stat = await git(m.projectCwd, ['diff', '--stat', ...spec, '--'])
      sections.push(`## ${title} — too large, stat only; read the files yourself\n${fence('', stat)}`)
    } else {
      sections.push(`## ${title}\n${fence('diff', diff)}`)
    }
  }
  if (m.files?.length) {
    sections.push(`## Files to read\n${fence('', m.files.join('\n'))}`)
  }
  return sections.join('\n\n')
}
