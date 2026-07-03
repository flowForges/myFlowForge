// Resolve which cwd a file preview should read against.
//
// - groupCwd: the per-project worktree cwd from the changes pane (aggregate mode groups each
//   file by its project → real git diff against that worktree).
// - cwd: the single-project worktree when not in aggregate mode.
// - wsPath: the workspace root, used as the fallback in aggregate mode for the file-tree pane,
//   whose nodes are paths relative to the workspace root (read via fs, no per-project cwd).
//
// Without the wsPath fallback, file-tree clicks in 全部项目 mode had no cwd and the preview was
// silently dropped. ChangesPane always passes a groupCwd, so it keeps its precise per-project cwd.
export function pickPreviewCwd(
  groupCwd: string | undefined,
  cwd: string | undefined,
  wsPath: string | undefined,
): string | undefined {
  return groupCwd ?? cwd ?? wsPath
}
