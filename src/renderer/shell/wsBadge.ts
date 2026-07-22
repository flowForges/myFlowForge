export type WsBadge = { kind: 'run' | 'confirm' | 'input'; count: number }

// Highest-priority attention state for a workspace row: 待输入 > 待确认 > 执行中. `confirm`/`input` are
// counts of pending gates across the workspace's sessions (chat + workflow); `live` = an agent is
// executing. Returns null when the workspace is idle.
export function deriveWsBadge(input: { live: boolean; confirm: number; input: number }): WsBadge | null {
  if (input.input > 0) return { kind: 'input', count: input.input }
  if (input.confirm > 0) return { kind: 'confirm', count: input.confirm }
  if (input.live) return { kind: 'run', count: 1 }
  return null
}
