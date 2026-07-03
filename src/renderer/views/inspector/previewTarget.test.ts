import { describe, it, expect } from 'vitest'
import { pickPreviewCwd } from './previewTarget'

describe('pickPreviewCwd', () => {
  it('uses the per-group cwd when present (changes pane, real worktree → real diff)', () => {
    expect(pickPreviewCwd('/ws/projA', undefined, '/ws')).toBe('/ws/projA')
  })
  it('uses the single-project cwd when there is no group cwd (single-project mode)', () => {
    expect(pickPreviewCwd(undefined, '/ws/projA', '/ws')).toBe('/ws/projA')
  })
  it('falls back to the workspace path in aggregate mode (no group, no single cwd)', () => {
    // Regression guard: file-tree clicks in 全部项目 mode had no cwd, so the preview
    // guard silently dropped them. The workspace root reads the relative path via fs.
    expect(pickPreviewCwd(undefined, undefined, '/ws')).toBe('/ws')
  })
  it('returns undefined only when nothing at all is available', () => {
    expect(pickPreviewCwd(undefined, undefined, undefined)).toBeUndefined()
  })
})
