import { describe, it, expect } from 'vitest'
import { deriveOpenTarget } from './deriveOpenTarget'

describe('deriveOpenTarget', () => {
  it('with a previewed file → folder = its worktree root, file = absolute path', () => {
    expect(deriveOpenTarget({ file: 'src/a.ts', cwd: '/ws/proj' }, '/ws/proj'))
      .toEqual({ folder: '/ws/proj', file: '/ws/proj/src/a.ts' })
  })

  it('no preview → just the base folder (selected project or workspace root)', () => {
    expect(deriveOpenTarget(null, '/ws/proj')).toEqual({ folder: '/ws/proj' })
  })

  it('preview folder follows the file, not the base (aggregate mode: base is ws root)', () => {
    expect(deriveOpenTarget({ file: 'x.ts', cwd: '/ws/projB' }, '/ws'))
      .toEqual({ folder: '/ws/projB', file: '/ws/projB/x.ts' })
  })

  it('empty base folder → null (no workspace to open)', () => {
    expect(deriveOpenTarget(null, '')).toBeNull()
  })
})
