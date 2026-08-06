// 用户自填 Git/URL 安装 skill —— 地址解析这一层。纯函数,不碰网络也不碰磁盘,便于单测。
//
// 支持的写法(都指向「一个含 SKILL.md 的目录」或「一份 SKILL.md」):
//   https://github.com/<owner>/<repo>
//   https://github.com/<owner>/<repo>/tree/<ref>/<path...>
//   https://github.com/<owner>/<repo>/blob/<ref>/<path...>/SKILL.md
//   https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path...>/SKILL.md
//   <owner>/<repo>            (简写)
//   <owner>/<repo>/<path...>  (简写)
//   任意 https://…/SKILL.md   (直链单文件)

export interface GithubDirSource {
  kind: 'github'
  owner: string
  repo: string
  /** 分支/tag/commit。缺省 = 让 API 用仓库默认分支。 */
  ref?: string
  /** 仓库内的子目录,'' = 仓库根。 */
  path: string
}
export interface RawFileSource {
  kind: 'raw'
  url: string
}
export type SkillSource = GithubDirSource | RawFileSource

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

// 去掉尾部斜杠与 .git 后缀
const tidy = (s: string) => s.trim().replace(/\.git$/, '').replace(/\/+$/, '')

export function parseSkillSource(raw: string): SkillSource | { error: string } {
  const input = tidy(raw)
  if (!input) return { error: '请填写地址' }

  // 完整 URL
  if (/^https?:\/\//i.test(input)) {
    let u: URL
    try { u = new URL(input) } catch { return { error: '不是合法的 URL' } }
    if (u.protocol !== 'https:') return { error: '出于安全考虑只接受 https 地址' }

    const seg = u.pathname.split('/').filter(Boolean)

    if (u.hostname === 'github.com') {
      const [owner, repo, kind, ref, ...rest] = seg
      if (!owner || !repo) return { error: 'GitHub 地址里缺少 owner/repo' }
      if (!OWNER_RE.test(owner) || !REPO_RE.test(tidy(repo))) return { error: 'owner/repo 名称不合法' }
      if (!kind) return { kind: 'github', owner, repo: tidy(repo), path: '' }
      if (kind !== 'tree' && kind !== 'blob') return { error: '只支持仓库根、/tree/ 或 /blob/ 形式的 GitHub 地址' }
      if (!ref) return { error: 'GitHub 地址里缺少分支名' }
      // blob 指向的是文件:取它所在的目录(若文件名不是 SKILL.md 也照样取目录,由下载层再判)
      const parts = kind === 'blob' ? rest.slice(0, -1) : rest
      return { kind: 'github', owner, repo: tidy(repo), ref, path: parts.join('/') }
    }

    if (u.hostname === 'raw.githubusercontent.com') {
      // /<owner>/<repo>/<ref>/<path...>
      const [owner, repo, ref, ...rest] = seg
      if (!owner || !repo || !ref || !rest.length) return { error: 'raw.githubusercontent.com 地址不完整' }
      return { kind: 'github', owner, repo: tidy(repo), ref, path: rest.slice(0, -1).join('/') }
    }

    // 其它域名:只接受直链到一份 SKILL.md,避免把任意站点当仓库爬
    if (!/\/SKILL\.md$/i.test(u.pathname)) {
      return { error: '非 GitHub 地址只支持直接指向 SKILL.md 的链接' }
    }
    return { kind: 'raw', url: u.toString() }
  }

  // 简写 owner/repo[/path...]
  const seg = input.split('/').filter(Boolean)
  if (seg.length < 2) return { error: '看不懂这个地址。可填 GitHub 链接,或 owner/repo 简写' }
  const [owner, repo, ...rest] = seg
  if (!OWNER_RE.test(owner) || !REPO_RE.test(tidy(repo))) return { error: 'owner/repo 名称不合法' }
  return { kind: 'github', owner, repo: tidy(repo), path: rest.join('/') }
}

/**
 * 从来源推导默认的 skill 名(= 安装目录名)。优先用子目录的最后一段,否则用仓库名。
 * 结果会再经 safeSkillName 收紧。
 */
export function defaultSkillName(src: SkillSource): string {
  if (src.kind === 'raw') {
    const seg = new URL(src.url).pathname.split('/').filter(Boolean)
    return seg[seg.length - 2] ?? 'skill'
  }
  const last = src.path.split('/').filter(Boolean).pop()
  return last ?? src.repo
}

/**
 * 收紧成一个能安全当目录名用的 skill 名。**安全关键**:安装目标是
 * `<home>/.claude/skills/<name>/`,若放任 `../` 或绝对路径进来,就能写到 home 里的任意位置。
 * 只保留 [A-Za-z0-9._-],其余折成 '-';禁止空串与纯点(., ..)。
 */
export function safeSkillName(name: string): string {
  const cleaned = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  if (!cleaned || /^\.+$/.test(cleaned)) return 'skill'
  return cleaned
}

/** GitHub contents API 地址(列目录 / 取单文件)。 */
export function contentsApiUrl(src: GithubDirSource): string {
  const base = `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${src.path}`.replace(/\/+$/, '')
  return src.ref ? `${base}?ref=${encodeURIComponent(src.ref)}` : base
}
