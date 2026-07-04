import type { OpenTarget } from '@shared/openers'

// Decide what "打开位置" should open. A previewed/selected file wins: open its own worktree root and
// reveal the file (absolute path). Otherwise open just the base folder — the caller passes the
// selected project's cwd, or the workspace root in aggregate/none mode. Returns null when there's no
// workspace to open.
export function deriveOpenTarget(
  preview: { file: string; cwd: string } | null,
  baseFolder: string,
): OpenTarget | null {
  if (!baseFolder) return null
  if (preview) return { folder: preview.cwd, file: `${preview.cwd}/${preview.file}` }
  return { folder: baseFolder }
}
