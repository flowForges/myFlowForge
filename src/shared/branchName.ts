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

// The default work branch for a workspace alias: `feat/<slug>`, with a stable `ws-<hash>` fallback so
// an all-CJK / emoji-only alias still yields a valid, deterministic ASCII branch (never a CJK branch).
export function deriveWorkBranch(name: string): string {
  const slug = branchSlug(name)
  return `${WORK_BRANCH_PREFIX}/${slug || `ws-${shortHash(name ?? '')}`}`
}
