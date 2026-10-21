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

async function git(cwd: string, args: string[]): Promise<string> {
  // ★ 只用 args 数组、不经 shell:range 来自用户输入;maxBuffer 放大以便超限判断由我们按字节数做
  const r = await execa('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return r.stdout
}

const fence = (lang: string, body: string) => '```' + lang + '\n' + body + '\n```'

export async function collectMaterials(m: CouncilMaterials | undefined, capBytes = COUNCIL_DIFF_CAP_BYTES): Promise<string> {
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
    const diff = await git(m.projectCwd, ['diff', ...spec, '--'])
    if (Buffer.byteLength(diff) > capBytes) {
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
