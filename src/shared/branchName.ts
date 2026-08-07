// Branch-name derivation shared by the create/edit wizard (renderer) and the git worktree layer
// (main). A workspace's default work branch is `feat/<slug>` where the slug is an ASCII-safe form of
// the workspace alias — so a Chinese/emoji alias never produces a CJK git branch (git allows UTF-8
// refs, but such branch names are hostile to tooling, PRs and remotes). Pure (no crypto / Node APIs)
// so it runs identically in both processes.

// Prefix for auto-derived work branches. A standard, conventional-commit-style prefix instead of the
// old bespoke `forge/`.
export const WORK_BRANCH_PREFIX = 'feat'

// Short, deterministic ASCII (base36) hash — the stable fallback when a name slugifies to '' (e.g. an
// all-CJK alias). djb2, kept unsigned so it never renders a leading '-'.
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// Turn an arbitrary name into a git-branch-safe ASCII segment: lowercase; any run of chars outside
// [a-z0-9._-] (spaces, CJK, punctuation) collapses to a single '-'; leading/trailing separators
// trimmed. May return '' when the input has no ASCII word chars at all (handled by deriveWorkBranch).
export function branchSlug(name: string): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
}

// 分支名的日期后缀,MMDD(本地日期)。加它是为了让「同一个工作区名 / 同一个项目的不同需求」不再撞成同一个
// 分支 —— 中文别名会被整段丢掉,`为 go-blog 开放注册` 和 `给 go-blog 加登录` 本来都退化成 feat/go-blog。
// 顺带在分支列表里能一眼看出这活儿是哪天开的。
export function dateSuffix(d: Date = new Date()): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// The default work branch for a workspace alias: `feat/<slug>-<MMDD>`, with a stable `ws-<hash>` fallback
// so an all-CJK / emoji-only alias still yields a valid, deterministic ASCII branch (never a CJK branch).
// 哈希在有日期后也保留:否则同一天建的两个中文名工作区会撞成同一个分支。
// `today` 可注入,便于测试;生产走默认的今天。
export function deriveWorkBranch(name: string, today: Date = new Date()): string {
  const slug = branchSlug(name) || `ws-${shortHash(name ?? '')}`
  return `${WORK_BRANCH_PREFIX}/${slug}-${dateSuffix(today)}`
}
